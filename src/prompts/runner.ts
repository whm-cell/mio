import { HttpError } from '@mio/foundation/errors';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { snapshotMaxTokens, supportsChatReasoning } from '../providers/contracts.ts';
import type {
  ChatReasoningEffort,
  ChatRuntimeSnapshot,
  ModelFailure,
  ModelObservation,
} from '../providers/contracts.ts';
import { assertTemplateVersion } from './contracts.ts';
import type {
  PromptInput,
  PromptModelCaller,
  StructuredPromptSpec,
  ValidationIssue,
} from './contracts.ts';

const log = createLogger('app', 'prompts');

export interface PromptExecution {
  readonly ownerId: string;
  readonly snapshot: ChatRuntimeSnapshot;
  readonly signal: AbortSignal;
  /** Business-owned stable evidence identity, e.g. `${taskId}:${requestId}`. */
  readonly evidence: string;
  readonly reasoningEffort?: ChatReasoningEffort;
  readonly observe: (observation: ModelObservation) => Promise<void>;
}
export interface StructuredPromptRequest<TInput, TOutput> extends PromptExecution {
  readonly spec: StructuredPromptSpec<TInput, TOutput>;
  readonly input: TInput;
}
export interface TextPromptRequest extends PromptExecution {
  readonly input: PromptInput;
}
export type PromptFailure =
  | ModelFailure
  | 'MODEL_MAX_TOKENS_INSUFFICIENT'
  | 'MODEL_REASONING_UNSUPPORTED'
  | 'MODEL_OUTPUT_TRUNCATED'
  | 'MODEL_OUTPUT_INVALID';
export type PromptResult<T> = (
  | { readonly status: 'succeeded'; readonly value: T }
  | {
      readonly status: 'failed';
      readonly error: PromptFailure;
      readonly issues?: readonly ValidationIssue[];
    }
  | { readonly status: 'cancelled' }
  | {
      readonly status: 'unknown';
      readonly error: 'MODEL_STREAM_INTERRUPTED' | 'OBSERVATION_UNAVAILABLE';
    }
) & { readonly observations: readonly ModelObservation[] };

export interface PromptRuntime {
  executeStructuredPrompt<TInput, TOutput>(
    request: StructuredPromptRequest<TInput, TOutput>,
  ): Promise<PromptResult<TOutput>>;
  executeTextPrompt(request: TextPromptRequest): Promise<PromptResult<string>>;
  /** Stops admission synchronously and joins every admitted call, observation and verification. */
  close(): Promise<void>;
}
export interface PromptRuntimePorts {
  readonly callModel: PromptModelCaller;
  readonly recordVerification: (
    ownerId: string,
    snapshot: ChatRuntimeSnapshot,
    evidence: string,
  ) => Promise<void>;
}

function preflight(
  request: PromptExecution,
  minOutputTokens?: number,
): 'cancelled' | PromptFailure | undefined {
  if (request.signal.aborted) return 'cancelled';
  if (minOutputTokens !== undefined && minOutputTokens > snapshotMaxTokens(request.snapshot))
    return 'MODEL_MAX_TOKENS_INSUFFICIENT';
  if (
    request.reasoningEffort !== undefined &&
    !supportsChatReasoning(request.snapshot.reasoning, request.reasoningEffort)
  )
    return 'MODEL_REASONING_UNSUPPORTED';
  return undefined;
}

/** Process-local protection only. Durable business queues and frozen BYOK admission belong upstream. */
export function createPromptRuntime(ports: PromptRuntimePorts): PromptRuntime {
  let closed = false;
  let active = 0;
  let closing: Promise<void> | undefined;
  let drained: (() => void) | undefined;
  function admit<T>(execute: () => Promise<PromptResult<T>>): Promise<PromptResult<T>> {
    if (closed || active >= 16)
      throw new HttpError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'PROMPT_RUNTIME_UNAVAILABLE');
    active++;
    return execute().finally(() => {
      active--;
      if (active === 0) drained?.();
    });
  }
  const attempt = (
    request: PromptExecution,
    input: PromptInput,
    purpose: 'structured' | 'structured-repair' | 'prompt-text',
    observations: ModelObservation[],
    maxOutputTokens?: number,
  ) =>
    ports.callModel({
      ownerId: request.ownerId,
      snapshot: request.snapshot,
      signal: request.signal,
      input,
      purpose,
      ...(request.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: request.reasoningEffort }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      async observe(observation) {
        observations.push(observation);
        await request.observe(observation);
        if (
          observation.status === HTTP_STATUS.OK &&
          (observation.finish === 'stop' || observation.finish === 'max-tokens')
        ) {
          // Verification has the same best-effort semantics as conversations; the durable observation remains authoritative.
          await ports
            .recordVerification(request.ownerId, request.snapshot, request.evidence)
            .catch(() => log.error('PROVIDER_VERIFICATION_UNAVAILABLE'));
        }
      },
    });
  return {
    executeStructuredPrompt(request) {
      return admit(async () => {
        const observations: ModelObservation[] = [];
        const blocked = preflight(request, request.spec.minOutputTokens);
        if (blocked)
          return blocked === 'cancelled'
            ? { status: 'cancelled', observations }
            : { status: 'failed', error: blocked, observations };
        assertTemplateVersion(request.spec.templateVersion);
        const input = request.spec.buildInput(request.input);
        const first = await attempt(request, input, 'structured', observations);
        if (first.status !== 'succeeded') return { ...first, observations };
        if (first.observation.finish === 'max-tokens')
          return { status: 'failed', error: 'MODEL_OUTPUT_TRUNCATED', observations };
        const parsed = request.spec.parseAndValidate(first.text, request.input);
        if (parsed.ok) return { status: 'succeeded', value: parsed.value, observations };
        if (!request.spec.repair)
          return {
            status: 'failed',
            error: 'MODEL_OUTPUT_INVALID',
            issues: parsed.issues,
            observations,
          };
        if (request.signal.aborted) return { status: 'cancelled', observations };
        const repair = request.spec.repair(request.input, first.text, parsed.issues);
        const second = await attempt(
          request,
          { ...input, prompt: repair.prompt },
          'structured-repair',
          observations,
          repair.maxOutputTokens,
        );
        if (second.status !== 'succeeded') return { ...second, observations };
        if (second.observation.finish === 'max-tokens')
          return { status: 'failed', error: 'MODEL_OUTPUT_TRUNCATED', observations };
        const repaired = repair.parse(second.text);
        return repaired.ok
          ? { status: 'succeeded', value: repaired.value, observations }
          : {
              status: 'failed',
              error: 'MODEL_OUTPUT_INVALID',
              issues: repaired.issues,
              observations,
            };
      });
    },
    executeTextPrompt(request) {
      return admit(async () => {
        const observations: ModelObservation[] = [];
        const blocked = preflight(request);
        if (blocked)
          return blocked === 'cancelled'
            ? { status: 'cancelled', observations }
            : { status: 'failed', error: blocked, observations };
        const result = await attempt(request, request.input, 'prompt-text', observations);
        if (result.status !== 'succeeded') return { ...result, observations };
        return result.observation.finish === 'max-tokens'
          ? { status: 'failed', error: 'MODEL_OUTPUT_TRUNCATED', observations }
          : { status: 'succeeded', value: result.text, observations };
      });
    },
    close() {
      closed = true;
      return (closing ??=
        active === 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              drained = resolve;
            }));
    },
  };
}
