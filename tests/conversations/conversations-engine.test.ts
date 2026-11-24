import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt';
import type { ConversationImageTools, ConversationRun } from '../../src/conversations/contracts.ts';
import {
  buildConversationSystemPrompt,
  MIIOO_ASSISTANT_NAME,
} from '../../src/conversations/prompt.ts';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import { parseImageJobPresentationMeta } from '../../src/dsh/image-tools.ts';
import { authorizeConversationTools } from '../../src/dsh/policy.ts';
import { createConversationVision } from '../../src/dsh/vision.ts';
import { protocolResponse } from '../onelink/fixture.ts';
import { kernelRuntime, ScriptedModel, textResponse } from '../support/kernel-runtime.ts';
import type { ModelScript } from '../support/kernel-runtime.ts';
const contexts: Context[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(script: ModelScript[]) {
  const root = await mkdtemp(join(tmpdir(), 'mio-engine-'));
  roots.push(root);
  const model = new ScriptedModel(script);
  const ctx = await kernelRuntime(root, model);
  contexts.push(ctx);
  return {
    ctx,
    model,
    engine: createDshConversationEngine(ctx, {
      databaseURL: 'unused',
      provider: 'mio-test-only',
      model: 'scripted',
    }),
  };
}

it('drains a second active owner even while the first opening rejects during close', async () => {
  const { ctx, engine, model } = await setup(['hold']);
  await engine.create('held');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence);
  const spy = vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
    if (args[0] === 'absent' && args[1] === 'write') {
      entered.resolve();
      await release.promise;
    }
    return open(...args);
  });
  const missing = engine.run(
    'absent',
    'one',
    'missing',
    async () => {},
    () => {},
  );
  void missing.catch(() => {});
  await entered.promise;
  const held = engine.run(
    'held',
    'two',
    'hold',
    async () => {},
    () => {},
  );
  await vi.waitFor(() => expect(model.requests).toHaveLength(1));
  const closing = engine.close();
  void closing.catch(() => {});
  try {
    expect(await held).toBe('unknown');
    expect(ctx.agents.list()).toEqual([]);
    release.resolve();
    await expect(missing).rejects.toThrow();
    await expect(closing).rejects.toThrow('cleanup failed');
  } finally {
    release.resolve();
    spy.mockRestore();
  }
});

it('keeps textless cancellation visible in history after a later completed round', async () => {
  const entered = Promise.withResolvers<void>();
  const silent: ModelScript = async function* (options) {
    entered.resolve();
    await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(options.signal?.reason ?? new Error('aborted'));
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
  };
  const { engine } = await setup([silent, textResponse('next complete')]);
  await engine.create('history');
  const running = engine.run(
    'history',
    'cancelled',
    'no text yet',
    async () => {},
    () => {},
  );
  await entered.promise;
  await engine.cancel('history', 'cancelled');
  expect(await running).toBe('cancelled');
  expect(
    await engine.run(
      'history',
      'next',
      'explicit new request',
      async () => {},
      () => {},
    ),
  ).toBe('completed');
  const history = await engine.history('history', -1, 100);
  expect(history.items.filter((item) => item.role === 'status')).toMatchObject([
    { status: 'cancelled' },
    { status: 'completed' },
  ]);
  expect(history.items.filter((item) => item.role === 'assistant')).toHaveLength(1);
});

it('keeps budget denials monotonic across repeated guard checks, honors aborted signals, and validates projected output order', async () => {
  const { ctx } = await setup([]);
  let revoke: (() => void) | undefined;
  const handle = await ctx.mioKernel.create('guard-monotonic', {}, (agentCtx, agent) => {
    revoke = authorizeConversationTools(agentCtx, agent, {
      imageGeneration: true,
      imageInspection: false,
      videoGeneration: true,
    });
  });
  try {
    const makeExec = (
      id: string,
      name: string,
      signal = new AbortController().signal,
    ): ToolExecution =>
      Object.freeze({
        callId: ToolCallId(id),
        name,
        args: {},
        rawArguments: '{}',
        agent: handle.agent,
        signal,
      }) as unknown as ToolExecution;

    // 4 allowed submit_image_job calls remain idempotent when re-checked
    for (let idx = 1; idx <= 4; idx += 1) {
      const allowedExec = makeExec(`sub-${idx}`, 'submit_image_job');
      expect(ctx.tools.checkGuards(allowedExec)).toBeUndefined();
      expect(ctx.tools.checkGuards(allowedExec)).toBeUndefined();
    }

    // 5th submit_image_job must stay monotonically denied even if checkGuards is called twice on the same exec
    const fifthSubmit = makeExec('sub-5', 'submit_image_job');
    expect(ctx.tools.checkGuards(fifthSubmit)).toContain('MIO_TOOL_BUDGET_EXCEEDED');
    expect(ctx.tools.checkGuards(fifthSubmit)).toContain('MIO_TOOL_BUDGET_EXCEEDED');

    const videoSubmit = makeExec('video-sub-1', 'submit_video_job');
    expect(ctx.tools.checkGuards(videoSubmit)).toBeUndefined();
    expect(ctx.tools.checkGuards(videoSubmit)).toBeUndefined();
    const repeatedVideoSubmit = makeExec('video-sub-2', 'submit_video_job');
    expect(ctx.tools.checkGuards(repeatedVideoSubmit)).toContain('MIO_TOOL_BUDGET_EXCEEDED');
    expect(ctx.tools.checkGuards(repeatedVideoSubmit)).toContain('MIO_TOOL_BUDGET_EXCEEDED');

    // Aborted signal is denied on both root and agent guard layers
    const abortedController = new AbortController();
    abortedController.abort();
    expect(
      ctx.tools.checkGuards(
        makeExec('aborted-list', 'list_image_models', abortedController.signal),
      ),
    ).toContain('MIO_TOOL_DENIED');
  } finally {
    revoke?.();
    await handle.dispose();
  }

  const jobId = '11111111-1111-4111-8111-111111111111';
  const a1 = '22222222-2222-4222-8222-222222222222';
  const a2 = '33333333-3333-4333-8333-333333333333';
  expect(
    parseImageJobPresentationMeta({
      kind: 'mio.image-job',
      tool: 'get_image_job',
      job: {
        jobId,
        status: 'completed',
        requestedCount: 2,
        errorCode: null,
        assetIds: [a1, a2],
        outputs: [
          { index: 0, assetId: a1 },
          { index: 1, assetId: a2 },
        ],
      },
    }),
  ).not.toBeNull();

  // Reject non-increasing output indices or mismatched assetId ordering
  expect(
    parseImageJobPresentationMeta({
      kind: 'mio.image-job',
      tool: 'get_image_job',
      job: {
        jobId,
        status: 'completed',
        requestedCount: 2,
        errorCode: null,
        assetIds: [a1, a2],
        outputs: [
          { index: 1, assetId: a1 },
          { index: 0, assetId: a2 },
        ],
      },
    }),
  ).toBeNull();
  expect(
    parseImageJobPresentationMeta({
      kind: 'mio.image-job',
      tool: 'get_image_job',
      job: {
        jobId,
        status: 'completed',
        requestedCount: 2,
        errorCode: null,
        assetIds: [a1, a2],
        outputs: [
          { index: 0, assetId: a2 },
          { index: 1, assetId: a1 },
        ],
      },
    }),
  ).toBeNull();
});

it('injects a stable server-owned system prompt across legacy rounds without leaking into public history', async () => {
  const { ctx, engine, model } = await setup([
    textResponse('first reply'),
    textResponse('second reply'),
  ]);
  await engine.create('prompt-legacy');
  expect(
    await engine.run(
      'prompt-legacy',
      'req-1',
      '帮我构思一个赛博武侠漫剧主角人设',
      async () => {},
      () => {},
    ),
  ).toBe('completed');
  expect(
    await engine.run(
      'prompt-legacy',
      'req-2',
      '再细化第一集的开场分镜',
      async () => {},
      () => {},
    ),
  ).toBe('completed');

  const expected = buildConversationSystemPrompt({
    imageGeneration: false,
    imageInspection: false,
  });
  expect(model.requests).toHaveLength(2);
  for (const request of model.requests) {
    const systemMessages = request.messages.filter((message) => message.role === 'system');
    expect(systemMessages).toHaveLength(1);
    const systemText = systemMessages[0]!.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('');
    expect(systemText).toBe(expected);
    expect(systemText).toContain(MIIOO_ASSISTANT_NAME);
    expect(systemText).not.toMatch(/deepseek\s*harness/i);
  }
  const stored = await ctx.mioKernel.history('prompt-legacy');
  const systemEvents = stored.events.filter((event) => event.type === 'system/message');
  expect(systemEvents).toHaveLength(1);

  const publicHistory = await engine.history('prompt-legacy', -1, 100);
  expect(JSON.stringify(publicHistory)).not.toContain(MIIOO_ASSISTANT_NAME);
  expect(JSON.stringify(publicHistory)).not.toMatch(/deepseek\s*harness/i);
});

it('preserves literal {{...}} text with interpolate: false and keeps system prompt cooperative (not complete)', async () => {
  const { ctx, engine, model } = await setup([textResponse('ok')]);
  const observedInterpolate: (boolean | undefined)[] = [];
  ctx.systemPrompt.section({
    name: 'test:cooperative-suffix',
    order: 500,
    interpolate: false,
    text: 'COOPERATIVE_SUFFIX_MARKER',
  });
  ctx.on('system-prompt/assemble', (assembly, _context, next) => {
    const persona = assembly.sections.find((section) => section.name === PERSONA_PREFIX_SECTION);
    if (persona) {
      observedInterpolate.push(persona.interpolate);
      persona.text = `${persona.text}\nLITERAL_TEMPLATE={{unregistered_var}}`;
    }
    return next();
  });

  await engine.create('prompt-literal');
  expect(
    await engine.run(
      'prompt-literal',
      'req-literal',
      '测试字面量模板',
      async () => {},
      () => {},
    ),
  ).toBe('completed');

  expect(observedInterpolate).toEqual([false]);
  expect(model.requests).toHaveLength(1);
  const systemText = model.requests[0]!.messages.filter((message) => message.role === 'system')
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
  expect(systemText).toContain(MIIOO_ASSISTANT_NAME);
  expect(systemText).toContain('LITERAL_TEMPLATE={{unregistered_var}}');
  expect(systemText).toContain('COOPERATIVE_SUFFIX_MARKER');
});

it.each([
  {
    label: 'text-only openai-chat',
    anthropic: false,
    withImageTools: false,
    withVision: false,
    imageModality: false,
    expectedGeneration: false,
    expectedInspection: false,
  },
  {
    label: 'text-only anthropic-messages',
    anthropic: true,
    withImageTools: false,
    withVision: false,
    imageModality: false,
    expectedGeneration: false,
    expectedInspection: false,
  },
  {
    label: 'generation tools only',
    anthropic: false,
    withImageTools: true,
    withVision: false,
    imageModality: false,
    expectedGeneration: true,
    expectedInspection: false,
  },
  {
    label: 'vision without image modality stays disabled',
    anthropic: false,
    withImageTools: false,
    withVision: true,
    imageModality: false,
    expectedGeneration: false,
    expectedInspection: false,
  },
  {
    label: 'vision with image modality only',
    anthropic: false,
    withImageTools: false,
    withVision: true,
    imageModality: true,
    expectedGeneration: false,
    expectedInspection: true,
  },
  {
    label: 'both generation and inspection tools enabled',
    anthropic: true,
    withImageTools: true,
    withVision: true,
    imageModality: true,
    expectedGeneration: true,
    expectedInspection: true,
  },
])('delivers capability-accurate stable system prompt in BYOK mode ($label)', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'mio-engine-byok-prompt-'));
  roots.push(root);
  const ctx = await kernelRuntime(root, new ScriptedModel([]));
  contexts.push(ctx);

  const outboundBodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    outboundBodies.push((await request.clone().json()) as Record<string, unknown>);
    return protocolResponse(request, `reply ${outboundBodies.length}`);
  });

  const dummyImageTools: ConversationImageTools = {
    listModels: async () => [],
    createImage: async () => {
      throw new Error('unused');
    },
    getImage: async () => {
      throw new Error('unused');
    },
  };
  const dummyVision = createConversationVision(async () => {
    throw new Error('unused');
  });
  const engine = createDshConversationEngine(
    ctx,
    { databaseURL: 'unused', byok: true },
    scenario.withImageTools ? dummyImageTools : undefined,
    scenario.withVision ? dummyVision : undefined,
  );
  const selected = {
    providerConfigId: 'cfg-prompt',
    providerRevision: 1,
    credentialVersion: 1,
    modelKey: 'key-prompt',
    catalogVersion: 1,
    adaptationVersion: 1,
    operation: 'chat' as const,
    profile: scenario.anthropic ? ('anthropic-messages' as const) : ('openai-chat' as const),
    modelRef: 'onelink:chat:prompt-test',
    modelId: 'prompt-test-model',
    protocol: scenario.anthropic ? ('anthropic-messages' as const) : ('openai-chat' as const),
    capabilityVersion: 'onelink-text-v1',
    apiKey: 'synthetic-key',
    inputModalities: scenario.imageModality
      ? (['text', 'image'] as ('text' | 'image')[])
      : (['text'] as ('text' | 'image')[]),
  };
  const makeBinding = (requestId: string): ConversationRun => ({
    userId: 'owner',
    conversationId: 'conv-prompt',
    dshSessionId: 'byok-prompt-session',
    requestId,
    snapshot: selected,
    observe: async () => {},
  });

  await engine.create('byok-prompt-session', selected);
  expect(
    await engine.run(
      'byok-prompt-session',
      'req-1',
      '帮我设计一个古风漫剧场景',
      async () => {},
      () => {},
      makeBinding('req-1'),
    ),
  ).toBe('completed');
  expect(
    await engine.run(
      'byok-prompt-session',
      'req-2',
      '补充镜头构图建议',
      async () => {},
      () => {},
      makeBinding('req-2'),
    ),
  ).toBe('completed');

  const expected = buildConversationSystemPrompt({
    imageGeneration: scenario.expectedGeneration,
    imageInspection: scenario.expectedInspection,
  });
  expect(outboundBodies).toHaveLength(2);
  for (const body of outboundBodies) {
    const systemText = scenario.anthropic
      ? Array.isArray(body.system)
        ? body.system
            .map((entry) =>
              typeof entry === 'object' && entry && 'text' in entry
                ? String((entry as { text: unknown }).text)
                : '',
            )
            .join('')
        : String(body.system ?? '')
      : String(
          (body.messages as { role: string; content: unknown }[]).find(
            (message) => message.role === 'system',
          )?.content ?? '',
        );
    expect(systemText).toBe(expected);
    expect(systemText).toContain(MIIOO_ASSISTANT_NAME);
    expect(systemText).not.toMatch(/deepseek\s*harness/i);
  }
  const stored = await ctx.mioKernel.history('byok-prompt-session');
  expect(stored.events.filter((event) => event.type === 'system/message')).toHaveLength(1);
});
