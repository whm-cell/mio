import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { paths } from '../src/adapters/media.ts';

const directories: string[] = [];
afterEach(() => {
  vi.doUnmock('cos-nodejs-sdk-v5');
  vi.resetModules();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
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
