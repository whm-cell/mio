import COS from 'cos-nodejs-sdk-v5';
import type { AssetConfig } from '../assets/config.ts';
import type { AssetObjectStore } from '../assets/contracts.ts';

/** Server-side credentials are scoped to this private bucket and are never returned to clients. */
export function createCosStorage(config: AssetConfig): AssetObjectStore {
  const { bucket: Bucket, region: Region } = config;
  const cos = new COS({
    SecretId: config.secretId,
    SecretKey: config.secretKey,
    Protocol: 'https:',
    Timeout: 60_000,
    FollowRedirect: false,
  });
  return {
    uploadUrl(Key, size) {
      return cos.getObjectUrl({
        Bucket,
        Region,
        Key,
        Method: 'PUT',
        Expires: 300,
        Headers: { 'content-length': String(size) },
      });
    },
    downloadUrl(Key) {
      return cos.getObjectUrl({
        Bucket,
        Region,
        Key,
        Method: 'GET',
        Expires: 300,
        Query: { 'response-content-disposition': 'attachment' },
      });
    },
    async head(Key) {
      const object = await cos.headObject({ Bucket, Region, Key });
      const size = Number(object.headers?.['content-length']);
      if (!Number.isSafeInteger(size) || size < 0 || !object.ETag)
        throw new Error('COS_INVALID_HEAD');
      const sha256 = object.headers?.['x-cos-meta-sha256'];
      return { size, etag: object.ETag, ...(typeof sha256 === 'string' ? { sha256 } : {}) };
    },
    async copy(source, target, etag) {
      await cos.putObjectCopy({
        Bucket,
        Region,
        Key: target,
        CopySource: `${Bucket}.cos.${Region}.myqcloud.com/${encodeURIComponent(source)}`,
        CopySourceIfMatch: etag,
        MetadataDirective: 'Replaced',
        ContentType: 'application/octet-stream',
        Headers: { 'x-cos-forbid-overwrite': 'true' },
      });
    },
    async delete(Key) {
      await cos.deleteObject({ Bucket, Region, Key });
    },
  };
}
