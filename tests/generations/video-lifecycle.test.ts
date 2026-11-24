import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { VideoGenerationStore } from '../../src/generations/video-store.ts';
import { createVideoRunner } from '../../src/generations/video-runner.ts';
import type { VideoExecutorProvider } from '../../src/generations/video-runner.ts';
import type {
  VideoMaterializedOutput,
  VideoMaterializer,
  VideoProtocol,
} from '../../src/generations/video-execution.ts';
import type { VideoCreateRequest } from '../../src/generations/video-contracts.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
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
  const actor = { userId: randomUUID(), sessionId: 'video-lifecycle' };
  const request: VideoCreateRequest = {
    requestId: randomUUID(),
    modelRef: 'onelink:model:' + randomUUID(),
    expectedCapabilitiesVersion: 'video-capability-test',
    parameters: { mode: 'text_to_video', prompt: 'a tiny movie', durationSeconds: 4 },
  };
  const job = await store.create(
    actor.userId,
    request,
    'stable-input-hash',
    { request, inputSnapshot: [] },
    {
      providerConfigId: randomUUID(),
      modelKey: randomUUID(),
      credentialVersion: 1,
      catalogVersion: 1,
      adaptationVersion: 1,
      driver: 'volcengine-ark-videos',
    },
    { providerConfigId: randomUUID(), credentialVersion: 1, credential: {} },
    {
      modelId: 'doubao-seedance-1.5-pro',
      route: {
        driver: 'volcengine-ark-videos',
        vendor: 'volcengine',
        submitPath: '/volc/api/v3/contents/generations/tasks',
        queryPathTemplate: '/volc/api/v3/contents/generations/tasks/{task_id}',
        paramSpec: { supportedModes: ['text_to_video'] },
        requestDefaults: {},
        outputSpec: {},
      },
    },
  );
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
  const run = createVideoRunner(
    execution,
    () => provider,
    materialize,
    new AbortController().signal,
    { protocol: () => protocol },
  );
  const next = async () => {
    await pool.query('UPDATE mio_video_executions SET next_query_at=now() WHERE job_id=$1', [
      job.jobId,
    ]);
    const row = await execution.claim();
    expect(row).toBeDefined();
    return row!;
  };
  return {
    database,
    pool,
    store,
    execution,
    actor,
    request,
    job,
    protocol,
    provider,
    output,
    materialize,
    run,
    next,
  };
}

describe('durable video execution', () => {
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

  it('resumes the same upstream GET after a lost querying process and preserves its budget', async () => {
    const f = await fixture();
    await f.run(await f.next());
    const queried = await f.execution.beginQuery(await f.next());
    expect(queried?.query_attempt).toBe(1);
    await f.execution.close();
    await f.execution.startExecutor(() => {});
    const resumed = await f.next();
    expect(resumed.phase).toBe('waiting');
    expect(resumed.upstream_task_id).toBe('safe-task');
    expect(resumed.query_attempt).toBe(1);
    await f.run(resumed);
    expect((await f.store.get(f.actor.userId, f.job.jobId)).state).toBe('completed');
    expect(f.protocol.submit).toHaveBeenCalledTimes(1);
    const row = (
      await f.pool.query('SELECT query_attempt FROM mio_video_executions WHERE job_id=$1', [
        f.job.jobId,
      ])
    ).rows[0];
    expect(row.query_attempt).toBe(2);
  });

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

// A durable intent is not permission to use a replaced key or disabled model.
it('rejects a ready intent when its current admission changes, without one POST', async () => {
  const f = await fixture();
  f.provider.snapshotVideo.mockRejectedValueOnce(new Error('MODEL_DISABLED'));
  await f.run(await f.next());
  expect(f.protocol.submit).not.toHaveBeenCalled();
  expect((await f.store.get(f.actor.userId, f.job.jobId)).state).toBe('rejected');
});
it('rejects a ready intent when its credential generation changes', async () => {
  const f = await fixture();
  f.provider.snapshotVideo.mockResolvedValueOnce({
    capabilitiesVersion: 'rotated',
    credentialVersion: 2,
  } as Awaited<ReturnType<VideoExecutorProvider['snapshotVideo']>>);
  await f.run(await f.next());
  expect(f.protocol.submit).not.toHaveBeenCalled();
  expect((await f.store.get(f.actor.userId, f.job.jobId)).state).toBe('rejected');
});
