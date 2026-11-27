import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { MEDIA_OPERATIONS, mediaResourceClass } from '@mio/compute-contracts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { mediaSchemaSQL, checkMediaSchema } from '../../src/compute/media/schema.ts';
import { MediaStore } from '../../src/compute/media/store.ts';
import type { MediaJobRow, MediaJobViewRow } from '../../src/compute/media/model.ts';
import { authDatabase } from '../support/auth-database.ts';
import { mediaSchemaV8SQL, mediaListV8SQL } from './media-schema-v8-fixture.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let store: MediaStore;
beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(computeSchemaSQL);
  process.stdout.write(
    'B07 PostgreSQL environment ' +
      JSON.stringify(
        (await pool.query('SELECT version(),current_database() AS database')).rows[0],
      ) +
      '\n',
  );
  store = new MediaStore(pool);
}, 45000);
afterAll(async () => {
  if (pool) await pool.end();
  if (database) await database.close();
}, 30000);
beforeEach(async () => {
  await pool.query(
    'DROP TABLE IF EXISTS mio_media_outbox,mio_media_inbox,mio_media_retries,mio_media_controls,mio_media_files,mio_media_jobs CASCADE',
  );
  await pool.query('TRUNCATE mio_assets CASCADE');
});
async function jobs(owner: string, count: number, files: number) {
  await pool.query(
    `INSERT INTO mio_media_jobs(id,owner_id,request_id,request_hash,operation,parameters,inputs,profile,state,attempt,attempt_id,command_id,created_at)
    SELECT gen_random_uuid(),$1,gen_random_uuid(),'historical','video.derivatives','{}','[]','standard-media',
      'succeeded',1,gen_random_uuid(),gen_random_uuid(),'2026-01-01'::timestamptz FROM generate_series(1,$2)`,
    [owner, count],
  );
  if (!files) return;
  await pool.query(
    `WITH inventory AS (
      SELECT gen_random_uuid() AS asset_id,j.id AS job_id,n,'file-'||lpad(n::text,5,'0') AS name
      FROM mio_media_jobs j CROSS JOIN generate_series(1,$2::int) n WHERE j.owner_id=$1
    ), assets AS (
      INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,raw_key,state,expires_at,asset_kind)
      SELECT asset_id,$1,name,'video/mp2t',7,'fixture/'||asset_id,'ready',now(),'derived' FROM inventory RETURNING id
    ) INSERT INTO mio_media_files(asset_id,job_id,name,role,object_key,size_bytes,etag,sha256,content_type,ordinal)
      SELECT i.asset_id,i.job_id,i.name,CASE WHEN i.n<=2 THEN 'hls' ELSE 'segment' END,
        'fixture/'||i.asset_id,7,'fixture',repeat('a',64),CASE WHEN i.n<=2 THEN 'application/vnd.apple.mpegurl' ELSE 'video/mp2t' END,
        $2-i.n FROM inventory i JOIN assets a ON a.id=i.asset_id ORDER BY i.job_id,i.n`,
    [owner, files],
  );
}

it('migrates persisted outbox lanes and pre-ordinal files without changing old commands, leases or INSERT callers', async () => {
  // This historical schema precedes the baseline's final additive ordinal statement.
  await pool.query(
    mediaSchemaV8SQL.slice(0, mediaSchemaV8SQL.indexOf('ALTER TABLE mio_media_files')),
  );
  await jobs('historical', 1, 0);
  const job = (await pool.query<MediaJobRow>('SELECT * FROM mio_media_jobs')).rows[0]!;
  const operations = [
    ...MEDIA_OPERATIONS.map((operation) => ({ type: 'media.request', operation })),
    { type: 'media.control' },
  ];
  for (const [index, command] of operations.entries()) {
    await pool.query(
      `INSERT INTO mio_media_outbox(id,job_id,command,lease_id,lease_until,sent_at)
      VALUES($1,$2,$3,$4,CASE WHEN $4::uuid IS NULL THEN NULL ELSE now()+interval '5 minutes' END,
        CASE WHEN $5 THEN now() ELSE NULL END)`,
      [
        randomUUID(),
        job.id,
        JSON.stringify(command),
        index === 0 ? randomUUID() : null,
        index === 1,
      ],
    );
  }
  const old = (await pool.query('SELECT * FROM mio_media_outbox ORDER BY id')).rows;
  // Also exercise the no-ordinal old file path with tied historical default order.
  for (const name of ['z.ts', 'a.ts']) {
    const assetId = randomUUID();
    await pool.query(
      "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,raw_key,state,expires_at) VALUES($1,'historical',$2,'video/mp2t',7,$3,'ready',now())",
      [assetId, name, 'fixture/' + assetId],
    );
    await pool.query(
      "INSERT INTO mio_media_files(asset_id,job_id,name,role,object_key,size_bytes,etag,sha256,content_type) VALUES($1,$2,$3,'segment',$4,7,'fixture','sha','video/mp2t')",
      [assetId, job.id, name, 'fixture/' + assetId],
    );
  }
  await pool.query(mediaSchemaSQL);
  await pool.query(mediaSchemaSQL);
  await checkMediaSchema(pool);
  const current = (await pool.query('SELECT * FROM mio_media_outbox ORDER BY id')).rows;
  expect(
    current.map(({ lane: _lane, ...row }) => {
      void _lane;
      return row;
    }),
  ).toEqual(old);
  for (const row of current)
    expect(row.lane).toBe(
      row.command.type === 'media.control' ? 'control' : mediaResourceClass(row.command.operation),
    );
  await pool.query('INSERT INTO mio_media_outbox(id,job_id,command) VALUES($1,$2,$3)', [
    randomUUID(),
    job.id,
    JSON.stringify({ type: 'media.request', operation: 'audio.waveform' }),
  ]);
  expect(
    (
      await pool.query(
        "SELECT lane FROM mio_media_outbox WHERE command->>'operation'='audio.waveform'",
      )
    ).rows.every((row) => row.lane === 'probe'),
  ).toBe(true);
  expect((await store.ownerView(job.id, 'historical'))?.outputs.map((file) => file.name)).toEqual([
    'a.ts',
    'z.ts',
  ]);
  expect((await pool.query('SELECT DISTINCT ordinal FROM mio_media_files')).rows).toEqual([
    { ordinal: 0 },
  ]);
  expect(
    (await pool.query("SELECT to_regclass('mio_media_outbox_pending') AS old")).rows[0].old,
  ).toBeNull();
  expect(
    (
      await pool.query(
        "SELECT attgenerated FROM pg_attribute WHERE attrelid='mio_media_outbox'::regclass AND attname='lane'",
      )
    ).rows[0].attgenerated,
  ).toBe('s');
});

it('uses the lane partial index for actual claims while excluding confirmed rows and active leases', async () => {
  await pool.query(mediaSchemaSQL);
  await jobs('lane-plan', 1, 0);
  const job = (await pool.query<MediaJobRow>('SELECT * FROM mio_media_jobs')).rows[0]!;
  await pool.query(
    `INSERT INTO mio_media_outbox(id,job_id,command,sent_at)
    SELECT gen_random_uuid(),$1,'{"type":"media.request","operation":"video.trim"}',now() FROM generate_series(1,10000)`,
    [job.id],
  );
  for (const operation of ['video.trim', 'media.probe', 'audio.waveform', 'scenes.detect']) {
    await pool.query('INSERT INTO mio_media_outbox(id,job_id,command) VALUES($1,$2,$3)', [
      randomUUID(),
      job.id,
      JSON.stringify({ type: 'media.request', operation }),
    ]);
  }
  await pool.query(
    'INSERT INTO mio_media_outbox(id,job_id,command) VALUES($1,$2,\'{"type":"media.control"}\')',
    [randomUUID(), job.id],
  );
  await pool.query('ANALYZE mio_media_outbox');
  const captured = vi.spyOn(pool, 'query');
  const claim = await store.claim('probe');
  const [sql, parameters] = captured.mock.calls[0]!;
  captured.mockRestore();
  expect(claim).toBeDefined();
  expect(String(sql)).toContain('AND lane=$2');
  const plan = (await pool.query('EXPLAIN (FORMAT JSON) ' + String(sql), parameters)).rows[0][
    'QUERY PLAN'
  ];
  process.stdout.write('B07 PostgreSQL lane plan ' + JSON.stringify(plan) + '\n');
  expect(JSON.stringify(plan)).toContain('mio_media_outbox_lane_pending');
  expect(JSON.stringify(plan)).not.toContain('CASE');
  const pending = (
    await pool.query(
      "SELECT id FROM mio_media_outbox WHERE sent_at IS NULL AND lane='probe' AND lease_id IS NULL ORDER BY created_at,id",
    )
  ).rows;
  const next = await store.claim('probe');
  expect(next?.command).toMatchObject({ type: 'media.request' });
  expect(
    (await pool.query('SELECT id FROM mio_media_outbox WHERE lease_id=$1', [next!.lease])).rows[0]
      .id,
  ).toBe(pending[0].id);
  const claimedId = (
    await pool.query('SELECT id FROM mio_media_outbox WHERE lease_id=$1', [claim!.lease])
  ).rows[0].id;
  await store.release(claimedId, randomUUID());
  expect(
    (await pool.query('SELECT lease_id FROM mio_media_outbox WHERE id=$1', [claimedId])).rows[0]
      .lease_id,
  ).toBe(claim!.lease);
});

it.each([
  { count: 105, files: 8 },
  { count: 10, files: 4096 },
])(
  'compares unchanged list contract with Route A at $count jobs x $files outputs',
  async ({ count, files }) => {
    await pool.query(mediaSchemaSQL);
    await jobs('list-probe', count, files);
    await pool.query('ANALYZE mio_media_files');
    const baseline = async () =>
      (await pool.query<MediaJobViewRow>(mediaListV8SQL, ['list-probe'])).rows;
    const expected = await baseline();
    const queryCalls = vi.spyOn(Client.prototype, 'query');
    let fileQuery: unknown[];
    try {
      expect(await store.list('list-probe')).toEqual(expected);
      const dataCalls = queryCalls.mock.calls.filter(([sql]) => String(sql).startsWith('SELECT'));
      expect(dataCalls).toHaveLength(2);
      expect(queryCalls.mock.calls.map(([sql]) => String(sql))).toEqual([
        'BEGIN',
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
        String(dataCalls[0]![0]),
        String(dataCalls[1]![0]),
        'COMMIT',
      ]);
      fileQuery = dataCalls[1]!;
    } finally {
      queryCalls.mockRestore();
    }
    expect(expected).toHaveLength(Math.min(count, 100));
    expect(expected.every((job) => job.outputs.length === files)).toBe(true);
    expect(expected.every((job) => job.outputs.some((file) => file.role === 'segment'))).toBe(true);
    expect((await store.hlsPackage(expected[0]!.id, 'list-probe', false))?.files).toHaveLength(2);
    expect((await store.hlsPackage(expected[0]!.id, 'list-probe', true))?.files).toHaveLength(
      files,
    );
    expect(await store.hlsPackage(expected[0]!.id, 'foreign', false)).toBeUndefined();
    const measurements: { baselineMs: number; routeAMs: number }[] = [];
    for (let i = 0; i < 6; i++) {
      let baselineMs = 0,
        routeAMs = 0;
      const old = async () => {
        const start = performance.now();
        await baseline();
        baselineMs = performance.now() - start;
      };
      const candidate = async () => {
        const start = performance.now();
        await store.list('list-probe');
        routeAMs = performance.now() - start;
      };
      if (i % 2) {
        await candidate();
        await old();
      } else {
        await old();
        await candidate();
      }
      measurements.push({ baselineMs, routeAMs });
    }
    const fileRows = (await pool.query(String(fileQuery[0]), fileQuery[1] as string[][])).rows;
    const selectedRows = expected.map(({ outputs, ...job }) => {
      void outputs;
      return job;
    });
    const routeABytes =
      Buffer.byteLength(JSON.stringify(selectedRows)) + Buffer.byteLength(JSON.stringify(fileRows));
    const plan = (
      await pool.query(
        'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT asset_id,name FROM mio_media_files WHERE job_id=$1 ORDER BY ordinal,name',
        [expected[0]!.id],
      )
    ).rows[0]['QUERY PLAN'];
    process.stdout.write(
      'B07 list Route A comparison ' +
        JSON.stringify({
          count,
          files,
          returned: expected.length,
          baselineQueries: 1,
          routeAQueries: 2,
          baselineStatements: 1,
          routeAStatements: 5,
          routeAIsolation: 'repeatable read / read only',
          timing: 'pool acquisition + BEGIN + SET + both data reads + JS assembly + COMMIT/release',
          baselineBytes: Buffer.byteLength(JSON.stringify(expected)),
          routeABytes,
          measurements,
          fileOrderPlan: plan,
        }) +
        '\n',
    );
    expect(expected[0]!.outputs.map((file) => file.name)).toEqual(
      Array.from({ length: files }, (_, index) => `file-${String(files - index).padStart(5, '0')}`),
    );
    expect(
      (
        await pool.query(
          "SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='mio_media_files_order'",
        )
      ).rows[0].indexdef,
    ).toContain('(job_id, ordinal, name)');
    // Large selections can legitimately favor bitmap + sort; preserve that actual plan above.
    if (files === 8) expect(JSON.stringify(plan)).toContain('mio_media_files_order');
  },
);

it('uses one list read for empty or nonsucceeded selections and never reads their files', async () => {
  await pool.query(mediaSchemaSQL);
  await jobs('nonsucceeded', 3, 0);
  await pool.query("UPDATE mio_media_jobs SET state='accepted'");
  const queryCalls = vi.spyOn(Client.prototype, 'query');
  try {
    expect(
      (await store.list('nonsucceeded')).every(
        (job) => job.state === 'accepted' && job.outputs.length === 0,
      ),
    ).toBe(true);
    expect(queryCalls).toHaveBeenCalledTimes(4);
    expect(queryCalls.mock.calls.filter(([sql]) => String(sql).startsWith('SELECT'))).toHaveLength(
      1,
    );
    expect(await store.list('foreign')).toEqual([]);
    expect(queryCalls).toHaveBeenCalledTimes(8);
    expect(queryCalls.mock.calls.filter(([sql]) => String(sql).startsWith('SELECT'))).toHaveLength(
      2,
    );
    expect(queryCalls.mock.calls.every(([sql]) => !String(sql).includes('mio_media_files'))).toBe(
      true,
    );
  } finally {
    queryCalls.mockRestore();
  }
});

it('uses the same backend and real read-only repeatable snapshot for both reads across a concurrent file commit', async () => {
  await pool.query(mediaSchemaSQL);
  await jobs('snapshot-owner', 2, 8);
  const expected = (await pool.query<MediaJobViewRow>(mediaListV8SQL, ['snapshot-owner'])).rows;
  const writer = new Pool({ connectionString: database.url, max: 1 });
  const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const original = Client.prototype.query;
  const settings: { pid: number; readonly: string; isolation: string; snapshot: string }[] = [];
  const calls: string[] = [];
  let injected = false;
  const query = vi.spyOn(Client.prototype, 'query').mockImplementation(function (
    this: Client,
    ...args: unknown[]
  ) {
    const sql = typeof args[0] === 'string' ? args[0] : '';
    const data =
      sql.startsWith('SELECT * FROM mio_media_jobs WHERE owner_id=') ||
      sql.startsWith('SELECT job_id,asset_id AS');
    if (data || sql === 'BEGIN' || sql.startsWith('SET TRANSACTION') || sql === 'COMMIT')
      calls.push(sql);
    const result = Reflect.apply(original, this, args);
    if (!data) return result;
    return result.then(async (rows: unknown) => {
      settings.push(
        (
          await Reflect.apply(original, this, [
            `SELECT pg_backend_pid() AS pid,
        current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation,
        pg_current_snapshot()::text AS snapshot`,
          ])
        ).rows[0],
      );
      if (!injected) {
        injected = true;
        // A direct mutation of isolated fixture rows tests MVCC itself, independently
        // of the production rule that succeeded files are immutable.
        await writer.query(
          "UPDATE mio_media_files SET name='after-snapshot-'||name WHERE job_id=$1",
          [expected[0]!.id],
        );
      }
      return rows;
    });
  });
  try {
    expect(await store.list('snapshot-owner')).toEqual(expected);
    expect(calls).toHaveLength(5);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    expect(calls.filter((sql) => sql.startsWith('SELECT'))).toHaveLength(2);
    expect(calls.at(-1)).toBe('COMMIT');
    expect(settings).toHaveLength(2);
    expect(settings[0]).toMatchObject({ readonly: 'on', isolation: 'repeatable read' });
    expect(settings[1]).toEqual(settings[0]);
    expect(settings[0]!.pid).not.toBe(writerPid);
    process.stdout.write(
      'B07_MEDIA_SNAPSHOT ' +
        JSON.stringify({ settings, writerPid, statements: calls, dataStatements: 2 }) +
        '\n',
    );
  } finally {
    query.mockRestore();
    await writer.end();
  }
  const next = await store.list('snapshot-owner');
  expect(
    next
      .find((job) => job.id === expected[0]!.id)!
      .outputs.every((file) => file.name.startsWith('after-snapshot-')),
  ).toBe(true);
  expect(await store.list('foreign')).toEqual([]);
});

it('rolls back a real failed file query and releases the same client with transaction defaults restored', async () => {
  await pool.query(mediaSchemaSQL);
  await jobs('failed-snapshot', 1, 8);
  const reader = new Pool({ connectionString: database.url, max: 1 });
  const media = new MediaStore(reader);
  const before = (
    await reader.query(`SELECT pg_backend_pid() AS pid,
    current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`)
  ).rows[0];
  const releases: { error: unknown; client: PoolClient }[] = [];
  reader.on('release', (error, client) => releases.push({ error, client }));
  const original = Client.prototype.query;
  const calls: string[] = [];
  const failedClients: Client[] = [];
  let root: unknown;
  const query = vi.spyOn(Client.prototype, 'query').mockImplementation(function (
    this: Client,
    ...args: unknown[]
  ) {
    const sql = typeof args[0] === 'string' ? args[0] : '';
    calls.push(sql);
    if (sql.startsWith('SELECT job_id,asset_id AS')) {
      failedClients.push(this);
      return Reflect.apply(original, this, [
        'SELECT b07_missing_file_column FROM mio_media_files',
      ]).catch((error: unknown) => {
        root = error;
        throw error;
      });
    }
    return Reflect.apply(original, this, args);
  });
  try {
    const failure = await media.list('failed-snapshot').catch((error: unknown) => error);
    expect(failure).toBe(root);
    expect(failure).toMatchObject({ code: '42703' });
    expect(calls).toHaveLength(5);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    expect(calls.filter((sql) => sql.startsWith('SELECT'))).toHaveLength(2);
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(releases).toHaveLength(1);
    expect(releases[0]!.error).toBeFalsy();
    expect(failedClients).toHaveLength(1);
    expect(releases[0]!.client).toBe(failedClients[0]);
    expect(reader.idleCount).toBe(1);
    query.mockRestore();
    const after = (
      await reader.query(`SELECT pg_backend_pid() AS pid,
      current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`)
    ).rows[0];
    expect(after).toEqual(before);
    expect(after).toMatchObject({ readonly: 'off', isolation: 'read committed' });
    expect((await media.list('failed-snapshot'))[0]!.outputs).toHaveLength(8);
    process.stdout.write(
      'B07_MEDIA_SNAPSHOT_ROLLBACK ' +
        JSON.stringify({
          before,
          after,
          statements: calls,
          code: '42703',
          released: true,
          reusedBackend: true,
        }) +
        '\n',
    );
  } finally {
    query.mockRestore();
    await reader.end();
  }
});
