import { createHash, randomUUID } from 'node:crypto';
import { ConversationError } from './contracts.ts';
import type {
  Conversation,
  ConversationEngine,
  ConversationEvent,
  Principal,
  Receipt,
} from './contracts.ts';
import type { ConversationStore } from './store.ts';
import { ProviderError } from '../providers/contracts.ts';
import type { ProviderService } from '../providers/service.ts';

/** Authorization and request ownership remain above the DSH adapter and below HTTP. */
export function createConversationService(
  store: ConversationStore,
  engine: ConversationEngine,
  providers?: Pick<ProviderService, 'selectChat' | 'resolveChat' | 'recordVerification'>,
) {
  const pending = new Map<string, Promise<void>>();
  const receiving = new Map<string, { digest: string; job: Promise<Receipt> }>();
  const admissions = new Set<Promise<unknown>>();
  const cancellations = new Set<string>();
  const listeners = new Map<string, Set<(event: ConversationEvent) => void>>();
  let closing: Promise<void> | undefined;
  const publish = (id: string, event: ConversationEvent) => {
    for (const listener of listeners.get(id) ?? []) {
      try {
        listener(event);
      } catch {
        /* A disconnected subscriber cannot affect accepted execution. */
      }
    }
  };
  const check = () => {
    if (closing) throw new ConversationError(503, 'CONVERSATION_UNAVAILABLE');
  };
  const admit = <T>(work: () => Promise<T>): Promise<T> => {
    check();
    const job = work();
    admissions.add(job);
    void job.then(
      () => admissions.delete(job),
      () => admissions.delete(job),
    );
    return job;
  };
  const providerAction = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ProviderError) throw new ConversationError(error.status, error.code);
      throw new ConversationError(503, 'MODEL_UNAVAILABLE');
    }
  };
  return {
    create(actor: Principal, modelRef?: string): Promise<Conversation> {
      return admit(async () => {
        if (!providers && modelRef) throw new ConversationError(503, 'MODEL_UNAVAILABLE');
        const selection = providers
          ? await providerAction(() => providers.selectChat(actor, modelRef))
          : undefined;
        const row = await store.create(actor, randomUUID(), selection);
        try {
          await engine.create(row.dsh_session_id, selection);
          await store.setReady(row.id, true);
        } catch {
          await store.setReady(row.id, false).catch(() => {});
          throw new ConversationError(503, 'CONVERSATION_UNKNOWN');
        }
        return {
          id: row.id,
          createdAt: row.created_at.toISOString(),
          state: 'ready' as const,
          ...(selection ? { modelRef: selection.modelRef } : {}),
        };
      });
    },
    bind(actor: Principal, id: string, modelRef: string) {
      return admit(async () => {
        if (!providers) {
          await store.owned(actor, id);
          throw new ConversationError(503, 'MODEL_UNAVAILABLE');
        }
        return store.bind(actor, id, modelRef, () =>
          providerAction(() => providers.selectChat(actor, modelRef)),
        );
      });
    },
    list: (actor: Principal, after: string | undefined, limit: number) => {
      check();
      return store.list(actor, after, limit);
    },
    request: (actor: Principal, id: string, requestId: string) => {
      check();
      return store.request(actor, id, requestId);
    },
    async history(actor: Principal, id: string, after: number, limit: number) {
      check();
      const row = await store.owned(actor, id);
      return engine.history(row.dsh_session_id, after, limit);
    },
    send(actor: Principal, id: string, requestId: string, text: string) {
      check();
      const key = `${id}:${requestId}`;
      const ownerKey = `${actor.userId}:${key}`;
      const digest = createHash('sha256').update(text).digest('hex');
      const existing = receiving.get(ownerKey);
      if (existing) {
        if (existing.digest !== digest) throw new ConversationError(409, 'REQUEST_ID_CONFLICT');
        return existing.job;
      }
      const job = admit(async () => {
        let received;
        try {
          received = await store.receive(actor, id, requestId, digest, async (row) => {
            if (providers) {
              if (!row.model_binding)
                throw new ConversationError(409, 'CONVERSATION_MODEL_REQUIRED');
              return providerAction(() => providers.resolveChat(actor, row.model_binding!));
            }
            if (row.model_binding || !engine.available)
              throw new ConversationError(503, 'MODEL_UNAVAILABLE');
            return undefined;
          });
        } catch (error) {
          if (!(error instanceof ConversationError) && !pending.has(key)) {
            try {
              await store.reconcileReception(actor, id, requestId, digest);
            } catch {
              store.markUnavailable();
            }
          }
          throw error;
        }
        if (!received.fresh) return received.receipt;
        const cancelledBeforeStart = cancellations.delete(key);
        publish(id, { type: 'state', receipt: received.receipt });
        const running = (async () => {
          try {
            const result = cancelledBeforeStart
              ? 'cancelled'
              : await engine.run(
                  received.row.dsh_session_id,
                  requestId,
                  text,
                  async () => {
                    await store.inputPersisted(id, requestId);
                    publish(id, {
                      type: 'state',
                      receipt: { conversationId: id, requestId, status: 'input-persisted' },
                    });
                  },
                  (event) => publish(id, event),
                  received.snapshot
                    ? {
                        userId: actor.userId,
                        conversationId: id,
                        dshSessionId: received.row.dsh_session_id,
                        requestId,
                        snapshot: received.snapshot,
                        observe: async (observation) => {
                          await store.observe(id, requestId, observation);
                          if (
                            observation.status === 200 &&
                            ['stop', 'max-tokens'].includes(observation.finish)
                          ) {
                            // The durable request observation remains authoritative if the separate provider DB is unavailable.
                            await providers!
                              .recordVerification(actor, received.snapshot!, `${id}:${requestId}`)
                              .catch(() => console.error('PROVIDER_VERIFICATION_UNAVAILABLE'));
                          }
                        },
                      }
                    : undefined,
                );
            publish(id, {
              type: 'state',
              receipt: await store.finish(
                id,
                requestId,
                result,
                result === 'failed'
                  ? 'MODEL_FAILED'
                  : result === 'unknown'
                    ? 'PROCESS_INTERRUPTED'
                    : undefined,
              ),
            });
          } catch {
            // The same request identity remains queryable; no retry through either storage.
            await engine.cancel(received.row.dsh_session_id, requestId).catch(() => {});
            try {
              const stored = await store.request(actor, id, requestId);
              const final = ['completed', 'cancelled', 'failed'].includes(stored.status)
                ? stored
                : await store.finish(id, requestId, 'unknown', 'EXECUTION_UNKNOWN');
              publish(id, { type: 'state', receipt: final });
            } catch {
              store.markUnavailable();
              publish(id, { type: 'error', code: 'CONVERSATION_UNAVAILABLE' });
            }
          } finally {
            cancellations.delete(key);
          }
        })();
        pending.set(key, running);
        void running.finally(() => pending.delete(key));
        return received.receipt;
      });
      const entry = { digest, job };
      receiving.set(ownerKey, entry);
      const forget = () => {
        if (receiving.get(ownerKey) === entry) receiving.delete(ownerKey);
      };
      void job.then(forget, forget);
      return job;
    },
    async cancel(actor: Principal, id: string) {
      check();
      const row = await store.owned(actor, id);
      if (row.active_request) {
        const key = `${id}:${row.active_request}`;
        cancellations.add(key);
        await engine.cancel(row.dsh_session_id, row.active_request);
        const receipt = await store.request(actor, id, row.active_request);
        if (['completed', 'cancelled', 'failed', 'unknown'].includes(receipt.status))
          cancellations.delete(key);
      }
      return { requested: row.active_request !== null, requestId: row.active_request };
    },
    async subscribe(actor: Principal, id: string, listener: (event: ConversationEvent) => void) {
      check();
      const row = await store.owned(actor, id);
      let group = listeners.get(id);
      if (!group) listeners.set(id, (group = new Set()));
      group.add(listener);
      let latest;
      try {
        const current = await store.owned(actor, id);
        latest = await store.latest(actor, id);
        check();
        row.active_request = current.active_request;
      } catch (error) {
        group.delete(listener);
        if (!group.size) listeners.delete(id);
        throw error;
      }
      return {
        snapshot: { conversationId: id, activeRequestId: row.active_request, receipt: latest },
        close: () => {
          group.delete(listener);
          if (!group.size) listeners.delete(id);
        },
      };
    },
    close(): Promise<void> {
      return (closing ??= (async () => {
        try {
          await Promise.allSettled(admissions);
          let failure: unknown;
          try {
            await engine.close();
          } catch (error) {
            failure = error;
          }
          await Promise.all(pending.values());
          if (failure) throw failure;
        } finally {
          cancellations.clear();
          listeners.clear();
          await store.close();
        }
      })());
    },
  };
}
export type ConversationService = ReturnType<typeof createConversationService>;
