import type { Context } from '@deepseek-ai/cordis';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm';
import type { TurnEndReason } from '@deepseek-ai/dsh-session';
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt';
import type { ConversationConfig } from '../conversations/config.ts';
import { outputTruncation } from '../conversations/contracts.ts';
import type {
  ConversationEngine,
  ConversationImageTools,
  ConversationVision,
  HistoryItem,
} from '../conversations/contracts.ts';
import { buildConversationSystemPrompt } from '../conversations/prompt.ts';
import { parseImageJobPresentationMeta, registerConversationImageTools } from './image-tools.ts';
import type {} from './kernel.ts';
import { registerOneLink, onelinkRoute } from './onelink.ts';
import { authorizeConversationImageTools } from './policy.ts';
import { conversationImageAssetId } from './vision.ts';
import { registerVisionTool } from './vision-tool.ts';
import type { ChatRuntimeSnapshot, ChatSelection } from '../providers/contracts.ts';

const MAX_TURN_STEPS = 8;

/** Narrow bridge: DSH values stop here; only public text/tool-card/status values leave it. */
export function createDshConversationEngine(
  ctx: Context,
  config: ConversationConfig,
  imageTools?: ConversationImageTools,
  vision?: ConversationVision,
): ConversationEngine {
  const active = new Map<
    string,
    { opening: Promise<AgentHandle>; stop?: 'user' | 'disposed'; requestId: string }
  >();
  const tasks = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const onelink = config.byok ? registerOneLink(ctx, vision) : undefined;
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
      const handle = await ctx.mioKernel.create(id, selectedOptions(selection));
      try {
        await ctx.mioKernel.flush(handle.agent.session);
      } finally {
        await handle.dispose();
      }
    },
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
        if (event.type === 'tool/result' && !event.data.message.isError) {
          const projected = parseImageJobPresentationMeta(event.data.meta);
          if (projected)
            items.push({ seq: event.seq, role: 'tool', tool: projected.tool, job: projected.job });
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
    run(id, requestId, text, durable, emit, binding, images = []) {
      if (closing || active.has(id)) return Promise.reject(new Error('MIO_ENGINE_BUSY'));
      if (
        config.byok &&
        (!binding || binding.dshSessionId !== id || binding.requestId !== requestId)
      )
        return Promise.reject(new Error('MIO_BINDING_REQUIRED'));
      const releases = new Map<AbortSignal, () => void>();
      const runOptions = selectedOptions(binding?.snapshot);
      let observationFailed = false;
      let oldImageCount = () => 0;
      const observedBinding = binding
        ? {
            ...binding,
            offloadableImages: () => oldImageCount(),
            observe: async (...args: Parameters<typeof binding.observe>) => {
              try {
                await binding.observe(...args);
              } catch {
                observationFailed = true;
                throw new Error('MIO_OBSERVATION_UNKNOWN');
              }
            },
          }
        : undefined;
      let end: TurnEndReason | undefined;
      let revokeImageTools: (() => void) | undefined;
      const entry: {
        opening: Promise<AgentHandle>;
        stop?: 'user' | 'disposed';
        requestId: string;
      } = {
        opening: ctx.mioKernel.resume(id, runOptions, (agentCtx, agent) => {
          const oldNodes = new Set(agent.session.surface.nodes);
          oldImageCount = () => {
            let count = 0;
            for (const seq of agent.session.surface.nodes) {
              if (!oldNodes.has(seq)) continue;
              const event = agent.session.eventAt(seq);
              if (!event || (event.type !== 'user/message' && event.type !== 'tool/result'))
                continue;
              count += (agent.session.deriveEventMessage(event)?.content ?? []).filter(
                (block) => block.type === 'image' && block.offloaded !== true,
              ).length;
            }
            return count;
          };
          if (runOptions.provider && runOptions.model)
            agent.model.select({ provider: runOptions.provider, model: runOptions.model });
          const inspection = Boolean(
            vision && observedBinding?.snapshot.inputModalities?.includes('image'),
          );
          const hasGenerationTools = Boolean(observedBinding && onelink && imageTools);
          const hasInspectionTool = Boolean(observedBinding && onelink && inspection);
          agentCtx.systemPrompt.section({
            name: PERSONA_PREFIX_SECTION,
            order: 0,
            interpolate: false,
            text: buildConversationSystemPrompt({
              imageGeneration: hasGenerationTools,
              imageInspection: hasInspectionTool,
            }),
          });
          if (observedBinding && onelink && (imageTools || inspection)) {
            revokeImageTools = authorizeConversationImageTools(agentCtx, agent, {
              generation: hasGenerationTools,
              inspection: hasInspectionTool,
            });
            if (imageTools) registerConversationImageTools(agentCtx, observedBinding, imageTools);
            if (inspection) registerVisionTool(agentCtx, observedBinding, vision!);
          }
          agentCtx.on('agent/pre-step', (payload, next) => {
            if (payload.step > MAX_TURN_STEPS) {
              throw new LlmError(
                `Conversation turn exceeded ${MAX_TURN_STEPS} steps`,
                'TURN_STEP_BUDGET_EXCEEDED',
              );
            }
            if (!observedBinding?.snapshot.inputModalities?.includes('image')) {
              const hasPendingImage = payload.messages.some((message) =>
                message.content.some((block) => block.type === 'image'),
              );
              const hasHistoryImage = agent.session.surface.nodes.some((seq) => {
                const event = agent.session.eventAt(seq);
                return Boolean(
                  event &&
                  (event.type === 'user/message' || event.type === 'tool/result') &&
                  agent.session
                    .deriveEventMessage(event)
                    ?.content.some((block) => block.type === 'image'),
                );
              });
              if (hasPendingImage || hasHistoryImage)
                throw new LlmError(
                  'Model does not support image input',
                  'MODEL_MODALITY_UNSUPPORTED',
                );
            }
            if (observedBinding && onelink) {
              if (
                payload.agent.id !== observedBinding.dshSessionId ||
                payload.modelSelection.provider !== runOptions.provider ||
                payload.modelSelection.model !== observedBinding.snapshot.modelId
              )
                throw new Error('MIO_BINDING_MISMATCH');
              releases.set(payload.signal, onelink.bind(payload.signal, observedBinding));
            }
            return next();
          });
          agentCtx.on('agent/assistant-stream', ({ frame }) => {
            if (frame.type === 'chunk' && frame.chunk.type === 'text-delta')
              emit({ type: 'text', requestId, text: frame.chunk.text });
          });
          agentCtx.on('session/event', (session, event) => {
            if (session !== agent.session) return;
            if (event.type === 'tool/result' && !event.data.message.isError) {
              const projected = parseImageJobPresentationMeta(event.data.meta);
              if (projected) {
                emit({ type: 'tool', requestId, tool: projected.tool, job: projected.job });
              }
            }
            if (event.type === 'turn/end') end = event.data.reason;
          });
        }),
        requestId,
      };
      active.set(id, entry);
      const running = (async () => {
        const handle = await entry.opening;
        try {
          if (entry.stop)
            return entry.stop === 'user' ? ('cancelled' as const) : ('unknown' as const);
          handle.agent.followup(
            createUserMessage({
              content: [
                { type: 'text', text },
                ...images.map((image) => ({
                  type: 'image' as const,
                  attachment: { ...image, attachmentId: AttachmentId(image.attachmentId) },
                })),
              ],
              source: { kind: 'user' },
            }),
          );
          await ctx.mioKernel.flush(handle.agent.session);
          await durable();
          await handle.agent.whenIdle();
          revokeImageTools?.();
          await ctx.mioKernel.flush(handle.agent.session);
          if (observationFailed) return 'unknown' as const;
          // A disposed session can leave only a durable prefix, with no turn/end
          // event. Cold replay then reports interruption, not a definite failure.
          if (!end || end.kind === 'interrupted') return 'unknown' as const;
          if (end.kind === 'completed' || end.kind === outputTruncation.reason) return end.kind;
          if (end.kind === 'aborted' && end.reason.kind === 'user') return 'cancelled' as const;
          if (end.kind === 'aborted' && end.reason.kind === 'disposed') return 'unknown' as const;
          return 'failed' as const;
        } finally {
          try {
            await handle.dispose();
          } finally {
            revokeImageTools?.();
            for (const release of releases.values()) release();
          }
        }
      })();
      tasks.add(running);
      const done = () => {
        active.delete(id);
        tasks.delete(running);
      };
      void running.then(done, done);
      return running;
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
        const settled = await Promise.allSettled(tasks);
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
