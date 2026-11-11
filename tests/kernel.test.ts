import { mkdtemp, readFile, rm, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  kernelRuntime,
  modelOptions,
  ScriptedModel,
  textResponse,
  toolResponse,
} from './kernel-runtime.ts';

const contexts: Context[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(script: (ReturnType<typeof textResponse> | 'hold')[], root?: string) {
  if (!root) roots.push((root = await mkdtemp(join(tmpdir(), 'mio-kernel-'))));
  const model = new ScriptedModel(script);
  const ctx = await kernelRuntime(root, model);
  contexts.push(ctx);
  return { ctx, model, root };
}

const input = (text: string) =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });

describe('Mio kernel through official loop and real JSONL', () => {
  it('joins explicit handle disposal racing graceful kernel close', async () => {
    const { ctx } = await setup(['hold']);
    const chunk = Promise.withResolvers<void>();
    const handle = await ctx.mioKernel.create('close-race', modelOptions, (agentCtx) => {
      agentCtx.on('agent/assistant-stream', ({ frame }) => {
        if (frame.type === 'chunk') chunk.resolve();
      });
    });
    handle.agent.followup(input('hold'));
    await chunk.promise;
    const closing = ctx.mioKernel.close();
    const disposing = handle.dispose();
    await Promise.all([closing, disposing]);
    expect(ctx.agents.list()).toEqual([]);
  });
  it('rechecks live ownership after a cold read races resume and a new active turn', async () => {
    const { ctx } = await setup([textResponse('stored first'), 'hold']);
    const first = await ctx.mioKernel.create('history-race', modelOptions);
    first.agent.followup(input('first'));
    await first.agent.whenIdle();
    await first.dispose();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence);
    let gated = false;
    const openSpy = vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      const reader = await originalOpen(...args);
      if (args[1] === 'read' && !gated) {
        gated = true;
        const read = reader.read.bind(reader);
        vi.spyOn(reader, 'read').mockImplementation(async (...readArgs) => {
          entered.resolve();
          await release.promise;
          return read(...readArgs);
        });
      }
      return reader;
    });
    try {
      const reading = ctx.mioKernel.history('history-race');
      await entered.promise;
      const chunk = Promise.withResolvers<void>();
      const resumed = await ctx.mioKernel.resume('history-race', modelOptions, (agentCtx) => {
        agentCtx.on('agent/assistant-stream', ({ frame }) => {
          if (frame.type === 'chunk') chunk.resolve();
        });
      });
      resumed.agent.followup(input('active second'));
      await chunk.promise;
      await ctx.mioKernel.flush(resumed.agent.session);
      release.resolve();
      const history = await reading;
      expect(JSON.stringify(history.events)).toContain('active second');
      expect(history.events.filter((event) => event.type === 'turn/end')).toHaveLength(1);
      expect(history.events.findLast((event) => event.type === 'turn/end')?.data.reason).toEqual({
        kind: 'completed',
      });
    } finally {
      release.resolve();
      openSpy.mockRestore();
    }
  });
  it('releases ownership before reopening the same identity in the same kernel', async () => {
    const { ctx, model } = await setup([textResponse('first'), textResponse('second')]);
    const first = await ctx.mioKernel.create('reopened', modelOptions);
    first.agent.followup(input('first input'));
    await first.agent.whenIdle();
    await ctx.mioKernel.flush(first.agent.session);
    const disposing = first.dispose();
    await expect(ctx.mioKernel.resume('reopened', modelOptions)).rejects.toThrow(
      'MIO_KERNEL_SESSION_CLOSING',
    );
    await disposing;
    const second = await ctx.mioKernel.resume('reopened', modelOptions);
    expect(second.agent).not.toBe(first.agent);
    second.agent.followup(input('second input'));
    await second.agent.whenIdle();
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1]!.messages)).toContain('first input');
    await second.dispose();
    await ctx.mioKernel.close();
  });
  it('uses the first round in the second model request and restores the flushed prefix without calling a model', async () => {
    const { ctx, model, root } = await setup([
      textResponse('remembered blue'),
      textResponse('blue again'),
    ]);
    const seen: string[] = [];
    const handle = await ctx.mioKernel.create('two-rounds', modelOptions, (agentCtx) => {
      agentCtx.on('agent/assistant-stream', ({ frame }) => {
        seen.push(frame.type);
      });
    });
    handle.agent.followup(input('remember blue'));
    await handle.agent.whenIdle();
    handle.agent.followup(input('which color?'));
    await handle.agent.whenIdle();
    expect(model.requests).toHaveLength(2);
    const request = JSON.stringify(model.requests[1]!.messages);
    expect(request).toContain('remember blue');
    expect(request).toContain('remembered blue');
    expect(request).toContain('which color?');
    expect(seen).toEqual([
      'start',
      ...Array(4).fill('chunk'),
      'end',
      'start',
      ...Array(4).fill('chunk'),
      'end',
    ]);
    await ctx.mioKernel.flush(handle.agent.session);
    const before = handle.agent.session.snapshotEvents();
    expect(before.at(-1)?.type).toBe('turn/end');
    await ctx.mioKernel.close();
    expect(ctx.agents.list()).toEqual([]);
    expect(ctx.sessions.list()).toEqual([]);
    await expect(ctx.mioKernel.create('late', modelOptions)).rejects.toThrow('MIO_KERNEL_CLOSED');
    const fresh = await setup([textResponse('next')], root);
    const history = await fresh.ctx.mioKernel.history('two-rounds');
    expect(history.events).toEqual(before);
    expect(fresh.model.requests).toHaveLength(0);
    const resumed = await fresh.ctx.mioKernel.resume('two-rounds', modelOptions);
    expect(fresh.model.requests).toHaveLength(0);
    resumed.agent.followup(input('continue'));
    await resumed.agent.whenIdle();
    expect(JSON.stringify(fresh.model.requests[0]!.messages)).toContain('blue again');
  });

  it('distinguishes transient chunks from settlement and drains an active root teardown', async () => {
    const { ctx, root } = await setup(['hold']);
    const chunk = Promise.withResolvers<void>();
    const handle = await ctx.mioKernel.create('cancelled', modelOptions, (agentCtx) => {
      agentCtx.on('agent/assistant-stream', ({ frame }) => {
        if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') chunk.resolve();
      });
    });
    handle.agent.followup(input('hold this'));
    await chunk.promise;
    await ctx.mioKernel.flush(handle.agent.session);
    const live = await ctx.mioKernel.history('cancelled');
    expect(live.events.some((event) => event.type === 'assistant/message')).toBe(false);
    expect(live.events.some((event) => event.type === 'turn/end')).toBe(false);
    await ctx.fiber.dispose();
    const fresh = await setup([], root);
    const recovered = await fresh.ctx.mioKernel.history('cancelled');
    const end = recovered.events.findLast((event) => event.type === 'turn/end');
    expect(end?.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'disposed' } });
    const stat = await fresh.ctx.sessionPersistence.stat(SessionId('cancelled'));
    expect(stat?.location?.kind).toBe('jsonl');
    if (stat?.location?.kind !== 'jsonl') throw new Error('missing JSONL location');
    expect(await readFile(stat.location.path, 'utf8')).toContain('turn/end');
    expect(fresh.model.requests).toHaveLength(0);
  });

  it('flushes cancelled settlement and removes restored pending input before accepting new input', async () => {
    const { ctx, root } = await setup(['hold']);
    const chunk = Promise.withResolvers<void>();
    const handle = await ctx.mioKernel.create('pending', modelOptions, (agentCtx) => {
      agentCtx.on('agent/assistant-stream', ({ frame }) => {
        if (frame.type === 'chunk') chunk.resolve();
      });
    });
    handle.agent.followup(input('active'));
    await chunk.promise;
    handle.agent.followup(input('must never replay'));
    await ctx.mioKernel.flush(handle.agent.session);
    handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
    await handle.agent.whenIdle();
    await ctx.mioKernel.flush(handle.agent.session);
    await handle.dispose();
    const fresh = await setup([textResponse('fresh response')], root);
    const resumed = await fresh.ctx.mioKernel.resume('pending', modelOptions);
    expect(resumed.agent.inbox.nextTurn).toEqual([]);
    expect(fresh.model.requests).toHaveLength(0);
    resumed.agent.followup(input('only new input'));
    await resumed.agent.whenIdle();
    expect(fresh.model.requests).toHaveLength(1);
    expect(JSON.stringify(fresh.model.requests[0]!.messages)).not.toContain('must never replay');
    const log = await fresh.ctx.mioKernel.history('pending');
    expect(
      log.events.some(
        (event) => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled',
      ),
    ).toBe(true);
  });

  it('recovers a torn final line while refusing corruption in a committed required record', async () => {
    const { ctx, root } = await setup([textResponse('stored')]);
    const handle = await ctx.mioKernel.create('damage', modelOptions);
    handle.agent.followup(input('persist'));
    await handle.agent.whenIdle();
    await ctx.mioKernel.close();
    const stat = await ctx.sessionPersistence.stat(SessionId('damage'));
    if (stat?.location?.kind !== 'jsonl') throw new Error('missing JSONL location');
    const original = await readFile(stat.location.path, 'utf8');
    await appendFile(stat.location.path, '{"type":"torn');
    const fresh = await setup([], root);
    expect(JSON.stringify((await fresh.ctx.mioKernel.history('damage')).events)).toContain(
      'stored',
    );
    // A complete retired required record is not treated as a recoverable tail.
    await writeFile(
      stat.location.path,
      original.replace('"type":"user/message"', '"type":"ptc/retired-required"'),
    );
    await expect(fresh.ctx.mioKernel.history('damage')).rejects.toThrow();
    expect(fresh.model.requests).toHaveLength(0);
  });

  it('preserves only the durable prefix across SIGKILL and never replays pending input on restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mio-kernel-killed-'));
    roots.push(root);
    const child = spawn(process.execPath, [resolve('tests/kernel-crash.ts'), root], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout!.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr!.on('data', (data: Buffer) => {
      output += data.toString();
    });
    const exited = once(child, 'exit');
    try {
      const ready = await Promise.race([
        once(child, 'message').then(([message]) => message),
        exited.then(() => {
          throw new Error(`crash fixture exited: ${output}`);
        }),
      ]);
      expect(ready).toEqual({ ready: true });
      await delay(100);
      expect(child.exitCode, output).toBeNull();
      expect(child.signalCode, output).toBeNull();
      expect(child.kill('SIGKILL')).toBe(true);
      expect(await exited).toEqual([null, 'SIGKILL']);
      const fresh = await setup([textResponse('new response')], root);
      const stat = await fresh.ctx.sessionPersistence.stat(SessionId('hard-stop'));
      if (stat?.location?.kind !== 'jsonl') throw new Error('missing JSONL location');
      const original = await readFile(stat.location.path, 'utf8');
      expect(original).not.toContain('turn/end');
      expect(original).not.toContain('unsettled chunk');
      const history = await fresh.ctx.mioKernel.history('hard-stop');
      expect(history.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'interrupted' } },
      });
      // Cold observation adds a read-only marker, without inventing a committed row.
      expect(await readFile(stat.location.path, 'utf8')).toBe(original);
      const handle = await fresh.ctx.mioKernel.resume('hard-stop', modelOptions);
      expect(fresh.model.requests).toHaveLength(0);
      expect(handle.agent.inbox.nextTurn).toEqual([]);
      handle.agent.followup(input('new after restart'));
      await handle.agent.whenIdle();
      expect(fresh.model.requests).toHaveLength(1);
      expect(JSON.stringify(fresh.model.requests[0]!.messages)).not.toContain(
        'pending must not replay',
      );
      expect(JSON.stringify(fresh.model.requests[0]!.messages)).not.toContain('unsettled chunk');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  });

  it('blocks a model-requested real tool body even with a later allow listener', async () => {
    const { ctx } = await setup([toolResponse(), textResponse('denied safely')]);
    let calls = 0;
    ctx.tools.register(
      defineTool({
        name: 'counted_fixture',
        description: 'Test-only, no external side effect',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async () => {
          calls++;
          return 'ran';
        },
      }),
    );
    ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }));
    const handle = await ctx.mioKernel.create('tools', modelOptions);
    handle.agent.followup(input('call the counted tool'));
    await handle.agent.whenIdle();
    expect(calls).toBe(0);
    expect(JSON.stringify(handle.agent.session.snapshotEvents())).toContain('MIO_TOOL_DENIED');
    // Existing plugin.test.ts separately runs the same native chain without a guard as positive control.
    const result = await ctx.tools.execute({
      calls: [
        { type: 'tool-call', id: ToolCallId('extra'), name: 'counted_fixture', arguments: '{}' },
      ],
      signal: new AbortController().signal,
    });
    expect(result.results[0]?.result.isError).toBe(true);
  });

  it('keeps the scoped deny policy until a tool attempt has drained during root unload', async () => {
    const { ctx } = await setup([toolResponse(), textResponse('done')]);
    let calls = 0;
    ctx.tools.register(
      defineTool({
        name: 'counted_fixture',
        description: 'Test-only counted body',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async () => {
          calls++;
          return 'ran';
        },
      }),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    ctx.on('tools/pre-execute', async () => {
      entered.resolve();
      await release.promise;
      return { kind: 'allow' };
    });
    const handle = await ctx.mioKernel.create('unload-tools', modelOptions);
    handle.agent.followup(input('call tool while stopping'));
    await entered.promise;
    const stopped = ctx.fiber.dispose();
    release.resolve();
    await stopped;
    expect(calls).toBe(0);
  });
});
