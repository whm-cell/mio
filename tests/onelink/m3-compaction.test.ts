import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { compactionThreshold } from '../../src/conversations/compaction.ts';
import type {
  ContextUsage,
  ConversationEvent,
  ConversationImageTools,
  ConversationRun,
  ModelObservation,
} from '../../src/conversations/contracts.ts';
import { applyConversationPolicies } from '../../src/dsh/conversation-checkpoints.ts';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import { OneLinkAdapter, onelinkRoute } from '../../src/dsh/onelink.ts';
import type {
  ChatProfile,
  ChatReasoningEffort,
  ChatRuntimeSnapshot,
} from '../../src/providers/contracts.ts';
import { kernelRuntime, ScriptedModel } from '../support/kernel-runtime.ts';
import { protocolResponse } from './fixture.ts';

const sessionId = 'm3-context-fixture';
const assetId = '9e832b71-85b2-41ef-9904-06637845e16d';
const jobId = '7dde6aa9-09fd-46c3-8b15-1dec94dd4a69';
const summary = '第一集。失忆的钟表师林七在港口调查，采用低饱和灰蓝画风。';
const world = '林七是失忆的钟表师，故事发生在旧港口。' + '旧港夜路'.repeat(220);
const secret = 'synthetic-single-owner-key';
const window = 8192;
const contextCode = 'context_length_exceeded';

function snapshot(
  protocol: ChatProfile,
  contextWindow: number | null = window,
): ChatRuntimeSnapshot {
  return Object.freeze({
    providerConfigId: 'fixture-provider',
    providerRevision: 1,
    credentialVersion: 1,
    modelKey: 'fixture-model',
    catalogVersion: 1,
    adaptationVersion: 1,
    operation: 'chat',
    profile: protocol,
    modelRef: 'onelink:chat:fixture-model',
    modelId: 'fixture-model',
    protocol,
    capabilityVersion: 'fixture-v1',
    apiKey: secret,
    ...(contextWindow === null ? {} : { contextWindow }),
  });
}

function runBinding(
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
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    observe: async (observation) => {
      observations.push(observation);
    },
  };
}

function rejection(status: number, code = contextCode) {
  return Response.json(
    { error: { code, message: 'private upstream detail' } },
    { status, headers: { 'x-should-retry': 'true', 'retry-after': '0' } },
  );
}

function anthropicFailure(type: string, emitted?: 'body' | 'thinking' | 'empty') {
  const block =
    emitted === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' };
  const delta =
    emitted === 'thinking'
      ? { type: 'thinking_delta', thinking: '内部思考' }
      : { type: 'text_delta', text: emitted === 'body' ? '先出现的正文' : '' };
  const prefix = emitted
    ? [
        {
          type: 'message_start',
          message: {
            id: 'fixture',
            model: 'fixture-model',
            role: 'assistant',
            content: [],
            usage: { input_tokens: 9, output_tokens: 0 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: block },
        { type: 'content_block_delta', index: 0, delta },
      ]
    : [];
  const frames = [
    ...prefix,
    { type: 'error', error: { type, message: 'private upstream detail' } },
  ];
  return new Response(
    frames
      .map(
        (frame) => `event: ${frame.type}
data: ${JSON.stringify(frame)}

`,
      )
      .join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

function anthropicThinking(text?: string) {
  const frames = [
    {
      type: 'message_start',
      message: {
        id: 'fixture',
        model: 'fixture-model',
        role: 'assistant',
        content: [],
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'private hidden thought' },
    },
    { type: 'content_block_stop', index: 0 },
    ...(text
      ? [
          { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
          { type: 'content_block_stop', index: 1 },
        ]
      : []),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
    { type: 'message_stop' },
  ];
  return new Response(
    frames
      .map(
        (frame) => `event: ${frame.type}
data: ${JSON.stringify(frame)}

`,
      )
      .join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

function toolResponse(name: string, args: object = {}, text?: string) {
  const chunks = [
    {
      delta: {
        role: 'assistant',
        ...(text ? { content: text } : {}),
        tool_calls: [
          {
            index: 0,
            id: 'fixture_' + name,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: null,
    },
    { delta: {}, finish_reason: 'tool_calls' },
  ].map((choice) => ({
    id: 'fixture',
    object: 'chat.completion.chunk',
    model: 'fixture-model',
    choices: [{ index: 0, ...choice }],
  }));
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

interface WireCall {
  request: Request;
  wire: string;
  body: { tools?: unknown[]; model: string };
  options: GenerateOptions;
  durable: readonly SessionEvent[];
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const clean of cleanups.splice(0).reverse()) await clean();
  } finally {
    vi.unstubAllGlobals();
  }
});

async function setup(
  options: { profile?: ChatProfile; contextWindow?: number | null; images?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'mio-m3-compaction-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const ctx = await kernelRuntime(root, new ScriptedModel([]));
  cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(TokenMeter);
  await ctx.plugin(ToolResultPruner);
  await ctx.plugin({
    name: 'm3-checkpoint-policies',
    inject: ['mioKernel', 'sessions', 'tools'],
    apply: applyConversationPolicies,
  });
  const calls: WireCall[] = [];
  let requestOptions: GenerateOptions | undefined;
  ctx.on('llm/stream', (attempt, next) => {
    if (attempt.sessionId === sessionId) requestOptions = attempt;
    return next();
  });
  const raw = async () => {
    const reader = await ctx.sessionPersistence.open(SessionId(sessionId), 'read');
    try {
      return (await reader.read(0)).events;
    } finally {
      await reader.close();
    }
  };
  const answer = (call: WireCall, text = '继续') => protocolResponse(call.request, text);
  let respond: (call: WireCall) => Response | Promise<Response> = answer;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const wire = await request.clone().text();
    if (!requestOptions) throw new Error('Missing native LLM boundary');
    const call = {
      request,
      wire,
      body: JSON.parse(wire) as WireCall['body'],
      options: requestOptions,
      durable: await raw(),
    };
    calls.push(call);
    return respond(call);
  });
  const listModels: ConversationImageTools['listModels'] = async () => [
    {
      modelRef: 'onelink:image:one',
      modelId: 'one',
      name: 'MODEL_HEAD ' + 'h'.repeat(5400) + ' MODEL_MIDDLE ' + 't'.repeat(5400) + ' MODEL_TAIL',
      vendor: 'fixture',
      driver: 'openai-images',
      supportedOperations: ['generate'],
      requiresAsync: true,
      maxN: 1,
      allowExplicitN: false,
      allowedSizes: null,
      defaultSize: null,
      allowCustomDimensions: false,
      allowedAspectRatios: [],
      maxReferenceImages: 0,
      allowGenerateReferences: false,
      allowMaskPng: false,
      allowedQualities: [],
      allowedBackgrounds: [],
      allowedOutputFormats: [],
    },
  ];
  const job = {
    jobId,
    assetIds: [assetId],
    requestedCount: 1,
    errorCode: null,
    status: 'completed',
    outputs: [{ index: 0, assetId }],
  };
  const createImage = vi.fn<ConversationImageTools['createImage']>().mockResolvedValue(job);
  const images = options.images
    ? { listModels, createImage, getImage: async () => job }
    : undefined;
  const engine = createDshConversationEngine(ctx, { databaseURL: 'unused', byok: true }, images);
  cleanups.push(() => engine.close());
  const events: ConversationEvent[] = [];
  const observations: ModelObservation[] = [];
  const contextUsage: ContextUsage[] = [];
  const route = snapshot(options.profile ?? 'openai-chat', options.contextWindow);
  await engine.create(sessionId, route);
  return {
    ctx,
    engine,
    route,
    calls,
    events,
    observations,
    contextUsage,
    raw,
    answer,
    createImage,
    run: (id: string, text = '接续当前场景', model = route, effort?: ChatReasoningEffort) =>
      engine.run(
        sessionId,
        id,
        text,
        async () => {},
        (event) => events.push(event),
        runBinding(id, model, observations, effort),
        [],
        undefined,
        (read) => contextUsage.push(read()),
      ),
    compact: (id: string, model = route, signal = new AbortController().signal) =>
      engine.compact!(sessionId, runBinding(id, model, observations), signal, (read) =>
        contextUsage.push(read()),
      ),
    respond: (next: typeof respond) => {
      respond = next;
    },
    usage: () => engine.contextUsage!(sessionId),
  };
}

it('prunes only historical large tool results before using one drama summary and preserving asset cards', async () => {
  const fixture = await setup({ images: true });
  const { calls, observations } = fixture;
  fixture.respond((call) =>
    calls.length === 1
      ? toolResponse('submit_image_job', {
          modelRef: 'onelink:image:one',
          prompt: '港口角色定妆照',
        })
      : fixture.answer(call),
  );
  expect(await fixture.run('world', world)).toBe('completed');

  fixture.respond((call) =>
    call.wire.includes('选择当前模型') && !call.wire.includes('MODEL_MIDDLE')
      ? toolResponse('list_image_models')
      : fixture.answer(call),
  );
  expect(await fixture.run('catalog', '选择当前模型')).toBe('completed');
  expect(calls.at(-1)!.wire).toContain('MODEL_MIDDLE');
  expect((await fixture.raw()).some((event) => event.type === 'compaction/prune')).toBe(false);

  const threshold = compactionThreshold(window, 1024);
  const before = await fixture.usage();
  const padding = (estimate: number) => 'a'.repeat(Math.max(40, (threshold - estimate + 100) * 4));
  fixture.respond((call) => fixture.answer(call));
  const beforePrune = calls.length;
  expect(await fixture.run('prune', '保留最近目录首尾。' + padding(before.estimatedTokens))).toBe(
    'completed',
  );
  expect(calls.slice(beforePrune)).toHaveLength(1);
  const pruned = calls.at(-1)!;
  expect(pruned.wire).toContain('MODEL_HEAD');
  expect(pruned.wire).toContain('MODEL_TAIL');
  expect(pruned.wire).not.toContain('MODEL_MIDDLE');
  expect(pruned.durable.some((event) => event.type === 'compaction/prune')).toBe(true);

  const beforeSummary = await fixture.usage();
  fixture.respond((call) =>
    fixture.answer(
      call,
      call.options.purpose === 'compaction' ? summary : '林七，assetId=' + assetId,
    ),
  );
  const beforeAuto = calls.length;
  expect(
    await fixture.run('summary', '保持最近进展并继续。' + padding(beforeSummary.estimatedTokens)),
  ).toBe('completed');
  const [summaryCall, answer] = calls.slice(beforeAuto);
  expect(calls.length - beforeAuto).toBe(2);
  expect(summaryCall!.options.purpose).toBe('compaction');
  expect(summaryCall!.body.tools ?? []).toHaveLength(0);
  expect(summaryCall!.wire).toContain('林七是失忆的钟表师');
  expect(summaryCall!.wire).toContain(assetId);
  expect(summaryCall!.wire).toContain(jobId);
  expect(summaryCall!.durable.at(-1)!.type).toBe('compaction/start');
  expect(answer!.wire).toContain(summary);
  expect(answer!.wire).toContain('assetId=' + assetId);
  expect(answer!.wire).toContain('保留最近目录首尾');
  expect(answer!.options.signal).toBe(summaryCall!.options.signal);
  expect(answer!.request.headers.get('authorization')).toBe('Bearer ' + secret);
  expect(summaryCall!.request.headers.get('authorization')).toBe('Bearer ' + secret);
  expect(observations.slice(-2).map((entry) => entry.purpose)).toEqual(['compaction', undefined]);
  expect(fixture.contextUsage.at(-1)).toMatchObject({ contextWindow: window, compacted: true });

  const history = await fixture.engine.history(sessionId, -1, 100);
  const texts = history.items.flatMap((item) => ('text' in item ? [item.text] : []));
  expect(texts).toContain(world);
  expect(texts.join('\n')).not.toContain(summary);
  expect(texts.join('\n')).not.toContain('你正在整理同一部漫剧');
  expect(history.items.filter((item) => item.role === 'tool')).toHaveLength(1);
  expect(fixture.events.filter((event) => event.type === 'tool')).toHaveLength(1);
  expect(fixture.createImage).toHaveBeenCalledOnce();
  expect((await fixture.usage()).compacted).toBe(true);
  const durable = await fixture.raw();
  expect(
    durable.some(
      (event) =>
        event.type === 'tool/result' && JSON.stringify(event.data).includes('MODEL_MIDDLE'),
    ),
  ).toBe(true);
});

it('preserves authorized edit inputs and masks when the model summary omits them', async () => {
  const fixture = await setup({ images: true });
  const input = 'bd932443-06d1-4f7f-98c5-1a49413817ae';
  const otherInput = 'f9192044-e330-4ba4-a6f7-7d4403ddc735';
  const mask = 'f5377f3e-1146-4614-83d0-2a5692b141a3';
  const denied = '9edd528c-b17d-4e9f-b952-fa2e1cb38a1d';
  const edit = {
    modelRef: 'onelink:image:one',
    prompt: '用蒙版编辑背景',
    operation: 'edit',
    imageAssetIds: [input, otherInput],
    maskAssetId: mask,
  };
  fixture.respond((call) =>
    fixture.calls.length === 1 ? toolResponse('submit_image_job', edit) : fixture.answer(call),
  );
  expect(await fixture.run('edit', world)).toBe('completed');
  expect(fixture.createImage).toHaveBeenCalledWith(
    { userId: 'fixture-owner' },
    expect.any(String),
    edit.modelRef,
    expect.objectContaining({
      operation: 'edit',
      imageAssetIds: [input, otherInput],
      maskAssetId: mask,
    }),
    expect.any(AbortSignal),
  );
  const deniedStart = fixture.calls.length;
  fixture.createImage.mockRejectedValueOnce(new Error('fixture rejected inaccessible asset'));
  fixture.respond((call) =>
    fixture.calls.length === deniedStart + 1
      ? toolResponse('submit_image_job', { ...edit, imageAssetIds: [denied] })
      : fixture.answer(call),
  );
  expect(await fixture.run('denied-edit', '另一个编辑建议')).toBe('completed');
  fixture.respond((call) => fixture.answer(call, call.options.purpose ? summary : '后续进展'));
  expect(await fixture.run('older-context', '历史场景补充。' + '灯下'.repeat(400))).toBe(
    'completed',
  );

  expect(await fixture.compact('retain-edit')).toBe('completed');
  const firstSummary = fixture.calls.at(-1)!;
  expect(firstSummary.options.purpose).toBe('compaction');
  expect(summary).not.toContain(input);
  expect(summary).not.toContain(mask);
  expect(await fixture.run('still-edit', '继续修改已确认的场景')).toBe('completed');
  const wire = fixture.calls.at(-1)!.wire;
  expect(wire).toContain('imageAssetIds=' + input);
  expect(wire).toContain('imageAssetIds=' + otherInput);
  expect(wire).toContain('maskAssetId=' + mask);
  expect(wire).not.toContain('imageAssetIds=' + denied);

  expect(await fixture.compact('retain-again')).toBe('completed');
  expect(fixture.calls.at(-1)!.options.purpose).toBe('compaction');
  expect(await fixture.run('after-second', '根据目前成果继续')).toBe('completed');
  expect(fixture.calls.at(-1)!.wire).toContain('maskAssetId=' + mask);
  expect(fixture.calls.at(-1)!.wire).toContain('imageAssetIds=' + input);
});

it.each([false, true])(
  'uses one paid recovery on exact overflow (second overflow=%s)',
  async (again) => {
    const fixture = await setup();
    expect(await fixture.run('old', world)).toBe('completed');
    const first = fixture.calls.length;
    fixture.respond((call) => {
      if (call.options.purpose === 'compaction') return fixture.answer(call, summary);
      if (fixture.calls.length === first + 1 || again) return rejection(400);
      return fixture.answer(call, '恢复成功');
    });
    expect(await fixture.run('overflow')).toEqual(
      again ? { status: 'failed', error: 'MODEL_CONTEXT_OVERFLOW' } : 'completed',
    );
    const tried = fixture.calls.slice(first);
    expect(tried.map((call) => call.options.purpose)).toEqual([undefined, 'compaction', undefined]);
    expect(tried.every((call) => call.options.signal === tried[0]!.options.signal)).toBe(true);
    expect(
      tried.every(
        (call) =>
          call.options.sessionId === sessionId &&
          call.body.model === fixture.route.modelId &&
          call.request.headers.get('authorization') === 'Bearer ' + secret,
      ),
    ).toBe(true);
    expect(tried[1]!.durable.some((event) => event.type === 'assistant/attempt')).toBe(true);
    expect(
      tried[2]!.durable.some((event) => event.type === 'compaction/end' && !event.data.error),
    ).toBe(true);
    expect(tried[2]!.wire.match(/接续当前场景/g)).toHaveLength(1);
    expect(fixture.observations.slice(-3)).toMatchObject([
      { status: 400, failureCode: 'CONTEXT_OVERFLOW' },
      { status: 200, purpose: 'compaction', finish: 'stop', usageStatus: 'reported' },
      again ? { status: 400, failureCode: 'CONTEXT_OVERFLOW' } : { status: 200, finish: 'stop' },
    ]);
    const log = await fixture.raw();
    expect(log.filter((event) => event.type === 'compaction/start')).toHaveLength(1);
    expect(
      log.filter((event) => event.type === 'user/message' && event.data.source.kind === 'user'),
    ).toHaveLength(2);
  },
);

it.each([
  [429, 'RATE_LIMIT', 'MODEL_RATE_LIMITED'],
  [500, 'SERVER', 'MODEL_UPSTREAM_ERROR'],
  [504, 'TIMEOUT', 'MODEL_TIMEOUT'],
] as const)('makes no paid recovery on HTTP %i', async (status, code, failure) => {
  const fixture = await setup();
  expect(await fixture.run('old', world)).toBe('completed');
  fixture.respond(() => rejection(status));
  expect(await fixture.run('transient')).toEqual({ status: 'failed', error: failure });
  expect(fixture.calls).toHaveLength(2);
  expect(fixture.observations.at(-1)).toMatchObject({ failureCode: code });
  expect((await fixture.usage()).compacted).toBe(false);
});

it('keeps SDK-inferred request size separate from confirmed stream overflow', async () => {
  const fixture = await setup({ profile: 'anthropic-messages' });
  expect(await fixture.run('old', world)).toBe('completed');
  fixture.respond(() => anthropicFailure('request_too_large'));
  expect(await fixture.run('ambiguous')).toBe('failed');
  expect(fixture.calls).toHaveLength(2);
  expect(fixture.observations.at(-1)).toMatchObject({ status: 200, failureCode: 'PI_AI_ERROR' });
});

it('settles confirmed overflow without recovery once the failing attempt publishes a body prefix', async () => {
  const fixture = await setup({ profile: 'anthropic-messages' });
  expect(await fixture.run('old', world)).toBe('completed');
  const before = fixture.calls.length;
  const eventsBefore = fixture.events.length;
  fixture.respond((call) => {
    if (fixture.calls.length === before + 1)
      return anthropicFailure('context_window_exceeded', 'body');
    return fixture.answer(call, call.options.purpose === 'compaction' ? summary : '意外的重发正文');
  });
  expect(await fixture.run('stream-exact')).toEqual({
    status: 'failed',
    error: 'MODEL_CONTEXT_OVERFLOW',
  });
  expect(fixture.calls.slice(before)).toHaveLength(1);
  expect(fixture.observations.slice(before)).toMatchObject([
    { status: 200, failureCode: 'CONTEXT_OVERFLOW' },
  ]);
  expect(fixture.events.slice(eventsBefore)).toEqual([
    { type: 'text', requestId: 'stream-exact', text: '先出现的正文' },
  ]);

  const durable = await fixture.raw();
  const failedAttempts = durable.filter((event) => event.type === 'assistant/attempt');
  expect(failedAttempts).toHaveLength(1);
  expect(JSON.stringify(failedAttempts[0]!.data.stream)).toContain('先出现的正文');
  expect(durable.some((event) => event.type === 'compaction/start')).toBe(false);
  const history = await fixture.engine.history(sessionId, -1, 100);
  expect(history.items.at(-1)).toMatchObject({ role: 'status', status: 'failed' });
  expect(history.items.filter((item) => item.role === 'assistant')).toEqual([
    expect.objectContaining({ text: '继续' }),
  ]);
});

it.each(['thinking', 'empty'] as const)(
  'retains confirmed overflow recovery when the failing attempt only emits %s',
  async (emitted) => {
    const fixture = await setup({ profile: 'anthropic-messages' });
    const route = {
      ...fixture.route,
      reasoning: { supported: true, efforts: ['high'] },
    } satisfies ChatRuntimeSnapshot;
    expect(await fixture.run('old', world)).toBe('completed');
    const before = fixture.calls.length;
    const eventsBefore = fixture.events.length;
    const chunks: StreamChunk[] = [];
    fixture.ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type === 'chunk') chunks.push(frame.chunk);
    });
    fixture.respond((call) => {
      if (fixture.calls.length === before + 1)
        return anthropicFailure('context_window_exceeded', emitted);
      return call.options.purpose === 'compaction'
        ? anthropicThinking(summary)
        : fixture.answer(call, '恢复正文');
    });
    expect(await fixture.run('stream-exact', undefined, route, 'high')).toBe('completed');
    expect(fixture.calls.slice(before).map((call) => call.options.purpose)).toEqual([
      undefined,
      'compaction',
      undefined,
    ]);
    expect(fixture.calls.slice(before).map((call) => call.options.reasoningEffort)).toEqual([
      'high',
      undefined,
      'high',
    ]);
    expect(chunks).toContainEqual(
      expect.objectContaining(
        emitted === 'thinking'
          ? { type: 'reasoning-delta', text: '内部思考' }
          : { type: 'text-delta', text: '' },
      ),
    );
    expect(
      fixture.events
        .slice(eventsBefore)
        .filter((event) => event.type === 'reasoning' || (event.type === 'text' && event.text)),
    ).toEqual([
      ...(emitted === 'thinking'
        ? [{ type: 'reasoning', requestId: 'stream-exact', text: '内部思考' }]
        : []),
      { type: 'text', requestId: 'stream-exact', text: '恢复正文' },
    ]);
  },
);

it('records a successful body in a previous step without losing recovery of a later step', async () => {
  const fixture = await setup({ images: true });
  expect(await fixture.run('old', world)).toBe('completed');
  const initial = fixture.calls.length;
  fixture.respond((call) => {
    const offset = fixture.calls.length - initial;
    if (offset === 1)
      return toolResponse(
        'submit_image_job',
        { modelRef: 'onelink:image:one', prompt: '港口角色头像' },
        '我会先提交港口角色头像任务。',
      );
    if (offset === 2) return rejection(400);
    return fixture.answer(call, call.options.purpose === 'compaction' ? summary : '场景更新');
  });
  expect(await fixture.run('with-tool')).toBe('completed');
  expect(fixture.events).toContainEqual({
    type: 'text',
    requestId: 'with-tool',
    text: '我会先提交港口角色头像任务。',
  });
  expect(fixture.calls.slice(initial).map((call) => call.options.purpose)).toEqual([
    undefined,
    undefined,
    'compaction',
    undefined,
  ]);
  expect(fixture.createImage).toHaveBeenCalledOnce();
  expect(fixture.events.filter((event) => event.type === 'tool')).toHaveLength(1);
});

it('loses neither older raw history nor bounded recovery if only a shorter balanced prefix fits', async () => {
  const fixture = await setup({ contextWindow: null });
  expect(await fixture.run('small-old', world)).toBe('completed');
  const giantOld = '历史大段标识' + 'a'.repeat(25_000);
  expect(await fixture.run('large-old', giantOld)).toBe('completed');
  expect(await fixture.run('other-old', '历史后续镜头')).toBe('completed');
  const first = fixture.calls.length;
  fixture.respond((request) =>
    fixture.answer(request, request.options.purpose === 'compaction' ? summary : '接续成功'),
  );
  expect(await fixture.run('declared-window', '现在续写', snapshot('openai-chat', 4096))).toBe(
    'completed',
  );
  const [call, resumed] = fixture.calls.slice(first);
  expect(fixture.calls.length - first).toBe(2);
  expect(call!.wire).toContain('林七是失忆的钟表师');
  expect(call!.wire).not.toContain('历史大段标识');
  expect(resumed!.wire).toContain('历史大段标识');
  const history = await fixture.engine.history(sessionId, -1, 100);
  expect(history.items).toContainEqual(expect.objectContaining({ role: 'user', text: giantOld }));
});

it('refuses to retry an indivisible new input that exhausts the known window', async () => {
  const fixture = await setup();
  fixture.respond(() => rejection(400));
  expect(await fixture.run('large', 'a'.repeat(40_000))).toEqual({
    status: 'failed',
    error: 'MODEL_CONTEXT_OVERFLOW',
  });
  expect(fixture.calls).toHaveLength(1);
  expect((await fixture.raw()).some((event) => event.type === 'compaction/start')).toBe(false);
});

it.each([200, 400])(
  'keeps one ordinary attempt with old compressible history when current input fills the window (HTTP %i)',
  async (status) => {
    const fixture = await setup();
    expect(await fixture.run('old', world)).toBe('completed');
    const giant = '本轮完整的超长剧本' + 'a'.repeat(40_000);
    fixture.respond((call) =>
      status === 200 ? fixture.answer(call, '供应商接受长输入') : rejection(400),
    );
    expect(await fixture.run('long-current-turn', giant)).toEqual(
      status === 200 ? 'completed' : { status: 'failed', error: 'MODEL_CONTEXT_OVERFLOW' },
    );
    expect(fixture.calls).toHaveLength(2);
    const ordinary = fixture.calls.at(-1)!;
    expect(ordinary.options.purpose).toBeUndefined();
    expect(ordinary.wire).toContain(giant);
    expect(ordinary.wire).toContain(world);
    expect(fixture.observations.at(-1)).toMatchObject({ status });
    expect((await fixture.raw()).some((event) => event.type === 'compaction/start')).toBe(false);
    const history = await fixture.engine.history(sessionId, -1, 100);
    expect(history.items).toContainEqual(expect.objectContaining({ role: 'user', text: world }));
    expect(history.items).toContainEqual(expect.objectContaining({ role: 'user', text: giant }));
  },
);

it('does not dispatch a summary when its oldest indivisible historical node cannot fit', async () => {
  const fixture = await setup({ contextWindow: null });
  const giant = '不可切分的存量剧本' + 'r'.repeat(25_000);
  expect(await fixture.run('large-old', giant)).toBe('completed');
  const route = snapshot('openai-chat', 4096);
  expect(await fixture.compact('unfittable-history', route)).toBe('completed');
  expect(fixture.calls).toHaveLength(1);
  fixture.respond(() => rejection(400));
  expect(await fixture.run('failure-after-large-history', '继续编剧', route)).toEqual({
    status: 'failed',
    error: 'MODEL_CONTEXT_OVERFLOW',
  });
  expect(fixture.calls).toHaveLength(2);
  expect(fixture.calls.at(-1)!.options.purpose).toBeUndefined();
  expect(fixture.calls.at(-1)!.wire).toContain(giant);
  expect((await fixture.raw()).some((event) => event.type === 'compaction/start')).toBe(false);
  const history = await fixture.engine.history(sessionId, -1, 100);
  expect(history.items).toContainEqual(expect.objectContaining({ role: 'user', text: giant }));
});

it('prunes historical large tools without guessing an undeclared window or billing a summary', async () => {
  const fixture = await setup({ contextWindow: null, images: true });
  fixture.respond((call) =>
    fixture.calls.length === 1 ? toolResponse('list_image_models') : fixture.answer(call),
  );
  expect(await fixture.run('catalog')).toBe('completed');
  expect(fixture.calls.at(-1)!.wire).toContain('MODEL_MIDDLE');
  expect(await fixture.run('use-old-catalog')).toBe('completed');
  expect(fixture.calls).toHaveLength(3);
  expect(fixture.calls.at(-1)!.wire).toContain('MODEL_HEAD');
  expect(fixture.calls.at(-1)!.wire).not.toContain('MODEL_MIDDLE');
  expect(await fixture.usage()).toMatchObject({ contextWindow: null, compacted: false });
});

it('requires Mio admission for direct DSH region compaction', async () => {
  const fixture = await setup();
  expect(await fixture.run('old', world)).toBe('completed');
  const session = await fixture.ctx.mioKernel.readView(sessionId);
  const seq = session.surface.nodes[1]!;
  await expect(
    fixture.ctx.compaction.compactRegion(
      seq,
      seq,
      { session, options: {} },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'BINDING_REQUIRED' });
  expect(fixture.calls).toHaveLength(1);
  expect((await fixture.raw()).some((event) => event.type === 'compaction/start')).toBe(false);
});

it('commits a manual summary without admitting a turn or emitting summary text', async () => {
  const fixture = await setup();
  expect(await fixture.run('old', world)).toBe('completed');
  const before = await fixture.raw();
  const delivered = fixture.events.length;
  fixture.respond((call) => fixture.answer(call, summary));
  expect(await fixture.compact('manual')).toBe('completed');
  expect(fixture.calls).toHaveLength(2);
  expect(fixture.calls.at(-1)!.options.purpose).toBe('compaction');
  expect(fixture.calls.at(-1)!.body.tools ?? []).toHaveLength(0);
  expect(fixture.observations.at(-1)).toMatchObject({
    status: 200,
    finish: 'stop',
    purpose: 'compaction',
  });
  expect(fixture.events).toHaveLength(delivered);
  const after = await fixture.raw();
  expect(after.filter((event) => event.type === 'turn/start')).toHaveLength(
    before.filter((event) => event.type === 'turn/start').length,
  );
  expect(after.filter((event) => event.type === 'compaction/end')).toMatchObject([
    { data: { turn: null } },
  ]);
  expect(fixture.contextUsage.at(-1)).toMatchObject({ contextWindow: window, compacted: true });
  expect(await fixture.usage()).toMatchObject({ contextWindow: window, compacted: true });
});

it('stores only formal text when the fixed native adapter also returns hidden thinking', async () => {
  const fixture = await setup({ profile: 'anthropic-messages' });
  expect(await fixture.run('old', world)).toBe('completed');
  const chunks: StreamChunk[] = [];
  fixture.ctx.on('llm/stream', (options, next) => {
    if (options.purpose !== 'compaction') return next();
    return (async function* () {
      for await (const chunk of next()) {
        chunks.push(chunk);
        yield chunk;
      }
    })();
  });
  fixture.respond(() => anthropicThinking(summary));
  expect(await fixture.compact('thinking')).toBe('completed');
  expect(chunks).toContainEqual(
    expect.objectContaining({
      type: 'reasoning-delta',
      text: 'private hidden thought',
    }),
  );
  expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: summary }));
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } });
  const durable = await fixture.raw();
  expect(durable.filter((event) => event.type === 'compaction/summary')).toMatchObject([
    { data: { summary: [{ type: 'text', text: summary }] } },
  ]);
  expect(JSON.stringify(durable)).not.toContain('private hidden thought');
  expect(fixture.observations.at(-1)).toMatchObject({
    purpose: 'compaction',
    finish: 'stop',
    usageStatus: 'reported',
  });
});

it.each(['only reasoning', 'tool call', 'output limit'] as const)(
  'fails an auxiliary output with %s without writing a summary',
  async (kind) => {
    const fixture = await setup({
      profile: kind === 'only reasoning' ? 'anthropic-messages' : 'openai-chat',
    });
    expect(await fixture.run('old', world)).toBe('completed');
    fixture.respond((call) => {
      switch (kind) {
        case 'only reasoning':
          return anthropicThinking();
        case 'tool call':
          return toolResponse('submit_image_job');
        case 'output limit':
          return protocolResponse(call.request, summary, false, { ending: 'max-tokens' });
      }
    });
    expect(await fixture.compact('rejected-output')).toBe('failed');
    expect(fixture.calls).toHaveLength(2);
    expect((await fixture.raw()).some((event) => event.type === 'compaction/summary')).toBe(false);
    expect(fixture.observations.at(-1)?.purpose).toBe('compaction');
  },
);

it('keeps manual compaction empty, unsupported, busy and cancelled paths honest', async () => {
  const fixture = await setup();
  expect(await fixture.compact('empty')).toBe('completed');
  expect(fixture.calls).toHaveLength(0);
  await expect(
    fixture.compact('unknown-window', snapshot('openai-chat', null)),
  ).rejects.toMatchObject({ code: 'CONVERSATION_COMPACTION_UNSUPPORTED' });
  expect(await fixture.run('old', world)).toBe('completed');
  const started = Promise.withResolvers<void>();
  fixture.respond((call) => {
    started.resolve();
    return protocolResponse(call.request, '未完成的摘要', true);
  });
  const running = fixture.compact('manual');
  await started.promise;
  try {
    await expect(fixture.run('different')).rejects.toThrow('MIO_ENGINE_BUSY');
    await expect(fixture.compact('other-manual')).rejects.toThrow('MIO_ENGINE_BUSY');
    await fixture.engine.cancel(sessionId, 'other-manual');
    expect(fixture.calls.at(-1)!.request.signal.aborted).toBe(false);
  } finally {
    await fixture.engine.cancel(sessionId, 'manual');
  }
  expect(await running).toBe('cancelled');
  expect(fixture.observations.at(-1)).toMatchObject({ purpose: 'compaction', finish: 'aborted' });
  const events = await fixture.raw();
  expect(events.filter((event) => event.type === 'compaction/end')).toMatchObject([
    {
      data: { turn: null, error: 'Compaction cancelled' },
    },
  ]);
  expect(events.some((event) => event.type === 'compaction/summary')).toBe(false);
  expect((await fixture.usage()).compacted).toBe(false);
});

it('keeps an original overflow with unavailable observations from causing more paid calls', async () => {
  const fixture = await setup();
  expect(await fixture.run('old', world)).toBe('completed');
  fixture.respond(() => rejection(400));
  const observe = vi.fn(async () => {
    throw new Error('fixture observation store unavailable');
  });
  const run = runBinding('unobserved-overflow', fixture.route, []);
  expect(
    await fixture.engine.run(
      sessionId,
      run.requestId,
      '继续',
      async () => {},
      () => {},
      { ...run, observe },
    ),
  ).toBe('unknown');
  expect(observe).toHaveBeenCalledOnce();
  expect(fixture.calls).toHaveLength(2);
  expect((await fixture.raw()).some((event) => event.type === 'compaction/start')).toBe(false);
});

it('does not re-dispatch after summary failure or a rejected durable compaction checkpoint', async () => {
  const fixture = await setup();
  expect(await fixture.run('old', world)).toBe('completed');
  fixture.respond((call) =>
    call.options.purpose === 'compaction' ? rejection(429) : rejection(400),
  );
  expect(await fixture.run('summary-denied')).toEqual({
    status: 'failed',
    error: 'MODEL_CONTEXT_OVERFLOW',
  });
  expect(fixture.calls).toHaveLength(3);
  expect(fixture.observations.at(-1)).toMatchObject({
    purpose: 'compaction',
    status: 429,
    failureCode: 'RATE_LIMIT',
  });
  expect((await fixture.usage()).compacted).toBe(false);

  let checkpointSeen = false;
  let checkpointRejected = false;
  fixture.ctx.on('session/event', (session, event) => {
    if (session.id === sessionId && event.type === 'compaction/end' && !event.data.error)
      checkpointSeen = true;
  });
  const off = fixture.ctx.on('session/flush', (session) => {
    if (session.id === sessionId && checkpointSeen && !checkpointRejected) {
      checkpointRejected = true;
      throw new Error('fixture checkpoint failure');
    }
  });
  fixture.respond((call) =>
    call.options.purpose === 'compaction' ? fixture.answer(call, summary) : rejection(400),
  );
  try {
    expect(await fixture.run('storage-failure')).toBe('unknown');
    expect(checkpointRejected).toBe(true);
    expect(fixture.calls).toHaveLength(5);
  } finally {
    off();
  }
});

it('does not allow an unowned auxiliary request, tools, or a second dispatch on one grant', async () => {
  const adapter = new OneLinkAdapter();
  const route = snapshot('openai-chat');
  const run = runBinding('trusted', route, []);
  const noNetwork = vi.fn<typeof fetch>(() => {
    throw new Error('fixture blocks network');
  });
  vi.stubGlobal('fetch', noNetwork);
  const signal = new AbortController().signal;
  const release = adapter.bind(signal, run);
  const options = {
    provider: onelinkRoute(route),
    model: route.modelId,
    maxTokens: 512,
    messages: [
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: world }] }),
    ],
    signal,
    purpose: 'compaction',
    sessionId: SessionId(sessionId),
  } satisfies GenerateOptions;
  async function send(overrides: Partial<GenerateOptions>): Promise<StreamChunk[]> {
    const call = await adapter.prepareCall(options.provider, options.model, signal);
    const chunks: StreamChunk[] = [];
    for await (const chunk of call.stream({ ...options, ...overrides })) chunks.push(chunk);
    return chunks;
  }
  const wrongTools = [{ name: 'forbidden', description: 'fixture', parameters: {} }];
  await expect(send({})).rejects.toMatchObject({ code: 'BINDING_REQUIRED' });
  await expect(
    adapter.withCompaction(signal, { ...run, userId: 'someone-else' }, () => send({})),
  ).rejects.toMatchObject({ code: 'BINDING_REQUIRED' });
  await adapter.withCompaction(signal, run, async () => {
    await expect(send({ sessionId: SessionId('other-session') })).rejects.toMatchObject({
      code: 'BINDING_REQUIRED',
    });
    await expect(send({ signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'BINDING_REQUIRED',
    });
    await expect(send({ tools: wrongTools })).rejects.toMatchObject({ code: 'BINDING_REQUIRED' });
    expect(noNetwork).toHaveBeenCalledTimes(0);
    noNetwork.mockResolvedValueOnce(
      protocolResponse(
        new Request('https://api.onelinkai.cloud/v1/chat/completions'),
        summary,
      ) as never,
    );
    expect((await send({})).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } });
    await expect(send({})).rejects.toMatchObject({ code: 'BINDING_REQUIRED' });
  });
  release();
  expect(noNetwork).toHaveBeenCalledOnce();
  await expect(send({})).rejects.toMatchObject({ code: 'BINDING_REQUIRED' });
});
