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

it('preserves all four terminal receipts and the next busy request after a late finish', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  const actor = { userId: randomUUID(), sessionId: randomUUID() };
  const resolveLegacy = async () => undefined;
  const rejectFreshResolution = async () => {
    throw new Error('Unexpected fresh model resolution');
  };
  let store: Awaited<ReturnType<typeof createConversationStore>> | undefined;
  try {
    await pool.query(conversationSchemaSQL);
    store = await createConversationStore(database.url);
    for (const [status, error] of [
      ['completed', undefined],
      ['cancelled', undefined],
      ['failed', 'MODEL_FAILED'],
      ['unknown', 'PROCESS_INTERRUPTED'],
    ] as const) {
      const id = randomUUID();
      await store.create(actor, id);
      await store.setReady(id, true);
      await store.receive(actor, id, 'first', 'first-digest', resolveLegacy);
      const original = await store.finish(id, 'first', status, error);
      expect(original).toEqual({
        conversationId: id,
        requestId: 'first',
        status,
        ...(error ? { error } : {}),
      });
      await store.receive(actor, id, 'next', 'next-digest', resolveLegacy);
      expect(await store.finish(id, 'first', 'unknown', 'EXECUTION_UNKNOWN')).toEqual(original);
      expect(await store.reconcileExecution(actor, id, 'first')).toEqual(original);
      expect(await store.request(actor, id, 'first')).toEqual(original);
      await expect(
        store.receive(actor, id, 'first', 'first-digest', rejectFreshResolution),
      ).resolves.toMatchObject({
        fresh: false,
        receipt: original,
      });
      await expect(
        store.receive(actor, id, 'first', 'wrong-digest', rejectFreshResolution),
      ).rejects.toMatchObject({
        code: 'REQUEST_ID_CONFLICT',
      });
      expect(await store.snapshot(actor, id)).toMatchObject({
        activeRequestId: 'next',
        receipt: { requestId: 'next', status: 'accepted' },
      });
      await expect(
        store.receive(actor, id, 'third', 'third-digest', rejectFreshResolution),
      ).rejects.toMatchObject({
        code: 'CONVERSATION_BUSY',
      });
    }
  } finally {
    await store?.close();
    await pool.end();
    await database.close();
  }
});

it('migrates pre-truncation receipts in place without deriving a terminal marker from model observations', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  const id = randomUUID();
  const actor = { userId: randomUUID(), sessionId: randomUUID() };
  let store: Awaited<ReturnType<typeof createConversationStore>> | undefined;
  try {
    // Original receipt schema before truncation and audio context became nullable columns.
    await pool.query(`
      CREATE TABLE mio_conversations (
        id uuid PRIMARY KEY, owner_id text NOT NULL, dsh_session_id text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        state text NOT NULL CHECK (state IN ('creating','ready','unknown')),
        active_request text, model_binding jsonb
      );
      CREATE TABLE mio_conversation_requests (
        conversation_id uuid NOT NULL REFERENCES mio_conversations(id), request_id text NOT NULL,
        digest text NOT NULL, status text NOT NULL CHECK (status IN ('accepted','input-persisted','completed','cancelled','failed','unknown')),
        error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        model_binding jsonb, model_observations jsonb NOT NULL DEFAULT '[]'::jsonb,
        PRIMARY KEY (conversation_id, request_id)
      );`);
    await pool.query(
      "INSERT INTO mio_conversations(id,owner_id,dsh_session_id,state,active_request) VALUES($1,$2,$3,'ready','in-flight')",
      [id, actor.userId, `mio-${id}`],
    );
    await pool.query(
      `INSERT INTO mio_conversation_requests(conversation_id,request_id,digest,status,error_code,model_observations)
       VALUES ($1,'settled','done','completed',NULL,'[]'),
              ($1,'old-unknown','lost','unknown','EXECUTION_UNKNOWN','[{"status":200,"finish":"max-tokens"}]'),
              ($1,'in-flight','pending','input-persisted',NULL,'[{"status":200,"finish":"max-tokens"}]')`,
      [id],
    );
    const old = await pool.query(
      'SELECT to_jsonb(r) AS original FROM mio_conversation_requests r ORDER BY request_id',
    );
    await expect(createConversationStore(database.url)).rejects.toThrow('CONVERSATION_SCHEMA');
    await pool.query(conversationSchemaSQL);
    await pool.query(conversationSchemaSQL);
    const migrated = await pool.query(
      'SELECT to_jsonb(r) AS original FROM mio_conversation_requests r ORDER BY request_id',
    );
    expect(migrated.rows).toEqual(
      old.rows.map(({ original }) => ({
        original: { ...original, truncation_reason: null, audio_context: null },
      })),
    );
    store = await createConversationStore(database.url);
    for (const [requestId, status, error] of [
      ['settled', 'completed', undefined],
      ['old-unknown', 'unknown', 'EXECUTION_UNKNOWN'],
      ['in-flight', 'unknown', 'PROCESS_INTERRUPTED'],
    ] as const) {
      expect(await store.request(actor, id, requestId)).toEqual({
        conversationId: id,
        requestId,
        status,
        ...(error ? { error } : {}),
      });
    }
    expect((await store.owned(actor, id)).active_request).toBeNull();
  } finally {
    await store?.close();
    await pool.end();
    await database.close();
  }
});
