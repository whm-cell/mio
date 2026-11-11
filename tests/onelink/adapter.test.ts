import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  BlockAssembler,
  createUserMessage,
  createToolResultMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { OneLinkAdapter } from '../../src/dsh/onelink.ts';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import type { ConversationRun, ModelObservation } from '../../src/conversations/contracts.ts';
import type { ChatProfile } from '../../src/providers/contracts.ts';
import { kernelRuntime, ScriptedModel } from '../kernel-runtime.ts';
import { protocolResponse, protocolToolResponse } from './fixture.ts';

afterEach(() => vi.unstubAllGlobals());
async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
const snapshot = (anthropic = false, apiKey = 'synthetic-owner-key') =>
  Object.freeze({
    providerConfigId: 'config-one',
    providerRevision: 1,
    credentialVersion: 1,
    modelKey: 'request-local-model-key',
    catalogVersion: 7,
    adaptationVersion: 3,
    operation: 'chat' as const,
    profile: anthropic ? ('anthropic-messages' as const) : ('openai-chat' as const),
    modelRef: anthropic
      ? 'onelink:chat:future-messages:route-K'
      : 'onelink:chat:future-text:route-Q',
    modelId: anthropic ? 'future-messages:route-K' : 'future-text:route-Q',
    protocol: anthropic ? ('anthropic-messages' as const) : ('openai-chat' as const),
    capabilityVersion: 'onelink-text-v1',
    apiKey,
  });
function binding(
  session: string,
  observations: ModelObservation[],
  anthropic = false,
): ConversationRun {
  return {
    userId: 'owner',
    conversationId: 'conversation',
    dshSessionId: session,
    requestId: 'request',
    snapshot: snapshot(anthropic),
    observe: async (value) => {
      observations.push(value);
    },
  };
}

it.each([false, true])(
  'runs two rounds through official loop and public PiAi protocol (Messages=%s)',
  async (anthropic) => {
    const root = await mkdtemp(join(tmpdir(), 'mio-onelink-adapter-'));
    const ctx = await kernelRuntime(root, new ScriptedModel([]));
    const requests: { request: Request; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({ request, body: (await request.clone().json()) as Record<string, unknown> });
      return protocolResponse(request, `reply ${requests.length}`);
    });
    const engine = createDshConversationEngine(ctx, { databaseURL: 'unused', byok: true });
    const observations: ModelObservation[] = [];
    try {
      const selected = snapshot(anthropic);
      await engine.create('one', selected);
      for (const [requestId, text] of [
        ['first', 'remember this'],
        ['second', 'use history'],
      ]) {
        const result = await engine.run(
          'one',
          requestId!,
          text!,
          async () => {},
          () => {},
          { ...binding('one', observations, anthropic), requestId: requestId! },
        );
        expect(result, JSON.stringify({ observations, requests: requests.length })).toBe(
          'completed',
        );
      }
      expect(requests).toHaveLength(2);
      expect(requests.map(({ body }) => body.model)).toEqual([selected.modelId, selected.modelId]);
      expect(requests.map(({ request }) => new URL(request.url).pathname)).toEqual(
        Array(2).fill(anthropic ? '/v1/messages' : '/v1/chat/completions'),
      );
      expect(requests[0]!.request.headers.get('authorization')).toBe('Bearer synthetic-owner-key');
      expect(requests[0]!.request.headers.has('x-api-key')).toBe(false);
      expect(requests[0]!.request.redirect).toBe('error');
      expect(requests[0]!.body.max_tokens).toBe(1024);
      expect(JSON.stringify(requests[1]!.body.messages)).toContain('reply 1');
      expect(observations).toHaveLength(2);
      expect(observations[0]).toMatchObject({
        status: 200,
        providerRequestId: 'fixture-request-id',
        finish: 'stop',
        usageStatus: 'reported',
      });
      expect(observations[0]!.usage).toMatchObject({
        inputTokens: 5,
        outputTokens: 4,
        totalTokens: 9,
      });
      const raw = await ctx.mioKernel.history('one');
      expect(JSON.stringify(raw)).not.toContain(selected.apiKey);
      expect(
        raw.events.some(
          (event) =>
            event.type === 'assistant/message' &&
            event.data.message.source.replayState !== undefined,
        ),
      ).toBe(true);
      expect(
        raw.events
          .filter((event) => event.type === 'request/context')
          .every(
            (event) => event.type === 'request/context' && event.data.contextWindow === undefined,
          ),
      ).toBe(true);
    } finally {
      await engine.close();
      await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(['future-protocol', '__proto__', 'constructor'])(
  'refuses an unimplemented internal profile %s before preparing or dispatching a request',
  async (profile) => {
    const adapter = new OneLinkAdapter();
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    const controller = new AbortController();
    const initial = binding('unsupported', []);
    const run = {
      ...initial,
      snapshot: {
        ...initial.snapshot,
        protocol: profile as ChatProfile,
        profile: profile as ChatProfile,
      },
    };
    const release = adapter.bind(controller.signal, run);
    try {
      await expect(
        adapter.resolveModel('onelink-openai', run.snapshot.modelId, controller.signal),
      ).rejects.toMatchObject({ code: 'MODEL_PROFILE_UNSUPPORTED' });
      await expect(
        adapter.prepareCall('onelink-openai', run.snapshot.modelId, controller.signal),
      ).rejects.toMatchObject({ code: 'MODEL_PROFILE_UNSUPPORTED' });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      release();
    }
  },
);

it('returns the declared context only from the trusted request snapshot using the public DSH shape', async () => {
  const adapter = new OneLinkAdapter();
  const controller = new AbortController();
  const initial = binding('context', []);
  const run = { ...initial, snapshot: Object.freeze({ ...initial.snapshot, contextWindow: 8192 }) };
  const release = adapter.bind(controller.signal, run);
  try {
    expect(
      (await adapter.resolveModel('onelink-openai', run.snapshot.modelId, controller.signal))
        .context,
    ).toEqual({ contextWindow: 8192 });
    expect(
      (await adapter.prepareCall('onelink-openai', run.snapshot.modelId, controller.signal)).model
        .context,
    ).toEqual({ contextWindow: 8192 });
  } finally {
    release();
  }
});

it('rejects absent, mismatched and auxiliary bindings before network or credential lookup', async () => {
  const adapter = new OneLinkAdapter();
  const transport = vi.fn();
  vi.stubGlobal('fetch', transport);
  expect(await adapter.listModels()).toEqual([]);
  await expect(adapter.resolveModel('onelink-openai', 'future-text:route-Q')).rejects.toThrow(
    'binding',
  );
  await expect(adapter.prepareCall('onelink-openai', 'future-text:route-Q')).rejects.toThrow(
    'binding',
  );
  const controller = new AbortController();
  const observations: ModelObservation[] = [];
  const release = adapter.bind(controller.signal, binding('one', observations));
  expect(
    await adapter.resolveModel('onelink-openai', 'future-text:route-Q', controller.signal),
  ).not.toHaveProperty('context');
  const prepared = await adapter.prepareCall(
    'onelink-openai',
    'future-text:route-Q',
    controller.signal,
  );
  const options = {
    provider: 'onelink-openai',
    model: 'future-text:route-Q',
    maxTokens: 1024,
    messages: [
      createUserMessage({ content: [{ type: 'text', text: 'test' }], source: { kind: 'user' } }),
    ],
    signal: controller.signal,
    sessionId: 'wrong' as never,
  } satisfies GenerateOptions;
  await expect(collect(prepared.stream(options))).rejects.toThrow('binding');
  await expect(
    collect(
      prepared.stream({
        ...options,
        sessionId: 'one' as never,
        purpose: 'test-auxiliary' as never,
      }),
    ),
  ).rejects.toThrow('binding');
  release();
  await expect(collect(prepared.stream({ ...options, sessionId: 'one' as never }))).rejects.toThrow(
    'binding',
  );
  expect(transport).not.toHaveBeenCalled();
});

it.each([
  [401, 'AUTH'],
  [403, 'AUTH'],
  [402, 'QUOTA_EXCEEDED'],
  [408, 'TIMEOUT'],
  [429, 'RATE_LIMIT'],
  [500, 'SERVER'],
  [504, 'TIMEOUT'],
])('classifies HTTP %s without retry or leaking the error body', async (status, failureCode) => {
  const adapter = new OneLinkAdapter();
  const observations: ModelObservation[] = [];
  const controller = new AbortController();
  adapter.bind(controller.signal, binding('one', observations));
  const transport = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: { message: 'synthetic-owner-key private text' } }), {
        status: status as number,
      }),
  );
  vi.stubGlobal('fetch', transport);
  const prepared = await adapter.prepareCall(
    'onelink-openai',
    'future-text:route-Q',
    controller.signal,
  );
  const chunks: StreamChunk[] = await collect(
    prepared.stream({
      provider: 'onelink-openai',
      model: 'future-text:route-Q',
      maxTokens: 1024,
      messages: [],
      signal: controller.signal,
      sessionId: 'one' as never,
    }),
  );
  expect(transport).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(chunks)).not.toContain('synthetic-owner-key');
  expect(chunks.at(-1)).toMatchObject({
    type: 'finish',
    reason: { kind: 'error', failure: { code: failureCode } },
  });
  expect(observations[0]).toMatchObject({ status, failureCode, usageStatus: 'unknown' });
  expect(observations[0]).not.toHaveProperty('usage');
  expect(JSON.stringify(observations)).not.toContain('synthetic-owner-key');
});

it.each([false, true])(
  'preserves tool calls/results and replay through both public codecs (Messages=%s)',
  async (anthropic) => {
    const adapter = new OneLinkAdapter();
    const controller = new AbortController();
    const run = binding('tools', [], anthropic);
    adapter.bind(controller.signal, run);
    let body: unknown;
    let calls = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      body = await request.clone().json();
      return calls++ === 0
        ? protocolToolResponse(anthropic)
        : protocolResponse(request, 'tool result consumed');
    });
    const options: GenerateOptions = {
      provider: anthropic ? 'onelink-anthropic' : 'onelink-openai',
      model: run.snapshot.modelId,
      signal: controller.signal,
      sessionId: 'tools' as never,
      maxTokens: 1024,
      tools: [
        {
          name: 'counted_fixture',
          description: 'No-side-effect fixture',
          parameters: {
            type: 'object',
            properties: { value: { type: 'number' } },
            required: ['value'],
          },
        },
      ],
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'test tool protocol' }],
          source: { kind: 'user' },
        }),
      ],
    };
    const first = await adapter.prepareCall(options.provider, options.model, controller.signal);
    const assembler = new BlockAssembler();
    for (const chunk of await collect(first.stream(options))) assembler.push(chunk);
    expect(assembler.finish.kind).toBe('tool-calls');
    expect(assembler.blocks()).toMatchObject([
      { type: 'tool-call', name: 'counted_fixture', arguments: '{"value":7}' },
    ]);
    expect(assembler.replayState).toBeDefined();
    const assistant = assembler.message({
      provider: options.provider,
      model: options.model,
      ...(assembler.replayState ? { replayState: assembler.replayState } : {}),
    });
    expect(assistant.source.replayState).toBeDefined();
    const result = createToolResultMessage({
      content: [{ type: 'text', text: 'fixture-result-7' }],
      callId: ToolCallId('call_fixture'),
      isError: false,
    });
    const second = await adapter.prepareCall(options.provider, options.model, controller.signal);
    await collect(
      second.stream({ ...options, messages: [...options.messages, assistant, result] }),
    );
    expect(JSON.stringify(body)).toContain('fixture-result-7');
    expect(JSON.stringify(body)).toContain('counted_fixture');
    expect(JSON.stringify(body)).toContain('call_fixture');
  },
);

it('keeps the production tool guard on the actual PiAi-to-loop execution chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mio-onelink-deny-'));
  const ctx = await kernelRuntime(root, new ScriptedModel([]));
  const engine = createDshConversationEngine(ctx, { databaseURL: 'unused', byok: true });
  let calls = 0;
  let requests = 0;
  ctx.tools.register(
    defineTool({
      name: 'counted_fixture',
      description: 'No-side-effect test body',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async () => {
        calls++;
        return 'executed';
      },
    }),
  );
  ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }));
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return requests++ === 0
      ? protocolToolResponse(false)
      : protocolResponse(request, 'tool was denied');
  });
  try {
    const run = binding('deny', []);
    await engine.create('deny', run.snapshot);
    await engine.run(
      'deny',
      run.requestId,
      'request a tool',
      async () => {},
      () => {},
      run,
    );
    expect(calls).toBe(0);
    expect(JSON.stringify(await ctx.mioKernel.history('deny'))).toContain('MIO_TOOL_DENIED');
  } finally {
    await engine.close();
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
