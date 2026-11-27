import { HTTP_STATUS } from '@mio/foundation/http-status';
import {
  BlockAssembler,
  createSystemMessage,
  createUserMessage,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm';
import type { FinishReason, RequestMessage } from '@deepseek-ai/dsh-llm';
import type { ModelFailure } from '../providers/contracts.ts';
import type { PromptModelCaller, PromptModelResult } from '../prompts/contracts.ts';
import { UNTRUSTED_MATERIAL_DECLARATION } from '../prompts/envelope.ts';
import {
  chatFailureCode,
  modelObservation,
  onelinkRoute,
  requestAdapter,
  snapshotMaxTokens,
} from './onelink.ts';
import type { OneLinkResponseFacts } from './onelink.ts';

const publicFailures: Readonly<Record<string, ModelFailure>> = {
  AUTH: 'MODEL_AUTH_FAILED',
  QUOTA_EXCEEDED: 'MODEL_QUOTA_EXCEEDED',
  RATE_LIMIT: 'MODEL_RATE_LIMITED',
  TIMEOUT: 'MODEL_TIMEOUT',
  CONTEXT_OVERFLOW: 'MODEL_CONTEXT_OVERFLOW',
};

/** One request-owned SDK call. No Agent, session, persistence, tool or credential service. */
export const callPromptModel: PromptModelCaller = async (request) => {
  const { snapshot, signal, input } = request;
  if (signal.aborted) return { status: 'cancelled' };
  const facts: OneLinkResponseFacts = {};
  const execution = { started: false };
  const assembler = new BlockAssembler();
  let terminal: FinishReason | undefined;
  let failure: { code: string; message?: string } | undefined;
  let setupError: unknown;
  try {
    const provider = onelinkRoute(snapshot);
    const adapter = requestAdapter(snapshot, facts, execution);
    const call = await adapter.prepareCall(provider, snapshot.modelId, signal);
    if (signal.aborted) return { status: 'cancelled' };
    const messages: RequestMessage[] = [
      createSystemMessage(input.system + '\n\n' + UNTRUSTED_MATERIAL_DECLARATION),
    ];
    if (input.sharedContext !== undefined)
      messages.push(
        createUserMessage({
          content: [{ type: 'text', text: input.sharedContext }],
          source: { kind: 'user' },
        }),
      );
    messages.push(
      createUserMessage({
        content: [{ type: 'text', text: input.prompt }],
        source: { kind: 'user' },
      }),
    );
    const maxTokens = snapshotMaxTokens(snapshot);
    for await (const chunk of call.stream({
      provider,
      model: snapshot.modelId,
      messages,
      signal,
      maxTokens: Math.min(maxTokens, request.maxOutputTokens ?? maxTokens),
      ...(request.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }),
    })) {
      assembler.push(chunk);
      if (chunk.type === 'finish') terminal = chunk.reason;
    }
    if (terminal?.kind === 'error' || terminal?.kind === 'aborted') failure = terminal.failure;
    else if (!terminal) failure = { code: 'STREAM_CLOSED' };
  } catch (error) {
    setupError = error;
    failure =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? { code: error.code, message: error.message }
        : { code: 'ONELINK_FAILED' };
  }
  if (!execution.started) {
    if (signal.aborted) return { status: 'cancelled' };
    // Trusted configuration or an internal invariant failed before an outbound request.
    throw setupError ?? new Error('PROMPT_DISPATCH_NOT_STARTED');
  }
  const aborted = signal.aborted;
  const failureCode =
    failure || aborted
      ? chatFailureCode(aborted, facts, failure ?? { code: 'ABORTED' })
      : undefined;
  const interrupted =
    !aborted &&
    failureCode !== 'CONTEXT_OVERFLOW' &&
    (facts.status === undefined || facts.status < HTTP_STATUS.BAD_REQUEST) &&
    (failure !== undefined || !terminal);
  const finish = aborted ? 'aborted' : interrupted ? 'unknown' : (terminal?.kind ?? 'error');
  const observation = modelObservation(
    facts,
    assembler.usage,
    finish,
    failureCode,
    request.purpose,
  );
  try {
    await request.observe(observation);
  } catch {
    return { status: 'unknown', error: 'OBSERVATION_UNAVAILABLE', observation };
  }
  if (aborted) return { status: 'cancelled', observation };
  if (interrupted) return { status: 'unknown', error: 'MODEL_STREAM_INTERRUPTED', observation };
  if (finish !== 'stop' && finish !== 'max-tokens')
    return {
      status: 'failed',
      error: publicFailures[failureCode!] ?? 'MODEL_UPSTREAM_ERROR',
      observation,
    };
  const text = assembler
    .blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return { status: 'succeeded', text, observation } satisfies PromptModelResult;
};
