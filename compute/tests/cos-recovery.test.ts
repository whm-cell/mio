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
    expect(params.Headers).toMatchObject({ 'x-cos-forbid-overwrite': 'true' });
  }
  expect(headObject).toHaveBeenCalledTimes(2);
  expect(getObjectStream).toHaveBeenCalledTimes(2);
});
