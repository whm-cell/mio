import { HTTP_STATUS } from '@mio/foundation/http-status';
import type { Context } from '@deepseek-ai/cordis';
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import type { CredentialStore, SimpleStreamOptions, Model, Api } from '@earendil-works/pi-ai';
import type {
  ConversationRun,
  ConversationVision,
  ModelObservation,
} from '../conversations/contracts.ts';
import type { ChatProfile, ChatSelection, ChatRuntimeSnapshot } from '../providers/contracts.ts';
import {
  DEFAULT_CHAT_IMAGE_BUDGET,
  DEFAULT_CHAT_STREAM_IDLE_TIMEOUT_MS,
  supportsChatReasoning,
  ProviderError,
  snapshotMaxTokens as providerSnapshotMaxTokens,
} from '../providers/contracts.ts';
import { ONELINK_ORIGIN } from '../integrations/onelink/models.ts';
import { chatTransport, isChatContextOverflow } from '../integrations/onelink/chat.ts';
import type { ChatResponseFacts } from '../integrations/onelink/chat.ts';
import { prepareVisionRequest, visionAttachmentStore } from './vision-request.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface LlmRequestPurposeMap {
    compaction: true;
  }
}

const retryPolicy = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'Mio OneLink');
const noCredentials: CredentialStore = {
  read: async () => undefined,
  list: async () => [],
  modify: async () => {
    throw new Error('ONELINK_NATIVE_AUTH_DENIED');
  },
  delete: async () => {
    throw new Error('ONELINK_NATIVE_AUTH_DENIED');
  },
};
// Protocol implementations, not a model list. A new profile must supply every wire choice.
const chatProfiles = {
  'openai-chat': {
    provider: 'onelink-openai',
    api: openAICompletionsApi,
    apiId: 'openai-completions',
    path: '/v1/chat/completions',
    defaultCacheRetention: 'none',
    // OneLink's Chat Completions endpoint manages prefix caching on the server.
    compat: {
      maxTokensField: 'max_tokens',
      supportsStore: false,
      supportsLongCacheRetention: false,
      sendSessionAffinityHeaders: false,
    },
  },
  'anthropic-messages': {
    provider: 'onelink-anthropic',
    api: anthropicMessagesApi,
    apiId: 'anthropic-messages',
    path: '/v1/messages',
    defaultCacheRetention: 'short',
    // Disable SDK strict-tool downgrade/repost; Mio owns every visible attempt.
    compat: { supportsStrictTools: false },
  },
} as const satisfies Record<ChatProfile, unknown>;

function protocolProfile(profile: ChatProfile) {
  if (!Object.hasOwn(chatProfiles, profile))
    throw new LlmError('OneLink profile is not implemented', 'MODEL_PROFILE_UNSUPPORTED');
  return chatProfiles[profile];
}
export const onelinkRoute = (selection: ChatSelection) =>
  protocolProfile(selection.protocol).provider;

export function snapshotMaxTokens(snapshot: ChatRuntimeSnapshot): number {
  try {
    return providerSnapshotMaxTokens(snapshot);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    throw new LlmError(error.message, error.code);
  }
}

function resolveChatEndpoint(snapshot: ChatRuntimeSnapshot) {
  const protocol = protocolProfile(snapshot.protocol);
  const submitPath = snapshot.submitPath ?? protocol.path;
  if (
    !/^\/[A-Za-z0-9._/-]+$/.test(submitPath) ||
    submitPath.includes('..') ||
    submitPath.includes('//')
  )
    throw new LlmError('OneLink submitPath is invalid', 'BINDING_REQUIRED');
  if (snapshot.protocol === 'openai-chat') {
    if (!submitPath.startsWith('/v1/') || !submitPath.endsWith('/chat/completions'))
      throw new LlmError('OneLink submitPath is invalid', 'BINDING_REQUIRED');
    const prefix = submitPath.slice(0, -'/chat/completions'.length);
    if (!prefix.startsWith('/v1'))
      throw new LlmError('OneLink submitPath is invalid', 'BINDING_REQUIRED');
    return { protocol, submitPath, baseUrl: `${ONELINK_ORIGIN}${prefix}` };
  }
  if (submitPath !== '/v1/messages')
    throw new LlmError('OneLink submitPath is invalid', 'BINDING_REQUIRED');
  return { protocol, submitPath, baseUrl: ONELINK_ORIGIN };
}

export function chatFailureCode(
  aborted: boolean,
  facts: ChatResponseFacts,
  failure: { code: string; message?: string },
): string {
  if (aborted) return 'ABORTED';
  const { status, contextOverflow } = facts;
  switch (status) {
    case HTTP_STATUS.UNAUTHORIZED:
    case HTTP_STATUS.FORBIDDEN:
      return 'AUTH';
    case 402:
      return 'QUOTA_EXCEEDED';
    case HTTP_STATUS.TOO_MANY_REQUESTS:
      return 'RATE_LIMIT';
    case HTTP_STATUS.REQUEST_TIMEOUT:
    case 504:
      return 'TIMEOUT';
  }
  if (status !== undefined && status >= 500) return 'SERVER';
  if (status !== undefined && status >= HTTP_STATUS.BAD_REQUEST)
    return contextOverflow ? 'CONTEXT_OVERFLOW' : 'INVALID_REQUEST';
  if (status === HTTP_STATUS.OK && failure.message && isChatContextOverflow(failure.message))
    return 'CONTEXT_OVERFLOW';
  // The SDK also infers overflow from payload size and usage heuristics.
  if (failure.code === CONTEXT_WINDOW_EXCEEDED_CODE) return 'PI_AI_ERROR';
  if (failure.code === 'STREAM_CLOSED') return 'TRANSPORT';
  return failure.code;
}

function metadata(
  provider: string,
  model: string,
  snapshot: ChatRuntimeSnapshot,
): LlmResolvedModelInfo {
  const efforts = snapshot.reasoning?.supported ? snapshot.reasoning.efforts : undefined;
  return {
    provider,
    id: model,
    name: model,
    inputModalities: [...(snapshot.inputModalities ?? ['text'])],
    defaultMaxTokens: snapshotMaxTokens(snapshot),
    ...(snapshot.contextWindow ? { context: { contextWindow: snapshot.contextWindow } } : {}),
    ...(efforts?.length
      ? { reasoning: { efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: id })) } }
      : {}),
  };
}

export type OneLinkResponseFacts = ChatResponseFacts & { reasoningTokens?: number };

/** Both fixed codecs expose the parsed event before usage normalization erases field presence. */
function providerReasoningTokens(profile: ChatProfile, event: unknown): number | undefined {
  type Usage = {
    completion_tokens_details?: { reasoning_tokens?: unknown };
    output_tokens_details?: { thinking_tokens?: unknown };
  };
  const data = event as {
    type?: string;
    usage?: Usage;
    message?: { usage?: Usage };
    choices?: { usage?: Usage }[];
  } | null;
  const tokens =
    profile === 'openai-chat'
      ? (data?.usage ?? data?.choices?.[0]?.usage)?.completion_tokens_details?.reasoning_tokens
      : (data?.type === 'message_delta'
          ? data.usage
          : data?.type === 'message_start'
            ? data.message?.usage
            : undefined
        )?.output_tokens_details?.thinking_tokens;
  return typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0
    ? tokens
    : undefined;
}

function wireModel(
  model: Model<Api>,
  effort: SimpleStreamOptions['reasoning'],
  vendor: ChatRuntimeSnapshot['vendor'],
): Model<Api> {
  if (!model.reasoning) return model;
  // Preserve the old wire defaults for turns without a selection and for summaries.
  if (effort === undefined) return { ...model, reasoning: false };
  if (model.api === 'anthropic-messages')
    return { ...model, compat: { ...model.compat, forceAdaptiveThinking: true } };
  if (vendor === 'deepseek')
    return {
      ...model,
      compat: {
        ...model.compat,
        thinkingFormat: 'deepseek',
        requiresReasoningContentOnAssistantMessages: true,
      },
    };
  return model;
}

/** One immutable request's SDK provider; only the public protocol factories perform encoding. */
export function requestAdapter(
  snapshot: ChatRuntimeSnapshot,
  facts: OneLinkResponseFacts,
  execution: { started: boolean },
  resolveAttachments?: () => ReturnType<typeof visionAttachmentStore>,
): PiAiAdapter {
  const { protocol, submitPath, baseUrl } = resolveChatEndpoint(snapshot);
  const maxTokens = snapshotMaxTokens(snapshot);
  const provider = protocol.provider;
  const api = protocol.api();
  const transport = chatTransport(snapshot.apiKey, submitPath, facts, (input, init) => {
    execution.started = true;
    return fetch(input, init);
  });
  const requestOptions = (options: SimpleStreamOptions | undefined): SimpleStreamOptions => {
    const rest = { ...options };
    delete rest.apiKey;
    return {
      ...rest,
      fetch: transport,
      maxRetries: 0,
      onProviderStreamEvent(event) {
        const count = providerReasoningTokens(snapshot.protocol, event);
        if (count !== undefined) facts.reasoningTokens = count;
      },
      headers: {
        ...rest.headers,
        authorization: `Bearer ${snapshot.apiKey}`,
        'x-api-key': null,
      },
    };
  };
  const model: Model<Api> = {
    id: snapshot.modelId,
    name: snapshot.modelId,
    provider,
    api: protocol.apiId,
    baseUrl,
    input: [...(snapshot.inputModalities ?? ['text'])],
    reasoning: snapshot.reasoning?.supported === true,
    // SDK 1.5.0 treats zero as unknown. Never expose this as supplier metadata.
    contextWindow: snapshot.contextWindow ?? 0,
    maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: protocol.compat,
  };
  const piProvider = createProvider({
    id: provider,
    auth: {
      apiKey: {
        name: 'Mio request BYOK',
        resolve: async ({ credential }) => {
          if (!credential?.key) throw new Error('ONELINK_BINDING_REQUIRED');
          return { auth: { apiKey: credential.key } };
        },
      },
    },
    models: [model],
    api: {
      stream: (selected, context, options) =>
        api.stream(selected, context, requestOptions(options)),
      streamSimple: (selected, context, options) =>
        api.streamSimple(
          wireModel(selected, options?.reasoning, snapshot.vendor),
          context,
          requestOptions(options),
        ),
    },
  });
  const budget = snapshot.imageBudget ?? DEFAULT_CHAT_IMAGE_BUDGET;
  const streamIdleTimeoutMs =
    (snapshot.reasoning?.supported ? snapshot.streamIdleTimeoutMs : undefined) ??
    DEFAULT_CHAT_STREAM_IDLE_TIMEOUT_MS;
  const profile: ResolvedPiAiProviderProfile = {
    provider,
    displayName: 'OneLinkAI',
    piProvider,
    modelErrors: new Map(),
    configuredMaxTokens: new Map([[snapshot.modelId, maxTokens]]),
    retryPolicy,
    streamIdleTimeoutMs,
    timeoutMs: streamIdleTimeoutMs,
    transport: 'sse',
    cacheRetention: snapshot.cacheRetention ?? protocol.defaultCacheRetention,
    maxRequestImageBytes: budget.maxRequestImageBytes,
    maxRequestImages: budget.maxRequestImages,
    imageOffloadCountQuantum: 1,
    requestImagePixelBudget: budget.requestImagePixelBudget,
    requestImageMaxBytes: budget.requestImageMaxBytes,
  };
  const profiles = new Map([[provider, profile]]);
  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => snapshot.apiKey,
    auth: {
      credentials: noCredentials,
      authContext: { env: async () => undefined, fileExists: async () => false },
    },
    ...(resolveAttachments ? { resolveAttachments } : {}),
  });
}

export function modelObservation(
  facts: OneLinkResponseFacts,
  usage: ModelObservation['usage'],
  finish: string,
  failureCode?: string,
  purpose?: ModelObservation['purpose'],
): ModelObservation {
  const { status, providerRequestId, reasoningTokens } = facts;
  const base = {
    ...(status !== undefined ? { status } : {}),
    ...(providerRequestId !== undefined ? { providerRequestId } : {}),
    finish,
    ...(purpose ? { purpose } : {}),
    ...(failureCode ? { failureCode } : {}),
  };
  // DSH can report cached input with both uncached input and output at zero.
  const observedUsage = reasoningTokens === undefined ? usage : { ...usage, reasoningTokens };
  if (
    !observedUsage ||
    (reasoningTokens === undefined && !Object.values(observedUsage).some((count) => count > 0))
  )
    return { ...base, usageStatus: 'unknown' };
  return {
    ...base,
    usage: observedUsage,
    usageStatus:
      usage && (finish === 'stop' || finish === 'max-tokens' || finish === 'tool-calls')
        ? 'reported'
        : 'partial',
  };
}

export const OBSERVATION_UNAVAILABLE = 'OBSERVATION_UNAVAILABLE';

/** Stable registration, request-owned snapshots. A Session id by itself grants no billing authority. */
export class OneLinkAdapter extends LlmAdapter {
  private readonly vision: ConversationVision | undefined;
  constructor(vision?: ConversationVision) {
    super();
    this.vision = vision;
  }
  private readonly bindings = new WeakMap<AbortSignal, ConversationRun>();
  private readonly compactionGrants = new WeakMap<
    AbortSignal,
    { run: ConversationRun; used: boolean }
  >();

  async withCompaction<T>(
    signal: AbortSignal,
    run: ConversationRun,
    dispatch: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if (
      this.bindings.get(signal) !== run ||
      run.snapshot.contextWindow === undefined ||
      this.compactionGrants.has(signal)
    )
      throw new LlmError('OneLink summary has no trusted binding', 'BINDING_REQUIRED');
    this.compactionGrants.set(signal, { run, used: false });
    try {
      return await dispatch();
    } finally {
      this.compactionGrants.delete(signal);
    }
  }

  bind(signal: AbortSignal, run: ConversationRun): () => void {
    const old = this.bindings.get(signal);
    if (old && old !== run) throw new LlmError('OneLink binding conflict', 'BINDING_CONFLICT');
    this.bindings.set(signal, run);
    return () => {
      if (this.bindings.get(signal) === run) this.bindings.delete(signal);
    };
  }
  override providerRetryPolicy() {
    return retryPolicy;
  }
  override async listModels() {
    return [];
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return metadata(provider, model, this.bound(provider, model, signal).snapshot);
  }
  private bound(provider: string, model: string, signal?: AbortSignal): ConversationRun {
    const run = signal && this.bindings.get(signal);
    if (
      !run ||
      signal.aborted ||
      provider !== onelinkRoute(run.snapshot) ||
      model !== run.snapshot.modelId
    )
      throw new LlmError('OneLink request has no trusted binding', 'BINDING_REQUIRED');
    return run;
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const run = this.bound(provider, model, signal);
    const facts: OneLinkResponseFacts = {};
    const expected = new Map();
    const execution = { started: false };
    const inner = await requestAdapter(
      run.snapshot,
      facts,
      execution,
      this.vision ? () => visionAttachmentStore(this.vision!, run.userId, expected) : undefined,
    ).prepareCall(provider, model, signal);
    return {
      model: metadata(provider, model, run.snapshot),
      stream: (options: GenerateOptions) =>
        this.dispatch(options, signal!, run, facts, inner.stream, expected, execution),
    };
  }
  async *stream(): AsyncIterable<StreamChunk> {
    throw new LlmError('OneLink requires a prepared trusted call', 'BINDING_REQUIRED');
  }
  private async *dispatch(
    options: GenerateOptions,
    signal: AbortSignal,
    run: ConversationRun,
    facts: OneLinkResponseFacts,
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
    expected: Parameters<typeof visionAttachmentStore>[2] extends ReadonlyMap<infer K, infer V>
      ? Map<K, V>
      : never,
    execution: { started: boolean },
  ): AsyncIterable<StreamChunk> {
    const maxTokens = snapshotMaxTokens(run.snapshot);
    const grant = options.purpose === 'compaction' ? this.compactionGrants.get(signal) : undefined;
    const effort = grant ? undefined : run.reasoningEffort;
    if (
      this.bindings.get(signal) !== run ||
      options.signal !== signal ||
      signal.aborted ||
      options.sessionId !== run.dshSessionId ||
      options.reasoningEffort !== effort ||
      (effort !== undefined && !supportsChatReasoning(run.snapshot.reasoning, effort)) ||
      (options.purpose !== undefined &&
        (!grant ||
          grant.run !== run ||
          grant.used ||
          options.toolHistory !== undefined ||
          Boolean(options.tools?.length) ||
          options.messages.some(
            (message) =>
              (message.role !== 'system' && message.role !== 'user') ||
              message.content.some((block) => block.type !== 'text'),
          ))) ||
      options.provider !== onelinkRoute(run.snapshot) ||
      options.model !== run.snapshot.modelId ||
      !options.maxTokens ||
      options.maxTokens > maxTokens ||
      options.stop !== undefined ||
      options.messages.some((message) => message.content.some((block) => block.type === 'file')) ||
      (options.messages.some((message) =>
        message.content.some((block) => block.type === 'image'),
      ) &&
        (!run.snapshot.inputModalities?.includes('image') || !this.vision))
    )
      throw new LlmError('OneLink request does not match its binding', 'BINDING_REQUIRED');
    if (grant) grant.used = true;
    let usage: ModelObservation['usage'];
    let failureCode: string | undefined;
    let observed = false;
    let release: (() => void) | undefined;
    execution.started = false;
    const persistObservation = async (finish: string) => {
      try {
        await run.observe(
          modelObservation(facts, usage, finish, failureCode, grant ? 'compaction' : undefined),
        );
      } catch {
        throw new LlmError('OneLink observation unavailable', OBSERVATION_UNAVAILABLE);
      }
    };
    try {
      const containsImages = options.messages.some((message) =>
        message.content.some((block) => block.type === 'image'),
      );
      if (containsImages) release = await this.vision!.acquireRequest(signal);
      const projected = containsImages
        ? await prepareVisionRequest(
            options,
            run,
            this.vision!,
            run.snapshot.imageBudget ?? DEFAULT_CHAT_IMAGE_BUDGET,
            expected,
          )
        : options;
      for await (const chunk of stream(projected)) {
        if (chunk.type === 'usage') usage = chunk.usage;
        if (chunk.type === 'finish') {
          let safe = chunk;
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            failureCode = chatFailureCode(signal.aborted, facts, chunk.reason.failure);
            safe = {
              type: 'finish',
              reason: {
                kind: signal.aborted ? 'aborted' : 'error',
                failure: {
                  code: failureCode,
                  message: 'OneLink model request did not complete',
                  ...(facts.providerRequestId
                    ? { requestId: facts.providerRequestId as never }
                    : {}),
                  ...(facts.status ? { status: facts.status } : {}),
                },
              },
            };
          }
          if (execution.started) {
            observed = true;
            await persistObservation(safe.reason.kind);
          }
          yield safe;
        } else yield chunk;
      }
    } catch (error) {
      if (error instanceof LlmError && error.code === OBSERVATION_UNAVAILABLE) throw error;
      if (error instanceof LlmError && error.code === IMAGE_OFFLOAD_REQUIRED_CODE) {
        failureCode = IMAGE_OFFLOAD_REQUIRED_CODE;
        throw error;
      }
      failureCode = chatFailureCode(
        signal.aborted,
        facts,
        error instanceof LlmError ? error : { code: 'ONELINK_FAILED' },
      );
      throw new LlmError('OneLink model request failed', failureCode);
    } finally {
      release?.();
      // The loop may stop consuming immediately after abort; it need not request a terminal chunk.
      if (!observed && execution.started) {
        failureCode ??= signal.aborted ? 'ABORTED' : 'ONELINK_UNKNOWN';
        await persistObservation(signal.aborted ? 'aborted' : 'unknown');
      }
    }
  }
}

export function registerOneLink(ctx: Context, vision?: ConversationVision): OneLinkAdapter {
  const adapter = new OneLinkAdapter(vision);
  ctx.llm.registerAdapter(
    Object.values(chatProfiles).map((profile) => profile.provider),
    adapter,
  );
  return adapter;
}
