import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it, vi } from 'vitest';
import { createConversationHandler } from '../../src/conversations/http.ts';
import { createConversationService } from '../../src/conversations/service.ts';
import type { ConversationEngine } from '../../src/conversations/contracts.ts';
import type { ConversationStore } from '../../src/conversations/store.ts';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import { kernelRuntime, ScriptedModel, textResponse } from '../support/kernel-runtime.ts';

const roots: string[] = [];
const contexts: Context[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runtime(script: ConstructorParameters<typeof ScriptedModel>[0] = []) {
  const root = await mkdtemp(join(tmpdir(), 'mio-history-cancel-'));
  roots.push(root);
  const model = new ScriptedModel(script);
  const ctx = await kernelRuntime(root, model);
  contexts.push(ctx);
  const engine = createDshConversationEngine(ctx, {
    databaseURL: 'unused',
    provider: 'mio-test-only',
    model: 'scripted',
  });
  return { ctx, engine, model };
}

it('cancels only the disconnected history HTTP request and drains it before closing the pool', async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const cancelled = Promise.withResolvers<void>();
  const store = {
    owned: vi.fn(async () => ({ dsh_session_id: 'session' })),
    close: vi.fn(async () => {}),
  } as unknown as ConversationStore;
  let first = true;
  const engine: ConversationEngine = {
    available: true,
    create: async () => {},
    rename: async (_id, title) => title,
    run: async () => 'completed',
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    async history(_id, after, _limit, signal) {
      if (!first) return { items: [], nextAfterSeq: after, hasMore: false };
      first = false;
      if (!signal) throw new Error('history cancellation signal missing');
      entered.resolve(signal);
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            cancelled.resolve();
            reject(signal.reason);
          },
          { once: true },
        );
      });
      throw new Error('unreachable');
    },
  };
  const service = createConversationService(store, engine);
  const endpoint = createConversationHandler(
    service,
    async () => ({ userId: 'owner', sessionId: 'login' }),
    [],
  );
  const server = createServer(endpoint.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
  const url = `http://127.0.0.1:${address.port}/api/v1/conversations/${randomUUID()}/history`;
  const stop = new AbortController();
  const firstRequest = fetch(url, { signal: stop.signal }).catch((error: unknown) => error);
  try {
    const reading = await entered.promise;
    stop.abort();
    await cancelled.promise;
    await firstRequest;
    expect(reading.aborted).toBe(true);
    expect((await fetch(url)).status).toBe(200);
    expect(engine.cancel).not.toHaveBeenCalled();
    expect(store.close).not.toHaveBeenCalled();
    await service.close();
    expect(store.close).toHaveBeenCalledOnce();
  } finally {
    stop.abort();
    endpoint.close();
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each(['cold', 'live'] as const)(
  'passes cancellation to the native %s history handle and closes that reader',
  async (mode) => {
    const { ctx, engine, model } = await runtime(mode === 'live' ? ['hold'] : []);
    await engine.create('history');
    const running =
      mode === 'live'
        ? engine.run(
            'history',
            'running',
            'hold',
            async () => {},
            () => {},
          )
        : undefined;
    if (running) await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    const entered = Promise.withResolvers<void>();
    const stop = new AbortController();
    const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence);
    let readSignal: AbortSignal | undefined;
    let closed = 0;
    const observer = vi
      .spyOn(ctx.sessionPersistence, 'open')
      .mockImplementationOnce(async (...args) => {
        const handle = await open(...args);
        expect(args[2]?.signal).toBe(stop.signal);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          closed++;
          await close();
        });
        vi.spyOn(handle, 'read').mockImplementationOnce(async (_offset, _limit, options) => {
          readSignal = options?.signal;
          entered.resolve();
          return new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), {
              once: true,
            });
          });
        });
        return handle;
      });
    const reading = engine.history('history', -1, 20, stop.signal);
    const failed = expect(reading).rejects.toThrow();
    try {
      await entered.promise;
      stop.abort(new Error('client disconnected'));
      await failed;
      expect(readSignal).toBe(stop.signal);
      expect(closed).toBe(1);
      observer.mockRestore();
      expect((await engine.history('history', -1, 20)).items).toBeInstanceOf(Array);
      expect(model.requests).toHaveLength(mode === 'live' ? 1 : 0);
      if (running) {
        expect(model.requests[0]!.signal?.aborted).toBe(false);
        await engine.cancel('history', 'running');
        await running;
      }
    } finally {
      stop.abort();
      observer.mockRestore();
      if (running) {
        await engine.cancel('history', 'running');
        await running;
      }
    }
  },
);

it('yields during a long history projection so client cancellation stops further scanning', async () => {
  const { ctx, engine } = await runtime([textResponse('answer')]);
  await engine.create('projection');
  await engine.run(
    'projection',
    'one',
    'hello',
    async () => {},
    () => {},
  );
  const stored = await ctx.mioKernel.history('projection');
  const source = stored.events.find((event) => event.type === 'user/message')!;
  const events = Array.from({ length: 1024 }, (_, seq) => ({
    ...source,
    seq: seq as typeof source.seq,
  }));
  vi.spyOn(ctx.mioKernel, 'history').mockResolvedValueOnce({ header: stored.header, events });
  const stop = new AbortController();
  const abort = setImmediate(() => stop.abort(new Error('client disconnected')));
  try {
    await expect(engine.history('projection', 2000, 20, stop.signal)).rejects.toThrow();
  } finally {
    clearImmediate(abort);
  }
});
