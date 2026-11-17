import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { paths } from '../src/adapters/media.ts';

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

it('allocates a new UUID image key for every materialization and never sends overwrite headers', async () => {
  const encoded = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=16x16',
      '-frames:v',
      '1',
      '-c:v',
      'png',
      '-f',
      'image2pipe',
      'pipe:1',
    ],
    { timeout: 10000, maxBuffer: 1024 * 1024 },
  );
  expect(encoded.status).toBe(0);
  const bytes = encoded.stdout;
  const putObject = vi.fn(async (params: Record<string, unknown>) => ({
    ETag: `"${String(params.Key).slice(-8)}"`,
  }));
  const headObject = vi.fn(async (params: Record<string, unknown>) => ({
    ETag: `"${String(params.Key).slice(-8)}"`,
    headers: {
      'content-length': String(bytes.length),
      'x-cos-meta-sha256': createHash('sha256').update(bytes).digest('hex'),
    },
  }));
  const getObjectStream = vi.fn(() => Readable.from(bytes));
  vi.doMock('cos-nodejs-sdk-v5', () => ({
    default: class {
      putObject = putObject;
      headObject = headObject;
      getObjectStream = getObjectStream;
    },
  }));
  const { ObjectStore } = await import('../src/adapters/cos.ts');
  const store = new ObjectStore({
    bucket: 'test',
    region: 'test',
    secretId: 'id',
    secretKey: 'key',
  });
  const jobId = randomUUID();
  const first = await store.image(jobId, 0, bytes.toString('base64'), 'png', randomUUID());
  const second = await store.image(jobId, 0, bytes.toString('base64'), 'png', randomUUID());
  expect(first.key).toMatch(new RegExp(`^mio/derived/${jobId}/images/0-[0-9a-f-]{36}\\.png$`));
  expect(second.key).toMatch(new RegExp(`^mio/derived/${jobId}/images/0-[0-9a-f-]{36}\\.png$`));
  expect(first.key).not.toBe(second.key);
  expect(putObject).toHaveBeenCalledTimes(2);
  for (const call of putObject.mock.calls) {
    const params = call[0]!;
    expect(params.Body).toBeInstanceOf(Readable);
    expect(params.Headers).toMatchObject({
      'x-cos-forbid-overwrite': 'true',
      'Content-MD5': createHash('md5').update(bytes).digest('base64'),
    });
  }
  expect(headObject).toHaveBeenCalledTimes(2);
  expect(getObjectStream).not.toHaveBeenCalled();
});

function encodedImage(codec: 'png' | 'mjpeg' | 'libwebp'): Buffer {
  const encoded = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=16x16',
      '-frames:v',
      '1',
      '-c:v',
      codec,
      '-f',
      'image2pipe',
      'pipe:1',
    ],
    { timeout: 10000, maxBuffer: 1024 * 1024 },
  );
  expect(encoded.status).toBe(0);
  expect(encoded.stdout.length).toBeGreaterThan(0);
  return encoded.stdout;
}

async function createImageStore(
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

it.each([
  ['png', 'png'],
  ['jpeg', 'mjpeg'],
  ['webp', 'libwebp'],
] as const)(
  'uploads validated %s with an opaque matching ETag and no GET',
  async (format, codec) => {
    const bytes = encodedImage(codec);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const md5 = createHash('md5').update(bytes).digest('base64');
    const putObject = vi.fn(async (params: Record<string, unknown>) => {
      const chunks: Buffer[] = [];
      for await (const chunk of params.Body as Readable) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(bytes);
      return { ETag: '"opaque-object-identifier"' };
    });
    const headObject = vi.fn(async () => ({
      ETag: '"opaque-object-identifier"',
      headers: { 'content-length': String(bytes.length), 'x-cos-meta-sha256': sha256 },
    }));
    const getObjectStream = vi.fn(() => Readable.from(bytes));
    const store = await createImageStore(putObject, headObject, getObjectStream);
    const jobId = randomUUID();
    const fileId = randomUUID();
    const result = await store.image(jobId, 0, bytes.toString('base64'), format, fileId);
    expect(result).toEqual({
      key: 'mio/derived/' + jobId + '/images/0-' + fileId + '.' + format,
      sizeBytes: bytes.length,
      sha256,
      etag: '"opaque-object-identifier"',
      contentType: 'image/' + format,
    });
    expect(putObject).toHaveBeenCalledOnce();
    expect(putObject.mock.calls[0]![0]).toMatchObject({
      Key: result.key,
      ContentLength: bytes.length,
      ContentType: 'image/' + format,
      'x-cos-meta-sha256': sha256,
      Headers: { 'x-cos-forbid-overwrite': 'true', 'Content-MD5': md5 },
    });
    expect(headObject).toHaveBeenCalledOnce();
    expect(getObjectStream).not.toHaveBeenCalled();
  },
);

it('rejects invalid image bytes before PUT', async () => {
  const putObject = vi.fn(async () => ({ ETag: '"opaque"' }));
  const headObject = vi.fn(async () => ({}));
  const getObjectStream = vi.fn(() => Readable.from([]));
  const store = await createImageStore(putObject, headObject, getObjectStream);
  const jobId = randomUUID();
  await expect(
    store.image(jobId, 0, Buffer.from('not an image').toString('base64'), 'png', randomUUID()),
  ).rejects.toThrow('IMAGE_OUTPUT_INVALID');
  const truncated = Buffer.from('89504e470d0a1a0a', 'hex');
  await expect(
    store.image(jobId, 0, truncated.toString('base64'), 'png', randomUUID()),
  ).rejects.toThrow();
  expect(putObject).not.toHaveBeenCalled();
  expect(headObject).not.toHaveBeenCalled();
  expect(getObjectStream).not.toHaveBeenCalled();
});

it.each([
  'put-fails',
  'put-no-etag',
  'head-missing',
  'head-size',
  'head-sha',
  'head-no-sha',
  'head-etag',
  'head-no-etag',
])('does not publish an image when %s', async (failure) => {
  const bytes = encodedImage('png');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const putObject = vi.fn(async () => {
    if (failure === 'put-fails') throw new Error('PUT_FAILED');
    return failure === 'put-no-etag' ? {} : { ETag: '"put-identifier"' };
  });
  const headObject = vi.fn(async () => {
    if (failure === 'head-missing')
      throw Object.assign(new Error('NOT_FOUND'), { statusCode: 404 });
    return {
      ETag:
        failure === 'head-no-etag'
          ? undefined
          : failure === 'head-etag'
            ? '"other"'
            : '"put-identifier"',
      headers: {
        'content-length': String(bytes.length + (failure === 'head-size' ? 1 : 0)),
        'x-cos-meta-sha256':
          failure === 'head-no-sha' ? undefined : failure === 'head-sha' ? 'a'.repeat(64) : sha256,
      },
    };
  });
  const getObjectStream = vi.fn(() => Readable.from(bytes));
  const store = await createImageStore(putObject, headObject, getObjectStream);
  await expect(
    store.image(randomUUID(), 0, bytes.toString('base64'), 'png', randomUUID()),
  ).rejects.toThrow();
  expect(putObject).toHaveBeenCalledOnce();
  if (failure.startsWith('put-')) expect(headObject).not.toHaveBeenCalled();
  else expect(headObject).toHaveBeenCalledOnce();
  expect(getObjectStream).not.toHaveBeenCalled();
});

it('keeps a timed-out image PUT pending and uses a fresh key for the next materialization', async () => {
  const bytes = encodedImage('png');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let finish: (value: object) => void = () => {};
  const firstPut = new Promise<object>((resolve) => {
    finish = resolve;
  });
  const putObject = vi.fn((params: Record<string, unknown>) =>
    putObject.mock.calls.length === 1
      ? firstPut
      : Promise.resolve({ ETag: '"' + String(params.Key) + '"' }),
  );
  const headObject = vi.fn(async (params: Record<string, unknown>) => ({
    ETag: '"' + String(params.Key) + '"',
    headers: { 'content-length': String(bytes.length), 'x-cos-meta-sha256': sha256 },
  }));
  const getObjectStream = vi.fn(() => Readable.from(bytes));
  const store = await createImageStore(putObject, headObject, getObjectStream);
  const jobId = randomUUID();
  const stop = new AbortController();
  const first = store.image(jobId, 0, bytes.toString('base64'), 'png', randomUUID(), stop.signal);
  await vi.waitFor(() => expect(putObject).toHaveBeenCalledOnce());
  const firstKey = String(putObject.mock.calls[0]![0].Key);
  stop.abort();
  await expect(first).rejects.toThrow('EXECUTION_TIMEOUT');
  const headStop = new AbortController();
  const blockedHead = store.head(firstKey, headStop.signal);
  headStop.abort();
  await expect(blockedHead).rejects.toThrow('EXECUTION_TIMEOUT');
  expect(headObject).not.toHaveBeenCalled();
  const second = await store.image(jobId, 0, bytes.toString('base64'), 'png', randomUUID());
  expect(second.key).not.toBe(firstKey);
  expect(putObject).toHaveBeenCalledTimes(2);
  const laterHead = store.head(firstKey, AbortSignal.timeout(5000));
  expect(headObject).toHaveBeenCalledOnce();
  finish({ ETag: '"' + firstKey + '"' });
  await expect(laterHead).resolves.toMatchObject({ etag: '"' + firstKey + '"', sha256 });
  expect(headObject).toHaveBeenCalledTimes(2);
  expect(getObjectStream).not.toHaveBeenCalled();
});

it('continues to hash the full downloaded content for video recovery verification', async () => {
  const expected = Buffer.from('expected-video-bytes');
  const sha256 = createHash('sha256').update(expected).digest('hex');
  const getObjectStream = vi
    .fn()
    .mockReturnValueOnce(Readable.from(expected))
    .mockReturnValueOnce(Readable.from(Buffer.alloc(expected.length)));
  const store = await createImageStore(
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
