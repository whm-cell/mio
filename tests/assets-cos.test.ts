import COS from 'cos-nodejs-sdk-v5';
import { expect, it, vi } from 'vitest';
import { createCosStorage } from '../src/integrations/cos.ts';

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
