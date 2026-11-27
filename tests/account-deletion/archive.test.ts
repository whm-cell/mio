import COS from 'cos-nodejs-sdk-v5';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createCosStorage } from '../../src/integrations/cos.ts';

it('archives only the minimal private non-overwritten tombstone and lists external facts independently of PG snapshots', async () => {
  const stored = new Map<string, { bytes: Buffer; sha256: string; acl: string }>();
  const put = vi.spyOn(COS.prototype, 'putObject').mockImplementation(async (params) => {
    expect(params.Headers).toMatchObject({ 'x-cos-forbid-overwrite': 'true' });
    expect(params.ACL).toBe('private');
    const parts: Buffer[] = [];
    for await (const part of params.Body as Readable) parts.push(Buffer.from(part));
    stored.set(params.Key, {
      bytes: Buffer.concat(parts),
      sha256: String(params['x-cos-meta-sha256']),
      acl: params.ACL!,
    });
    return { ETag: '"audit"', Location: 'fixture.invalid', statusCode: 200, headers: {} };
  });
  const head = vi.spyOn(COS.prototype, 'headObject').mockImplementation(async (params) => {
    const value = stored.get(params.Key);
    if (!value) throw Object.assign(new Error('absent'), { statusCode: 404 });
    return {
      ETag: '"audit"',
      statusCode: 200,
      headers: { 'content-length': String(value.bytes.length), 'x-cos-meta-sha256': value.sha256 },
    };
  });
  const get = vi.spyOn(COS.prototype, 'getObject').mockImplementation(((
    params: { Key: string; Output: Writable },
    callback: (error: null, result: { statusCode: number }) => void,
  ) => {
    const value = stored.get(params.Key)!;
    params.Output.end(value.bytes);
    callback(null, { statusCode: 200 });
  }) as unknown as typeof COS.prototype.getObject);
  const acl = vi.spyOn(COS.prototype, 'getObjectAcl').mockImplementation(
    async (params) =>
      ({
        ACL: stored.get(params.Key)!.acl,
        statusCode: 200,
        headers: {},
      }) as COS.GetObjectAclResult,
  );
  const list = vi.spyOn(COS.prototype, 'getBucket').mockImplementation(
    async () =>
      ({
        IsTruncated: 'false',
        Contents: [...stored.keys()].map((Key) => ({ Key })),
      }) as COS.GetBucketResult,
  );
  try {
    const objects = createCosStorage({
      databaseURL: 'postgresql://unused.invalid/test',
      bucket: 'fixture-1234567890',
      region: 'ap-shanghai',
      secretId: 'synthetic',
      secretKey: 'synthetic',
    });
    const tombstone = { userId: randomUUID(), finalizedAt: new Date().toISOString() },
      signal = AbortSignal.timeout(5000);
    await objects.archiveAccountDeletion!(tombstone, signal);
    await objects.archiveAccountDeletion!(tombstone, signal);
    expect(put).toHaveBeenCalledOnce();
    expect(objects.hasPendingWrites!(put.mock.calls[0]![0].Key)).toBe(false);
    expect(JSON.parse([...stored.values()][0]!.bytes.toString())).toEqual(tombstone);
    const seen = [];
    for await (const value of objects.accountDeletionTombstones!(signal)) seen.push(value);
    expect(seen).toEqual([tombstone]);
    expect(list.mock.calls[0]![0]).toMatchObject({
      Prefix: 'mio/audit/account-deletions/',
      MaxKeys: 100,
    });
    stored.values().next().value!.acl = 'public-read';
    await expect(objects.archiveAccountDeletion!(tombstone, signal)).rejects.toThrow(
      'ACCOUNT_TOMBSTONE_UNCONFIRMED',
    );
    expect(put).toHaveBeenCalledOnce();
  } finally {
    put.mockRestore();
    head.mockRestore();
    get.mockRestore();
    acl.mockRestore();
    list.mockRestore();
  }
});
