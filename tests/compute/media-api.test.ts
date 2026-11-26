import { MEDIA_VERSION } from '@mio/compute-contracts';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { MEDIA_PROFILE, MEDIA_MAX_MANIFEST_BYTES, mediaObjectPrefix } from '@mio/compute-contracts';
import type {
  MediaCommand,
  MediaControl,
  MediaManifest,
  MediaResult,
} from '@mio/compute-contracts';
import type { AssetObjectStore, AssetPrincipal } from '../../src/assets/contracts.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { ComputeBroker } from '../../src/integrations/rabbitmq.ts';
import { createMediaHandler } from '../../src/compute/media/http.ts';
import { createMediaService } from '../../src/compute/media/service.ts';
import { MediaStore } from '../../src/compute/media/store.ts';
import type { MediaJobRow } from '../../src/compute/media/model.ts';
import { authDatabase } from '../support/auth-database.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let observer: Pool;
let service: ReturnType<typeof createMediaService>;
let store: MediaStore;
let server: Server;
let origin: string;
let assetId: string;
let key: string;
let receive: (event: MediaResult) => Promise<void>;
let brokerFailed: () => void;
const blobs = new Map<string, Uint8Array>();
const metadata = new Map<string, { size: number; etag: string; sha256?: string }>();
const actor: AssetPrincipal = { userId: 'media-api-owner', sessionId: 'session' };
const publish = vi.fn<(message: MediaCommand | MediaControl) => Promise<void>>();
const brokerClose = vi.fn<() => Promise<void>>();
const config = {
  brokerURL: 'amqp://a:password@127.0.0.1/vhost',
  brokerUser: 'a',
  expectedResultUser: 'b',
};
const head = vi.fn(async (objectKey: string) => {
  const meta = metadata.get(objectKey);
  if (!meta) throw new Error('missing object');
  return meta;
});
const read = vi.fn(async (objectKey: string, etag: string, size: number, signal: AbortSignal) => {
  signal.throwIfAborted();
  const meta = metadata.get(objectKey),
    bytes = blobs.get(objectKey);
  if (!meta || !bytes || meta.etag !== etag || bytes.length !== size)
    throw new Error('changed object');
  return bytes;
});
const objects: AssetObjectStore = {
  uploadUrl: () => '',
  downloadUrl: (objectKey) => `https://objects.invalid/${objectKey}?expires=300&signature=test`,
  head,
  readMedia: read,
  copy: async () => {},
  delete: async () => {},
};
function put(objectKey: string, text: string) {
  const bytes = Buffer.from(text),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  const meta = { size: bytes.length, etag: 'etag-' + sha256, sha256 };
  blobs.set(objectKey, bytes);
  metadata.set(objectKey, meta);
  return { key: objectKey, sizeBytes: bytes.length, etag: meta.etag, sha256 };
}
const identity = vi.fn(async (headers: Headers): Promise<AssetPrincipal | null> => {
  const cookie = headers.get('cookie');
  return cookie === 'owner' ? actor : cookie === 'other' ? { ...actor, userId: 'other' } : null;
});
function body(requestId = randomUUID()) {
  return {
    requestId,
    operation: 'video.trim',
    inputs: [{ assetId }],
    parameters: { startSeconds: 0, endSeconds: 2 },
  };
}
function call(path = '', value?: unknown, cookie = 'owner', options: RequestInit = {}) {
  return fetch(origin + '/api/v1/compute/media' + path, {
    method: value === undefined ? 'GET' : 'POST',
    headers: {
      origin,
      cookie,
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    ...options,
  });
}
async function create() {
  const result = await call('', body());
  expect(result.status).toBe(202);
  const value = (await result.json()) as { jobId: string };
  return (await store.ownerView(value.jobId, actor.userId))!;
}
function running(job: MediaJobRow): Extract<MediaResult, { state: 'running' }> {
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
    progress: 0.4,
  };
}
function output(job: MediaJobRow, files?: MediaManifest['files']) {
  const prefix = mediaObjectPrefix(job.id, job.attempt_id);
  const manifest: MediaManifest = {
    version: MEDIA_VERSION,
    jobId: job.id,
    attemptId: job.attempt_id,
    operation: job.operation,
    profile: MEDIA_PROFILE,
    files: files ?? [
      {
        ...put(prefix + 'result.mp4', 'result bytes'),
        name: 'result.mp4',
        role: 'primary',
        contentType: 'video/mp4',
      },
    ],
    data: { trimmed: true },
  };
  const reference = put(prefix + 'manifest.json', JSON.stringify(manifest));
  const { stage: _stage, progress: _progress, ...base } = running(job);
  void _stage;
  void _progress;
  const event: Extract<MediaResult, { state: 'succeeded' }> = {
    ...base,
    state: 'succeeded',
    manifest: reference,
  };
  return { event, manifest };
}
beforeAll(async () => {
  database = await authDatabase();
  observer = new Pool({ connectionString: database.url });
  await observer.query(assetSchemaSQL);
  await observer.query(computeSchemaSQL);
}, 45000);
afterAll(async () => {
  if (observer) await observer.end();
  if (database) await database.close();
}, 30000);
beforeEach(async () => {
  await observer.query(
    'TRUNCATE mio_media_inbox,mio_media_outbox,mio_media_retries,mio_media_controls,mio_media_files,mio_media_jobs,mio_assets CASCADE',
  );
  blobs.clear();
  metadata.clear();
  head.mockClear();
  read.mockClear();
  publish.mockReset();
  publish.mockResolvedValue();
  brokerClose.mockReset();
  brokerClose.mockResolvedValue();
  identity.mockClear();
  vi.spyOn(ComputeBroker, 'connect').mockImplementation(
    async () =>
      ({
        onClose: () => {},
        consumeMedia: async (fn: typeof receive, failed: () => void) => {
          receive = fn;
          brokerFailed = failed;
        },
        publishMedia: publish,
        close: brokerClose,
      }) as unknown as ComputeBroker,
  );
  assetId = randomUUID();
  key = `mio/raw/${assetId}/${randomUUID()}`;
  put(key, 'raw');
  await observer.query(
    "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at) VALUES($1,$2,'source.mp4','video/mp4',3,$3,$4,'ready',now()+interval '1 day')",
    [assetId, actor.userId, `mio/staging/${assetId}`, key],
  );
  store = new MediaStore(new Pool({ connectionString: database.url }));
  service = createMediaService(store, objects, config);
  server = createServer((request, response) => {
    void createMediaHandler(service, identity, [origin])(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing listener');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await service?.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  vi.restoreAllMocks();
});
it('serves owner scoped create/get/list, canonical idempotency and frozen snapshots through HTTP', async () => {
  const request = body();
  const response = await call('', request);
  expect(response.status).toBe(202);
  const created = (await response.json()) as { jobId: string; outputs: unknown[] };
  expect(created.outputs).toEqual([]);
  metadata.set(key, { size: 999, etag: 'mutated' });
  expect(
    (await call('', { ...request, parameters: { endSeconds: 2, startSeconds: 0 } })).status,
  ).toBe(200);
  expect(
    (await call('', { ...request, parameters: { startSeconds: 0, endSeconds: 3 } })).status,
  ).toBe(409);
  expect((await call('/' + created.jobId, undefined, 'other')).status).toBe(404);
  expect(await (await call('', undefined, 'other')).json()).toEqual({ jobs: [] });
  const fetched = await (await call('/' + created.jobId)).json();
  expect(fetched).toMatchObject({
    jobId: created.jobId,
    operation: 'video.trim',
    inputs: [{ assetId }],
  });
  expect(JSON.stringify(fetched)).not.toContain('mio/raw/');
  await vi.waitFor(() => expect(publish).toHaveBeenCalled());
  expect(publish.mock.calls[0]![0]).toMatchObject({
    inputs: [{ key, sizeBytes: 3, etag: expect.stringContaining('etag-') }],
  });
});
it('rejects invalid body, unauthorized assets, origins and methods before side effects', async () => {
  expect((await call('', body(), '')).status).toBe(401);
  expect((await call('', body(), 'other')).status).toBe(404);
  expect((await call('', { ...body(), owner: 'injected' })).status).toBe(400);
  expect(
    (await call('', { ...body(), parameters: { startSeconds: 0, endSeconds: 1, filter: 'evil' } }))
      .status,
  ).toBe(400);
  expect(
    (
      await call('', body(), 'owner', {
        headers: {
          origin: 'https://evil.invalid',
          'content-type': 'application/json',
          cookie: 'owner',
        },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('', body(), 'owner', {
        headers: { 'content-type': 'application/json', cookie: 'owner' },
      })
    ).status,
  ).toBe(403);
  expect((await call('', undefined, 'owner', { method: 'DELETE' })).status).toBe(405);
  expect((await call('?owner=other')).status).toBe(400);
  expect(
    (
      await call('', body(), 'owner', {
        headers: { origin, 'content-type': 'text/plain', cookie: 'owner' },
      })
    ).status,
  ).toBe(415);
  const preflight = await call('', undefined, 'owner', { method: 'OPTIONS' });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
  expect(await store.list(actor.userId)).toHaveLength(0);
  expect(publish).not.toHaveBeenCalled();
});

it('ends a legacy HEAD at the media deadline and preserves HTTP storage errors', async () => {
  head.mockRejectedValueOnce(new Error('fixture storage rejection'));
  const unavailable = await call('', body());
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({
    error: { code: 'COMPUTE_STORAGE_UNAVAILABLE' },
  });
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<{ size: number; etag: string }>();
  head.mockImplementationOnce(async (objectKey: string) => {
    expect(objectKey).toBe(key);
    started.resolve();
    return reply.promise;
  });
  const deadline = new AbortController();
  const normalTimeout = AbortSignal.timeout;
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation((ms) => (ms === 180_000 ? deadline.signal : normalTimeout(ms)));
  try {
    const finished = vi.fn((response: Response) => response);
    const response = call('', body()).then(finished);
    await started.promise;
    expect(timeout).toHaveBeenCalledWith(180_000);
    deadline.abort(new DOMException('fixture deadline', 'TimeoutError'));
    await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
    const rejected = await response;
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({ error: { code: 'COMPUTE_UNAVAILABLE' } });
    reply.resolve({ size: 3, etag: 'etag' });
    await reply.promise;
    expect((await observer.query('SELECT count(*) FROM mio_media_jobs')).rows[0].count).toBe('0');
    expect(publish).not.toHaveBeenCalled();
  } finally {
    reply.resolve({ size: 3, etag: 'etag' });
    timeout.mockRestore();
  }
});
it('rechecks the session after reading mutations and rejects oversized JSON', async () => {
  identity.mockResolvedValueOnce(actor).mockResolvedValueOnce(null);
  expect((await call('', body())).status).toBe(401);
  expect((await call('', { ...body(), padding: 'x'.repeat(256 * 1024) })).status).toBe(413);
  expect(await store.list(actor.userId)).toHaveLength(0);
});
it.each(['manifest', 'file'] as const)(
  'ACKs %s digest conflicts durably and recovers the original result on the same attempt',
  async (target) => {
    const job = await create();
    await receive(running(job));
    const success = output(job);
    const object = target === 'manifest' ? success.event.manifest : success.manifest.files[0]!;
    const original = metadata.get(object.key)!;
    metadata.set(object.key, { ...original, sha256: '0'.repeat(64) });
    await expect(receive(success.event)).resolves.toBeUndefined();
    const errorCode = target === 'manifest' ? 'MEDIA_MANIFEST_MISMATCH' : 'MEDIA_FILE_MISMATCH';
    expect(await store.ownerView(job.id, actor.userId)).toMatchObject({
      state: 'reconciling',
      error_code: errorCode,
      attempt_id: job.attempt_id,
      attempt: 1,
    });
    const fact = (
      await observer.query('SELECT payload FROM mio_media_inbox WHERE id=$1', [
        success.event.messageId,
      ])
    ).rows[0].payload;
    expect(fact).toEqual({ ...success.event, _verificationErrors: [errorCode] });
    expect((await store.ownerView(job.id, actor.userId))?.outputs).toHaveLength(0);
    expect((await call('/' + job.id + '/retry', { requestId: randomUUID() })).status).toBe(409);
    // A later worker failure cannot consume another attempt while publication is uncertain.
    const { stage: _stage, progress: _progress, ...base } = running(job);
    void _stage;
    void _progress;
    await receive({ ...base, state: 'failed', errorCode: 'WORKER_INTERRUPTED' });
    expect((await store.ownerView(job.id, actor.userId))?.state).toBe('reconciling');
    expect(await (await call('/' + job.id + '/recover', {})).json()).toMatchObject({
      status: 'reconciling',
    });
    await service.close();
    store = new MediaStore(new Pool({ connectionString: database.url }));
    service = createMediaService(store, objects, config);
    metadata.set(object.key, original);
    expect(await (await call('/' + job.id + '/recover', {})).json()).toMatchObject({
      status: 'succeeded',
      attempt: 1,
      data: { trimmed: true },
      outputs: [{ role: 'primary', name: 'result.mp4' }],
    });
    const calls = head.mock.calls.length;
    await receive(success.event);
    expect(head).toHaveBeenCalledTimes(calls);
    expect((await store.ownerView(job.id, actor.userId))?.outputs).toHaveLength(1);
    expect((await store.ownerView(job.id, actor.userId))?.attempt_id).toBe(job.attempt_id);
    expect(
      (
        await observer.query('SELECT payload FROM mio_media_inbox WHERE id=$1', [
          success.event.messageId,
        ])
      ).rows[0].payload,
    ).toEqual(fact);
  },
);
it.each(['manifest', 'file'] as const)(
  'rechecks a missing %s on each recover and succeeds when the object appears later',
  async (target) => {
    const job = await create(),
      success = output(job);
    const object = target === 'manifest' ? success.event.manifest : success.manifest.files[0]!;
    const original = metadata.get(object.key)!;
    metadata.delete(object.key);
    await expect(receive(success.event)).resolves.toBeUndefined();
    expect((await store.ownerView(job.id, actor.userId))?.state).toBe('reconciling');
    const before = head.mock.calls.length;
    expect(await (await call('/' + job.id + '/recover', {})).json()).toMatchObject({
      status: 'reconciling',
    });
    expect(head.mock.calls.length).toBeGreaterThan(before);
    const first = (
      await observer.query("SELECT message_id FROM mio_media_controls WHERE action='recover'")
    ).rows[0].message_id;
    await vi.waitFor(async () => {
      const outbox = await observer.query('SELECT sent_at FROM mio_media_outbox WHERE id=$1', [
        first,
      ]);
      expect(outbox.rows[0]?.sent_at).toBeInstanceOf(Date);
    });
    metadata.set(object.key, original);
    expect(await (await call('/' + job.id + '/recover', {})).json()).toMatchObject({
      status: 'succeeded',
      attempt: 1,
    });
    const second = (
      await observer.query("SELECT message_id FROM mio_media_controls WHERE action='recover'")
    ).rows[0].message_id;
    expect(second).not.toBe(first);
    const controls = (
      await observer.query(
        "SELECT id,command FROM mio_media_outbox WHERE command->>'action'='recover' ORDER BY created_at",
      )
    ).rows;
    expect(controls).toHaveLength(2);
    expect(new Set(controls.map((row) => row.id))).toEqual(new Set([first, second]));
    expect(controls.every((row) => row.command.attemptId === job.attempt_id)).toBe(true);
    await vi.waitFor(() =>
      expect(
        publish.mock.calls.filter(
          ([command]) => command.type === 'media.control' && command.action === 'recover',
        ),
      ).toHaveLength(2),
    );
    expect((await store.ownerView(job.id, actor.userId))?.attempt_id).toBe(job.attempt_id);
    expect((await store.ownerView(job.id, actor.userId))?.outputs).toHaveLength(1);
  },
);
it('rejects oversized envelopes and retains corrupt or excessive manifests for reconciliation', async () => {
  const job = await create();
  const success = output(job);
  await expect(
    receive({
      ...success.event,
      manifest: { ...success.event.manifest, sizeBytes: MEDIA_MAX_MANIFEST_BYTES + 1 },
    }),
  ).rejects.toMatchObject({ permanent: true });
  blobs.set(success.event.manifest.key, Buffer.alloc(success.event.manifest.sizeBytes));
  await expect(receive(success.event)).resolves.toBeUndefined();
  expect((await store.ownerView(job.id, actor.userId))?.error_code).toBe('MEDIA_MANIFEST_MISMATCH');
  put(
    success.event.manifest.key,
    JSON.stringify({
      ...success.manifest,
      files: Array.from({ length: 4097 }, () => success.manifest.files[0]),
    }),
  );
  const meta = metadata.get(success.event.manifest.key)!;
  await expect(
    receive({
      ...success.event,
      messageId: randomUUID(),
      manifest: {
        key: success.event.manifest.key,
        sizeBytes: meta.size,
        etag: meta.etag,
        sha256: meta.sha256!,
      },
    }),
  ).resolves.toBeUndefined();
  expect((await store.ownerView(job.id, actor.userId))?.state).toBe('reconciling');
  expect((await store.ownerView(job.id, actor.userId))?.outputs).toHaveLength(0);
});
it('exposes cancel/retry/recover with durable controls and a three-attempt limit', async () => {
  const job = await create();
  const { stage: _stage, progress: _progress, ...base } = running(job);
  void _stage;
  void _progress;
  await receive({ ...base, state: 'reconciling', errorCode: 'PROCESS_UNKNOWN' });
  expect((await call('/' + job.id + '/retry', { requestId: randomUUID() })).status).toBe(409);
  expect((await call('/' + job.id + '/recover', {})).status).toBe(200);
  expect((await call('/' + job.id + '/cancel', {})).status).toBe(200);
  const success = output(job);
  await receive(success.event);
  expect((await store.ownerView(job.id, actor.userId))?.state).toBe('cancelled');
  expect((await store.ownerView(job.id, actor.userId))?.outputs).toHaveLength(0);
  const next = await create();
  const { stage: _s, progress: _p, ...failedBase } = running(next);
  void _s;
  void _p;
  await receive({ ...failedBase, state: 'failed', errorCode: 'INPUT_INVALID' });
  const retryId = randomUUID();
  expect((await call('/' + next.id + '/retry', { requestId: retryId })).status).toBe(200);
  expect((await call('/' + next.id + '/retry', { requestId: retryId })).status).toBe(200);
  expect((await store.ownerView(next.id, actor.userId))?.attempt).toBe(2);
});
it('lets cancellation win while successful manifest verification is in flight', async () => {
  const job = await create(),
    success = output(job);
  let unblock!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const implementation = head.getMockImplementation()!;
  head.mockImplementationOnce(async (key) => {
    entered();
    await gate;
    return implementation(key);
  });
  const receiving = receive(success.event);
  await blocked;
  expect((await call('/' + job.id + '/cancel', {})).status).toBe(200);
  unblock();
  await receiving;
  expect((await store.ownerView(job.id, actor.userId))?.state).toBe('cancelled');
  expect((await store.ownerView(job.id, actor.userId))?.outputs).toHaveLength(0);
  expect((await observer.query('SELECT * FROM mio_media_inbox')).rows).toHaveLength(1);
});
it('retains outbox until publish confirm and drains admitted work before closing its pool', async () => {
  let confirm!: () => void;
  publish.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        confirm = resolve;
      }),
  );
  const job = await create();
  await vi.waitFor(() => expect(confirm).toBeTypeOf('function'));
  expect(
    (await observer.query('SELECT sent_at FROM mio_media_outbox WHERE job_id=$1', [job.id])).rows[0]
      .sent_at,
  ).toBeNull();
  const closing = service.close();
  await expect(service.get(actor, job.id)).rejects.toMatchObject({ code: 'COMPUTE_UNAVAILABLE' });
  confirm();
  await closing;
  expect(
    (await observer.query('SELECT sent_at FROM mio_media_outbox WHERE job_id=$1', [job.id])).rows[0]
      .sent_at,
  ).toBeInstanceOf(Date);
  expect(brokerClose).toHaveBeenCalled();
});
it('releases failed publish leases and retries the same stable message after reconnect', async () => {
  publish.mockRejectedValueOnce(new Error('confirm lost'));
  const job = await create();
  await vi.waitFor(
    async () => {
      expect(publish.mock.calls.length).toBeGreaterThanOrEqual(2);
      // publish resolves before store.sent commits; wait for the durable acknowledgement.
      const sent = (
        await observer.query(
          'SELECT id,sent_at,lease_id,lease_until FROM mio_media_outbox WHERE job_id=$1',
          [job.id],
        )
      ).rows[0];
      expect(sent).toMatchObject({
        id: publish.mock.calls[0]![0].messageId,
        sent_at: expect.any(Date),
        lease_id: null,
        lease_until: null,
      });
    },
    { timeout: 4000 },
  );
  expect(publish.mock.calls[1]![0].messageId).toBe(publish.mock.calls[0]![0].messageId);
  brokerFailed();
});

it('rejects malformed UTF-8 even when replacing it would leave valid JSON', async () => {
  const request = {
    ...body(),
    operation: 'audio.concat',
    parameters: {
      subtitles: [
        { inputIndex: 0, cues: [{ startSeconds: 0, endSeconds: 1, text: 'replace-me' }] },
      ],
    },
  };
  const encoded = Buffer.from(JSON.stringify(request));
  encoded[encoded.indexOf('replace-me')] = 0xff;
  const response = await call('', request, 'owner', { body: encoded });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'BODY_INVALID' } });
  expect(await store.list(actor.userId)).toEqual([]);
  expect(publish).not.toHaveBeenCalled();
});

it('rolls back admission when adding the frozen object keys and ETags would exceed 256 KiB', async () => {
  const ids = Array.from({ length: 64 }, () => randomUUID());
  const keys = ids.map((id) => `mio/raw/${id}/${randomUUID()}`);
  for (const objectKey of keys) metadata.set(objectKey, { size: 3, etag: 'a'.repeat(256) });
  await observer.query(
    `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,raw_key,state,expires_at)
     SELECT id,$1,'input.wav','audio/wav',3,key,'ready',now()
     FROM unnest($2::uuid[],$3::text[]) AS input(id,key)`,
    [actor.userId, ids, keys],
  );
  const request = {
    requestId: randomUUID(),
    operation: 'audio.concat',
    inputs: ids.map((id) => ({ assetId: id })),
    parameters: {
      subtitles: [
        {
          inputIndex: 0,
          cues: Array.from({ length: 60 }, (_, i) => ({
            startSeconds: i,
            endSeconds: i + 0.75,
            text: 'x'.repeat(4096),
          })),
        },
      ],
    },
  };
  expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(256 * 1024);
  const response = await call('', request);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'MEDIA_INPUT_INVALID' } });
  expect(head).toHaveBeenCalledTimes(64);
  const persisted = await observer.query('SELECT id FROM mio_media_outbox');
  expect(persisted.rows).toEqual([]);
  expect(await store.list(actor.userId)).toEqual([]);
});

it('cancels a completed worker attempt whose manifest is awaiting A verification', async () => {
  const job = await create();
  const success = output(job);
  const bytes = blobs.get(success.event.manifest.key)!;
  blobs.set(success.event.manifest.key, Buffer.alloc(bytes.length));
  await receive(success.event);
  expect(await store.ownerView(job.id, actor.userId)).toMatchObject({
    state: 'reconciling',
    error_code: 'MEDIA_MANIFEST_MISMATCH',
    outputs: [],
  });
  const path = '/' + job.id;
  const cancelled = await call(path + '/cancel', {});
  expect(await cancelled.json()).toMatchObject({
    status: 'cancelled',
    attempt: 1,
    cancelRequested: true,
    outputs: [],
  });
  blobs.set(success.event.manifest.key, bytes);
  await receive(success.event);
  expect(await (await call(path + '/recover', {})).json()).toMatchObject({
    status: 'cancelled',
    attempt: 1,
    outputs: [],
  });
  expect((await observer.query('SELECT id FROM mio_assets')).rows).toHaveLength(1);
  expect(
    (await observer.query("SELECT id FROM mio_media_outbox WHERE command->>'type'='media.request'"))
      .rows,
  ).toHaveLength(1);
});

it('applies the three-attempt bound across a manual retry and automatic retry', async () => {
  const first = await create();
  const report = async (
    job: MediaJobRow,
    errorCode: 'INPUT_CHANGED' | 'STORAGE_FAILURE' | 'EXECUTION_TIMEOUT',
  ) => {
    const { stage: _stage, progress: _progress, ...envelope } = running(job);
    void _stage;
    void _progress;
    await receive({ ...envelope, state: 'failed', errorCode });
  };
  await report(first, 'INPUT_CHANGED');
  expect((await store.ownerView(first.id, actor.userId))?.attempt).toBe(1);
  const retryId = randomUUID();
  expect((await call('/' + first.id + '/retry', { requestId: retryId })).status).toBe(200);
  const second = (await store.ownerView(first.id, actor.userId))!;
  expect(second.attempt).toBe(2);
  await report(second, 'STORAGE_FAILURE');
  const third = (await store.ownerView(first.id, actor.userId))!;
  expect(third.attempt).toBe(3);
  expect(third.inputs).toEqual(first.inputs);
  expect(third.parameters).toEqual(first.parameters);
  await report(third, 'EXECUTION_TIMEOUT');
  expect(await store.ownerView(first.id, actor.userId)).toMatchObject({
    state: 'failed',
    attempt: 3,
    error_code: 'EXECUTION_TIMEOUT',
  });
  expect((await call('/' + first.id + '/retry', { requestId: randomUUID() })).status).toBe(409);
  const original = await call('/' + first.id + '/retry', { requestId: retryId });
  expect(original.status).toBe(200);
  const commands = (
    await observer.query<{ command: MediaCommand }>(
      "SELECT command FROM mio_media_outbox WHERE command->>'type'='media.request' ORDER BY created_at",
    )
  ).rows.map((row) => row.command);
  expect(commands.map((command) => command.attempt)).toEqual([1, 2, 3]);
  expect(
    commands.every((command) => JSON.stringify(command.inputs) === JSON.stringify(first.inputs)),
  ).toBe(true);
});

it('keeps output visibility consistent across a concurrent successful result and owner read', async () => {
  const job = await create();
  const manifest = output(job);
  const readStarted = Promise.withResolvers<void>();
  const readCanReturn = Promise.withResolvers<void>();
  const getView = store.ownerView.bind(store);
  vi.spyOn(store, 'ownerView').mockImplementationOnce(async (...args) => {
    const snapshot = await getView(...args);
    readStarted.resolve();
    await readCanReturn.promise;
    return snapshot;
  });
  const pendingRead = call('/' + job.id);
  await readStarted.promise;
  try {
    await receive(manifest.event);
    const list = (await (await call('')).json()) as {
      jobs: { status: string; outputs: unknown[] }[];
    };
    expect(list.jobs[0]).toMatchObject({ status: 'succeeded', outputs: [{ name: 'result.mp4' }] });
  } finally {
    readCanReturn.resolve();
  }
  const oldView = (await (await pendingRead).json()) as { status: string; outputs: unknown[] };
  expect(oldView.status).not.toBe('succeeded');
  expect(oldView.outputs).toEqual([]);
});
