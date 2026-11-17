import { createHash, randomUUID } from 'node:crypto';
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
