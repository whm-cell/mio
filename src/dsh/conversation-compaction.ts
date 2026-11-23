import { createId } from '@mio/foundation/identifiers';
import type { Context } from '@deepseek-ai/cordis';
import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction';
import type {
  CompactionAgentContext,
  CompactionResult,
  CompactionTrigger,
  ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction';
import {
  BlockAssembler,
  createSystemMessage,
  createUserMessage,
  LlmError,
} from '@deepseek-ai/dsh-llm';
import type { ContentBlock, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';
import type { TokenMeasurement, TokenMeter, TokenSurfaceNode } from '@deepseek-ai/dsh-token-meter';
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import {
  CONVERSATION_COMPACTION_PROMPT,
  compactionThreshold,
} from '../conversations/compaction.ts';
import type { ContextUsage, ConversationRun } from '../conversations/contracts.ts';
import { fitSummaryInput } from './conversation-summary.ts';
import { onelinkRoute, snapshotMaxTokens } from './onelink.ts';
import type { OneLinkAdapter } from './onelink.ts';

interface CompactRequest {
  readonly binding: ConversationRun;
  readonly adapter: OneLinkAdapter;
  readonly budget: { used: boolean };
  readonly turn?: {
    readonly number: number;
    readonly firstStep: boolean;
    readonly pending: readonly UserMessage[];
    readonly inputSeq: SessionSeq | undefined;
  };
}

interface Region {
  readonly start: SessionSeq;
  readonly end: SessionSeq;
}

const checkpointPreamble = '以下是本会话先前的创作资料。按当前用户请求接续。';

export function measureConversationContext(
  meter: TokenMeter,
  session: Session,
  contextWindow = session.requestContext()?.contextWindow ?? null,
): ContextUsage {
  const { totalTokens, nodes } = meter.measure(session);
  const compacted = nodes.some(({ seq }) => {
    const event = session.eventAt(seq);
    return event?.type === 'user/message' && isCompactCheckpointSource(event.data.source);
  });
  return { estimatedTokens: totalTokens, contextWindow, compacted };
}

function rangeFor(
  session: Session,
  measurement: TokenMeasurement,
  inputSeq?: SessionSeq,
): Region | undefined {
  const { nodes } = measurement;
  const head = nodes[0];
  if (!head) return;
  const start = Number(session.eventAt(head.seq)?.type === 'system/message');
  const inputIndex = inputSeq === undefined ? -1 : nodes.findIndex(({ seq }) => seq === inputSeq);
  let cut = nodes.length - Math.ceil((nodes.length - start) * 0.2);
  if (inputIndex !== -1) cut = Math.min(cut, inputIndex);
  while (cut > start && !toolPairingBalancedBefore(session, nodes[cut]!.seq)) cut--;
  if (cut <= start) return;
  const first = nodes[start]!;
  const event = session.eventAt(first.seq);
  if (
    cut === start + 1 &&
    event?.type === 'user/message' &&
    isCompactCheckpointSource(event.data.source)
  )
    return;
  return { start: first.seq, end: nodes[cut - 1]!.seq };
}

export class ConversationCompaction extends CompactionEngine {
  private readonly requests = new WeakMap<
    Session,
    { signal: AbortSignal; request: CompactRequest }
  >();

  private readonly flush: (session: Session) => Promise<unknown>;

  constructor(ctx: Context, flush: (session: Session) => Promise<unknown>) {
    super(ctx);
    this.flush = flush;
  }

  /** Admit the native engine only for a Mio-owned operation on this exact session. */
  async withRequest<T>(
    agent: CompactionAgentContext,
    signal: AbortSignal,
    request: CompactRequest,
    perform: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const { session } = agent;
    if (session.id !== request.binding.dshSessionId || this.requests.has(session))
      throw new LlmError('Conversation compaction binding mismatch', 'BINDING_REQUIRED');
    this.requests.set(session, { signal, request });
    try {
      return await perform();
    } finally {
      this.requests.delete(session);
    }
  }

  private owner(agent: CompactionAgentContext, signal?: AbortSignal): CompactRequest {
    const bound = this.requests.get(agent.session);
    if (!bound || !signal || bound.signal !== signal)
      throw new LlmError('Conversation compaction binding required', 'BINDING_REQUIRED');
    signal.throwIfAborted();
    return bound.request;
  }

  override async compactIfNeeded(
    agent: CompactionAgentContext,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const request = this.owner(agent, signal);
    if (!request.turn || request.budget.used) return null;

    const { session } = agent;
    const window = request.binding.snapshot.contextWindow;
    // The second and later model steps must see this turn's tool output as produced.
    if (window === undefined) {
      if (request.turn.firstStep) await this.prune(session, signal);
      return null;
    }
    const meter = this.ctx.get('tokenMeter');
    if (!meter) return null;
    const threshold = compactionThreshold(window, snapshotMaxTokens(request.binding.snapshot));
    const pending = request.turn.pending.reduce(
      (sum, message) => sum + meter.estimateMessage(message),
      0,
    );
    let measurement = meter.measure(session);
    const belowThreshold = () =>
      trigger === 'pressure' && measurement.totalTokens + pending < threshold;
    if (belowThreshold()) return null;
    if (request.turn.firstStep && (await this.prune(session, signal))) {
      measurement = meter.measure(session);
      if (belowThreshold()) return null;
    }
    const region = rangeFor(session, measurement, request.turn.inputSeq);
    return region
      ? this.commit(session, region, request, request.turn.number, signal, meter, measurement.nodes)
      : null;
  }

  private async prune(session: Session, signal: AbortSignal): Promise<boolean> {
    if (!this.ctx.get('toolResultPruner')?.pruneSession(session).pruned.length) return false;
    await this.flush(session);
    signal.throwIfAborted();
    return true;
  }

  override async compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const request = this.owner(agent, signal);
    if (!request.binding.snapshot.contextWindow)
      throw new LlmError('Conversation model context window is unavailable', 'BINDING_REQUIRED');
    const { session } = agent;
    const meter = this.ctx.get('tokenMeter');
    if (!meter) throw new Error('MIO_TOKEN_METER_UNAVAILABLE');
    return agent.runMaintenance(async (maintenanceSignal) => {
      const ownedSignal = AbortSignal.any([signal, maintenanceSignal]);
      ownedSignal.throwIfAborted();
      await this.prune(session, ownedSignal);
      const measurement = meter.measure(session);
      const range = rangeFor(session, measurement);
      if (!range) return null;
      const release = request.adapter.bind(ownedSignal, request.binding);
      try {
        return await this.commit(
          session,
          range,
          request,
          null,
          ownedSignal,
          meter,
          measurement.nodes,
        );
      } finally {
        release();
      }
    });
  }

  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const request = this.owner(agent, signal);
    const meter = this.ctx.get('tokenMeter');
    if (!meter || !request.turn) throw new Error('MIO_COMPACTION_SCOPE_REQUIRED');
    const result = await this.commit(
      agent.session,
      { start, end },
      request,
      request.turn.number,
      signal!,
      meter,
      meter.measure(agent.session).nodes,
      true,
    );
    if (!result)
      throw new ManualCompactionError('summary', 'Selected history cannot fit a useful summary');
    return result;
  }

  private async commit(
    session: Session,
    proposed: Region,
    request: CompactRequest,
    turn: number | null,
    signal: AbortSignal,
    meter: TokenMeter,
    nodes: readonly TokenSurfaceNode[],
    exact = false,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted();
    const { binding, budget } = request;
    const window = binding.snapshot.contextWindow;
    if (!window || budget.used)
      throw new ManualCompactionError('busy', 'Compaction is unavailable');
    const first = nodes.findIndex(({ seq }) => seq === proposed.start);
    const last = nodes.findIndex(({ seq }) => seq === proposed.end);
    if (
      first < 0 ||
      last < first ||
      !toolPairingBalancedBefore(session, proposed.start) ||
      !toolPairingBalancedAfter(session, proposed.end)
    )
      throw new ManualCompactionError('changed', 'Compaction requires balanced surface boundaries');
    const candidates = nodes.slice(first, last + 1);
    const system = createSystemMessage(CONVERSATION_COMPACTION_PROMPT);
    const maxTokens = Math.max(
      1,
      Math.min(snapshotMaxTokens(binding.snapshot), 1024, Math.floor(window / 8)),
    );
    const input = fitSummaryInput(
      session,
      candidates,
      meter,
      window - maxTokens - meter.estimateMessage(system),
    );
    if (!input || (exact && input.count !== candidates.length)) return null;
    const { message, referenceText } = input;
    const selected = candidates.slice(0, input.count);
    const shadowedSeqs = selected.map(({ seq }) => seq);
    const end = shadowedSeqs.at(-1)!;
    const region = { start: proposed.start, end };
    const shadowedTokenCount = selected.reduce(
      (count, { heuristicTokens }) => count + heuristicTokens,
      0,
    );
    const startEventType = session.eventAt(region.start);
    if (
      (selected.length === 1 &&
        startEventType?.type === 'user/message' &&
        isCompactCheckpointSource(startEventType.data.source)) ||
      shadowedTokenCount <=
        meter.estimateMessage(
          createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: checkpointPreamble + referenceText }],
          }),
        )
    )
      return null;

    budget.used = true;
    const compactionId = CompactionId(createId());
    const lifetime = { compactionId, turn };
    const startEvent = session.append('compaction/start', lifetime);
    const surfaceGeneration = session.surface.contentGeneration;
    let closing = false;
    try {
      const provider = onelinkRoute(binding.snapshot);
      const model = binding.snapshot.modelId;
      const { summary, usage } = await request.adapter.withCompaction(signal, binding, () =>
        this.summarize(provider, model, session, signal, maxTokens, system, message),
      );
      signal.throwIfAborted();
      if (session.surface.contentGeneration !== surfaceGeneration)
        throw new ManualCompactionError('changed', 'Compaction surface changed during dispatch');
      const content = [
        { type: 'text' as const, text: checkpointPreamble },
        ...summary,
        ...(referenceText ? [{ type: 'text' as const, text: referenceText }] : []),
      ];
      const checkpoint = createUserMessage({
        source: compactCheckpointSource(compactionId),
        content,
      });
      if (
        meter.estimateMessage(checkpoint) >=
        selected.reduce((count, node) => count + node.tokens, 0)
      )
        throw new ManualCompactionError(
          'summary',
          'Compaction summary did not reduce the selected history',
        );
      const summaryEvent = session.append('compaction/summary', {
        compactionId,
        summary,
        shadowedRange: region,
        shadowedSeqs,
        shadowedTokenCount,
        provider,
        model,
        maxTokens,
        ...(usage && { usage }),
      });
      session.append('user/message', checkpoint, {
        surfaceOp: { op: 'replace', startSeq: region.start, endSeq: region.end },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
      });
      closing = true;
      const endEvent = session.append('compaction/end', lifetime);
      return {
        compactionId,
        startSeq: startEvent.seq,
        summarySeq: summaryEvent.seq,
        endSeq: endEvent.seq,
        summary,
        shadowedRange: region,
        shadowedSeqs,
        shadowedTokenCount,
      };
    } catch (error) {
      if (!closing) {
        session.append('compaction/end', {
          ...lifetime,
          error: signal.aborted ? 'Compaction cancelled' : 'Compaction failed',
        });
      }
      throw error;
    } finally {
      await this.flush(session);
    }
  }

  private async summarize(
    provider: string,
    model: string,
    session: Session,
    signal: AbortSignal,
    maxTokens: number,
    system: ReturnType<typeof createSystemMessage>,
    message: UserMessage,
  ): Promise<{ summary: ContentBlock[]; usage: TokenUsage | undefined }> {
    const llm = this.ctx.get('llm');
    if (!llm) throw new Error('MIO_COMPACTION_LLM_UNAVAILABLE');
    const call = await llm.prepareCall({ provider, model, maxTokens }, signal);
    const assembled = new BlockAssembler();
    let finished = false;
    for await (const chunk of call.stream({
      ...call.config,
      messages: [system, message],
      sessionId: session.id,
      signal,
      purpose: 'compaction',
    })) {
      assembled.push(chunk);
      if (chunk.type === 'finish') finished = true;
    }
    signal.throwIfAborted();
    const finish = assembled.finish;
    if (finish.kind === 'error' || finish.kind === 'aborted')
      throw new LlmError('Conversation summary failed', finish.failure.code);
    const blocks = assembled.blocks();
    const summary = blocks.filter((block) => block.type === 'text');
    if (
      !finished ||
      finish.kind !== 'stop' ||
      blocks.some((block) => block.type !== 'text' && block.type !== 'reasoning') ||
      !summary.some((block) => block.text.trim())
    )
      throw new ManualCompactionError('summary', 'Conversation summary was incomplete');
    return { summary, usage: assembled.usage };
  }
}
