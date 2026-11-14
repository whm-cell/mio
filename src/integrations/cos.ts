import COS from 'cos-nodejs-sdk-v5';
import type { AssetConfig } from '../assets/config.ts';
import type { AssetObjectStore } from '../assets/contracts.ts';

/** Server-side credentials are scoped to this private bucket and are never returned to clients. */
export function createCosStorage(config: AssetConfig): AssetObjectStore {
  const { bucket: Bucket, region: Region } = config;
  const cos = new COS({
    SecretId: config.secretId,
    SecretKey: config.secretKey,
    ...(config.sessionToken ? { SecurityToken: config.sessionToken } : {}),
    Protocol: 'https:',
    Timeout: 60_000,
    FollowRedirect: false,
  });
  // This SDK appends the session token after signing without URL-encoding it.
  // Encode only that parameter; the signed query and the token used by SDK requests stay intact.
  const encodeUrlToken = (url: string) => {
    const token = config.sessionToken;
    if (!token) return url;
    const rawToken = `&x-cos-security-token=${token}`;
    if (!url.includes(rawToken)) throw new Error('COS_SIGNED_URL_TOKEN_MISSING');
    return url.replace(rawToken, () => `&x-cos-security-token=${encodeURIComponent(token)}`);
  };
  return {
    uploadUrl(Key, size) {
      return encodeUrlToken(
        cos.getObjectUrl({
          Bucket,
          Region,
          Key,
          Method: 'PUT',
          Expires: 300,
          Headers: { 'content-length': String(size) },
        }),
      );
    },
    downloadUrl(Key) {
      return encodeUrlToken(
        cos.getObjectUrl({
          Bucket,
          Region,
          Key,
          Method: 'GET',
          Expires: 300,
          Query: { 'response-content-disposition': 'attachment' },
        }),
      );
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
