import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import { parseImageJobPresentationMeta } from '../../src/dsh/image-tools.ts';
import { authorizeConversationImageTools } from '../../src/dsh/policy.ts';
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

it('keeps budget denials monotonic across repeated guard checks, honors aborted signals, and validates projected output order', async () => {
  const { ctx } = await setup([]);
  let revoke: (() => void) | undefined;
  const handle = await ctx.mioKernel.create('guard-monotonic', {}, (agentCtx, agent) => {
    revoke = authorizeConversationImageTools(agentCtx, agent);
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
