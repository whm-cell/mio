import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Pool } from 'pg';
import COS from 'cos-nodejs-sdk-v5';
import { describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { probeVideoFile } from '../../compute/src/adapters/media.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { createAssetStore } from '../../src/assets/store.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { createVideoExecutor } from '../../src/generations/video/executor.ts';
import { VIDEO_QUOTA_LOCK } from '../../src/generations/video/execution.ts';
import { createVideoGenerationHandler } from '../../src/generations/video/http.ts';
import { createVideoInputResolver } from '../../src/generations/video/inputs.ts';
import { createVideoMaterializer } from '../../src/generations/video/media.ts';
import type { VideoProbe } from '../../src/generations/video/media.ts';
import { createVideoRunner } from '../../src/generations/video/runner.ts';
import type { VideoTransports } from '../../src/generations/video/runner.ts';
import { createVideoGenerationService } from '../../src/generations/video/service.ts';
import { VideoGenerationStore } from '../../src/generations/video/store.ts';
import { VideoSubmissionReceipts } from '../../src/generations/video/submission-receipts.ts';
import type {
  VideoAssetReference,
  VideoCapabilitiesView,
  VideoCreateRequest,
  VideoJobView,
} from '../../src/generations/video/contracts.ts';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { createVideoProtocol } from '../../src/integrations/onelink/video/index.ts';
import type { withPublicHttps } from '../../src/integrations/onelink/public-https.ts';
import { ProviderError } from '../../src/providers/contracts.ts';
import type { VideoRouteConfig } from '../../src/providers/contracts.ts';
import { validateVideoRouteConfig } from '../../src/providers/onelink/video-route.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { createProviderService } from '../../src/providers/service.ts';
import type { ProviderService } from '../../src/providers/service.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { legacyVideoRouteEntries } from '../../scripts/service/legacy-video-routes.ts';
import { authDatabase } from '../support/auth-database.ts';
import { observeOwnerStateReads } from '../support/provider-state-queries.ts';
import { writeVideoProbeFixture } from '../support/video-probe-fixtures.ts';

const actor = { userId: randomUUID(), sessionId: 'video-http-test' };
const origin = 'https://demo.fixture';
const jobId = randomUUID();
const requestId = randomUUID();
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
  'base64',
);
const wave = Buffer.from(
  '524946462800000057415645666d74201000000001000100401f0000803e000002001000646174610400000000000000',
  'hex',
);

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

type VideoHttpDatabase = Awaited<ReturnType<typeof authDatabase>>;

interface AssetHttpFixtureOptions {
  withExecutor?: boolean;
  providerModelIds?: readonly string[];
  realOutput?: Buffer<ArrayBuffer>;
  alternate?: { route: VideoRouteConfig; modelId: string };
  migrateGenerations?: (pool: Pool, database: VideoHttpDatabase) => Promise<unknown>;
}

async function assetHttpFixture(options: AssetHttpFixtureOptions = {}) {
  const cleanups: (() => Promise<void>)[] = [];
  const close = async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'video HTTP fixture cleanup failed');
  };
  try {
    return { ...(await startAssetHttpFixture(options, cleanups)), close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'video HTTP fixture setup and cleanup failed',
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

async function startAssetHttpFixture(
  {
    withExecutor = false,
    providerModelIds,
    realOutput,
    alternate,
    migrateGenerations = (pool) => pool.query(generationSchemaSQL),
  }: AssetHttpFixtureOptions,
  cleanups: (() => Promise<void>)[],
) {
  const database = await authDatabase();
  cleanups.push(() => database.close());
  const pool = new Pool({ connectionString: database.url });
  cleanups.push(() => pool.end());
  await pool.query(assetSchemaSQL);
  await migrateGenerations(pool, database);
  const assets = await createAssetStore(database.url);
  let assetsClosed = false;
  const closeAssets = async () => {
    if (assetsClosed) return;
    await assets.close();
    assetsClosed = true;
  };
  cleanups.push(closeAssets);
  const store = new VideoGenerationStore(pool);
  const execution = store.executorStore();
  cleanups.push(() => execution.close());
  const resumeClaim = Promise.withResolvers<void>();
  if (withExecutor) {
    const claim = execution.claim.bind(execution);
    vi.spyOn(execution, 'claim').mockImplementation(async (...args) => {
      // Keep the real executor from picking up the jobs used to exercise HTTP admission.
      await resumeClaim.promise;
      return claim(...args);
    });
  } else await execution.startExecutor(() => {});
  const directory = await mkdtemp(join(tmpdir(), 'mio-video-http-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const heads = new Map<string, Awaited<ReturnType<AssetObjectStore['head']>>>();
  const inputBytes = new Map<string, Uint8Array>();
  const generatedVideo = 'https://video.fixture/render.mp4';
  const outputBytes = realOutput ?? Buffer.from('video for a fixture Worker');
  const probePath = realOutput && join(directory, 'worker-input.media');
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
    readPrefix: vi.fn<NonNullable<AssetObjectStore['readPrefix']>>(
      async (key, etag, size, limit, signal) => {
        signal.throwIfAborted();
        const object = heads.get(key);
        const bytes = inputBytes.get(key);
        if (!object || !bytes)
          throw Object.assign(new Error('missing COS object'), { statusCode: 404 });
        if (etag !== object.etag || object.size !== size || bytes.byteLength !== size)
          throw Object.assign(new Error('changed COS object'), { statusCode: 412 });
        return bytes.subarray(0, Math.min(size - 1, limit));
      },
    ),
    putVideo: vi.fn<NonNullable<AssetObjectStore['putVideo']>>(
      async (key, stream, sizeBytes, sha256) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        if (!bytes.equals(outputBytes)) throw new Error('unexpected video bytes');
        if (probePath) await writeFile(probePath, bytes, { mode: 0o600 });
        const etag = 'fixture-staging-etag';
        const contentType = 'video/mp4';
        heads.set(key, { size: sizeBytes, etag, sha256, contentType });
        return { key, etag, sha256, sizeBytes, contentType };
      },
    ),
  } satisfies AssetObjectStore;
  const inputs = createVideoInputResolver(assets, objects);
  const capabilitiesVersion = 'asset-http-capabilities';
  const route: VideoRouteConfig = alternate?.route ?? {
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
    modes: route.paramSpec.supportedModes.map((mode) => ({ mode, supported: true })),
  }));
  const makeSnapshot = () => ({
    capabilitiesVersion,
    route,
    modelId: alternate?.modelId ?? 'doubao-seedance-2-0-fast',
    providerConfigId: randomUUID(),
    credentialVersion: 1,
    credential: {},
  });
  const admissionSnapshot = vi.fn(makeSnapshot);
  const videoAdmission = vi.fn(async () => ({
    capabilitiesVersion,
    available: true,
    supportedModes: route.paramSpec.supportedModes,
    snapshot: admissionSnapshot,
  }));
  const snapshotVideo = vi.fn(async () => makeSnapshot());
  let provider = {
    videoCapabilities,
    videoAdmission,
    snapshotVideo,
    openImageSnapshot: vi.fn(() => 'fixture-key'),
    resolveImageTaskCredential: vi.fn(async () => 'fixture-key'),
  } as unknown as ProviderService;
  let modelRef = 'onelink:model:' + randomUUID();
  if (providerModelIds) {
    const config = {
      databaseURL: database.url,
      masterKey: randomBytes(32),
      masterKeyId: 'video-http-fixture',
    };
    await pool.query(providerSchemaSQL);
    const providerStore = await createProviderStore(config);
    provider = createProviderService(
      providerStore,
      config,
      async () => Response.json({ data: providerModelIds.map((id) => ({ id })) }),
      true,
    );
    cleanups.push(provider.close);
    await provider.save(actor, 0, 'synthetic-video-http-key');
    await provider.discover(actor);
    await providerStore.importRoutes(legacyVideoRouteEntries(providerModelIds));
    modelRef = (await provider.catalog(actor, 'video')).items[0]!.modelRef;
  }
  const upstream = vi.fn<typeof fetch>(async (_url, options) => {
    if (options?.method === 'POST') {
      if (route.driver === 'kling-videos')
        return Response.json({ code: 0, data: { task_id: 'fixture-task' } });
      if (route.driver === 'happyhorse-videos')
        return Response.json({ output: { task_id: 'fixture-task' } });
      return Response.json({ id: 'fixture-task' });
    }
    return Response.json({
      id: 'fixture-task',
      status: 'succeeded',
      content: { video_url: generatedVideo },
    });
  });
  const stop = new AbortController();
  const receipts = new VideoSubmissionReceipts(directory);
  cleanups.push(() => receipts.close());
  let expiredResult = false;
  let downloads = 0;
  const download: typeof withPublicHttps = async (url, signal, consume) => {
    expect(url.href).toBe(generatedVideo);
    signal.throwIfAborted();
    downloads++;
    return consume(expiredResult ? new Response(null, { status: 410 }) : new Response(outputBytes));
  };
  const probe = vi.fn<VideoProbe>(async ({ source }, signal) => {
    if (probePath) {
      expect(heads.get(source.stagingKey)).toMatchObject({
        size: source.sizeBytes,
        sha256: source.sha256,
        etag: source.etag,
      });
      try {
        return await probeVideoFile(probePath, signal);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'SOURCE_INVALID') throw error;
        throw new Error('VIDEO_SOURCE_INVALID', { cause: error });
      }
    }
    return {
      container: 'mp4',
      videoCodec: 'h264',
      width: 640,
      height: 360,
      durationSeconds: 4,
      hasAudio: false,
      audioCodec: null,
    };
  });
  const materialize = createVideoMaterializer(objects, directory, probe, download);
  const transports: VideoTransports = {
    protocol: createVideoProtocol,
    transport: upstream,
    references: (row, signal) =>
      inputs.resolve(row.owner_id, row.command.inputSnapshot, signal, row.command.inputObjects),
  };
  const run = createVideoRunner(
    execution,
    () => provider,
    materialize,
    stop.signal,
    transports,
    receipts,
  );
  const worker = withExecutor
    ? await createVideoExecutor(store, () => provider, materialize, transports, directory)
    : undefined;
  if (worker)
    cleanups.push(async () => {
      const workerClose = worker.close();
      resumeClaim.resolve();
      await workerClose;
    });
  const wake = vi.fn(() => worker?.wake());
  const service = createVideoGenerationService(
    store,
    () => provider,
    { wake, signal: worker?.signal ?? stop.signal },
    inputs.inspect,
  );
  cleanups.push(service.close);
  const otherActor = { userId: randomUUID(), sessionId: 'video-http-other' };
  const handler = createVideoGenerationHandler(
    service,
    async (headers) => {
      const session = headers.get('cookie');
      if (session === 'session=fixture') return actor;
      if (session === 'session=other') return otherActor;
      return null;
    },
    [origin],
  );
  const server = createServer(handler);
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('video test server address missing');
  const endpoint = `http://127.0.0.1:${address.port}/api/v1/compute/videos`;
  const request = (
    references: VideoAssetReference[],
    id: string = randomUUID(),
  ): VideoCreateRequest => ({
    requestId: id,
    modelRef,
    expectedCapabilitiesVersion: capabilitiesVersion,
    parameters: { mode: 'full', prompt: 'ordered references', references },
  });
  const postRequest = (body: VideoCreateRequest, session = 'fixture', signal?: AbortSignal) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', cookie: `session=${session}` },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });
  return {
    pool,
    store,
    service,
    provider,
    modelRef,
    execution,
    server,
    directory,
    applicationName: database.applicationName,
    request,
    postRequest,
    videoAdmission,
    admissionSnapshot,
    snapshotVideo,
    heads,
    inputBytes,
    objects,
    probe,
    upstream,
    expireResult: () => {
      expiredResult = true;
    },
    downloadCount: () => downloads,
    wake,
    closeAdmissions: service.close,
    stopRunner: (reason?: unknown) => stop.abort(reason),
    async loseExecutorLease() {
      if (!worker) throw new Error('real video executor required');
      const { rows } = await pool.query(
        `SELECT pg_terminate_backend(a.pid) AS terminated
         FROM pg_locks l JOIN pg_stat_activity a USING(pid)
         WHERE a.application_name=$1 AND l.locktype='advisory' AND l.objsubid=2 AND l.granted`,
        [database.applicationName],
      );
      expect(rows).toEqual([{ terminated: true }]);
      await vi.waitFor(() => expect(worker.signal.aborted).toBe(true));
    },
    async addAsset(
      assetOwner = actor.userId,
      state = 'ready',
      contentType = 'image/png',
      derived = false,
      bytes: Uint8Array = png,
    ) {
      const assetId = randomUUID();
      const key = `mio/raw/${assetId}/${randomUUID()}`;
      const head = { size: bytes.byteLength, etag: '"raw-etag"' };
      heads.set(key, head);
      inputBytes.set(key, bytes);
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
      return postRequest(request(references, id), 'fixture', signal);
    },
    capabilities(ref = modelRef) {
      const url = new URL(
        `/api/v1/compute/video-capabilities/${encodeURIComponent(ref)}`,
        endpoint,
      );
      return fetch(url, { headers: { cookie: 'session=fixture' } });
    },
    get(id: string) {
      return fetch(`${endpoint}/${id}`, { headers: { cookie: 'session=fixture' } });
    },
    list(session = 'fixture') {
      return fetch(endpoint, { headers: { cookie: `session=${session}` } });
    },
    async runNext() {
      const row = await execution.claim();
      if (!row) throw new Error('video fixture has no ready execution');
      await run(row);
      return row;
    },
    closeAssets,
  };
}

it.each(['mp4', 'attached-cover', 'truncated-mp4', 'corrupt-mp4', 'mov', '3gp'] as const)(
  'publishes only verified MP4 from actual staged %s bytes',
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'mio-video-http-fixture-'));
    let bytes: Buffer<ArrayBuffer>;
    try {
      bytes = await readFile(writeVideoProbeFixture(directory, kind));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const f = await assetHttpFixture({ realOutput: bytes });
    try {
      const reference = await f.addAsset();
      const accepted = await f.post([{ assetId: reference.assetId }]);
      expect(accepted.status).toBe(202);
      const { id } = await accepted.json();
      await f.runNext();

      await f.pool.query('UPDATE mio_video_executions SET next_query_at=now() WHERE job_id=$1', [
        id,
      ]);
      await f.runNext();
      expect(f.downloadCount()).toBe(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
      expect(f.probe).toHaveBeenCalledOnce();
      expect(f.upstream.mock.calls.map(([, options]) => options?.method)).toEqual(['POST', 'GET']);

      const response = await f.get(id);
      expect(response.status).toBe(200);
      const view: VideoJobView = await response.json();
      const { rows } = await f.pool.query(
        `SELECT id,owner_id,filename,content_type,raw_key,source_etag,state
         FROM mio_assets WHERE asset_kind='derived'`,
      );
      const raw = [...f.heads.keys()].filter(
        (key) => key !== reference.key && key.startsWith('mio/raw/'),
      );
      if (kind === 'mp4') {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        expect(view).toMatchObject({
          state: 'completed',
          outputs: [
            {
              index: 0,
              status: 'registered',
              width: 320,
              height: 240,
              assetId: expect.any(String),
              sizeBytes: bytes.length,
              sha256,
            },
          ],
        });
        const assetId = view.outputs[0]!.assetId;
        const command = f.probe.mock.calls[0]![0];
        const rawKey = `mio/raw/${assetId}/${command.attemptId}`;
        expect(raw).toEqual([rawKey]);
        expect(f.heads.get(rawKey)).toMatchObject({ contentType: 'video/mp4', sha256 });
        expect(rows).toEqual([
          {
            id: assetId,
            owner_id: actor.userId,
            filename: 'video-0.mp4',
            content_type: 'video/mp4',
            raw_key: rawKey,
            source_etag: 'fixture-raw-etag',
            state: 'ready',
          },
        ]);
        expect(f.objects.copy).toHaveBeenCalledExactlyOnceWith(
          command.source.stagingKey,
          rawKey,
          command.source.etag,
          'private',
          { contentType: 'video/mp4', sha256, signal: expect.any(AbortSignal) },
        );
      } else {
        expect(view).toMatchObject({
          state: 'materialization_failed',
          outputs: [
            { index: 0, status: 'failed', assetId: null, errorCode: 'VIDEO_SOURCE_INVALID' },
          ],
        });
        expect(rows).toEqual([]);
        expect(raw).toEqual([]);
        expect(f.objects.copy).not.toHaveBeenCalled();
        await f.pool.query('UPDATE mio_video_executions SET next_query_at=now() WHERE job_id=$1', [
          id,
        ]);
        expect(await f.execution.claim()).toBeUndefined();
      }
    } finally {
      await f.close();
    }
  },
);

it('recovers the private video from its downloaded checkpoint after the supplier URL expires', async () => {
  const f = await assetHttpFixture();
  try {
    const asset = await f.addAsset();
    const accepted = await f.post([{ assetId: asset.assetId }]);
    expect(accepted.status).toBe(202);
    const { id } = await accepted.json();
    await f.runNext();
    const due = () =>
      f.pool.query('UPDATE mio_video_executions SET next_query_at=now() WHERE job_id=$1', [id]);
    await due();
    f.objects.putVideo.mockRejectedValueOnce(new Error('fixture upload outage'));
    await f.runNext();
    expect(f.downloadCount()).toBe(1);
    await f.pool.query(
      `UPDATE mio_video_executions SET checkpoint=checkpoint||'{"materializationAttempts":3}'::jsonb
      WHERE job_id=$1`,
      [id],
    );
    await due();
    await f.runNext();
    const failed = await f.get(id);
    expect(await failed.json()).toMatchObject({
      state: 'materialization_failed',
      recovery: { available: true },
      outputs: [{ index: 0, status: 'failed', assetId: null }],
    });
    f.expireResult();
    await f.service.recover(actor, id);
    await f.runNext();
    const detail = await f.get(id);
    expect(detail.status).toBe(200);
    const completed = await detail.json();
    expect(completed).toMatchObject({
      state: 'completed',
      recovery: { available: false },
      outputs: [{ index: 0, status: 'registered', width: 640, height: 360 }],
    });
    expect(JSON.stringify(completed)).not.toContain('https://video.fixture/');
    expect(f.downloadCount()).toBe(1);
    expect(f.upstream.mock.calls.map(([, options]) => options?.method)).toEqual(['POST', 'GET']);
  } finally {
    await f.close();
  }
});

function waitForLock(
  f: Awaited<ReturnType<typeof assetHttpFixture>>,
  key: number,
  query: string,
  count: number,
) {
  return vi.waitFor(
    async () => {
      const { rows } = await f.pool.query<{ pid: number; query: string }>(
        `SELECT a.pid,a.query FROM pg_locks l JOIN pg_stat_activity a USING(pid)
         WHERE a.application_name=$1 AND l.locktype='advisory'
           AND l.classid=0 AND l.objid=$2::oid AND NOT l.granted`,
        [f.applicationName, key],
      );
      expect(rows).toHaveLength(count);
      for (const row of rows) expect(row.query).toContain(query);
      return rows.map((row) => row.pid);
    },
    { timeout: 4000 },
  );
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

  it.each(['provider state', 'material inspection'] as const)(
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
        if (stage === 'provider state') {
          const query = f.videoAdmission.getMockImplementation()!;
          f.videoAdmission.mockImplementationOnce(async () => {
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
        if (stage === 'provider state') expect(f.admissionSnapshot).not.toHaveBeenCalled();
        expect(f.snapshotVideo).not.toHaveBeenCalled();
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
        await waitForLock(
          f,
          lock,
          stage === 'quota lock' ? 'pg_advisory_xact_lock' : 'INSERT INTO mio_video_executions',
          1,
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
      const readAdmission = f.videoAdmission.getMockImplementation()!;
      f.videoAdmission.mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
        return readAdmission();
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

describe('video admission replay', () => {
  it('reads current owner state once at HTTP admission and refreshes it after dispatch reference checks', async () => {
    const f = await assetHttpFixture({ providerModelIds: ['vega-1.5-pro'] });
    const { expectReads: expectStateReads, restore } = observeOwnerStateReads(actor.userId);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let dispatch: ReturnType<typeof f.runNext> | undefined;
    try {
      const capabilityResponse = await f.capabilities();
      expect(capabilityResponse.status).toBe(200);
      const current: VideoCapabilitiesView = await capabilityResponse.json();
      expect(current).toMatchObject({ modelRef: f.modelRef, available: true });
      expectStateReads(1);

      const asset = await f.addAsset();
      const unsupported: VideoCreateRequest = {
        requestId: randomUUID(),
        modelRef: f.modelRef,
        expectedCapabilitiesVersion: current.capabilitiesVersion,
        parameters: {
          mode: 'full',
          prompt: 'A lake at dawn',
          references: [{ assetId: asset.assetId }],
        },
      };
      const modeRejected = await f.postRequest(unsupported);
      expect(modeRejected.status).toBe(400);
      expect(await modeRejected.json()).toMatchObject({
        error: { code: 'VIDEO_MODE_UNSUPPORTED' },
      });
      expectStateReads(1);

      const request: VideoCreateRequest = {
        ...unsupported,
        requestId: randomUUID(),
        parameters: {
          mode: 'first_frame',
          prompt: 'A lake at dawn',
          resolution: '480p',
          durationSeconds: 4,
          firstFrame: { assetId: asset.assetId },
        },
      };
      const accepted = await f.postRequest(request);
      expect(accepted.status).toBe(202);
      const { id } = await accepted.json();
      expectStateReads(1);
      expect(
        (
          await f.pool.query(
            `SELECT j.route_snapshot, e.snapshot FROM mio_video_jobs j
         JOIN mio_video_executions e ON e.job_id = j.id WHERE j.id=$1`,
            [id],
          )
        ).rows,
      ).toMatchObject([
        {
          route_snapshot: {
            capabilitiesVersion: current.capabilitiesVersion,
            modelId: 'vega-1.5-pro',
          },
          snapshot: { credentialVersion: 1, credential: { ciphertext: expect.any(String) } },
        },
      ]);

      f.objects.head.mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
        return asset.head;
      });
      dispatch = f.runNext();
      await Promise.race([
        entered.promise,
        dispatch.then(() => {
          throw new Error('dispatch settled before reference inspection');
        }),
      ]);
      expectStateReads(0);
      await f.provider.settings(actor, (await f.provider.get(actor))!.revision, { enabled: false });
      resume.resolve();
      await dispatch;
      expect(f.objects.materialUrl).toHaveBeenCalledExactlyOnceWith(asset.key);
      expectStateReads(1);
      expect(f.upstream).not.toHaveBeenCalled();
      expect(await f.store.get(actor.userId, id)).toMatchObject({
        state: 'rejected',
        error: { code: 'VIDEO_INPUT_OR_CREDENTIAL_UNAVAILABLE' },
      });

      const replay = await f.postRequest(request);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ id, state: 'rejected' });
      expectStateReads(0);
      const stale = await f.postRequest(unsupported);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { code: 'VIDEO_CAPABILITIES_STALE' } });
      expectStateReads(1);

      const disabled: VideoCapabilitiesView = await (await f.capabilities()).json();
      expect(disabled).toMatchObject({ available: false, unavailableReason: 'PROVIDER_DISABLED' });
      expectStateReads(1);
      const matching = await f.postRequest({
        ...unsupported,
        expectedCapabilitiesVersion: disabled.capabilitiesVersion,
      });
      expect(matching.status).toBe(503);
      expect(await matching.json()).toMatchObject({ error: { code: 'VIDEO_UNAVAILABLE' } });
      expectStateReads(1);
      expect(f.wake).toHaveBeenCalledOnce();
    } finally {
      restore();
      resume.resolve();
      await Promise.allSettled([dispatch]);
      await f.close();
    }
  });

  it.each([
    ['changed capabilities version', 409, 'VIDEO_CAPABILITIES_STALE'],
    ['unavailable matching version', 503, 'VIDEO_UNAVAILABLE'],
    ['provider read error', 503, 'PROVIDER_UNAVAILABLE'],
  ] as const)(
    'compares concurrent submissions to the committed winner after a %s',
    async (stage, status, code) => {
      const f = await assetHttpFixture();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const pending: Promise<Response>[] = [];
      let waiting = 0;
      const pause = async () => {
        if (++waiting === 3) entered.resolve();
        await resume.promise;
      };
      const readAdmission = f.videoAdmission.getMockImplementation()!;
      try {
        f.videoAdmission.mockImplementation(async () => {
          await pause();
          if (stage === 'provider read error') throw new ProviderError(status, code);
          const admission = await readAdmission();
          if (stage === 'unavailable matching version') return { ...admission, available: false };
          return { ...admission, capabilitiesVersion: 'changed-capabilities' };
        });
        const asset = await f.addAsset();
        const request = f.request([{ assetId: asset.assetId }]);
        const changed = {
          ...request,
          parameters: { ...request.parameters, prompt: 'different input' },
        };
        const replay = f.postRequest(request);
        const conflict = f.postRequest(changed);
        const otherOwner = f.postRequest(request, 'other');
        pending.push(replay, conflict, otherOwner);
        await Promise.race([
          entered.promise,
          ...pending.map((post) =>
            post.then(() => {
              throw new Error('video replied before reaching the provider barrier');
            }),
          ),
        ]);
        f.videoAdmission.mockImplementationOnce(readAdmission);

        const accepted = await f.postRequest(request);
        expect(accepted.status).toBe(202);
        const job = await accepted.json();
        expect(f.upstream).not.toHaveBeenCalled();
        await f.runNext();
        resume.resolve();
        const repeated = await replay;
        expect(repeated.status).toBe(200);
        expect(await repeated.json()).toMatchObject({ id: job.id });
        const rejected = await conflict;
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toMatchObject({ error: { code: 'REQUEST_CONFLICT' } });
        const fresh = f.postRequest({ ...request, requestId: randomUUID() });
        pending.push(fresh);
        for (const response of await Promise.all([otherOwner, fresh])) {
          expect(response.status).toBe(status);
          expect(await response.json()).toMatchObject({ error: { code } });
        }
        const hash = createHash('sha256').update(JSON.stringify(request), 'utf8').digest('hex');
        expect(
          (await f.pool.query('SELECT id,owner_id,request_id,input_hash FROM mio_video_jobs')).rows,
        ).toEqual([
          { id: job.id, owner_id: actor.userId, request_id: request.requestId, input_hash: hash },
        ]);
        expect((await f.pool.query('SELECT job_id FROM mio_video_executions')).rows).toEqual([
          { job_id: job.id },
        ]);
        expect(f.wake).toHaveBeenCalledTimes(1);
        expect(f.videoAdmission).toHaveBeenCalledTimes(5);
        expect(f.admissionSnapshot).toHaveBeenCalledOnce();
        expect(f.snapshotVideo).toHaveBeenCalledOnce();
        expect(f.upstream.mock.calls.map(([, options]) => options?.method)).toEqual(['POST']);
        expect(await (await f.get(job.id)).json()).toMatchObject({ state: 'submitted' });
      } finally {
        resume.resolve();
        await Promise.allSettled(pending);
        await f.close();
      }
    },
  );

  it.each(['tool cancellation', 'PostgreSQL failure'] as const)(
    'preserves %s even if a concurrent request commits',
    async (failure) => {
      const f = await assetHttpFixture();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const controller = new AbortController();
      let pending: ReturnType<typeof f.service.create> | undefined;
      try {
        f.videoAdmission.mockImplementationOnce(async () => {
          entered.resolve();
          await resume.promise;
          if (failure === 'PostgreSQL failure') await f.pool.query('SELECT 1 / 0');
          throw new ProviderError(503, 'PROVIDER_UNAVAILABLE');
        });
        const asset = await f.addAsset();
        const request = f.request([{ assetId: asset.assetId }]);
        pending = f.service.create(actor, request, controller.signal);
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('video admitted before reaching the provider barrier');
          }),
        ]);
        const accepted = await f.postRequest(request);
        expect(accepted.status).toBe(202);
        await accepted.json();
        if (failure === 'tool cancellation') controller.abort();
        resume.resolve();
        if (failure === 'tool cancellation')
          await expect(pending).rejects.toBe(controller.signal.reason);
        else await expect(pending).rejects.toMatchObject({ code: '22012' });
        expect(f.wake).toHaveBeenCalledTimes(1);
      } finally {
        resume.resolve();
        await Promise.allSettled([pending]);
        await f.close();
      }
    },
  );

  it('preserves tool cancellation during the detail read for a concurrent replay', async () => {
    const f = await assetHttpFixture();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const controller = new AbortController();
    let pending: ReturnType<typeof f.service.create> | undefined;
    try {
      f.videoAdmission.mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
        throw new ProviderError(503, 'PROVIDER_UNAVAILABLE');
      });
      const asset = await f.addAsset();
      const request = f.request([{ assetId: asset.assetId }]);
      pending = f.service.create(actor, request, controller.signal);
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('video admitted before reaching the provider barrier');
        }),
      ]);
      const accepted = await f.postRequest(request);
      expect(accepted.status).toBe(202);
      const { id } = await accepted.json();

      const gate = await f.pool.connect();
      try {
        await gate.query('BEGIN');
        // The request lookup can finish while the job detail SELECT waits for its outputs.
        await gate.query('LOCK TABLE mio_video_outputs IN ACCESS EXCLUSIVE MODE');
        resume.resolve();
        await vi.waitFor(
          async () => {
            const { rows } = await f.pool.query<{ query: string }>(
              `SELECT a.query FROM pg_locks l JOIN pg_stat_activity a USING(pid)
               WHERE a.application_name=$1 AND l.relation='mio_video_outputs'::regclass AND NOT l.granted`,
              [f.applicationName],
            );
            expect(rows).toHaveLength(1);
            expect(rows[0]?.query).toContain('WHERE j.owner_id=$1 AND j.id=$2');
          },
          { timeout: 4000 },
        );
        controller.abort();
      } finally {
        await gate.query('ROLLBACK');
        gate.release();
      }
      await expect(pending).rejects.toBe(controller.signal.reason);
      expect((await f.pool.query('SELECT id FROM mio_video_jobs')).rows).toEqual([{ id }]);
      expect((await f.pool.query('SELECT job_id FROM mio_video_executions')).rows).toEqual([
        { job_id: id },
      ]);
      expect(f.wake).toHaveBeenCalledTimes(1);
      expect(f.upstream).not.toHaveBeenCalled();
      await f.runNext();
      expect(f.upstream.mock.calls.map(([, options]) => options?.method)).toEqual(['POST']);
    } finally {
      resume.resolve();
      await Promise.allSettled([pending]);
      await f.close();
    }
  });
});

describe('video admission after executor lease loss', () => {
  async function expectUnavailable(response: Response) {
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'VIDEO_UNAVAILABLE' } });
  }

  it.each(['object inspection', 'quota lock', 'unrelated PostgreSQL error'] as const)(
    'preserves the request outcome after losing the lease during %s',
    async (stage) => {
      const f = await assetHttpFixture({ withExecutor: true });
      const gate = await f.pool.connect();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const pending: Promise<Response>[] = [];
      const lookup = vi.spyOn(f.store, 'byRequest');
      let locked = false;
      try {
        const asset = await f.addAsset();
        const request = f.request([{ assetId: asset.assetId }]);
        const changed = { ...request, parameters: { ...request.parameters, prompt: 'changed' } };
        const head = f.objects.head.getMockImplementation()!;
        let inspecting = 0;
        const pause: AssetObjectStore['head'] = async (...args) => {
          if (++inspecting === 2) entered.resolve();
          await resume.promise;
          return head(...args);
        };
        f.objects.head.mockImplementationOnce(pause).mockImplementationOnce(pause);
        const same = f.postRequest(request);
        const conflict = f.postRequest(changed);
        pending.push(same, conflict);
        await Promise.race([
          entered.promise,
          ...pending.map((reply) =>
            reply.then(() => {
              throw new Error('video POST replied before the object inspection barrier');
            }),
          ),
        ]);
        expect(lookup.mock.calls).toEqual([
          [actor.userId, request.requestId],
          [actor.userId, request.requestId],
        ]);

        const winner = await f.postRequest(request);
        expect(winner.status).toBe(202);
        const job = await winner.json();
        let waiters: number[] = [];
        if (stage !== 'object inspection') {
          await gate.query('SELECT pg_advisory_lock($1)', [VIDEO_QUOTA_LOCK]);
          locked = true;
          resume.resolve();
          waiters = await waitForLock(f, VIDEO_QUOTA_LOCK, 'pg_advisory_xact_lock', 2);
        }
        await f.loseExecutorLease();
        if (stage === 'unrelated PostgreSQL error') {
          // Fail the SQL statement itself while the executor signal is already aborted.
          const { rows } = await f.pool.query(
            'SELECT pg_cancel_backend(pid) AS canceled FROM unnest($1::int[]) AS waiters(pid)',
            [waiters],
          );
          expect(rows).toEqual([{ canceled: true }, { canceled: true }]);
        } else if (locked) {
          await gate.query('SELECT pg_advisory_unlock($1)', [VIDEO_QUOTA_LOCK]);
          locked = false;
        }

        const [repeated, rejected] = await Promise.all([same, conflict]);
        if (stage === 'unrelated PostgreSQL error') {
          await expectUnavailable(repeated);
          await expectUnavailable(rejected);
          expect(lookup).toHaveBeenCalledTimes(3);
        } else {
          expect(repeated.status).toBe(200);
          expect(await repeated.json()).toEqual(job);
          expect(rejected.status).toBe(409);
          expect(await rejected.json()).toMatchObject({ error: { code: 'REQUEST_CONFLICT' } });
          expect(lookup).toHaveBeenCalledTimes(5);
        }
        expect(f.videoAdmission).toHaveBeenCalledTimes(3);
        expect(f.admissionSnapshot).toHaveBeenCalledTimes(3);
        expect(f.snapshotVideo).not.toHaveBeenCalled();
        expect((await f.pool.query('SELECT id,state FROM mio_video_jobs')).rows).toEqual([
          { id: job.id, state: 'accepted' },
        ]);
        expect((await f.pool.query('SELECT job_id FROM mio_video_executions')).rows).toEqual([
          { job_id: job.id },
        ]);
        expect(f.wake).toHaveBeenCalledOnce();
        expect(f.upstream).not.toHaveBeenCalled();
      } finally {
        if (locked) await gate.query('SELECT pg_advisory_unlock($1)', [VIDEO_QUOTA_LOCK]);
        gate.release();
        resume.resolve();
        await Promise.allSettled(pending);
        await f.close();
      }
    },
  );

  it.each(['quota lock', 'both inserts'] as const)(
    'rolls back writes at the %s and keeps owner reads and old-hash replay available',
    async (stage) => {
      const f = await assetHttpFixture({ withExecutor: true });
      const gate = await f.pool.connect();
      const lock = stage === 'quota lock' ? VIDEO_QUOTA_LOCK : randomInt(1, 2147483647);
      let pending: Promise<Response> | undefined;
      let recovery: ReturnType<typeof f.service.recover> | undefined;
      try {
        const asset = await f.addAsset();
        const references = [{ assetId: asset.assetId }];
        const original = f.request(references);
        const accepted = await f.postRequest(original);
        expect(accepted.status).toBe(202);
        const { id } = await accepted.json();
        const hash = createHash('sha256').update(JSON.stringify(original), 'utf8').digest('hex');
        await f.pool.query(
          `UPDATE mio_video_jobs SET state='materialization_failed',error_code='VIDEO_MATERIALIZATION_FAILED',
           completed_at=now(),input_hash=$2,command=command-'inputObjects' WHERE id=$1`,
          [id, hash],
        );
        await f.pool.query(
          `UPDATE mio_video_executions SET phase='done',checkpoint=$2 WHERE job_id=$1`,
          [
            id,
            { videos: [{ url: 'https://fixture.invalid/output.mp4' }], materializationAttempts: 3 },
          ],
        );
        const before = await f.store.get(actor.userId, id);
        const executionState = 'SELECT job_id,phase,claim_id,checkpoint FROM mio_video_executions';
        const beforeExecution = (await f.pool.query(executionState)).rows;
        expect(before).toMatchObject({ recovery: { available: true } });

        await gate.query('SELECT pg_advisory_lock($1)', [lock]);
        if (stage === 'both inserts')
          await f.pool
            .query(`CREATE FUNCTION pause_video_execution_insert() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_advisory_xact_lock(${lock}); RETURN NEW; END $$;
            CREATE TRIGGER pause_video_execution_insert AFTER INSERT ON mio_video_executions
              FOR EACH ROW EXECUTE FUNCTION pause_video_execution_insert()`);
        pending = f.post(references);
        void pending.catch(() => {});
        await waitForLock(
          f,
          lock,
          stage === 'quota lock' ? 'pg_advisory_xact_lock' : 'INSERT INTO mio_video_executions',
          1,
        );
        recovery = f.service.recover(actor, id);
        void recovery.catch(() => {});
        await waitForLock(
          f,
          VIDEO_QUOTA_LOCK,
          'pg_advisory_xact_lock',
          stage === 'quota lock' ? 2 : 1,
        );
        await f.loseExecutorLease();
        f.videoAdmission.mockClear();
        f.snapshotVideo.mockClear();
        f.objects.head.mockClear();

        await expectUnavailable(await f.post(references));
        await expectUnavailable(await f.postRequest(original, 'other'));
        await expect(f.service.recover(actor, id)).rejects.toMatchObject({
          status: 503,
          code: 'VIDEO_UNAVAILABLE',
        });
        const same = await f.postRequest(original);
        expect(same.status).toBe(200);
        expect(await same.json()).toEqual(before);
        const changed = await f.postRequest({
          ...original,
          parameters: { ...original.parameters, prompt: 'different input' },
        });
        expect(changed.status).toBe(409);
        expect(await changed.json()).toMatchObject({ error: { code: 'REQUEST_CONFLICT' } });
        const detail = await f.get(id);
        expect(detail.status).toBe(200);
        expect(await detail.json()).toEqual(before);
        const list = await f.list();
        expect(list.status).toBe(200);
        expect(await list.json()).toMatchObject({ items: [{ id }] });
        expect(await (await f.list('other')).json()).toMatchObject({ items: [] });
        expect(f.videoAdmission).not.toHaveBeenCalled();
        expect(f.snapshotVideo).not.toHaveBeenCalled();
        expect(f.objects.head).not.toHaveBeenCalled();

        await gate.query('SELECT pg_advisory_unlock($1)', [lock]);
        await expectUnavailable(await pending);
        await expect(recovery).rejects.toMatchObject({ status: 503, code: 'VIDEO_UNAVAILABLE' });
        expect((await f.pool.query('SELECT id,state FROM mio_video_jobs')).rows).toEqual([
          { id, state: 'materialization_failed' },
        ]);
        expect((await f.pool.query(executionState)).rows).toEqual(beforeExecution);
        expect(await f.store.get(actor.userId, id)).toEqual(before);
        expect(f.wake).toHaveBeenCalledTimes(1);
        expect(f.upstream).not.toHaveBeenCalled();
      } finally {
        await gate.query('SELECT pg_advisory_unlock($1)', [lock]);
        gate.release();
        await Promise.allSettled([pending, recovery]);
        await f.close();
      }
    },
  );

  it('returns an already committed HTTP job without waking a stopped executor', async () => {
    const f = await assetHttpFixture();
    const committed = Promise.withResolvers<string>();
    const resume = Promise.withResolvers<void>();
    const create = f.store.create.bind(f.store);
    vi.spyOn(f.store, 'create').mockImplementationOnce(async (...args) => {
      const result = await create(...args);
      committed.resolve(result.jobId);
      await resume.promise;
      return result;
    });
    try {
      const asset = await f.addAsset();
      const references = [{ assetId: asset.assetId }];
      const request = f.request(references);
      const pending = f.postRequest(request);
      const id = await Promise.race([
        committed.promise,
        pending.then(() => {
          throw new Error('HTTP POST replied before the post-COMMIT barrier');
        }),
      ]);
      f.stopRunner(new ProviderError(409, 'FIXTURE_PRIVATE_EXECUTOR_REASON'));
      resume.resolve();
      const reply = await pending;
      expect(reply.status).toBe(202);
      expect(await reply.json()).toMatchObject({ id, state: 'accepted' });
      const replay = await f.postRequest(request);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ id });
      await expectUnavailable(await f.post(references));
      expect(f.wake).not.toHaveBeenCalled();
      expect(f.upstream).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await f.close();
    }
  });
});

it('blocks video discovery and HTTP admission for previously accepted invalid routes', async () => {
  const q2 = 'video-vidu-q2';
  const turbo = 'kling-v2-5-turbo';
  const invalidId = 'video-vidu/fixture';
  const alias = 'video-vidu-fixture:v2.1';
  const f = await assetHttpFixture({ providerModelIds: [q2, turbo, invalidId, alias] });
  try {
    // Reproduce what the previous platform importer could persist for these discovered IDs.
    await f.pool.query(
      `INSERT INTO mio_provider_model_routes (raw_model_id,operation,vendor,driver,classification,
        submit_path,query_path_template,param_spec,capability_metadata,source_kind,source,source_version)
       SELECT model_id,operation,vendor,driver,classification,submit_path,query_path_template,
        param_spec,capability_metadata,source_kind,source,source_version
       FROM mio_provider_model_routes CROSS JOIN unnest($2::text[]) AS model_id
       WHERE raw_model_id=$1 AND operation='video.generate'`,
      [q2, [invalidId, alias]],
    );
    await f.pool.query(
      `UPDATE mio_provider_model_routes SET param_spec=jsonb_set(param_spec,'{parameters,resolutions}','["720p"]')
       WHERE raw_model_id=$1 AND operation='video.generate'`,
      [q2],
    );
    await f.pool.query(
      `UPDATE mio_provider_model_routes SET param_spec=jsonb_set(param_spec,'{parameters,generateAudio}','true')
       WHERE raw_model_id=$1 AND operation='video.generate'`,
      [turbo],
    );

    const catalog = await f.provider.catalog(actor);
    for (const [modelId, parameters] of [
      [q2, { resolution: '720p' }],
      [turbo, { generateAudio: true }],
      [invalidId, {}],
    ] as const) {
      const member = catalog.items.find((item) => item.modelId === modelId)!;
      expect.soft(member).toMatchObject({
        discovered: true,
        video: { runnable: false, adaptation: null, modes: [] },
      });
      const response = await f.capabilities(member.modelRef);
      expect(response.status).toBe(200);
      const capability: VideoCapabilitiesView = await response.json();
      expect.soft(capability).toMatchObject({
        available: false,
        unavailableReason: 'ROUTE_NOT_CONFIGURED',
        modes: [],
      });
      const rejected = await f.postRequest({
        ...f.request([]),
        modelRef: member.modelRef,
        expectedCapabilitiesVersion: capability.capabilitiesVersion,
        parameters: { mode: 'text_to_video', prompt: 'A spring morning.', ...parameters },
      });
      expect.soft(rejected.status).toBe(503);
      expect.soft(await rejected.json()).toEqual({
        error: {
          code: 'VIDEO_UNAVAILABLE',
          message: 'VIDEO_UNAVAILABLE',
          requestId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          ),
        },
      });
    }

    const dynamic = catalog.items.find((item) => item.modelId === alias)!;
    expect(dynamic).toMatchObject({ discovered: true, video: { runnable: true } });
    const capability: VideoCapabilitiesView = await (await f.capabilities(dynamic.modelRef)).json();
    expect(capability).toMatchObject({ available: true });
    const accepted = await f.postRequest({
      ...f.request([]),
      modelRef: dynamic.modelRef,
      expectedCapabilitiesVersion: capability.capabilitiesVersion,
      parameters: { mode: 'text_to_video', prompt: 'A spring morning.', generateAudio: true },
    });
    expect(accepted.status).toBe(202);
    const job: VideoJobView = await accepted.json();
    expect(job).toMatchObject({ state: 'accepted', effectiveParameters: { generateAudio: true } });
    expect((await f.pool.query('SELECT id FROM mio_video_jobs')).rows).toEqual([{ id: job.id }]);
    expect(f.upstream).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each([true, false])(
  'freezes the Kling audio default and preserves the raw intent on HTTP replay (override: %s)',
  async (override) => {
    const modelId = 'video-kling-v3';
    const declaration = legacyVideoRouteEntries([modelId])[0]!;
    const original = validateVideoRouteConfig({
      ...declaration,
      editPath: null,
      requestDefaults: {},
      outputSpec: {},
    })!;
    const route = {
      ...original,
      paramSpec: {
        ...original.paramSpec,
        parameters: { ...original.paramSpec.parameters!, generateAudio: override },
      },
    };
    const f = await assetHttpFixture({ alternate: { route, modelId } });
    try {
      const request: VideoCreateRequest = {
        ...f.request([]),
        parameters: { mode: 'text_to_video', prompt: 'A pebble falls in a pond.' },
      };
      const initial = await f.postRequest(request);
      expect(initial.status).toBe(202);
      const first = await initial.json();
      expect(first.effectiveParameters.generateAudio).toBe(true);
      const persisted = (
        await f.pool.query('SELECT command,input_hash FROM mio_video_jobs WHERE id=$1', [first.id])
      ).rows[0];
      expect(persisted.command.request.parameters.generateAudio).toBe(true);
      expect(persisted.input_hash).toBe(
        createHash('sha256').update(JSON.stringify(request)).digest('hex'),
      );
      expect(f.upstream).not.toHaveBeenCalled();
      expect((await f.runNext()).id).toBe(first.id);
      expect(f.upstream).toHaveBeenCalledTimes(1);
      const [endpoint, outbound] = f.upstream.mock.calls[0]!;
      expect(new URL(String(endpoint)).pathname).toBe('/kling/v1/videos/text2video');
      expect(JSON.parse(String(outbound?.body))).toMatchObject({
        model_name: modelId,
        sound: 'on',
        settings: { audio: 'native' },
      });

      f.snapshotVideo.mockClear();
      const replay = await f.postRequest(request);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        id: first.id,
        state: 'submitted',
        effectiveParameters: { generateAudio: true },
      });
      const different = await f.postRequest({
        ...request,
        parameters: { ...request.parameters, generateAudio: true },
      });
      expect(different.status).toBe(409);
      expect(await different.json()).toMatchObject({ error: { code: 'REQUEST_CONFLICT' } });
      expect(f.snapshotVideo).not.toHaveBeenCalled();
      expect(f.upstream).toHaveBeenCalledTimes(1);

      const explicit = await f.postRequest({
        ...request,
        requestId: randomUUID(),
        parameters: { ...request.parameters, generateAudio: false },
      });
      if (override) {
        expect(explicit.status).toBe(202);
        const second = await explicit.json();
        expect(second.effectiveParameters.generateAudio).toBe(false);
        expect((await f.runNext()).id).toBe(second.id);
        expect(f.upstream).toHaveBeenCalledTimes(2);
        expect(JSON.parse(String(f.upstream.mock.calls[1]![1]?.body))).toMatchObject({
          sound: 'off',
          settings: { audio: 'off' },
        });
      } else {
        expect(explicit.status).toBe(400);
        expect(await explicit.json()).toMatchObject({ error: { code: 'VIDEO_INPUT_INVALID' } });
        expect(f.upstream).toHaveBeenCalledTimes(1);
      }
    } finally {
      await f.close();
    }
  },
);

it('rejects an over-budget HappyHorse prompt before admission and submits the exact limit', async () => {
  const modelId = 'happyhorse-1.1-r2v';
  const route = validateVideoRouteConfig({
    ...legacyVideoRouteEntries([modelId])[0]!,
    editPath: null,
    requestDefaults: {},
    outputSpec: {},
  })!;
  const limit = route.paramSpec.parameters!.maxPromptCodepoints;
  const header = '[Image 1]、[Image 2] 为 "领队🐎"；[Image 3] 为 "旅人"。\n';
  const prompt = '跃' + '😀'.repeat(limit - [...header].length - 1);
  const f = await assetHttpFixture({ alternate: { route, modelId } });
  try {
    const first = await f.addAsset();
    const second = await f.addAsset();
    const subjects = [
      { name: '领队🐎', images: [{ assetId: first.assetId }, { assetId: second.assetId }] },
      { name: '旅人', images: [{ assetId: first.assetId }] },
    ];
    const request: VideoCreateRequest = {
      ...f.request([]),
      parameters: { mode: 'reference_subjects', prompt, subjects },
    };
    const over = prompt + '潮';
    expect([...over].length).toBeLessThan(limit);
    expect([...(header + over)].length).toBe(limit + 1);
    const rejected = await f.postRequest({
      ...request,
      parameters: { ...request.parameters, prompt: over },
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: 'VIDEO_INPUT_INVALID' } });
    const { rows } = await f.pool.query(
      'SELECT (SELECT count(*) FROM mio_video_jobs) AS jobs,' +
        ' (SELECT count(*) FROM mio_video_executions) AS executions',
    );
    expect(rows).toEqual([{ jobs: '0', executions: '0' }]);
    expect(f.wake).not.toHaveBeenCalled();
    expect(f.objects.head).not.toHaveBeenCalled();
    expect(f.objects.readPrefix).not.toHaveBeenCalled();
    expect(f.objects.materialUrl).not.toHaveBeenCalled();
    expect(f.upstream).not.toHaveBeenCalled();

    const accepted = await f.postRequest(request);
    expect(accepted.status).toBe(202);
    const job: VideoJobView = await accepted.json();
    expect(job).toMatchObject({ state: 'accepted', effectiveParameters: { prompt, subjects } });
    expect((await f.runNext()).id).toBe(job.id);
    expect(f.upstream).toHaveBeenCalledOnce();
    const [endpoint, outbound] = f.upstream.mock.calls[0]!;
    expect(new URL(String(endpoint)).pathname).toBe(route.submitPath);
    expect(outbound?.method).toBe('POST');
    const body = JSON.parse(String(outbound?.body));
    expect(body.input).toEqual({
      prompt: header + prompt,
      media: [first, second, first].map(({ key }) => ({
        type: 'reference_image',
        url: 'https://cos.fixture/' + key + '?signature=fixture',
      })),
    });
    expect([...body.input.prompt].length).toBe(limit);
    expect(await (await f.get(job.id)).json()).toMatchObject({ state: 'submitted' });
  } finally {
    await f.close();
  }
});

describe('video asset admission over HTTP', () => {
  it('disposes the pool and random schema when later setup DDL fails', async () => {
    let setup:
      | {
          pool: Pool;
          database: VideoHttpDatabase;
          endPool: MockInstance<Pool['end']>;
          closeDatabase: MockInstance<VideoHttpDatabase['close']>;
        }
      | undefined;
    let ddlError: unknown;
    try {
      const failure = await assetHttpFixture({
        async migrateGenerations(pool, database) {
          setup = {
            pool,
            database,
            endPool: vi.spyOn(pool, 'end'),
            closeDatabase: vi.spyOn(database, 'close'),
          };
          expect((await pool.query('SELECT current_schema() AS schema')).rows).toEqual([
            { schema: database.applicationName },
          ]);
          try {
            await pool.query(`${generationSchemaSQL}\nCREATE TABLE mio_video_jobs (id uuid);`);
          } catch (error) {
            ddlError = error;
            throw error;
          }
        },
      }).then(
        async (fixture) => {
          await fixture.close();
          throw new Error('generation DDL unexpectedly succeeded');
        },
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        code: '42P07',
        message: 'relation "mio_video_jobs" already exists',
      });
      expect(failure).toBe(ddlError);
      if (!setup) throw new Error('generation DDL was not reached');
      const observer = new Pool({
        connectionString: setup.database.observerURL,
        connectionTimeoutMillis: 5000,
      });
      try {
        if (process.env.MIO_TEST_DATABASE_URL) {
          const { rows } = await observer.query(
            'SELECT nspname FROM pg_namespace WHERE nspname=$1',
            [setup.database.applicationName],
          );
          expect(rows).toEqual([]);
        } else {
          // With a temporary cluster the fixture also owns the listening process.
          await expect(observer.query('SELECT 1')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
        }
      } finally {
        await observer.end();
      }
      expect(setup.endPool).toHaveBeenCalledOnce();
    } finally {
      if (setup) {
        try {
          if (!setup.endPool.mock.calls.length) await setup.pool.end();
        } finally {
          if (!setup.closeDatabase.mock.calls.length) await setup.database.close();
        }
      }
    }
  });

  it('submits from persisted frozen input objects with ordered, duplicated reference slots', async () => {
    const f = await assetHttpFixture();
    try {
      const audio = await f.addAsset(actor.userId, 'ready', 'audio/x-wav', false, wave);
      const image = await f.addAsset();
      const references: VideoAssetReference[] = [
        { assetId: image.assetId },
        { assetId: audio.assetId, mediaType: 'audio' },
        { assetId: image.assetId },
        { assetId: image.assetId },
      ];
      const frozen = {
        [image.assetId]: { key: image.key, etag: image.head.etag },
        [audio.assetId]: { key: audio.key, etag: audio.head.etag },
      };
      const accepted = await f.post(references);
      expect(accepted.status).toBe(202);
      const job: VideoJobView = await accepted.json();
      expect(job).toMatchObject({ state: 'accepted', inputSnapshot: references });
      const persisted = await f.pool.query(
        "SELECT owner_id, command->'inputObjects' AS input_objects FROM mio_video_jobs WHERE id=$1",
        [job.id],
      );
      expect(persisted.rows).toEqual([{ owner_id: actor.userId, input_objects: frozen }]);
      const heads = [image, audio].map(({ key }) => [key, expect.any(AbortSignal)]);
      const reads = [image, audio].map(({ key, head }) => [
        key,
        head.etag,
        head.size,
        expect.any(Number),
        expect.any(AbortSignal),
      ]);
      expect(f.objects.head.mock.calls).toEqual(heads);
      expect(f.objects.readPrefix.mock.calls).toEqual(reads);
      expect(f.objects.materialUrl).not.toHaveBeenCalled();
      expect(f.upstream).not.toHaveBeenCalled();

      expect((await f.runNext()).id).toBe(job.id);
      expect(f.objects.head.mock.calls).toEqual([...heads, ...heads]);
      expect(f.objects.readPrefix.mock.calls).toEqual([...reads, ...reads]);
      expect(f.objects.materialUrl.mock.calls).toEqual([[image.key], [audio.key]]);
      expect(f.upstream).toHaveBeenCalledOnce();
      const submittedHeads = f.objects.head.mock.invocationCallOrder.slice(heads.length);
      const submittedReads = f.objects.readPrefix.mock.invocationCallOrder.slice(reads.length);
      const [firstSignature, lastSignature] = f.objects.materialUrl.mock.invocationCallOrder;
      for (const [index, head] of submittedHeads.entries())
        expect(head).toBeLessThan(submittedReads[index]!);
      expect(Math.max(...submittedReads)).toBeLessThan(firstSignature!);
      expect(lastSignature!).toBeLessThan(f.upstream.mock.invocationCallOrder[0]!);
      const [endpoint, outbound] = f.upstream.mock.calls[0]!;
      expect(new URL(String(endpoint)).pathname).toBe('/volc/api/v3/contents/generations/tasks');
      expect(outbound?.method).toBe('POST');
      const imageContent = {
        type: 'image_url',
        image_url: { url: `https://cos.fixture/${image.key}?signature=fixture` },
        role: 'reference_image',
      };
      expect(JSON.parse(String(outbound?.body)).content).toEqual([
        { type: 'text', text: 'ordered references' },
        imageContent,
        {
          type: 'audio_url',
          audio_url: { url: `https://cos.fixture/${audio.key}?signature=fixture` },
          role: 'reference_audio',
        },
        imageContent,
        imageContent,
      ]);
      const submitted = await f.pool.query(
        `SELECT j.state, e.phase, e.upstream_task_id
         FROM mio_video_jobs j JOIN mio_video_executions e ON e.job_id=j.id WHERE j.id=$1`,
        [job.id],
      );
      expect(submitted.rows).toEqual([
        { state: 'submitted', phase: 'waiting', upstream_task_id: 'fixture-task' },
      ]);
      const read = await f.get(job.id);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ id: job.id, state: 'submitted' });
    } finally {
      await f.close();
    }
  });

  it('checks real PNG, WAV and MP4 bytes over conditional COS reads at both boundaries', async () => {
    const f = await assetHttpFixture();
    const requests: {
      method?: string | undefined;
      key: string;
      range?: string | undefined;
      etag?: string | undefined;
    }[] = [];
    const rangeErrors = new Map<string, number>();
    const cos = createServer((request, response) => {
      const key = request.url?.slice(1) ?? '';
      const range = request.headers.range;
      const etag = request.headers['if-match'];
      requests.push({ method: request.method, key, range, etag });
      const head = f.heads.get(key);
      const body = f.inputBytes.get(key);
      if (!head || !body) return response.writeHead(404).end();
      if (request.method === 'HEAD')
        return response
          .writeHead(200, {
            'content-length': head.size,
            etag: head.etag,
            'content-type': 'application/octet-stream',
          })
          .end();
      if (etag !== head.etag) return response.writeHead(412).end();
      const failed = rangeErrors.get(key);
      if (failed) return response.writeHead(failed).end();
      const end = /^bytes=0-(\d+)$/.exec(range ?? '');
      if (!end) return response.writeHead(400).end();
      const length = Number(end[1]) + 1;
      return response
        .writeHead(206, {
          'content-length': length,
          'content-range': `bytes 0-${length - 1}/${head.size}`,
          etag: head.etag,
        })
        .end(body.subarray(0, length));
    });
    await new Promise<void>((resolve) => cos.listen(0, '127.0.0.1', resolve));
    const address = cos.address();
    if (!address || typeof address === 'string') throw new Error('COS fixture address missing');
    const original = COS.prototype.headObject;
    const pointToFixture = vi.spyOn(COS.prototype, 'headObject').mockImplementation(function (
      this: COS,
      ...args
    ) {
      const client = this as unknown as { options: { Domain: string; Protocol: string } };
      client.options.Domain = `http://127.0.0.1:${address.port}`;
      client.options.Protocol = 'http:';
      return original.apply(this, args);
    });
    try {
      const storage = createCosStorage({
        databaseURL: 'postgresql://example.invalid/media',
        bucket: 'mio-test-1234567890',
        region: 'ap-shanghai',
        secretId: 'fixture',
        secretKey: 'fixture',
      });
      f.objects.head.mockImplementation(storage.head);
      f.objects.readPrefix.mockImplementation(storage.readPrefix!);
      const image = await f.addAsset(actor.userId, 'ready', 'Image/PNG');
      const fake = await f.addAsset(actor.userId, 'ready', 'Image/PNG', false, wave);
      const audio = await f.addAsset(actor.userId, 'ready', 'audio/x-wav', false, wave);
      const videos = new Map(
        await Promise.all(
          (['mp4', 'mov', '3gp'] as const).map(
            async (kind) =>
              [kind, await readFile(writeVideoProbeFixture(f.directory, kind))] as const,
          ),
        ),
      );
      const video = await f.addAsset(actor.userId, 'ready', 'video/mp4', true, videos.get('mp4')!);
      const invalid = await f.post([{ assetId: fake.assetId }]);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: 'VIDEO_INPUT_INVALID' } });
      for (const kind of ['mov', '3gp'] as const) {
        const wrong = await f.addAsset(actor.userId, 'ready', 'video/mp4', true, videos.get(kind)!);
        const response = await f.post([{ assetId: wrong.assetId, mediaType: 'video' }]);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: 'VIDEO_INPUT_INVALID' } });
      }
      for (const [status, expected, code] of [
        [412, 409, 'VIDEO_INPUT_CHANGED'],
        [409, 503, 'VIDEO_UNAVAILABLE'],
        [206, 503, 'VIDEO_UNAVAILABLE'],
        [503, 503, 'VIDEO_UNAVAILABLE'],
      ] as const) {
        rangeErrors.set(image.key, status);
        const response = await f.post([{ assetId: image.assetId }]);
        expect(response.status).toBe(expected);
        expect(await response.json()).toMatchObject({ error: { code } });
      }
      rangeErrors.delete(image.key);
      expect((await f.pool.query('SELECT count(*) FROM mio_video_jobs')).rows[0].count).toBe('0');
      expect(f.objects.materialUrl).not.toHaveBeenCalled();
      expect(f.upstream).not.toHaveBeenCalled();

      const refs: VideoAssetReference[] = [
        { assetId: image.assetId },
        { assetId: audio.assetId, mediaType: 'audio' },
        { assetId: video.assetId, mediaType: 'video' },
      ];
      requests.length = 0;
      const expectedReads = [image, audio, video].flatMap(({ key, head }) => [
        { method: 'HEAD', key, range: undefined, etag: undefined },
        {
          method: 'GET',
          key,
          range: `bytes=0-${Math.min(head.size - 1, 1024) - 1}`,
          etag: head.etag,
        },
      ]);
      const accepted = await f.post(refs);
      expect(accepted.status).toBe(202);
      const job = await accepted.json();
      expect(job.inputSnapshot).toEqual(refs);
      expect(requests).toEqual(expectedReads);
      expect(f.objects.materialUrl).not.toHaveBeenCalled();
      const row = await f.runNext();
      expect(row.id).toBe(job.id);
      expect(row.command.inputObjects).toEqual(
        Object.fromEntries(
          [image, audio, video].map(({ assetId, key, head }) => [
            assetId,
            { key, etag: head.etag },
          ]),
        ),
      );
      expect(requests).toEqual([...expectedReads, ...expectedReads]);
      expect(f.objects.materialUrl.mock.calls).toEqual([[image.key], [audio.key], [video.key]]);
      expect(f.upstream).toHaveBeenCalledTimes(1);
      expect(f.upstream.mock.calls[0]![1]?.method).toBe('POST');
      expect(JSON.parse(String(f.upstream.mock.calls[0]![1]?.body)).content).toMatchObject([
        { type: 'text' },
        { type: 'image_url' },
        { type: 'audio_url' },
        { type: 'video_url' },
      ]);
    } finally {
      pointToFixture.mockRestore();
      cos.closeAllConnections();
      cos.close();
      await once(cos, 'close');
      await f.close();
    }
  });

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
      const bytes = await readFile(writeVideoProbeFixture(f.directory, 'mp4'));
      const second = await f.addAsset(actor.userId, 'ready', 'video/mp4', true, bytes);
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

  it.each(['key', 'condition'] as const)(
    'rejects before signing when the frozen input %s changes after admission',
    async (change) => {
      const f = await assetHttpFixture();
      try {
        const input = await f.addAsset();
        const response = await f.post([{ assetId: input.assetId }]);
        expect(response.status).toBe(202);
        const job = await response.json();
        if (change === 'key') {
          const replacement = input.key + '-replaced';
          f.heads.set(replacement, input.head);
          f.inputBytes.set(replacement, png);
          await f.pool.query('UPDATE mio_assets SET raw_key=$1 WHERE id=$2', [
            replacement,
            input.assetId,
          ]);
        } else {
          f.objects.readPrefix.mockRejectedValueOnce(
            Object.assign(new Error('COS conditional read failed'), { statusCode: 412 }),
          );
        }
        await f.runNext();
        expect(await (await f.get(job.id)).json()).toMatchObject({
          state: 'rejected',
          error: { code: 'VIDEO_INPUT_OR_CREDENTIAL_UNAVAILABLE' },
        });
        expect(f.objects.readPrefix).toHaveBeenCalledTimes(change === 'key' ? 1 : 2);
        expect(f.objects.readPrefix.mock.calls.every(([key]) => key === input.key)).toBe(true);
        expect(f.objects.materialUrl).not.toHaveBeenCalled();
        expect(f.upstream).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );

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
        reply.resolve({
          ETag: asset.head.etag,
          headers: { 'content-length': String(asset.head.size) },
        });
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
