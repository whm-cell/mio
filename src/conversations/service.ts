import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { createId } from '@mio/foundation/identifiers';
import { sha256Utf8 } from '@mio/foundation/hash';
import {
  ConversationError,
  emptyAudioSelection,
  isInFlightRequest,
  outputTruncation,
} from './contracts.ts';
import { audioAction, canonicalAudioContext, freezeConversationAudio } from './audio-context.ts';
import type {
  CaptureContextUsage,
  ContextUsage,
  Conversation,
  ConversationAudioTools,
  ConversationAudioTurn,
  ConversationEngine,
  ConversationEvent,
  ConversationImageReference,
  ConversationPurpose,
  ConversationRun,
  ConversationRunResult,
  ConversationVision,
  Principal,
  Receipt,
} from './contracts.ts';
import type { ConversationCursor } from './cursor.ts';
import { loadConversationProjectContext } from './project-context.ts';
import type { ConversationProjectContextResolver } from './project-context.ts';
import { projectConversation } from './store.ts';
import type { ConversationStore } from './store.ts';
import { ProviderError, supportsChatReasoning } from '../providers/contracts.ts';
import type { ProviderService } from '../providers/service.ts';
import type { ChatReasoningEffort, ChatRuntimeSnapshot } from '../providers/contracts.ts';
import { AssetError } from '../assets/contracts.ts';

const log = createLogger('app', 'conversations');
const IMAGE_PREPARATION_CONCURRENCY = 2;
// A separate operation in the same requestId namespace as text and vision sends.
const COMPACTION_DIGEST = 'compact:v1';
const publicContextUsage = ({ estimatedTokens, contextWindow, compacted }: ContextUsage) => ({
  estimatedTokens,
  contextWindow,
  compacted,
});

function requireReasoning(
  snapshot: ChatRuntimeSnapshot | undefined,
  effort: ChatReasoningEffort | undefined,
): void {
  if (effort !== undefined && !supportsChatReasoning(snapshot?.reasoning, effort))
    throw new ConversationError(HTTP_STATUS.CONFLICT, 'MODEL_REASONING_UNSUPPORTED');
}

/** Authorization and request ownership remain above the DSH adapter and below HTTP. */
export function createConversationService(
  store: ConversationStore,
  engine: ConversationEngine,
  providers?: Pick<ProviderService, 'selectChat' | 'resolveChat' | 'recordVerification'> &
    Partial<Pick<ProviderService, 'chatContextWindow' | 'selectChatRoute'>>,
  vision?: ConversationVision,
  resolveProjectContext?: ConversationProjectContextResolver,
  audio?: ConversationAudioTools,
) {
  const pending = new Map<string, Promise<void>>();
  const receiving = new Map<string, Promise<Receipt>>();
  const admissionStop = new AbortController();
  const admissions = new Set<Promise<unknown>>();
  const cancellations = new Set<string>();
  const listeners = new Map<string, Set<(event: ConversationEvent) => void>>();
  let closing: Promise<void> | undefined;
  let preparingImages = 0;
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
  const receiveInOrder = (
    actor: Principal,
    id: string,
    requestId: string,
    work: () => Promise<Receipt>,
  ) => {
    const ownerKey = `${actor.userId}:${id}:${requestId}`;
    const earlier = receiving.get(ownerKey);
    const job = admit(async () => {
      if (earlier) await earlier.catch(() => {});
      return work();
    });
    receiving.set(ownerKey, job);
    const forget = () => {
      if (receiving.get(ownerKey) === job) receiving.delete(ownerKey);
    };
    void job.then(forget, forget);
    return job;
  };
  const receive = async (
    actor: Principal,
    id: string,
    requestId: string,
    digest: string,
    resolveFresh: Parameters<ConversationStore['receive']>[4],
    resolveAudio?: Parameters<ConversationStore['receive']>[5],
  ) => {
    try {
      return await store.receive(actor, id, requestId, digest, resolveFresh, resolveAudio);
    } catch (error) {
      if (!(error instanceof ConversationError) && !pending.has(`${id}:${requestId}`)) {
        try {
          await store.reconcileReception(actor, id, requestId, digest);
        } catch {
          store.markUnavailable();
        }
      }
      throw error;
    }
  };
  const bindRun = (
    actor: Principal,
    id: string,
    dshSessionId: string,
    requestId: string,
    snapshot: ChatRuntimeSnapshot,
    reasoningEffort?: ChatReasoningEffort,
  ): ConversationRun => ({
    userId: actor.userId,
    conversationId: id,
    dshSessionId,
    requestId,
    snapshot,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    async observe(observation) {
      await store.observe(id, requestId, observation);
      if (
        observation.purpose !== 'compaction' &&
        observation.status === 200 &&
        ['stop', 'max-tokens'].includes(observation.finish)
      ) {
        // A provider verification failure cannot invalidate a durable model observation.
        await providers!
          .recordVerification(actor, snapshot, `${id}:${requestId}`)
          .catch(() => log.error('PROVIDER_VERIFICATION_UNAVAILABLE'));
      }
    },
  });
  const startRequest = (
    actor: Principal,
    accepted: Receipt,
    dshSessionId: string,
    run: (captureContextUsage: CaptureContextUsage) => Promise<ConversationRunResult>,
    settleActivity?: () => Promise<void>,
  ) => {
    const { conversationId: id, requestId } = accepted;
    const key = `${id}:${requestId}`;
    const cancelledBeforeStart = cancellations.delete(key);
    let contextUsage: ContextUsage | undefined;
    const capture: CaptureContextUsage = (read) => {
      if (!listeners.get(id)?.size) return;
      try {
        contextUsage = publicContextUsage(read());
      } catch {
        // An estimate is optional and cannot change the request's outcome.
      }
    };
    const publishTerminal = (receipt: Receipt) =>
      publish(id, {
        type: 'state',
        receipt,
        ...(contextUsage ? { contextUsage } : {}),
      });
    publish(id, { type: 'state', receipt: accepted });
    const running = (async () => {
      let executionEnded = false;
      try {
        const result = cancelledBeforeStart ? 'cancelled' : await run(capture);
        executionEnded = true;
        await settleActivity?.();
        const status = typeof result === 'string' ? result : result.status;
        const truncated = status === outputTruncation.reason;
        const error =
          typeof result !== 'string'
            ? result.error
            : status === 'failed'
              ? 'MODEL_FAILED'
              : status === 'unknown'
                ? 'PROCESS_INTERRUPTED'
                : undefined;
        publishTerminal(
          await store.finish(
            id,
            requestId,
            truncated ? 'completed' : status,
            error,
            truncated ? outputTruncation.reason : undefined,
          ),
        );
      } catch {
        if (!executionEnded) await engine.cancel(dshSessionId, requestId).catch(() => {});
        await settleActivity?.();
        try {
          publishTerminal(await store.reconcileExecution(actor, id, requestId));
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
    return accepted;
  };
  const selectAudioVoice = (
    actor: Principal,
    id: string,
    voiceRef: string,
    revision: number,
    requestId?: string,
  ) =>
    admit(async () => {
      const selection = await store.selectAudioVoice(
        actor,
        id,
        voiceRef,
        revision,
        (ref) => {
          if (!providers || !audio)
            throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'AUDIO_UNAVAILABLE');
          return audioAction(() => audio.resolveVoice(actor, ref));
        },
        requestId,
      );
      publish(id, { type: 'audio-selection', conversationId: id, selection });
      return selection;
    });
  return {
    selectAudioVoice,
    create(
      actor: Principal,
      modelRef?: string,
      purpose: ConversationPurpose = 'general',
      reasoningEffort?: ChatReasoningEffort,
    ): Promise<Conversation> {
      return admit(async () => {
        if (purpose === 'audio' && (!providers || !audio))
          throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'AUDIO_UNAVAILABLE');
        if (!providers) {
          requireReasoning(undefined, reasoningEffort);
          if (modelRef)
            throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'MODEL_UNAVAILABLE');
        }
        const selection = providers
          ? await providerAction(() => providers.selectChat(actor, modelRef, reasoningEffort))
          : undefined;
        const row = await store.create(actor, createId(), selection, purpose, reasoningEffort);
        try {
          await engine.create(row.dsh_session_id, selection);
          await store.setReady(row.id, true);
        } catch {
          await store.setReady(row.id, false).catch(() => {});
          throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'CONVERSATION_UNKNOWN');
        }
        return projectConversation({ ...row, state: 'ready' });
      });
    },
    fork(actor: Principal, id: string, requestId: string, turnEndSeq?: number) {
      return admit(async () => {
        const reservation = await store.reserveFork(
          actor,
          id,
          requestId,
          turnEndSeq,
          (nativeId) => {
            if (!engine.resolveForkBoundary || !engine.fork)
              throw new ConversationError(
                HTTP_STATUS.SERVICE_UNAVAILABLE,
                'CONVERSATION_UNAVAILABLE',
              );
            return engine.resolveForkBoundary(nativeId, turnEndSeq);
          },
        );
        try {
          return await store.completeFork(
            actor,
            reservation.targetId,
            (nativeId, cutoff, selection) => {
              if (!engine.fork)
                throw new ConversationError(
                  HTTP_STATUS.SERVICE_UNAVAILABLE,
                  'CONVERSATION_UNAVAILABLE',
                );
              return engine.fork(reservation.sourceSessionId, nativeId, cutoff, selection);
            },
          );
        } catch (error) {
          if (error instanceof ConversationError) throw error;
          throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'CONVERSATION_UNKNOWN');
        }
      });
    },
    selectModel(actor: Principal, id: string, modelRef: string) {
      return admit(async () => {
        if (!providers) {
          const row = await store.owned(actor, id);
          if (row.archived_at)
            throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_ARCHIVED');
          throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'MODEL_UNAVAILABLE');
        }
        return store.selectModel(actor, id, modelRef, async (row) => {
          if (!providers.selectChatRoute)
            throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'MODEL_UNAVAILABLE');
          const { selection, inputModalities } = await providerAction(() =>
            providers.selectChatRoute!(actor, modelRef, row.reasoning_effort ?? undefined),
          );
          if (!inputModalities.includes('image')) {
            if (!engine.hasRetainedImages)
              throw new ConversationError(
                HTTP_STATUS.SERVICE_UNAVAILABLE,
                'CONVERSATION_UNAVAILABLE',
              );
            if (await engine.hasRetainedImages(row.dsh_session_id))
              throw new ConversationError(HTTP_STATUS.CONFLICT, 'MODEL_MODALITY_UNSUPPORTED');
          }
          return selection;
        });
      });
    },
    list: (
      actor: Principal,
      after: ConversationCursor | undefined,
      limit: number,
      purpose?: 'audio',
    ) => {
      check();
      return store.list(actor, after, limit, purpose);
    },
    rename: (actor: Principal, id: string, title: string) =>
      admit(() => store.rename(actor, id, (row) => engine.rename(row.dsh_session_id, title))),
    archive: (actor: Principal, id: string) => admit(() => store.archive(actor, id)),
    request: (actor: Principal, id: string, requestId: string) => {
      check();
      return store.request(actor, id, requestId);
    },
    history(actor: Principal, id: string, after: number, limit: number, signal?: AbortSignal) {
      return admit(async () => {
        const stopped = AbortSignal.any([admissionStop.signal, ...(signal ? [signal] : [])]);
        stopped.throwIfAborted();
        const row = await store.owned(actor, id);
        stopped.throwIfAborted();
        return engine.history(row.dsh_session_id, after, limit, stopped);
      });
    },
    compact(actor: Principal, id: string, requestId: string) {
      return receiveInOrder(actor, id, requestId, async () => {
        const received = await receive(actor, id, requestId, COMPACTION_DIGEST, async (row) => {
          if (!engine.compact || !providers || !row.model_binding)
            throw new ConversationError(
              HTTP_STATUS.CONFLICT,
              'CONVERSATION_COMPACTION_UNSUPPORTED',
            );
          const snapshot = await providerAction(() =>
            providers.resolveChat(actor, row.model_binding!),
          );
          const window = snapshot.contextWindow;
          if (window === undefined || !Number.isSafeInteger(window) || window < 1)
            throw new ConversationError(
              HTTP_STATUS.CONFLICT,
              'CONVERSATION_COMPACTION_UNSUPPORTED',
            );
          return snapshot;
        });
        if (!received.fresh) return received.receipt;
        const nativeId = received.row.dsh_session_id;
        const binding = bindRun(actor, id, nativeId, requestId, received.snapshot!);
        return startRequest(actor, received.receipt, nativeId, (capture) =>
          engine.compact!(nativeId, binding, admissionStop.signal, capture),
        );
      });
    },
    send(
      actor: Principal,
      id: string,
      requestId: string,
      text: string,
      imageAssetIds: string[] = [],
      reasoningEffort?: ChatReasoningEffort,
      audioContext?: unknown,
    ) {
      const ids = [...imageAssetIds];
      const rawAudio = audioContext === undefined ? undefined : canonicalAudioContext(audioContext);
      const digest =
        rawAudio !== undefined
          ? `audio:v1:${sha256Utf8(JSON.stringify([text, ids, reasoningEffort ?? null, rawAudio]))}`
          : reasoningEffort !== undefined
            ? `reasoning:v1:${sha256Utf8(JSON.stringify([text, ids, reasoningEffort]))}`
            : ids.length
              ? `vision:v1:${sha256Utf8(JSON.stringify([text, ids]))}`
              : sha256Utf8(text);
      return receiveInOrder(actor, id, requestId, async () => {
        const images: ConversationImageReference[] = [];
        let preflight: ChatRuntimeSnapshot | undefined;
        if (ids.length) {
          const { row, replay } = await store.existing(actor, id, requestId, digest);
          if (replay) return replay;
          if (row.purpose === 'audio')
            throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_NOT_ALLOWED');
          if (rawAudio !== undefined)
            throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'AUDIO_CONTEXT_NOT_ALLOWED');
          if (preparingImages >= IMAGE_PREPARATION_CONCURRENCY)
            throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'IMAGE_UNAVAILABLE');
          preparingImages++;
          try {
            const effort = reasoningEffort ?? row.reasoning_effort ?? undefined;
            if (row.state !== 'ready')
              throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_UNKNOWN');
            if (row.active_request)
              throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_BUSY');
            if (!providers) {
              requireReasoning(undefined, effort);
              throw new ConversationError(HTTP_STATUS.CONFLICT, 'MODEL_MODALITY_UNSUPPORTED');
            }
            if (!row.model_binding)
              throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_MODEL_REQUIRED');
            preflight = await providerAction(() =>
              providers.resolveChat(actor, row.model_binding!),
            );
            requireReasoning(preflight, effort);
            if (!preflight.inputModalities?.includes('image') || !preflight.imageBudget)
              throw new ConversationError(HTTP_STATUS.CONFLICT, 'MODEL_MODALITY_UNSUPPORTED');
            if (ids.length > preflight.imageBudget.maxRequestImages)
              throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
            if (!vision)
              throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'IMAGE_UNAVAILABLE');
            let representedBytes = 0;
            for (const assetId of ids) {
              const prepared = await vision.prepareRequest(
                actor.userId,
                assetId,
                {
                  maxPixels: preflight.imageBudget.requestImagePixelBudget,
                  maxBytes: preflight.imageBudget.requestImageMaxBytes,
                },
                admissionStop.signal,
              );
              representedBytes += Math.ceil(prepared.previewBytes / 3) * 4;
              if (representedBytes > preflight.imageBudget.maxRequestImageBytes)
                throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
              images.push(prepared.reference);
            }
          } catch (error) {
            if (error instanceof ConversationError) throw error;
            if (error instanceof AssetError) throw new ConversationError(error.status, error.code);
            throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'IMAGE_UNAVAILABLE');
          } finally {
            preparingImages--;
          }
        }
        let projectContext: string | undefined;
        const received = await receive(
          actor,
          id,
          requestId,
          digest,
          async (row) => {
            if (row.purpose !== 'audio' && rawAudio !== undefined)
              throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'AUDIO_CONTEXT_NOT_ALLOWED');
            if (row.purpose === 'audio' && (!providers || !audio))
              throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'AUDIO_UNAVAILABLE');
            const effort = reasoningEffort ?? row.reasoning_effort ?? undefined;
            let snapshot: ChatRuntimeSnapshot | undefined;
            if (providers) {
              if (!row.model_binding)
                throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_MODEL_REQUIRED');
              snapshot = await providerAction(() =>
                providers.resolveChat(actor, row.model_binding!),
              );
              requireReasoning(snapshot, effort);
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
            } else {
              requireReasoning(undefined, effort);
              if (images.length)
                throw new ConversationError(HTTP_STATUS.CONFLICT, 'MODEL_MODALITY_UNSUPPORTED');
              if (row.model_binding || !engine.available)
                throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'MODEL_UNAVAILABLE');
            }
            if (row.purpose === 'drama-script' && resolveProjectContext)
              projectContext = await loadConversationProjectContext(resolveProjectContext, {
                ownerId: row.owner_id,
                conversationId: row.id,
                signal: admissionStop.signal,
              });
            return snapshot && effort !== undefined
              ? Object.freeze({ ...snapshot, reasoningEffort: effort })
              : snapshot;
          },
          async (row) => {
            if (row.purpose === 'audio')
              return freezeConversationAudio(
                audio!,
                actor,
                text,
                row.audio_selection,
                rawAudio ?? {},
              );
          },
        );
        if (!received.fresh) return received.receipt;
        const nativeId = received.row.dsh_session_id;
        const snapshot = received.snapshot;
        const binding =
          snapshot && bindRun(actor, id, nativeId, requestId, snapshot, snapshot.reasoningEffort);
        let audioSelection = received.row.audio_selection ?? emptyAudioSelection;
        const audioTurn: ConversationAudioTurn | undefined =
          received.audioContext === undefined
            ? undefined
            : {
                userId: actor.userId,
                conversationId: id,
                requestId,
                audioContext: received.audioContext,
                audioSelection,
                async selectAudioVoice(voiceRef) {
                  audioSelection = await selectAudioVoice(
                    actor,
                    id,
                    voiceRef,
                    audioSelection.revision,
                    requestId,
                  );
                  return audioSelection;
                },
              };
        let retryActivity: (() => Promise<void>) | undefined;
        return startRequest(
          actor,
          received.receipt,
          nativeId,
          (capture) =>
            engine.run(
              nativeId,
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
              binding,
              images,
              (eventTimeMs, autoTitle) => {
                const project = () => store.inputAdmitted(id, requestId, eventTimeMs, autoTitle);
                return project().catch(() => {
                  // Retain the persisted event for one retry before releasing the active request.
                  retryActivity = project;
                });
              },
              capture,
              {
                purpose: received.row.purpose,
                ...(audioTurn ? { audio: audioTurn } : {}),
                ...(projectContext !== undefined ? { projectContext } : {}),
              },
            ),
          async () => {
            const retry = retryActivity;
            retryActivity = undefined;
            await retry?.().catch(() => log.error('CONVERSATION_ACTIVITY_UNAVAILABLE'));
          },
        );
      });
    },
    async cancel(actor: Principal, id: string) {
      check();
      const row = await store.owned(actor, id);
      if (row.archived_at)
        throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_ARCHIVED');
      if (row.active_request) {
        const key = `${id}:${row.active_request}`;
        cancellations.add(key);
        await engine.cancel(row.dsh_session_id, row.active_request);
        const receipt = await store.request(actor, id, row.active_request);
        if (!isInFlightRequest(receipt.status)) cancellations.delete(key);
      }
      return { requested: row.active_request !== null, requestId: row.active_request };
    },
    async subscribe(
      actor: Principal,
      id: string,
      listener: (event: ConversationEvent) => void,
      signal?: AbortSignal,
    ) {
      check();
      signal?.throwIfAborted();
      const row = await store.owned(actor, id);
      signal?.throwIfAborted();
      check();
      let group = listeners.get(id);
      if (!group) listeners.set(id, (group = new Set()));
      group.add(listener);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        group.delete(listener);
        if (!group.size) listeners.delete(id);
        signal?.removeEventListener('abort', close);
      };
      signal?.addEventListener('abort', close, { once: true });
      try {
        const snapshot = await store.snapshot(actor, id);
        signal?.throwIfAborted();
        check();
        if (engine.contextUsage && row.state === 'ready') {
          const usage = await engine
            .contextUsage(row.dsh_session_id, signal)
            .catch(() => undefined);
          signal?.throwIfAborted();
          check();
          if (usage) {
            const window = row.model_binding
              ? await providers?.chatContextWindow?.(actor, row.model_binding).catch(() => null)
              : usage.contextWindow;
            signal?.throwIfAborted();
            check();
            snapshot.contextUsage = {
              ...publicContextUsage(usage),
              contextWindow: window ?? null,
            };
          }
        }
        return { snapshot, close };
      } catch (error) {
        close();
        throw error;
      }
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
