import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { afterEach, expect, it, vi } from 'vitest';
import {
  applyConversationPolicies,
  CHECKPOINT_INTERRUPTED,
} from '../../src/dsh/conversation-checkpoints.ts';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import {
  kernelRuntime,
  modelOptions,
  ScriptedModel,
  textResponse,
  toolResponse,
} from '../support/kernel-runtime.ts';
import type { ModelScript } from '../support/kernel-runtime.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const source = 'mio-source';
const invalid = { code: 'CONVERSATION_FORK_BOUNDARY_INVALID', status: 409 };
const input = (text: string) =>
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const pastTurnEnds = (events: readonly SessionEvent[]) =>
  events.filter((event) => event.type === 'turn/end');

async function setup(script: ModelScript[]) {
  const root = await mkdtemp(join(tmpdir(), 'mio-m6-boundaries-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const model = new ScriptedModel(script);
  const ctx = await kernelRuntime(root, model);
  cleanup.push(() => ctx.fiber.dispose());
  const engine = createDshConversationEngine(ctx, { databaseURL: 'unused', ...modelOptions });
  cleanup.push(() => engine.close());
  await engine.create(source);
  return {
    ctx,
    engine,
    model,
    run: (requestId: string) =>
      engine.run(
        source,
        requestId,
        requestId,
        async () => {},
        () => {},
      ),
  };
}

it('selects only the durable turn end while a newer turn end is live before flush', async () => {
  const { ctx, engine, run } = await setup([textResponse('first'), textResponse('second')]);
  await expect(engine.resolveForkBoundary!(source)).rejects.toMatchObject(invalid);
  expect(await run('first')).toBe('completed');
  const first = await engine.resolveForkBoundary!(source);
  const live = await ctx.mioKernel.resume(source, modelOptions);
  let sourceFlushes = 0;
  ctx.on('session/flush', (session) => {
    if (session.id === source) sourceFlushes++;
  });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    live.agent.followup(input('unflushed second'));
    await live.agent.whenIdle();
    const end = pastTurnEnds(live.agent.session.snapshotEvents()).at(-1)!;
    expect(end.data.reason.kind).toBe('completed');
    expect(end.seq).toBeGreaterThan(first);
    expect(await engine.resolveForkBoundary!(source)).toBe(first);
    await expect(engine.resolveForkBoundary!(source, end.seq)).rejects.toMatchObject(invalid);
    await engine.fork!(source, 'durable-first', first);
    expect(sourceFlushes).toBe(0);
    expect(await engine.resolveForkBoundary!(source)).toBe(first);
    await ctx.mioKernel.flush(live.agent.session);
    expect(await engine.resolveForkBoundary!(source)).toBe(end.seq);
  } finally {
    vi.useRealTimers();
    await live.dispose();
  }
});

it('retains real cancellation and failure boundaries with an open tool tail, including after recovery', async () => {
  const cancelStarted = Promise.withResolvers<void>();
  const { ctx, engine, model, run } = await setup([
    async function* (options) {
      const aborted = new Promise<never>((_resolve, reject) => {
        const fail = () => reject(options.signal?.reason);
        if (options.signal?.aborted) fail();
        else options.signal?.addEventListener('abort', fail, { once: true });
      });
      cancelStarted.resolve();
      await aborted;
    },
    [
      {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'FIXTURE', message: 'fixture failure' } },
      },
    ],
    toolResponse(),
    textResponse('tool looked up'),
  ]);
  const execute = vi.fn(async () => 'counted');
  ctx.tools.register(
    defineTool({
      name: 'counted_fixture',
      description: 'Count a test-only tool body',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute,
    }),
  );
  const cancelling = run('cancel-me');
  await cancelStarted.promise;
  await engine.cancel(source, 'cancel-me');
  expect(await cancelling).toBe('cancelled');
  const cancelled = await engine.resolveForkBoundary!(source);
  expect(await run('fail-me')).toBe('failed');
  const failed = await engine.resolveForkBoundary!(source);
  expect(failed).toBeGreaterThan(cancelled);
  expect(await run('tool-step')).toBe('completed');
  expect(execute).not.toHaveBeenCalled();

  const { events } = await ctx.mioKernel.readPersistedHistory(source);
  const call = events.find((event) => event.type === 'tool/call')!;
  expect(call.seq).toBeGreaterThan(failed);
  const interrupted = 'interrupted-tool';
  const writer = await ctx.sessionPersistence.create(Session.create(SessionId(interrupted)).header);
  try {
    await writer.append(events.slice(0, call.seq + 1));
  } finally {
    await writer.close();
  }
  const physicalBefore = await ctx.mioKernel.readPersistedHistory(interrupted);
  expect(physicalBefore.events.at(-1)).toEqual(call);
  const cold = await ctx.mioKernel.history(interrupted);
  const coldEnd = pastTurnEnds(cold.events).at(-1)!;
  expect(coldEnd.data.reason.kind).toBe('interrupted');
  expect(cold.events.slice(call.seq + 1).map((event) => event.type)).toEqual([
    'tool/result',
    'step/end',
    'turn/end',
  ]);
  await expect(engine.resolveForkBoundary!(interrupted, call.seq)).rejects.toMatchObject(invalid);
  await expect(engine.resolveForkBoundary!(interrupted, coldEnd.seq)).rejects.toMatchObject(
    invalid,
  );
  expect(await engine.resolveForkBoundary!(interrupted)).toBe(failed);
  await engine.fork!(interrupted, 'previously-settled', failed);
  expect(await ctx.mioKernel.readPersistedHistory(interrupted)).toEqual(physicalBefore);

  const reopened = await ctx.mioKernel.resume(interrupted, {});
  await reopened.dispose();
  const physicalAfter = await ctx.mioKernel.readPersistedHistory(interrupted);
  expect(physicalAfter.events[coldEnd.seq]).toEqual(coldEnd);
  expect(physicalAfter.events.at(-1)).toMatchObject({ type: 'session/end-seed', data: {} });
  await expect(engine.resolveForkBoundary!(interrupted, coldEnd.seq)).rejects.toMatchObject(
    invalid,
  );
  expect(await engine.resolveForkBoundary!(interrupted)).toBe(failed);
  expect(await engine.resolveForkBoundary!(interrupted, cancelled)).toBe(cancelled);
  expect(model.requests).toHaveLength(4);
  expect(execute).not.toHaveBeenCalled();
});

it('skips a physically closed turn whose M1 checkpoint left the request outcome unknown', async () => {
  const { ctx, engine, model, run } = await setup([textResponse('settled')]);
  await ctx.plugin({
    name: 'm6-checkpoint-policies',
    inject: ['mioKernel', 'sessions', 'tools'],
    apply: applyConversationPolicies,
  });
  expect(await run('already-settled')).toBe('completed');
  const valid = await engine.resolveForkBoundary!(source);
  let rejectNextFlush = false;
  ctx.on('session/event', (session, event) => {
    if (session.id === source && event.type === 'request/header') rejectNextFlush = true;
  });
  ctx.on('session/flush', (session) => {
    if (session.id !== source || !rejectNextFlush) return;
    rejectNextFlush = false;
    throw new Error('fixture checkpoint rejection');
  });

  expect(await run('checkpoint-failed')).toBe('unknown');
  const { events } = await ctx.mioKernel.readPersistedHistory(source);
  const end = pastTurnEnds(events).at(-1)!;
  expect(end.data.reason).toEqual({
    kind: 'error',
    error: { code: 'UNKNOWN', message: CHECKPOINT_INTERRUPTED },
  });
  await expect(engine.resolveForkBoundary!(source, end.seq)).rejects.toMatchObject(invalid);
  expect(await engine.resolveForkBoundary!(source)).toBe(valid);
  expect(model.requests).toHaveLength(1);
});
