import COS from 'cos-nodejs-sdk-v5';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { readAssetConfig } from '../../src/assets/config.ts';
import { createAssetService } from '../../src/assets/service.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import type { AssetStore } from '../../src/assets/store.ts';

const copyFixture = {
  databaseURL: 'postgresql://example.invalid/media',
  bucket: 'mio-test-1234567890',
  region: 'ap-shanghai',
  secretId: 'example-id',
  secretKey: 'example-key',
};

function redirectCosRequests(port: number, onSend?: () => void) {
  const original = COS.prototype.request;
  const redirect = (options: { url: string }) => {
    const url = new URL(options.url);
    options.url = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
    onSend?.();
  };
  return vi.spyOn(COS.prototype, 'request').mockImplementation(function (
    this: COS,
    params: COS.RequestParams,
  ) {
    this.off('before-send', redirect);
    this.on('before-send', redirect);
    return original.call(this, params);
  });
}

function redirectCosDownloads(port: number) {
  const original = COS.prototype.getObject;
  return vi.spyOn(COS.prototype, 'getObject').mockImplementation(function (this: COS, ...args) {
    const client = this as unknown as { options: { Domain: string; Protocol: string } };
    client.options.Domain = `http://127.0.0.1:${port}`;
    client.options.Protocol = 'http:';
    return original.apply(this, args);
  });
}

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
  const playback = new URL(storage.audioPlaybackUrl!('mio/raw/example/attempt', 'audio/mpeg'));
  expect(playback.pathname).toBe(download.pathname);
  expect(playback.searchParams.get('response-content-disposition')).toBe('inline');
  expect(playback.searchParams.get('response-content-type')).toBe('audio/mpeg');
  expect(playback.searchParams.get('q-signature')).toBeTruthy();
});

it('signs a private HLS segment GET for inline MPEG-TS using the official SDK', () => {
  const storage = createCosStorage({
    databaseURL: 'postgresql://example.invalid/media',
    bucket: 'mio-test-1234567890',
    region: 'ap-shanghai',
    secretId: 'example-id',
    secretKey: 'example-key',
    sessionToken: 'synthetic+token=/&%#?',
  });
  const key = 'mio/media/example-job/example-attempt/seg-720-000.ts';
  const playback = new URL(storage.hlsSegmentUrl!(key, 1014));
  expect(playback.protocol).toBe('https:');
  expect(playback.pathname).toBe('/' + key);
  expect(playback.searchParams.get('response-content-disposition')).toBe('inline');
  expect(playback.searchParams.get('response-content-type')).toBe('video/mp2t');
  expect(playback.searchParams.get('x-cos-security-token')).toBe('synthetic+token=/&%#?');
  expect(playback.searchParams.get('q-signature')).toBeTruthy();
  const [start, end] = playback.searchParams.get('q-sign-time')!.split(';').map(Number);
  expect(end! - start!).toBe(1014);
});

it('stops waiting for a hung SDK HEAD and detaches the abort listener', async () => {
  const storage = createCosStorage({
    databaseURL: 'postgresql://example.invalid/media',
    bucket: 'mio-test-1234567890',
    region: 'ap-shanghai',
    secretId: 'fixture',
    secretKey: 'fixture',
  });
  const work = Promise.withResolvers<COS.HeadObjectResult>();
  const started = Promise.withResolvers<void>();
  const head = vi.spyOn(COS.prototype, 'headObject').mockImplementation(() => {
    started.resolve();
    return work.promise;
  });
  const abort = new AbortController();
  const add = vi.spyOn(abort.signal, 'addEventListener');
  const remove = vi.spyOn(abort.signal, 'removeEventListener');
  const reason = new Error('fixture HEAD shutdown');
  try {
    await expect(storage.head('staging', AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(head).not.toHaveBeenCalled();
    const pending = storage.head('staging', abort.signal);
    await started.promise;
    abort.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
    work.reject(new Error('late SDK failure'));

    const active = new AbortController();
    const settled = vi.spyOn(active.signal, 'removeEventListener');
    head.mockResolvedValueOnce({ ETag: 'etag', headers: { 'content-length': '3' } });
    await expect(storage.head('staging', active.signal)).resolves.toEqual({
      size: 3,
      etag: 'etag',
    });
    expect(settled).toHaveBeenCalledWith('abort', expect.any(Function));
    head.mockRejectedValueOnce(new Error('SDK failure'));
    await expect(storage.head('staging', active.signal)).rejects.toThrow('SDK failure');
    expect(settled).toHaveBeenCalledTimes(2);
  } finally {
    head.mockRestore();
  }
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
        ContentType: 'application/octet-stream',
        Headers: { 'x-cos-forbid-overwrite': 'true' },
      }),
    );
  } finally {
    copy.mockRestore();
    head.mockRestore();
  }
});

it.each(['acknowledged', 'xml-error', 'connection-reset'] as const)(
  'sends one conditional video copy at the SDK transport on %s',
  async (outcome) => {
    const size = 41;
    const sha256 = 'a'.repeat(64);
    const token = 'fixture-session-token';
    const source = 'mio/staging/video/job/0/attempt.media';
    const target = 'mio/raw/asset/attempt';
    const seen: {
      method: string | undefined;
      url: string | undefined;
      headers: Record<string, unknown>;
    }[] = [];
    let stored = false;
    const server = createServer((request, response) => {
      const { method, url, headers } = request;
      seen.push({ method, url, headers });
      request.resume();
      request.once('end', () => {
        if (method === 'HEAD') {
          response
            .writeHead(stored ? 200 : 404, {
              'content-length': String(size),
              'content-type': 'video/mp4',
              'x-cos-meta-sha256': sha256,
              etag: '"raw"',
            })
            .end();
          return;
        }
        if (outcome === 'xml-error') {
          response.end('<Error><Code>InternalError</Code><Message>fixture</Message></Error>');
          return;
        }
        stored = true;
        if (outcome === 'connection-reset') {
          request.socket.destroy();
          return;
        }
        response.end('<CopyObjectResult><ETag>&quot;raw&quot;</ETag></CopyObjectResult>');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('COS fixture address missing');
    const requestSpy = redirectCosRequests(address.port);
    try {
      const storage = createCosStorage({ ...copyFixture, sessionToken: token });
      const result = storage.copy(source, target, '"source"', 'private', {
        contentType: 'video/mp4',
        sha256,
        signal: AbortSignal.timeout(5000),
      });
      if (outcome === 'acknowledged') await expect(result).resolves.toEqual({ etag: '"raw"' });
      else if (outcome === 'xml-error')
        await expect(result).rejects.toThrow('COS_VIDEO_COPY_ACK_INVALID');
      else await expect(result).rejects.toMatchObject({ code: 'ECONNRESET' });
      if (outcome !== 'xml-error') {
        expect(await storage.head(target)).toEqual({
          size,
          etag: '"raw"',
          contentType: 'video/mp4',
          sha256,
        });
      }
      expect(seen.map(({ method }) => method)).toEqual(
        outcome === 'xml-error' ? ['PUT'] : ['PUT', 'HEAD'],
      );
      expect(seen[0]).toMatchObject({
        url: '/' + target,
        headers: {
          authorization: expect.any(String),
          'content-length': '0',
          'content-type': 'video/mp4',
          'x-cos-copy-source': `mio-test-1234567890.cos.ap-shanghai.myqcloud.com/${encodeURIComponent(source)}`,
          'x-cos-copy-source-if-match': '"source"',
          'x-cos-metadata-directive': 'Replaced',
          'x-cos-acl': 'private',
          'x-cos-meta-sha256': sha256,
          'x-cos-forbid-overwrite': 'true',
          'x-cos-security-token': token,
        },
      });
    } finally {
      requestSpy.mockRestore();
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  },
);

it.each(['PUT', 'DELETE'] as const)(
  'cancels the COS %s sender before request EOF and after EOF while waiting for a reply',
  async (method) => {
    const seen: (string | undefined)[] = [];
    const server = createServer((request) => {
      seen.push(request.method);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('COS fixture address missing');
    let sends = 0;
    const active = new AbortController();
    const beforeSend = new AbortController();
    const reason = Object.freeze(new Error('fixture cancellation'));
    const requestSpy = redirectCosRequests(address.port, () => {
      sends += 1;
      if (sends === 1) beforeSend.abort(reason);
    });
    const storage = createCosStorage(copyFixture);
    const operation = (signal: AbortSignal) =>
      method === 'PUT'
        ? storage.copy('staging/source', 'raw/target', '"source"', 'private', {
            contentType: 'video/mp4',
            sha256: 'a'.repeat(64),
            signal,
          })
        : storage.delete('staging/source', signal);
    try {
      await expect(operation(AbortSignal.abort(reason))).rejects.toBe(reason);
      expect(requestSpy).not.toHaveBeenCalled();

      await expect(operation(beforeSend.signal)).rejects.toBe(reason);
      const earlyBody = requestSpy.mock.calls[0]?.[0].Body;
      expect(earlyBody).toMatchObject({ readableEnded: false, destroyed: true });
      expect(sends).toBe(1);

      const deadline = AbortSignal.timeout(3000);
      const received = once(server, 'request', { signal: deadline });
      const remove = vi.spyOn(active.signal, 'removeEventListener');
      const pending = operation(active.signal);
      void pending.catch(() => {});
      const [request] = (await received) as [IncomingMessage];
      const ended = once(request, 'end', { signal: deadline });
      const disconnected = once(request.socket, 'close', { signal: deadline });
      void disconnected.catch(() => {});
      request.resume();
      await ended;
      const body = requestSpy.mock.calls[1]?.[0].Body;
      expect(body).toMatchObject({ readableEnded: true, destroyed: false });
      active.abort(reason);
      await Promise.all([expect(pending).rejects.toBe(reason), disconnected]);
      deadline.throwIfAborted();
      expect(body).toMatchObject({ readableEnded: true, destroyed: true });
      expect(remove).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function));
      expect(seen).toEqual([method]);
      expect(sends).toBe(2);
    } finally {
      active.abort(reason);
      requestSpy.mockRestore();
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  },
);

it('preserves signalled asset copy headers and distinguishes missing deletes from other COS failures', async () => {
  const seen: IncomingMessage['headers'][] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers);
    if (request.url === '/raw/target')
      response.end('<CopyObjectResult><ETag>&quot;raw&quot;</ETag></CopyObjectResult>');
    else if (request.url === '/raw/false-ack')
      response.end('<Error><Code>InternalError</Code><Message>fixture</Message></Error>');
    else if (request.url === '/raw/source-changed') response.writeHead(412).end();
    else if (request.url === '/staging/deleted') response.writeHead(204).end();
    else if (request.url === '/staging/missing') response.writeHead(404).end();
    else response.writeHead(403).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('COS fixture address missing');
  const requestSpy = redirectCosRequests(address.port);
  const storage = createCosStorage(copyFixture);
  const signal = AbortSignal.timeout(3000);
  const remove = vi.spyOn(signal, 'removeEventListener');
  try {
    await expect(
      storage.copy('staging/source', 'raw/target', '"source"', 'private', { signal }),
    ).resolves.toBeUndefined();
    expect(seen[0]).toMatchObject({
      'cache-control': '',
      'content-length': '0',
      'content-type': 'application/octet-stream',
      'x-cos-copy-source': 'mio-test-1234567890.cos.ap-shanghai.myqcloud.com/staging%2Fsource',
      'x-cos-copy-source-if-match': '"source"',
      'x-cos-metadata-directive': 'Replaced',
      'x-cos-acl': 'private',
      'x-cos-forbid-overwrite': 'true',
    });
    expect(seen[0]?.['x-cos-meta-sha256']).toBeUndefined();
    await expect(
      storage.copy('staging/source', 'raw/false-ack', '"source"', undefined, { signal }),
    ).rejects.toThrow('COS_COPY_ACK_INVALID');
    await expect(
      storage.copy('staging/source', 'raw/source-changed', '"source"', undefined, { signal }),
    ).rejects.toMatchObject({ statusCode: 412 });
    await expect(storage.delete('staging/deleted', signal)).resolves.toBeUndefined();
    await expect(storage.delete('staging/missing', signal)).resolves.toBeUndefined();
    await expect(storage.delete('staging/denied', signal)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(seen).toHaveLength(6);
    expect(remove).toHaveBeenCalledTimes(6);
  } finally {
    requestSpy.mockRestore();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
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
  const get = redirectCosDownloads(address.port);
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
  const get = redirectCosDownloads(address.port);
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
  const get = redirectCosDownloads(address.port);
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
  const get = redirectCosDownloads(address.port);
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

it('validates a conditional prefix on the actual SDK wire and distinguishes identity from storage failures', async () => {
  const tag = '"fixture-etag"';
  const good = { 'content-range': 'bytes 0-7/1000000', etag: tag };
  const cases = {
    exact: { status: 206, headers: { ...good, 'content-length': '8' }, body: '12345678' },
    'small-object': { status: 206, headers: { 'content-range': 'bytes 0-3/5' }, body: '1234' },
    'wrong-start': { status: 206, headers: { ...good, 'content-range': 'bytes 1-8/1000000' } },
    'wrong-end': { status: 206, headers: { ...good, 'content-range': 'bytes 0-6/1000000' } },
    'wrong-total': { status: 206, headers: { ...good, 'content-range': 'bytes 0-7/1000001' } },
    'missing-range': { status: 206, headers: { etag: tag } },
    'malformed-range': { status: 206, headers: { ...good, 'content-range': 'bytes 0-7/*' } },
    'wrong-etag': { status: 206, headers: { ...good, etag: '"other"' } },
    'wrong-length': { status: 206, headers: { ...good, 'content-length': '9' } },
    short: { status: 206, headers: good, body: '123' },
    overlong: { status: 206, headers: good, body: '123456789' },
    'ignored-range': { status: 200 },
    changed: { status: 412 },
    unavailable: { status: 503 },
  } satisfies Record<string, { status: number; headers?: Record<string, string>; body?: string }>;
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    const entry: { status: number; headers?: Record<string, string>; body?: string } =
      cases[request.url?.slice(1) as keyof typeof cases];
    response.writeHead(entry.status, entry.headers).flushHeaders();
    if (entry.body !== undefined) {
      // A chunked response tests length from the stream when no Content-Length is sent.
      response.write(entry.body.slice(0, 2));
      response.end(entry.body.slice(2));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
  const get = redirectCosDownloads(address.port);
  try {
    const storage = createCosStorage(copyFixture);
    const read = (key: keyof typeof cases, size = 1_000_000) =>
      storage.readPrefix!(key, tag, size, 8, AbortSignal.timeout(3000));
    await expect(read('exact')).resolves.toEqual(Buffer.from('12345678'));
    await expect(read('small-object', 5)).resolves.toEqual(Buffer.from('1234'));
    for (const key of ['wrong-start', 'wrong-end', 'missing-range', 'malformed-range'] as const)
      await expect(read(key)).rejects.toThrow('ASSET_RANGE_RESPONSE');
    for (const key of ['wrong-total', 'wrong-etag', 'wrong-length'] as const)
      await expect(read(key)).rejects.toMatchObject({ status: 409, code: 'ASSET_SOURCE_CHANGED' });
    for (const key of ['short', 'overlong'] as const)
      await expect(read(key)).rejects.toMatchObject({ status: 409, code: 'ASSET_SIZE_MISMATCH' });
    await expect(read('ignored-range')).rejects.toMatchObject({ statusCode: 200 });
    await expect(read('changed')).rejects.toMatchObject({ statusCode: 412 });
    await expect(read('unavailable')).rejects.toMatchObject({ statusCode: 503 });
    expect(requests.map(({ url }) => url).sort()).toEqual(
      Object.keys(cases)
        .map((key) => '/' + key)
        .sort(),
    );
    for (const request of requests) {
      expect(request.method).toBe('GET');
      expect(request.headers).toMatchObject({
        'if-match': tag,
        range: request.url === '/small-object' ? 'bytes=0-3' : 'bytes=0-7',
      });
      expect(request.headers.authorization).toMatch(/q-header-list=[^&]*if-match[^&]*range/);
    }
  } finally {
    get.mockRestore();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

it.each([false, true])(
  'closes the conditional range socket on abort (headers sent: %s)',
  async (sent) => {
    const entered = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const server = createServer((_request, response) => {
      response.on('close', () => disconnected.resolve());
      if (sent) response.writeHead(206, { 'content-range': 'bytes 0-7/1000000' }).write('1234');
      entered.resolve();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
    const get = redirectCosDownloads(address.port);
    const controller = new AbortController();
    try {
      const storage = createCosStorage(copyFixture);
      const read = storage.readPrefix!(
        'waiting',
        '"fixture-etag"',
        1_000_000,
        8,
        controller.signal,
      );
      await entered.promise;
      controller.abort();
      await expect(read).rejects.toThrow();
      await disconnected.promise;
      const calls = get.mock.calls.length;
      await expect(
        storage.readPrefix!('never-started', '"fixture-etag"', 1_000_000, 8, controller.signal),
      ).rejects.toThrow();
      expect(get).toHaveBeenCalledTimes(calls);
    } finally {
      controller.abort();
      get.mockRestore();
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  },
);

it('streams video staging with MD5, private access and non-overwrite metadata', async () => {
  const bytes = Buffer.from('generated video fixture');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const md5 = createHash('md5').update(bytes).digest('base64');
  const received: Buffer[] = [];
  const put = vi.spyOn(COS.prototype, 'putObject').mockImplementation(async (parameters) => {
    for await (const part of parameters.Body as Readable) received.push(Buffer.from(part));
    return { ETag: '"video-etag"', Location: '' };
  });
  const storage = createCosStorage({
    databaseURL: 'postgresql://example.invalid/media',
    bucket: 'mio-test-1234567890',
    region: 'ap-shanghai',
    secretId: 'fixture',
    secretKey: 'fixture',
  });
  try {
    const key = 'mio/staging/video/job/0/attempt.media';
    expect(
      await storage.putVideo!(
        key,
        Readable.from(bytes),
        bytes.length,
        sha256,
        md5,
        AbortSignal.timeout(5000),
      ),
    ).toEqual({
      key,
      sizeBytes: bytes.length,
      sha256,
      etag: '"video-etag"',
      contentType: 'video/mp4',
    });
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: key,
        ACL: 'private',
        ContentLength: bytes.length,
        ContentType: 'video/mp4',
        'x-cos-meta-sha256': sha256,
        Headers: { 'x-cos-forbid-overwrite': 'true', 'Content-MD5': md5 },
      }),
    );
    expect(Buffer.concat(received)).toEqual(bytes);
    await expect(
      storage.putVideo!(key, Readable.from(bytes), bytes.length, sha256, md5, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(put).toHaveBeenCalledTimes(1);
  } finally {
    put.mockRestore();
  }
});

it('writes generation originals with MD5 and non-overwrite and returns the actual PUT receipt for adoption', async () => {
  const bytes = Buffer.from('original generated bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const uploaded: Buffer[] = [];
  const put = vi.spyOn(COS.prototype, 'putObject').mockImplementation(async (parameters) => {
    const chunks: Buffer[] = [];
    for await (const chunk of parameters.Body as Readable) chunks.push(Buffer.from(chunk));
    uploaded.push(Buffer.concat(chunks));
    return { ETag: '"put-etag"', Location: '' };
  });
  const head = vi.spyOn(COS.prototype, 'headObject').mockResolvedValue({
    ETag: '"put-etag"',
    headers: { 'content-length': String(bytes.length), 'x-cos-meta-sha256': sha256 },
  });
  const storage = createCosStorage({
    databaseURL: 'postgresql://example.invalid/media',
    bucket: 'mio-test-1234567890',
    region: 'ap-shanghai',
    secretId: 'fixture',
    secretKey: 'fixture',
  });
  const key = 'mio/derived/job/images/0-file.png';
  try {
    expect(
      await storage.putImage!(key, bytes, 'png', sha256, new AbortController().signal),
    ).toEqual({
      key,
      sizeBytes: bytes.length,
      sha256,
      etag: '"put-etag"',
      contentType: 'image/png',
    });
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: key,
        Body: expect.any(Readable),
        ContentLength: bytes.length,
        ContentType: 'image/png',
        'x-cos-meta-sha256': sha256,
        Headers: {
          'x-cos-forbid-overwrite': 'true',
          'Content-MD5': createHash('md5').update(bytes).digest('base64'),
        },
      }),
    );
    expect(uploaded).toEqual([bytes]);
    expect(head).not.toHaveBeenCalled();
    put.mockResolvedValueOnce({ ETag: '', Location: '' });
    await expect(
      storage.putImage!(key, bytes, 'png', sha256, new AbortController().signal),
    ).rejects.toThrow('IMAGE_OUTPUT_MISMATCH');
    await expect(
      storage.putImage!(key, bytes, 'png', '0'.repeat(64), new AbortController().signal),
    ).rejects.toThrow('IMAGE_OUTPUT_INVALID');
    const stopped = AbortSignal.abort();
    await expect(storage.putImage!(key, bytes, 'png', sha256, stopped)).rejects.toThrow();
    expect(put).toHaveBeenCalledTimes(2);
  } finally {
    put.mockRestore();
    head.mockRestore();
  }
});

it.each(['server error', 'connection reset'])(
  'makes one physical generation PUT on SDK %s',
  async (failure) => {
    const requests: { url: string; bytes: Buffer }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({ url: request.url!, bytes: Buffer.concat(chunks) });
      if (failure === 'connection reset') request.socket.destroy();
      else {
        response.writeHead(500, { 'content-type': 'application/xml' });
        response.end(
          '<Error><Code>InternalError</Code><Message>retryable fixture</Message></Error>',
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
    const original = COS.prototype.putObject;
    const put = vi.spyOn(COS.prototype, 'putObject').mockImplementation(function (
      this: COS,
      ...args
    ) {
      const client = this as unknown as { options: { Domain: string; Protocol: string } };
      client.options.Domain = `http://127.0.0.1:${address.port}`;
      client.options.Protocol = 'http:';
      return original.apply(this, args);
    });
    try {
      const bytes = Buffer.from('the exact generation original');
      const storage = createCosStorage({
        databaseURL: 'postgresql://example.invalid/media',
        bucket: 'mio-test-1234567890',
        region: 'ap-shanghai',
        secretId: 'fixture',
        secretKey: 'fixture',
      });
      const key = 'mio/derived/job/images/0-physical.png';
      await expect(
        storage.putImage!(
          key,
          bytes,
          'png',
          createHash('sha256').update(bytes).digest('hex'),
          new AbortController().signal,
        ),
      ).rejects.toBeTruthy();
      expect(put).toHaveBeenCalledTimes(1);
      expect(requests).toEqual([{ url: '/' + key, bytes }]);
    } finally {
      put.mockRestore();
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  },
);

it('signs a separate600-second supplier GET without attachment and preserves session-token URL encoding', () => {
  const token = 'fixture+token=/&%#?';
  const signer = vi.spyOn(COS.prototype, 'getObjectUrl');
  try {
    const storage = createCosStorage({
      databaseURL: 'postgresql://fixture/media',
      bucket: 'mio-test-1234567890',
      region: 'ap-shanghai',
      secretId: 'fixture',
      secretKey: 'fixture',
      sessionToken: token,
    });
    const url = new URL(storage.materialUrl!('mio/raw/fixture/immutable'));
    expect(signer).toHaveBeenLastCalledWith(
      expect.objectContaining({ Method: 'GET', Expires: 600, Key: 'mio/raw/fixture/immutable' }),
    );
    expect(signer.mock.calls.at(-1)![0]).not.toHaveProperty('Query');
    expect(url.searchParams.has('response-content-disposition')).toBe(false);
    expect(url.searchParams.get('x-cos-security-token')).toBe(token);
    const [from, to] = url.searchParams.get('q-sign-time')!.split(';').map(Number);
    expect(to! - from!).toBe(600);
    const download = new URL(storage.downloadUrl('mio/raw/fixture/immutable'));
    expect(download.searchParams.get('response-content-disposition')).toBe('attachment');
  } finally {
    signer.mockRestore();
  }
});

it('signs the required private ACL for audio staging and applies it to audio copies and output PUTs', async () => {
  const storage = createCosStorage({
    databaseURL: 'postgresql://example.invalid/media',
    bucket: 'mio-test-1234567890',
    region: 'ap-shanghai',
    secretId: 'isolated-fixture',
    secretKey: 'isolated-secret',
  });
  const bytes = Buffer.from('fixture audio');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const put = vi
    .spyOn(COS.prototype, 'putObject')
    .mockResolvedValue({ ETag: '"audio"', Location: '' });
  const copy = vi.spyOn(COS.prototype, 'putObjectCopy').mockResolvedValue({
    ETag: '"audio"',
    CRC64: '',
    LastModified: '',
    VersionId: '',
    Location: '',
  });
  try {
    const plain = new URL(storage.uploadUrl('mio/staging/known', bytes.length));
    const privateUrl = new URL(storage.uploadUrl('mio/staging/known', bytes.length, 'private'));
    expect(plain.searchParams.get('q-header-list')).toBe('content-length;host');
    expect(privateUrl.searchParams.get('q-header-list')).toBe('content-length;host;x-cos-acl');
    expect(privateUrl.searchParams.get('q-signature')).not.toBe(
      plain.searchParams.get('q-signature'),
    );
    await storage.copy('mio/staging/known', 'mio/raw/known/copy', '"audio"', 'private');
    expect(copy).toHaveBeenCalledWith(
      expect.objectContaining({
        ACL: 'private',
        CopySourceIfMatch: '"audio"',
        Headers: { 'x-cos-forbid-overwrite': 'true' },
      }),
    );
    await storage.putAudio!(
      'mio/raw/known/result',
      bytes,
      'mp3',
      sha256,
      new AbortController().signal,
    );
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        ACL: 'private',
        'x-cos-meta-sha256': sha256,
        Headers: expect.objectContaining({ 'x-cos-forbid-overwrite': 'true' }),
      }),
    );
  } finally {
    copy.mockRestore();
    put.mockRestore();
  }
});

it('narrows the ACL only after identity checks and leaves an already-private object alone', async () => {
  const bytes = Buffer.from('audio checkpoint fixture');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const storage = createCosStorage({
    databaseURL: 'postgresql://example.invalid/media',
    bucket: 'mio-test-1234567890',
    region: 'ap-shanghai',
    secretId: 'isolated-fixture',
    secretKey: 'isolated-secret',
  });
  const head = vi.spyOn(COS.prototype, 'headObject').mockResolvedValue({
    ETag: '"frozen"',
    headers: { 'content-length': String(bytes.length), 'x-cos-meta-sha256': sha256 },
  });
  const acl = vi
    .spyOn(COS.prototype, 'getObjectAcl')
    .mockResolvedValueOnce({ ACL: 'default' } as COS.GetObjectAclResult)
    .mockResolvedValue({ ACL: 'private' } as COS.GetObjectAclResult);
  const write = vi
    .spyOn(COS.prototype, 'putObjectAcl')
    .mockResolvedValue({ statusCode: 200, headers: {} });
  try {
    const identity = { sizeBytes: bytes.length, etag: '"frozen"', sha256 };
    const signal = new AbortController().signal;
    await expect(
      storage.ensureAudioPrivate!(
        'mio/raw/known/result',
        { ...identity, etag: '"changed"' },
        signal,
      ),
    ).rejects.toMatchObject({ statusCode: 412 });
    expect(acl).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    await storage.ensureAudioPrivate!('mio/raw/known/result', identity, signal);
    await storage.ensureAudioPrivate!('mio/raw/known/result', identity, signal);
    expect(write).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        Key: 'mio/raw/known/result',
        ACL: 'private',
      }),
    );
  } finally {
    write.mockRestore();
    acl.mockRestore();
    head.mockRestore();
  }
});

it('returns the private upload header and conditionally publishes audio from only the owned staging key', async () => {
  const id = randomUUID();
  const actor = { userId: 'audio-owner', sessionId: 'audio-session' };
  const key = `mio/staging/${id}`;
  const row = {
    id,
    state: 'pending',
    staging_key: key,
    raw_key: null,
    source_etag: null,
    content_type: 'audio/wav',
    size_bytes: '12',
    created_at: new Date(),
  };
  const store = {
    create: async (created: string, owner: string, filename: string) => ({
      ...row,
      id: created,
      staging_key: `mio/staging/${created}`,
      owner_id: owner,
      filename,
    }),
    owned: async () => row,
    claim: async () => row,
    release: async () => {},
    commit: async (_id: string, _owner: string, _lease: string, rawKey: string) => ({
      ...row,
      raw_key: rawKey,
      state: 'ready',
    }),
    expiredStaging: async () => [],
    close: async () => {},
  } as unknown as AssetStore;
  const uploadUrl = vi.fn(() => 'https://example.invalid/upload');
  const ensureAudioPrivate = vi.fn<NonNullable<AssetObjectStore['ensureAudioPrivate']>>(
    async () => {},
  );
  const copy = vi.fn(async () => {});
  const service = createAssetService(store, {
    uploadUrl,
    downloadUrl: () => 'https://example.invalid/download',
    head: async () => ({ size: 12, etag: '"frozen"' }),
    ensureAudioPrivate,
    copy,
    delete: async () => {},
  });
  try {
    const receipt = await service.create(actor, 'sample.wav', 'audio/wav', 12);
    expect(receipt.uploadHeaders).toEqual({ 'x-cos-acl': 'private' });
    expect(uploadUrl).toHaveBeenCalledWith(`mio/staging/${receipt.assetId}`, 12, 'private');
    const image = await service.create(actor, 'image.png', 'image/png', 12);
    expect(image.uploadHeaders).toBeUndefined();
    expect(uploadUrl).toHaveBeenCalledWith(`mio/staging/${image.assetId}`, 12);
    row.staging_key = `mio/staging/${randomUUID()}`;
    await expect(service.complete(actor, id)).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' });
    expect(ensureAudioPrivate).not.toHaveBeenCalled();
    row.staging_key = key;
    expect((await service.complete(actor, id)).status).toBe('ready');
    expect(ensureAudioPrivate).toHaveBeenCalledExactlyOnceWith(
      key,
      { sizeBytes: 12, etag: '"frozen"' },
      expect.any(AbortSignal),
    );
    expect(copy).toHaveBeenCalledExactlyOnceWith(
      key,
      expect.stringMatching(new RegExp(`^mio/raw/${id}/[a-f0-9-]{36}$`)),
      '"frozen"',
      'private',
      { signal: ensureAudioPrivate.mock.calls[0]?.[2] },
    );
  } finally {
    await service.close();
  }
});
