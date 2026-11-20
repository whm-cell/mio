import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { createConversationStore } from '../../src/conversations/store.ts';
import { authDatabase } from '../support/auth-database.ts';

it('recovers interrupted conversations without rewriting settled history', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  let store: Awaited<ReturnType<typeof createConversationStore>> | undefined;
  const seeds = (['creating', 'ready', 'unknown'] as const).flatMap((state) =>
    [null, 'unfinished-request'].map((active_request) => ({
      id: randomUUID(),
      state,
      active_request,
    })),
  );
  try {
    await pool.query(conversationSchemaSQL);
    for (const seed of seeds)
      await pool.query(
        'INSERT INTO mio_conversations(id,owner_id,dsh_session_id,state,active_request) VALUES($1,$2,$3,$4,$5)',
        [seed.id, randomUUID(), randomUUID(), seed.state, seed.active_request],
      );
    await pool.query('CREATE TABLE recovery_updates (id uuid NOT NULL)');
    await pool.query(
      'CREATE FUNCTION observe_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO recovery_updates VALUES(NEW.id); RETURN NEW; END $$',
    );
    await pool.query(
      'CREATE TRIGGER observe_recovery AFTER UPDATE ON mio_conversations FOR EACH ROW EXECUTE FUNCTION observe_recovery()',
    );
    const before = (await pool.query('SELECT * FROM mio_conversations ORDER BY id')).rows;
    store = await createConversationStore(database.url);
    expect((await pool.query('SELECT * FROM mio_conversations ORDER BY id')).rows).toEqual(
      before.map((row) => ({
        ...row,
        state: row.state === 'creating' ? 'unknown' : row.state,
        active_request: null,
      })),
    );
    expect(
      (await pool.query('SELECT id FROM recovery_updates')).rows.map((row) => row.id).sort(),
    ).toEqual(
      seeds
        .filter((seed) => seed.state === 'creating' || seed.active_request !== null)
        .map((seed) => seed.id)
        .sort(),
    );
    await expect(createConversationStore(database.url)).rejects.toThrow('CONVERSATION_INSTANCE');
    await store.close();
    store = undefined;
    await pool.query('TRUNCATE recovery_updates');
    store = await createConversationStore(database.url);
    expect((await pool.query('SELECT * FROM recovery_updates')).rows).toEqual([]);
  } finally {
    await store?.close();
    await pool.end();
    await database.close();
  }
});
