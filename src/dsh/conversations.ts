import type { Context } from '@deepseek-ai/cordis';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createUserMessage,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  INVALID_CREDENTIAL_CODE,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm';
import type { RequestMessage, UserMessage } from '@deepseek-ai/dsh-llm';
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session';
import type { Session, SessionEvent, SessionSeq, TurnEndReason } from '@deepseek-ai/dsh-session';
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title';
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import type { ConversationConfig } from '../conversations/config.ts';
import {
  ConversationError,
  MAX_CONVERSATION_TITLE_BYTES,
  outputTruncation,
} from '../conversations/contracts.ts';
import type {
  CaptureContextUsage,
  ConversationEngine,
  ConversationAudioTools,
  ConversationImageTools,
  ConversationRunResult,
  ConversationVideoTools,
  ConversationVision,
  HistoryItem,
  ModelFailure,
} from '../conversations/contracts.ts';
import { buildConversationSystemPrompt } from '../conversations/prompt.ts';
import { parseImageJobPresentationMeta, registerConversationImageTools } from './image-tools.ts';
import { parseVideoJobPresentationMeta, registerConversationVideoTools } from './video-tools.ts';
import { parseAudioJobPresentationMeta, registerConversationAudioTools } from './audio-tools.ts';
import {
  CHECKPOINT_INTERRUPTED,
  hasCheckpointFailure,
  trackConversationToolCheckpoints,
} from './conversation-checkpoints.ts';
import { ConversationCompaction, measureConversationContext } from './conversation-compaction.ts';
import { stageProjectContext } from './conversation-context.ts';
import type { ProjectContext } from './conversation-context.ts';
import type {} from './kernel.ts';
import { OBSERVATION_UNAVAILABLE, onelinkRoute, registerOneLink } from './onelink.ts';
import { authorizeConversationAudioTools, authorizeConversationImageTools } from './policy.ts';
import { conversationImageAssetId } from './vision.ts';
import { registerVisionTool } from './vision-tool.ts';
import type { ChatRuntimeSnapshot, ChatSelection } from '../providers/contracts.ts';

const MAX_TURN_STEPS = 8;
interface ActiveRequest {
  opening: Promise<AgentHandle>;
  disposing?: true;
  stop?: 'user' | 'disposed';
  requestId: string;
}

function publicModelFailure(code: string): ModelFailure | undefined {
  switch (code) {
    case 'AUTH':
    case 'MISSING_CREDENTIAL':
    case INVALID_CREDENTIAL_CODE:
      return 'MODEL_AUTH_FAILED';
    case 'QUOTA_EXCEEDED':
    case QUOTA_EXCEEDED_CODE:
      return 'MODEL_QUOTA_EXCEEDED';
    case 'RATE_LIMIT':
      return 'MODEL_RATE_LIMITED';
    case 'TIMEOUT':
      return 'MODEL_TIMEOUT';
    case 'CONTEXT_OVERFLOW':
    case CONTEXT_WINDOW_EXCEEDED_CODE:
      return 'MODEL_CONTEXT_OVERFLOW';
    case 'SERVER':
    case 'TRANSPORT':
      return 'MODEL_UPSTREAM_ERROR';
    case 'TURN_STEP_BUDGET_EXCEEDED':
      return code;
  }
  return undefined;
}

function isForkBoundary(event: SessionEvent | undefined): event is SessionEvent<'turn/end'> {
  if (event?.type !== 'turn/end') return false;
  const { reason } = event.data;
  switch (reason.kind) {
    case 'completed':
    case 'max-tokens':
    case 'blocked':
      return true;
    case 'error':
      return (
        reason.error.code !== OBSERVATION_UNAVAILABLE &&
        (reason.error.code !== 'UNKNOWN' || reason.error.message !== CHECKPOINT_INTERRUPTED)
      );
    case 'aborted':
      return reason.reason.kind === 'user';
    default:
      return false;
  }
}

function forkBoundary(events: readonly SessionEvent[], requested?: number): number {
  // The native persistence codec validates turn, step and tool pairing inside
  // the decoded prefix. Recovery-generated endings never settle a user turn.
  const boundary = requested === undefined ? events.findLast(isForkBoundary) : events[requested];
  if (!isForkBoundary(boundary) || (requested !== undefined && boundary.seq !== requested))
    throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_FORK_BOUNDARY_INVALID');
  return boundary.seq;
}

function containsRetainedImages(messages: readonly RequestMessage[]): boolean {
  return messages.some((message) =>
    message.content.some((block) => block.type === 'image' && block.offloaded !== true),
  );
}

/** Narrow bridge: DSH values stop here; only public text/tool-card/status values leave it. */
export function createDshConversationEngine(
  ctx: Context,
  config: ConversationConfig,
  imageTools?: ConversationImageTools,
  vision?: ConversationVision,
  audioTools?: ConversationAudioTools,
  videoTools?: ConversationVideoTools,
): ConversationEngine {
  const active = new Map<string, ActiveRequest>();
  const sessionActions = new Map<string, Promise<unknown>>();
  const tasks = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const onelink = config.byok ? registerOneLink(ctx, vision) : undefined;
  const installedCompaction = ctx.get('compaction');
  const compaction =
    installedCompaction instanceof ConversationCompaction ? installedCompaction : undefined;
  const meter = ctx.get('tokenMeter');
  const options = {
    ...(config.provider ? { provider: config.provider } : {}),
    ...(config.model ? { model: config.model } : {}),
    maxTokens: 1024,
  };
  const selectedOptions = (selection?: ChatSelection | ChatRuntimeSnapshot) =>
    selection
      ? {
          provider: onelinkRoute(selection),
          model: selection.modelId,
          maxTokens:
            'maxOutputTokens' in selection && selection.maxOutputTokens !== undefined
              ? selection.maxOutputTokens
              : 1024,
        }
      : options;

  // A rename can borrow the turn's handle. Order native opens, writes and
  // disposals per session without holding this queue over a model turn or PG.
  function inSessionOrder<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = sessionActions.get(id) ?? Promise.resolve();
    const pending = previous.then(action, action);
    sessionActions.set(id, pending);
    const done = () => {
      if (sessionActions.get(id) === pending) sessionActions.delete(id);
    };
    void pending.then(done, done);
    return pending;
  }

  function track<T>(id: string, work: Promise<T>): Promise<T> {
    tasks.add(work);
    const done = () => {
      active.delete(id);
      tasks.delete(work);
    };
    void work.then(done, done);
    return work;
  }

  function captureUsage(
    session: Session,
    capture: CaptureContextUsage | undefined,
    window?: number | null,
  ) {
    if (meter) capture?.(() => measureConversationContext(meter, session, window));
  }

  function titleService() {
    // The service is a retained child of the conversation plugin.
    const titles = ctx.get('sessionTitle');
    if (!titles) throw new Error('MIO_SESSION_TITLE_UNAVAILABLE');
    return titles;
  }

  async function renameSession(session: Session, normalized: string): Promise<string> {
    const titles = titleService();
    const current = titles.get(session);
    const accepted =
      current?.source.kind === 'user' && current.title === normalized
        ? current
        : titles.rename(session, normalized);
    await ctx.mioKernel.flush(session);
    return accepted.title;
  }

  return {
    get available() {
      return (
        !closing &&
        Boolean(
          config.model && ctx.llm.listProviders().some((route) => route.id === config.provider),
        )
      );
    },
    async create(id, selection) {
      if (closing) throw new Error('MIO_ENGINE_CLOSED');
      await inSessionOrder(id, async () => {
        const handle = await ctx.mioKernel.create(id, selectedOptions(selection));
        try {
          await ctx.mioKernel.flush(handle.agent.session);
        } finally {
          await handle.dispose();
        }
      });
    },
    async resolveForkBoundary(sourceId, upToSeq) {
      const { events } = await ctx.mioKernel.readPersistedHistory(sourceId);
      return forkBoundary(events, upToSeq);
    },
    async fork(sourceId, targetId, upToSeq, selection) {
      if (closing) throw new Error('MIO_ENGINE_CLOSED');
      await inSessionOrder(targetId, async () => {
        const { events } = await ctx.mioKernel.readPersistedHistory(sourceId);
        const boundary = forkBoundary(events, upToSeq);
        await ctx.mioKernel.createFork(
          sourceId,
          targetId,
          events.slice(0, boundary + 1),
          selectedOptions(selection),
        );
      });
    },
    async retainedAssetIds(id) {
      const view = await ctx.mioKernel.readPersistedView(id);
      const ids = new Set<string>();
      for (const message of view.deriveMessages()) {
        for (const block of message.content) {
          if (block.type !== 'image' || block.offloaded === true) continue;
          const assetId = conversationImageAssetId(String(block.attachment.attachmentId));
          if (assetId) ids.add(assetId);
        }
      }
      return [...ids];
    },
    async hasRetainedImages(id) {
      const view = await ctx.mioKernel.readPersistedView(id);
      return containsRetainedImages(view.deriveMessages());
    },
    async rename(id, title) {
      if (closing) throw new Error('MIO_ENGINE_CLOSED');
      const normalized = normalizeSessionTitle(title.toWellFormed(), MAX_CONVERSATION_TITLE_BYTES);
      if (!normalized) throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      const running = active.get(id);
      const liveOpening = running?.disposing ? undefined : running?.opening;
      return inSessionOrder(id, async () => {
        if (liveOpening) return renameSession((await liveOpening).agent.session, normalized);
        const handle = await ctx.mioKernel.resume(id, {});
        try {
          return await renameSession(handle.agent.session, normalized);
        } finally {
          await handle.dispose();
        }
      });
    },
    ...(meter && {
      async contextUsage(id, signal) {
        const view = await ctx.mioKernel.readView(id, signal);
        return measureConversationContext(meter, view);
      },
    }),
    ...(compaction &&
      meter &&
      onelink && {
        compact(id, binding, signal, capture) {
          if (closing || active.has(id)) return Promise.reject(new Error('MIO_ENGINE_BUSY'));
          if (id !== binding.dshSessionId) return Promise.reject(new Error('MIO_BINDING_REQUIRED'));
          const window = binding.snapshot.contextWindow;
          if (!window)
            return Promise.reject(
              new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_COMPACTION_UNSUPPORTED'),
            );
          const entry: ActiveRequest = {
            opening: inSessionOrder(id, () =>
              ctx.mioKernel.resume(id, selectedOptions(binding.snapshot)),
            ),
            requestId: binding.requestId,
          };
          active.set(id, entry);
          return track(
            id,
            (async (): Promise<ConversationRunResult> => {
              const handle = await entry.opening;
              const { agent } = handle;
              let observationFailed = false;
              const bound = {
                ...binding,
                observe: async (observation: Parameters<typeof binding.observe>[0]) => {
                  try {
                    await binding.observe(observation);
                  } catch {
                    observationFailed = true;
                    throw new Error('MIO_OBSERVATION_UNKNOWN');
                  }
                },
              };
              const stop = () =>
                entry.stop === 'user'
                  ? 'cancelled'
                  : signal.aborted || entry.stop
                    ? 'unknown'
                    : undefined;
              try {
                const before = stop();
                if (before) return before;
                await compaction.withRequest(
                  agent,
                  signal,
                  {
                    binding: bound,
                    adapter: onelink,
                    budget: { used: false },
                  },
                  () => compaction.compactNow(agent, signal),
                );
                captureUsage(agent.session, capture, window);
                return 'completed';
              } catch (error) {
                if (observationFailed || hasCheckpointFailure(agent.session)) return 'unknown';
                const stopped = stop();
                if (stopped) return stopped;
                const failure = error instanceof LlmError && publicModelFailure(error.code);
                return failure ? { status: 'failed', error: failure } : 'failed';
              } finally {
                entry.disposing = true;
                await inSessionOrder(id, () => handle.dispose());
              }
            })(),
          );
        },
      }),
    async history(id, afterSeq, limit, signal) {
      const { events } = await ctx.mioKernel.history(id, signal);
      const items: HistoryItem[] = [];
      for (const [index, event] of events.entries()) {
        if (index > 0 && index % 128 === 0) await yieldToIO(undefined, { signal });
        signal?.throwIfAborted();
        if (event.seq <= afterSeq) continue;
        if (event.type === 'user/message' && event.data.source.kind === 'user') {
          const text = event.data.content
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('');
          const imageAssetIds = event.data.content.flatMap((block) => {
            if (block.type !== 'image') return [];
            const assetId = conversationImageAssetId(String(block.attachment.attachmentId));
            if (!assetId) throw new Error('MIO_IMAGE_HISTORY_INVALID');
            return [assetId];
          });
          if (text)
            items.push({
              seq: event.seq,
              role: 'user',
              text,
              ...(imageAssetIds.length ? { imageAssetIds } : {}),
            });
        }
        if (event.type === 'assistant/message') {
          const text = event.data.message.content
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('');
          if (text)
            items.push({
              seq: event.seq,
              role: 'assistant',
              text,
              ...(event.data.interrupted ? { interrupted: true } : {}),
            });
        }
        if (
          event.type === 'tool/result' &&
          isAppendSurfaceEvent(event) &&
          !event.data.message.isError
        ) {
          const projected =
            parseImageJobPresentationMeta(event.data.meta) ??
            parseAudioJobPresentationMeta(event.data.meta);
          if (projected) items.push({ seq: event.seq, role: 'tool', ...projected });
          const videoProjected = parseVideoJobPresentationMeta(event.data.meta);
          if (videoProjected)
            items.push({
              seq: event.seq,
              role: 'tool',
              tool: videoProjected.tool,
              job: videoProjected.job,
            });
        }
        if (event.type === 'turn/end') {
          const reason = event.data.reason;
          const truncated = reason.kind === outputTruncation.reason;
          const status =
            reason.kind === 'completed' || truncated
              ? 'completed'
              : reason.kind === 'interrupted'
                ? 'interrupted'
                : reason.kind === 'aborted'
                  ? reason.reason.kind === 'user'
                    ? 'cancelled'
                    : 'interrupted'
                  : 'failed';
          items.push({
            seq: event.seq,
            role: 'status',
            status,
            ...(truncated ? { truncation: outputTruncation } : {}),
          });
        }
        if (items.length > limit) break;
      }
      const page = items.slice(0, limit);
      return {
        items: page,
        nextAfterSeq: page.at(-1)?.seq ?? afterSeq,
        hasMore: items.length > limit,
      };
    },
    run(id, requestId, text, durable, emit, binding, images = [], admitted, capture, turnContext) {
      if (closing || active.has(id)) return Promise.reject(new Error('MIO_ENGINE_BUSY'));
      if (
        config.byok &&
        (!binding || binding.dshSessionId !== id || binding.requestId !== requestId)
      )
        return Promise.reject(new Error('MIO_BINDING_REQUIRED'));
      const releases = new Map<AbortSignal, () => void>();
      const runOptions = selectedOptions(binding?.snapshot);
      const reasoningEffort =
        binding?.reasoningEffort === undefined
          ? undefined
          : ReasoningEffortId(binding.reasoningEffort);
      let observationFailed = false;
      let observedFailureCode: string | undefined;
      let oldImageCount = () => 0;
      const observedBinding = binding
        ? {
            ...binding,
            offloadableImages: () => oldImageCount(),
            observe: async (observation: Parameters<typeof binding.observe>[0]) => {
              try {
                await binding.observe(observation);
                if (observation.purpose !== 'compaction')
                  observedFailureCode = observation.failureCode;
              } catch {
                observationFailed = true;
                throw new Error('MIO_OBSERVATION_UNKNOWN');
              }
            },
          }
        : undefined;
      let end: TurnEndReason | undefined;
      let waitForToolCheckpoints: (() => Promise<void>) | undefined;
      let revokeTools: (() => void) | undefined;
      const humanInput = Promise.withResolvers<number>();
      let submittedId: UserMessage['id'] | undefined;
      let inputSeq: SessionSeq | undefined;
      let projectContext: ProjectContext | undefined;
      const compactionBudget = { used: false };
      const resume = () =>
        ctx.mioKernel.resume(id, runOptions, (agentCtx, agent) => {
          const oldNodes = new Set(agent.session.surface.nodes);
          oldImageCount = () => {
            let count = 0;
            for (const seq of agent.session.surface.nodes) {
              const event = agent.session.eventAt(seq);
              if (!event || (event.type !== 'user/message' && event.type !== 'tool/result'))
                continue;
              if (
                !oldNodes.has(seq) &&
                !event.sourceEventSeqs?.some((source) => oldNodes.has(source))
              )
                continue;
              count += (agent.session.deriveEventMessage(event)?.content ?? []).filter(
                (block) => block.type === 'image' && block.offloaded !== true,
              ).length;
            }
            return count;
          };
          if (runOptions.provider && runOptions.model)
            agent.model.select({
              provider: runOptions.provider,
              model: runOptions.model,
              ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            });
          const audioPurpose = turnContext?.purpose === 'audio';
          const audioTurn = turnContext?.audio;
          const inspection =
            !audioPurpose &&
            Boolean(vision && observedBinding?.snapshot.inputModalities?.includes('image'));
          const hasGenerationTools =
            !audioPurpose && Boolean(observedBinding && onelink && imageTools);
          const hasVideoGenerationTools =
            !audioPurpose && Boolean(observedBinding && onelink && videoTools);
          const hasInspectionTool = Boolean(observedBinding && onelink && inspection);
          agentCtx.systemPrompt.section({
            name: PERSONA_PREFIX_SECTION,
            order: 0,
            interpolate: false,
            text: buildConversationSystemPrompt(
              {
                imageGeneration: hasGenerationTools,
                imageInspection: hasInspectionTool,
                videoGeneration: hasVideoGenerationTools,
              },
              turnContext?.purpose,
            ),
          });
          if (
            audioPurpose &&
            audioTools &&
            audioTurn &&
            observedBinding &&
            onelink &&
            audioTurn.userId === observedBinding.userId &&
            audioTurn.conversationId === observedBinding.conversationId &&
            audioTurn.requestId === requestId
          ) {
            revokeTools = authorizeConversationAudioTools(agentCtx, agent, (tool, status) =>
              emit({ type: 'tool-status', requestId, tool, status }),
            );
            waitForToolCheckpoints = trackConversationToolCheckpoints(
              agentCtx,
              agent,
              ctx.mioKernel,
              requestId,
              emit,
            );
            registerConversationAudioTools(agentCtx, audioTurn, audioTools);
          } else if (
            !audioPurpose &&
            observedBinding &&
            onelink &&
            (imageTools || videoTools || inspection)
          ) {
            revokeTools = authorizeConversationImageTools(
              agentCtx,
              agent,
              {
                generation: hasGenerationTools,
                inspection: hasInspectionTool,
                videoGeneration: hasVideoGenerationTools,
              },
              (tool, status) => emit({ type: 'tool-status', requestId, tool, status }),
            );
            if (imageTools || videoTools) {
              waitForToolCheckpoints = trackConversationToolCheckpoints(
                agentCtx,
                agent,
                ctx.mioKernel,
                requestId,
                emit,
              );
              if (imageTools) registerConversationImageTools(agentCtx, observedBinding, imageTools);
              if (videoTools) registerConversationVideoTools(agentCtx, observedBinding, videoTools);
            }
            if (inspection) registerVisionTool(agentCtx, observedBinding, vision!);
          }
          const compactStep =
            compaction && onelink && observedBinding
              ? async (
                  trigger: 'pressure' | 'context-overflow',
                  turn: number,
                  step: number,
                  signal: AbortSignal,
                  pending: readonly UserMessage[],
                ) => {
                  const result = await compaction.withRequest(
                    agent,
                    signal,
                    {
                      binding: observedBinding,
                      adapter: onelink,
                      budget: compactionBudget,
                      turn: {
                        number: turn,
                        firstStep: step === 1,
                        pending,
                        inputSeq,
                        projectContext,
                      },
                    },
                    () => compaction.compactIfNeeded(agent, trigger, signal),
                  );
                  if (
                    projectContext?.seq !== undefined &&
                    result?.shadowedSeqs.includes(projectContext.seq)
                  ) {
                    signal.throwIfAborted();
                    const { source, content } = projectContext.message;
                    projectContext.seq = agent.session.append(
                      'user/message',
                      createUserMessage({ source, content }),
                      { surfaceOp: 'append' },
                    ).seq;
                  }
                  return result;
                }
              : undefined;
          agentCtx.on('agent/pre-step', async (payload, next) => {
            if (payload.step > MAX_TURN_STEPS) {
              throw new LlmError(
                `Conversation turn exceeded ${MAX_TURN_STEPS} steps`,
                'TURN_STEP_BUDGET_EXCEEDED',
              );
            }
            if (
              !observedBinding?.snapshot.inputModalities?.includes('image') &&
              (containsRetainedImages(payload.messages) ||
                containsRetainedImages(agent.session.deriveMessages()))
            )
              throw new LlmError(
                'Model does not support image input',
                'MODEL_MODALITY_UNSUPPORTED',
              );
            if (observedBinding && onelink) {
              if (
                payload.agent.id !== observedBinding.dshSessionId ||
                payload.modelSelection.provider !== runOptions.provider ||
                payload.modelSelection.model !== observedBinding.snapshot.modelId ||
                payload.modelSelection.reasoningEffort !== reasoningEffort
              )
                throw new Error('MIO_BINDING_MISMATCH');
              if (!releases.has(payload.signal))
                releases.set(payload.signal, onelink.bind(payload.signal, observedBinding));
            }
            const decision = await next();
            if (decision.kind === 'reject') return decision;
            let messages = decision.messages;
            if (
              turnContext?.purpose === 'drama-script' &&
              payload.step === 1 &&
              messages.some((message) => message.id === submittedId)
            ) {
              payload.signal.throwIfAborted();
              projectContext = stageProjectContext(agent.session, turnContext.projectContext);
              if (projectContext && projectContext.seq === undefined)
                messages = [projectContext.message, ...messages];
            }
            await compactStep?.('pressure', payload.turn, payload.step, payload.signal, messages);
            return messages === decision.messages ? decision : { ...decision, messages };
          });
          let attemptPublishedText = false;
          if (compactStep) {
            agentCtx.on(
              'agent/request-error',
              async (payload, next) => {
                // Native image offload is a local pre-transport correction.
                if (payload.failure.code === IMAGE_OFFLOAD_REQUIRED_CODE) return next();
                if (
                  payload.failure.code !== 'CONTEXT_OVERFLOW' ||
                  payload.signal.aborted ||
                  !observedBinding?.snapshot.contextWindow ||
                  attemptPublishedText ||
                  observationFailed ||
                  compactionBudget.used
                )
                  return;
                const result = await compactStep(
                  'context-overflow',
                  payload.turn,
                  payload.step,
                  payload.signal,
                  [],
                );
                if (result && !payload.signal.aborted) return { kind: 'retry' };
              },
              { prepend: true },
            );
          }
          agentCtx.on('agent/assistant-stream', ({ frame }) => {
            if (frame.type === 'start') attemptPublishedText = false;
            if (frame.type !== 'chunk') return;
            if (frame.chunk.type === 'text-delta') {
              if (frame.chunk.text.length > 0) attemptPublishedText = true;
              emit({ type: 'text', requestId, text: frame.chunk.text });
            } else if (
              frame.chunk.type === 'reasoning-delta' &&
              observedBinding?.snapshot.reasoning?.supported &&
              typeof frame.chunk.text === 'string' &&
              frame.chunk.text.length > 0
            ) {
              emit({ type: 'reasoning', requestId, text: frame.chunk.text });
            }
          });
          agentCtx.on('session/event', (session, event) => {
            if (session !== agent.session) return;
            if (event.type === 'user/message') {
              if (projectContext?.message.id === event.data.id) projectContext.seq = event.seq;
              if (event.data.source.kind === 'user' && event.data.id === submittedId) {
                inputSeq = event.seq;
                humanInput.resolve(event.time);
              }
            }
            if (event.type === 'turn/end') end = event.data.reason;
          });
        });
      const entry: ActiveRequest = {
        opening: inSessionOrder(id, resume),
        requestId,
      };
      active.set(id, entry);
      const running = (async () => {
        const handle = await entry.opening;
        try {
          if (entry.stop)
            return entry.stop === 'user' ? ('cancelled' as const) : ('unknown' as const);
          const message = createUserMessage({
            content: [
              { type: 'text', text },
              ...images.map((image) => ({
                type: 'image' as const,
                attachment: { ...image, attachmentId: AttachmentId(image.attachmentId) },
              })),
            ],
            source: { kind: 'user' },
          });
          submittedId = message.id;
          handle.agent.followup(message);
          await ctx.mioKernel.flush(handle.agent.session);
          await durable();
          const idle = handle.agent.whenIdle();
          if (admitted) {
            const time = await Promise.race([humanInput.promise, idle]);
            if (time !== undefined) {
              const session = handle.agent.session;
              // The same refresh API can unpin a manual title. Only call it
              // while the log lacks any accepted title.
              const titles = titleService();
              const title = titles.get(session) ?? (await titles.refresh(session));
              await ctx.mioKernel.flush(session);
              await admitted(
                time,
                title?.source.kind === 'fallback' ? title.title.toWellFormed() : undefined,
              );
            }
          }
          await idle;
          await waitForToolCheckpoints?.();
          revokeTools?.();
          await ctx.mioKernel.flush(handle.agent.session);
          if (observationFailed || hasCheckpointFailure(handle.agent.session))
            return 'unknown' as const;
          captureUsage(
            handle.agent.session,
            capture,
            binding ? (binding.snapshot.contextWindow ?? null) : undefined,
          );
          // A disposed session can leave only a durable prefix, with no turn/end
          // event. Cold replay then reports interruption, not a definite failure.
          if (!end || end.kind === 'interrupted') return 'unknown' as const;
          if (end.kind === 'completed' || end.kind === outputTruncation.reason) return end.kind;
          if (end.kind === 'aborted' && end.reason.kind === 'user') return 'cancelled' as const;
          if (end.kind === 'aborted' && end.reason.kind === 'disposed') return 'unknown' as const;
          if (end.kind === 'error') {
            const error = publicModelFailure(observedFailureCode ?? end.error.code);
            if (error) return { status: 'failed' as const, error };
          }
          return 'failed' as const;
        } finally {
          entry.disposing = true;
          try {
            await inSessionOrder(id, () => handle.dispose());
          } finally {
            revokeTools?.();
            for (const release of releases.values()) release();
          }
        }
      })();
      return track(id, running);
    },
    async cancel(id, requestId) {
      const entry = active.get(id);
      if (!entry || entry.requestId !== requestId) return;
      if (entry.stop === 'disposed') return;
      entry.stop = 'user';
      const handle = await entry.opening;
      handle.agent.cancel({ kind: 'user' });
      await handle.agent.whenIdle();
    },
    close() {
      return (closing ??= (async () => {
        const cancellations = await Promise.allSettled(
          [...active.values()].map(async (entry) => {
            entry.stop ??= 'disposed';
            const handle = await entry.opening;
            handle.agent.cancel({ kind: entry.stop });
          }),
        );
        const settled = await Promise.allSettled([...tasks, ...sessionActions.values()]);
        const failures = [...cancellations, ...settled].filter(
          (result) => result.status === 'rejected',
        );
        if (failures.length)
          throw new AggregateError(
            failures.map((failure) => failure.reason),
            'DSH conversation cleanup failed',
          );
      })());
    },
  };
}
