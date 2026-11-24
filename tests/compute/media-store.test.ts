import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { MEDIA_PROFILE, MEDIA_VERSION, mediaObjectPrefix } from '@mio/compute-contracts';
import type { MediaManifest, MediaRequest, MediaResult } from '@mio/compute-contracts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { ComputeStore } from '../../src/compute/store.ts';
import { ComputeError } from '../../src/compute/errors.ts';
import { MediaStore } from '../../src/compute/media-store.ts';
import { acceptMedia } from '../../src/compute/media-results.ts';
import { controlMedia } from '../../src/compute/media-mutations.ts';
import type { MediaJobRow } from '../../src/compute/media-model.ts';
import { authDatabase } from '../support/auth-database.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let store: MediaStore;
let transcode: ComputeStore;
let assetId: string;
let key: string;
const owner = 'media-owner';
beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(computeSchemaSQL);
  await pool.query(computeSchemaSQL);
  store = new MediaStore(pool);
  transcode = new ComputeStore(pool);
}, 45000);
afterAll(async () => {
  if (store) await store.close();
  if (database) await database.close();
}, 30000);
beforeEach(async () => {
  await pool.query(
    'TRUNCATE mio_compute_inbox,mio_compute_outbox,mio_compute_jobs,mio_media_inbox,mio_media_outbox,mio_media_retries,mio_media_controls,mio_media_files,mio_media_jobs,mio_assets CASCADE',
  );
  assetId = randomUUID();
  key = `mio/raw/${assetId}/${randomUUID()}`;
  await pool.query(
    "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at) VALUES($1,$2,'source.mp4','video/mp4',3,$3,$4,'ready',now()+interval '1 day')",
    [assetId, owner, `mio/staging/${assetId}`, key],
  );
});
function request(requestId = randomUUID()): Extract<MediaRequest, { operation: 'video.trim' }> {
  return {
    requestId,
    operation: 'video.trim',
    inputs: [{ assetId }],
    parameters: { startSeconds: 0, endSeconds: 2 },
  };
}
function create(value: MediaRequest = request(), who = owner) {
  return store.create(who, value, [{ assetId, key, sizeBytes: 3, etag: 'input-etag' }]);
}
function event(job: MediaJobRow): Extract<MediaResult, { state: 'running' }> {
  return {
    version: MEDIA_VERSION,
    type: 'media.result',
    messageId: randomUUID(),
    commandId: job.command_id,
    jobId: job.id,
    attemptId: job.attempt_id,
    attempt: job.attempt,
    state: 'running',
    stage: 'encode',
    progress: 0.5,
  };
}
function failed(
  job: MediaJobRow,
  errorCode: Extract<MediaResult, { state: 'failed' }>['errorCode'] = 'INPUT_INVALID',
): MediaResult {
  const { stage: _stage, progress: _progress, ...base } = event(job);
  void _stage;
  void _progress;
  return { ...base, state: 'failed', errorCode };
}
function succeeded(job: MediaJobRow): Extract<MediaResult, { state: 'succeeded' }> {
  const { stage: _stage, progress: _progress, ...base } = event(job);
  void _stage;
  void _progress;
  return {
    ...base,
    state: 'succeeded',
    manifest: {
      key: mediaObjectPrefix(job.id, job.attempt_id) + 'manifest.json',
      sizeBytes: 100,
      etag: 'manifest',
      sha256: 'a'.repeat(64),
    },
  };
}
function manifest(job: MediaJobRow): MediaManifest {
  return {
    version: MEDIA_VERSION,
    jobId: job.id,
    attemptId: job.attempt_id,
    profile: MEDIA_PROFILE,
    operation: job.operation,
    files: [
      {
        key: mediaObjectPrefix(job.id, job.attempt_id) + 'result.mp4',
        name: 'result.mp4',
        role: 'primary',
        contentType: 'video/mp4',
        sizeBytes: 7,
        etag: 'result-etag',
        sha256: 'b'.repeat(64),
      },
    ],
    data: { trimmed: true },
  };
}
it('serializes admission, normalizes object keys and freezes snapshots and one outbox', async () => {
  const value = request();
  const rows = await Promise.all(Array.from({ length: 8 }, () => create(value)));
  expect(rows.filter((r) => r.created)).toHaveLength(1);
  const job = rows[0]!.job;
  const reordered = { ...value, parameters: { endSeconds: 2, startSeconds: 0 } };
  expect((await create(reordered)).job.id).toBe(job.id);
  await expect(
    create({ ...value, parameters: { endSeconds: 3, startSeconds: 0 } }),
  ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  const claim = await store.claim('encode');
  expect(claim?.command).toMatchObject({
    profile: MEDIA_PROFILE,
    inputs: [{ assetId, key, sizeBytes: 3, etag: 'input-etag' }],
  });
  expect(await store.claim('encode')).toBeUndefined();
  await store.sent(claim!.command, randomUUID());
  expect((await store.ownerView(job.id, owner))?.state).toBe('accepted');
  await store.release(claim!.command.messageId, claim!.lease);
  const replay = await store.claim('encode');
  expect(replay?.command).toEqual(claim!.command);
  await store.sent(replay!.command, replay!.lease);
  expect((await store.ownerView(job.id, owner))?.state).toBe('queued');
});
it('checks ownership and ready state, serializes quotas and rolls back failed outbox writes', async () => {
  await expect(create(request(), 'other')).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  await pool.query("UPDATE mio_assets SET state='pending' WHERE id=$1", [assetId]);
  await expect(create()).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  await pool.query("UPDATE mio_assets SET state='ready' WHERE id=$1", [assetId]);
  await pool.query(
    'ALTER TABLE mio_media_outbox ADD CONSTRAINT fail_media_outbox CHECK(false) NOT VALID',
  );
  try {
    await expect(create()).rejects.toThrow();
    expect(await store.list(owner)).toHaveLength(0);
  } finally {
    await pool.query('ALTER TABLE mio_media_outbox DROP CONSTRAINT fail_media_outbox');
  }
  const jobs = await Promise.allSettled(Array.from({ length: 12 }, () => create()));
  expect(jobs.filter((j) => j.status === 'fulfilled')).toHaveLength(10);
  expect(jobs.filter((j) => j.status === 'rejected')).toHaveLength(2);
  const first = (await store.list(owner))[0]!;
  expect(await store.ownerView(first.id, 'other')).toBeUndefined();
  expect(await store.list('other')).toHaveLength(0);
});
it('shares a total three-attempt budget across automatic and independently idempotent manual retries', async () => {
  const first = (await create()).job;
  await store.accept(failed(first));
  const retryId = randomUUID();
  const retries = await Promise.all(
    Array.from({ length: 8 }, () => store.retry(owner, first.id, retryId)),
  );
  expect(new Set(retries.map((j) => j.attempt_id)).size).toBe(1);
  const second = retries[0]!;
  expect(second.attempt).toBe(2);
  expect(second.inputs).toEqual(first.inputs);
  await store.accept(failed(second, 'STORAGE_FAILURE'));
  const third = (await store.ownerView(first.id, owner))!;
  expect(third.attempt).toBe(3);
  await store.accept(failed(third, 'WORKER_INTERRUPTED'));
  expect((await store.retry(owner, first.id, retryId)).attempt).toBe(3);
  await expect(store.retry(owner, first.id, randomUUID())).rejects.toMatchObject({
    code: 'MEDIA_RETRY_NOT_ALLOWED',
  });
  expect((await pool.query('SELECT * FROM mio_media_outbox')).rows).toHaveLength(3);
});
it.each(['INPUT_CHANGED', 'INPUT_INVALID', 'EXECUTION_FAILED', 'DISK_FULL'] as const)(
  'does not spend an automatic attempt on permanent or unclassified failure %s',
  async (code) => {
    const job = (await create()).job;
    await store.accept(failed(job, code));
    expect(await store.ownerView(job.id, owner)).toMatchObject({
      state: 'failed',
      attempt: 1,
      attempt_id: job.attempt_id,
      error_code: code,
    });
    expect((await pool.query('SELECT * FROM mio_media_outbox')).rows).toHaveLength(1);
  },
);
it('keeps unknown attempts recoverable without retries or progress rollback, and deduplicates inbox', async () => {
  const first = (await create()).job;
  const running = event(first);
  await store.accept(running);
  await store.accept(running);
  await expect(store.accept({ ...running, progress: 0.7 })).rejects.toMatchObject({
    code: 'RESULT_CONFLICT',
  });
  const { stage: _stage, progress: _progress, ...base } = event(first);
  void _stage;
  void _progress;
  await store.accept({ ...base, state: 'reconciling', errorCode: 'PROCESS_UNKNOWN' });
  await store.accept(event(first));
  expect((await store.ownerView(first.id, owner))?.state).toBe('reconciling');
  await expect(store.retry(owner, first.id, randomUUID())).rejects.toMatchObject({
    code: 'MEDIA_RETRY_NOT_ALLOWED',
  });
  await store.control(owner, first.id, 'recover');
  await store.control(owner, first.id, 'recover');
  const commands = (await pool.query('SELECT command FROM mio_media_outbox')).rows;
  expect(commands).toHaveLength(2);
  expect(commands[1].command).toMatchObject({
    type: 'media.control',
    action: 'recover',
    attemptId: first.attempt_id,
  });
  await store.accept(failed(first, 'WORKER_INTERRUPTED'));
  const second = (await store.ownerView(first.id, owner))!;
  await store.accept(succeeded(first), manifest(first));
  await store.accept(event(first));
  expect((await store.ownerView(first.id, owner))?.attempt_id).toBe(second.attempt_id);
});
it('commits cancel intent and control together, then lets cancellation win over late success without assets', async () => {
  const job = (await create()).job;
  await pool.query(
    'ALTER TABLE mio_media_outbox ADD CONSTRAINT fail_cancel_outbox CHECK(false) NOT VALID',
  );
  try {
    await expect(store.control(owner, job.id, 'cancel')).rejects.toThrow();
    expect((await store.ownerView(job.id, owner))?.cancel_requested).toBe(false);
  } finally {
    await pool.query('ALTER TABLE mio_media_outbox DROP CONSTRAINT fail_cancel_outbox');
  }
  await Promise.all(Array.from({ length: 6 }, () => store.control(owner, job.id, 'cancel')));
  expect((await store.ownerView(job.id, owner))?.state).toBe('cancel_requested');
  expect((await pool.query('SELECT * FROM mio_media_controls')).rows).toHaveLength(1);
  await store.accept(succeeded(job), manifest(job));
  expect((await store.ownerView(job.id, owner))?.state).toBe('cancelled');
  expect((await store.ownerView(job.id, owner))?.outputs).toHaveLength(0);
  expect(
    (await pool.query("SELECT * FROM mio_assets WHERE asset_kind='derived'")).rows,
  ).toHaveLength(0);
});
async function waitForJobRowLock() {
  await vi.waitFor(async () => {
    const waiting = await pool.query(`
      SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND usename=current_user AND wait_event_type='Lock'
      AND query LIKE 'SELECT * FROM mio_media_jobs%FOR UPDATE'
    `);
    expect(waiting.rowCount).toBe(1);
  });
}

it('lets a committed cancel intent win when success waits behind its row lock', async () => {
  const job = (await create()).job;
  const client = await pool.connect();
  let accepting: Promise<void> | undefined;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM mio_media_jobs WHERE id=$1 FOR UPDATE', [job.id]);
    await controlMedia(client, job, 'cancel');
    accepting = store.accept(succeeded(job), manifest(job));
    void accepting.catch(() => {});
    await waitForJobRowLock();
    await client.query('COMMIT');
    await accepting;
    expect(await store.ownerView(job.id, owner)).toMatchObject({ state: 'cancelled', outputs: [] });
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await accepting;
  }
});

it('atomically registers files and data once and permits only owned derived inputs', async () => {
  const job = (await create()).job;
  const result = succeeded(job);
  const actual = manifest(job);
  await store.accept(result, actual);
  await store.accept(result, actual);
  const completed = (await store.ownerView(job.id, owner))!;
  expect(completed).toMatchObject({ state: 'succeeded', data: { trimmed: true } });
  expect(completed.outputs).toHaveLength(1);
  const assetId = completed.outputs[0]!.assetId;
  const file = actual.files[0]!;
  expect(await store.inputs(owner, [assetId])).toMatchObject([
    { raw_key: file.key, size_bytes: '7' },
  ]);
  expect(await store.inputs('other', [assetId])).toEqual([]);
  await store.accept(event(job));
  expect((await store.ownerView(job.id, owner))?.state).toBe('succeeded');
  const probe: MediaRequest = {
    requestId: randomUUID(),
    operation: 'media.probe',
    inputs: [{ assetId }],
    parameters: {},
  };
  const snapshot = [{ assetId, key: file.key, sizeBytes: 7, etag: file.etag }];
  await store.create(owner, probe, snapshot);
  await expect(store.create('other', probe, snapshot)).rejects.toMatchObject({
    code: 'ASSET_NOT_FOUND',
  });
  await pool.query('UPDATE mio_assets SET source_etag=$2 WHERE id=$1', [assetId, 'new-etag']);
  await expect(
    store.create(owner, { ...probe, requestId: randomUUID() }, snapshot),
  ).rejects.toMatchObject({ code: 'ASSET_SOURCE_CHANGED' });
});
it('rolls back inbox, both assets and status when the second file registration is rejected', async () => {
  const job = (await create()).job;
  const output = manifest(job);
  output.files.push({
    ...output.files[0]!,
    key: mediaObjectPrefix(job.id, job.attempt_id) + 'reject.mp4',
    name: 'reject.mp4',
  });
  await pool.query(
    "ALTER TABLE mio_media_files ADD CONSTRAINT reject_second_media_file CHECK (name <> 'reject.mp4') NOT VALID",
  );
  try {
    await expect(store.accept(succeeded(job), output)).rejects.toMatchObject({
      constraint: 'reject_second_media_file',
    });
    expect((await pool.query('SELECT id FROM mio_media_inbox')).rows).toEqual([]);
    expect((await pool.query("SELECT id FROM mio_assets WHERE asset_kind='derived'")).rows).toEqual(
      [],
    );
    expect((await pool.query('SELECT asset_id FROM mio_media_files')).rows).toEqual([]);
    expect(await store.ownerView(job.id, owner)).toMatchObject({ state: 'accepted', outputs: [] });
  } finally {
    await pool.query('ALTER TABLE mio_media_files DROP CONSTRAINT reject_second_media_file');
  }
});
it('reclaims expired outbox leases without letting a stale publisher acknowledge the newer lease', async () => {
  await create();
  const first = (await store.claim('encode'))!;
  await pool.query(
    "UPDATE mio_media_outbox SET lease_until=now()-interval '1 second' WHERE id=$1",
    [first.command.messageId],
  );
  const second = (await store.claim('encode'))!;
  expect(second.command).toEqual(first.command);
  expect(second.lease).not.toBe(first.lease);
  await store.sent(first.command, first.lease);
  await store.release(first.command.messageId, first.lease);
  expect(await store.claim('encode')).toBeUndefined();
  expect((await pool.query('SELECT sent_at,lease_id FROM mio_media_outbox')).rows[0]).toMatchObject(
    { sent_at: null, lease_id: second.lease },
  );
  await store.sent(second.command, second.lease);
  expect((await pool.query('SELECT sent_at FROM mio_media_outbox')).rows[0].sent_at).toBeInstanceOf(
    Date,
  );
});
it('keeps committed success when cancellation waits behind its registration transaction', async () => {
  const job = (await create()).job;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acceptMedia(client, succeeded(job), manifest(job));
    const cancel = store.control(owner, job.id, 'cancel');
    void cancel.catch(() => {});
    await waitForJobRowLock();
    await client.query('COMMIT');
    expect((await cancel).state).toBe('succeeded');
    expect((await store.ownerView(job.id, owner))?.outputs).toHaveLength(1);
    expect((await pool.query('SELECT * FROM mio_media_controls')).rows).toHaveLength(0);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

it('rolls back the original result and reconciliation fact together, then permits same-ID revalidation', async () => {
  const job = (await create()).job;
  const result = succeeded(job);
  await pool.query(
    "ALTER TABLE mio_media_jobs ADD CONSTRAINT fail_reconciliation CHECK(state<>'reconciling') NOT VALID",
  );
  try {
    await expect(store.accept(result, undefined, 'MEDIA_FILE_MISMATCH')).rejects.toThrow();
    expect((await pool.query('SELECT * FROM mio_media_inbox')).rows).toHaveLength(0);
    expect((await store.ownerView(job.id, owner))?.state).toBe('accepted');
  } finally {
    await pool.query('ALTER TABLE mio_media_jobs DROP CONSTRAINT fail_reconciliation');
  }
  await store.accept(result, undefined, 'MEDIA_FILE_MISMATCH');
  await store.accept(result, undefined, 'MEDIA_FILE_MISMATCH');
  expect(await store.recoveryResult(job)).toEqual(result);
  expect((await pool.query('SELECT payload FROM mio_media_inbox')).rows[0].payload).toEqual({
    ...result,
    _verificationErrors: ['MEDIA_FILE_MISMATCH'],
  });
  await expect(
    store.accept({ ...result, manifest: { ...result.manifest, sha256: 'c'.repeat(64) } }),
  ).rejects.toMatchObject({ code: 'RESULT_CONFLICT' });
  await store.accept(result, manifest(job));
  expect(await store.ownerView(job.id, owner)).toMatchObject({
    state: 'succeeded',
    attempt_id: job.attempt_id,
    attempt: 1,
  });
  expect((await store.ownerView(job.id, owner))?.outputs).toHaveLength(1);
});
it('retains recovery authority when another success references a conflicting manifest', async () => {
  const job = (await create()).job,
    result = succeeded(job);
  await store.accept(result, undefined, 'MEDIA_MANIFEST_MISMATCH');
  await store.accept(
    {
      ...result,
      messageId: randomUUID(),
      manifest: { ...result.manifest, sha256: 'c'.repeat(64) },
    },
    manifest(job),
  );
  expect(await store.ownerView(job.id, owner)).toMatchObject({
    state: 'reconciling',
    error_code: 'RESULT_CONFLICT',
    attempt: 1,
  });
  expect(await store.recoveryResult(job)).toEqual(result);
  expect((await store.ownerView(job.id, owner))?.outputs).toHaveLength(0);
  await store.accept(result, manifest(job));
  expect((await store.ownerView(job.id, owner))?.state).toBe('succeeded');
});
it('rolls back a replacement recover control if its new outbox write fails', async () => {
  const job = (await create()).job;
  const { stage: _stage, progress: _progress, ...base } = event(job);
  void _stage;
  void _progress;
  await store.accept({ ...base, state: 'reconciling', errorCode: 'PROCESS_UNKNOWN' });
  await store.control(owner, job.id, 'recover');
  const first = (await pool.query('SELECT message_id FROM mio_media_controls')).rows[0].message_id;
  await pool.query('UPDATE mio_media_outbox SET sent_at=now() WHERE id=$1', [first]);
  await pool.query(
    'ALTER TABLE mio_media_outbox ADD CONSTRAINT fail_recover_outbox CHECK(false) NOT VALID',
  );
  try {
    await expect(store.control(owner, job.id, 'recover')).rejects.toThrow();
    expect((await pool.query('SELECT message_id FROM mio_media_controls')).rows[0].message_id).toBe(
      first,
    );
    expect((await pool.query('SELECT * FROM mio_media_outbox')).rows).toHaveLength(2);
  } finally {
    await pool.query('ALTER TABLE mio_media_outbox DROP CONSTRAINT fail_recover_outbox');
  }
  await store.control(owner, job.id, 'recover');
  expect(
    (await pool.query('SELECT message_id FROM mio_media_controls')).rows[0].message_id,
  ).not.toBe(first);
  expect((await pool.query('SELECT * FROM mio_media_outbox')).rows).toHaveLength(3);
});

it('lets cancellation win over replay of a durable verification conflict', async () => {
  const job = (await create()).job,
    result = succeeded(job);
  await store.accept(result, undefined, 'MEDIA_FILE_MISMATCH');
  await Promise.all(Array.from({ length: 4 }, () => store.control(owner, job.id, 'cancel')));
  await store.accept(result, undefined, 'MEDIA_FILE_MISMATCH');
  await store.accept(result, manifest(job));
  expect(await store.ownerView(job.id, owner)).toMatchObject({
    state: 'cancelled',
    attempt: 1,
    attempt_id: job.attempt_id,
  });
  expect((await store.ownerView(job.id, owner))?.outputs).toHaveLength(0);
  expect(
    (await pool.query("SELECT * FROM mio_media_controls WHERE action='cancel'")).rows,
  ).toHaveLength(1);
});

function createTranscode(requestId = randomUUID()) {
  return transcode.create(owner, requestId, assetId, key, 3, 'input-etag');
}
it.each(['transcode', 'media'] as const)(
  'counts ten active %s jobs against both protocols and preserves full-quota idempotency',
  async (version) => {
    const transcodeCase = version === 'transcode';
    const firstId = randomUUID();
    const first = transcodeCase ? await createTranscode(firstId) : await create(request(firstId));
    for (let i = 1; i < 10; i++) {
      if (transcodeCase) await createTranscode();
      else {
        const job = (await create()).job;
        if (i % 2) await store.control(owner, job.id, 'cancel');
        else await store.accept(succeeded(job), undefined, 'MEDIA_FILE_MISMATCH');
      }
    }
    await expect(createTranscode()).rejects.toBeInstanceOf(ComputeError);
    await expect(createTranscode()).rejects.toMatchObject({
      status: 429,
      code: 'COMPUTE_QUOTA_EXCEEDED',
    });
    await expect(create()).rejects.toBeInstanceOf(ComputeError);
    await expect(create()).rejects.toMatchObject({ status: 429, code: 'COMPUTE_QUOTA_EXCEEDED' });
    const replay = transcodeCase ? await createTranscode(firstId) : await create(request(firstId));
    expect(replay).toMatchObject({ created: false, job: { id: first.job.id } });
    if (transcodeCase) {
      await expect(
        transcode.create(owner, firstId, randomUUID(), key, 3, 'input-etag'),
      ).rejects.toMatchObject({ status: 409, code: 'REQUEST_CONFLICT' });
      await pool.query("UPDATE mio_compute_jobs SET state='failed' WHERE id=$1", [first.job.id]);
      await create();
    } else {
      await expect(
        create({ ...request(firstId), parameters: { startSeconds: 0, endSeconds: 3 } }),
      ).rejects.toMatchObject({ status: 409, code: 'REQUEST_CONFLICT' });
      await store.accept(failed(first.job as MediaJobRow));
      await createTranscode();
    }
  },
);
it('serializes mixed transcode/media concurrent admission at the shared user limit', async () => {
  const outcomes = await Promise.allSettled(
    Array.from({ length: 24 }, (_, i) => (i % 2 ? createTranscode() : create())),
  );
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(10);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      expect(outcome.reason).toBeInstanceOf(ComputeError);
      expect(outcome.reason).toMatchObject({ status: 429, code: 'COMPUTE_QUOTA_EXCEEDED' });
    }
  }
  const counts =
    await pool.query(`SELECT (SELECT count(*) FROM mio_compute_jobs)+(SELECT count(*) FROM mio_media_jobs) AS jobs,
    (SELECT count(*) FROM mio_compute_outbox)+(SELECT count(*) FROM mio_media_outbox) AS commands`);
  expect(counts.rows[0]).toEqual({ jobs: '10', commands: '10' });
});
it.each(['transcode', 'media'] as const)(
  'counts both protocols at the global limit when %s admission takes the final slot',
  async (version) => {
    await pool.query(
      `INSERT INTO mio_compute_jobs(id,owner_id,request_id,input_asset_id,input_key,input_size,input_etag,state,attempt,attempt_id,command_id)
    SELECT gen_random_uuid(),'bulk-transcode-'||n,gen_random_uuid(),$1,$2,3,'raw','running',1,gen_random_uuid(),gen_random_uuid() FROM generate_series(1,250) n`,
      [assetId, key],
    );
    await pool.query(
      `INSERT INTO mio_media_jobs(id,owner_id,request_id,request_hash,operation,parameters,inputs,profile,state,attempt,attempt_id,command_id)
    SELECT gen_random_uuid(),'bulk-media-'||n,gen_random_uuid(),'fixture','media.probe','{}','[]',$1,
      CASE WHEN n%2=0 THEN 'reconciling' ELSE 'cancel_requested' END,1,gen_random_uuid(),gen_random_uuid() FROM generate_series(1,249) n`,
      [MEDIA_PROFILE],
    );
    if (version === 'transcode') await createTranscode();
    else await create();
    await expect(createTranscode()).rejects.toMatchObject({
      status: 429,
      code: 'COMPUTE_QUOTA_EXCEEDED',
    });
    await expect(create()).rejects.toMatchObject({ status: 429, code: 'COMPUTE_QUOTA_EXCEEDED' });
    // Terminal jobs release capacity; compete for one slot using separate pooled connections.
    await pool.query(
      "UPDATE mio_media_jobs SET state='cancelled' WHERE id=(SELECT id FROM mio_media_jobs WHERE owner_id='bulk-media-1')",
    );
    const outcomes = await Promise.allSettled([createTranscode(), create()]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(ComputeError);
        expect(outcome.reason).toMatchObject({ status: 429, code: 'COMPUTE_QUOTA_EXCEEDED' });
      }
    const counts = await pool.query(`SELECT count(*) AS active FROM (
    SELECT id FROM mio_compute_jobs WHERE state IN ('accepted','queued','running')
    UNION ALL SELECT id FROM mio_media_jobs WHERE state NOT IN ('succeeded','failed','cancelled')) active`);
    expect(counts.rows[0].active).toBe('500');
  },
);
it('applies the shared user quota to manual media retries while keeping retry request IDs idempotent', async () => {
  const job = (await create()).job;
  await store.accept(failed(job));
  for (let i = 0; i < 10; i++) await createTranscode();
  const retryId = randomUUID();
  await expect(store.retry(owner, job.id, retryId)).rejects.toMatchObject({
    status: 429,
    code: 'COMPUTE_QUOTA_EXCEEDED',
  });
  expect((await store.ownerView(job.id, owner))?.attempt).toBe(1);
  expect((await pool.query('SELECT * FROM mio_media_retries')).rows).toHaveLength(0);
  await pool.query(
    "UPDATE mio_compute_jobs SET state='succeeded' WHERE id=(SELECT id FROM mio_compute_jobs LIMIT 1)",
  );
  const retried = await store.retry(owner, job.id, retryId);
  expect(retried.attempt).toBe(2);
  expect((await store.retry(owner, job.id, retryId)).attempt_id).toBe(retried.attempt_id);
  await expect(createTranscode()).rejects.toMatchObject({
    status: 429,
    code: 'COMPUTE_QUOTA_EXCEEDED',
  });
});

it('keeps progress monotonic within a stage, resets on a new stage and completes at one', async () => {
  const job = (await create()).job;
  await store.accept({ ...event(job), stage: 'encode', progress: 0.8 });
  await store.accept({ ...event(job), stage: 'encode', progress: 0.2 });
  expect(await store.ownerView(job.id, owner)).toMatchObject({
    state: 'running',
    stage: 'encode',
    progress: 0.8,
  });
  await store.accept({ ...event(job), stage: 'upload', progress: 0.1 });
  expect(await store.ownerView(job.id, owner)).toMatchObject({
    state: 'running',
    stage: 'upload',
    progress: 0.1,
  });
  await store.accept(succeeded(job), manifest(job));
  expect(await store.ownerView(job.id, owner)).toMatchObject({ state: 'succeeded', progress: 1 });
});
