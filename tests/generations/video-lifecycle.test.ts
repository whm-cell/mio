import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { AssetStore } from '../../src/assets/store.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { createVideoExecutor } from '../../src/generations/video/executor.ts';
import { createVideoInputResolver } from '../../src/generations/video/inputs.ts';
import { VideoSubmissionReceipts } from '../../src/generations/video/submission-receipts.ts';
import { VideoGenerationStore } from '../../src/generations/video/store.ts';
import { createVideoRunner } from '../../src/generations/video/runner.ts';
import type { VideoExecutorProvider, VideoTransports } from '../../src/generations/video/runner.ts';
import type {
  VideoJobCommand,
  VideoMaterializedOutput,
  VideoMaterializer,
  VideoProtocol,
  VideoProtocolFactory,
  VideoSubmitResult,
} from '../../src/generations/video/execution.ts';
import { VIDEO_EXECUTOR_QUERY_INTERVAL_MS } from '../../src/generations/video/execution.ts';
import type { VideoCreateRequest } from '../../src/generations/video/contracts.ts';
import { VIDEO_USER_QUOTA } from '../../src/generations/video/contracts.ts';
import { createVideoProtocol } from '../../src/integrations/onelink/video/index.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const queryRoutes = {
  ark: {
    modelId: 'doubao-seedance-1.5-pro',
    driver: 'volcengine-ark-videos',
    vendor: 'volcengine',
    submitPath: '/volc/api/v3/contents/generations/tasks',
    queryPathTemplate: '/volc/api/v3/contents/generations/tasks/{task_id}',
  },
  kling: {
    modelId: 'video-kling-v3',
    driver: 'kling-videos',
    vendor: 'kling',
    submitPath: '/kling/v1/videos/text2video',
    queryPathTemplate: '/kling/v1/videos/text2video/{task_id}',
  },
  happyhorse: {
    modelId: 'happyhorse-1.0-t2v',
    driver: 'happyhorse-videos',
    vendor: 'happyhorse',
    submitPath: '/happyhorse/v1/services/aigc/video-generation/video-synthesis',
    queryPathTemplate: '/happyhorse/v1/tasks/{task_id}',
  },
} as const;

async function fixture(reference?: 'frozen' | 'legacy', family: keyof typeof queryRoutes = 'ark') {
  const { modelId, ...route } = queryRoutes[family];
  const database = await authDatabase();
  cleanups.push(database.close);
  const pool = new Pool({ connectionString: database.url });
  cleanups.push(() => pool.end());
  await pool.query(assetSchemaSQL);
  await pool.query(generationSchemaSQL);
  const store = new VideoGenerationStore(pool);
  const execution = store.executorStore();
  cleanups.push(() => execution.close());
  await execution.startExecutor(() => {});
  const directory = await mkdtemp(join(tmpdir(), 'mio-video-lifecycle-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const receipts = new VideoSubmissionReceipts(directory);
  cleanups.push(() => receipts.close());
  const actor = { userId: randomUUID(), sessionId: 'video-lifecycle' };
  const assetId = randomUUID();
  const key = 'mio/raw/' + assetId;
  const etag = 'frozen-image-etag';
  if (reference)
    await pool.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,raw_key,state,expires_at,source_etag)
       VALUES ($1,$2,'first.png','image/png',256,$3,'ready',now(),$4)`,
      [assetId, actor.userId, key, etag],
    );
  const request: VideoCreateRequest = {
    requestId: randomUUID(),
    modelRef: 'onelink:model:' + randomUUID(),
    expectedCapabilitiesVersion: 'video-capability-test',
    parameters: reference
      ? { mode: 'first_frame', firstFrame: { assetId }, prompt: 'a tiny movie', durationSeconds: 4 }
      : { mode: 'text_to_video', prompt: 'a tiny movie', durationSeconds: 4 },
  };
  const create = (command: VideoJobCommand, owner = actor.userId) =>
    store.create(
      owner,
      command.request,
      'stable-input-hash',
      command,
      {
        providerConfigId: randomUUID(),
        modelKey: randomUUID(),
        credentialVersion: 1,
        catalogVersion: 1,
        adaptationVersion: 1,
        driver: route.driver,
      },
      {
        providerConfigId: randomUUID(),
        credentialVersion: 1,
        credential: {},
      },
      {
        modelId,
        route: {
          ...route,
          paramSpec: {
            supportedModes: ['text_to_video', 'first_frame'],
            parameters: {
              ratios: [],
              resolutions: [],
              durations: [4],
              maxPromptCodepoints: 5000,
              maxImages: 1,
              maxVideos: 0,
              maxAudios: 0,
              maxInputs: 1,
              maxSubjects: 0,
              maxSubjectImages: 0,
              generateAudio: false,
              watermark: false,
              offPeak: false,
              audioSettings: [],
              requiresResolution: false,
              referenceAudioRequiresVisual: false,
              referenceDurations: [],
            },
          },
          requestDefaults: {},
          outputSpec: {},
        },
      },
    );
  const job = await create({
    request,
    inputSnapshot: reference ? [{ assetId, mediaType: 'image', role: 'first_frame' }] : [],
    ...(reference === 'frozen' ? { inputObjects: { [assetId]: { key, etag } } } : {}),
  });
  const protocol: VideoProtocol = {
    submit: vi
      .fn<VideoProtocol['submit']>()
      .mockResolvedValue({ state: 'submitted', upstreamTaskId: 'safe-task' }),
    query: vi.fn<VideoProtocol['query']>().mockResolvedValue({
      state: 'returned',
      videos: [{ url: 'https://media.fixture/video.mp4' }],
    }),
  };
  const provider = {
    snapshotVideo: vi.fn<VideoExecutorProvider['snapshotVideo']>().mockResolvedValue({
      capabilitiesVersion: request.expectedCapabilitiesVersion,
      credentialVersion: 1,
    } as Awaited<ReturnType<VideoExecutorProvider['snapshotVideo']>>),
    openImageSnapshot: vi.fn(() => 'frozen-test-key'),
    resolveImageTaskCredential: vi.fn(async () => 'current-test-key'),
    recordVerification: vi.fn(async () => {}),
  } satisfies VideoExecutorProvider;
  const output: VideoMaterializedOutput = {
    index: 0,
    assetId: randomUUID(),
    key: 'mio/derived/video/' + randomUUID() + '.mp4',
    etag: 'verified-etag',
    sha256: 'a'.repeat(64),
    sizeBytes: 400,
    contentType: 'video/mp4',
    width: 32,
    height: 32,
    durationMs: 4000,
    hasAudio: false,
  };
  const materialize = vi.fn<VideoMaterializer>().mockResolvedValue([output]);
  const runner = (
    overrides: Partial<VideoTransports> = {},
    target = execution,
    durable = receipts,
  ) =>
    createVideoRunner(
      target,
      () => provider,
      materialize,
      new AbortController().signal,
      { protocol: () => protocol, ...overrides },
      durable,
    );
  const makeDue = () =>
    pool.query(
      "UPDATE mio_video_executions SET next_query_at=clock_timestamp()-interval '1 millisecond' WHERE job_id=$1",
      [job.jobId],
    );
  const next = async (target = execution) => {
    await makeDue();
    const row = await target.claim();
    expect(row).toBeDefined();
    return row!;
  };
  const durableState = async () =>
    (
      await pool.query(
        `SELECT j.state,j.error_code,j.completed_at,e.phase,e.claim_id,e.upstream_task_id,
       e.async_deadline,e.async_max_queries,e.query_attempt,e.next_query_at,e.checkpoint
       FROM mio_video_jobs j JOIN mio_video_executions e ON e.job_id=j.id WHERE j.id=$1`,
        [job.jobId],
      )
    ).rows[0];
  const databaseNow = async () =>
    (await pool.query<{ time: Date }>('SELECT clock_timestamp() AS time')).rows[0]!.time.getTime();
  const receiptPath = join(directory, 'video-submissions', job.jobId + '.json');
  const expectedReceipt = {
    version: 1 as const,
    jobId: job.jobId,
    ownerId: actor.userId,
    requestId: request.requestId,
    upstreamTaskId: 'safe-task',
  };
  return {
    pool,
    store,
    execution,
    directory,
    receiptPath,
    expectedReceipt,
    receipts,
    create,
    asset: { assetId, key, etag },
    actor,
    request,
    job,
    protocol,
    provider,
    output,
    materialize,
    run: runner(),
    runner,
    makeDue,
    next,
    durableState,
    databaseNow,
  };
}

describe('durable video execution', () => {
  it('recovers an owner result from the checkpoint without submitting another video', async () => {
    const f = await fixture();
    await f.run(await f.next());
    f.materialize.mockRejectedValueOnce(new Error('temporary storage error'));
    await f.run(await f.next());
    await f.pool.query(
      "UPDATE mio_video_executions SET checkpoint=jsonb_set(checkpoint,'{materializationAttempts}','3'::jsonb) WHERE job_id=$1",
      [f.job.jobId],
    );
    await f.run(await f.next());
    expect((await f.store.get(f.actor.userId, f.job.jobId)).state).toBe('materialization_failed');
    await expect(f.store.recover('another-owner', f.job.jobId)).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });
    await Promise.all([
      f.store.recover(f.actor.userId, f.job.jobId),
      f.store.recover(f.actor.userId, f.job.jobId),
    ]);
    await f.run(await f.next());
    expect((await f.store.get(f.actor.userId, f.job.jobId)).state).toBe('completed');
    expect(f.protocol.submit).toHaveBeenCalledTimes(1);
    await f.store.recover(f.actor.userId, f.job.jobId);
  });
  it('submits once, retains its upstream identity, and atomically registers the owner video asset', async () => {
    const f = await fixture();
    await f.run(await f.next());
    const submitted = await f.store.get(f.actor.userId, f.job.jobId);
    expect(submitted.state).toBe('submitted');
    expect(submitted.outputs).toEqual([]);
    await f.run(await f.next());
    const completed = await f.store.get(f.actor.userId, f.job.jobId);
    expect(completed.state).toBe('completed');
    expect(completed.outputs[0]).toMatchObject({
      assetId: f.output.assetId,
      status: 'registered',
      durationSeconds: 4,
    });
    expect(f.protocol.submit).toHaveBeenCalledTimes(1);
    expect(f.protocol.query).toHaveBeenCalledWith(
      'safe-task',
      'current-test-key',
      expect.any(AbortSignal),
    );
    expect(f.provider.recordVerification).toHaveBeenCalledTimes(1);
    const asset = (
      await f.pool.query(
        'SELECT owner_id,raw_key,content_type,asset_kind FROM mio_assets WHERE id=$1',
        [f.output.assetId],
      )
    ).rows[0];
    expect(asset).toEqual({
      owner_id: f.actor.userId,
      raw_key: f.output.key,
      content_type: 'video/mp4',
      asset_kind: 'derived',
    });
    await expect(f.store.get(randomUUID(), f.job.jobId)).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });
    expect(await f.execution.claim()).toBeUndefined();
  });

  it('never resubmits a POST whose response is unknown, including after restart', async () => {
    const f = await fixture();
    vi.mocked(f.protocol.submit).mockRejectedValue(new Error('connection lost after POST'));
    await f.run(await f.next());
    expect((await f.store.get(f.actor.userId, f.job.jobId)).state).toBe('unknown');
    await f.execution.close();
    await f.execution.startExecutor(() => {});
    expect(await f.execution.claim()).toBeUndefined();
    expect(f.protocol.submit).toHaveBeenCalledTimes(1);
  });

  it('reconciles a process that died after committing submitting as unknown without POST', async () => {
    const f = await fixture();
    const row = await f.next();
    expect(await f.execution.submitting(row)).toBe(true);
    await f.execution.close();
    await f.execution.startExecutor(() => {});
    const resumed = await f.next();
    expect(resumed.phase).toBe('submitting');
    await f.run(resumed);
    expect((await f.store.get(f.actor.userId, f.job.jobId)).state).toBe('unknown');
    expect(f.protocol.submit).not.toHaveBeenCalled();
  });

  it.each(['reserved floor', 'legacy null floor', 'later floor'])(
    'defers the same upstream GET after a lost querying process with %s and preserves its budget',
    async (floor) => {
      const f = await fixture();
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ id: 'safe-task' }))
        .mockResolvedValueOnce(Response.json({ id: 'safe-task', status: 'running' }));
      const run = f.runner({ protocol: createVideoProtocol, transport });
      await run(await f.next());
      const submitted = await f.durableState();
      const claimed = await f.next();
      const reserving = await f.databaseNow();
      expect(await f.execution.beginQuery(claimed)).toMatchObject({
        phase: 'querying',
        query_attempt: 1,
        claim_id: claimed.claim_id,
      });
      const reserved = await f.durableState();
      expect(reserved.next_query_at.getTime()).toBeGreaterThanOrEqual(
        reserving + VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
      );
      let laterFloor: Date | undefined;
      if (floor === 'legacy null floor')
        await f.pool.query('UPDATE mio_video_executions SET next_query_at=NULL WHERE job_id=$1', [
          f.job.jobId,
        ]);
      if (floor === 'later floor')
        laterFloor = (
          await f.pool.query<{ next_query_at: Date }>(
            `UPDATE mio_video_executions SET next_query_at=clock_timestamp()+interval '20 seconds'
             WHERE job_id=$1 RETURNING next_query_at`,
            [f.job.jobId],
          )
        ).rows[0]!.next_query_at;
      await f.execution.close();
      const takingOver = await f.databaseNow();
      await f.execution.startExecutor(() => {});
      const waiting = await f.durableState();
      expect(waiting).toMatchObject({
        phase: 'waiting',
        claim_id: null,
        upstream_task_id: 'safe-task',
        query_attempt: 1,
        async_deadline: submitted.async_deadline,
        async_max_queries: submitted.async_max_queries,
      });
      expect(waiting.next_query_at.getTime()).toBeGreaterThanOrEqual(
        takingOver + VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
      );
      if (floor === 'reserved floor')
        expect(waiting.next_query_at.getTime()).toBeGreaterThanOrEqual(
          reserved.next_query_at.getTime() + VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
        );
      if (laterFloor)
        expect(waiting.next_query_at.getTime()).toBe(
          laterFloor.getTime() + VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
        );
      expect(await f.execution.claim()).toBeUndefined();
      expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual(['POST']);
      await run(await f.next());
      expect(await f.durableState()).toMatchObject({ state: 'processing', query_attempt: 2 });
      expect(
        transport.mock.calls.map(([url, options]) => [
          new URL(String(url)).pathname,
          options?.method,
        ]),
      ).toEqual([
        [queryRoutes.ark.submitPath, 'POST'],
        [queryRoutes.ark.submitPath + '/safe-task', 'GET'],
      ]);
    },
  );

  it('does not issue a GET after the persisted deadline or count is exhausted', async () => {
    const f = await fixture();
    await f.run(await f.next());
    await f.pool.query(
      'UPDATE mio_video_executions SET query_attempt=async_max_queries WHERE job_id=$1',
      [f.job.jobId],
    );
    await f.run(await f.next());
    const result = await f.store.get(f.actor.userId, f.job.jobId);
    expect(result.state).toBe('failed');
    expect(result.error?.code).toBe('VIDEO_QUERY_LIMIT');
    expect(f.protocol.query).not.toHaveBeenCalled();
  });

  it('persists output locators before materialization, caps retries, and never repeats generation', async () => {
    const f = await fixture();
    f.materialize.mockRejectedValue(new Error('private media store offline'));
    await f.run(await f.next());
    await f.run(await f.next());
    for (let attempt = 0; attempt < 3; attempt++) await f.run(await f.next());
    const result = await f.store.get(f.actor.userId, f.job.jobId);
    expect(result.state).toBe('materialization_failed');
    expect(f.materialize).toHaveBeenCalledTimes(3);
    expect(f.protocol.submit).toHaveBeenCalledTimes(1);
    expect(f.protocol.query).toHaveBeenCalledTimes(1);
    expect((await f.pool.query('SELECT count(*) FROM mio_assets')).rows[0].count).toBe('0');
    const saved = (
      await f.pool.query('SELECT checkpoint FROM mio_video_executions WHERE job_id=$1', [
        f.job.jobId,
      ])
    ).rows[0].checkpoint;
    expect(saved.videos[0].url).toBe('https://media.fixture/video.mp4');
  });

  it('keeps an exclusive executor lease and leaves the shared database pool open when closed', async () => {
    const f = await fixture();
    const other = new VideoGenerationStore(f.pool).executorStore();
    await expect(other.startExecutor(() => {})).rejects.toThrow('VIDEO_EXECUTOR_ALREADY_RUNNING');
    await f.execution.close();
    await other.startExecutor(() => {});
    await other.close();
    expect((await f.pool.query('SELECT 1 AS alive')).rows[0].alive).toBe(1);
  });
});

it.each(['rotated', 'disabled', 'asset-changed', 'unchanged', 'legacy'] as const)(
  'checks the current admission after resolving the frozen input when %s',
  async (scenario) => {
    const f = await fixture(scenario === 'legacy' ? 'legacy' : 'frozen');
    const headStarted = Promise.withResolvers<void>();
    const headRelease = Promise.withResolvers<void>();
    const objects: AssetObjectStore = {
      uploadUrl: vi.fn(),
      downloadUrl: vi.fn(),
      copy: vi.fn(),
      delete: vi.fn(),
      materialUrl: vi.fn(() => 'https://cos.fixture/first-frame'),
      head: vi.fn(async () => {
        headStarted.resolve();
        await headRelease.promise;
        return {
          size: 256,
          etag: scenario === 'asset-changed' ? 'changed-etag' : f.asset.etag,
        };
      }),
    };
    const inputs = createVideoInputResolver(new AssetStore(f.pool), objects);
    const run = f.runner({
      references: (row, signal) =>
        inputs.resolve(row.owner_id, row.command.inputSnapshot, signal, row.command.inputObjects),
    });
    const row = await f.next();
    const accepted = scenario === 'unchanged' || scenario === 'legacy';
    const pending = accepted ? Promise.all([run(row), run(row)]) : run(row);
    try {
      await headStarted.promise;
      expect(f.provider.snapshotVideo).not.toHaveBeenCalled();
      expect(f.provider.openImageSnapshot).not.toHaveBeenCalled();
      expect(f.protocol.submit).not.toHaveBeenCalled();
      expect(await f.durableState()).toMatchObject({ phase: 'ready', async_deadline: null });
      if (scenario === 'rotated')
        f.provider.snapshotVideo.mockResolvedValueOnce({
          capabilitiesVersion: f.request.expectedCapabilitiesVersion,
          credentialVersion: 2,
        } as Awaited<ReturnType<VideoExecutorProvider['snapshotVideo']>>);
      if (scenario === 'disabled')
        f.provider.snapshotVideo.mockRejectedValueOnce(new Error('MODEL_DISABLED'));
    } finally {
      headRelease.resolve();
      await pending;
    }
    expect(objects.head).toHaveBeenCalledWith(f.asset.key, expect.any(AbortSignal));
    if (scenario === 'asset-changed') {
      expect(f.provider.snapshotVideo).not.toHaveBeenCalled();
      expect(objects.materialUrl).not.toHaveBeenCalled();
    } else {
      expect(f.provider.snapshotVideo).toHaveBeenCalledWith(
        { userId: f.actor.userId },
        f.request.modelRef,
      );
      expect(vi.mocked(objects.materialUrl!).mock.invocationCallOrder[0]).toBeLessThan(
        f.provider.snapshotVideo.mock.invocationCallOrder[0]!,
      );
    }
    if (accepted) {
      expect(f.provider.openImageSnapshot).toHaveBeenCalledWith(f.actor.userId, row.snapshot);
      expect(f.protocol.submit).toHaveBeenCalledExactlyOnceWith(
        f.request.parameters,
        { [f.asset.assetId]: 'https://cos.fixture/first-frame' },
        'frozen-test-key',
        expect.any(AbortSignal),
      );
      expect(await f.durableState()).toMatchObject({ state: 'submitted', phase: 'waiting' });
    } else {
      expect(f.provider.openImageSnapshot).not.toHaveBeenCalled();
      expect(f.protocol.submit).not.toHaveBeenCalled();
      expect(await f.durableState()).toMatchObject({
        state: 'rejected',
        phase: 'done',
        async_deadline: null,
        async_max_queries: null,
        upstream_task_id: null,
      });
    }
  },
);

it('rejects before submission when its receipt directory is already unusable', async () => {
  const f = await fixture();
  const submissions = join(f.directory, 'video-submissions');
  await mkdir(submissions);
  await chmod(submissions, 0o755);
  await f.run(await f.next());
  expect(f.protocol.submit).not.toHaveBeenCalled();
  expect(await f.durableState()).toMatchObject({
    state: 'rejected',
    async_deadline: null,
    upstream_task_id: null,
  });
});

async function reopen(f: Awaited<ReturnType<typeof fixture>>) {
  await f.execution.close();
  const execution = new VideoGenerationStore(f.pool).executorStore();
  await execution.startExecutor(() => {});
  cleanups.push(() => execution.close());
  const receipts = new VideoSubmissionReceipts(f.directory);
  cleanups.push(() => receipts.close());
  return {
    execution,
    receipts,
    replay: () => receipts.replay(execution.receive.bind(execution), new AbortController().signal),
    run: f.runner({}, execution, receipts),
  };
}

async function observeDirectorySync(directory: string, beforeSync: () => Promise<void>) {
  const handle = await open(directory, 'r');
  const { ino, dev } = await handle.stat();
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  const sync = prototype.sync;
  return vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
    const current = await this.stat();
    if (current.ino === ino && current.dev === dev) await beforeSync();
    await sync.call(this);
  });
}

describe('paid video submission receipt', () => {
  it('keeps a private received ID when PostgreSQL declines it and the executor restarts', async () => {
    const f = await fixture();
    await f.pool.query(`
      CREATE FUNCTION decline_fixture_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture declined the receipt'; END;
      $$;
      CREATE TRIGGER decline_fixture_receipt BEFORE UPDATE OF upstream_task_id
      ON mio_video_executions FOR EACH ROW EXECUTE FUNCTION decline_fixture_receipt()
    `);
    await expect(f.run(await f.next())).rejects.toThrow('fixture declined the receipt');
    const submitting = await f.durableState();
    expect(submitting).toMatchObject({
      state: 'accepted',
      phase: 'submitting',
      upstream_task_id: null,
    });
    expect(await stat(f.receiptPath).then((info) => info.mode & 0o777)).toBe(0o600);
    expect(JSON.parse(await readFile(f.receiptPath, 'utf8'))).toEqual(f.expectedReceipt);

    const competing = vi.fn(async () => 'deferred' as const);
    await expect(
      f.receipts.record({ ...f.expectedReceipt, upstreamTaskId: 'different-task' }, competing),
    ).resolves.toBe(true);
    expect(competing).toHaveBeenCalledWith(f.expectedReceipt, true);
    expect(JSON.parse(await readFile(f.receiptPath, 'utf8'))).toEqual(f.expectedReceipt);

    await f.pool.query('DROP TRIGGER decline_fixture_receipt ON mio_video_executions');
    await f.execution.close();
    const restarted = await createVideoExecutor(
      new VideoGenerationStore(f.pool),
      () => f.provider,
      f.materialize,
      { protocol: () => f.protocol },
      f.directory,
    );
    cleanups.push(() => restarted.close());
    await vi.waitFor(
      async () => {
        expect(await f.durableState()).toMatchObject({
          state: 'submitted',
          phase: 'waiting',
          upstream_task_id: f.expectedReceipt.upstreamTaskId,
          query_attempt: submitting.query_attempt,
          async_deadline: submitting.async_deadline,
          async_max_queries: submitting.async_max_queries,
        });
        await expect(readFile(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
      },
      { timeout: 3000 },
    );
    await f.pool.query('UPDATE mio_video_executions SET next_query_at=now() WHERE job_id=$1', [
      f.job.jobId,
    ]);
    restarted.wake();
    await vi.waitFor(
      async () => expect(await f.durableState()).toMatchObject({ state: 'completed' }),
      {
        timeout: 3000,
      },
    );
    expect(f.protocol.submit).toHaveBeenCalledTimes(1);
    expect(f.protocol.query).toHaveBeenCalledExactlyOnceWith(
      'safe-task',
      'current-test-key',
      expect.any(AbortSignal),
    );
  });

  it('does not write PostgreSQL before replay has synced a newly published receipt name', async () => {
    const f = await fixture();
    const publisher = Promise.withResolvers<void>();
    const replay = Promise.withResolvers<void>();
    const publisherResume = Promise.withResolvers<void>();
    const replayResume = Promise.withResolvers<void>();
    let syncingParent = 0;
    const observeSync = await observeDirectorySync(f.directory, async () => {
      if (++syncingParent === 1) {
        publisher.resolve();
        await publisherResume.promise;
        throw new Error('fixture directory sync failed');
      }
      replay.resolve();
      await replayResume.promise;
    });
    const receive = vi.spyOn(f.execution, 'receive');
    const row = await f.next();
    const incoming = f.run(row);
    const other = new VideoSubmissionReceipts(f.directory);
    cleanups.push(() => other.close());
    let restore: Promise<void> | undefined;
    try {
      await publisher.promise;
      expect(JSON.parse(await readFile(f.receiptPath, 'utf8'))).toEqual(f.expectedReceipt);
      restore = other.replay(f.execution.receive.bind(f.execution), new AbortController().signal);
      await replay.promise;
      expect(receive).not.toHaveBeenCalled();
      expect(await f.durableState()).toMatchObject({ phase: 'submitting', upstream_task_id: null });
      replayResume.resolve();
      await restore;
      expect(receive).toHaveBeenCalledExactlyOnceWith(f.expectedReceipt, true);
      expect(await f.durableState()).toMatchObject({
        phase: 'waiting',
        upstream_task_id: 'safe-task',
      });
    } finally {
      publisherResume.resolve();
      replayResume.resolve();
      await Promise.all([incoming, restore]);
      observeSync.mockRestore();
      receive.mockRestore();
    }
    expect(f.protocol.submit).toHaveBeenCalledTimes(1);
  });

  it('confirms an already committed ID after a lost COMMIT reply without resetting query progress', async () => {
    const f = await fixture();
    const original = Client.prototype.query;
    const acknowledgementLost = new Error('fixture discarded COMMIT reply');
    let armed = false;
    const query = vi.spyOn(Client.prototype, 'query').mockImplementation(function (
      this: Client,
      ...args: unknown[]
    ) {
      const result = Reflect.apply(original, this, args);
      if (armed && args[0] === 'COMMIT') {
        armed = false;
        return Promise.resolve(result).then(() => {
          throw acknowledgementLost;
        });
      }
      return result;
    });
    vi.mocked(f.protocol.submit).mockImplementationOnce(async () => {
      armed = true;
      return { state: 'submitted', upstreamTaskId: 'safe-task' };
    });
    try {
      await expect(f.run(await f.next())).rejects.toBe(acknowledgementLost);
    } finally {
      query.mockRestore();
    }
    expect(JSON.parse(await readFile(f.receiptPath, 'utf8'))).toEqual(f.expectedReceipt);
    expect(await f.durableState()).toMatchObject({
      state: 'submitted',
      upstream_task_id: 'safe-task',
    });

    vi.mocked(f.protocol.query).mockResolvedValueOnce({ state: 'processing' });
    await f.run(await f.next());
    const beforeReplay = await f.durableState();
    expect(beforeReplay).toMatchObject({ query_attempt: 1, phase: 'waiting' });
    const restarted = await reopen(f);
    await restarted.replay();
    expect(await f.durableState()).toEqual(beforeReplay);
    await expect(readFile(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await restarted.run(await f.next(restarted.execution));
    expect(await f.durableState()).toMatchObject({ state: 'completed', query_attempt: 2 });
    expect(f.protocol.submit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.protocol.query).mock.calls.map(([id]) => id)).toEqual([
      'safe-task',
      'safe-task',
    ]);
  });

  it.each(['release', 'expire', 'lost-volume', 'repaired-sync'] as const)(
    'handles a late ID after claim replacement at full owner quota when %s',
    async (scenario) => {
      const f = await fixture();
      const upstreamEntered = Promise.withResolvers<void>();
      const upstreamReply = Promise.withResolvers<VideoSubmitResult>();
      vi.mocked(f.protocol.submit).mockImplementationOnce(async () => {
        upstreamEntered.resolve();
        return upstreamReply.promise;
      });
      const original = await f.next();
      const pending = f.run(original);
      await upstreamEntered.promise;
      const intent = await f.durableState();
      let repair: Awaited<ReturnType<typeof observeDirectorySync>> | undefined;
      let restarted: Awaited<ReturnType<typeof reopen>>;
      try {
        restarted = await reopen(f);
        const current = await f.next(restarted.execution);
        expect(current.claim_id).not.toBe(original.claim_id);
        await restarted.run(current);
        expect(await f.durableState()).toMatchObject({
          state: 'unknown',
          phase: 'done',
          upstream_task_id: null,
        });
        for (let index = 0; index < VIDEO_USER_QUOTA; index++)
          await f.create({ request: { ...f.request, requestId: randomUUID() }, inputSnapshot: [] });
        if (scenario === 'lost-volume')
          await rm(join(f.directory, 'video-submissions'), { recursive: true, force: true });
        if (scenario === 'repaired-sync')
          repair = await observeDirectorySync(f.directory, async () => {
            throw new Error('fixture volume cannot sync directories');
          });
      } finally {
        upstreamReply.resolve({ state: 'submitted', upstreamTaskId: 'safe-task' });
        await pending.finally(() => repair?.mockRestore());
      }
      const volatile = scenario === 'lost-volume' || scenario === 'repaired-sync';
      const unknown = await f.durableState();
      expect(unknown).toMatchObject({
        state: 'unknown',
        phase: 'done',
        query_attempt: intent.query_attempt,
        async_deadline: intent.async_deadline,
        async_max_queries: intent.async_max_queries,
        upstream_task_id: volatile ? 'safe-task' : null,
      });
      if (scenario === 'lost-volume')
        await expect(readFile(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(JSON.parse(await readFile(f.receiptPath, 'utf8'))).toEqual(f.expectedReceipt);
      await restarted.replay();
      expect(await f.durableState()).toEqual(unknown);
      if (scenario !== 'lost-volume')
        expect(JSON.parse(await readFile(f.receiptPath, 'utf8'))).toEqual(f.expectedReceipt);
      expect(
        (await f.pool.query("SELECT count(*) FROM mio_video_jobs WHERE state='accepted'")).rows[0]
          .count,
      ).toBe(String(VIDEO_USER_QUOTA));

      if (scenario === 'expire') {
        const expired = (
          await f.pool.query(
            `UPDATE mio_video_executions SET async_deadline=now()-interval '1 second'
             WHERE job_id=$1 RETURNING async_deadline`,
            [f.job.jobId],
          )
        ).rows[0].async_deadline;
        await restarted.replay();
        expect(await f.durableState()).toEqual({
          ...unknown,
          async_deadline: expired,
          upstream_task_id: 'safe-task',
        });
      } else {
        const occupying = (await restarted.execution.claim())!;
        await restarted.execution.terminal(occupying, 'failed', 'FIXTURE_SLOT_RELEASED');
        await restarted.replay();
        if (scenario === 'lost-volume') expect(await f.durableState()).toEqual(unknown);
        else {
          expect(await f.durableState()).toMatchObject({
            state: 'submitted',
            phase: 'waiting',
            upstream_task_id: 'safe-task',
            query_attempt: intent.query_attempt,
            async_deadline: intent.async_deadline,
            async_max_queries: intent.async_max_queries,
          });
          await restarted.run(await f.next(restarted.execution));
          expect(await f.durableState()).toMatchObject({ state: 'completed', query_attempt: 1 });
        }
      }
      await expect(readFile(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.protocol.submit).toHaveBeenCalledTimes(1);
      expect(f.protocol.query).toHaveBeenCalledTimes(
        scenario === 'release' || scenario === 'repaired-sync' ? 1 : 0,
      );
    },
  );

  it('does not attach a receipt with a different owner, request, ID, or terminal disposition', async () => {
    const f = await fixture();
    vi.mocked(f.protocol.submit).mockResolvedValueOnce({
      state: 'unknown',
      code: 'VIDEO_SUBMISSION_UNKNOWN',
    });
    await f.run(await f.next());
    const unknown = await f.durableState();
    const receive = f.execution.receive.bind(f.execution);
    for (const discrepancy of [{ ownerId: randomUUID() }, { requestId: randomUUID() }]) {
      expect(await f.receipts.record({ ...f.expectedReceipt, ...discrepancy }, receive)).toBe(
        false,
      );
      expect(await f.durableState()).toEqual(unknown);
    }
    expect(await f.receipts.record(f.expectedReceipt, receive)).toBe(true);
    await f.run(await f.next());
    const completed = await f.durableState();
    expect(completed).toMatchObject({ state: 'completed', upstream_task_id: 'safe-task' });
    expect(
      await f.receipts.record({ ...f.expectedReceipt, upstreamTaskId: 'different-task' }, receive),
    ).toBe(false);
    expect(await f.receipts.record(f.expectedReceipt, receive)).toBe(true);
    expect(await f.durableState()).toEqual(completed);
    await expect(readFile(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.protocol.submit).toHaveBeenCalledTimes(1);
    expect(f.protocol.query).toHaveBeenCalledTimes(1);
  });

  it('cannot adopt an ID for a rejected submission with no upstream ID', async () => {
    const f = await fixture();
    vi.mocked(f.protocol.submit).mockResolvedValueOnce({ state: 'rejected', code: 'VIDEO_AUTH' });
    await f.run(await f.next());
    const rejected = await f.durableState();
    expect(rejected).toMatchObject({ state: 'rejected', upstream_task_id: null });
    expect(await f.receipts.record(f.expectedReceipt, f.execution.receive.bind(f.execution))).toBe(
      false,
    );
    expect(await f.durableState()).toEqual(rejected);
    expect(await f.execution.claim()).toBeUndefined();
    expect(f.protocol.query).not.toHaveBeenCalled();
  });
});

it.each([undefined, 'other-task'])(
  'keeps the original ID and produces no asset when actual Ark query reports identity %s',
  async (id) => {
    const f = await fixture();
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => Response.json({ id: 'safe-task' }))
      .mockImplementationOnce(async () =>
        Response.json({
          id,
          status: 'succeeded',
          content: { video_url: 'https://media.fixture/unrelated.mp4' },
        }),
      );
    const run = f.runner({ protocol: createVideoProtocol, transport });
    await run(await f.next());
    const submitted = await f.durableState();
    expect(submitted).toMatchObject({ state: 'submitted', upstream_task_id: 'safe-task' });
    await run(await f.next());
    expect(await f.durableState()).toMatchObject({
      state: 'unknown',
      error_code: 'VIDEO_QUERY_IDENTITY_INVALID',
      phase: 'done',
      upstream_task_id: 'safe-task',
      query_attempt: 1,
      async_deadline: submitted.async_deadline,
      async_max_queries: submitted.async_max_queries,
      checkpoint: null,
    });
    expect((await f.store.get(f.actor.userId, f.job.jobId)).outputs).toEqual([]);
    expect((await f.pool.query('SELECT count(*) FROM mio_assets')).rows[0].count).toBe('0');
    expect(f.materialize).not.toHaveBeenCalled();
    expect(await f.execution.claim()).toBeUndefined();
    expect(
      transport.mock.calls.map(([url, options]) => [
        new URL(String(url)).pathname,
        options?.method,
      ]),
    ).toEqual([
      ['/volc/api/v3/contents/generations/tasks', 'POST'],
      ['/volc/api/v3/contents/generations/tasks/safe-task', 'GET'],
    ]);
  },
);

function arkQueryTransport() {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: 'safe-task' }));
}

describe('durable video query outcomes', () => {
  it.each([
    {
      family: 'kling',
      response: { code: 0, data: { task_id: 'safe-task', task_status: 'new_supplier_status' } },
      expectedState: 'unknown',
      expectedCode: 'VIDEO_QUERY_STATUS_UNKNOWN',
    },
    {
      family: 'happyhorse',
      response: { output: { task_id: 'safe-task', task_status: 'UNKNOWN' } },
      expectedState: 'unknown',
      expectedCode: 'VIDEO_QUERY_STATUS_UNKNOWN',
    },
    {
      family: 'happyhorse',
      response: { output: { task_id: 'safe-task', task_status: 'FAILED' } },
      expectedState: 'failed',
      expectedCode: 'VIDEO_UPSTREAM_FAILED',
    },
  ] as const)(
    'persists $expectedState / $expectedCode for $family without assets or extra POST',
    async ({ family, response, expectedState, expectedCode }) => {
      const f = await fixture(undefined, family);
      const route = queryRoutes[family];
      const submission =
        family === 'kling'
          ? { code: 0, data: { task_id: 'safe-task' } }
          : { output: { task_id: 'safe-task' } };
      const upstreamTaskId =
        family === 'kling'
          ? JSON.stringify({ path: route.submitPath, id: 'safe-task' })
          : 'safe-task';
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(submission))
        .mockResolvedValueOnce(Response.json(response));
      const run = f.runner({ protocol: createVideoProtocol, transport });
      await run(await f.next());
      const submitted = await f.durableState();
      expect(submitted).toMatchObject({ state: 'submitted', upstream_task_id: upstreamTaskId });
      await run(await f.next());
      expect(await f.durableState()).toMatchObject({
        state: expectedState,
        error_code: expectedCode,
        phase: 'done',
        upstream_task_id: upstreamTaskId,
        async_deadline: submitted.async_deadline,
        async_max_queries: submitted.async_max_queries,
        query_attempt: 1,
        checkpoint: null,
      });
      expect(await f.store.get(f.actor.userId, f.job.jobId)).toMatchObject({
        state: expectedState,
        error: { code: expectedCode },
        outputs: [],
      });
      expect(f.materialize).not.toHaveBeenCalled();
      expect((await f.pool.query('SELECT count(*) FROM mio_assets')).rows[0].count).toBe('0');
      expect(await f.execution.claim()).toBeUndefined();
      expect(
        transport.mock.calls.map(([url, options]) => [
          new URL(String(url)).pathname,
          options?.method,
        ]),
      ).toEqual([
        [route.submitPath, 'POST'],
        [route.queryPathTemplate.replace('{task_id}', 'safe-task'), 'GET'],
      ]);
    },
  );

  it.each([401, 403])(
    'polls the same ID with the rotated owner Key after HTTP %s',
    async (status) => {
      const f = await fixture();
      const transport = arkQueryTransport()
        .mockResolvedValueOnce(new Response('private supplier detail', { status }))
        .mockResolvedValueOnce(Response.json({ id: 'safe-task', status: 'running' }))
        .mockResolvedValueOnce(
          Response.json({
            id: 'safe-task',
            status: 'succeeded',
            content: { video_url: 'https://media.fixture/video.mp4' },
          }),
        );
      f.provider.resolveImageTaskCredential
        .mockResolvedValueOnce('old-owner-key')
        .mockResolvedValue('rotated-owner-key');
      const run = f.runner({ protocol: createVideoProtocol, transport });
      await run(await f.next());
      const submitted = await f.durableState();
      const polling = await f.databaseNow();
      await run(await f.next());
      const blocked = await f.durableState();
      expect(blocked).toMatchObject({
        state: 'submitted',
        error_code: 'VIDEO_QUERY_AUTH',
        phase: 'waiting',
        upstream_task_id: 'safe-task',
        query_attempt: 1,
        async_deadline: submitted.async_deadline,
        async_max_queries: submitted.async_max_queries,
        completed_at: null,
      });
      expect(blocked.next_query_at.getTime()).toBeGreaterThanOrEqual(
        polling + VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
      );
      expect(await f.store.get(f.actor.userId, f.job.jobId)).toMatchObject({
        state: 'submitted',
        error: { code: 'VIDEO_QUERY_AUTH' },
        outputs: [],
      });
      expect(await f.execution.claim()).toBeUndefined();
      const another = () =>
        f.create({ request: { ...f.request, requestId: randomUUID() }, inputSnapshot: [] });
      for (let slot = 1; slot < VIDEO_USER_QUOTA; slot++) await another();
      await expect(another()).rejects.toMatchObject({ code: 'VIDEO_QUOTA_EXCEEDED' });
      await run(await f.next());
      expect(await f.durableState()).toMatchObject({
        state: 'processing',
        error_code: null,
        query_attempt: 2,
      });
      await run(await f.next());
      expect(await f.durableState()).toMatchObject({
        state: 'completed',
        error_code: null,
        query_attempt: 3,
        upstream_task_id: 'safe-task',
      });
      expect(f.provider.resolveImageTaskCredential.mock.calls).toEqual([
        [f.actor.userId],
        [f.actor.userId],
        [f.actor.userId],
      ]);
      expect(f.provider.openImageSnapshot).toHaveBeenCalledTimes(1);
      expect(
        transport.mock.calls.map(([url, options]) => [
          new URL(String(url)).pathname,
          options?.method,
          new Headers(options?.headers).get('Authorization'),
        ]),
      ).toEqual([
        [queryRoutes.ark.submitPath, 'POST', 'Bearer frozen-test-key'],
        [queryRoutes.ark.submitPath + '/safe-task', 'GET', 'Bearer old-owner-key'],
        [queryRoutes.ark.submitPath + '/safe-task', 'GET', 'Bearer rotated-owner-key'],
        [queryRoutes.ark.submitPath + '/safe-task', 'GET', 'Bearer rotated-owner-key'],
      ]);
    },
  );

  it('records only outbound GET attempts across limited, unavailable, network, timeout and malformed responses', async () => {
    const f = await fixture();
    const transport = arkQueryTransport()
      .mockResolvedValueOnce(new Response('private supplier detail', { status: 429 }))
      .mockResolvedValueOnce(new Response('private supplier detail', { status: 502 }))
      .mockRejectedValueOnce(new TypeError('private transport detail'))
      .mockResolvedValueOnce(new Response('private supplier detail', { status: 408 }))
      .mockResolvedValueOnce(new Response('private malformed payload'));
    const run = f.runner({ protocol: createVideoProtocol, transport });
    await run(await f.next());
    await f.pool.query('UPDATE mio_video_executions SET async_max_queries=5 WHERE job_id=$1', [
      f.job.jobId,
    ]);
    const states = [
      { state: 'submitted', code: 'VIDEO_QUERY_RATE_LIMITED' },
      { state: 'submitted', code: 'VIDEO_QUERY_UPSTREAM_UNAVAILABLE' },
      { state: 'submitted', code: 'VIDEO_QUERY_NETWORK_ERROR' },
      { state: 'submitted', code: 'VIDEO_QUERY_TIMEOUT' },
      { state: 'unknown', code: 'VIDEO_QUERY_RESPONSE_INVALID' },
    ];
    for (const [index, { state, code }] of states.entries()) {
      await run(await f.next());
      expect(await f.durableState()).toMatchObject({
        state,
        error_code: code,
        upstream_task_id: 'safe-task',
        query_attempt: index + 1,
      });
    }
    expect(await f.execution.claim()).toBeUndefined();
    expect(f.materialize).not.toHaveBeenCalled();
    expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual([
      'POST',
      'GET',
      'GET',
      'GET',
      'GET',
      'GET',
    ]);
  });

  it('does not spend a GET while no owner credential is available and resumes with the repaired Key', async () => {
    const f = await fixture();
    f.provider.resolveImageTaskCredential
      .mockRejectedValueOnce(new Error('private credential detail'))
      .mockResolvedValueOnce('repaired-owner-key');
    const transport = arkQueryTransport().mockResolvedValueOnce(
      Response.json({ id: 'safe-task', status: 'running' }),
    );
    const run = f.runner({ protocol: createVideoProtocol, transport });
    await run(await f.next());
    const submitted = await f.durableState();
    const lookupStarted = await f.databaseNow();
    await run(await f.next());
    const blocked = await f.durableState();
    expect(blocked).toMatchObject({
      state: 'submitted',
      error_code: 'VIDEO_QUERY_CREDENTIAL_UNAVAILABLE',
      upstream_task_id: 'safe-task',
      query_attempt: 0,
      async_deadline: submitted.async_deadline,
      async_max_queries: submitted.async_max_queries,
    });
    expect(blocked.next_query_at.getTime()).toBeGreaterThanOrEqual(
      lookupStarted + VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await f.execution.claim()).toBeUndefined();
    await run(await f.next());
    expect(await f.durableState()).toMatchObject({
      state: 'processing',
      error_code: null,
      query_attempt: 1,
    });
    expect(transport).toHaveBeenCalledTimes(2);
    const [url, options] = transport.mock.calls[1]!;
    expect(new URL(String(url)).pathname).toBe(queryRoutes.ark.submitPath + '/safe-task');
    expect(options?.method).toBe('GET');
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer repaired-owner-key');
  });

  it.each(['deadline', 'attempt count'] as const)(
    'retains the last durable retry reason and never dispatches after restart with exhausted %s',
    async (cutoff) => {
      const f = await fixture();
      const transport = arkQueryTransport().mockResolvedValueOnce(
        new Response('private supplier detail', { status: 429 }),
      );
      const run = f.runner({ protocol: createVideoProtocol, transport });
      await run(await f.next());
      await f.pool.query('UPDATE mio_video_executions SET async_max_queries=2 WHERE job_id=$1', [
        f.job.jobId,
      ]);
      await run(await f.next());
      expect(await f.durableState()).toMatchObject({
        state: 'submitted',
        error_code: 'VIDEO_QUERY_RATE_LIMITED',
        query_attempt: 1,
      });
      if (cutoff === 'attempt count') {
        // A killed process may have used the second GET before persisting its response.
        expect(await f.execution.beginQuery(await f.next())).toMatchObject({
          phase: 'querying',
          query_attempt: 2,
        });
      } else {
        await f.pool.query(
          "UPDATE mio_video_executions SET async_deadline=clock_timestamp()-interval '1 millisecond' WHERE job_id=$1",
          [f.job.jobId],
        );
      }
      const beforeRestart = await f.durableState();
      await f.execution.close();
      await f.execution.startExecutor(() => {});
      const restored = await f.durableState();
      expect(restored.next_query_at.getTime()).toBeGreaterThan(await f.databaseNow());
      // A future transport schedule does not defer terminal accounting when budget is gone.
      const claimed = await f.execution.claim();
      expect(claimed).toBeDefined();
      await run(claimed!);
      expect(await f.durableState()).toMatchObject({
        state: 'unknown',
        error_code: 'VIDEO_QUERY_RATE_LIMITED',
        phase: 'done',
        upstream_task_id: 'safe-task',
        query_attempt: beforeRestart.query_attempt,
        async_deadline: beforeRestart.async_deadline,
        async_max_queries: beforeRestart.async_max_queries,
      });
      expect(await f.execution.claim()).toBeUndefined();
      expect(f.provider.resolveImageTaskCredential).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual(['POST', 'GET']);
    },
  );
});

describe('video query dispatch and shutdown', () => {
  it.each(['key lookup', 'query reservation', 'protocol creation'] as const)(
    'dispatches zero new GETs when the deadline passes during %s',
    async (boundary) => {
      const f = await fixture();
      const transport = arkQueryTransport().mockResolvedValueOnce(
        new Response(null, { status: 401 }),
      );
      const run = f.runner({ protocol: createVideoProtocol, transport });
      await run(await f.next());
      await run(await f.next());
      const blocked = await f.durableState();
      const deadline = blocked.async_deadline.getTime();
      const claimed = await f.next();
      const wall = vi.spyOn(Date, 'now');
      const keyRead = Promise.withResolvers<string>();
      const readingKey = Promise.withResolvers<void>();
      if (boundary === 'key lookup')
        f.provider.resolveImageTaskCredential.mockImplementationOnce(() => {
          readingKey.resolve();
          return keyRead.promise;
        });
      const reserve = f.execution.beginQuery.bind(f.execution);
      const reservation = vi.spyOn(f.execution, 'beginQuery');
      if (boundary === 'query reservation')
        reservation.mockImplementationOnce(async (row) => {
          const reserved = await reserve(row);
          wall.mockReturnValue(deadline);
          return reserved;
        });
      const protocol = vi.fn<VideoProtocolFactory>(createVideoProtocol);
      if (boundary === 'protocol creation')
        protocol.mockImplementationOnce((route, model, guardedTransport) => {
          const created = createVideoProtocol(route, model, guardedTransport);
          wall.mockReturnValue(deadline);
          return created;
        });
      const pending = f.runner({ protocol, transport })(claimed);
      try {
        if (boundary === 'key lookup') {
          await readingKey.promise;
          expect(reservation).not.toHaveBeenCalled();
          wall.mockReturnValue(deadline);
          keyRead.resolve('current-test-key');
        }
        await pending;
      } finally {
        wall.mockRestore();
        reservation.mockRestore();
        keyRead.resolve('current-test-key');
        await pending;
      }
      expect(protocol).toHaveBeenCalledTimes(boundary === 'protocol creation' ? 1 : 0);
      expect(await f.durableState()).toMatchObject({
        state: 'unknown',
        error_code: 'VIDEO_QUERY_AUTH',
        phase: 'done',
        upstream_task_id: 'safe-task',
        query_attempt: boundary === 'key lookup' ? 1 : 2,
        async_deadline: blocked.async_deadline,
        async_max_queries: blocked.async_max_queries,
      });
      expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual(['POST', 'GET']);
      expect(await f.execution.claim()).toBeUndefined();
    },
  );

  it('bounds an in-flight GET by the remaining time and records a timeout when that budget expires', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<AbortSignal>();
    const transport = arkQueryTransport().mockImplementationOnce(async (_url, options) => {
      const signal = options!.signal!;
      entered.resolve(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const run = f.runner({ protocol: createVideoProtocol, transport });
    await run(await f.next());
    const { rows } = await f.pool.query<{ async_deadline: Date }>(
      `UPDATE mio_video_executions SET async_deadline=clock_timestamp()+interval '4 seconds'
       WHERE job_id=$1 RETURNING async_deadline`,
      [f.job.jobId],
    );
    const deadline = rows[0]!.async_deadline;
    const claimed = await f.next();
    const deadlineAbort = new AbortController();
    const timeoutError = new DOMException('fixture budget elapsed', 'TimeoutError');
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadlineAbort.signal);
    const wall = vi.spyOn(Date, 'now').mockReturnValue(deadline.getTime() - 800);
    const pending = run(claimed);
    try {
      const signal = await entered.promise;
      expect(timeout).toHaveBeenCalledWith(800);
      expect(signal.aborted).toBe(false);
      wall.mockReturnValue(deadline.getTime());
      deadlineAbort.abort(timeoutError);
      await pending;
      expect(signal.reason).toBe(timeoutError);
    } finally {
      deadlineAbort.abort(timeoutError);
      timeout.mockRestore();
      wall.mockRestore();
      await pending;
    }
    expect(await f.durableState()).toMatchObject({
      state: 'unknown',
      error_code: 'VIDEO_QUERY_TIMEOUT',
      phase: 'done',
      upstream_task_id: 'safe-task',
      query_attempt: 1,
      async_deadline: deadline,
    });
    expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual(['POST', 'GET']);
  });

  it.each([
    { caseName: 'late dispatch before the cutoff after takeover', takeOver: true, send: true },
    { caseName: 'dispatch at the cutoff after takeover', takeOver: true, send: false },
    { caseName: 'dispatch at the cutoff with the original claim', takeOver: false, send: false },
  ])('enforces the durable query window for $caseName', async ({ takeOver, send }) => {
    const f = await fixture();
    const transport = arkQueryTransport().mockResolvedValueOnce(
      new Response(null, { status: 401 }),
    );
    const run = f.runner({ protocol: createVideoProtocol, transport });
    await run(await f.next());
    await run(await f.next());
    const beforeWindow = await f.durableState();
    const claimed = await f.next();

    // Hold the old runner after its PostgreSQL reservation. Closing the lock session
    // without aborting that runner models a delayed lease loss notification.
    const reserved = Promise.withResolvers<Date>();
    const resume = Promise.withResolvers<void>();
    const begin = f.execution.beginQuery.bind(f.execution);
    const gate = vi.spyOn(f.execution, 'beginQuery').mockImplementationOnce(async (row) => {
      const attempt = await begin(row);
      reserved.resolve(attempt!.next_query_at);
      await resume.promise;
      return attempt;
    });
    const sent: number[] = [];
    if (send) {
      transport.mockImplementationOnce(async () => {
        sent.push(Date.now());
        return Response.json({
          id: 'safe-task',
          status: 'succeeded',
          content: { video_url: 'https://media.fixture/stale-result.mp4' },
        });
      });
    }
    const wall = vi.spyOn(Date, 'now');
    const pending = run(claimed);
    let floor: Date | undefined;
    let beforeRelease: number | undefined;
    try {
      const cutoff = await reserved.promise;
      if (takeOver) {
        await f.execution.close();
        await f.execution.startExecutor(() => {});
        floor = (await f.durableState()).next_query_at as Date;
        expect(floor.getTime()).toBeGreaterThanOrEqual(
          cutoff.getTime() + VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
        );
        expect(await f.execution.claim()).toBeUndefined();
      } else beforeRelease = await f.databaseNow();
      wall.mockReturnValue(cutoff.getTime() - (send ? 1 : 0));
      resume.resolve();
      await pending;
    } finally {
      wall.mockRestore();
      gate.mockRestore();
      resume.resolve();
      await pending;
    }

    const scheduled = await f.durableState();
    expect(scheduled).toMatchObject({
      state: 'submitted',
      error_code: 'VIDEO_QUERY_AUTH',
      phase: 'waiting',
      claim_id: null,
      upstream_task_id: 'safe-task',
      query_attempt: 2,
      async_deadline: beforeWindow.async_deadline,
      async_max_queries: beforeWindow.async_max_queries,
      checkpoint: null,
    });
    if (floor) expect(scheduled.next_query_at).toEqual(floor);
    if (beforeRelease !== undefined)
      expect(scheduled.next_query_at.getTime()).toBeGreaterThanOrEqual(
        beforeRelease + VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
      );
    expect(sent).toHaveLength(send ? 1 : 0);
    if (send)
      expect(scheduled.next_query_at.getTime() - sent[0]!).toBeGreaterThanOrEqual(
        VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
      );
    expect(await f.execution.claim()).toBeUndefined();
    expect(f.materialize).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(send ? 3 : 2);

    // Advance only the persisted due time to exercise the next attempt without a sleep.
    transport.mockResolvedValueOnce(Response.json({ id: 'safe-task', status: 'running' }));
    await run(await f.next());
    expect(await f.durableState()).toMatchObject({
      state: 'processing',
      error_code: null,
      query_attempt: 3,
    });
    expect(
      transport.mock.calls.map(([url, options]) => [
        options?.method,
        new URL(String(url)).pathname,
      ]),
    ).toEqual([
      ['POST', queryRoutes.ark.submitPath],
      ...Array.from({ length: send ? 3 : 2 }, () => [
        'GET',
        queryRoutes.ark.submitPath + '/safe-task',
      ]),
    ]);
  });

  it('preserves the rate limit from the last GET when shutdown precedes settling it', async () => {
    const f = await fixture();
    const transport = arkQueryTransport().mockResolvedValueOnce(
      new Response(null, { status: 429 }),
    );
    const run = f.runner({ protocol: createVideoProtocol, transport });
    await run(await f.next());
    await f.pool.query('UPDATE mio_video_executions SET async_max_queries=1 WHERE job_id=$1', [
      f.job.jobId,
    ]);
    await f.execution.close();
    await f.makeDue();
    const classified = Promise.withResolvers<AbortSignal>();
    const settle = Promise.withResolvers<void>();
    const protocol: VideoProtocolFactory = (route, modelId, guardedTransport) => {
      const upstream = createVideoProtocol(route, modelId, guardedTransport);
      return {
        ...upstream,
        async query(id, key, signal) {
          const result = await upstream.query(id, key, signal);
          classified.resolve(signal);
          await settle.promise;
          return result;
        },
      };
    };
    const executor = await createVideoExecutor(
      f.store,
      () => f.provider,
      f.materialize,
      { protocol, transport },
      f.directory,
    );
    cleanups.push(() => executor.close());
    try {
      const signal = await classified.promise;
      expect(await f.durableState()).toMatchObject({
        state: 'submitted',
        error_code: null,
        phase: 'querying',
        query_attempt: 1,
      });
      const closing = executor.close();
      expect(signal.aborted).toBe(true);
      settle.resolve();
      await closing;
    } finally {
      settle.resolve();
      await executor.close();
    }

    await f.execution.startExecutor(() => {});
    expect(await f.execution.claim()).toBeUndefined();
    expect(await f.durableState()).toMatchObject({
      state: 'unknown',
      error_code: 'VIDEO_QUERY_RATE_LIMITED',
      phase: 'done',
      upstream_task_id: 'safe-task',
      query_attempt: 1,
    });
    expect(f.materialize).not.toHaveBeenCalled();
    expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual(['POST', 'GET']);
  });

  it.each(['orderly shutdown', 'failed query settlement'] as const)(
    'persists the next query floor across %s while a GET was reserved',
    async (interruption) => {
      const f = await fixture();
      const entered = Promise.withResolvers<number>();
      const transport = arkQueryTransport().mockImplementationOnce(async (_url, options) => {
        const time = await f.databaseNow();
        if (interruption === 'orderly shutdown') {
          const signal = options!.signal!;
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            entered.resolve(time);
          });
        }
        entered.resolve(time);
        return Response.json({ id: 'safe-task', status: 'running' });
      });
      const run = f.runner({ protocol: createVideoProtocol, transport });
      await run(await f.next());
      const submitted = await f.durableState();
      if (interruption === 'failed query settlement')
        await f.pool.query(`
          CREATE FUNCTION decline_fixture_processing() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.state = 'processing' THEN RAISE EXCEPTION 'fixture cannot settle query'; END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER decline_fixture_processing BEFORE UPDATE ON mio_video_jobs
            FOR EACH ROW EXECUTE FUNCTION decline_fixture_processing();
        `);
      await f.execution.close();
      await f.makeDue();
      const executor = await createVideoExecutor(
        f.store,
        () => f.provider,
        f.materialize,
        { protocol: createVideoProtocol, transport },
        f.directory,
      );
      cleanups.push(() => executor.close());
      const sentAt = await entered.promise;
      if (interruption === 'failed query settlement')
        await vi.waitFor(async () =>
          expect(await f.durableState()).toMatchObject({
            phase: 'waiting',
            claim_id: null,
            query_attempt: 1,
          }),
        );
      await executor.close();
      const released = await f.durableState();
      expect(released).toMatchObject({
        state: 'submitted',
        phase: 'waiting',
        claim_id: null,
        query_attempt: 1,
        upstream_task_id: 'safe-task',
        async_deadline: submitted.async_deadline,
        async_max_queries: submitted.async_max_queries,
      });
      expect(released.next_query_at.getTime()).toBeGreaterThanOrEqual(
        sentAt + VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
      );
      await f.execution.startExecutor(() => {});
      expect((await f.durableState()).next_query_at).toEqual(released.next_query_at);
      expect(await f.execution.claim()).toBeUndefined();
      if (interruption === 'failed query settlement')
        await f.pool.query('DROP TRIGGER decline_fixture_processing ON mio_video_jobs');
      transport.mockResolvedValueOnce(Response.json({ id: 'safe-task', status: 'running' }));
      await run(await f.next());
      expect(await f.durableState()).toMatchObject({ state: 'processing', query_attempt: 2 });
      expect(
        transport.mock.calls.map(([url, options]) => [
          new URL(String(url)).pathname,
          options?.method,
        ]),
      ).toEqual([
        [queryRoutes.ark.submitPath, 'POST'],
        [queryRoutes.ark.submitPath + '/safe-task', 'GET'],
        [queryRoutes.ark.submitPath + '/safe-task', 'GET'],
      ]);
    },
  );
});
