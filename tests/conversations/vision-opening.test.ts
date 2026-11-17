import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { createConversationService } from '../../src/conversations/service.ts';
import { createConversationStore } from '../../src/conversations/store.ts';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import { authDatabase } from '../support/auth-database.ts';
import { kernelRuntime, ScriptedModel } from '../support/kernel-runtime.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let observer: Pool;
const actor = { userId: 'owner', sessionId: 'login' };

beforeAll(async () => {
  database = await authDatabase();
  observer = new Pool({ connectionString: database.observerURL });
  await observer.query(conversationSchemaSQL);
}, 45000);

afterAll(async () => {
  if (observer) await observer.end();
  if (database) await database.close();
}, 30000);

it.each(['user-first', 'shutdown-first', 'shutdown-only'] as const)(
  'preserves the first termination intent during real resume: %s',
  async (order) => {
    const root = await mkdtemp(join(tmpdir(), 'mio-opening-race-'));
    const model = new ScriptedModel([]);
    const ctx = await kernelRuntime(root, model);
    const engine = createDshConversationEngine(ctx, {
      databaseURL: 'unused',
      provider: 'mio-test-only',
      model: 'scripted',
    });
    const store = await createConversationStore(database.url);
    const service = createConversationService(store, engine);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let closing: Promise<void> | undefined;
    let cancellation: Promise<unknown> | undefined;
    try {
      const conversation = await service.create(actor);
      const sessionId = (await store.owned(actor, conversation.id)).dsh_session_id;
      const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence);
      const opening = vi
        .spyOn(ctx.sessionPersistence, 'open')
        .mockImplementation(async (...args) => {
          if (args[0] === sessionId && args[1] === 'write') {
            entered.resolve();
            await release.promise;
          }
          return open(...args);
        });
      const cancel = vi.spyOn(engine, 'cancel');
      const close = vi.spyOn(engine, 'close');
      expect((await service.send(actor, conversation.id, 'opening', 'hello')).status).toBe(
        'accepted',
      );
      await entered.promise;
      if (order === 'user-first') {
        cancellation = service.cancel(actor, conversation.id);
        void cancellation.catch(() => {});
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      }
      closing = service.close();
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      if (order === 'shutdown-first') {
        await expect(service.cancel(actor, conversation.id)).rejects.toMatchObject({
          code: 'CONVERSATION_UNAVAILABLE',
        });
        await engine.cancel(sessionId, 'opening');
      }
      release.resolve();
      await closing;
      await cancellation?.catch(() => {});
      const result = await observer.query<{ status: string; error_code: string | null }>(
        'SELECT status,error_code FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2',
        [conversation.id, 'opening'],
      );
      expect(result.rows[0]).toEqual(
        order === 'user-first'
          ? { status: 'cancelled', error_code: null }
          : { status: 'unknown', error_code: 'PROCESS_INTERRUPTED' },
      );
      expect(model.requests).toHaveLength(0);
      const history = await ctx.mioKernel.history(sessionId);
      expect(history.events.some((event) => event.type === 'user/message')).toBe(false);
      opening.mockRestore();
    } finally {
      release.resolve();
      await closing?.catch(() => {});
      await service.close().catch(() => {});
      await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
