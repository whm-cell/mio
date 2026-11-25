import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Pool } from 'pg';
import COS from 'cos-nodejs-sdk-v5';
import { describe, expect, it, vi } from 'vitest';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { createAssetStore } from '../../src/assets/store.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { VIDEO_QUOTA_LOCK } from '../../src/generations/video/execution.ts';
import { createVideoGenerationHandler } from '../../src/generations/video/http.ts';
import { createVideoInputResolver } from '../../src/generations/video/inputs.ts';
import { createVideoMaterializer } from '../../src/generations/video/media.ts';
import { createVideoRunner } from '../../src/generations/video/runner.ts';
import { createVideoGenerationService } from '../../src/generations/video/service.ts';
import { VideoGenerationStore } from '../../src/generations/video/store.ts';
import { VideoSubmissionReceipts } from '../../src/generations/video/submission-receipts.ts';
import type {
  VideoAssetReference,
  VideoCreateRequest,
} from '../../src/generations/video/contracts.ts';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { createVideoProtocol } from '../../src/integrations/onelink/video/index.ts';
import type { withPublicHttps } from '../../src/integrations/onelink/public-https.ts';
import type { VideoRouteConfig } from '../../src/providers/contracts.ts';
import type { ProviderService } from '../../src/providers/service.ts';
import { authDatabase } from '../support/auth-database.ts';

const actor = { userId: randomUUID(), sessionId: 'video-http-test' };
const origin = 'https://demo.fixture';
const jobId = randomUUID();
const requestId = randomUUID();

type ResponseFixture = {
  status: number;
  headers: Map<string, string | number | readonly string[]>;
  body: string;
};

async function send(
  handler: ReturnType<typeof createVideoGenerationHandler>,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<ResponseFixture> {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  Object.assign(request, { method, url, headers });
  const response: ResponseFixture & {
    setHeader(name: string, value: string | number | readonly string[]): void;
    writeHead(status: number, headers?: Record<string, string>): typeof response;
    end(body?: string): typeof response;
  } = {
    status: 200,
    headers: new Map(),
    body: '',
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    writeHead(status, responseHeaders) {
      this.status = status;
      for (const [name, value] of Object.entries(responseHeaders ?? {}))
        this.headers.set(name.toLowerCase(), value);
      return this;
    },
    end(value = '') {
      this.body = value;
      return this;
    },
  };
  await handler(request as IncomingMessage, response as unknown as ServerResponse);
  return response;
}

describe('video generation HTTP boundary', () => {
  it('supports owner scoped reads, keyset query parameters, and a single explicit create request', async () => {
    const service = {
      capabilities: vi.fn().mockResolvedValue({ available: false, modes: [] }),
      create: vi.fn().mockResolvedValue({ created: true, job: { id: jobId } }),
      get: vi.fn().mockResolvedValue({ id: jobId }),
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof createVideoGenerationService>;
    const identity = vi.fn(async () => actor);
    const handler = createVideoGenerationHandler(service, identity, [origin]);
    const base = '/api/v1/compute';

    const cursor = Buffer.from(
      JSON.stringify({ createdAt: '2026-11-23T12:00:00.123456Z', id: randomUUID() }),
    ).toString('base64url');
    const listResponse = await send(handler, 'GET', `${base}/videos?limit=2&cursor=${cursor}`);
    expect(listResponse.status).toBe(200);
    expect(service.list).toHaveBeenCalledWith(actor, 2, cursor);

    const duplicateQuery = await send(handler, 'GET', `${base}/videos?limit=2&limit=3`);
    expect(duplicateQuery.status).toBe(400);
    expect(service.list).toHaveBeenCalledTimes(1);

    const jobResponse = await send(handler, 'GET', `${base}/videos/${jobId}`);
    expect(jobResponse.status).toBe(200);
    expect(service.get).toHaveBeenCalledWith(actor, jobId);

    const options = await send(handler, 'OPTIONS', `${base}/videos`, { origin });
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');

    const body = {
      requestId,
      modelRef: `onelink:model:${randomUUID()}`,
      expectedCapabilitiesVersion: 'cap-v1',
      parameters: { mode: 'text_to_video', prompt: 'one explicit request' },
    };
    const created = await send(
      handler,
      'POST',
      `${base}/videos`,
      { origin, 'content-type': 'application/json' },
      JSON.stringify(body),
    );
    expect(created.status).toBe(202);
    expect(JSON.parse(created.body)).toEqual({ id: jobId });
    expect(service.create).toHaveBeenCalledWith(actor, body);
    expect(identity).toHaveBeenCalledTimes(4);
  });

  it('rejects untrusted origins, unsupported methods, and unknown query parameters', async () => {
    const service = {
      capabilities: vi.fn(),
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      close: vi.fn(),
    } as unknown as ReturnType<typeof createVideoGenerationService>;
    const handler = createVideoGenerationHandler(service, async () => actor, [origin]);
    const base = '/api/v1/compute/videos';

    expect((await send(handler, 'GET', base, { origin: 'https://untrusted.fixture' })).status).toBe(
      403,
    );
    expect((await send(handler, 'GET', `${base}?ownerId=${randomUUID()}`)).status).toBe(400);
    expect((await send(handler, 'DELETE', base)).status).toBe(405);
    expect(service.list).not.toHaveBeenCalled();
    expect(service.create).not.toHaveBeenCalled();
  });
});

async function assetHttpFixture() {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(generationSchemaSQL);
  const assets = await createAssetStore(database.url);
  let assetsClosed = false;
  const store = new VideoGenerationStore(pool);
  const execution = store.executorStore();
  await execution.startExecutor(() => {});
  const directory = await mkdtemp(join(tmpdir(), 'mio-video-http-'));
  const heads = new Map<string, Awaited<ReturnType<AssetObjectStore['head']>>>();
  const generatedVideo = 'https://video.fixture/render.mp4';
  const outputBytes = Buffer.from('video for a fixture Worker');
  const objects = {
    uploadUrl: vi.fn(),
    downloadUrl: vi.fn(),
    copy: vi.fn<AssetObjectStore['copy']>(async (source, target, etag, acl) => {
      const head = heads.get(source);
      if (!head || head.etag !== etag || heads.has(target) || acl !== 'private')
        throw new Error('unexpected video copy');
      const copied = { ...head, etag: 'fixture-raw-etag' };
      heads.set(target, copied);
      return { etag: copied.etag };
    }),
    delete: vi.fn(),
    materialUrl: vi.fn((key) => `https://cos.fixture/${key}?signature=fixture`),
    head: vi.fn<AssetObjectStore['head']>(async (key) => {
      const head = heads.get(key);
      if (!head) throw Object.assign(new Error('private COS error'), { statusCode: 404 });
      return head;
    }),
    putVideo: vi.fn<NonNullable<AssetObjectStore['putVideo']>>(
      async (key, stream, sizeBytes, sha256) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        if (!Buffer.concat(chunks).equals(outputBytes)) throw new Error('unexpected video bytes');
        const etag = 'fixture-staging-etag';
        const contentType = 'video/mp4';
        heads.set(key, { size: sizeBytes, etag, sha256, contentType });
        return { key, etag, sha256, sizeBytes, contentType };
      },
    ),
  } satisfies AssetObjectStore;
  const inputs = createVideoInputResolver(assets, objects);
  const capabilitiesVersion = 'asset-http-capabilities';
  const route: VideoRouteConfig = {
    driver: 'volcengine-ark-videos',
    vendor: 'volcengine',
    submitPath: '/volc/api/v3/contents/generations/tasks',
    queryPathTemplate: '/volc/api/v3/contents/generations/tasks/{task_id}',
    paramSpec: {
      supportedModes: ['full'],
      parameters: {
        ratios: ['16:9'],
        resolutions: ['480P'],
        durations: [4],
        maxPromptCodepoints: 1000,
        maxImages: 4,
        maxVideos: 1,
        maxAudios: 1,
        maxInputs: 6,
        maxSubjects: 0,
        maxSubjectImages: 0,
        generateAudio: false,
        watermark: false,
        offPeak: false,
        audioSettings: [],
        requiresResolution: false,
        referenceAudioRequiresVisual: true,
        referenceDurations: [4],
      },
    },
    requestDefaults: {},
    outputSpec: {},
  };
  const videoCapabilities = vi.fn(async () => ({
    capabilitiesVersion,
    available: true,
    modes: [{ mode: 'full', supported: true }],
  }));
  const snapshotVideo = vi.fn(async () => ({
    capabilitiesVersion,
    route,
    modelId: 'doubao-seedance-2-0-fast',
    providerConfigId: randomUUID(),
    credentialVersion: 1,
    credential: {},
  }));
  const provider = {
    videoCapabilities,
    snapshotVideo,
    openImageSnapshot: vi.fn(() => 'fixture-key'),
    resolveImageTaskCredential: vi.fn(async () => 'fixture-key'),
  } as unknown as ProviderService;
  const upstream = vi.fn<typeof fetch>(async (_url, options) =>
    options?.method === 'POST'
      ? Response.json({ id: 'fixture-task' })
      : Response.json({
          id: 'fixture-task',
          status: 'succeeded',
          content: { video_url: generatedVideo },
        }),
  );
  const wake = vi.fn();
  const stop = new AbortController();
  const receipts = new VideoSubmissionReceipts(directory);
  const download: typeof withPublicHttps = async (url, signal, consume) => {
    expect(url.href).toBe(generatedVideo);
    signal.throwIfAborted();
    return consume(new Response(outputBytes));
  };
  const materialize = createVideoMaterializer(
    objects,
    directory,
    async () => ({
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      videoCodec: 'h264',
      width: 640,
      height: 360,
      durationSeconds: 4,
      hasAudio: false,
      audioCodec: null,
    }),
    download,
  );
  const run = createVideoRunner(
    execution,
    () => provider,
    materialize,
    stop.signal,
    {
      protocol: createVideoProtocol,
      transport: upstream,
      references: (row, activeSignal) =>
        inputs.resolve(
          row.owner_id,
          row.command.inputSnapshot,
          activeSignal,
          row.command.inputObjects,
        ),
    },
    receipts,
  );
  const service = createVideoGenerationService(store, () => provider, { wake }, inputs.inspect);
  const handler = createVideoGenerationHandler(
    service,
    async (headers) => (headers.get('cookie') === 'session=fixture' ? actor : null),
    [origin],
  );
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('video test server address missing');
  const endpoint = `http://127.0.0.1:${address.port}/api/v1/compute/videos`;
  const modelRef = 'onelink:model:' + randomUUID();
  const request = (
    references: VideoAssetReference[],
    id: string = randomUUID(),
  ): VideoCreateRequest => ({
    requestId: id,
    modelRef,
    expectedCapabilitiesVersion: capabilitiesVersion,
    parameters: { mode: 'full', prompt: 'ordered references', references },
  });
  return {
    pool,
    store,
    service,
    execution,
    server,
    applicationName: database.applicationName,
    request,
    videoCapabilities,
    snapshotVideo,
    heads,
    objects,
    upstream,
    wake,
    closeAdmissions: service.close,
    stopRunner: () => stop.abort(),
    async addAsset(
      assetOwner = actor.userId,
      state = 'ready',
      contentType = 'image/png',
      derived = false,
    ) {
      const assetId = randomUUID();
      const key = `mio/raw/${assetId}/${randomUUID()}`;
      const head = { size: 100, etag: 'raw-etag' };
      heads.set(key, head);
      await pool.query(
        `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,
         raw_key,state,source_etag,expires_at,staging_deleted_at,asset_kind)
         VALUES($1,$2,'fixture',$3,$4,$5,$6,$7,$8,now(),now(),$9)`,
        [
          assetId,
          assetOwner,
          contentType,
          head.size,
          derived ? null : `mio/staging/${assetId}`,
          key,
          state,
          derived ? head.etag : 'staging-etag',
          derived ? 'derived' : 'original',
        ],
      );
      return { assetId, key, head };
    },
    post(references: VideoAssetReference[], id?: string, signal?: AbortSignal) {
      return fetch(endpoint, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', cookie: 'session=fixture' },
        body: JSON.stringify(request(references, id)),
        signal: signal ?? null,
      });
    },
    get(id: string) {
      return fetch(`${endpoint}/${id}`, { headers: { cookie: 'session=fixture' } });
    },
    async runNext() {
      const row = await execution.claim();
      if (!row) throw new Error('video fixture has no ready execution');
      await run(row);
      return row;
    },
    async closeAssets() {
      await assets.close();
      assetsClosed = true;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.close();
      if (!assetsClosed) await assets.close();
      await receipts.close();
      await execution.close();
      await pool.end();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe('video admission cancellation', () => {
  const expectUnadmitted = async (f: Awaited<ReturnType<typeof assetHttpFixture>>) => {
    const { rows } = await f.pool.query(`SELECT
      (SELECT count(*) FROM mio_video_jobs) AS jobs,
      (SELECT count(*) FROM mio_video_executions) AS executions`);
    expect(rows[0]).toEqual({ jobs: '0', executions: '0' });
    expect(f.wake).not.toHaveBeenCalled();
    expect(f.upstream).not.toHaveBeenCalled();
  };

  it.each(['provider capabilities', 'provider snapshot', 'material inspection'] as const)(
    'stops admission when a tool turn is cancelled during %s',
    async (stage) => {
      const f = await assetHttpFixture();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const pause = async () => {
        entered.resolve();
        await resume.promise;
      };
      const controller = new AbortController();
      try {
        const asset = await f.addAsset();
        if (stage === 'provider capabilities') {
          const query = f.videoCapabilities.getMockImplementation()!;
          f.videoCapabilities.mockImplementationOnce(async () => {
            await pause();
            return query();
          });
        } else if (stage === 'provider snapshot') {
          const query = f.snapshotVideo.getMockImplementation()!;
          f.snapshotVideo.mockImplementationOnce(async () => {
            await pause();
            return query();
          });
        } else {
          f.objects.head.mockImplementationOnce(async () => {
            await pause();
            return asset.head;
          });
        }
        const pending = f.service.create(
          actor,
          f.request([{ assetId: asset.assetId }]),
          controller.signal,
        );
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('video admitted before the cancellation barrier');
          }),
        ]);
        controller.abort();
        if (stage === 'material inspection')
          expect(f.objects.head.mock.calls[0]?.[1]?.aborted).toBe(true);
        else resume.resolve();
        await expect(pending).rejects.toBe(controller.signal.reason);
        await expectUnadmitted(f);
        if (stage === 'provider capabilities') expect(f.snapshotVideo).not.toHaveBeenCalled();
        if (stage !== 'material inspection') expect(f.objects.head).not.toHaveBeenCalled();
        if (stage === 'material inspection') expect(f.objects.materialUrl).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await f.close();
      }
    },
  );

  it.each(['quota lock', 'both inserts'] as const)(
    'rolls back a video tool submission cancelled at %s before COMMIT',
    async (stage) => {
      const f = await assetHttpFixture();
      const gate = await f.pool.connect();
      const lock = stage === 'quota lock' ? VIDEO_QUOTA_LOCK : randomInt(1, 2147483647);
      let pending: ReturnType<typeof f.service.create> | undefined;
      try {
        await gate.query('SELECT pg_advisory_lock($1)', [lock]);
        if (stage === 'quota lock') {
          // A sequence increment survives rollback, so this detects even a transient insert.
          await f.pool.query(`CREATE SEQUENCE video_job_insert_attempts;
            CREATE FUNCTION observe_video_job_insert() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN PERFORM nextval('video_job_insert_attempts'); RETURN NEW; END $$;
            CREATE TRIGGER observe_video_job_insert AFTER INSERT ON mio_video_jobs
              FOR EACH ROW EXECUTE FUNCTION observe_video_job_insert()`);
        } else {
          await f.pool
            .query(`CREATE FUNCTION pause_video_execution_insert() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN PERFORM pg_advisory_xact_lock(${lock}); RETURN NEW; END $$;
            CREATE TRIGGER pause_video_execution_insert AFTER INSERT ON mio_video_executions
              FOR EACH ROW EXECUTE FUNCTION pause_video_execution_insert()`);
        }
        const asset = await f.addAsset();
        const controller = new AbortController();
        pending = f.service.create(
          actor,
          f.request([{ assetId: asset.assetId }]),
          controller.signal,
        );
        void pending.catch(() => {});
        await vi.waitFor(
          async () => {
            const { rows } = await f.pool.query<{ query: string }>(
              `SELECT a.query FROM pg_locks l JOIN pg_stat_activity a USING(pid)
             WHERE a.application_name=$1 AND l.locktype='advisory'
               AND l.classid=0 AND l.objid=$2::oid AND NOT l.granted`,
              [f.applicationName, lock],
            );
            expect(rows).toHaveLength(1);
            expect(rows[0]?.query).toContain(
              stage === 'quota lock' ? 'pg_advisory_xact_lock' : 'INSERT INTO mio_video_executions',
            );
          },
          { timeout: 4000 },
        );
        controller.abort();
        await gate.query('SELECT pg_advisory_unlock($1)', [lock]);
        await expect(pending).rejects.toBe(controller.signal.reason);
        await expectUnadmitted(f);
        if (stage === 'quota lock') {
          const { rows } = await f.pool.query('SELECT is_called FROM video_job_insert_attempts');
          expect(rows[0]?.is_called).toBe(false);
        }
      } finally {
        await gate.query('SELECT pg_advisory_unlock($1)', [lock]);
        gate.release();
        await Promise.allSettled([pending]);
        await f.close();
      }
    },
  );

  it('wakes a committed job after tool cancellation and completes only its original upstream task', async () => {
    const f = await assetHttpFixture();
    const committed = Promise.withResolvers<string>();
    const resume = Promise.withResolvers<void>();
    const create = f.store.create.bind(f.store);
    const admission = vi.spyOn(f.store, 'create').mockImplementationOnce(async (...args) => {
      const stored = await create(...args);
      committed.resolve(stored.jobId);
      await resume.promise;
      return stored;
    });
    const controller = new AbortController();
    try {
      const asset = await f.addAsset();
      const request = f.request([{ assetId: asset.assetId }]);
      const pending = f.service.create(actor, request, controller.signal);
      const id = await Promise.race([
        committed.promise,
        pending.then(() => {
          throw new Error('video admission settled before the post-COMMIT barrier');
        }),
      ]);
      expect(await f.store.get(actor.userId, id)).toMatchObject({
        state: 'accepted',
        stage: 'ready',
      });
      expect(f.wake).not.toHaveBeenCalled();
      controller.abort();
      resume.resolve();
      await expect(pending).resolves.toMatchObject({ created: true, job: { id } });
      expect(f.wake).toHaveBeenCalledTimes(1);
      await f.runNext();
      await f.pool.query('UPDATE mio_video_executions SET next_query_at=now() WHERE job_id=$1', [
        id,
      ]);
      await f.runNext();
      const replay = await f.service.create(actor, request);
      expect(replay).toMatchObject({
        created: false,
        job: { id, state: 'completed', outputs: [{ status: 'registered' }] },
      });
      expect(f.wake).toHaveBeenCalledTimes(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
      expect(f.objects.copy).toHaveBeenCalledTimes(1);
      expect(
        f.upstream.mock.calls.map(([url, options]) => [
          new URL(String(url)).pathname,
          options?.method,
        ]),
      ).toEqual([
        ['/volc/api/v3/contents/generations/tasks', 'POST'],
        ['/volc/api/v3/contents/generations/tasks/fixture-task', 'GET'],
      ]);
      expect(await f.execution.claim()).toBeUndefined();
    } finally {
      resume.resolve();
      admission.mockRestore();
      await f.close();
    }
  });

  it('keeps ordinary HTTP admission running after the authenticated client disconnects', async () => {
    const f = await assetHttpFixture();
    const entered = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const controller = new AbortController();
    try {
      f.server.prependOnceListener('request', (_request, response) => {
        response.once('close', () => disconnected.resolve());
      });
      const snapshot = f.snapshotVideo.getMockImplementation()!;
      f.snapshotVideo.mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
        return snapshot();
      });
      const asset = await f.addAsset();
      const id = randomUUID();
      const pending = f.post([{ assetId: asset.assetId }], id, controller.signal);
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('HTTP replied before the disconnect barrier');
        }),
      ]);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await disconnected.promise;
      resume.resolve();
      await vi.waitFor(() => expect(f.wake).toHaveBeenCalledTimes(1));
      const durable = await f.store.byRequest(actor.userId, id);
      expect(durable?.jobId).toBeDefined();
      expect(await f.store.get(actor.userId, durable!.jobId)).toMatchObject({ state: 'accepted' });
      await f.runNext();
      expect(f.upstream).toHaveBeenCalledTimes(1);
      expect(await f.store.get(actor.userId, durable!.jobId)).toMatchObject({ state: 'submitted' });
    } finally {
      resume.resolve();
      await f.close();
    }
  });
});

describe('video asset admission over HTTP', () => {
  it('distinguishes asset rejection from PG and COS failure with zero upstream POSTs', async () => {
    const f = await assetHttpFixture();
    try {
      const outside = await f.addAsset(randomUUID());
      const pending = await f.addAsset(actor.userId, 'pending');
      const original = await f.addAsset();
      const derived = await f.addAsset(actor.userId, 'ready', 'video/mp4', true);
      const missing = await f.addAsset();
      f.heads.delete(missing.key);
      f.heads.set(derived.key, { ...derived.head, etag: 'replaced-etag' });
      const rejected = async (reference: VideoAssetReference, status: number, code: string) => {
        const response = await f.post([reference]);
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({
          error: { code, message: code, requestId: expect.any(String) },
        });
      };
      await rejected({ assetId: randomUUID() }, 404, 'ASSET_NOT_FOUND');
      await rejected({ assetId: outside.assetId }, 404, 'ASSET_NOT_FOUND');
      await rejected({ assetId: pending.assetId }, 404, 'ASSET_NOT_FOUND');
      await rejected({ assetId: original.assetId, mediaType: 'video' }, 400, 'VIDEO_INPUT_INVALID');
      expect(f.objects.head).not.toHaveBeenCalled();
      await rejected({ assetId: missing.assetId }, 409, 'VIDEO_INPUT_CHANGED');
      await rejected({ assetId: derived.assetId, mediaType: 'video' }, 409, 'VIDEO_INPUT_CHANGED');
      f.objects.head.mockResolvedValueOnce({ ...original.head, size: original.head.size + 1 });
      await rejected({ assetId: original.assetId }, 409, 'VIDEO_INPUT_CHANGED');
      f.objects.head.mockRejectedValueOnce(
        Object.assign(new Error('private COS error'), { statusCode: 503 }),
      );
      await rejected({ assetId: original.assetId }, 503, 'VIDEO_UNAVAILABLE');
      await f.closeAssets();
      await rejected({ assetId: original.assetId }, 503, 'VIDEO_UNAVAILABLE');
      expect((await f.pool.query('SELECT count(*) FROM mio_video_jobs')).rows[0].count).toBe('0');
      expect(f.wake).not.toHaveBeenCalled();
      expect(f.objects.materialUrl).not.toHaveBeenCalled();
      expect(f.upstream).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('checks raw identity again and keeps ordered references, privacy and idempotency', async () => {
    const f = await assetHttpFixture();
    try {
      const first = await f.addAsset();
      const second = await f.addAsset(actor.userId, 'ready', 'video/mp4', true);
      const references: VideoAssetReference[] = [
        { assetId: second.assetId, mediaType: 'video' },
        { assetId: first.assetId },
        { assetId: first.assetId },
      ];
      const id = randomUUID();
      const accepted = await f.post(references, id);
      expect(accepted.status).toBe(202);
      const job = await accepted.json();
      expect(job.inputSnapshot).toEqual(references);
      expect(JSON.stringify(job)).not.toMatch(/mio\/raw|raw-etag|signature=/);
      expect(f.objects.head.mock.calls).toEqual([
        [second.key, expect.any(AbortSignal)],
        [first.key, expect.any(AbortSignal)],
      ]);
      expect(f.objects.materialUrl).not.toHaveBeenCalled();
      f.heads.set(first.key, { ...first.head, etag: 'replaced-etag' });
      const row = await f.runNext();
      expect(row.command.inputObjects?.[first.assetId]).toEqual({
        key: first.key,
        etag: first.head.etag,
      });
      const read = await f.get(job.id);
      expect(await read.json()).toMatchObject({
        state: 'rejected',
        error: { code: 'VIDEO_INPUT_OR_CREDENTIAL_UNAVAILABLE' },
      });
      expect(f.upstream).not.toHaveBeenCalled();
      expect(f.objects.materialUrl).not.toHaveBeenCalled();
      const replay = await f.post(references, id);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ id: job.id, state: 'rejected' });

      f.heads.set(first.key, first.head);
      const legacy = await f.post(references);
      expect(legacy.status).toBe(202);
      const legacyJob = await legacy.json();
      await f.pool.query("UPDATE mio_video_jobs SET command=command-'inputObjects' WHERE id=$1", [
        legacyJob.id,
      ]);
      await f.runNext();
      expect(f.upstream).toHaveBeenCalledTimes(1);
      const outbound = f.upstream.mock.calls[0]![1];
      expect(outbound?.method).toBe('POST');
      expect(JSON.parse(String(outbound?.body)).content).toMatchObject([
        { type: 'text' },
        { video_url: { url: `https://cos.fixture/${second.key}?signature=fixture` } },
        { image_url: { url: `https://cos.fixture/${first.key}?signature=fixture` } },
        { image_url: { url: `https://cos.fixture/${first.key}?signature=fixture` } },
      ]);
      expect(f.objects.materialUrl.mock.calls).toEqual([[second.key], [first.key]]);
    } finally {
      await f.close();
    }
  });

  it('replays a persisted pre-Foundation input hash and rejects changed new inputs', async () => {
    const f = await assetHttpFixture();
    try {
      const first = await f.addAsset();
      const last = await f.addAsset();
      const references = [{ assetId: first.assetId }, { assetId: last.assetId }];
      const id = randomUUID();
      const created = await f.post(references, id);
      expect(created.status).toBe(202);
      const job = await created.json();
      const original: VideoCreateRequest = {
        requestId: id,
        modelRef: job.modelRef,
        expectedCapabilitiesVersion: 'asset-http-capabilities',
        parameters: { mode: 'full', prompt: 'ordered references', references },
      };
      const legacy = createHash('sha256').update(JSON.stringify(original), 'utf8').digest('hex');
      const current = await f.pool.query('SELECT input_hash FROM mio_video_jobs WHERE id=$1', [
        job.id,
      ]);
      expect(current.rows[0]?.input_hash).toBe(legacy);
      await f.pool.query(
        "UPDATE mio_video_jobs SET input_hash=$2,command=command-'inputObjects' WHERE id=$1",
        [job.id, legacy],
      );
      f.objects.head.mockClear();
      const replay = await f.post(references, id);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ id: job.id });
      expect(f.objects.head).not.toHaveBeenCalled();

      const freshId = randomUUID();
      expect((await f.post(references, freshId)).status).toBe(202);
      const conflicting = await f.post(references.toReversed(), freshId);
      expect(conflicting.status).toBe(409);
      expect(await conflicting.json()).toMatchObject({ error: { code: 'REQUEST_CONFLICT' } });
      expect(f.wake).toHaveBeenCalledTimes(2);
      expect(f.upstream).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it.each(['admission', 'submission', 'legacy-admission'] as const)(
    'halts a hung HEAD during video %s without signing or submitting',
    async (stage) => {
      const f = await assetHttpFixture();
      const reply = Promise.withResolvers<COS.HeadObjectResult>();
      const started = Promise.withResolvers<void>();
      const head = vi.spyOn(COS.prototype, 'headObject').mockImplementation(() => {
        started.resolve();
        return reply.promise;
      });
      const storage = createCosStorage({
        databaseURL: 'postgresql://example.invalid/media',
        bucket: 'mio-test-1234567890',
        region: 'ap-shanghai',
        secretId: 'fixture',
        secretKey: 'fixture',
      });
      try {
        const asset = await f.addAsset();
        const references = [{ assetId: asset.assetId }];
        const legacyHead = async (key: string) => {
          expect(key).toBe(asset.key);
          started.resolve();
          const actual = await reply.promise;
          return { size: Number(actual.headers?.['content-length']), etag: actual.ETag };
        };
        if (stage !== 'submission') {
          f.objects.head.mockImplementationOnce(
            stage === 'legacy-admission' ? legacyHead : storage.head,
          );
          const pending = f.post(references);
          await started.promise;
          await f.closeAdmissions();
          const response = await pending;
          expect(response.status).toBe(503);
          expect(await response.json()).toMatchObject({ error: { code: 'VIDEO_UNAVAILABLE' } });
          expect((await f.pool.query('SELECT count(*) FROM mio_video_jobs')).rows[0].count).toBe(
            '0',
          );
          expect(f.wake).not.toHaveBeenCalled();
        } else {
          const accepted = await f.post(references);
          expect(accepted.status).toBe(202);
          const job = await accepted.json();
          f.objects.head.mockImplementationOnce(storage.head);
          const pending = f.runNext();
          await started.promise;
          f.stopRunner();
          await pending;
          expect(await (await f.get(job.id)).json()).toMatchObject({
            state: 'accepted',
            stage: 'ready',
          });
        }
        reply.resolve({ ETag: asset.head.etag, headers: { 'content-length': '100' } });
        await reply.promise;
        expect(f.objects.materialUrl).not.toHaveBeenCalled();
        expect(f.upstream).not.toHaveBeenCalled();
      } finally {
        f.stopRunner();
        reply.resolve({ ETag: '', headers: {} });
        head.mockRestore();
        await f.close();
      }
    },
  );
});
