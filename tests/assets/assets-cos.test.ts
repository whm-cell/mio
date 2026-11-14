import COS from 'cos-nodejs-sdk-v5';
import { expect, it, vi } from 'vitest';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { readAssetConfig } from '../../src/assets/config.ts';

it('uses a supplied temporary session token in signed URLs without changing long-term key support', () => {
  const token = 'synthetic+token=/&%#?';
  const getObjectUrl = vi.spyOn(COS.prototype, 'getObjectUrl');
  const env = {
    MIO_ASSETS_DATABASE_URL: 'postgresql://example.invalid/media',
    MIO_COS_BUCKET: 'mio-test-1234567890',
    MIO_COS_REGION: 'ap-shanghai',
    MIO_COS_SECRET_ID: 'synthetic-id',
    MIO_COS_SECRET_KEY: 'synthetic-key',
    MIO_COS_SESSION_TOKEN: token,
  };
  try {
    const config = readAssetConfig(env)!;
    const storage = createCosStorage(config);
    const download = storage.downloadUrl('mio/raw/example/attempt');
    const downloadOriginal = getObjectUrl.mock.results.at(-1)!.value as string;
    const url = new URL(download);
    expect(url.searchParams.get('x-cos-security-token')).toBe(token);
    expect(download).toBe(
      downloadOriginal.replace(
        `&x-cos-security-token=${token}`,
        `&x-cos-security-token=${encodeURIComponent(token)}`,
      ),
    );
    const upload = storage.uploadUrl('mio/staging/example', 123);
    const uploadOriginal = getObjectUrl.mock.results.at(-1)!.value as string;
    expect(new URL(upload).searchParams.get('x-cos-security-token')).toBe(token);
    expect(upload).toBe(
      uploadOriginal.replace(
        `&x-cos-security-token=${token}`,
        `&x-cos-security-token=${encodeURIComponent(token)}`,
      ),
    );
    expect(url.searchParams.get('q-signature')).toBeTruthy();
    expect(url.searchParams.get('q-sign-time')).toMatch(/^\d+;\d+$/);
    const [start, end] = url.searchParams.get('q-sign-time')!.split(';').map(Number);
    expect(end! - start!).toBe(300);
    expect(() => readAssetConfig({ ...env, MIO_COS_SESSION_TOKEN: '' })).toThrow('ASSET_CONFIG');
    expect(
      readAssetConfig({ ...env, MIO_COS_SESSION_TOKEN: undefined })?.sessionToken,
    ).toBeUndefined();
    getObjectUrl.mockReturnValue('https://example.invalid/?q-signature=example');
    expect(() => storage.downloadUrl('mio/raw/example/attempt')).toThrow(
      'COS_SIGNED_URL_TOKEN_MISSING',
    );
  } finally {
    getObjectUrl.mockRestore();
  }
});

it('uses the official SDK to bind PUT length and host and signs a private attachment download', () => {
  const storage = createCosStorage({
    databaseURL: 'postgresql://example.invalid/media',
    bucket: 'mio-test-1234567890',
    region: 'ap-shanghai',
    secretId: 'example-id',
    secretKey: 'example-key',
  });
  const upload = new URL(storage.uploadUrl('mio/staging/example', 123));
  expect(upload.protocol).toBe('https:');
  expect(upload.searchParams.get('q-header-list')).toBe('content-length;host');
  expect(upload.searchParams.get('q-sign-time')).toMatch(/^\d+;\d+$/);
  const download = new URL(storage.downloadUrl('mio/raw/example/attempt'));
  expect(download.protocol).toBe('https:');
  expect(download.searchParams.get('response-content-disposition')).toBe('attachment');
  expect(download.searchParams.get('q-signature')).toBeTruthy();
});

it('passes conditional copy and non-overwrite headers to the official SDK', async () => {
  const copy = vi.spyOn(COS.prototype, 'putObjectCopy').mockResolvedValue({
    ETag: 'etag',
    CRC64: '',
    LastModified: '',
    VersionId: '',
    Location: '',
  });
  const head = vi.spyOn(COS.prototype, 'headObject').mockResolvedValue({
    ETag: 'etag',
    headers: { 'content-length': '17' },
  });
  try {
    const storage = createCosStorage({
      databaseURL: 'postgresql://example.invalid/media',
      bucket: 'mio-test-1234567890',
      region: 'ap-shanghai',
      secretId: 'example-id',
      secretKey: 'example-key',
    });
    expect(await storage.head('mio/staging/source')).toEqual({ etag: 'etag', size: 17 });
    await storage.copy('mio/staging/source', 'mio/raw/destination', 'etag');
    expect(copy).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'mio-test-1234567890',
        Region: 'ap-shanghai',
        Key: 'mio/raw/destination',
        CopySource: 'mio-test-1234567890.cos.ap-shanghai.myqcloud.com/mio%2Fstaging%2Fsource',
        CopySourceIfMatch: 'etag',
        MetadataDirective: 'Replaced',
        Headers: { 'x-cos-forbid-overwrite': 'true' },
      }),
    );
  } finally {
    copy.mockRestore();
    head.mockRestore();
  }
});
