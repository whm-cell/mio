import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { createConversationStore } from '../../src/conversations/store.ts';
import { createConversationService } from '../../src/conversations/service.ts';
import type { ConversationEngine } from '../../src/conversations/contracts.ts';

it('cancels an actually running owner turn, drains its receipt, and keeps another owner service available', async () => {
  const database = await authDatabase(),
    pool = new Pool({ connectionString: database.url });
  await pool.query(conversationSchemaSQL);
  const entered = Promise.withResolvers<void>(),
    stop = Promise.withResolvers<void>();
  const purge = vi.fn(async () => {});
  const engine: ConversationEngine = {
    available: true,
    create: async () => {},
    rename: async () => '',
    history: async () => ({ items: [], hasMore: false, nextAfterSeq: 0 }),
    async run(_id, _request, _text, durable) {
      await durable();
      entered.resolve();
      await stop.promise;
      return 'cancelled';
    },
    cancel: async () => {
      stop.resolve();
    },
    purgeSession: purge,
    close: async () => {
      stop.resolve();
    },
  };
  const service = createConversationService(await createConversationStore(database.url), engine);
  try {
    const old = { userId: 'old', sessionId: 'old-session' },
      fresh = { userId: 'fresh', sessionId: 'new-session' };
    const chat = await service.create(old);
    await service.send(old, chat.id, 'turn', 'private message');
    await entered.promise;
    expect(
      (await pool.query('SELECT active_request FROM mio_conversations WHERE id=$1', [chat.id]))
        .rows[0].active_request,
    ).toBe('turn');
    expect((await service.cancelDeletedAccount(old.userId, new Date())).done).toBe(true);
    expect((await service.deleteAccountBatch(old.userId, AbortSignal.timeout(5000))).done).toBe(
      true,
    );
    expect(purge).toHaveBeenCalledOnce();
    const next = await service.create(fresh);
    expect(next.id).not.toBe(chat.id);
    await expect(service.create(old)).rejects.toThrow('ACCOUNT_DELETED');
  } finally {
    stop.resolve();
    await service.close();
    await pool.end();
    await database.close();
  }
});
