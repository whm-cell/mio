import COS from 'cos-nodejs-sdk-v5';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { readAssetConfig } from '../../src/assets/config.ts';
import { createAssetService } from '../../src/assets/service.ts';
import type { AssetStore } from '../../src/assets/store.ts';

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

it('aborts the SDK sender on oversized and cancelled image streams and forwards If-Match', async () => {
  const seen = Promise.withResolvers<string | undefined>();
  const disconnected = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    seen.resolve(request.headers['if-match']);
    response.on('close', () => disconnected.resolve());
    if (request.url?.includes('oversized')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.write(Buffer.alloc(32));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
  const original = COS.prototype.getObject;
  const get = vi.spyOn(COS.prototype, 'getObject').mockImplementation(function (
    this: COS,
    ...args
  ) {
    const client = this as unknown as { options: { Domain: string; Protocol: string } };
    client.options.Domain = `http://127.0.0.1:${address.port}`;
    client.options.Protocol = 'http:';
    return original.apply(this, args);
  });
  try {
    const storage = createCosStorage({
      databaseURL: 'postgresql://example.invalid/media',
      bucket: 'mio-test-1234567890',
      region: 'ap-shanghai',
      secretId: 'example-id',
      secretKey: 'example-key',
    });
    const controller = new AbortController();
    await expect(
      storage.readImage!('oversized', '"fixture-etag"', 4, controller.signal),
    ).rejects.toThrow('ASSET_SIZE_MISMATCH');
    expect(await seen.promise).toBe('"fixture-etag"');
    await Promise.race([
      disconnected.promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('sender remained open')), 3000),
      ),
    ]);

    const already = new AbortController();
    already.abort();
    const calls = get.mock.calls.length;
    await expect(storage.readImage!('never-started', 'etag', 4, already.signal)).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(calls);
  } finally {
    get.mockRestore();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

it('cancels an SDK image request while the server has not responded', async () => {
  const entered = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const server = createServer((_request, response) => {
    entered.resolve();
    response.on('close', () => disconnected.resolve());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
  const original = COS.prototype.getObject;
  const get = vi.spyOn(COS.prototype, 'getObject').mockImplementation(function (
    this: COS,
    ...args
  ) {
    const client = this as unknown as { options: { Domain: string; Protocol: string } };
    client.options.Domain = `http://127.0.0.1:${address.port}`;
    client.options.Protocol = 'http:';
    return original.apply(this, args);
  });
  try {
    const storage = createCosStorage({
      databaseURL: 'postgresql://example.invalid/media',
      bucket: 'mio-test-1234567890',
      region: 'ap-shanghai',
      secretId: 'example-id',
      secretKey: 'example-key',
    });
    const controller = new AbortController();
    const read = storage.readImage!('waiting', '"etag"', 4, controller.signal);
    await entered.promise;
    controller.abort();
    await expect(read).rejects.toThrow();
    await Promise.race([
      disconnected.promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('sender remained open')), 3000),
      ),
    ]);
  } finally {
    get.mockRestore();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

it.each([
  [
    'longer than expected',
    '<Error><Code>PreconditionFailed</Code><Message>changed</Message></Error>',
  ],
  ['equal to expected', 'oops'],
  ['empty', ''],
])('preserves the SDK precondition failure when its body is %s', async (_name, body) => {
  const server = createServer((_request, response) => {
    response.writeHead(412, { 'content-type': 'application/xml' });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
  const original = COS.prototype.getObject;
  const get = vi.spyOn(COS.prototype, 'getObject').mockImplementation(function (
    this: COS,
    ...args
  ) {
    const client = this as unknown as { options: { Domain: string; Protocol: string } };
    client.options.Domain = `http://127.0.0.1:${address.port}`;
    client.options.Protocol = 'http:';
    return original.apply(this, args);
  });
  try {
    const storage = createCosStorage({
      databaseURL: 'postgresql://example.invalid/media',
      bucket: 'mio-test-1234567890',
      region: 'ap-shanghai',
      secretId: 'example-id',
      secretKey: 'example-key',
    });
    await expect(
      storage.readImage!('changed', '"old"', 4, new AbortController().signal),
    ).rejects.toMatchObject({ statusCode: 412 });
  } finally {
    get.mockRestore();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

it('waits for SDK completion after the exact response bytes arrive', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = createServer((_request, response) => response.end('data'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
  const original = COS.prototype.getObject;
  const get = vi.spyOn(COS.prototype, 'getObject').mockImplementation(function (
    this: COS,
    ...args
  ) {
    const client = this as unknown as { options: { Domain: string; Protocol: string } };
    client.options.Domain = `http://127.0.0.1:${address.port}`;
    client.options.Protocol = 'http:';
    const values = args as unknown as [
      COS.GetObjectParams,
      (error: COS.CosError, result: COS.GetObjectResult) => void,
    ];
    const callback = values[1];
    values[1] = (error, result) => {
      entered.resolve();
      void release.promise.then(() => callback(error, result));
    };
    return original.apply(this, args);
  });
  try {
    const storage = createCosStorage({
      databaseURL: 'postgresql://example.invalid/media',
      bucket: 'mio-test-1234567890',
      region: 'ap-shanghai',
      secretId: 'example-id',
      secretKey: 'example-key',
    });
    let settled = false;
    const read = storage.readImage!('exact', '"etag"', 4, new AbortController().signal);
    void read.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release.resolve();
    expect(Buffer.from(await read).toString()).toBe('data');
  } finally {
    release.resolve();
    get.mockRestore();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

it.each([
  ['short', 'ab'],
  ['long', 'abcdefgh'],
])('maps an actual SDK %s response to the asset size conflict', async (_name, body) => {
  const server = createServer((_request, response) => response.end(body));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
  const original = COS.prototype.getObject;
  const get = vi.spyOn(COS.prototype, 'getObject').mockImplementation(function (
    this: COS,
    ...args
  ) {
    const client = this as unknown as { options: { Domain: string; Protocol: string } };
    client.options.Domain = `http://127.0.0.1:${address.port}`;
    client.options.Protocol = 'http:';
    return original.apply(this, args);
  });
  const head = vi.spyOn(COS.prototype, 'headObject').mockResolvedValue({
    statusCode: 200,
    ETag: '"etag"',
    headers: { 'content-length': '4' },
  });
  const assetId = randomUUID();
  const store = {
    owned: async () => ({
      id: assetId,
      owner_id: 'owner',
      state: 'ready',
      raw_key: `mio/raw/${assetId}/${randomUUID()}`,
      content_type: 'image/png',
      size_bytes: '4',
    }),
    expiredStaging: async () => [],
    close: async () => {},
  } as unknown as AssetStore;
  const service = createAssetService(
    store,
    createCosStorage({
      databaseURL: 'postgresql://example.invalid/media',
      bucket: 'mio-test-1234567890',
      region: 'ap-shanghai',
      secretId: 'example-id',
      secretKey: 'example-key',
    }),
  );
  try {
    await expect(
      service.readVisionSource('owner', assetId, undefined, new AbortController().signal),
    ).rejects.toMatchObject({ status: 409, code: 'ASSET_SIZE_MISMATCH' });
  } finally {
    await service.close();
    head.mockRestore();
    get.mockRestore();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});
