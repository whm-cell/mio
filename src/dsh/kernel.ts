import { isDeepStrictEqual } from 'node:util';
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-loop';
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import { readColdSessionLog } from '@deepseek-ai/dsh-session-query';
import { denyModelTools } from './policy.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    mioKernel: MioKernel;
  }
}

interface StoredHistory {
  header: SessionHeader;
  events: readonly SessionEvent[];
  inheritedEventCount: SessionLogOffset;
  view?: Session;
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

  /** Materialize a validated prefix or recognize a durably created target after an uncertain write. */
  async createFork(
    sourceId: string,
    targetId: string,
    seed: readonly SessionEvent[],
    options: AgentOptions,
  ): Promise<void> {
    const parent = SessionId(sourceId);
    const target = SessionId(targetId);
    const inheritedEventCount = SessionLogOffset(seed.length);
    const existing = await this.readPersistedHistory(targetId).catch((error: unknown) => {
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error;
    });
    if (existing) {
      const marker = existing.events[inheritedEventCount];
      if (
        existing.header.parentSession !== parent ||
        !existing.header.isSeeded ||
        existing.inheritedEventCount !== inheritedEventCount ||
        marker?.type !== 'session/end-seed' ||
        marker.data.inherited !== true ||
        !isDeepStrictEqual(existing.events.slice(0, inheritedEventCount), seed)
      )
        throw new Error('MIO_FORK_TARGET_CONFLICT');
      return;
    }
    const handle = await this.own(target, () =>
      this.ctx.agents.create({
        sessionId: target,
        seed,
        inheritedEventCount,
        meta: { isSeeded: true, parentSession: parent },
        agentOptions: options,
        setup: (agentCtx, agent) => {
          denyModelTools(agentCtx);
          // A queued input from the source never authorizes work in the child.
          agent.inbox.clear();
        },
      }),
    );
    try {
      await this.flush(handle.agent.session);
    } finally {
      await handle.dispose();
    }
  }

  /** Only the persisted prefix, with neither a live flush nor recovery closers. */
  async readPersistedHistory(id: string, signal?: AbortSignal): Promise<StoredHistory> {
    signal?.throwIfAborted();
    const options = signal ? { signal } : undefined;
    const reader = await this.ctx.sessionPersistence.open(SessionId(id), 'read', options);
    try {
      const { events } = await reader.read(0, undefined, options);
      signal?.throwIfAborted();
      return {
        header: reader.header,
        events,
        inheritedEventCount: reader.inheritedEventCount,
      };
    } finally {
      await reader.close();
    }
  }

  /** Current persisted model surface without opening a writer. */
  async readPersistedView(id: string): Promise<Session> {
    return this.replay(SessionId(id), await this.readPersistedHistory(id));
  }

  /** Trusted internal history; callers must apply resource authorization and public projection. */
  async history(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ header: SessionHeader; events: readonly SessionEvent[] }> {
    const { header, events } = await this.readHistory(id, signal);
    return { header, events };
  }

  /** A detached replay for trusted internal projections through the persisted prefix. */
  async readView(id: string, signal?: AbortSignal): Promise<Session> {
    const history = await this.readHistory(id, signal);
    const view = history.view ?? this.replay(SessionId(id), history);
    signal?.throwIfAborted();
    return view;
  }

  private async readHistory(id: string, signal?: AbortSignal): Promise<StoredHistory> {
    signal?.throwIfAborted();
    const live = this.ctx.sessions.get(SessionId(id));
    if (live) {
      await this.flush(live);
      return this.readPersistedHistory(id, signal);
    }
    const stored = await readColdSessionLog(this.ctx.sessionPersistence, SessionId(id), signal);
    signal?.throwIfAborted();
    // A concurrent resume may have attached a writer while the cold read awaited I/O.
    if (this.ctx.sessions.get(SessionId(id))) return this.readHistory(id, signal);
    // Validate the cold log once and reuse the detached replay when requested.
    const view = this.replay(SessionId(id), stored);
    signal?.throwIfAborted();
    return { ...stored, view };
  }

  private replay(id: SessionId, { header, events, inheritedEventCount }: StoredHistory): Session {
    return Session.create(
      id,
      events,
      header,
      inheritedEventCount,
      this.ctx.sessions.messageProjections,
    );
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
