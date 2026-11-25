import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  ConversationEvent,
  ConversationImageTools,
  ConversationRun,
  ModelObservation,
} from '../../src/conversations/contracts.ts';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import { OneLinkAdapter, onelinkRoute } from '../../src/dsh/onelink.ts';
import type { ChatReasoningEffort, ChatRuntimeSnapshot } from '../../src/providers/contracts.ts';
import { kernelRuntime, ScriptedModel } from '../support/kernel-runtime.ts';
import { protocolResponse } from './fixture.ts';

const sessionId = 'm5-reasoning-fixture';
const replaySignature = 'fixture-native-thinking-signature';
const redactedThinking = 'fixture-redacted-data';

function snapshot(overrides: Partial<ChatRuntimeSnapshot> = {}): ChatRuntimeSnapshot {
  return Object.freeze({
    providerConfigId: 'fixture-provider',
    providerRevision: 1,
    credentialVersion: 1,
    modelKey: 'fixture-model',
    catalogVersion: 1,
    adaptationVersion: 1,
    operation: 'chat',
    profile: 'openai-chat',
    modelRef: 'onelink:chat:fixture-model',
    modelId: 'runtime-route-Q',
    protocol: 'openai-chat',
    capabilityVersion: 'fixture',
    apiKey: 'synthetic-fixture-key',
    reasoning: { supported: true, efforts: ['low', 'high'] },
    ...overrides,
  } satisfies ChatRuntimeSnapshot);
}

function binding(
  requestId: string,
  route: ChatRuntimeSnapshot,
  observations: ModelObservation[],
  reasoningEffort?: ChatReasoningEffort,
): ConversationRun {
  return {
    userId: 'fixture-owner',
    conversationId: 'fixture-conversation',
    dshSessionId: sessionId,
    requestId,
    snapshot: route,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    observe: async (value) => {
      observations.push(value);
    },
  };
}

function response(frames: readonly unknown[], anthropic = false) {
  return new Response(
    frames
      .map((frame) => {
        const event = anthropic ? `event: ${(frame as { type: string }).type}\n` : '';
        return `${event}data: ${frame === '[DONE]' ? frame : JSON.stringify(frame)}\n\n`;
      })
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function chatStep(delta: Record<string, unknown>, finish = 'stop', reasoningTokens?: unknown) {
  return response([
    {
      id: 'fixture-response',
      choices: [{ index: 0, delta, finish_reason: finish }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 7,
        ...(reasoningTokens === undefined
          ? {}
          : { completion_tokens_details: { reasoning_tokens: reasoningTokens } }),
      },
    },
    '[DONE]',
  ]);
}

function anthropicStep(reasoning: string, text: string, reasoningTokens?: unknown) {
  return response(
    [
      {
        type: 'message_start',
        message: {
          id: 'fixture-message',
          model: 'runtime-route-Q',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: reasoning },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: replaySignature },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'redacted_thinking', data: redactedThinking },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 2 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          output_tokens: 7,
          ...(reasoningTokens === undefined
            ? {}
            : { output_tokens_details: { thinking_tokens: reasoningTokens } }),
        },
      },
      { type: 'message_stop' },
    ],
    true,
  );
}

async function engineFixture(imageTools?: ConversationImageTools) {
  const root = await mkdtemp(join(tmpdir(), 'mio-m5-runtime-'));
  const ctx = await kernelRuntime(root, new ScriptedModel([]));
  const engine = createDshConversationEngine(
    ctx,
    { databaseURL: 'unused', byok: true },
    imageTools,
  );
  const observations: ModelObservation[] = [];
  const events: ConversationEvent[] = [];
  return {
    ctx,
    engine,
    observations,
    events,
    run: (id: string, route: ChatRuntimeSnapshot, effort?: ChatReasoningEffort) =>
      engine.run(
        sessionId,
        id,
        `input ${id}`,
        async () => {},
        (event) => events.push(event),
        binding(id, route, observations, effort),
      ),
    async close() {
      await engine.close();
      await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  ['openai-chat', 'openai'],
  ['openai-chat', 'deepseek'],
  ['anthropic-messages', 'anthropic'],
] as const)(
  'uses exact %s/%s reasoning controls per turn and keeps native reasoning out of history',
  async (protocol, vendor) => {
    const fixture = await engineFixture();
    const route = snapshot({ protocol, profile: protocol, vendor });
    const noOptions = snapshot({
      protocol,
      profile: protocol,
      vendor,
      reasoning: { supported: true },
    });
    const ordinary = snapshot({
      protocol,
      profile: protocol,
      vendor,
      reasoning: { supported: false },
    });
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push((await new Request(input, init).json()) as Record<string, unknown>);
      const i = requests.length;
      const tokens = [4, undefined, 0, -1][i - 1];
      return protocol === 'anthropic-messages'
        ? anthropicStep(`thought ${i}`, `reply ${i}`, tokens)
        : chatStep({ reasoning_content: `thought ${i}`, content: `reply ${i}` }, 'stop', tokens);
    });
    try {
      await fixture.engine.create(sessionId, route);
      expect(await fixture.run('one', route, 'high')).toBe('completed');
      expect(await fixture.run('two', noOptions)).toBe('completed');
      expect(await fixture.run('three', route, 'low')).toBe('completed');
      expect(await fixture.run('four', ordinary)).toBe('completed');
      expect(requests).toHaveLength(4);
      for (const [index, effort] of [
        [0, 'high'],
        [2, 'low'],
      ] as const) {
        const request = requests[index];
        expect(request?.max_tokens).toBe(1024);
        if (protocol === 'anthropic-messages') {
          expect(request?.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
          expect(request?.output_config).toEqual({ effort });
        } else {
          expect(request?.reasoning_effort).toBe(effort);
          expect(request?.thinking).toEqual(
            vendor === 'deepseek' ? { type: 'enabled' } : undefined,
          );
        }
      }
      for (const index of [1, 3]) {
        const request = requests[index];
        expect(request?.max_tokens).toBe(1024);
        expect(request).not.toHaveProperty('reasoning_effort');
        expect(request).not.toHaveProperty('thinking');
        expect(request).not.toHaveProperty('output_config');
        expect(JSON.stringify(request?.messages)).not.toContain('"reasoning_content":""');
      }
      expect(fixture.events.map((event) => event.type)).toEqual([
        'reasoning',
        'text',
        'reasoning',
        'text',
        'reasoning',
        'text',
        'text',
      ]);
      expect(
        fixture.events.filter((event) => event.type === 'reasoning').map((event) => event.text),
      ).toEqual(['thought 1', 'thought 2', 'thought 3']);
      expect(fixture.observations.map((value) => value.usage?.reasoningTokens)).toEqual([
        4,
        undefined,
        0,
        undefined,
      ]);
      expect(fixture.observations.map((value) => value.usage?.outputTokens)).toEqual([7, 7, 7, 7]);
      const transcript = JSON.stringify(await fixture.engine.history(sessionId, -1, 100));
      expect(transcript).toContain('reply 1');
      expect(transcript).toContain('reply 4');
      expect(transcript).not.toContain('thought');
      const native = JSON.stringify(await fixture.ctx.mioKernel.history(sessionId));
      expect(native).toContain('thought 4');
      if (protocol === 'anthropic-messages') {
        expect(native).toContain(replaySignature);
        expect(native).toContain(redactedThinking);
        expect(JSON.stringify(fixture.events)).not.toMatch(
          /fixture-(native|redacted)|Reasoning redacted/,
        );
      }
    } finally {
      await fixture.close();
    }
  },
);

function llmOptions(run: ConversationRun, signal: AbortSignal): GenerateOptions {
  return {
    provider: onelinkRoute(run.snapshot),
    model: run.snapshot.modelId,
    maxTokens: 1024,
    sessionId: SessionId(sessionId),
    signal,
    messages: [
      createUserMessage({ content: [{ type: 'text', text: 'input' }], source: { kind: 'user' } }),
    ],
  };
}

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

it.each([0, 4])(
  'retains an observed reasoning count of %i when the consumer leaves before terminal usage',
  async (count) => {
    const adapter = new OneLinkAdapter();
    const observations: ModelObservation[] = [];
    const run = binding('early-return', snapshot(), observations, 'high');
    const signal = new AbortController().signal;
    const release = adapter.bind(signal, run);
    const options = llmOptions(run, signal);
    vi.stubGlobal('fetch', async () => chatStep({ content: 'first delta' }, 'stop', count));
    try {
      const prepared = await adapter.prepareCall(options.provider, options.model, signal);
      for await (const chunk of prepared.stream({
        ...options,
        reasoningEffort: ReasoningEffortId('high'),
      })) {
        if (chunk.type === 'text-delta') break;
      }
      expect(observations).toEqual([
        {
          status: 200,
          finish: 'unknown',
          failureCode: 'ONELINK_UNKNOWN',
          usageStatus: 'partial',
          usage: { reasoningTokens: count },
        },
      ]);
    } finally {
      release();
    }
  },
);

it('keeps reasoning within the trusted request and auxiliary one-shot context', async () => {
  const adapter = new OneLinkAdapter();
  const observations: ModelObservation[] = [];
  const run = binding('reasoning', snapshot({ contextWindow: 8192 }), observations, 'high');
  const signal = new AbortController().signal;
  const release = adapter.bind(signal, run);
  const options = llmOptions(run, signal);
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push((await request.json()) as Record<string, unknown>);
    return chatStep({ content: 'result' }, 'stop', 0);
  });
  const prepare = () => adapter.prepareCall(options.provider, options.model, signal);
  const picked = { ...options, reasoningEffort: ReasoningEffortId('high') };
  try {
    const prepared = await prepare();
    expect(prepared.model.reasoning?.efforts.map((item) => item.id)).toEqual(['low', 'high']);
    await expect(collect(prepared.stream(options))).rejects.toThrow('binding');
    await expect(
      collect(prepared.stream({ ...picked, reasoningEffort: ReasoningEffortId('medium') })),
    ).rejects.toThrow('binding');
    expect(requests).toHaveLength(0);
    await adapter.withCompaction(signal, run, async () => {
      const summary = await prepare();
      await expect(collect(summary.stream({ ...picked, purpose: 'compaction' }))).rejects.toThrow(
        'binding',
      );
      await collect(summary.stream({ ...options, purpose: 'compaction' }));
      await expect(collect(summary.stream({ ...options, purpose: 'compaction' }))).rejects.toThrow(
        'binding',
      );
    });
    await collect(prepared.stream(picked));
    release();
    await expect(collect(prepared.stream(picked))).rejects.toThrow('binding');
    expect(requests.map((body) => body.reasoning_effort)).toEqual([undefined, 'high']);
    expect(observations.map((value) => [value.purpose, value.usage?.reasoningTokens])).toEqual([
      ['compaction', 0],
      [undefined, 0],
    ]);
  } finally {
    release();
  }
});

it('pairs simultaneous admitted tools with the native ordered results and keeps denied calls private', async () => {
  const firstId = '3125b33f-47f8-4b12-9424-b7b8795ace26';
  const secondId = 'd72fcc27-58e2-4c86-a6bc-be4d8518be06';
  const job = {
    jobId: firstId,
    status: 'completed',
    requestedCount: 1,
    errorCode: null,
    outputs: [],
    assetIds: [],
  };
  const first = Promise.withResolvers<typeof job>();
  const second = Promise.withResolvers<typeof job>();
  const secondBodyEnded = Promise.withResolvers<void>();
  const getImage = vi.fn<ConversationImageTools['getImage']>((_actor, id) =>
    id === firstId ? first.promise : second.promise.finally(secondBodyEnded.resolve),
  );
  const fixture = await engineFixture({
    getImage,
    createImage: vi.fn(),
    listModels: vi.fn(),
  });
  const route = snapshot({ vendor: 'deepseek' });
  const requests: Record<string, unknown>[] = [];
  const calls = [
    { name: 'get_image_job', arguments: { jobId: firstId } },
    { name: 'get_image_job', arguments: { jobId: secondId } },
    { name: 'inspect_image_asset', arguments: { assetId: 'not-authorized-in-this-profile' } },
  ];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push((await request.clone().json()) as Record<string, unknown>);
    return requests.length === 1
      ? chatStep(
          {
            reasoning_content: 'thinking before tools',
            tool_calls: calls.map((call, index) => ({
              index,
              id: `call_fixture_${index}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          },
          'tool_calls',
          3,
        )
      : protocolResponse(request, 'reply after tools');
  });
  const status = (value: 'running' | 'failed' | 'completed') => ({
    type: 'tool-status',
    requestId: 'tools',
    tool: 'get_image_job',
    status: value,
  });
  const progress = () => fixture.events.filter((event) => event.type === 'tool-status');
  try {
    await fixture.engine.create(sessionId, route);
    const work = fixture.run('tools', route, 'high');
    await vi.waitFor(() => expect(getImage).toHaveBeenCalledTimes(2));
    expect(fixture.events).toEqual([
      { type: 'reasoning', requestId: 'tools', text: 'thinking before tools' },
      status('running'),
      status('running'),
    ]);
    second.reject(new Error('private supplier tool error'));
    await secondBodyEnded.promise;
    expect(progress()).toEqual([status('running'), status('running')]);
    first.resolve(job);
    expect(await work).toBe('completed');
    expect(progress()).toEqual([
      status('running'),
      status('running'),
      status('completed'),
      status('failed'),
    ]);
    expect(requests.map((request) => request.reasoning_effort)).toEqual(['high', 'high']);
    expect(requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', reasoning_content: 'thinking before tools' }),
      ]),
    );
    expect(fixture.events.at(-1)).toEqual({
      type: 'text',
      requestId: 'tools',
      text: 'reply after tools',
    });
  } finally {
    first.resolve(job);
    second.resolve(job);
    await fixture.close();
  }
});

it.each([
  ['headers', false, 30_000],
  ['headers', true, 90_000],
  ['idle stream', true, 90_000],
] as const)(
  'uses the frozen reasoning timeout for %s (declared=%s)',
  async (phase, declared, timeout) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const observations: ModelObservation[] = [];
    const route = snapshot(
      declared ? { streamIdleTimeoutMs: timeout } : { reasoning: { supported: false } },
    );
    const run = binding('timeout', route, observations);
    const signal = new AbortController().signal;
    const adapter = new OneLinkAdapter();
    const release = adapter.bind(signal, run);
    const options = llmOptions(run, signal);
    const outbound = Promise.withResolvers<Request>();
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      outbound.resolve(request);
      if (phase === 'idle stream')
        return Promise.resolve(protocolResponse(request, 'body before idle', true));
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), {
          once: true,
        });
      });
    });
    try {
      const prepared = await adapter.prepareCall(options.provider, options.model, signal);
      const result = collect(prepared.stream(options)).catch((error: Error) => error);
      const request = await outbound.promise;
      await vi.advanceTimersByTimeAsync(timeout - 1);
      expect(request.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(request.signal.aborted).toBe(true);
      await result;
      expect(observations).toMatchObject([{ failureCode: 'TIMEOUT' }]);
    } finally {
      release();
    }
  },
);
