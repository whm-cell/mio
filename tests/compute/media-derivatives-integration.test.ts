import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { parseMediaManifest } from '@mio/compute-contracts';
import { Journal } from '../../compute/src/adapters/journal.ts';
import { executeMedia } from '../../compute/src/media-executor.ts';
import type { MediaExecutor } from '../../compute/src/media-execution.ts';
import { runMediaRuntime } from '../../compute/src/media-runtime.ts';
import type { MediaStore as WorkerObjects } from '../../compute/src/media-worker.ts';
import { ResourceSlots } from '../../compute/src/resource-slots.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import { startAssetDerivatives } from '../../src/assets/derivatives.ts';
import { createAssetHandler } from '../../src/assets/http.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { createAssetService } from '../../src/assets/service.ts';
import { AssetStore } from '../../src/assets/store.ts';
import { createMediaHandler } from '../../src/compute/media-http.ts';
import { createMediaService } from '../../src/compute/media-service.ts';
import { MediaStore } from '../../src/compute/media-store.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { authDatabase } from '../support/auth-database.ts';
import { withLocalTestBroker } from '../support/local-broker-fixture.ts';

const actor = { userId: 'private-video-owner', sessionId: 'video-session' };
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const runFFmpeg = promisify(execFile);
const assetsPath = '/api/v1/assets';
const mediaPath = '/api/v1/compute/media';
type Job = {
  jobId: string;
  status: string;
  attempt: number;
  outputs: { assetId: string; name: string; role: string }[];
};

function storage() {
  let origin = '';
  const blobs = new Map<string, Buffer>();
  const permits = new Map<string, { key: string; expiresAt: number }>();
  const writes: string[] = [];
  const read = (key: string) => {
    const bytes = blobs.get(key);
    if (!bytes) throw Object.assign(new Error('MISSING'), { statusCode: 404 });
    const sha256 = hash(bytes);
    return { bytes, size: bytes.length, etag: `"${sha256}"`, sha256 };
  };
  const app: AssetObjectStore = {
    uploadUrl: (key) => key,
    downloadUrl: (key) => origin + '/' + key,
    hlsSegmentUrl(key, ttl) {
      const ticket = randomUUID();
      permits.set(ticket, { key, expiresAt: Date.now() + ttl * 1000 });
      return `${origin}/signed-ts/${ticket}.ts`;
    },
    async head(key) {
      const { size, etag, sha256 } = read(key);
      return { size, etag, sha256 };
    },
    async readMedia(key, etag, size, signal) {
      signal.throwIfAborted();
      const object = read(key);
      if (object.size !== size || object.etag !== etag) throw new Error('PRECONDITION_FAILED');
      return object.bytes;
    },
    async copy(source, target, etag) {
      const object = read(source);
      if (object.etag !== etag || blobs.has(target)) throw new Error('PRECONDITION_FAILED');
      blobs.set(target, object.bytes);
    },
    async delete(key) {
      blobs.delete(key);
    },
  };
  const worker: WorkerObjects = {
    async downloadMedia(input, files, name, signal) {
      const object = read(input.key);
      if (object.etag !== input.etag) throw new Error('INPUT_CHANGED');
      await files.receive(name, Readable.from(object.bytes), input.sizeBytes, signal);
    },
    async uploadMedia(key, files, name, expected, _contentType, signal) {
      signal.throwIfAborted();
      const data = await readFile(files.path(name));
      expect(blobs.has(key)).toBe(false);
      expect({ size: data.length, sha256: hash(data) }).toEqual(expected);
      blobs.set(key, data);
      writes.push(key);
    },
    async headMedia(key, signal) {
      signal.throwIfAborted();
      if (!blobs.has(key)) return null;
      const { size, etag, sha256 } = read(key);
      return { sizeBytes: size, etag, sha256 };
    },
    async verifyMedia(key, etag, size, sha256, signal) {
      signal.throwIfAborted();
      const object = read(key);
      return object.etag === etag && object.size === size && object.sha256 === sha256;
    },
  };
  function serveSegment(path: string, response: ServerResponse) {
    const permit = permits.get(path.slice('/signed-ts/'.length, -'.ts'.length));
    if (!permit || Date.now() >= permit.expiresAt) return response.writeHead(403).end();
    return response.writeHead(200, { 'content-type': 'video/mp2t' }).end(read(permit.key).bytes);
  }
  return {
    app,
    worker,
    blobs,
    read,
    writes,
    serveSegment,
    setOrigin: (url: string) => {
      origin = url;
    },
  };
}

async function source(root: string, short = false) {
  const path = join(root, short ? 'short.mp4' : 'fixture.mp4');
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-threads',
      '2',
      '-filter_threads',
      '2',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=160x90:rate=24:duration=${short ? 0.25 : 6.3}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=520:sample_rate=48000:duration=${short ? 0.25 : 6.3}`,
      '-c:a',
      'aac',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '240',
      path,
    ],
    { timeout: 30000 },
  );
  return readFile(path);
}

function serve(
  assets: ReturnType<typeof createAssetService>,
  media: ReturnType<typeof createMediaService>,
  objects: ReturnType<typeof storage>,
) {
  let origin = '';
  let handleAsset: ReturnType<typeof createAssetHandler>;
  let handleMedia: ReturnType<typeof createMediaHandler>;
  const identity = async (headers: Headers) => {
    const cookie = headers.get('cookie');
    if (cookie === 'owner') return actor;
    if (cookie === 'other') return { ...actor, userId: 'other-user' };
    return null;
  };
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    if (path.startsWith('/signed-ts/')) objects.serveSegment(path, response);
    else if (path.startsWith(assetsPath)) void handleAsset(request, response);
    else void handleMedia(request, response);
  });
  return {
    async begin() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('LISTEN_FAILED');
      origin = `http://127.0.0.1:${address.port}`;
      objects.setOrigin(origin);
      handleAsset = createAssetHandler(assets, identity, [origin]);
      handleMedia = createMediaHandler(media, identity, [origin]);
    },
    call(path: string, body?: object, cookie = 'owner') {
      return fetch(origin + path, {
        method: body ? 'POST' : 'GET',
        headers: { cookie, origin, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function checkPlayback(http: ReturnType<typeof serve>, jobId: string, short = false) {
  const masterPath = `${mediaPath}/${jobId}/hls`;
  const master = await http.call(masterPath);
  expect(master.status, await master.clone().text()).toBe(200);
  expect(master.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
  expect(master.headers.get('cache-control')).toBe('private, no-store');
  const text = await master.text();
  expect(text).toContain('RESOLUTION=160x90');
  const paths = text.split('\n').filter((line) => line.startsWith('/'));
  expect(paths).toHaveLength(1);
  expect(paths[0]).toMatch(new RegExp(`^${masterPath}/[a-f0-9-]+$`));
  const path = paths[0]!;
  expect((await http.call(masterPath, undefined, '')).status).toBe(401);
  expect((await http.call(masterPath, undefined, 'other')).status).toBe(404);
  expect((await http.call(path, undefined, 'other')).status).toBe(404);
  expect((await http.call(path, {})).status).toBe(405);
  const child = await http.call(path);
  expect(child.status, await child.clone().text()).toBe(200);
  const playlist = await child.text();
  const links = playlist.split('\n').filter((line) => line.startsWith('http'));
  expect(links).toHaveLength(short ? 1 : 2);
  if (short) {
    expect(playlist).toContain('#EXT-X-TARGETDURATION:1');
    expect(playlist).toContain('#EXTINF:0.250000,');
  }
  for (const link of links) {
    const result = await fetch(link);
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('video/mp2t');
    const data = new Uint8Array(await result.arrayBuffer());
    expect(data[0]).toBe(0x47);
    expect(data.byteLength % 188).toBe(0);
  }
  const playback = await runFFmpeg(
    'ffmpeg',
    [
      '-v',
      'warning',
      '-xerror',
      '-err_detect',
      'explode',
      '-protocol_whitelist',
      'http,tcp',
      '-headers',
      'Cookie: owner\r\n',
      '-f',
      'hls',
      '-i',
      master.url,
      '-map',
      '0:V:0',
      '-map',
      '0:a:0?',
      '-stats_period',
      '3600',
      '-progress',
      'pipe:1',
      '-f',
      'null',
      '-',
    ],
    { timeout: 30000 },
  );
  expect(playback.stderr).toBe('');
  const decoded = playback.stdout
    .match(/out_time_us=(\d+)(?=\r?$)/gm)
    ?.at(-1)
    ?.split('=')[1];
  expect(Math.abs(Number(decoded) / 1000000 - (short ? 0.25 : 6.3))).toBeLessThanOrEqual(0.35);
  const otherAssetRoute = await http.call(assetsPath + '/' + path.split('/').at(-1)!);
  expect(otherAssetRoute.status).toBe(200);
  expect(await otherAssetRoute.json()).not.toHaveProperty('downloadUrl');
}

it('runs automatic ordinary and retried canvas jobs through real media queues and both private playlist routes', async () => {
  await withLocalTestBroker(async (broker) => {
    const root = await mkdtemp(join(tmpdir(), 'mio-derivatives-integration-'));
    const database = await authDatabase();
    const pool = new Pool({ connectionString: database.url });
    const objects = storage();
    const stop = new AbortController();
    let firstCanvasAttempt: string | undefined;
    let retryCanvasAttempt: string | undefined;
    const execute: MediaExecutor = (command, ctx) => {
      if (command.operation !== 'video.derivatives' || command.parameters.profile !== 'canvas')
        return executeMedia(command, ctx);
      if (command.attempt !== 1) {
        retryCanvasAttempt = command.attemptId;
        return executeMedia(command, ctx);
      }
      firstCanvasAttempt = command.attemptId;
      return executeMedia(command, {
        ...ctx,
        run: async (step, discover) => {
          const result = await ctx.run(step, discover);
          if (step.id === 'encode-seg-720-000.ts')
            throw Object.assign(new Error('WORKER_INTERRUPTED'), { code: 'WORKER_INTERRUPTED' });
          return result;
        },
      });
    };

    let journal: Journal | undefined;
    let assets: ReturnType<typeof createAssetService> | undefined;
    let media: ReturnType<typeof createMediaService> | undefined;
    let scheduler: ReturnType<typeof startAssetDerivatives> | undefined;
    let http: ReturnType<typeof serve> | undefined;
    let runtime: Promise<void> | undefined;
    let runtimeError: unknown;
    try {
      await pool.query(assetSchemaSQL);
      await pool.query(computeSchemaSQL);
      const assetStore = new AssetStore(new Pool({ connectionString: database.url }), true);
      assets = createAssetService(assetStore, objects.app);
      media = createMediaService(
        new MediaStore(new Pool({ connectionString: database.url })),
        objects.app,
        {
          brokerURL: broker.appBrokerUrl,
          brokerUser: broker.userA,
          expectedResultUser: broker.userB,
        },
      );
      journal = new Journal(root, 'derivative-integration', true);
      runtime = runMediaRuntime(
        {
          url: broker.workerBrokerUrl,
          userId: broker.userB,
          expectedUserId: broker.userA,
          directory: root,
        },
        objects.worker,
        journal,
        execute,
        stop.signal,
        new ResourceSlots(),
      ).catch((error) => {
        runtimeError = error;
      });
      http = serve(assets, media, objects);
      await http.begin();
      const clip = await source(root);
      const upload = await http.call(assetsPath + '/uploads', {
        filename: 'fixture.mp4',
        contentType: 'video/mp4',
        size: clip.length,
      });
      expect(upload.status).toBe(201);
      const { assetId, uploadUrl } = (await upload.json()) as {
        assetId: string;
        uploadUrl: string;
      };
      objects.blobs.set(uploadUrl, clip);
      for (let replay = 0; replay < 2; replay++) {
        const complete = await http.call(`${assetsPath}/${assetId}/complete`, {});
        expect(complete.status, await complete.clone().text()).toBe(200);
        expect(await complete.json()).toMatchObject({
          status: 'ready',
          derivatives: { profiles: [{ status: 'pending' }] },
        });
      }
      scheduler = startAssetDerivatives(assetStore, media);
      const ordinary = await vi.waitFor(
        async () => {
          const res = await http!.call(`${assetsPath}/${assetId}`);
          const { derivatives } = (await res.json()) as {
            derivatives: { profiles: { jobId: string; playbackUrl?: string; status: string }[] };
          };
          const output = derivatives.profiles[0]!;
          expect(output.status).toBe('succeeded');
          expect(output.playbackUrl).toBe(`${mediaPath}/${output.jobId}/hls`);
          return output.jobId;
        },
        { timeout: 20000, interval: 25 },
      );
      await checkPlayback(http, ordinary);
      const submitted = await http.call(mediaPath, {
        requestId: randomUUID(),
        operation: 'video.derivatives',
        inputs: [{ assetId }],
        parameters: { profile: 'canvas' },
      });
      expect(submitted.status, await submitted.clone().text()).toBe(202);
      const { jobId: canvas } = (await submitted.json()) as Job;
      await vi.waitFor(
        async () => {
          const current = await http!.call(`${mediaPath}/${canvas}`);
          expect(await current.json()).toMatchObject({ status: 'succeeded', attempt: 2 });
        },
        { timeout: 20000, interval: 25 },
      );
      expect(firstCanvasAttempt).toBeTruthy();
      expect(retryCanvasAttempt).toBeTruthy();
      expect(
        journal.media.get(retryCanvasAttempt!)?.steps['encode-seg-720-000.ts']?.reusedFromAttemptId,
      ).toBe(firstCanvasAttempt);
      expect(
        journal.media.get(retryCanvasAttempt!)?.steps['derivatives-canvas-audio']
          ?.reusedFromAttemptId,
      ).toBe(firstCanvasAttempt);
      await checkPlayback(http, canvas);

      const shortClip = await source(root, true);
      const shortId = randomUUID();
      const shortKey = `mio/raw/${shortId}/${randomUUID()}`;
      objects.blobs.set(shortKey, shortClip);
      await pool.query(
        `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,raw_key,state,expires_at)
         VALUES($1,$2,'short.mp4','video/mp4',$3,$4,'ready',now())`,
        [shortId, actor.userId, shortClip.length, shortKey],
      );
      const shortSubmit = await http.call(mediaPath, {
        requestId: randomUUID(),
        operation: 'video.derivatives',
        inputs: [{ assetId: shortId }],
        parameters: { profile: 'ordinary' },
      });
      expect(shortSubmit.status, await shortSubmit.clone().text()).toBe(202);
      const { jobId: shortJob } = (await shortSubmit.json()) as Job;
      await vi.waitFor(
        async () => {
          expect(await (await http!.call(`${mediaPath}/${shortJob}`)).json()).toMatchObject({
            status: 'succeeded',
          });
        },
        { timeout: 20000, interval: 25 },
      );
      await checkPlayback(http, shortJob, true);

      for (const id of [ordinary, canvas]) {
        const writes = objects.writes.filter((key) => key.startsWith(`mio/media/${id}/`));
        const last = writes.at(-1)!;
        expect(last.endsWith('/manifest.json')).toBe(true);
        const manifest = parseMediaManifest(objects.read(last).bytes);
        expect(manifest.files.map((file) => file.role)).toEqual([
          'preview',
          'poster',
          'segment',
          'segment',
          'hls',
          'hls',
        ]);
        expect(manifest.files.map((file) => file.key)).toEqual(writes.slice(0, -1));
        for (const file of manifest.files) expect(objects.read(file.key).sha256).toBe(file.sha256);
      }
      const { outputs } = (await (await http.call(`${mediaPath}/${ordinary}`)).json()) as Job;
      const preview = outputs.find((file) => file.role === 'preview')!;
      const generated = await http.call(`${assetsPath}/${preview.assetId}/complete`, {});
      expect(await generated.json()).toMatchObject({
        status: 'ready',
        downloadUrl: expect.any(String),
      });
      expect((await pool.query('SELECT asset_id FROM mio_asset_derivative_intents')).rows).toEqual([
        { asset_id: assetId },
      ]);
    } finally {
      if (http) await http.close();
      const schedulerClosed = scheduler?.close();
      stop.abort();
      await media?.close();
      await schedulerClosed;
      await runtime;
      journal?.close();
      await Promise.all([assets?.close(), pool.end()]);
      await database.close();
      await rm(root, { recursive: true, force: true });
      if (runtimeError) throw runtimeError;
    }
  });
}, 120000);
