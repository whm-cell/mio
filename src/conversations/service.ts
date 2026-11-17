import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { createId } from '@mio/foundation/identifiers';
import { sha256Utf8 } from '@mio/foundation/hash';
import { ConversationError } from './contracts.ts';
import type {
  Conversation,
  ConversationEngine,
  ConversationEvent,
  ConversationImageReference,
  ConversationVision,
  Principal,
  Receipt,
} from './contracts.ts';
import type { ConversationStore } from './store.ts';
import { ProviderError } from '../providers/contracts.ts';
import type { ProviderService } from '../providers/service.ts';
import type { ChatRuntimeSnapshot } from '../providers/contracts.ts';
import { AssetError } from '../assets/contracts.ts';

const log = createLogger('app', 'conversations');

/** Authorization and request ownership remain above the DSH adapter and below HTTP. */
export function createConversationService(
  store: ConversationStore,
  engine: ConversationEngine,
  providers?: Pick<ProviderService, 'selectChat' | 'resolveChat' | 'recordVerification'>,
  vision?: ConversationVision,
) {
  const pending = new Map<string, Promise<void>>();
  const receiving = new Map<string, Promise<Receipt>>();
  const admissionStop = new AbortController();
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
    if (closing)
      throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'CONVERSATION_UNAVAILABLE');
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
      throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'MODEL_UNAVAILABLE');
    }
  };
  return {
    create(actor: Principal, modelRef?: string): Promise<Conversation> {
      return admit(async () => {
        if (!providers && modelRef)
          throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'MODEL_UNAVAILABLE');
        const selection = providers
          ? await providerAction(() => providers.selectChat(actor, modelRef))
          : undefined;
        const row = await store.create(actor, createId(), selection);
        try {
          await engine.create(row.dsh_session_id, selection);
          await store.setReady(row.id, true);
        } catch {
          await store.setReady(row.id, false).catch(() => {});
          throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'CONVERSATION_UNKNOWN');
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
          throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'MODEL_UNAVAILABLE');
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
    history(actor: Principal, id: string, after: number, limit: number) {
      return admit(async () => {
        const row = await store.owned(actor, id);
        return engine.history(row.dsh_session_id, after, limit);
      });
    },
    send(
      actor: Principal,
      id: string,
      requestId: string,
      text: string,
      imageAssetIds: string[] = [],
    ) {
      check();
      const key = `${id}:${requestId}`;
      const ownerKey = `${actor.userId}:${key}`;
      const ids = [...imageAssetIds];
      const digest = ids.length
        ? `vision:v1:${sha256Utf8(JSON.stringify([text, ids]))}`
        : sha256Utf8(text);
      const earlier = receiving.get(ownerKey);
      const job = admit(async () => {
        if (earlier) await earlier.catch(() => {});
        const images: ConversationImageReference[] = [];
        let preflight: ChatRuntimeSnapshot | undefined;
        if (ids.length) {
          const old = await store.existing(actor, id, requestId, digest);
          if (old) return old;
          const row = await store.owned(actor, id);
          if (row.state !== 'ready')
            throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_UNKNOWN');
          if (row.active_request)
            throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_BUSY');
          if (!providers)
            throw new ConversationError(HTTP_STATUS.CONFLICT, 'MODEL_MODALITY_UNSUPPORTED');
          if (!row.model_binding)
            throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_MODEL_REQUIRED');
          preflight = await providerAction(() => providers.resolveChat(actor, row.model_binding!));
          if (!preflight.inputModalities?.includes('image') || !preflight.imageBudget)
            throw new ConversationError(HTTP_STATUS.CONFLICT, 'MODEL_MODALITY_UNSUPPORTED');
          if (ids.length > preflight.imageBudget.maxRequestImages)
            throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
          if (!vision)
            throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'IMAGE_UNAVAILABLE');
          try {
            let representedBytes = 0;
            for (const assetId of ids) {
              const image = await vision.prepare(actor.userId, assetId, admissionStop.signal);
              const target = vision.target(image, {
                maxPixels: preflight.imageBudget.requestImagePixelBudget,
                maxBytes: preflight.imageBudget.requestImageMaxBytes,
              });
              const preview = await vision.preview(
                actor.userId,
                image,
                target,
                admissionStop.signal,
              );
              representedBytes += Math.ceil(preview.bytes / 3) * 4;
              if (representedBytes > preflight.imageBudget.maxRequestImageBytes)
                throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
              images.push(image);
            }
          } catch (error) {
            if (error instanceof ConversationError) throw error;
            if (error instanceof AssetError) throw new ConversationError(error.status, error.code);
            throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'IMAGE_UNAVAILABLE');
          }
        }
        let received;
        try {
          received = await store.receive(actor, id, requestId, digest, async (row) => {
            if (providers) {
              if (!row.model_binding)
                throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_MODEL_REQUIRED');
              const snapshot = await providerAction(() =>
                providers.resolveChat(actor, row.model_binding!),
              );
              if (images.length && !snapshot.inputModalities?.includes('image'))
                throw new ConversationError(HTTP_STATUS.CONFLICT, 'MODEL_MODALITY_UNSUPPORTED');
              if (
                preflight &&
                (snapshot.providerConfigId !== preflight.providerConfigId ||
                  snapshot.modelId !== preflight.modelId ||
                  snapshot.adaptationVersion !== preflight.adaptationVersion ||
                  JSON.stringify(snapshot.imageBudget) !== JSON.stringify(preflight.imageBudget))
              )
                throw new ConversationError(HTTP_STATUS.CONFLICT, 'MODEL_VISION_CHANGED');
              return snapshot;
            }
            if (images.length)
              throw new ConversationError(HTTP_STATUS.CONFLICT, 'MODEL_MODALITY_UNSUPPORTED');
            if (row.model_binding || !engine.available)
              throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'MODEL_UNAVAILABLE');
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
                              .catch(() => log.error('PROVIDER_VERIFICATION_UNAVAILABLE'));
                          }
                        },
                      }
                    : undefined,
                  images,
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
      receiving.set(ownerKey, job);
      const forget = () => {
        if (receiving.get(ownerKey) === job) receiving.delete(ownerKey);
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
          admissionStop.abort();
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
