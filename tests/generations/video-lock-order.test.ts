import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { legacyVideoRouteEntries } from '../../scripts/service/legacy-video-routes.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { VIDEO_GLOBAL_QUOTA, VIDEO_USER_QUOTA } from '../../src/generations/video/contracts.ts';
import type { VideoCreateRequest } from '../../src/generations/video/contracts.ts';
import type {
  VideoMaterializedOutput,
  VideoMaterializer,
} from '../../src/generations/video/execution.ts';
import { createVideoRunner } from '../../src/generations/video/runner.ts';
import type { VideoExecutorProvider } from '../../src/generations/video/runner.ts';
import { VideoGenerationStore } from '../../src/generations/video/store.ts';
import { VideoSubmissionReceipts } from '../../src/generations/video/submission-receipts.ts';
import { createVideoProtocol } from '../../src/integrations/onelink/video/index.ts';
import { authDatabase } from '../support/auth-database.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const inputHash = 'stable-input-hash';
const upstreamTaskId = 'original-upstream-task';
const videos = [{ url: 'https://media.fixture/video.mp4' }];
const modelId = 'doubao-seedance-1.5-pro';
const { vendor, driver, submitPath, queryPathTemplate, paramSpec } = legacyVideoRouteEntries([
  modelId,
])[0]!;
const routeSnapshot = {
  modelId,
  route: {
    vendor,
    driver,
    submitPath,
    queryPathTemplate,
    paramSpec,
    requestDefaults: {},
    outputSpec: {},
  },
};

async function fixture() {
  const database = await authDatabase();
  cleanups.push(database.close);
  const pool = new Pool({ connectionString: database.url, max: 2 });
  cleanups.push(() => pool.end());
  await pool.query(assetSchemaSQL);
  await pool.query(generationSchemaSQL);
  const connection = (role: string) => {
    const url = new URL(database.url);
    const name = database.applicationName + '_' + role;
    url.searchParams.set('application_name', name);
    const target = new Pool({ connectionString: url.toString(), max: 1 });
    cleanups.push(() => target.end());
    return { name, store: new VideoGenerationStore(target) };
  };
  const writer = connection('writer');
  const recovery = connection('recovery');
  const competing = connection('competing');
  const execution = writer.store.executorStore();
  const ownerId = randomUUID();
  const request: VideoCreateRequest = {
    requestId: randomUUID(),
    modelRef: 'onelink:model:' + randomUUID(),
    expectedCapabilitiesVersion: 'video-test',
    parameters: { mode: 'text_to_video', prompt: 'test', durationSeconds: 4 },
  };
  const admit = (owner: string, requestId: string = randomUUID()) => {
    const input = { ...request, requestId };
    return writer.store.create(
      owner,
      input,
      inputHash,
      { request: input, inputSnapshot: [] },
      {},
      { credential: {}, credentialVersion: 1 },
      routeSnapshot,
    );
  };
  const { jobId } = await admit(ownerId, request.requestId);
  const directory = await mkdtemp(join(tmpdir(), 'mio-video-lock-order-'));
  const receipts = new VideoSubmissionReceipts(directory);
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation(async (_url, options) =>
      Response.json(
        options?.method === 'POST'
          ? { id: upstreamTaskId }
          : { id: upstreamTaskId, status: 'succeeded', content: { video_url: videos[0]!.url } },
      ),
    );
  const provider = {
    snapshotVideo: vi.fn<VideoExecutorProvider['snapshotVideo']>().mockResolvedValue({
      capabilitiesVersion: request.expectedCapabilitiesVersion,
      credentialVersion: 1,
    } as Awaited<ReturnType<VideoExecutorProvider['snapshotVideo']>>),
    openImageSnapshot: () => 'fixture-key',
    resolveImageTaskCredential: async () => 'fixture-key',
    recordVerification: async () => {},
  } satisfies VideoExecutorProvider;
  const output: VideoMaterializedOutput = {
    index: 0,
    assetId: randomUUID(),
    key: 'mio/derived/video/' + randomUUID() + '.mp4',
    etag: 'fixture-etag',
    sha256: 'a'.repeat(64),
    sizeBytes: 400,
    contentType: 'video/mp4',
    width: 32,
    height: 32,
    durationMs: 4000,
    hasAudio: false,
  };
  const materialize: VideoMaterializer = async () => output;
  const run = createVideoRunner(
    execution,
    () => provider,
    materialize,
    new AbortController().signal,
    { protocol: createVideoProtocol, transport },
    receipts,
  );
  const next = async () => {
    await pool.query('UPDATE mio_video_executions SET next_query_at=now() WHERE job_id=$1', [
      jobId,
    ]);
    const row = await execution.claim();
    if (row?.id !== jobId) throw new Error('Expected to claim the original video job');
    return row;
  };
  const durable = async () =>
    (
      await pool.query(
        `SELECT j.id,j.owner_id,j.request_id,j.input_hash,j.state,j.error_code,j.completed_at,
              e.phase,e.upstream_task_id,e.query_attempt,e.async_deadline,e.async_max_queries,e.checkpoint
       FROM mio_video_jobs j JOIN mio_video_executions e ON e.job_id=j.id WHERE j.id=$1`,
        [jobId],
      )
    ).rows[0];
  const identity = {
    id: jobId,
    owner_id: ownerId,
    request_id: request.requestId,
    input_hash: inputHash,
  };
  return {
    pool,
    writer,
    recovery,
    competing,
    execution,
    ownerId,
    jobId,
    identity,
    admit,
    run,
    next,
    durable,
    output,
    transport,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function prepareCompletion(f: Fixture) {
  await f.run(await f.next());
  const querying = await f.execution.beginQuery(await f.next());
  if (!querying) throw new Error('Expected to reserve the original video query');
  expect(await f.execution.returned(querying, videos)).toBe(true);
  await f.execution.release(querying);
  return f.next();
}

async function blockedBy(pool: Pool, name: string, pid: number) {
  return vi.waitFor(
    async () => {
      const waiting = await pool.query<{ pid: number; wait_event: string }>(
        `SELECT pid,wait_event FROM pg_stat_activity WHERE application_name=$1
       AND $2=ANY(pg_blocking_pids(pid))`,
        [name, pid],
      );
      expect(waiting.rows).toHaveLength(1);
      return waiting.rows[0]!;
    },
    { timeout: 3000, interval: 10 },
  );
}

function observe(work: Promise<unknown>) {
  return work.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', code: (reason as { code?: string } | null)?.code }),
  );
}

async function raceRecovery(f: Fixture, trigger: string, write: () => Promise<unknown>) {
  const key = 'hashtext(current_schema()),1';
  await f.pool.query(
    `CREATE FUNCTION pause_video_write() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$`,
  );
  await f.pool.query(trigger);
  const gate = await f.pool.connect();
  const pending: ReturnType<typeof observe>[] = [];
  let outcomes: Awaited<ReturnType<typeof observe>>[];
  let firstWait: string;
  try {
    const { rows } = await gate.query<{ pid: number }>(
      `SELECT pg_advisory_lock(${key}),pg_backend_pid() AS pid`,
    );
    pending.push(observe(write()));
    const writer = await blockedBy(f.pool, f.writer.name, rows[0]!.pid);
    pending.push(observe(f.recovery.store.recover(f.ownerId, f.jobId)));
    const first = await blockedBy(f.pool, f.recovery.name, writer.pid);
    firstWait = first.wait_event;
    pending.push(observe(f.competing.store.recover(f.ownerId, f.jobId)));
    expect((await blockedBy(f.pool, f.competing.name, first.pid)).wait_event).toBe('advisory');
  } finally {
    await gate.query(`SELECT pg_advisory_unlock(${key})`).finally(() => gate.release());
    outcomes = await Promise.all(pending);
  }
  return { firstWait, outcomes };
}

it('completes a video through its output foreign key while competing recoveries wait', async () => {
  const f = await fixture();
  const row = await prepareCompletion(f);
  // The writer holds the execution row and has yet to take the output FK's job lock.
  const race = await raceRecovery(
    f,
    'CREATE TRIGGER pause_video_write BEFORE INSERT ON mio_video_outputs FOR EACH ROW EXECUTE FUNCTION pause_video_write()',
    () => f.run(row),
  );
  expect(race.firstWait).toBe('transactionid');
  expect(race.outcomes).toEqual([
    { status: 'fulfilled', value: undefined },
    { status: 'fulfilled', value: undefined },
    { status: 'fulfilled', value: undefined },
  ]);
  expect(await f.durable()).toMatchObject({
    ...f.identity,
    state: 'completed',
    phase: 'done',
    upstream_task_id: upstreamTaskId,
    query_attempt: 1,
    async_deadline: row.async_deadline,
    async_max_queries: row.async_max_queries,
  });
  expect(await f.writer.store.get(f.ownerId, f.jobId)).toMatchObject({
    outputs: [{ index: 0, assetId: f.output.assetId, status: 'registered' }],
  });
  expect(await f.execution.claim()).toBeUndefined();
  expect(f.transport.mock.calls.map(([, options]) => options?.method)).toEqual(['POST']);
});

it('settles the original video receipt while competing recoveries wait for quota', async () => {
  const f = await fixture();
  const row = await f.next();
  const race = await raceRecovery(
    f,
    `CREATE TRIGGER pause_video_write BEFORE UPDATE ON mio_video_jobs FOR EACH ROW
     WHEN (NEW.state='submitted') EXECUTE FUNCTION pause_video_write()`,
    () => f.run(row),
  );
  expect(race.firstWait).toBe('advisory');
  expect(race.outcomes).toEqual([
    { status: 'fulfilled', value: undefined },
    { status: 'rejected', code: 'RESULT_CONFLICT' },
    { status: 'rejected', code: 'RESULT_CONFLICT' },
  ]);
  expect(await f.durable()).toMatchObject({
    ...f.identity,
    state: 'submitted',
    phase: 'waiting',
    upstream_task_id: upstreamTaskId,
    query_attempt: 0,
  });
  await f.run(await f.next());
  expect(await f.durable()).toMatchObject({
    state: 'completed',
    phase: 'done',
    upstream_task_id: upstreamTaskId,
    query_attempt: 1,
  });
  expect(f.transport.mock.calls.map(([, options]) => options?.method)).toEqual(['POST', 'GET']);
});

it('enforces both quotas before competing recoveries resume the original checkpoint', async () => {
  const f = await fixture();
  const row = await prepareCompletion(f);
  expect(await f.execution.beginMaterialization(row, true)).toEqual({
    attempts: 1,
    reserved: true,
  });
  await f.execution.terminal(row, 'materialization_failed', 'VIDEO_MATERIALIZATION_FAILED');
  const failed = await f.durable();
  const freeSlot = async () => {
    const slot = await f.execution.claim();
    if (!slot) throw new Error('Expected an active job occupying quota');
    await f.execution.terminal(slot, 'failed', 'TEST_QUOTA_RELEASE');
  };
  for (let index = 0; index < VIDEO_USER_QUOTA; index++) await f.admit(f.ownerId);
  const recover = () => f.recovery.store.recover(f.ownerId, f.jobId);
  await expect(recover()).rejects.toMatchObject({ code: 'VIDEO_QUOTA_EXCEEDED' });
  expect(await f.durable()).toEqual(failed);
  await freeSlot();
  for (let index = VIDEO_USER_QUOTA - 1; index < VIDEO_GLOBAL_QUOTA; index++)
    await f.admit(randomUUID());
  await expect(recover()).rejects.toMatchObject({ code: 'VIDEO_QUOTA_EXCEEDED' });
  expect(await f.durable()).toEqual(failed);
  await freeSlot();

  await Promise.all([recover(), f.competing.store.recover(f.ownerId, f.jobId)]);
  const resumed = await f.next();
  expect(resumed.checkpoint).toMatchObject({
    videos,
    materializationAttempts: 0,
    recoveryQuery: { state: 'available' },
  });
  expect(
    (
      await f.pool.query(
        "SELECT count(*) AS total FROM mio_video_jobs WHERE state='accepted' OR state='materializing'",
      )
    ).rows[0]!.total,
  ).toBe(String(VIDEO_GLOBAL_QUOTA));
  await f.run(resumed);
  expect(await f.durable()).toMatchObject({
    ...f.identity,
    state: 'completed',
    phase: 'done',
    upstream_task_id: upstreamTaskId,
    query_attempt: 1,
    async_deadline: row.async_deadline,
    async_max_queries: row.async_max_queries,
  });
  expect(f.transport.mock.calls.map(([, options]) => options?.method)).toEqual(['POST']);
});
