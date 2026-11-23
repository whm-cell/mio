import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
import { afterEach, expect, it, vi } from 'vitest';
import { installConversationTitles } from '../../src/dsh/conversation-titles.ts';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import { kernelRuntime, ScriptedModel, textResponse } from '../support/kernel-runtime.ts';
import type { ModelScript } from '../support/kernel-runtime.ts';

const contexts: Context[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(script: ModelScript[], existingRoot?: string) {
  const root = existingRoot ?? (await mkdtemp(join(tmpdir(), 'mio-title-')));
  if (!existingRoot) roots.push(root);
  const model = new ScriptedModel(script);
  const ctx = await kernelRuntime(root, model);
  contexts.push(ctx);
  await ctx.inject(['sessions', 'sessionProjections', 'agents'], async (titleCtx) => {
    await installConversationTitles(titleCtx);
  });
  const engine = createDshConversationEngine(ctx, {
    databaseURL: 'unused',
    provider: 'mio-test-only',
    model: 'scripted',
  });
  return { root, ctx, model, engine };
}

async function diskEvents(ctx: Context, id: string) {
  const reader = await ctx.sessionPersistence.open(SessionId(id), 'read');
  try {
    return (await reader.read(0)).events;
  } finally {
    await reader.close();
  }
}

const ignore = async () => {};

it('keeps the inbox receipt while pre-step waits and copies the first durably admitted human title', async () => {
  const { ctx, engine, model } = await setup([textResponse('reply')]);
  const id = 'input-and-title';
  await engine.create(id);
  const synthetic = createUserMessage({
    content: [{ type: 'text', text: 'synthetic lookup should never become the title' }],
    source: { kind: 'tool', callId: ToolCallId('synthetic-lookup') },
  });

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const inbox = Promise.withResolvers<void>();
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent.id !== id) return next();
    entered.resolve();
    await release.promise;
    const decision = await next();
    return decision.kind === 'enter'
      ? { ...decision, messages: [synthetic, ...decision.messages] }
      : decision;
  });
  const expectedTitle = 'one two three four five six seven eight nine ten eleven twelve';
  const admitted = vi.fn(async (time: number, title?: string) => {
    const events = await diskEvents(ctx, id);
    const human = events.find(
      (event) => event.type === 'user/message' && event.data.source.kind === 'user',
    );
    const tool = events.find(
      (event) => event.type === 'user/message' && event.data.source.kind === 'tool',
    );
    expect(human).toBeDefined();
    expect(tool?.seq).toBeLessThan(human!.seq);
    expect(time).toBe(human?.time);
    expect(title).toBe(expectedTitle);
    expect(foldSessionTitle(events)).toMatchObject({
      source: { kind: 'fallback' },
      messageSeqs: [human?.seq],
      title: expectedTitle,
    });
  });
  const turn = engine.run(
    id,
    'first',
    '  one\n\ttwo three four five six seven eight nine ten eleven twelve thirteen  ',
    async () => inbox.resolve(),
    () => {},
    undefined,
    undefined,
    admitted,
  );
  try {
    await Promise.all([entered.promise, inbox.promise]);
    const events = await diskEvents(ctx, id);
    expect(events.some((event) => event.type === 'agent/inbox/spliced')).toBe(true);
    expect(events.some((event) => event.type === 'user/message')).toBe(false);
    expect(foldSessionTitle(events)).toBeUndefined();
    expect(admitted).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(0);
  } finally {
    release.resolve();
    await turn;
  }
  expect(await turn).toBe('completed');
  expect(admitted).toHaveBeenCalledExactlyOnceWith(expect.any(Number), expectedTitle);
  expect(model.requests).toHaveLength(1);
  expect(model.requests[0]!.messages.flatMap((message) => message.content)).not.toContainEqual({
    type: 'text',
    text: expectedTitle,
  });
});

it('leaves title admission untouched when a queued user message fails pre-step', async () => {
  const { ctx, engine, model } = await setup([]);
  const id = 'input-blocked';
  await engine.create(id);
  ctx.on('agent/pre-step', async () => {
    throw new Error('fixture pre-step rejection');
  });
  const durable = vi.fn(ignore);
  const admitted = vi.fn(ignore);
  expect(
    await engine.run(
      id,
      'blocked',
      'queued text only',
      durable,
      () => {},
      undefined,
      undefined,
      admitted,
    ),
  ).toBe('failed');
  expect(durable).toHaveBeenCalledOnce();
  expect(admitted).not.toHaveBeenCalled();
  expect(model.requests).toHaveLength(0);
  const events = await diskEvents(ctx, id);
  expect(events.some((event) => event.type === 'user/message')).toBe(false);
  expect(foldSessionTitle(events)).toBeUndefined();
});

it('reuses the same byte-bounded native fallback after a failed admission write and cold reopen', async () => {
  const first = await setup([textResponse('first answer')]);
  const id = 'durable-first-title';
  await first.engine.create(id);
  const original = '\uD800' + '字'.repeat(31) + '😀 trailing';
  const expectedTitle = '\uFFFD' + '字'.repeat(31);
  const fail = vi.fn(async () => {
    throw new Error('fixture PG activity write failure');
  });
  await expect(
    first.engine.run(id, 'first', original, ignore, () => {}, undefined, undefined, fail),
  ).rejects.toThrow('fixture PG activity write failure');
  await first.engine.close();
  await first.ctx.fiber.dispose();
  expect(fail).toHaveBeenCalledExactlyOnceWith(expect.any(Number), expectedTitle);
  expect(Buffer.byteLength(expectedTitle, 'utf8')).toBe(96);

  const second = await setup([textResponse('second answer')], first.root);
  const admitted = vi.fn(ignore);
  expect(second.model.requests).toHaveLength(0);
  expect((await second.engine.history(id, -1, 10)).items).toContainEqual(
    expect.objectContaining({ role: 'user', text: original }),
  );
  expect(
    await second.engine.run(
      id,
      'second',
      'different prompt',
      ignore,
      () => {},
      undefined,
      undefined,
      admitted,
    ),
  ).toBe('completed');
  expect(admitted).toHaveBeenCalledExactlyOnceWith(expect.any(Number), expectedTitle);
  const events = await diskEvents(second.ctx, id);
  expect(events.filter((event) => event.type === 'session/title')).toHaveLength(1);
  expect(foldSessionTitle(events)?.title.toWellFormed()).toBe(expectedTitle);
  expect(first.model.requests).toHaveLength(1);
  expect(second.model.requests).toHaveLength(1);
});

it('renames a cold session after abrupt exit without replaying its old inbox or changing history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mio-title-interrupted-'));
  roots.push(root);
  const child = fork(resolve('tests/foundation/kernel-crash.ts'), [root], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit');
  try {
    const [ready] = await Promise.race([once(child, 'message'), exited]);
    expect(ready).toEqual({ ready: true });
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await exited).toEqual([null, 'SIGKILL']);
    const { ctx, engine, model } = await setup([], root);
    const history = await engine.history('hard-stop', -1, 10);
    expect(history.items).toMatchObject([
      { role: 'user', text: 'interrupted input' },
      { role: 'status', status: 'interrupted' },
    ]);
    await expect(engine.rename('hard-stop', 'Saved title')).resolves.toBe('Saved title');
    expect(await engine.history('hard-stop', -1, 10)).toEqual(history);
    const events = await diskEvents(ctx, 'hard-stop');
    expect(foldSessionTitle(events)).toMatchObject({
      title: 'Saved title',
      source: { kind: 'user' },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent/inbox/spliced',
        data: expect.objectContaining({ outcome: 'canceled' }),
      }),
    );
    expect(model.requests).toHaveLength(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
});

it('renames an active turn without waiting for the admission write and persists a manual pin', async () => {
  const { ctx, engine, model } = await setup(['hold', textResponse('next')]);
  const id = 'busy-title';
  await engine.create(id);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const admitted = vi.fn(async () => {
    entered.resolve();
    await release.promise;
  });
  const turn = engine.run(
    id,
    'first',
    'automatic title',
    ignore,
    () => {},
    undefined,
    undefined,
    admitted,
  );
  try {
    await entered.promise;
    expect(admitted).toHaveBeenCalledExactlyOnceWith(expect.any(Number), 'automatic title');
    await expect(engine.rename(id, '  Manual\n\u001b[31m  标题  ')).resolves.toBe('Manual 标题');
    expect(foldSessionTitle(await diskEvents(ctx, id))).toMatchObject({
      title: 'Manual 标题',
      source: { kind: 'user' },
    });
  } finally {
    release.resolve();
    await engine.cancel(id, 'first');
    await turn;
  }
  expect(await turn).toBe('cancelled');
  const second = vi.fn(ignore);
  expect(
    await engine.run(
      id,
      'next',
      'second title candidate',
      ignore,
      () => {},
      undefined,
      undefined,
      second,
    ),
  ).toBe('completed');
  expect(second).toHaveBeenCalledExactlyOnceWith(expect.any(Number), undefined);
  const events = await diskEvents(ctx, id);
  expect(foldSessionTitle(events)).toMatchObject({
    source: { kind: 'user' },
    title: 'Manual 标题',
  });
  expect(events.filter((event) => event.type === 'session/title')).toHaveLength(2);
  expect(model.requests).toHaveLength(2);
});

it('queues a run behind a cold rename and makes an identical retry safe', async () => {
  const { ctx, engine, model } = await setup([textResponse('reply')]);
  const id = 'cold-title';
  await engine.create(id);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const disposing = Promise.withResolvers<void>();
  const releaseDispose = Promise.withResolvers<void>();
  const native = ctx.mioKernel.resume.bind(ctx.mioKernel);
  const resume = vi
    .spyOn(ctx.mioKernel, 'resume')
    .mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return native(...args);
    })
    .mockImplementationOnce(async (...args) => {
      const handle = await native(...args);
      return {
        agent: handle.agent,
        async dispose() {
          disposing.resolve();
          await releaseDispose.promise;
          await handle.dispose();
        },
      };
    });
  await expect(engine.rename(id, '\u200B\u001b[31m\t')).rejects.toMatchObject({
    code: 'BODY_INVALID',
  });
  expect(resume).not.toHaveBeenCalled();

  const title = '字'.repeat(40);
  const rename = engine.rename(id, title);
  await entered.promise;
  const admitted = vi.fn(ignore);
  const turn = engine.run(
    id,
    'first',
    'other title',
    ignore,
    () => {},
    undefined,
    undefined,
    admitted,
  );
  let retry: Promise<string> | undefined;
  try {
    expect(resume).toHaveBeenCalledOnce();
    expect(model.requests).toHaveLength(0);
    release.resolve();
    await Promise.race([disposing.promise, turn]);
    retry = engine.rename(id, title);
    // A cold rename queued behind disposal must not ask the kernel for a writer yet.
    await Promise.resolve();
    expect(resume).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
    releaseDispose.resolve();
    await Promise.all([rename, turn, retry]);
    resume.mockRestore();
  }
  expect(await rename).toBe(title);
  expect(await turn).toBe('completed');
  expect(admitted).toHaveBeenCalledExactlyOnceWith(expect.any(Number), undefined);
  expect(await retry).toBe(title);
  const events = await diskEvents(ctx, id);
  expect(events.filter((event) => event.type === 'session/title')).toHaveLength(1);
  expect(foldSessionTitle(events)?.title).toBe(title);
  expect(model.requests).toHaveLength(1);
});
