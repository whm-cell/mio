import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-loop';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { readColdSessionLog } from '@deepseek-ai/dsh-session-query';
import { denyModelTools } from './policy.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    mioKernel: MioKernel;
  }
}

/** Owned public DSH handles; the official driver remains the only Agent loop. */
export default class MioKernel extends Service {
  static inject = ['agents', 'agentLoop', 'sessions', 'sessionPersistence', 'tools'];
  private readonly handles = new Map<
    SessionId,
    { opening: Promise<AgentHandle>; closing: boolean }
  >();
  private closing: Promise<void> | undefined;

  constructor(ctx: Context) {
    super(ctx, 'mioKernel');
    denyModelTools(ctx);
    // Required injections keep the driver/backend alive during this cleanup.
    // Owner effects may run concurrently: join native dispose, which drains its write handle.
    ctx.effect(() => () => this.stop(false));
  }

  create(id: string, options: AgentOptions, setup?: AgentSetup): Promise<AgentHandle> {
    return this.own(SessionId(id), () =>
      this.ctx.agents.create({
        sessionId: SessionId(id),
        agentOptions: options,
        setup: (agentCtx, agent) => {
          denyModelTools(agentCtx);
          return setup?.(agentCtx, agent);
        },
      }),
    );
  }

  resume(id: string, options: AgentOptions, setup?: AgentSetup): Promise<AgentHandle> {
    return this.own(SessionId(id), () =>
      this.ctx.agents.resume({
        resumeSessionId: SessionId(id),
        agentOptions: options,
        setup: async (agentCtx, agent) => {
          denyModelTools(agentCtx);
          // Restored input is evidence of an interrupted request, never authority to retry it.
          agent.inbox.clear();
          await this.flush(agent.session);
          return setup?.(agentCtx, agent);
        },
      }),
    );
  }

  /** Trusted internal history; callers must apply resource authorization and public projection. */
  async history(id: string): Promise<{ header: SessionHeader; events: readonly SessionEvent[] }> {
    const live = this.ctx.sessions.get(SessionId(id));
    if (live) {
      await this.flush(live);
      const reader = await this.ctx.sessionPersistence.open(SessionId(id), 'read');
      try {
        const { events } = await reader.read(0);
        return { header: reader.header, events };
      } finally {
        await reader.close();
      }
    }
    const stored = await readColdSessionLog(this.ctx.sessionPersistence, SessionId(id));
    // A concurrent resume may have attached a writer while the cold read awaited I/O.
    if (this.ctx.sessions.get(SessionId(id))) return this.history(id);
    // Reuse the official replay validation and message projections, without publishing an Agent.
    Session.create(
      SessionId(id),
      stored.events,
      stored.header,
      stored.inheritedEventCount,
      this.ctx.sessions.messageProjections,
    );
    return { header: stored.header, events: stored.events };
  }

  /** False means there is no durability listener; it must never become a persisted receipt. */
  async flush(session: Session): Promise<void> {
    if (!(await this.ctx.sessions.flush(session)))
      throw new Error('MIO_PERSISTENCE_UNAVAILABLE: no session durability listener');
  }

  /** Explicit graceful shutdown, before disposing the application/root context. */
  close(): Promise<void> {
    return this.stop(true);
  }

  private own(id: SessionId, create: () => Promise<AgentHandle>): Promise<AgentHandle> {
    if (this.closing) return Promise.reject(new Error('MIO_KERNEL_CLOSED'));
    const existing = this.handles.get(id);
    if (existing?.closing) return Promise.reject(new Error('MIO_KERNEL_SESSION_CLOSING'));
    if (existing) return existing.opening;
    const opening = create().then((handle) => {
      let disposed: Promise<void> | undefined;
      return {
        agent: handle.agent,
        dispose: () => {
          entry.closing = true;
          return (disposed ??= handle.dispose().finally(() => {
            if (this.handles.get(id) === entry) this.handles.delete(id);
          }));
        },
      };
    });
    const entry = { opening, closing: false };
    this.handles.set(id, entry);
    void entry.opening.catch(() => {
      if (this.handles.get(id) === entry) this.handles.delete(id);
    });
    return entry.opening;
  }

  private stop(flush: boolean): Promise<void> {
    return (this.closing ??= (async () => {
      const results = await Promise.allSettled(
        [...this.handles.values()].map(async (entry) => {
          const handle = await entry.opening;
          try {
            if (flush && !entry.closing) {
              handle.agent.cancel({ kind: 'disposed' });
              await handle.agent.whenIdle();
              if (!entry.closing && this.ctx.sessions.get(handle.agent.id) === handle.agent.session)
                await this.flush(handle.agent.session);
            }
          } finally {
            await handle.dispose();
          }
        }),
      );
      this.handles.clear();
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason));
    })());
  }
}
