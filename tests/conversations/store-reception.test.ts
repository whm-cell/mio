import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { ConversationError } from '../../src/conversations/contracts.ts';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { createConversationStore } from '../../src/conversations/store.ts';
import { authDatabase } from '../support/auth-database.ts';

it('admits a legacy callback once and replays the original receipt without resolving the model', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  let store: Awaited<ReturnType<typeof createConversationStore>> | undefined;
  try {
    await pool.query(conversationSchemaSQL);
    store = await createConversationStore(database.url);
    const actor = { userId: randomUUID(), sessionId: 'fixture' };
    const id = randomUUID();
    await store.create(actor, id);
    await store.setReady(id, true);

    const unavailable = vi.fn(async () => {
      throw new ConversationError(503, 'MODEL_UNAVAILABLE');
    });
    await expect(store.receive(actor, id, 'rejected', 'digest', unavailable)).rejects.toMatchObject(
      {
        status: 503,
        code: 'MODEL_UNAVAILABLE',
      },
    );
    expect(unavailable).toHaveBeenCalledTimes(1);
    await expect(store.request(actor, id, 'rejected')).rejects.toMatchObject({
      code: 'REQUEST_NOT_FOUND',
    });

    const legacy = vi.fn(async () => undefined);
    const fresh = await store.receive(actor, id, 'request', 'digest', legacy);
    expect(legacy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id, state: 'ready', model_binding: null }),
    );
    expect(fresh).toMatchObject({ fresh: true, receipt: { status: 'accepted' } });
    expect(fresh.snapshot).toBeUndefined();
    const modelBinding = await pool.query(
      'SELECT model_binding FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2',
      [id, 'request'],
    );
    expect(modelBinding.rows).toEqual([{ model_binding: null }]);

    unavailable.mockClear();
    const replay = await store.receive(actor, id, 'request', 'digest', unavailable);
    expect(replay).toMatchObject({ fresh: false, receipt: fresh.receipt });
    await expect(store.receive(actor, id, 'request', 'changed', unavailable)).rejects.toMatchObject(
      {
        code: 'REQUEST_ID_CONFLICT',
      },
    );
    expect(unavailable).not.toHaveBeenCalled();
  } finally {
    await store?.close();
    await pool.end();
    await database.close();
  }
});
