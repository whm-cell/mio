import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Pool } from 'pg';
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import {
  creationLogSchemaSQL,
  checkCreationLogSchema,
} from '../../src/notifications/creation-schema.ts';
import { createCreationLogStore } from '../../src/notifications/creation-store.ts';
import { createCreationLogHandler } from '../../src/notifications/creation-http.ts';
import { writeCreationLog } from '../../src/notifications/creation-write.ts';
import type {
  CreationLogInput,
  CreationCursor,
} from '../../src/notifications/creation-contracts.ts';

let db: Awaited<ReturnType<typeof authDatabase>>, pool: Pool;
let store: Awaited<ReturnType<typeof createCreationLogStore>>;
let days: number | null = null;
let policyDown = false;
const event = (overrides: Partial<CreationLogInput> = {}): CreationLogInput => ({
  ownerId: 'owner-a',
  mediaType: 'audio',
  jobId: randomUUID(),
  eventKind: 'completed',
  title: '作品已保存',
  summary: '可查看作品。',
  occurredAt: new Date().toISOString(),
  ...overrides,
});
beforeAll(async () => {
  db = await authDatabase();
  pool = new Pool({ connectionString: db.url });
  await pool.query(creationLogSchemaSQL);
  store = await createCreationLogStore(db.url, () => {
    if (policyDown) throw new Error('policy expired');
    return days;
  });
});
beforeEach(async () => {
  days = null;
  policyDown = false;
  await pool.query('TRUNCATE mio_creation_logs,mio_audio_creation_receipts');
});
afterAll(async () => {
  await store?.close();
  await pool?.end();
  await db?.close();
});

it('previews without a database and preserves rows across explicit idempotent migration and readonly startup', async () => {
  const preview = spawnSync(process.execPath, ['scripts/service/migrate-creation-logs.ts'], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  expect(preview.status, preview.stderr).toBe(0);
  expect(preview.stdout.trim()).toBe(creationLogSchemaSQL.trim());
  await store.receiveAudio(randomUUID(), event());
  const before = (await pool.query('SELECT * FROM mio_creation_logs')).rows;
  await pool.query(creationLogSchemaSQL);
  await checkCreationLogSchema(pool);
  expect((await pool.query('SELECT * FROM mio_creation_logs')).rows).toEqual(before);
  const url = new URL(db.url);
  url.searchParams.set(
    'options',
    `${url.searchParams.get('options')} -cdefault_transaction_read_only=on`,
  );
  const readonly = await createCreationLogStore(url.toString(), () => null);
  expect((await readonly.list('owner-a', 1, 10)).items).toHaveLength(1);
  await readonly.close();
});

it('atomically rolls back both audio receipt and log, then deduplicates concurrent delivery preserving original time', async () => {
  await pool.query(`CREATE FUNCTION fail_creation_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture insert failure'; END $$;
    CREATE TRIGGER fail_creation_log BEFORE INSERT ON mio_creation_logs FOR EACH ROW EXECUTE FUNCTION fail_creation_log()`);
  const id = randomUUID(),
    input = event({ occurredAt: new Date(Date.now() - 3600000).toISOString() });
  await expect(store.receiveAudio(id, input)).rejects.toThrow('fixture insert failure');
  expect((await pool.query('SELECT * FROM mio_audio_creation_receipts')).rowCount).toBe(0);
  await pool.query(
    'DROP TRIGGER fail_creation_log ON mio_creation_logs; DROP FUNCTION fail_creation_log()',
  );
  await Promise.all(Array.from({ length: 8 }, () => store.receiveAudio(id, input)));
  const logs = (await store.list('owner-a', 1, 10)).items;
  expect(logs).toHaveLength(1);
  expect(logs[0]?.occurredAt).toBe(input.occurredAt);
  await store.receiveAudio(randomUUID(), { ...input, occurredAt: new Date().toISOString() });
  expect((await store.list('owner-a', 1, 10)).items).toEqual(logs);
});

it('does not resurrect deleted audio through short/long retention changes or an event beyond the hard seven-day window', async () => {
  const id = randomUUID(),
    input = event({ occurredAt: new Date(Date.now() - 3 * 86400000).toISOString() });
  await store.receiveAudio(id, input);
  days = 1;
  await store.cleanup();
  days = 21;
  await store.receiveAudio(id, input);
  expect((await store.list('owner-a', 1, 10)).items).toHaveLength(0);
  await store.receiveAudio(
    randomUUID(),
    event({ occurredAt: new Date(Date.now() - 8 * 86400000).toISOString() }),
  );
  expect((await pool.query('SELECT * FROM mio_audio_creation_receipts')).rowCount).toBe(2);
  expect((await pool.query('SELECT * FROM mio_creation_logs')).rowCount).toBe(0);
});

it('applies retention to existing records, read writes and old cursors; extension reveals retained rows only', async () => {
  const old = event({
    mediaType: 'image',
    occurredAt: new Date(Date.now() - 10 * 86400000).toISOString(),
  });
  await writeCreationLog(pool.query.bind(pool), old);
  await writeCreationLog(
    pool.query.bind(pool),
    event({ occurredAt: new Date(Date.now() - 1000).toISOString() }),
  );
  const first = await store.list('owner-a', 1, 1);
  expect(first.hasMore).toBe(true);
  const cursor = JSON.parse(
    Buffer.from(first.nextCursor!, 'base64url').toString(),
  ) as CreationCursor;
  const oldId = (await store.list('owner-a', 2, 10, cursor)).items[0]!.id;
  await store.markRead('owner-a', oldId);
  days = 7;
  expect((await store.list('owner-a', 2, 10, cursor)).items).toEqual([]);
  await expect(store.markRead('owner-a', oldId)).rejects.toMatchObject({ status: 404 });
  days = 21;
  expect((await store.list('owner-a', 2, 10, cursor)).items[0]).toMatchObject({
    id: oldId,
    isRead: true,
  });
  days = 7;
  await store.cleanup();
  days = 21;
  expect((await store.list('owner-a', 1, 100)).items.map((x) => x.id)).not.toContain(oldId);
});

it('paginates mixed media at identical microsecond times without duplicates, skips or another owner', async () => {
  for (let i = 0; i < 25; i++) {
    const input = event({
      mediaType: (['image', 'video', 'audio'] as const)[i % 3]!,
      ownerId: i === 24 ? 'owner-b' : 'owner-a',
    });
    await writeCreationLog(pool.query.bind(pool), input);
  }
  await pool.query("UPDATE mio_creation_logs SET occurred_at='2026-11-27T01:02:03.123456Z'");
  let cursor: CreationCursor | undefined;
  const ids: string[] = [];
  for (let page = 1; page <= 3; page++) {
    const result = await store.list('owner-a', page, 10, cursor);
    ids.push(...result.items.map((x) => x.id));
    cursor = result.nextCursor
      ? JSON.parse(Buffer.from(result.nextCursor, 'base64url').toString())
      : undefined;
    expect(result.hasMore).toBe(page < 3);
  }
  expect(ids).toHaveLength(24);
  expect(new Set(ids).size).toBe(24);
  const expected = (
    await pool.query(
      "SELECT id FROM mio_creation_logs WHERE owner_id='owner-a' ORDER BY occurred_at DESC,id DESC",
    )
  ).rows.map((x) => x.id);
  expect(ids).toEqual(expected);
  await expect(store.markRead('owner-b', ids[0]!)).rejects.toMatchObject({ status: 404 });
});

it('limits each cleanup to 100 rows, skips locks, rechecks policy and expires receipts with unlimited log retention', async () => {
  await pool.query(`INSERT INTO mio_creation_logs(id,owner_id,media_type,job_id,event_kind,title,summary,occurred_at)
    SELECT gen_random_uuid(),'owner-a','image',gen_random_uuid(),'completed','title','summary',now()-interval '10 days' FROM generate_series(1,205)`);
  const locked = await pool.connect();
  await locked.query('BEGIN');
  const keep = (
    await locked.query(
      'SELECT id FROM mio_creation_logs ORDER BY occurred_at,id LIMIT 1 FOR UPDATE',
    )
  ).rows[0]!.id;
  try {
    days = 7;
    await store.cleanup();
    expect((await pool.query('SELECT * FROM mio_creation_logs')).rowCount).toBe(105);
    days = 21;
    await store.cleanup();
    expect((await pool.query('SELECT * FROM mio_creation_logs WHERE id=$1', [keep])).rowCount).toBe(
      1,
    );
  } finally {
    await locked.query('ROLLBACK');
    locked.release();
  }
  days = null;
  await pool.query(
    "INSERT INTO mio_audio_creation_receipts(event_id,recorded_at) VALUES($1,now()-interval '8 days'),($2,now()-interval '7 days')",
    [randomUUID(), randomUUID()],
  );
  await store.cleanup();
  expect((await pool.query('SELECT * FROM mio_audio_creation_receipts')).rowCount).toBe(1);
  expect((await pool.query('SELECT * FROM mio_creation_logs')).rowCount).toBe(105);
  policyDown = true;
  await expect(store.list('owner-a', 1, 10)).rejects.toThrow('policy expired');
});

it('enforces cookie identity and exact Origin for PATCH, validates cursors and persists an idempotent read', async () => {
  await store.receiveAudio(randomUUID(), event());
  const id = (await store.list('owner-a', 1, 10)).items[0]!.id;
  const identity = vi.fn(async (headers: Headers) =>
    headers.get('cookie') === 'session=a'
      ? { userId: 'owner-a' }
      : headers.get('cookie') === 'session=b'
        ? { userId: 'owner-b' }
        : null,
  );
  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error();
  const origin = `http://127.0.0.1:${addr.port}`;
  const handler = createCreationLogHandler(store, identity, [origin]);
  const read = (cookie = 'session=a', o: string | undefined = origin) =>
    fetch(`${origin}/api/v1/notifications/${id}/read`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json', ...(o ? { origin: o } : {}) },
      body: '{}',
    });
  try {
    expect(
      (
        await fetch(`${origin}/api/v1/notifications?type=creation_log`, {
          headers: { authorization: 'Bearer service-token' },
        })
      ).status,
    ).toBe(401);
    expect((await read('session=a', 'https://wrong.invalid')).status).toBe(403);
    expect((await read('session=a', '')).status).toBe(403);
    expect((await read('session=b')).status).toBe(404);
    expect((await read()).status).toBe(200);
    const before = (await pool.query('SELECT read_at FROM mio_creation_logs WHERE id=$1', [id]))
      .rows[0];
    expect((await read()).status).toBe(200);
    expect(
      (await pool.query('SELECT read_at FROM mio_creation_logs WHERE id=$1', [id])).rows[0],
    ).toEqual(before);
    const bad = await fetch(`${origin}/api/v1/notifications?type=creation_log&cursor=bad`, {
      headers: { cookie: 'session=a' },
    });
    expect(bad.status).toBe(400);
    const good = await fetch(`${origin}/api/v1/notifications?type=creation_log`, {
      headers: { cookie: 'session=a' },
    });
    expect(good.headers.get('cache-control')).toBe('no-store');
    expect((await good.json()).items[0].isRead).toBe(true);
    await store.receiveAudio(
      randomUUID(),
      event({ occurredAt: new Date(Date.now() - 1000).toISOString() }),
    );
    const first = await (
      await fetch(`${origin}/api/v1/notifications?type=creation_log&pageSize=1`, {
        headers: { cookie: 'session=a' },
      })
    ).json();
    expect(first.hasMore).toBe(true);
    expect(JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString()).occurredAt).toMatch(
      /\.\d{6}Z$/,
    );
    const next = await fetch(
      `${origin}/api/v1/notifications?type=creation_log&page=2&pageSize=1&cursor=${first.nextCursor}`,
      {
        headers: { cookie: 'session=a' },
      },
    );
    expect(next.status).toBe(200);
    const second = await next.json();
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect(second.hasMore).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});

it('keeps valid very large positive retention days readable without PostgreSQL interval overflow', async () => {
  await writeCreationLog(
    pool.query.bind(pool),
    event({ mediaType: 'image', occurredAt: new Date(Date.now() - 15 * 86400000).toISOString() }),
  );
  days = Number.MAX_SAFE_INTEGER;
  const old = (await store.list('owner-a', 1, 10)).items[0]!;
  await store.markRead('owner-a', old.id);
  await store.receiveAudio(randomUUID(), event());
  await store.cleanup();
  expect((await store.list('owner-a', 1, 10)).items).toHaveLength(2);
});

it('still expires fixed-TTL audio receipts after the retention policy snapshot has failed', async () => {
  const expired = randomUUID(),
    recent = randomUUID();
  await pool.query(
    "INSERT INTO mio_audio_creation_receipts(event_id,recorded_at) VALUES($1,now()-interval '8 days'),($2,now()-interval '7 days')",
    [expired, recent],
  );
  await writeCreationLog(
    pool.query.bind(pool),
    event({ mediaType: 'image', occurredAt: new Date(Date.now() - 15 * 86400000).toISOString() }),
  );
  policyDown = true;
  await expect(store.cleanup()).rejects.toThrow('policy expired');
  expect((await pool.query('SELECT event_id FROM mio_audio_creation_receipts')).rows).toEqual([
    { event_id: recent },
  ]);
  expect((await pool.query('SELECT id FROM mio_creation_logs')).rowCount).toBe(1);
  await expect(store.list('owner-a', 1, 10)).rejects.toThrow('policy expired');
});
