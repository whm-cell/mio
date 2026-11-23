import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseConversationCursor } from '../../src/conversations/cursor.ts';
import type { ConversationCursor } from '../../src/conversations/cursor.ts';
import { checkConversationSchema, conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { createConversationStore } from '../../src/conversations/store.ts';
import type { ConversationStore } from '../../src/conversations/store.ts';
import { authDatabase } from '../support/auth-database.ts';

const owner = { userId: 'lifecycle-owner', sessionId: 'fixture' };
const outsider = { userId: 'lifecycle-outsider', sessionId: 'fixture' };
let database: Awaited<ReturnType<typeof authDatabase>> | undefined;
let pool: Pool;
let store: ConversationStore | undefined;

beforeEach(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
});

afterEach(async () => {
  try {
    await store?.close();
  } finally {
    store = undefined;
    if (database) {
      try {
        await pool.end();
      } finally {
        await database.close();
        database = undefined;
      }
    }
  }
});

async function startStore() {
  await pool.query(conversationSchemaSQL);
  return (store = await createConversationStore(database!.url));
}

it('migrates pre-lifecycle metadata and preserves activity and receipts on repeat', async () => {
  await pool.query(`
    CREATE TABLE mio_conversations (
      id uuid PRIMARY KEY, owner_id text NOT NULL, dsh_session_id text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      state text NOT NULL CHECK (state IN ('creating','ready','unknown')),
      active_request text, model_binding jsonb
    );
    CREATE INDEX mio_conversations_owner_page ON mio_conversations(owner_id, id);
    CREATE TABLE mio_conversation_requests (
      conversation_id uuid NOT NULL REFERENCES mio_conversations(id), request_id text NOT NULL,
      digest text NOT NULL, status text NOT NULL,
      error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      model_binding jsonb, model_observations jsonb NOT NULL DEFAULT '[]'::jsonb, truncation_reason text,
      PRIMARY KEY (conversation_id, request_id)
    );`);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mio_conversations(id,owner_id,dsh_session_id,state,created_at)
     VALUES($1,$2,'original-dsh','ready','2025-01-03T01:02:03.123456Z')`,
    [id, owner.userId],
  );
  await pool.query(
    `INSERT INTO mio_conversation_requests(conversation_id,request_id,digest,status,model_observations)
     VALUES($1,'first','original-digest','completed','[{"status":200,"finish":"stop"}]')`,
    [id],
  );
  const originalRequests = (
    await pool.query('SELECT to_jsonb(r) AS row FROM mio_conversation_requests r')
  ).rows;
  await expect(checkConversationSchema(pool)).rejects.toThrow('column "title" does not exist');
  expect(
    (await pool.query("SELECT to_regclass('mio_conversations_owner_activity_page') AS index")).rows,
  ).toEqual([{ index: null }]);
  const migrate = () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/service/migrate-conversations.ts', '--apply'],
      {
        env: { PATH: process.env.PATH, MIO_CONVERSATIONS_DATABASE_URL: database!.url },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
  };
  migrate();
  const { rows } = await pool.query(`
    SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='mio_conversations'
      AND column_name IN ('archived_at','title','title_pinned','updated_at') ORDER BY column_name`);
  expect(rows).toEqual([
    {
      column_name: 'archived_at',
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
      column_default: null,
    },
    { column_name: 'title', data_type: 'text', is_nullable: 'YES', column_default: null },
    {
      column_name: 'title_pinned',
      data_type: 'boolean',
      is_nullable: 'NO',
      column_default: 'false',
    },
    {
      column_name: 'updated_at',
      data_type: 'timestamp with time zone',
      is_nullable: 'NO',
      column_default: 'now()',
    },
  ]);
  const { rows: indexes } = await pool.query(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname=current_schema() AND indexname='mio_conversations_owner_activity_page'`);
  expect(indexes[0]?.indexdef).toContain(
    'USING btree (owner_id, updated_at DESC, id DESC) WHERE (archived_at IS NULL)',
  );
  expect(
    (
      await pool.query(`SELECT title,title_pinned,archived_at,updated_at=created_at AS exact,
       dsh_session_id FROM mio_conversations`)
    ).rows,
  ).toEqual([
    {
      title: null,
      title_pinned: false,
      archived_at: null,
      exact: true,
      dsh_session_id: 'original-dsh',
    },
  ]);

  await pool.query(`UPDATE mio_conversations SET title='Manual',title_pinned=true,
    updated_at='2026-01-03T04:05:06.000007Z',archived_at='2026-01-03T04:05:07.123456Z'`);
  const migratedRows = (await pool.query('SELECT to_jsonb(c) AS row FROM mio_conversations c'))
    .rows;
  migrate();
  expect((await pool.query('SELECT to_jsonb(c) AS row FROM mio_conversations c')).rows).toEqual(
    migratedRows,
  );
  expect(
    (await pool.query('SELECT to_jsonb(r) AS row FROM mio_conversation_requests r')).rows,
  ).toEqual(originalRequests);
  await checkConversationSchema(pool);
  store = await createConversationStore(database!.url);
  const created = await store.create(owner, randomUUID());
  expect(created).toMatchObject({
    title: null,
    title_pinned: false,
    archived_at: null,
    updated_at: created.created_at,
  });
  expect(await store.request(owner, id, 'first')).toMatchObject({ status: 'completed' });
});

it('pages by PostgreSQL microseconds then descending ID and preserves an ascending legacy continuation', async () => {
  const store = await startStore();
  const [lowerTie, archived, oldest, foreign, microOlder, higherTie] = [
    '00000001-0000-4000-8000-000000000001',
    '00000002-0000-4000-8000-000000000002',
    '00000003-0000-4000-8000-000000000003',
    '00000004-0000-4000-8000-000000000004',
    '00000005-0000-4000-8000-000000000005',
    '00000006-0000-4000-8000-000000000006',
  ] as const;
  for (const [id, actor, micros, hidden] of [
    [lowerTie, owner, '123457', false],
    [archived, owner, '123458', true],
    [oldest, owner, '123455', false],
    [foreign, outsider, '123459', false],
    [microOlder, owner, '123456', false],
    [higherTie, owner, '123457', false],
  ] as const) {
    await pool.query(
      `INSERT INTO mio_conversations(id,owner_id,dsh_session_id,state,updated_at,archived_at)
       VALUES($1,$2,$1::uuid::text,'ready',$3::timestamptz,CASE WHEN $4 THEN now() END)`,
      [id, actor.userId, `2026-01-02T03:04:05.${micros}Z`, hidden],
    );
  }

  let activity: ConversationCursor | undefined;
  for (const [id, usec] of [
    [higherTie, '123457'],
    [lowerTie, '123457'],
    [microOlder, '123456'],
    [oldest, null],
  ] as const) {
    const page = await store.list(owner, activity, 1);
    expect(page.items).toMatchObject([{ id, title: null, updatedAt: '2026-01-02T03:04:05.123Z' }]);
    activity = parseConversationCursor(page.nextAfter ?? undefined);
    expect(activity).toEqual(
      usec ? { kind: 'activity', id, updatedAt: `2026-01-02T03:04:05.${usec}Z` } : undefined,
    );
  }

  let after: string | null = lowerTie;
  for (const id of [oldest, microOlder, higherTie]) {
    const page = await store.list(owner, parseConversationCursor(after ?? undefined), 1);
    expect(page.items).toMatchObject([{ id }]);
    expect(page.nextAfter).toBe(id === higherTie ? null : id);
    after = page.nextAfter;
  }
});

it('projects admitted native input once and retains a pinned title across concurrent and replayed activity', async () => {
  const store = await startStore();
  const id = randomUUID();
  const created = await store.create(owner, id);
  await store.setReady(id, true);
  const resolveFresh = async () => undefined;
  const firstTime = created.updated_at.getTime() + 10;
  const nextTime = firstTime + 10;
  await store.receive(owner, id, 'first', 'digest', resolveFresh);
  await store.inputPersisted(id, 'first');
  expect(await store.request(owner, id, 'first')).toMatchObject({ status: 'input-persisted' });
  expect(await store.owned(owner, id)).toMatchObject({
    updated_at: created.updated_at,
    title: null,
  });

  await store.inputAdmitted(id, 'first', firstTime, 'First fallback');
  const first = await store.owned(owner, id);
  expect(first).toMatchObject({
    updated_at: new Date(firstTime),
    title: 'First fallback',
    title_pinned: false,
  });
  await store.inputAdmitted(id, 'first', firstTime, 'Stale fallback');
  expect(await store.owned(owner, id)).toEqual(first);
  await store.finish(id, 'first', 'completed');

  await pool.query(
    "ALTER TABLE mio_conversations ADD CONSTRAINT reject_rename CHECK (title <> 'Manual')",
  );
  const nativeRename = vi.fn(async () => 'Manual');
  await expect(store.rename(owner, id, nativeRename)).rejects.toMatchObject({ code: '23514' });
  expect(nativeRename).toHaveBeenCalledOnce();
  expect(await store.owned(owner, id)).toMatchObject({
    title: 'First fallback',
    updated_at: new Date(firstTime),
  });
  await pool.query('ALTER TABLE mio_conversations DROP CONSTRAINT reject_rename');

  await store.receive(owner, id, 'next', 'other-digest', resolveFresh);
  const renaming = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const rename = store.rename(owner, id, async () => {
    renaming.resolve();
    await release.promise;
    return nativeRename();
  });
  await renaming.promise;
  const admit = store.inputAdmitted(id, 'next', nextTime, 'First fallback');
  release.resolve();
  expect(await rename).toMatchObject({
    title: 'Manual',
    updatedAt: new Date(firstTime).toISOString(),
  });
  await admit;
  await store.finish(id, 'next', 'completed');
  await store.inputAdmitted(id, 'first', nextTime + 10, 'Late fallback');
  await store.receive(owner, id, 'first', 'digest', resolveFresh);
  expect((await store.list(owner, undefined, 10)).items).toMatchObject([
    { id, title: 'Manual', updatedAt: new Date(nextTime).toISOString() },
  ]);
  expect((await store.owned(owner, id)).title_pinned).toBe(true);
});

it('serializes archive with reception and preserves owner-only historical access and replay', async () => {
  const store = await startStore();
  const id = randomUUID();
  await store.create(owner, id);
  await store.setReady(id, true);
  const resolving = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const admitted = store.receive(owner, id, 'first', 'digest', async () => {
    resolving.resolve();
    await release.promise;
    return undefined;
  });
  await resolving.promise;
  const busy = expect(store.archive(owner, id)).rejects.toMatchObject({
    status: 409,
    code: 'CONVERSATION_BUSY',
  });
  release.resolve();
  await admitted;
  await busy;
  const original = await store.finish(id, 'first', 'completed');

  await expect(store.archive(outsider, id)).rejects.toMatchObject({
    status: 404,
    code: 'CONVERSATION_NOT_FOUND',
  });
  const activity = (await store.owned(owner, id)).updated_at;
  const archived = await store.archive(owner, id);
  const timestamp = (
    await pool.query('SELECT archived_at::text AS archived FROM mio_conversations WHERE id=$1', [
      id,
    ])
  ).rows;
  expect(await store.archive(owner, id)).toEqual(archived);
  expect(
    (
      await pool.query('SELECT archived_at::text AS archived FROM mio_conversations WHERE id=$1', [
        id,
      ])
    ).rows,
  ).toEqual(timestamp);
  expect(await store.owned(owner, id)).toMatchObject({
    archived_at: new Date(archived.archivedAt),
    updated_at: activity,
  });
  expect(await store.request(owner, id, 'first')).toEqual(original);
  expect((await store.list(owner, undefined, 10)).items).toEqual([]);
  await expect(store.request(outsider, id, 'first')).rejects.toMatchObject({ status: 404 });

  const deny = vi.fn(async () => {
    throw new Error('Archived conversation reached a write or provider callback');
  });
  await expect(store.receive(owner, id, 'new', 'digest', deny)).rejects.toMatchObject({
    status: 409,
    code: 'CONVERSATION_ARCHIVED',
  });
  await expect(store.existing(owner, id, 'new', 'digest')).rejects.toMatchObject({
    status: 409,
    code: 'CONVERSATION_ARCHIVED',
  });
  await expect(store.bind(owner, id, 'model', deny)).rejects.toMatchObject({
    status: 409,
    code: 'CONVERSATION_ARCHIVED',
  });
  await expect(store.rename(owner, id, deny)).rejects.toMatchObject({
    status: 409,
    code: 'CONVERSATION_ARCHIVED',
  });
  await expect(store.receive(outsider, id, 'first', 'digest', deny)).rejects.toMatchObject({
    status: 404,
  });
  await expect(store.receive(owner, id, 'first', 'changed', deny)).rejects.toMatchObject({
    status: 409,
    code: 'REQUEST_ID_CONFLICT',
  });
  await expect(store.existing(owner, id, 'first', 'changed')).rejects.toMatchObject({
    status: 409,
    code: 'REQUEST_ID_CONFLICT',
  });
  expect(await store.receive(owner, id, 'first', 'digest', deny)).toMatchObject({
    fresh: false,
    receipt: original,
  });
  expect(await store.existing(owner, id, 'first', 'digest')).toMatchObject({ replay: original });
  expect(deny).not.toHaveBeenCalled();
});

it('does not start a native rename after losing the lease while waiting for its row lock', async () => {
  const store = await startStore();
  const id = randomUUID();
  await store.create(owner, id);
  await store.setReady(id, true);
  const blocker = await pool.connect();
  const writeNative = vi.fn(async () => 'New name');
  let rename: Promise<unknown> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM mio_conversations WHERE id=$1 FOR UPDATE', [id]);
    const { rows: backend } = await blocker.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    rename = expect(store.rename(owner, id, writeNative)).rejects.toMatchObject({
      status: 503,
      code: 'CONVERSATION_UNAVAILABLE',
    });
    await vi.waitFor(
      async () => {
        const { rows } = await pool.query<{ waiting: boolean }>(
          `
        SELECT EXISTS(
          SELECT FROM pg_locks WHERE relation='mio_conversations'::regclass
            AND mode='RowShareLock' AND pid<>$1
        ) AS waiting`,
          [backend[0]!.pid],
        );
        expect(rows[0]?.waiting).toBe(true);
      },
      { timeout: 3000 },
    );
  } finally {
    store.markUnavailable();
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  await rename;
  expect(writeNative).not.toHaveBeenCalled();
});
