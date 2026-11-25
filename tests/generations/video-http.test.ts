import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Pool } from 'pg';
import COS from 'cos-nodejs-sdk-v5';
import { describe, expect, it, vi } from 'vitest';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { createAssetStore } from '../../src/assets/store.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { createVideoGenerationHandler } from '../../src/generations/video-http.ts';
import { createVideoInputResolver } from '../../src/generations/video-inputs.ts';
import { createVideoRunner } from '../../src/generations/video-runner.ts';
import { createVideoGenerationService } from '../../src/generations/video-service.ts';
import { VideoGenerationStore } from '../../src/generations/video-store.ts';
import type {
  VideoAssetReference,
  VideoCreateRequest,
} from '../../src/generations/video-contracts.ts';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { createVideoProtocol } from '../../src/integrations/onelink/video/index.ts';
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
  const heads = new Map<string, { size: number; etag: string }>();
  const objects = {
    uploadUrl: vi.fn(),
    downloadUrl: vi.fn(),
    copy: vi.fn(),
    delete: vi.fn(),
    materialUrl: vi.fn((key) => `https://cos.fixture/${key}?signature=fixture`),
    head: vi.fn<AssetObjectStore['head']>(async (key) => {
      const head = heads.get(key);
      if (!head) throw Object.assign(new Error('private COS error'), { statusCode: 404 });
      return head;
    }),
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
  const provider = {
    videoCapabilities: vi.fn(async () => ({
      capabilitiesVersion,
      available: true,
      modes: [{ mode: 'full', supported: true }],
    })),
    snapshotVideo: vi.fn(async () => ({
      capabilitiesVersion,
      route,
      modelId: 'doubao-seedance-2-0-fast',
      providerConfigId: randomUUID(),
      credentialVersion: 1,
      credential: {},
    })),
    openImageSnapshot: vi.fn(() => 'fixture-key'),
  } as unknown as ProviderService;
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'fixture-task' }));
  const wake = vi.fn();
  const stop = new AbortController();
  const run = createVideoRunner(execution, () => provider, vi.fn(), stop.signal, {
    protocol: createVideoProtocol,
    transport: upstream,
    references: (row, activeSignal) =>
      inputs.resolve(
        row.owner_id,
        row.command.inputSnapshot,
        activeSignal,
        row.command.inputObjects,
      ),
  });
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
  return {
    pool,
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
    post(references: VideoAssetReference[], id: string = randomUUID()) {
      return fetch(endpoint, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', cookie: 'session=fixture' },
        body: JSON.stringify({
          requestId: id,
          modelRef,
          expectedCapabilitiesVersion: capabilitiesVersion,
          parameters: { mode: 'full', prompt: 'ordered references', references },
        }),
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
      await execution.close();
      await pool.end();
      await database.close();
    },
  };
}

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
