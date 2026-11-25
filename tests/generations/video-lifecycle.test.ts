import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
  VideoExecution,
  VideoJobCommand,
  VideoMaterializedOutput,
  VideoMaterializer,
  VideoProtocol,
  VideoProtocolFactory,
  VideoSubmitResult,
} from '../../src/generations/video/execution.ts';
import {
  VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
  VideoResultUrlExpired,
} from '../../src/generations/video/execution.ts';
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

function klingSuccess(videos: unknown[], taskId = 'safe-task') {
  return { code: 0, data: { task_id: taskId, task_status: 'succeed', task_result: { videos } } };
}

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
  const materialize = vi.fn<VideoMaterializer>().mockResolvedValue(output);
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
    databaseURL: database.url,
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
      `UPDATE mio_video_executions SET checkpoint=checkpoint||
        '{"materializationAttempts":3}'::jsonb WHERE job_id=$1`,
      [f.job.jobId],
    );
    await f.run(await f.next());
    expect((await f.store.get(f.actor.userId, f.job.jobId)).state).toBe('materialization_failed');
    await f.pool.query(
      `UPDATE mio_video_executions SET checkpoint=checkpoint-'refreshAt',
      updated_at=clock_timestamp()-interval '1 minute' WHERE job_id=$1`,
      [f.job.jobId],
    );
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
    expect(f.protocol.query).toHaveBeenCalledTimes(1);
    await f.store.recover(f.actor.userId, f.job.jobId);
  });

  it.each(['recent', 'aged'] as const)(
    'enforces the manual query interval for a %s legacy checkpoint',
    async (age) => {
      const f = await fixture();
      await f.run(await f.next());
      f.materialize.mockRejectedValueOnce(new Error('VIDEO_STORAGE_UNAVAILABLE'));
      await f.run(await f.next());
      await f.execution.terminal(
        await f.next(),
        'materialization_failed',
        'VIDEO_MATERIALIZATION_FAILED',
      );
      const before = await f.durableState();
      const legacy = { videos: before.checkpoint.videos, materializationAttempts: 3 };
      const updated = await f.pool.query<{ updated_at: Date }>(
        `UPDATE mio_video_executions SET checkpoint=$2,
          updated_at=clock_timestamp()-$3*interval '1 second' WHERE job_id=$1
          RETURNING updated_at`,
        [f.job.jobId, legacy, age === 'recent' ? 0 : 60],
      );
      expect(await f.durableState()).toMatchObject({ checkpoint: legacy, next_query_at: null });

      await f.store.recover(f.actor.userId, f.job.jobId);
      const armed = await f.durableState();
      expect(armed).toMatchObject({
        checkpoint: {
          videos: legacy.videos,
          materializationAttempts: 0,
          recoveryQuery: { state: 'available' },
        },
        next_query_at: null,
        query_attempt: before.query_attempt,
        async_deadline: before.async_deadline,
        async_max_queries: before.async_max_queries,
        upstream_task_id: before.upstream_task_id,
      });
      expect(Date.parse(armed.checkpoint.refreshAt)).toBe(
        updated.rows[0]!.updated_at.getTime() + VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
      );
      const row = await f.next();
      const reservation = await f.execution.reserveRecoveryQuery(row, before.upstream_task_id);
      if (age === 'recent') expect(reservation).toBeUndefined();
      else expect(reservation).toBeInstanceOf(Date);
      expect(f.protocol.submit).toHaveBeenCalledTimes(1);
      expect(f.protocol.query).toHaveBeenCalledTimes(1);
      await f.execution.release(row);
    },
  );

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

  it('preserves the original slots and later outputs when one asset transaction rolls back', async () => {
    const f = await fixture(undefined, 'kling');
    const videos = [
      { url: 'https://media.fixture/first.mp4' },
      { url: 'http://malformed.fixture/skip.mp4' },
      { url: 'https://media.fixture/cannot-register.mp4' },
      { url: 'https://media.fixture/last.mp4' },
    ];
    const outputs = videos.map((_, index) => ({
      ...f.output,
      index,
      assetId: randomUUID(),
      key: 'mio/raw/' + randomUUID(),
    }));
    f.materialize.mockImplementation(async (_, video, index) => {
      expect(video).toEqual(videos[index]);
      return outputs[index]!;
    });
    const transport = vi.fn<typeof fetch>(async (_url, options) =>
      Response.json(
        options?.method === 'POST'
          ? { code: 0, data: { task_id: 'safe-task' } }
          : klingSuccess(videos),
      ),
    );
    await f.pool.query(`
      CREATE FUNCTION fail_video_registration() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture insert interruption'; END $$;
      CREATE TRIGGER fail_video_registration BEFORE INSERT ON mio_video_outputs
      FOR EACH ROW WHEN (NEW.output_index=2 AND NEW.phase='registered')
      EXECUTE FUNCTION fail_video_registration()
    `);
    const run = f.runner({ protocol: createVideoProtocol, transport });
    await run(await f.next());
    await run(await f.next());
    const actorId = f.actor.userId;
    const view = () => f.store.get(actorId, f.job.jobId);
    const firstPass = (await view()).outputs;
    expect(firstPass).toMatchObject([
      { index: 0, status: 'registered', assetId: outputs[0]!.assetId },
      { index: 1, status: 'failed', assetId: null, errorCode: 'VIDEO_RESULT_INVALID' },
      { index: 2, status: 'failed', assetId: null, errorCode: 'VIDEO_MATERIALIZATION_FAILED' },
      { index: 3, status: 'registered', assetId: outputs[3]!.assetId },
    ]);
    const assets = () => f.pool.query('SELECT id,owner_id FROM mio_assets ORDER BY filename');
    expect((await assets()).rows).toEqual([
      { id: outputs[0]!.assetId, owner_id: actorId },
      { id: outputs[3]!.assetId, owner_id: actorId },
    ]);

    await f.execution.close();
    const restarted = new VideoGenerationStore(f.pool).executorStore();
    cleanups.push(() => restarted.close());
    await restarted.startExecutor(() => {});
    const resume = f.runner({ protocol: createVideoProtocol, transport }, restarted);
    for (let pass = 0; pass < 2; pass++) await resume(await f.next(restarted));
    expect(await view()).toMatchObject({
      state: 'partial',
      recovery: { available: true },
      outputs: firstPass,
    });
    expect(f.materialize.mock.calls.map(([, , index]) => index)).toEqual([0, 2, 3, 2, 2]);
    expect((await assets()).rows).toHaveLength(2);

    await f.pool.query('DROP TRIGGER fail_video_registration ON mio_video_outputs');
    await f.store.recover(actorId, f.job.jobId);
    await resume(await f.next(restarted));
    expect(await view()).toMatchObject({
      state: 'partial',
      recovery: { available: false },
      outputs: [
        firstPass[0],
        firstPass[1],
        { index: 2, status: 'registered', assetId: outputs[2]!.assetId },
        firstPass[3],
      ],
    });
    expect((await assets()).rows).toHaveLength(3);
    await expect(f.store.recover(actorId, f.job.jobId)).rejects.toMatchObject({
      code: 'RESULT_CONFLICT',
    });
    expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual(['POST', 'GET']);
    expect(f.materialize.mock.calls.map(([, , index]) => index)).toEqual([0, 2, 3, 2, 2, 2]);
  });

  it('preserves a replacement from the last pass across restart without materializing on a stale claim', async () => {
    const f = await fixture(undefined, 'kling');
    const videos = [
      { url: 'https://media.fixture/already-registered.mp4' },
      { url: 'https://media.fixture/expired.mp4' },
      { url: 'https://media.fixture/owned-checkpoint.mp4' },
    ];
    const replacement = { url: 'https://media.fixture/new-address.mp4' };
    const route = queryRoutes.kling.submitPath + '/safe-task';
    const ownerId = f.actor.userId;
    const view = () => f.store.get(ownerId, f.job.jobId);
    let queries = 0;
    let callsAtQuery = 0;
    let ownerCheckpointAvailable = false;
    let dispatchAt = 0;
    const transport = vi.fn<typeof fetch>(async (url, options) => {
      if (options?.method === 'POST')
        return Response.json({ code: 0, data: { task_id: 'safe-task' } });
      queries++;
      if (queries === 1) return Response.json(klingSuccess(videos));
      expect(new URL(String(url)).pathname).toBe(route);
      expect(options?.method).toBe('GET');
      expect(options?.redirect).toBe('error');
      expect(new Headers(options?.headers).get('authorization')).toBe('Bearer rotated-key');
      callsAtQuery = f.materialize.mock.calls.length;
      dispatchAt = await f.databaseNow();
      expect(
        (await view()).outputs
          .filter((output) => output.status === 'registered')
          .map((output) => output.index),
      ).toEqual([0, 2]);
      return Response.json(
        klingSuccess([
          { url: 'https://media.fixture/do-not-overwrite-first.mp4' },
          replacement,
          { url: 'https://media.fixture/do-not-overwrite-checkpoint.mp4' },
        ]),
      );
    });
    const outputs = videos.map((_, index) => ({
      ...f.output,
      index,
      assetId: randomUUID(),
      key: 'mio/raw/' + randomUUID(),
    }));
    f.materialize.mockImplementation(async (_, video, index) => {
      if (index === 1 && video.url !== replacement.url) throw new VideoResultUrlExpired();
      if (index === 2 && !ownerCheckpointAvailable) throw new Error('VIDEO_STORAGE_UNAVAILABLE');
      return outputs[index]!;
    });
    const run = f.runner({ protocol: createVideoProtocol, transport });
    await run(await f.next());
    await run(await f.next());
    for (let pass = 0; pass < 2; pass++) await run(await f.next());
    expect(await view()).toMatchObject({ state: 'partial', recovery: { available: true } });
    expect(f.materialize.mock.calls.map(([, , index]) => index)).toEqual([0, 1, 2, 2, 2]);
    expect(queries).toBe(1);
    await f.pool.query(
      `UPDATE mio_video_executions SET query_attempt=async_max_queries,
      async_deadline=clock_timestamp()-interval '1 minute' WHERE job_id=$1`,
      [f.job.jobId],
    );
    const original = await f.durableState();
    await f.store.recover(ownerId, f.job.jobId);
    await f.pool.query(
      `UPDATE mio_video_executions SET checkpoint=checkpoint||
       jsonb_build_object('materializationAttempts',2,'refreshAt',clock_timestamp()-interval '1 second')
       WHERE job_id=$1`,
      [f.job.jobId],
    );
    ownerCheckpointAvailable = true;
    f.provider.resolveImageTaskCredential.mockResolvedValueOnce('rotated-key');
    await run(await f.next());
    const refreshed = await f.durableState();
    expect(callsAtQuery).toBe(7);
    expect(f.materialize).toHaveBeenCalledTimes(callsAtQuery);
    expect(refreshed).toMatchObject({
      state: 'materializing',
      query_attempt: original.query_attempt,
      async_deadline: original.async_deadline,
      async_max_queries: original.async_max_queries,
      upstream_task_id: original.upstream_task_id,
      checkpoint: {
        videos: [videos[0], replacement, videos[2]],
        materializationAttempts: 3,
        recoveryQuery: { state: 'reserved', refreshed: { 1: 'pending' } },
      },
    });
    expect(Date.parse(refreshed.checkpoint.refreshAt) - dispatchAt).toBeGreaterThanOrEqual(
      VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
    );

    const stale = await f.next();
    await f.execution.close();
    const restarted = new VideoGenerationStore(f.pool).executorStore();
    cleanups.push(() => restarted.close());
    await restarted.startExecutor(() => {});
    const resume = f.runner({ protocol: createVideoProtocol, transport }, restarted);
    const current = await f.next(restarted);
    await resume(stale);
    expect(f.materialize).toHaveBeenCalledTimes(callsAtQuery);
    await resume(current);
    expect(f.materialize.mock.calls[7]?.slice(1, 3)).toEqual([replacement, 1]);
    expect(await view()).toMatchObject({
      state: 'completed',
      outputs: outputs.map(({ index, assetId }) => ({ index, assetId, status: 'registered' })),
    });
    expect(await f.durableState()).toMatchObject({
      query_attempt: original.query_attempt,
      async_deadline: original.async_deadline,
      upstream_task_id: original.upstream_task_id,
      checkpoint: {
        videos: [videos[0], replacement, videos[2]],
        materializationAttempts: 3,
        recoveryQuery: { state: 'reserved', refreshed: { 1: 'finished' } },
      },
    });
    expect(f.provider.snapshotVideo).toHaveBeenCalledTimes(1);
    expect(f.provider.resolveImageTaskCredential.mock.calls).toEqual([[ownerId], [ownerId]]);
    expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual([
      'POST',
      'GET',
      'GET',
    ]);
  });

  it.each([
    ['identity changed', 'VIDEO_QUERY_IDENTITY_INVALID'],
    ['length changed', 'VIDEO_RECOVERY_RESULT_MISMATCH'],
    ['same addresses', 'VIDEO_RECOVERY_RESULT_UNCHANGED'],
    ['credential unauthorized', 'VIDEO_QUERY_AUTH'],
    ['interrupted before replacement commit', undefined],
  ] as const)(
    'keeps expiry factual and preserves one recovery GET when %s',
    async (scenario, code) => {
      const f = await fixture(undefined, 'kling');
      const videos = [
        { url: 'https://media.fixture/ready.mp4' },
        { url: 'https://media.fixture/expired.mp4' },
        { url: 'https://media.fixture/storage-error.mp4' },
      ];
      const replacement = { url: 'https://media.fixture/replacement.mp4' };
      let lookups = 0;
      const transport = vi.fn<typeof fetch>(async (_url, options) => {
        if (options?.method === 'POST')
          return Response.json({ code: 0, data: { task_id: 'safe-task' } });
        if (++lookups === 1) return Response.json(klingSuccess(videos));
        if (scenario === 'same addresses') return Response.json(klingSuccess(videos));
        if (scenario === 'length changed') return Response.json(klingSuccess([replacement]));
        if (scenario === 'credential unauthorized') return new Response('', { status: 401 });
        if (scenario === 'identity changed')
          return Response.json(klingSuccess([videos[0], replacement, videos[2]], 'other-task'));
        return Response.json(klingSuccess([videos[0], replacement, videos[2]]));
      });
      f.materialize.mockImplementation(async (_, _video, index) => {
        if (index === 1) throw new VideoResultUrlExpired();
        if (index === 2) throw new Error('VIDEO_STORAGE_UNAVAILABLE');
        return f.output;
      });
      const ownerId = f.actor.userId;
      const view = () => f.store.get(ownerId, f.job.jobId);
      const run = f.runner({ protocol: createVideoProtocol, transport });
      await run(await f.next());
      for (let pass = 0; pass < 3; pass++) await run(await f.next());
      const original = await f.durableState();
      await f.store.recover(ownerId, f.job.jobId);
      const beforeDue = await f.next();
      expect(
        await f.execution.reserveRecoveryQuery(beforeDue, original.upstream_task_id),
      ).toBeUndefined();
      await f.execution.release(beforeDue);
      await f.pool.query(
        `UPDATE mio_video_executions SET checkpoint=checkpoint||
       jsonb_build_object('refreshAt',clock_timestamp()-interval '1 second') WHERE job_id=$1`,
        [f.job.jobId],
      );
      if (scenario === 'interrupted before replacement commit')
        vi.spyOn(f.execution, 'finishRecoveryQuery').mockRejectedValueOnce(
          new Error('interrupted'),
        );
      await run(await f.next());
      await f.execution.close();
      const restarted = new VideoGenerationStore(f.pool).executorStore();
      cleanups.push(() => restarted.close());
      await restarted.startExecutor(() => {});
      const resume = f.runner({ protocol: createVideoProtocol, transport }, restarted);
      for (let pass = 0; pass < 2; pass++) await resume(await f.next(restarted));
      expect(await view()).toMatchObject({
        state: 'partial',
        outputs: [
          { index: 0, status: 'registered', assetId: f.output.assetId },
          { index: 1, status: 'failed', errorCode: 'VIDEO_RESULT_URL_EXPIRED' },
          { index: 2, status: 'failed', errorCode: 'VIDEO_STORAGE_UNAVAILABLE' },
        ],
      });
      expect(await f.durableState()).toMatchObject({
        upstream_task_id: original.upstream_task_id,
        query_attempt: original.query_attempt,
        async_deadline: original.async_deadline,
        checkpoint: {
          videos,
          recoveryQuery: { state: 'reserved', ...(code ? { errorCode: code } : {}) },
        },
      });
      expect(f.materialize.mock.calls.map(([, , index]) => index)).toEqual([
        0, 1, 2, 2, 2, 1, 2, 2, 2,
      ]);
      expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual([
        'POST',
        'GET',
        'GET',
      ]);
      await f.store.recover(ownerId, f.job.jobId);
      const nextRecovery = await f.next(restarted);
      expect(
        await restarted.reserveRecoveryQuery(nextRecovery, original.upstream_task_id),
      ).toBeUndefined();
      expect(nextRecovery.checkpoint?.recoveryQuery).toEqual({ state: 'available' });
      await restarted.release(nextRecovery);
    },
  );

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
    for (let attempt = 0; attempt < 2; attempt++) await f.run(await f.next());
    const result = await f.store.get(f.actor.userId, f.job.jobId);
    expect(result.state).toBe('materialization_failed');
    expect(result.outputs).toMatchObject([
      { index: 0, status: 'failed', assetId: null, errorCode: 'VIDEO_MATERIALIZATION_FAILED' },
    ]);
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

it.each(['rotated', 'disabled', 'asset-changed', 'unchanged', 'legacy', 'legacy-invalid'] as const)(
  'checks the current admission after resolving the frozen input when %s',
  async (scenario) => {
    const f = await fixture(scenario.startsWith('legacy') ? 'legacy' : 'frozen');
    const headStarted = Promise.withResolvers<void>();
    const headRelease = Promise.withResolvers<void>();
    const prefix = Buffer.alloc(255);
    // The historical ready PNG record may refer to actual WAVE data.
    Buffer.from(
      scenario === 'legacy-invalid'
        ? '52494646f800000057415645666d74201000000001000100401f0000803e00000200100064617461d4000000'
        : '89504e470d0a1a0a',
      'hex',
    ).copy(prefix);
    const objects: AssetObjectStore = {
      uploadUrl: vi.fn(),
      downloadUrl: vi.fn(),
      copy: vi.fn(),
      delete: vi.fn(),
      materialUrl: vi.fn(() => 'https://cos.fixture/first-frame'),
      readPrefix: vi.fn(async () => prefix),
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
    if (scenario === 'asset-changed') expect(objects.readPrefix).not.toHaveBeenCalled();
    else
      expect(objects.readPrefix).toHaveBeenCalledWith(
        f.asset.key,
        f.asset.etag,
        256,
        1024,
        expect.any(AbortSignal),
      );
    if (scenario === 'asset-changed' || scenario === 'legacy-invalid') {
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
      expect(vi.mocked(objects.readPrefix!).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(objects.materialUrl!).mock.invocationCallOrder[0]!,
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
      if (scenario === 'legacy-invalid') {
        expect(row.command.inputObjects).toBeUndefined();
        expect(await f.store.get(f.actor.userId, f.job.jobId)).toMatchObject({
          state: 'rejected',
          error: { code: 'VIDEO_INPUT_OR_CREDENTIAL_UNAVAILABLE' },
        });
      }
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

async function videoLeasePid(pool: Pool) {
  const lease = await pool.query<{ pid: number }>(`
    SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE l.locktype='advisory' AND l.objid=672049927
      AND a.application_name=current_setting('application_name') AND a.datname=current_database()
  `);
  expect(lease.rows).toHaveLength(1);
  return lease.rows[0]!.pid;
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
        await vi.waitFor(
          async () =>
            expect(await f.durableState()).toMatchObject({
              phase: 'waiting',
              claim_id: null,
              query_attempt: 1,
            }),
          { timeout: 5000 },
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

describe('video executor ownership and capacity', () => {
  it('retries the same query release after real PostgreSQL errors while keeping its lease', async () => {
    const f = await fixture();
    expect(await f.execution.submitting(await f.next())).toBe(true);
    expect(await f.execution.receive(f.expectedReceipt, true)).toBe('confirmed');
    await f.execution.close();
    await f.makeDue();
    await f.pool.query(`
      CREATE TABLE fixture_release_gate (allowed boolean NOT NULL);
      INSERT INTO fixture_release_gate VALUES (false);
      CREATE FUNCTION decline_fixture_release() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.phase='querying' AND NEW.phase='waiting' AND NEW.claim_id IS NULL
          AND NOT (SELECT allowed FROM fixture_release_gate) THEN
          RAISE EXCEPTION USING ERRCODE='58000', MESSAGE='fixture cannot release',
            DETAIL=(extract(epoch FROM clock_timestamp())*1000)::text;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER decline_fixture_release BEFORE UPDATE ON mio_video_executions
        FOR EACH ROW EXECUTE FUNCTION decline_fixture_release();
    `);
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: 'safe-task', status: 'running' }));
    const protocol: VideoProtocolFactory = (route, modelId, guardedTransport) => {
      const upstream = createVideoProtocol(route, modelId, guardedTransport);
      return {
        submit: f.protocol.submit,
        async query(id, key, signal) {
          // Expire the dispatch window after reservation. The runner calls release directly.
          const cutoff = (await f.durableState()).next_query_at.getTime() as number;
          const wall = vi.spyOn(Date, 'now').mockReturnValue(cutoff);
          try {
            return await upstream.query(id, key, signal);
          } finally {
            wall.mockRestore();
          }
        },
      };
    };
    const failures: { id: string; claim: string; time: number }[] = [];
    const release = f.execution.release.bind(f.execution);
    const releaseProbe = vi.spyOn(f.execution, 'release').mockImplementation(async (row) => {
      try {
        await release(row);
      } catch (error) {
        const failure = error as { code?: string; detail?: string };
        if (failure.code === '58000')
          failures.push({ id: row.id, claim: row.claim_id, time: Number(failure.detail) });
        throw error;
      }
    });
    const executor = await createVideoExecutor(
      f.store,
      () => f.provider,
      f.materialize,
      { protocol, transport },
      f.directory,
    );
    cleanups.push(() => executor.close());
    try {
      // PostgreSQL timestamps the failed direct release and the first fallback attempt.
      await vi.waitFor(() => expect(failures.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
      const blocked = await f.durableState();
      expect(blocked).toMatchObject({ state: 'submitted', phase: 'querying', query_attempt: 1 });
      expect(failures[0]).toMatchObject({ id: f.job.jobId, claim: blocked.claim_id });
      expect(failures[1]).toMatchObject({ id: f.job.jobId, claim: blocked.claim_id });
      expect(failures[1]!.time - failures[0]!.time).toBeGreaterThanOrEqual(1000);
      const repairedAt = await f.databaseNow();
      await f.pool.query('UPDATE fixture_release_gate SET allowed=true');
      await vi.waitFor(
        async () =>
          expect(await f.durableState()).toMatchObject({ phase: 'waiting', claim_id: null }),
        { timeout: 5000 },
      );
      const released = await f.durableState();
      expect(released).toMatchObject({
        state: 'submitted',
        query_attempt: 1,
        async_deadline: blocked.async_deadline,
        upstream_task_id: blocked.upstream_task_id,
      });
      expect(released.next_query_at.getTime()).toBeGreaterThanOrEqual(
        repairedAt + VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
      );
      expect(releaseProbe.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(executor.signal.aborted).toBe(false);
      expect(transport).not.toHaveBeenCalled();
      expect(f.protocol.submit).not.toHaveBeenCalled();
    } finally {
      await f.pool.query('UPDATE fixture_release_gate SET allowed=true');
      await executor.close();
      releaseProbe.mockRestore();
    }
  });

  it('stops synchronously on real lease loss and drains a late returned claim without submitting', async () => {
    const f = await fixture();
    await f.execution.close();
    const claimed = Promise.withResolvers<VideoExecution>();
    const resume = Promise.withResolvers<void>();
    const claim = f.execution.claim.bind(f.execution);
    const gate = vi.spyOn(f.execution, 'claim').mockImplementationOnce(async (signal) => {
      const row = await claim(signal);
      claimed.resolve(row!);
      await resume.promise;
      return row;
    });
    const executor = await createVideoExecutor(
      f.store,
      () => f.provider,
      f.materialize,
      { protocol: () => f.protocol },
      f.directory,
    );
    cleanups.push(() => executor.close());
    try {
      const row = await claimed.promise;
      expect(await f.durableState()).toMatchObject({ phase: 'ready', claim_id: row.claim_id });
      const leasePid = await videoLeasePid(f.pool);
      const lost = Promise.withResolvers<void>();
      executor.signal.addEventListener('abort', () => lost.resolve(), { once: true });
      const terminated = await f.pool.query<{ terminated: boolean }>(
        'SELECT pg_terminate_backend($1) AS terminated',
        [leasePid],
      );
      expect(terminated.rows[0]?.terminated).toBe(true);
      await lost.promise;
      expect(executor.signal.reason).toMatchObject({ code: 'VIDEO_UNAVAILABLE', status: 503 });
      executor.wake();
      resume.resolve();
      await vi.waitFor(async () =>
        expect(await f.durableState()).toMatchObject({
          state: 'accepted',
          phase: 'ready',
          claim_id: null,
        }),
      );
      await delay(1100);
      expect(gate).toHaveBeenCalledOnce();
      const closing = executor.close();
      expect(executor.close()).toBe(closing);
      await closing;
      expect(f.protocol.submit).not.toHaveBeenCalled();
      expect(await f.durableState()).toMatchObject({ phase: 'ready', claim_id: null });
    } finally {
      resume.resolve();
      gate.mockRestore();
      await executor.close();
    }
  });

  it('releases and reclaims a committed claim after losing its COMMIT reply', async () => {
    const f = await fixture();
    expect(await f.execution.submitting(await f.next())).toBe(true);
    expect(await f.execution.receive(f.expectedReceipt, true)).toBe('confirmed');
    await f.execution.close();
    await f.makeDue();
    vi.mocked(f.protocol.query).mockResolvedValueOnce({ state: 'processing' });
    const committed = Promise.withResolvers<string>();
    const original = Client.prototype.query;
    const claimants = new WeakSet<Client>();
    let discarded = false;
    const query = vi.spyOn(Client.prototype, 'query').mockImplementation(function (
      this: Client,
      ...args: unknown[]
    ) {
      const sql = args[0];
      if (typeof sql === 'string' && sql.startsWith('UPDATE mio_video_executions SET claim_id=$1'))
        claimants.add(this);
      const result = Reflect.apply(original, this, args);
      if (sql === 'COMMIT' && claimants.has(this) && !discarded) {
        discarded = true;
        return Promise.resolve(result).then(async () => {
          const durable = await f.durableState();
          committed.resolve(durable.claim_id);
          throw new Error('fixture discarded committed claim reply');
        });
      }
      return result;
    });
    const release = vi.spyOn(f.execution, 'release');
    const reserve = vi.spyOn(f.execution, 'beginQuery');
    const start = vi.spyOn(f.execution, 'startExecutor');
    const executor = await createVideoExecutor(
      f.store,
      () => f.provider,
      f.materialize,
      { protocol: () => f.protocol },
      f.directory,
    );
    cleanups.push(() => executor.close());
    try {
      const claim = await committed.promise;
      expect(claim).toEqual(expect.any(String));
      await vi.waitFor(
        async () =>
          expect(await f.durableState()).toMatchObject({
            state: 'submitted',
            phase: 'waiting',
            claim_id: null,
            query_attempt: 0,
            upstream_task_id: 'safe-task',
          }),
        { timeout: 5000 },
      );
      expect(release).toHaveBeenCalledExactlyOnceWith({ id: f.job.jobId, claim_id: claim });
      await vi.waitFor(
        async () =>
          expect(await f.durableState()).toMatchObject({ state: 'processing', query_attempt: 1 }),
        { timeout: 5000 },
      );
      expect(reserve).toHaveBeenCalledOnce();
      expect(reserve.mock.calls[0]![0].claim_id).not.toBe(claim);
      expect(start).toHaveBeenCalledOnce();
      expect(executor.signal.aborted).toBe(false);
      expect(f.protocol.query).toHaveBeenCalledOnce();
      expect(f.protocol.submit).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
      release.mockRestore();
      reserve.mockRestore();
      start.mockRestore();
      await executor.close();
    }
  });

  it('recovers when PostgreSQL terminates a checked-out claim client and keeps the lease', async () => {
    const f = await fixture();
    expect(await f.execution.submitting(await f.next())).toBe(true);
    expect(await f.execution.receive(f.expectedReceipt, true)).toBe('confirmed');
    await f.execution.close();
    await f.makeDue();
    vi.mocked(f.protocol.query).mockResolvedValueOnce({ state: 'processing' });
    const updated = Promise.withResolvers<{ pid: number; claimId: string }>();
    const disconnected = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const original = Client.prototype.query;
    const doomed = new WeakSet<Client>();
    const rollback = vi.fn();
    let interrupted = false;
    const probe = vi.spyOn(Client.prototype, 'query').mockImplementation(function (
      this: Client,
      ...args: unknown[]
    ) {
      const sql = args[0];
      if (sql === 'ROLLBACK' && doomed.has(this)) rollback();
      const result = Reflect.apply(original, this, args);
      if (
        !interrupted &&
        typeof sql === 'string' &&
        sql.startsWith('UPDATE mio_video_executions SET claim_id=$1')
      ) {
        interrupted = true;
        doomed.add(this);
        return Promise.resolve(result).then(async (written) => {
          const metadata = await Reflect.apply(original, this, ['SELECT pg_backend_pid() AS pid']);
          this.once('end', () => disconnected.resolve());
          updated.resolve({ pid: metadata.rows[0].pid, claimId: (args[1] as [string])[0] });
          await resume.promise;
          return written;
        });
      }
      return result;
    });
    const release = vi.spyOn(f.execution, 'release');
    const reserve = vi.spyOn(f.execution, 'beginQuery');
    const executor = await createVideoExecutor(
      f.store,
      () => f.provider,
      f.materialize,
      { protocol: () => f.protocol },
      f.directory,
    );
    cleanups.push(() => executor.close());
    try {
      const { pid, claimId } = await updated.promise;
      const lease = await videoLeasePid(f.pool);
      expect(pid).not.toBe(lease);
      const terminated = await f.pool.query<{ terminated: boolean }>(
        'SELECT pg_terminate_backend($1) AS terminated',
        [pid],
      );
      expect(terminated.rows[0]?.terminated).toBe(true);
      await disconnected.promise;
      expect(await f.durableState()).toMatchObject({
        phase: 'waiting',
        claim_id: null,
        query_attempt: 0,
      });
      resume.resolve();
      await vi.waitFor(
        () =>
          expect(release).toHaveBeenCalledExactlyOnceWith({ id: f.job.jobId, claim_id: claimId }),
        { timeout: 5000 },
      );
      await vi.waitFor(
        async () =>
          expect(await f.durableState()).toMatchObject({ state: 'processing', query_attempt: 1 }),
        { timeout: 5000 },
      );
      expect(reserve.mock.calls[0]![0].claim_id).not.toBe(claimId);
      expect(await videoLeasePid(f.pool)).toBe(lease);
      expect(executor.signal.aborted).toBe(false);
      expect(rollback).not.toHaveBeenCalled();
      expect(f.protocol.query).toHaveBeenCalledOnce();
      expect(f.protocol.submit).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await executor.close();
      probe.mockRestore();
      release.mockRestore();
      reserve.mockRestore();
    }
  });

  it('returns the original reservation from one statement when a new lease claims the job before its caller resumes', async () => {
    const f = await fixture();
    expect(await f.execution.submitting(await f.next())).toBe(true);
    await f.execution.receive(f.expectedReceipt, true);
    const claimed = await f.next();
    const separate = new Pool({ connectionString: f.databaseURL });
    cleanups.push(() => separate.end());
    const takeover = new VideoGenerationStore(separate).executorStore();
    cleanups.push(() => takeover.close());
    const query = f.pool.query.bind(f.pool);
    let renewed: VideoExecution | undefined;
    const oldQuery = vi.spyOn(f.pool, 'query').mockImplementationOnce(async (sql, values) => {
      const result = await query(sql, values);
      const cutoff = result.rows[0].next_query_at as Date;
      await f.execution.close();
      await takeover.startExecutor(() => {});
      const next = (
        await separate.query<{ next_query_at: Date }>(
          'SELECT next_query_at FROM mio_video_executions WHERE job_id=$1',
          [claimed.id],
        )
      ).rows[0]!.next_query_at;
      expect(next.getTime()).toBeGreaterThanOrEqual(
        cutoff.getTime() + VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
      );
      expect(await takeover.claim()).toBeUndefined();
      // Advance just the fixture's due time after checking the real takeover floor.
      await separate.query(
        'UPDATE mio_video_executions SET next_query_at=statement_timestamp() WHERE job_id=$1',
        [claimed.id],
      );
      renewed = await takeover.claim();
      expect(renewed?.claim_id).toEqual(expect.any(String));
      expect(renewed?.claim_id).not.toBe(claimed.claim_id);
      return result;
    });
    let reserved: Awaited<ReturnType<typeof f.execution.beginQuery>>;
    try {
      reserved = await f.execution.beginQuery(claimed);
      expect(oldQuery).toHaveBeenCalledOnce();
      expect(oldQuery.mock.calls[0]![0]).toMatch(/^UPDATE .*?[\s\S]+RETURNING/);
      expect(reserved).toMatchObject({
        id: claimed.id,
        claim_id: claimed.claim_id,
        phase: 'querying',
        query_attempt: 1,
      });
    } finally {
      oldQuery.mockRestore();
    }
    const current = await f.durableState();
    expect(current).toMatchObject({
      phase: 'waiting',
      claim_id: renewed!.claim_id,
      query_attempt: 1,
    });
    await f.execution.release(reserved!);
    expect(await f.durableState()).toEqual(current);
    expect(f.protocol.submit).not.toHaveBeenCalled();
    expect(f.protocol.query).not.toHaveBeenCalled();
  });

  it('shares four slots between execution, cleanup and receipt reconciliation through pressure and shutdown', async () => {
    const f = await fixture();
    const original = await f.next();
    expect(await f.execution.submitting(original)).toBe(true);
    await f.execution.terminal(original, 'unknown', 'VIDEO_SUBMISSION_UNKNOWN');
    await f.pool.query(
      "UPDATE mio_video_executions SET async_deadline=now()-interval '1 second' WHERE job_id=$1",
      [original.id],
    );
    const newCommand = (): VideoJobCommand => ({
      request: { ...f.request, requestId: randomUUID() },
      inputSnapshot: [],
    });
    const completed = await f.create(newCommand());
    const materializeOwner = randomUUID();
    const jobs = await Promise.all(
      Array.from({ length: 5 }, () => f.create(newCommand(), materializeOwner)),
    );
    const ids = jobs.map(({ jobId }) => jobId);
    await f.pool.query("UPDATE mio_video_jobs SET state='completed' WHERE id=$1", [
      completed.jobId,
    ]);
    await f.pool.query("UPDATE mio_video_jobs SET state='materializing' WHERE id=ANY($1)", [ids]);
    const videos = [{ url: 'https://media.fixture/background.mp4' }];
    await f.pool.query(
      "UPDATE mio_video_executions SET phase='done',checkpoint=$2 WHERE job_id=$1",
      [completed.jobId, JSON.stringify({ videos, materializationAttempts: 1, cleaned: true })],
    );
    await f.pool.query(
      "UPDATE mio_video_executions SET phase='materializing',checkpoint=$2 WHERE job_id=ANY($1)",
      [ids, JSON.stringify({ videos, materializationAttempts: 0 })],
    );
    await f.execution.close();

    let peak = 0;
    const active = new Map<string, () => void>();
    const entered: string[] = [];
    const hold = async <T>(key: string, work: () => Promise<T>) => {
      const gate = Promise.withResolvers<void>();
      active.set(key, gate.resolve);
      entered.push(key);
      peak = Math.max(peak, active.size);
      try {
        const result = await work();
        await gate.promise;
        return result;
      } finally {
        active.delete(key);
      }
    };
    const runners = () => entered.filter((key) => key.startsWith('runner:'));
    const receive = f.execution.receive.bind(f.execution);
    const receipt = vi
      .spyOn(f.execution, 'receive')
      .mockImplementation((row, canReplay) =>
        hold('receipt:' + row.jobId, () => receive(row, canReplay)),
      );
    const closeSignals: AbortSignal[] = [];
    const cleanup = async (row: VideoExecution, signal: AbortSignal) => {
      await hold('cleanup:' + row.id, async () => {
        closeSignals.push(signal);
      });
      signal.throwIfAborted();
    };
    const materialize: VideoMaterializer = async (row, _source, index, signal) => {
      await hold('runner:' + row.id, async () => {
        closeSignals.push(signal);
      });
      signal.throwIfAborted();
      return {
        ...f.output,
        index,
        assetId: randomUUID(),
        key: 'mio/derived/video/' + row.id + '.mp4',
      };
    };
    const executor = await createVideoExecutor(
      f.store,
      () => f.provider,
      materialize,
      { protocol: () => f.protocol, cleanup },
      f.directory,
    );
    cleanups.push(() => executor.close());
    const cleanKey = 'cleanup:' + completed.jobId;
    const receiptKey = 'receipt:' + original.id;
    try {
      await vi.waitFor(() => expect(runners()).toHaveLength(4), { timeout: 5000 });
      await f.pool.query(
        `UPDATE mio_video_executions SET checkpoint=checkpoint-'cleaned',updated_at='2000-01-01'
         WHERE job_id=$1`,
        [completed.jobId],
      );
      executor.wake();
      await delay(1100);
      expect(entered).toHaveLength(4);

      active.get(runners()[0]!)!();
      await vi.waitFor(() => expect(active.has(cleanKey)).toBe(true), { timeout: 5000 });
      expect(runners()).toHaveLength(4);
      expect(active.size).toBe(4);
      active.get(runners()[1]!)!();
      await vi.waitFor(() => expect(runners()).toHaveLength(5), { timeout: 5000 });
      expect(active.has(cleanKey)).toBe(true);
      expect(active.size).toBe(4);

      await f.receipts.prepare();
      await writeFile(f.receiptPath, JSON.stringify(f.expectedReceipt), { mode: 0o600 });
      executor.wake();
      await delay(1100);
      expect(receipt).not.toHaveBeenCalled();
      active.get(cleanKey)!();
      await vi.waitFor(() => expect(active.has(receiptKey)).toBe(true), { timeout: 5000 });
      expect(active.size).toBe(4);
      expect(peak).toBe(4);
      await vi.waitFor(async () =>
        expect(await f.durableState()).toMatchObject({
          state: 'unknown',
          upstream_task_id: f.expectedReceipt.upstreamTaskId,
        }),
      );
      expect(
        (
          await f.pool.query('SELECT checkpoint FROM mio_video_executions WHERE job_id=$1', [
            completed.jobId,
          ])
        ).rows[0].checkpoint.cleaned,
      ).toBe(true);

      let closed = false;
      const closing = executor.close().then(() => {
        closed = true;
      });
      expect(executor.signal.aborted).toBe(true);
      expect(closeSignals.every((signal) => signal.aborted)).toBe(true);
      executor.wake();
      await Promise.resolve();
      expect(closed).toBe(false);
      for (const release of active.values()) release();
      await closing;
      expect(receipt).toHaveBeenCalledOnce();
      expect(entered).toHaveLength(7);
      expect(f.protocol.submit).not.toHaveBeenCalled();
      expect(f.protocol.query).not.toHaveBeenCalled();
    } finally {
      const closing = executor.close();
      for (const release of active.values()) release();
      await closing;
      receipt.mockRestore();
    }
  });
});
