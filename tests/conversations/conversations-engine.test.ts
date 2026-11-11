import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import { kernelRuntime, ScriptedModel, textResponse } from '../support/kernel-runtime.ts';
import type { ModelScript } from '../support/kernel-runtime.ts';
const contexts: Context[] = [];
const roots: string[] = [];
afterEach(async () => {
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
