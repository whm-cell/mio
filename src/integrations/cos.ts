import { parseAccountDeletionTombstone } from '../account-deletion/tombstone.ts';
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { sha256Bytes } from '@mio/foundation/hash';
import COS from 'cos-nodejs-sdk-v5';
import { PassThrough, Readable } from 'node:stream';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { AssetError, waitForObjectHead } from '../assets/contracts.ts';
import type { AssetConfig } from '../assets/config.ts';
import type { AssetObjectStore } from '../assets/contracts.ts';

function prefixResponseError(
  headers: IncomingHttpHeaders,
  length: number,
  objectSize: number,
  etag: string,
): Error | undefined {
  const range = headers['content-range']?.match(/^bytes 0-(\d+)\/(\d+)$/i);
  const total = Number(range?.[2]);
  if (Number(range?.[1]) !== length - 1 || !Number.isSafeInteger(total) || total < length)
    return new Error('ASSET_RANGE_RESPONSE');
  if (
    total !== objectSize ||
    (headers['content-length'] !== undefined && headers['content-length'] !== String(length)) ||
    (headers.etag !== undefined && headers.etag !== etag)
  )
    return new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SOURCE_CHANGED');
}

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
  const writes = new Map<string, Set<Promise<unknown>>>();
  const trackWrite = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const entries = writes.get(key) ?? new Set();
    writes.set(key, entries);
    const pending = Promise.resolve().then(run);
    entries.add(pending);
    const done = () => {
      entries.delete(pending);
      if (!entries.size) writes.delete(key);
    };
    void pending.then(done, done);
    return pending;
  };
  const requestWithoutBody = async (
    Key: string,
    Method: 'PUT' | 'DELETE',
    signal: AbortSignal,
    headers?: Record<string, string>,
  ) => {
    signal.throwIfAborted();
    // Pinned SDK 3.0.0 aborts the sender on input stream error and does not retry streams.
    // Keep the empty stream destroyable after EOF while COS may still be preparing its reply.
    const body = Readable.from([], { autoDestroy: false });
    const abort = () => body.destroy(new Error('COS_REQUEST_ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await cos.request({
        Bucket,
        Region,
        Key,
        Method,
        Body: body,
        Headers: { ...headers, 'Content-Length': '0' },
      });
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      body.destroy();
    }
  };
  // This SDK appends the session token after signing without URL-encoding it.
  // Encode only that parameter; the signed query and the token used by SDK requests stay intact.
  const encodeUrlToken = (url: string) => {
    const token = config.sessionToken;
    if (!token) return url;
    const rawToken = `&x-cos-security-token=${token}`;
    if (!url.includes(rawToken)) throw new Error('COS_SIGNED_URL_TOKEN_MISSING');
    return url.replace(rawToken, () => `&x-cos-security-token=${encodeURIComponent(token)}`);
  };
  const readObject = async (
    Key: string,
    etag: string,
    size: number,
    signal: AbortSignal,
    objectSize?: number,
  ) => {
    signal.throwIfAborted();
    const range = objectSize === undefined ? undefined : `bytes=0-${size - 1}`;
    const expectedStatus = range ? 206 : 200;
    const stream = new PassThrough();
    // The SDK can report a late sender error after cancellation. Keep an error listener
    // on this one-shot stream until it is collected, including after our iterator exits.
    stream.on('error', () => {});
    // getObjectStream exposes the response body but not its status, and the SDK pipes
    // 412 bodies before reporting an error. Install the listener before the SDK pipes.
    stream.once('pipe', (sender: NodeJS.ReadableStream) => {
      sender.once(
        'response',
        ({ statusCode, headers }: Pick<IncomingMessage, 'statusCode' | 'headers'>) => {
          if (statusCode !== expectedStatus) {
            stream.destroy(Object.assign(new Error('ASSET_OBJECT_RESPONSE'), { statusCode }));
            return;
          }
          if (objectSize !== undefined) {
            const invalid = prefixResponseError(headers, size, objectSize, etag);
            if (invalid) stream.destroy(invalid);
          }
        },
      );
    });
    const completed = new Promise<void>((resolve, reject) => {
      const options = {
        Bucket,
        Region,
        Key,
        IfMatch: etag,
        ...(range === undefined ? {} : { Range: range }),
        Output: stream,
      };
      cos.getObject(options, (error, result) => {
        if (error) {
          const failure = Object.assign(new Error('ASSET_OBJECT_RESPONSE'), {
            statusCode: error.statusCode,
          });
          if (!stream.destroyed) stream.destroy(failure);
          reject(failure);
        } else if (result.statusCode !== expectedStatus) {
          reject(
            Object.assign(new Error('ASSET_OBJECT_RESPONSE'), { statusCode: result.statusCode }),
          );
        } else resolve();
      });
    });
    // A stream failure can precede the SDK's completion callback.
    void completed.catch(() => {});
    let rejectAbort: ((error: Error) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    void aborted.catch(() => {});
    const abort = () => {
      stream.destroy(new Error('ASSET_READ_ABORTED'));
      rejectAbort?.(new Error('ASSET_READ_ABORTED'));
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of stream) {
        signal.throwIfAborted();
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += part.length;
        if (length > size) {
          const error = new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SIZE_MISMATCH');
          stream.destroy(error);
          throw error;
        }
        chunks.push(part);
      }
      await Promise.race([completed, aborted]);
      if (length !== size) throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SIZE_MISMATCH');
      return Buffer.concat(chunks, length);
    } catch (error) {
      if (!stream.destroyed)
        stream.destroy(error instanceof Error ? error : new Error('ASSET_OBJECT_RESPONSE'));
      void completed.catch(() => {});
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      stream.destroy();
    }
  };
  const putObject = async (
    Key: string,
    bytes: Uint8Array,
    contentType: string,
    sha256: string,
    signal: AbortSignal,
    label: 'AUDIO' | 'IMAGE' | 'AUDIT',
    acl?: 'private',
  ) => {
    signal.throwIfAborted();
    const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (sha256Bytes(body) !== sha256) throw new Error(label + '_OUTPUT_INVALID');
    const uploaded = await trackWrite(Key, () =>
      cos.putObject({
        Bucket,
        Region,
        Key,
        // The SDK cannot retry a consumed stream; reconcile this key before any new PUT.
        Body: Readable.from(body),
        ContentLength: body.length,
        ContentType: contentType,
        'x-cos-meta-sha256': sha256,
        ...(label !== 'IMAGE' || acl ? { ACL: 'private' as const } : {}),
        Headers: {
          'x-cos-forbid-overwrite': 'true',
          'Content-MD5': createHash('md5').update(body).digest('base64'),
        },
      }),
    );
    signal.throwIfAborted();
    if (!uploaded.ETag) throw new Error(label + '_OUTPUT_MISMATCH');
    return {
      key: Key,
      sizeBytes: body.length,
      sha256,
      etag: uploaded.ETag,
      contentType,
    };
  };
  const head: AssetObjectStore['head'] = async (Key, signal) => {
    // The SDK can still return a late reply after the caller stops waiting.
    const object = await waitForObjectHead(() => cos.headObject({ Bucket, Region, Key }), signal);
    const size = Number(object.headers?.['content-length']);
    if (!Number.isSafeInteger(size) || size < 0 || !object.ETag)
      throw new Error('COS_INVALID_HEAD');
    const sha256 = object.headers?.['x-cos-meta-sha256'];
    const contentType = object.headers?.['content-type'];
    return {
      size,
      etag: object.ETag,
      ...(typeof sha256 === 'string' ? { sha256 } : {}),
      ...(typeof contentType === 'string' ? { contentType } : {}),
    };
  };
  const inlinePlaybackUrl = (Key: string, contentType: string, expiresIn = 300) =>
    encodeUrlToken(
      cos.getObjectUrl({
        Bucket,
        Region,
        Key,
        Method: 'GET',
        Expires: expiresIn,
        Query: {
          'response-content-disposition': 'inline',
          'response-content-type': contentType,
        },
      }),
    );
  return {
    hasPendingWrites: (key) => Boolean(writes.get(key)?.size),
    async archiveAccountDeletion(value, signal) {
      value = parseAccountDeletionTombstone(value);
      const Key = 'mio/audit/account-deletions/' + encodeURIComponent(value.userId) + '.json';
      const bytes = Buffer.from(
        JSON.stringify({ userId: value.userId, finalizedAt: value.finalizedAt }),
      );
      const sha256 = sha256Bytes(bytes);
      let stored: Awaited<ReturnType<typeof head>> | undefined;
      try {
        stored = await head(Key, signal);
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
      if (!stored) {
        await putObject(Key, bytes, 'application/json', sha256, signal, 'AUDIT', 'private');
        stored = await head(Key, signal);
      }
      if (stored.size !== bytes.length || stored.sha256 !== sha256)
        throw new Error('ACCOUNT_TOMBSTONE_CONFLICT');
      const archived = await readObject(Key, stored.etag, stored.size, signal);
      if (
        sha256Bytes(archived) !== sha256 ||
        (await cos.getObjectAcl({ Bucket, Region, Key })).ACL !== 'private'
      )
        throw new Error('ACCOUNT_TOMBSTONE_UNCONFIRMED');
    },
    async *accountDeletionTombstones(signal) {
      const Prefix = 'mio/audit/account-deletions/';
      let Marker = '';
      for (;;) {
        signal.throwIfAborted();
        const page = await cos.getBucket({ Bucket, Region, Prefix, Marker, MaxKeys: 100 });
        for (const item of page.Contents ?? []) {
          const key = item.Key;
          if (!key.startsWith(Prefix) || !key.endsWith('.json'))
            throw new Error('ACCOUNT_TOMBSTONE_INVALID');
          const meta = await head(key, signal);
          if (meta.size > 1024) throw new Error('ACCOUNT_TOMBSTONE_INVALID');
          const bytes = await readObject(key, meta.etag, meta.size, signal);
          if (sha256Bytes(bytes) !== meta.sha256) throw new Error('ACCOUNT_TOMBSTONE_INVALID');
          const value = parseAccountDeletionTombstone(bytes);
          if (key !== Prefix + encodeURIComponent(value.userId) + '.json')
            throw new Error('ACCOUNT_TOMBSTONE_INVALID');
          yield value;
        }
        if (String(page.IsTruncated) !== 'true') break;
        if (!page.NextMarker || page.NextMarker === Marker)
          throw new Error('ACCOUNT_TOMBSTONE_PAGE_INVALID');
        Marker = page.NextMarker;
      }
    },
    uploadUrl(Key, size, acl) {
      return encodeUrlToken(
        cos.getObjectUrl({
          Bucket,
          Region,
          Key,
          Method: 'PUT',
          Expires: 300,
          Headers: {
            'content-length': String(size),
            ...(acl ? { 'x-cos-acl': acl } : {}),
          },
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
    avatarInlineUrl(Key, contentType) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType))
        throw new Error('AVATAR_CONTENT_TYPE_INVALID');
      return inlinePlaybackUrl(Key, contentType);
    },
    audioPlaybackUrl: inlinePlaybackUrl,
    hlsSegmentUrl(Key, expiresIn) {
      return inlinePlaybackUrl(Key, 'video/mp2t', expiresIn);
    },
    materialUrl(Key) {
      return encodeUrlToken(cos.getObjectUrl({ Bucket, Region, Key, Method: 'GET', Expires: 600 }));
    },
    head,
    readImage: readObject,
    readMedia: readObject,
    readPrefix(Key, etag, size, maxBytes, signal) {
      // COS requires an actual subrange for a 206 response, even for small objects.
      const length = Math.min(size - 1, maxBytes);
      if (length < 1) throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SIZE_MISMATCH');
      return readObject(Key, etag, length, signal, size);
    },
    readAudio: readObject,
    putImage(Key, bytes, format, sha256, signal, acl) {
      if (!['png', 'jpeg', 'webp'].includes(format)) throw new Error('IMAGE_OUTPUT_INVALID');
      return putObject(Key, bytes, 'image/' + format, sha256, signal, 'IMAGE', acl);
    },
    putAudio(Key, bytes, format, sha256, signal) {
      if (!['mp3', 'wav', 'flac'].includes(format)) throw new Error('AUDIO_OUTPUT_INVALID');
      const contentType = format === 'mp3' ? 'audio/mpeg' : 'audio/' + format;
      return putObject(Key, bytes, contentType, sha256, signal, 'AUDIO');
    },
    async ensureAudioPrivate(Key, expected, signal) {
      signal.throwIfAborted();
      const current = await head(Key, signal);
      signal.throwIfAborted();
      if (
        current.size !== expected.sizeBytes ||
        current.etag !== expected.etag ||
        (expected.sha256 !== undefined && current.sha256 !== expected.sha256)
      )
        throw Object.assign(new Error('COS_AUDIO_OBJECT_CHANGED'), { statusCode: 412 });
      const scope = { Bucket, Region, Key };
      const permissions = await cos.getObjectAcl(scope);
      signal.throwIfAborted();
      if (permissions.ACL === 'private') return;
      await cos.putObjectAcl({ ...scope, ACL: 'private' });
      signal.throwIfAborted();
      if ((await cos.getObjectAcl(scope)).ACL !== 'private')
        throw new Error('COS_AUDIO_ACL_NOT_PRIVATE');
    },
    async putVideo(Key, stream, sizeBytes, sha256, contentMd5, signal) {
      signal.throwIfAborted();
      if (
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 1 ||
        sizeBytes > 1024 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(sha256) ||
        !/^[A-Za-z0-9+/]{22}==$/.test(contentMd5)
      )
        throw new Error('VIDEO_OUTPUT_INVALID');
      const abort = () => stream.destroy(new Error('VIDEO_UPLOAD_ABORTED'));
      signal.addEventListener('abort', abort, { once: true });
      try {
        const uploaded = await trackWrite(Key, () =>
          cos.putObject({
            Bucket,
            Region,
            Key,
            Body: stream,
            ContentLength: sizeBytes,
            ContentType: 'video/mp4',
            ACL: 'private',
            'x-cos-meta-sha256': sha256,
            Headers: { 'x-cos-forbid-overwrite': 'true', 'Content-MD5': contentMd5 },
          }),
        );
        signal.throwIfAborted();
        if (!uploaded.ETag) throw new Error('VIDEO_OUTPUT_MISMATCH');
        return { key: Key, sizeBytes, sha256, etag: uploaded.ETag, contentType: 'video/mp4' };
      } finally {
        signal.removeEventListener('abort', abort);
        stream.destroy();
      }
    },
    async copy(
      source,
      target,
      etag,
      acl,
      { signal, contentType = 'application/octet-stream', sha256 },
    ) {
      const sourcePath = `${Bucket}.cos.${Region}.myqcloud.com/${encodeURIComponent(source)}`;
      const copied = await trackWrite(target, () =>
        requestWithoutBody(target, 'PUT', signal, {
          'Content-Type': contentType,
          'x-cos-copy-source': sourcePath,
          'x-cos-copy-source-If-Match': etag,
          'x-cos-metadata-directive': 'Replaced',
          ...(sha256 === undefined ? { 'Cache-Control': '' } : { 'x-cos-meta-sha256': sha256 }),
          ...(acl ? { 'x-cos-acl': acl } : {}),
          'x-cos-forbid-overwrite': 'true',
        }),
      );
      signal.throwIfAborted();
      // COS can return HTTP 200 with an XML Error instead of CopyObjectResult.
      if (sha256 === undefined) {
        if (copied.Error) throw new Error('COS_COPY_ACK_INVALID');
        return;
      }
      const copiedEtag: unknown = copied.CopyObjectResult?.ETag;
      if (copied.Error || typeof copiedEtag !== 'string' || !copiedEtag)
        throw new Error('COS_VIDEO_COPY_ACK_INVALID');
      return { etag: copiedEtag };
    },
    async delete(Key, signal) {
      try {
        await requestWithoutBody(Key, 'DELETE', signal);
      } catch (error) {
        signal.throwIfAborted();
        // Deleting an already absent object is complete.
        if ((error as COS.CosError | undefined)?.statusCode !== HTTP_STATUS.NOT_FOUND) throw error;
      }
      signal.throwIfAborted();
    },
  };
}
