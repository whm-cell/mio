import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import type { CredentialStore, SimpleStreamOptions, Model, Api } from '@earendil-works/pi-ai';
import type { ConversationRun, ModelObservation } from '../conversations/contracts.ts';
import type { ChatProfile, ChatSelection, ChatRuntimeSnapshot } from '../providers/contracts.ts';
import { ONELINK_ORIGIN } from '../integrations/onelink/models.ts';
import { chatTransport } from '../integrations/onelink/chat.ts';
import type { ChatResponseFacts } from '../integrations/onelink/chat.ts';

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
    baseUrl: `${ONELINK_ORIGIN}/v1`,
    compat: { maxTokensField: 'max_tokens', supportsStore: false },
  },
  'anthropic-messages': {
    provider: 'onelink-anthropic',
    api: anthropicMessagesApi,
    apiId: 'anthropic-messages',
    path: '/v1/messages',
    baseUrl: ONELINK_ORIGIN,
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

function metadata(
  provider: string,
  model: string,
  snapshot: ChatRuntimeSnapshot,
): LlmResolvedModelInfo {
  return {
    provider,
    id: model,
    name: model,
    inputModalities: ['text'],
    defaultMaxTokens: 1024,
    ...(snapshot.contextWindow ? { context: { contextWindow: snapshot.contextWindow } } : {}),
  };
}

/** One immutable request's SDK provider; only the public protocol factories perform encoding. */
function requestAdapter(run: ConversationRun, facts: ChatResponseFacts): PiAiAdapter {
  const protocol = protocolProfile(run.snapshot.protocol);
  const provider = protocol.provider;
  const api = protocol.api();
  const transport = chatTransport(run.snapshot.apiKey, protocol.path, facts);
  const requestOptions = (options: SimpleStreamOptions | undefined): SimpleStreamOptions => {
    const rest = { ...options };
    delete rest.apiKey;
    return {
      ...rest,
      fetch: transport,
      maxRetries: 0,
      headers: {
        ...rest.headers,
        authorization: `Bearer ${run.snapshot.apiKey}`,
        'x-api-key': null,
      },
    };
  };
  const model: Model<Api> = {
    id: run.snapshot.modelId,
    name: run.snapshot.modelId,
    provider,
    api: protocol.apiId,
    baseUrl: protocol.baseUrl,
    input: ['text'],
    reasoning: false,
    // SDK 1.5.0 treats zero as unknown. Never expose this as supplier metadata.
    contextWindow: run.snapshot.contextWindow ?? 0,
    maxTokens: 1024,
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
        api.streamSimple(selected, context, requestOptions(options)),
    },
  });
  const profile: ResolvedPiAiProviderProfile = {
    provider,
    displayName: 'OneLinkAI',
    piProvider,
    modelErrors: new Map(),
    configuredMaxTokens: new Map([[run.snapshot.modelId, 1024]]),
    retryPolicy,
    streamIdleTimeoutMs: 30_000,
    timeoutMs: 30_000,
    transport: 'sse',
    cacheRetention: 'none',
    maxRequestImageBytes: 1,
    maxRequestImages: 1,
    imageOffloadCountQuantum: 1,
    requestImagePixelBudget: 1,
    requestImageMaxBytes: 1,
  };
  const profiles = new Map([[provider, profile]]);
  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => run.snapshot.apiKey,
    auth: {
      credentials: noCredentials,
      authContext: { env: async () => undefined, fileExists: async () => false },
    },
  });
}

/** Stable registration, request-owned snapshots. A Session id by itself grants no billing authority. */
export class OneLinkAdapter extends LlmAdapter {
  private readonly bindings = new WeakMap<AbortSignal, ConversationRun>();
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
    const facts: ChatResponseFacts = {};
    const inner = await requestAdapter(run, facts).prepareCall(provider, model, signal);
    return {
      model: metadata(provider, model, run.snapshot),
      stream: (options: GenerateOptions) =>
        this.dispatch(options, signal!, run, facts, inner.stream),
    };
  }
  async *stream(): AsyncIterable<StreamChunk> {
    throw new LlmError('OneLink requires a prepared trusted call', 'BINDING_REQUIRED');
  }
  private async *dispatch(
    options: GenerateOptions,
    signal: AbortSignal,
    run: ConversationRun,
    facts: ChatResponseFacts,
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    if (
      this.bindings.get(signal) !== run ||
      options.signal !== signal ||
      signal.aborted ||
      options.sessionId !== run.dshSessionId ||
      options.purpose !== undefined ||
      options.provider !== onelinkRoute(run.snapshot) ||
      options.model !== run.snapshot.modelId ||
      !options.maxTokens ||
      options.maxTokens > 1024 ||
      options.stop !== undefined ||
      options.messages.some((message) =>
        message.content.some((block) => block.type === 'image' || block.type === 'file'),
      )
    )
      throw new LlmError('OneLink request does not match its binding', 'BINDING_REQUIRED');
    let usage: ModelObservation['usage'];
    let failureCode: string | undefined;
    let observed = false;
    const observation = (finish: string): ModelObservation => {
      if (!usage || (usage.inputTokens === 0 && usage.outputTokens === 0))
        return {
          ...facts,
          finish,
          usageStatus: 'unknown',
          ...(failureCode ? { failureCode } : {}),
        };
      return {
        ...facts,
        usage,
        finish,
        ...(failureCode ? { failureCode } : {}),
        usageStatus:
          finish === 'stop' || finish === 'max-tokens' || finish === 'tool-calls'
            ? 'reported'
            : 'partial',
      };
    };
    try {
      for await (const chunk of stream(options)) {
        if (chunk.type === 'usage') usage = chunk.usage;
        if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            failureCode = signal.aborted
              ? 'ABORTED'
              : facts.status === 401 || facts.status === 403
                ? 'AUTH'
                : facts.status === 402
                  ? 'QUOTA_EXCEEDED'
                  : facts.status === 429
                    ? 'RATE_LIMIT'
                    : facts.status === 408 || facts.status === 504
                      ? 'TIMEOUT'
                      : facts.status && facts.status >= 500
                        ? 'SERVER'
                        : facts.status && facts.status >= 400
                          ? 'INVALID_REQUEST'
                          : chunk.reason.failure.code;
          }
          const safe: StreamChunk =
            chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted'
              ? {
                  type: 'finish',
                  reason: {
                    kind: signal.aborted ? 'aborted' : 'error',
                    failure: {
                      code: failureCode!,
                      message: 'OneLink model request did not complete',
                      ...(facts.providerRequestId
                        ? { requestId: facts.providerRequestId as never }
                        : {}),
                      ...(facts.status ? { status: facts.status } : {}),
                    },
                  },
                }
              : chunk;
          observed = true;
          await run.observe(observation(safe.reason.kind));
          yield safe;
        } else yield chunk;
      }
    } catch (error) {
      failureCode = signal.aborted
        ? 'ABORTED'
        : error instanceof LlmError && error.code === 'TIMEOUT'
          ? 'TIMEOUT'
          : 'ONELINK_FAILED';
      throw new LlmError('OneLink model request failed', failureCode);
    } finally {
      // The loop may stop consuming immediately after abort; it need not request a terminal chunk.
      if (!observed) {
        failureCode ??= signal.aborted ? 'ABORTED' : 'ONELINK_UNKNOWN';
        try {
          await run.observe(observation(signal.aborted ? 'aborted' : 'unknown'));
        } catch {
          throw new LlmError('OneLink observation unavailable', 'OBSERVATION_UNAVAILABLE');
        }
      }
    }
  }
}

export function registerOneLink(ctx: Context): OneLinkAdapter {
  const adapter = new OneLinkAdapter();
  ctx.llm.registerAdapter(
    Object.values(chatProfiles).map((profile) => profile.provider),
    adapter,
  );
  return adapter;
}
