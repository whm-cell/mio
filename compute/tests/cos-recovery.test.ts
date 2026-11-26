import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { paths, probePath } from '../src/adapters/media.ts';

const directories: string[] = [];
afterEach(() => {
  vi.doUnmock('cos-nodejs-sdk-v5');
  vi.resetModules();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('passes temporary session credentials to the B COS SDK client', async () => {
  const constructor = vi.fn();
  vi.doMock('cos-nodejs-sdk-v5', () => ({
    default: class {
      constructor(options: unknown) {
        constructor(options);
      }
    },
  }));
  const { ObjectStore } = await import('../src/adapters/cos.ts');
  new ObjectStore({
    bucket: 'test',
    region: 'test',
    secretId: 'id',
    secretKey: 'key',
    sessionToken: 'synthetic-token',
  });
  expect(constructor).toHaveBeenCalledWith(
    expect.objectContaining({ SecurityToken: 'synthetic-token', SecretId: 'id', SecretKey: 'key' }),
  );
});

it('does not treat a timed-out PUT as cancelled or start a same-key HEAD while it remains unresolved', async () => {
  let finish: (value: object) => void = () => {};
  const remote = new Promise<object>((resolve) => {
    finish = resolve;
  });
  const putObject = vi.fn(() => remote);
  const headObject = vi.fn(async () => ({
    ETag: '"object"',
    headers: { 'content-length': '1', 'x-cos-meta-sha256': 'a'.repeat(64) },
  }));
  vi.doMock('cos-nodejs-sdk-v5', () => ({
    default: class {
      putObject = putObject;
      headObject = headObject;
    },
  }));
  const { ObjectStore } = await import('../src/adapters/cos.ts');
  const root = mkdtempSync(join(tmpdir(), 'mio-pending-put-'));
  directories.push(root);
  const attemptId = randomUUID();
  const bytes = Buffer.from('x');
  writeFileSync(paths(root, attemptId).output, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const store = new ObjectStore({
    bucket: 'test',
    region: 'test',
    secretId: 'test',
    secretKey: 'test',
  });
  const key = `mio/derived/${randomUUID()}/${attemptId}/result.mp4`;
  const uploadAbort = new AbortController();
  const upload = store.upload(key, root, attemptId, bytes.length, sha256, uploadAbort.signal);
  await vi.waitFor(() => expect(putObject).toHaveBeenCalledOnce());
  uploadAbort.abort();
  await expect(upload).rejects.toThrow('EXECUTION_TIMEOUT');
  const headAbort = new AbortController();
  const blockedHead = store.head(key, headAbort.signal);
  headAbort.abort();
  await expect(blockedHead).rejects.toThrow('EXECUTION_TIMEOUT');
  expect(headObject).not.toHaveBeenCalled();
  const afterSettlement = store.head(key, AbortSignal.timeout(5000));
  expect(headObject).not.toHaveBeenCalled();
  finish({});
  await expect(afterSettlement).resolves.toMatchObject({ sizeBytes: 1, etag: '"object"' });
  expect(headObject).toHaveBeenCalledOnce();
  expect(putObject).toHaveBeenCalledOnce();
});

async function createObjectStore(
  putObject: (params: Record<string, unknown>) => Promise<object>,
  headObject: (params: Record<string, unknown>) => Promise<object>,
  getObjectStream: () => Readable,
) {
  vi.doMock('cos-nodejs-sdk-v5', () => ({
    default: class {
      putObject = putObject;
      headObject = headObject;
      getObjectStream = getObjectStream;
    },
  }));
  const { ObjectStore } = await import('../src/adapters/cos.ts');
  return new ObjectStore({ bucket: 'test', region: 'test', secretId: 'id', secretKey: 'key' });
}

it('continues to hash the full downloaded content for video recovery verification', async () => {
  const expected = Buffer.from('expected-video-bytes');
  const sha256 = createHash('sha256').update(expected).digest('hex');
  const getObjectStream = vi
    .fn()
    .mockReturnValueOnce(Readable.from(expected))
    .mockReturnValueOnce(Readable.from(Buffer.alloc(expected.length)));
  const store = await createObjectStore(
    async () => ({}),
    async () => ({}),
    getObjectStream,
  );
  await expect(
    store.verify('video-key', expected.length, sha256, AbortSignal.timeout(5000)),
  ).resolves.toBe(true);
  await expect(
    store.verify('video-key', expected.length, sha256, AbortSignal.timeout(5000)),
  ).resolves.toBe(false);
  expect(getObjectStream).toHaveBeenCalledTimes(2);
});

it('downloads a private probe source conditionally and verifies the streamed bytes and digest', async () => {
  const bytes = Buffer.from('private-video-probe-source');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const jobId = randomUUID();
  const outputIndex = 0;
  const attemptId = randomUUID();
  const messageId = randomUUID();
  const command = {
    version: 1 as const,
    type: 'video.probe' as const,
    messageId,
    jobId,
    outputIndex,
    attemptId,
    attempt: 1 as const,
    source: {
      stagingKey: `mio/staging/video/${jobId}/${outputIndex}/${attemptId}.media`,
      sizeBytes: bytes.length,
      etag: '"staging-etag"',
      sha256,
    },
  };
  const headObject = vi.fn(async () => ({
    ETag: command.source.etag,
    headers: {
      'content-length': String(bytes.length),
      'x-cos-meta-sha256': sha256,
    },
  }));
  const getObjectStream = vi.fn(() => Readable.from(bytes));
  const store = await createObjectStore(async () => ({}), headObject, getObjectStream);
  const root = mkdtempSync(join(tmpdir(), 'mio-video-probe-cos-'));
  directories.push(root);
  const path = await store.downloadVideoProbe(command, root, AbortSignal.timeout(5000));
  expect(path).toBe(probePath(root, messageId));
  expect(readFileSync(path)).toEqual(bytes);
  expect(headObject).toHaveBeenCalledWith(
    expect.objectContaining({ Key: command.source.stagingKey }),
  );
  expect(getObjectStream).toHaveBeenCalledWith(
    expect.objectContaining({ Key: command.source.stagingKey, IfMatch: command.source.etag }),
  );
  headObject.mockRejectedValueOnce(
    Object.assign(new Error('fixture missing object'), {
      statusCode: 404,
    }),
  );
  await expect(store.downloadVideoProbe(command, root, AbortSignal.timeout(5000))).rejects.toThrow(
    'SOURCE_CHANGED',
  );
  expect(getObjectStream).toHaveBeenCalledOnce();
});

it('rejects an ETag or streamed digest mismatch before returning a probe file', async () => {
  const expected = Buffer.from('expected-private-video');
  const changed = Buffer.from('mutated--private-video');
  const sha256 = createHash('sha256').update(expected).digest('hex');
  const jobId = randomUUID();
  const outputIndex = 0;
  const attemptId = randomUUID();
  const messageId = randomUUID();
  const command = {
    version: 1 as const,
    type: 'video.probe' as const,
    messageId,
    jobId,
    outputIndex,
    attemptId,
    attempt: 1 as const,
    source: {
      stagingKey: `mio/staging/video/${jobId}/${outputIndex}/${attemptId}.media`,
      sizeBytes: expected.length,
      etag: '"staging-etag"',
      sha256,
    },
  };
  const store = await createObjectStore(
    async () => ({}),
    async () => ({
      ETag: command.source.etag,
      headers: {
        'content-length': String(expected.length),
        'x-cos-meta-sha256': sha256,
      },
    }),
    () => Readable.from(changed),
  );
  const root = mkdtempSync(join(tmpdir(), 'mio-video-probe-cos-'));
  directories.push(root);
  await expect(store.downloadVideoProbe(command, root, AbortSignal.timeout(5000))).rejects.toThrow(
    'SOURCE_CHANGED',
  );
  expect(() => readFileSync(probePath(root, messageId))).toThrow();
});

it('sets private ACL and immutable checksums on both media outputs and the manifest PUT', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mio-media-put-'));
  directories.push(root);
  const attemptId = randomUUID();
  const { MediaFiles } = await import('../src/adapters/media-files.ts');
  const files = new MediaFiles(root, attemptId);
  const putObject = vi.fn(async (options: Record<string, unknown>) => {
    let length = 0;
    for await (const chunk of options.Body as Readable) length += (chunk as Buffer).length;
    expect(length).toBe(options.ContentLength);
    return {};
  });
  const store = await createObjectStore(
    putObject,
    async () => ({}),
    () => Readable.from([]),
  );
  const signal = AbortSignal.timeout(5000);
  for (const [name, mime] of [
    ['audio.wav', 'audio/wav'],
    ['manifest.json', 'application/json'],
  ]) {
    const body = Buffer.from(name!);
    await files.write(name!, body);
    const hash = createHash('sha256').update(body).digest('hex');
    const key = `mio/media/${randomUUID()}/${attemptId}/${name}`;
    await store.uploadMedia(key, files, name!, { size: body.length, sha256: hash }, mime!, signal);
    expect(putObject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        Key: key,
        ACL: 'private',
        ContentLength: body.length,
        ContentType: mime,
        'x-cos-meta-sha256': hash,
        Headers: {
          'x-cos-forbid-overwrite': 'true',
          'Content-MD5': createHash('md5').update(body).digest('base64'),
        },
      }),
    );
  }
  expect(putObject).toHaveBeenCalledTimes(2);
});

it.each([
  [412, undefined, 'INPUT_CHANGED'],
  [408, undefined, 'STORAGE_FAILURE'],
  [429, undefined, 'STORAGE_FAILURE'],
  [503, undefined, 'STORAGE_FAILURE'],
  [undefined, 'ECONNRESET', 'STORAGE_FAILURE'],
  [403, undefined, 'MEDIA_OBJECT_RESPONSE'],
  [404, undefined, 'MEDIA_OBJECT_RESPONSE'],
] as const)(
  'classifies a conditional media GET failure %s / %s as %s',
  async (statusCode, code, expected) => {
    const getObject = vi.fn((_options: unknown, callback: (error: object) => void) =>
      setImmediate(() => callback({ statusCode, code })),
    );
    vi.doMock('cos-nodejs-sdk-v5', () => ({
      default: class {
        getObject = getObject;
      },
    }));
    const { ObjectStore } = await import('../src/adapters/cos.ts');
    const { MediaFiles } = await import('../src/adapters/media-files.ts');
    const root = mkdtempSync(join(tmpdir(), 'mio-media-get-'));
    directories.push(root);
    const store = new ObjectStore({
      bucket: 'test',
      region: 'test',
      secretId: 'id',
      secretKey: 'key',
    });
    const assetId = randomUUID(),
      key = `mio/raw/${assetId}/${randomUUID()}`;
    await expect(
      store.downloadMedia(
        { assetId, key, sizeBytes: 1, etag: '"frozen"' },
        new MediaFiles(root, randomUUID()),
        'input-0',
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow(expected);
    expect(getObject).toHaveBeenCalledOnce();
    expect(getObject).toHaveBeenCalledWith(
      expect.objectContaining({ Key: key, IfMatch: '"frozen"' }),
      expect.any(Function),
    );
  },
);
