import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ComputeResultV1 } from '@mio/compute-contracts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { checkComputeSchema, computeSchemaSQL } from '../../src/compute/schema.ts';
import { ComputeError } from '../../src/compute/errors.ts';
import { ComputeStore } from '../../src/compute/transcode/store.ts';
import { checkComputeCapacity, lockComputeCapacity } from '../../src/compute/capacity.ts';
import { authDatabase } from '../support/auth-database.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let store: ComputeStore;
let assetId: string;
let key: string;
const owner = 'compute-owner';

beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(computeSchemaSQL);
  await pool.query(computeSchemaSQL);
  store = new ComputeStore(pool);
}, 45000);
afterAll(async () => {
  if (store) await store.close();
  if (database) await database.close();
}, 30000);
beforeEach(async () => {
  await pool.query(
    'TRUNCATE mio_compute_inbox,mio_compute_outbox,mio_compute_jobs,mio_media_jobs,mio_assets CASCADE',
  );
  assetId = randomUUID();
  key = `mio/raw/${assetId}/${randomUUID()}`;
  await pool.query(
    "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at) VALUES($1,$2,'x.mp4','video/mp4',3,$3,$4,'ready',now()+interval '1 day')",
    [assetId, owner, `mio/staging/${assetId}`, key],
  );
});

function event(
  job: Awaited<ReturnType<ComputeStore['create']>>['job'],
  state: ComputeResultV1['state'],
): ComputeResultV1 {
  const base = {
    version: 1 as const,
    type: 'transcode.result' as const,
    messageId: randomUUID(),
    jobId: job.id,
    commandId: job.command_id,
    attemptId: job.attempt_id,
    attempt: job.attempt,
  };
  if (state === 'succeeded')
    return {
      ...base,
      state,
      output: {
        key: `mio/derived/${job.id}/${job.attempt_id}/result.mp4`,
        sizeBytes: 7,
        etag: 'output-etag',
        sha256: 'a'.repeat(64),
      },
    };
  if (state === 'failed') return { ...base, state, errorCode: 'TRANSCODE_FAILED' };
  if (state === 'unknown') return { ...base, state, errorCode: 'UPLOAD_UNKNOWN' };
  return { ...base, state: 'running' };
}
const create = (requestId: string = randomUUID(), who = owner) =>
  store.create(who, requestId, assetId, key, 3, 'raw-actual-etag');

it('serializes duplicate requests and atomically records one outbox command', async () => {
  const requestId = randomUUID();
  const results = await Promise.all(Array.from({ length: 8 }, () => create(requestId)));
  expect(results.filter((value) => value.created)).toHaveLength(1);
  expect(new Set(results.map((value) => value.job.id)).size).toBe(1);
  await expect(store.create(owner, requestId, randomUUID(), key, 3, 'other')).rejects.toMatchObject(
    { status: 409, code: 'REQUEST_CONFLICT' },
  );
  const rows = await pool.query<{ count: string }>('SELECT count(*) FROM mio_compute_outbox');
  expect(Number(rows.rows[0]!.count)).toBe(1);
  const first = await store.claim();
  expect(first?.command.input.etag).toBe('raw-actual-etag');
  expect(await store.claim()).toBeUndefined();
  await store.release(first!.command.messageId, first!.lease);
  const replay = await store.claim();
  expect(replay?.command).toEqual(first?.command);
  await store.sent(replay!.command, replay!.lease);
  expect((await store.owned(results[0]!.job.id, owner))?.state).toBe('queued');
});

it('enforces owner authorization and the ten unfinished jobs under concurrent admission', async () => {
  await expect(create(randomUUID(), 'other')).rejects.toMatchObject({
    status: 404,
    code: 'ASSET_NOT_FOUND',
  });
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => create()));
  expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(10);
  const rejected = results.filter(
    (value): value is PromiseRejectedResult => value.status === 'rejected',
  );
  expect(rejected).toHaveLength(2);
  expect(
    rejected.every(
      (value) =>
        value.reason instanceof ComputeError && value.reason.code === 'COMPUTE_QUOTA_EXCEEDED',
    ),
  ).toBe(true);
  expect(
    await store.owned(
      (
        results.find((value) => value.status === 'fulfilled') as PromiseFulfilledResult<
          Awaited<ReturnType<typeof create>>
        >
      ).value.job.id,
      'other',
    ),
  ).toBeUndefined();
});

it('enforces the global 500 limit across concurrent owners', async () => {
  const otherAsset = randomUUID();
  const otherKey = `mio/raw/${otherAsset}/${randomUUID()}`;
  await pool.query(
    "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at) VALUES($1,'other','x.mp4','video/mp4',3,$2,$3,'ready',now()+interval '1 day')",
    [otherAsset, `mio/staging/${otherAsset}`, otherKey],
  );
  await pool.query(
    `INSERT INTO mio_compute_jobs(id,owner_id,request_id,input_asset_id,input_key,input_size,input_etag,state,attempt,attempt_id,command_id)
    SELECT gen_random_uuid(),'bulk-' || n,gen_random_uuid(),$1,$2,3,'raw','accepted',1,gen_random_uuid(),gen_random_uuid() FROM generate_series(1,499) n`,
    [assetId, key],
  );
  const results = await Promise.allSettled([
    create(),
    store.create('other', randomUUID(), otherAsset, otherKey, 3, 'raw'),
  ]);
  expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((value) => value.status === 'rejected')).toHaveLength(1);
  expect(
    Number(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*) FROM mio_compute_jobs WHERE state IN ('accepted','queued','running')",
        )
      ).rows[0]!.count,
    ),
  ).toBe(500);
});

it('rolls back the job if writing the command outbox fails', async () => {
  await pool.query(
    'ALTER TABLE mio_compute_outbox ADD CONSTRAINT fail_outbox_test CHECK (false) NOT VALID',
  );
  try {
    await expect(create()).rejects.toThrow();
    expect(
      Number(
        (await pool.query<{ count: string }>('SELECT count(*) FROM mio_compute_jobs')).rows[0]!
          .count,
      ),
    ).toBe(0);
  } finally {
    await pool.query('ALTER TABLE mio_compute_outbox DROP CONSTRAINT fail_outbox_test');
  }
});

it('deduplicates events, retries at most three attempts, and ignores old and terminal updates', async () => {
  const first = (await create()).job;
  const running = event(first, 'running');
  await store.accept(running);
  await store.accept(running);
  await expect(
    store.accept({ ...running, state: 'unknown', errorCode: 'UPLOAD_UNKNOWN' }),
  ).rejects.toMatchObject({ code: 'RESULT_CONFLICT' });
  await store.accept(event(first, 'failed'));
  const second = (await store.owned(first.id, owner))!;
  expect(second.attempt).toBe(2);
  await store.accept(event(first, 'succeeded'));
  expect((await store.owned(first.id, owner))?.attempt_id).toBe(second.attempt_id);
  await store.accept(event(second, 'unknown'));
  expect((await store.owned(first.id, owner))?.state).toBe('running');
  await store.accept(event(second, 'failed'));
  const third = (await store.owned(first.id, owner))!;
  expect(third.attempt).toBe(3);
  await store.accept(event(third, 'failed'));
  await store.accept(event(third, 'running'));
  expect((await store.owned(first.id, owner))?.state).toBe('failed');
  const rows = await pool.query<{ count: string }>(
    'SELECT count(*) FROM mio_compute_outbox WHERE job_id=$1',
    [first.id],
  );
  expect(Number(rows.rows[0]!.count)).toBe(3);
});

it('commits a derived asset and terminal state in the same transaction without staging cleanup', async () => {
  const job = (await create()).job;
  const succeeded = event(job, 'succeeded');
  await store.accept(succeeded);
  await store.accept(succeeded);
  const completed = (await store.owned(job.id, owner))!;
  expect(completed.state).toBe('succeeded');
  const derived = (
    await pool.query('SELECT * FROM mio_assets WHERE id=$1', [completed.result_asset_id])
  ).rows[0];
  expect(derived).toMatchObject({
    owner_id: owner,
    state: 'ready',
    asset_kind: 'derived',
    staging_key: null,
  });
  expect(derived.staging_deleted_at).toBeInstanceOf(Date);
  expect(await store.input(owner, completed.result_asset_id!)).toBeUndefined();
  const rows = await pool.query<{ count: string }>(
    "SELECT count(*) FROM mio_assets WHERE asset_kind='derived'",
  );
  expect(Number(rows.rows[0]!.count)).toBe(1);
});

async function seedMediaJobs(count: number, ownerId: string, state: string) {
  await pool.query(
    `INSERT INTO mio_media_jobs
       (id,owner_id,request_id,request_hash,operation,parameters,inputs,profile,state,attempt,attempt_id,command_id)
     SELECT gen_random_uuid(),$1,gen_random_uuid(),'fixture','media.probe','{}','[]','standard-media',$2,1,gen_random_uuid(),gen_random_uuid()
     FROM generate_series(1,$3::integer)`,
    [ownerId, state, count],
  );
}

it('keeps prior job and outbox on an additive migration and opens the floor idempotently', async () => {
  const existing = await create();
  const original = await pool.query('SELECT command FROM mio_compute_outbox WHERE job_id=$1', [
    existing.job.id,
  ]);
  // This per-test PostgreSQL schema models the tables an existing revision would have installed.
  await pool.query(
    'DROP TABLE mio_media_controls,mio_media_retries,mio_media_files,mio_media_inbox,mio_media_outbox,mio_media_jobs',
  );
  await expect(checkComputeSchema(pool)).rejects.toMatchObject({ code: '42P01' });
  await pool.query(computeSchemaSQL);
  await pool.query(computeSchemaSQL);
  await expect(checkComputeSchema(pool)).resolves.toBeUndefined();
  expect(await store.owned(existing.job.id, owner)).toEqual(existing.job);
  expect(
    (await pool.query('SELECT command FROM mio_compute_outbox WHERE job_id=$1', [existing.job.id]))
      .rows,
  ).toEqual(original.rows);
});

it('counts media reconciliation and cancellation with legacy video and retains idempotency at capacity', async () => {
  await seedMediaJobs(7, owner, 'accepted');
  await seedMediaJobs(1, owner, 'reconciling');
  await seedMediaJobs(1, owner, 'cancel_requested');
  await seedMediaJobs(20, owner, 'succeeded');
  await seedMediaJobs(20, owner, 'cancelled');
  const last = await create();
  await expect(create()).rejects.toMatchObject({ status: 429, code: 'COMPUTE_QUOTA_EXCEEDED' });
  await expect(create(last.job.request_id)).resolves.toEqual({ job: last.job, created: false });
  await expect(
    store.create(owner, last.job.request_id, randomUUID(), key, 3, 'etag'),
  ).rejects.toMatchObject({ status: 409, code: 'REQUEST_CONFLICT' });
  await store.accept(event(last.job, 'failed'));
  expect((await store.owned(last.job.id, owner))?.attempt).toBe(2);
  await expect(create()).rejects.toMatchObject({ status: 429, code: 'COMPUTE_QUOTA_EXCEEDED' });
});

it('serializes mixed admissions for the last global place and releases it after rollback', async () => {
  await seedMediaJobs(499, 'other-owners', 'queued');
  const admitted = Promise.withResolvers<void>();
  const finishMedia = Promise.withResolvers<void>();
  const media = (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockComputeCapacity(client);
      await checkComputeCapacity(client, 'other-requester');
      await client.query(
        `INSERT INTO mio_media_jobs
           (id,owner_id,request_id,request_hash,operation,parameters,inputs,profile,state,attempt,attempt_id,command_id)
         VALUES(gen_random_uuid(),'other-requester',gen_random_uuid(),'fixture','media.probe','{}','[]','standard-media','accepted',1,gen_random_uuid(),gen_random_uuid())`,
      );
      admitted.resolve();
      await finishMedia.promise;
      await client.query('COMMIT');
    } catch (error) {
      admitted.reject(error);
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  })();
  void media.catch(() => {});
  await admitted.promise;
  let videoCompleted = false;
  const competing = create().finally(() => {
    videoCompleted = true;
  });
  void competing.catch(() => {});
  try {
    await vi.waitFor(
      async () => {
        expect(videoCompleted).toBe(false);
        const lock = await pool.query(
          `SELECT 1 FROM pg_locks JOIN pg_stat_activity USING(pid)
         WHERE locktype='advisory' AND NOT granted AND classid=0 AND objid=672049923
           AND application_name=$1`,
          [database.applicationName],
        );
        expect(lock.rowCount).toBe(1);
      },
      { timeout: 4000 },
    );
  } finally {
    finishMedia.resolve();
    await media;
  }
  await expect(competing).rejects.toMatchObject({ status: 429, code: 'COMPUTE_QUOTA_EXCEEDED' });
  await pool.query("UPDATE mio_media_jobs SET state='failed' WHERE owner_id='other-requester'");
  const invalidAsset = randomUUID();
  await expect(
    store.create(owner, randomUUID(), invalidAsset, key, 3, 'etag'),
  ).rejects.toMatchObject({ status: 404, code: 'ASSET_NOT_FOUND' });
  await expect(create()).resolves.toMatchObject({ created: true });
});
