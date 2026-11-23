import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { afterEach, expect, it, vi } from 'vitest';
import { compactionThreshold } from '../../src/conversations/compaction.ts';
import type { ConversationEvent } from '../../src/conversations/contracts.ts';
import { buildConversationSystemPrompt } from '../../src/conversations/prompt.ts';
import { applyConversationPolicies } from '../../src/dsh/conversation-checkpoints.ts';
import { PROJECT_CONTEXT_SOURCE } from '../../src/dsh/conversation-context.ts';
import { installConversationTitles } from '../../src/dsh/conversation-titles.ts';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import type { ChatProfile, ChatRuntimeSnapshot } from '../../src/providers/contracts.ts';
import { kernelRuntime, ScriptedModel, textResponse } from '../support/kernel-runtime.ts';
import { protocolResponse } from './fixture.ts';

const id = 'm4-context-test';
const oldAsset = '1290e421-cbd2-4b64-8351-2303567c25dd';
const newAsset = 'c7e0a061-0ad8-417a-8ce9-d6b426187e6e';
const oldSnapshot = JSON.stringify({
  summary: 'OLD_PROJECT_ONLY',
  worldbuilding: `assetId=${oldAsset}`,
});
const newSnapshot = JSON.stringify({
  summary: 'CURRENT_PROJECT_ONLY {{literal}}',
  worldbuilding: `assetId=${newAsset}`,
});
const noOp = async () => {};
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  try {
    for (const clean of cleanups.splice(0).reverse()) await clean();
  } finally {
    vi.unstubAllGlobals();
  }
});

async function tempHome() {
  const root = await mkdtemp(join(tmpdir(), 'mio-m4-context-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

interface WireCall {
  native: GenerateOptions;
  wire: string;
  body: { messages: { role: string; content: unknown }[]; system?: { text: string }[] };
}

async function setup(profile: ChatProfile = 'openai-chat') {
  const root = await tempHome();
  const route: ChatRuntimeSnapshot = {
    providerConfigId: 'fixture-provider',
    providerRevision: 1,
    credentialVersion: 1,
    modelKey: 'fixture-model',
    catalogVersion: 1,
    adaptationVersion: 1,
    operation: 'chat',
    profile,
    modelRef: 'onelink:chat:fixture-model',
    modelId: 'fixture-model',
    protocol: profile,
    capabilityVersion: 'fixture-v1',
    apiKey: 'synthetic-only',
    contextWindow: 32_768,
    maxOutputTokens: 128,
  };
  const calls: WireCall[] = [];
  const events: ConversationEvent[] = [];
  let current: GenerateOptions | undefined;
  let overflowNext = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe('https://api.onelinkai.cloud');
    expect(url.pathname).toBe(profile === 'openai-chat' ? '/v1/chat/completions' : '/v1/messages');
    if (!current) throw new Error('Native call is missing');
    const wire = await request.text();
    calls.push({ native: current, wire, body: JSON.parse(wire) });
    if (current.purpose === 'compaction') return protocolResponse(request, '早期设定已整理。');
    if (overflowNext) {
      overflowNext = false;
      return Response.json(
        { error: { code: 'context_length_exceeded', message: 'prompt is too long' } },
        { status: 400 },
      );
    }
    return protocolResponse(request, '公开回复');
  });

  const open = async () => {
    const ctx = await kernelRuntime(root, new ScriptedModel([]));
    cleanups.push(() => ctx.fiber.dispose());
    await ctx.plugin(TokenMeter);
    await ctx.plugin({
      name: 'm4-checkpoint-policies',
      inject: ['mioKernel', 'sessions', 'tools'],
      apply: applyConversationPolicies,
    });
    ctx.on('llm/stream', (options, next) => {
      if (options.sessionId === id) current = options;
      return next();
    });
    const engine = createDshConversationEngine(ctx, { databaseURL: 'unused', byok: true });
    cleanups.push(() => engine.close());
    return { engine, ctx };
  };
  let live = await open();
  await live.engine.create(id, route);

  return {
    calls,
    events,
    route,
    async restart() {
      await live.engine.close();
      await live.ctx.fiber.dispose();
      live = await open();
    },
    overflowNext: () => {
      overflowNext = true;
    },
    run: (requestId: string, text: string, context?: string, snapshot = route) =>
      live.engine.run(
        id,
        requestId,
        text,
        noOp,
        (event) => events.push(event),
        {
          userId: 'owner',
          conversationId: 'conversation',
          dshSessionId: id,
          requestId,
          snapshot,
          observe: noOp,
        },
        undefined,
        undefined,
        undefined,
        { purpose: 'drama-script', ...(context === undefined ? {} : { projectContext: context }) },
      ),
    raw: () => live.ctx.mioKernel.history(id).then(({ events }) => events),
    history: () => live.engine.history(id, -1, 100),
    usage: () => live.engine.contextUsage!(id),
  };
}

const privateMessages = (call: WireCall) =>
  call.native.messages.filter((message) => message.source?.kind === PROJECT_CONTEXT_SOURCE);

it.each(['openai-chat', 'anthropic-messages'] as const)(
  'reuses one private slot across cold %s turns and keeps the system bytes stable',
  async (profile) => {
    const fixture = await setup(profile);
    expect(await fixture.run('first', '第一条真实输入', oldSnapshot)).toBe('completed');
    await fixture.restart();
    expect(await fixture.run('updated', '更新后继续', newSnapshot)).toBe('completed');
    expect(await fixture.run('same', '沿用当前设定', newSnapshot)).toBe('completed');
    expect(await fixture.run('cleared', '没有项目快照', undefined)).toBe('completed');
    expect(await fixture.run('still-cleared', '仍无快照', undefined)).toBe('completed');
    expect(await fixture.run('restored', '重新提供项目快照', newSnapshot)).toBe('completed');
    expect(fixture.calls).toHaveLength(6);
    const expected = buildConversationSystemPrompt({}, 'drama-script');
    const system = (call: WireCall) =>
      profile === 'openai-chat' ? call.body.messages[0]?.content : call.body.system?.[0]?.text;
    expect(fixture.calls.map(system)).toEqual(Array(6).fill(expected));
    const first = fixture.calls[0]!;
    expect(privateMessages(first)).toHaveLength(1);
    expect(first.wire).toContain('OLD_PROJECT_ONLY');
    expect(first.wire.indexOf('OLD_PROJECT_ONLY')).toBeLessThan(
      first.wire.indexOf('第一条真实输入'),
    );
    expect(
      JSON.stringify(first.body.messages.filter(({ role }) => role === 'user').at(-1)),
    ).toContain('第一条真实输入');
    for (const call of fixture.calls.slice(1)) {
      expect(call.wire).not.toContain('OLD_PROJECT_ONLY');
      expect(privateMessages(call)).toHaveLength(1);
    }
    expect(fixture.calls[1]!.wire).toContain('CURRENT_PROJECT_ONLY {{literal}}');
    expect(privateMessages(fixture.calls[1]!)[0]?.id).toBe(
      privateMessages(fixture.calls[2]!)[0]?.id,
    );
    expect(privateMessages(fixture.calls[3]!)[0]?.id).toBe(
      privateMessages(fixture.calls[4]!)[0]?.id,
    );
    expect(fixture.calls[3]!.wire).not.toContain('CURRENT_PROJECT_ONLY');
    expect(fixture.calls[4]!.wire).not.toContain('CURRENT_PROJECT_ONLY');
    expect(fixture.calls[5]!.wire).toContain('CURRENT_PROJECT_ONLY');
    const raw = await fixture.raw();
    const snapshots = raw.filter(
      (event) => event.type === 'user/message' && event.data.source.kind === PROJECT_CONTEXT_SOURCE,
    );
    expect(snapshots).toHaveLength(4);
    expect(snapshots[0]!.surfaceOp).toBe('append');
    expect(snapshots.slice(1).map((event) => event.surfaceOp)).toEqual(
      snapshots.slice(0, -1).map(({ seq }) => ({ op: 'replace', startSeq: seq, endSeq: seq })),
    );
    expect(JSON.stringify(raw)).toContain(oldAsset);
    expect(
      (await fixture.history()).items.flatMap((item) => (item.role === 'user' ? [item.text] : [])),
    ).toEqual([
      '第一条真实输入',
      '更新后继续',
      '沿用当前设定',
      '没有项目快照',
      '仍无快照',
      '重新提供项目快照',
    ]);
    expect(JSON.stringify(fixture.events)).not.toMatch(
      /OLD_PROJECT_ONLY|CURRENT_PROJECT_ONLY|项目上下文快照/,
    );
  },
);

it('charges a pending project snapshot to pressure and skips a nonshrinkable input on both paths', async () => {
  const fixture = await setup();
  for (let index = 0; index < 5; index++) {
    expect(await fixture.run(`seed-${index}`, `用户设定 ${index} ${'古镇夜影'.repeat(220)}`)).toBe(
      'completed',
    );
  }
  const before = (await fixture.usage()).estimatedTokens;
  const window = Math.ceil((before + 256) * 1.25);
  const route = { ...fixture.route, contextWindow: window };
  expect(compactionThreshold(window, route.maxOutputTokens!)).toBeGreaterThan(before + 20);
  const longProject = JSON.stringify({ summary: 'PENDING_CONTEXT_ONLY ' + '山'.repeat(2200) });
  const start = fixture.calls.length;
  expect(await fixture.run('pressure', '继续', longProject, route)).toBe('completed');
  const [summary, message] = fixture.calls.slice(start);
  expect(fixture.calls.slice(start).map((call) => call.native.purpose)).toEqual([
    'compaction',
    undefined,
  ]);
  expect(summary!.wire).not.toContain('PENDING_CONTEXT_ONLY');
  expect(message!.wire).toContain('PENDING_CONTEXT_ONLY');
  expect(privateMessages(message!)).toHaveLength(1);

  fixture.overflowNext();
  const longInput = '海'.repeat(3600);
  const indivisibleProject = JSON.stringify({ summary: 'INDIVISIBLE ' + '星'.repeat(3750) });
  const smallRoute = { ...route, contextWindow: 1800 };
  const beforeOverflow = fixture.calls.length;
  expect(await fixture.run('indivisible', longInput, indivisibleProject, smallRoute)).toEqual({
    status: 'failed',
    error: 'MODEL_CONTEXT_OVERFLOW',
  });
  expect(fixture.calls.slice(beforeOverflow).map((call) => call.native.purpose)).toEqual([
    undefined,
  ]);
  expect(fixture.calls.at(-1)!.wire).toContain('INDIVISIBLE');
});

it.each(['existing', 'first'] as const)(
  'restores the same frozen %s slot once when M3 overflow compacts its position',
  async (slot) => {
    const fixture = await setup();
    const seedTurns = slot === 'existing' ? 6 : 1;
    for (let index = 0; index < seedTurns; index++) {
      const snapshot = slot === 'first' ? undefined : index === 0 ? oldSnapshot : newSnapshot;
      expect(
        await fixture.run(
          `history-${index}`,
          `真实创作 ${index} ${'纸灯湖岸'.repeat(180)}`,
          snapshot,
        ),
      ).toBe('completed');
    }
    const start = fixture.calls.length;
    fixture.overflowNext();
    expect(await fixture.run('overflow', '继续写当前设定', newSnapshot)).toBe('completed');
    const attempts = fixture.calls.slice(start);
    expect(attempts.map((call) => call.native.purpose)).toEqual([
      undefined,
      'compaction',
      undefined,
    ]);
    const [initial, summary, replayed] = attempts;
    expect(initial!.wire).toContain('CURRENT_PROJECT_ONLY');
    expect(summary!.wire).toContain('真实创作');
    expect(summary!.wire).not.toMatch(/OLD_PROJECT_ONLY|CURRENT_PROJECT_ONLY/);
    expect(summary!.wire).not.toContain(oldAsset);
    expect(summary!.wire).not.toContain(newAsset);
    expect(replayed!.wire).toContain('CURRENT_PROJECT_ONLY');
    expect(replayed!.wire).not.toContain('OLD_PROJECT_ONLY');
    expect(privateMessages(replayed!)).toHaveLength(1);
    expect(privateMessages(replayed!)[0]?.id).not.toBe(privateMessages(initial!)[0]?.id);
    const raw = await fixture.raw();
    const shadowedProject = raw.find(
      (event) =>
        event.type === 'user/message' && event.data.id === privateMessages(initial!)[0]?.id,
    );
    expect(shadowedProject).toBeDefined();
    expect(raw.find((event) => event.type === 'compaction/summary')?.data).toMatchObject({
      shadowedSeqs: expect.arrayContaining([shadowedProject!.seq]),
    });
    await fixture.restart();
    expect(await fixture.run('cold', '冷启后续写', undefined)).toBe('completed');
    expect(fixture.calls.at(-1)!.wire).not.toMatch(/OLD_PROJECT_ONLY|CURRENT_PROJECT_ONLY/);
  },
);

it('keeps the legacy user inbox acknowledgement, title admission and cancellation independent of private context', async () => {
  const model = new ScriptedModel([textResponse('公开回复')]);
  const ctx = await kernelRuntime(await tempHome(), model);
  cleanups.push(() => ctx.fiber.dispose());
  await ctx.inject(['sessions', 'sessionProjections', 'agents'], async (titleCtx) => {
    await installConversationTitles(titleCtx);
  });
  const engine = createDshConversationEngine(ctx, {
    databaseURL: 'unused',
    provider: 'mio-test-only',
    model: 'scripted',
  });
  cleanups.push(() => engine.close());
  await engine.create(id);
  const inbox = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const gate = ctx.on('agent/pre-step', async ({ signal }, next) => {
    await release.promise;
    signal.throwIfAborted();
    return next();
  });
  const admitted = vi.fn(noOp);
  const run = engine.run(
    id,
    'cancel',
    '只有用户输入入队',
    async () => inbox.resolve(),
    () => {},
    undefined,
    undefined,
    admitted,
    undefined,
    { purpose: 'drama-script', projectContext: oldSnapshot },
  );
  try {
    await inbox.promise;
    const logged = JSON.stringify((await ctx.mioKernel.history(id)).events);
    expect(logged).toContain('只有用户输入入队');
    expect(logged).not.toContain('OLD_PROJECT_ONLY');
    const cancelling = engine.cancel(id, 'cancel');
    release.resolve();
    await cancelling;
    expect(await run).toBe('cancelled');
  } finally {
    gate();
    release.resolve();
    await run;
  }
  expect(admitted).not.toHaveBeenCalled();
  expect(model.requests).toHaveLength(0);
  expect(
    await engine.run(
      id,
      'continue',
      '真实标题',
      noOp,
      () => {},
      undefined,
      undefined,
      admitted,
      undefined,
      { purpose: 'drama-script', projectContext: newSnapshot },
    ),
  ).toBe('completed');
  expect(admitted).toHaveBeenCalledExactlyOnceWith(expect.any(Number), '真实标题');
  expect(JSON.stringify(model.requests[0]!.messages)).toContain('CURRENT_PROJECT_ONLY');
  expect(JSON.stringify(model.requests[0]!.messages)).not.toContain('OLD_PROJECT_ONLY');
});
