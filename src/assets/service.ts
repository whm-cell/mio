import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { createId } from '@mio/foundation/identifiers';
import { createHash } from 'node:crypto';
import { HLS_PLAYLIST_CONTENT_TYPE } from '../compute/media-hls.ts';
import { isValidImageAssetObjectKey } from '../generations/contracts.ts';
import {
  AssetError,
  MAX_ASSET_BYTES,
  MAX_VISION_SOURCE_BYTES,
  MAX_MATERIAL_SOURCE_BYTES,
} from './contracts.ts';
import type {
  AssetObjectStore,
  AssetPrincipal,
  VisionSource,
  MaterialImageSource,
} from './contracts.ts';
import type { AssetRow, AssetStore } from './store.ts';

const log = createLogger('app', 'assets');
const playableAudio = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
]);

function view(row: AssetRow, objects: AssetObjectStore) {
  const rawKey = row.state === 'ready' ? row.raw_key : null;
  const hlsObject =
    rawKey?.startsWith('mio/media/') &&
    [HLS_PLAYLIST_CONTENT_TYPE, 'video/mp2t'].includes(row.content_type);
  return {
    assetId: row.id,
    status: row.state !== 'ready' && row.upload_expired ? 'expired' : row.state,
    filename: row.filename,
    contentType: row.content_type,
    size: Number(row.size_bytes),
    createdAt: row.created_at.toISOString(),
    ...(rawKey && !hlsObject ? { downloadUrl: objects.downloadUrl(rawKey) } : {}),
    ...(rawKey && objects.audioPlaybackUrl && playableAudio.has(row.content_type.toLowerCase())
      ? { playbackUrl: objects.audioPlaybackUrl(rawKey, row.content_type) }
      : {}),
  };
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('statusCode' in error)) return;
  return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

/** Serial cleanup bounds each pass and deletes only stored, expired staging keys. */
export function createAssetService(store: AssetStore, objects: AssetObjectStore) {
  const present = async (
    row: AssetRow,
  ): Promise<
    ReturnType<typeof view> & {
      derivatives?: Awaited<ReturnType<AssetStore['derivativeView']>>;
    }
  > => {
    const base = view(row, objects);
    if (
      row.state !== 'ready' ||
      !row.raw_key?.startsWith(`mio/raw/${row.id}/`) ||
      !row.content_type.toLowerCase().startsWith('video/')
    )
      return base;
    return { ...base, derivatives: await store.derivativeView(row.id, row.owner_id) };
  };
  const active = new Set<Promise<unknown>>();
  const stop = new AbortController();
  let cleanup: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let stopping = false;
  const admit = <T>(work: () => Promise<T>): Promise<T> => {
    if (stopping) throw new AssetError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE');
    const action = work();
    active.add(action);
    void action.then(
      () => active.delete(action),
      () => active.delete(action),
    );
    return action;
  };
  // The SDK does not expose cancellation for these calls. Stop waiting after the drain
  // deadline; a late copy has a unique key and cannot register through this operation.
  const waitObject = <T>(start: () => Promise<T>, signal = stop.signal): Promise<T> => {
    if (signal.aborted)
      return Promise.reject(new AssetError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE'));
    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        clearTimeout(deadline);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        finish();
        reject(new AssetError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE'));
      };
      const deadline = setTimeout(() => {
        finish();
        reject(new Error('ASSET_OBJECT_TIMEOUT'));
      }, 180_000);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(start)
        .then(
          (value) => {
            finish();
            resolve(value);
          },
          (error: unknown) => {
            finish();
            reject(error);
          },
        );
    });
  };
  const readOwnedImage = async (
    ownerId: string,
    id: string,
    maxBytes: number,
    expected: { etagDigest: string; sourceDigest: string } | undefined,
    signal: AbortSignal,
  ): Promise<MaterialImageSource> => {
    const combined = AbortSignal.any([signal, stop.signal, AbortSignal.timeout(60_000)]);
    combined.throwIfAborted();
    const row = await store.owned(id, ownerId);
    const size = Number(row.size_bytes);
    if (
      row.state !== 'ready' ||
      !row.raw_key ||
      !isValidImageAssetObjectKey(id, row.raw_key, row.content_type)
    )
      throw new AssetError(HTTP_STATUS.NOT_FOUND, 'ASSET_NOT_FOUND');
    if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes)
      throw new AssetError(HTTP_STATUS.BAD_REQUEST, 'ASSET_INPUT_INVALID');
    if (!objects.readImage)
      throw new AssetError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_STORAGE_UNAVAILABLE');
    let head: Awaited<ReturnType<AssetObjectStore['head']>>;
    let data: Uint8Array;
    try {
      head = await waitObject(() => objects.head(row.raw_key!), combined);
      combined.throwIfAborted();
      if (
        head.size !== size ||
        !head.etag ||
        head.etag.length > 256 ||
        /[\x00-\x1f\x7f]/.test(head.etag)
      )
        throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SIZE_MISMATCH');
      const etagDigest = createHash('sha256').update(head.etag).digest('hex');
      if (expected && expected.etagDigest !== etagDigest)
        throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SOURCE_CHANGED');
      data = await waitObject(
        () => objects.readImage!(row.raw_key!, head.etag, size, combined),
        combined,
      );
      combined.throwIfAborted();
      if (data.byteLength !== size)
        throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SIZE_MISMATCH');
      const sourceDigest = createHash('sha256').update(data).digest('hex');
      if (expected && expected.sourceDigest !== sourceDigest)
        throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SOURCE_CHANGED');
      const current = await store.owned(id, ownerId);
      if (
        current.state !== 'ready' ||
        current.raw_key !== row.raw_key ||
        current.size_bytes !== row.size_bytes ||
        current.content_type !== row.content_type
      )
        throw new AssetError(HTTP_STATUS.NOT_FOUND, 'ASSET_NOT_FOUND');
      return {
        rawKey: row.raw_key,
        rawEtag: head.etag,
        size,
        assetId: id,
        contentType: row.content_type as VisionSource['contentType'],
        data,
        etagDigest,
        sourceDigest,
      };
    } catch (error) {
      if (error instanceof AssetError) throw error;
      if (statusCode(error) === 412)
        throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SOURCE_CHANGED');
      throw new AssetError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_STORAGE_UNAVAILABLE');
    }
  };
  let cleanupCursor: { expires_at: string; id: string } | undefined;
  const clean = () => {
    if (stopping) return Promise.resolve();
    if (cleanup) return cleanup;
    cleanup = (async () => {
      const rows = await store.expiredStaging(cleanupCursor);
      if (!rows.length) cleanupCursor = undefined;
      for (const row of rows) {
        if (stopping) break;
        cleanupCursor = { expires_at: row.expires_at, id: row.id };
        try {
          if (row.staging_key !== `mio/staging/${row.id}`) {
            log.error('ASSET_STAGING_KEY_INVALID');
            continue;
          }
          await waitObject(() => objects.delete(row.staging_key));
          await store.stagingDeleted(row.id, row.staging_key);
        } catch {
          log.error('ASSET_STAGING_CLEANUP_FAILED');
        }
      }
    })().finally(() => {
      cleanup = undefined;
    });
    return cleanup;
  };
  const timer = setInterval(
    () => void clean().catch(() => log.error('ASSET_CLEANUP_FAILED')),
    60_000,
  );
  timer.unref();
  void clean().catch(() => log.error('ASSET_CLEANUP_FAILED'));

  return {
    create(actor: AssetPrincipal, filename: string, contentType: string, size: number) {
      return admit(async () => {
        if (
          !filename.trim() ||
          Buffer.byteLength(filename) > 255 ||
          /[\x00-\x1f\x7f]/.test(filename) ||
          !/^[\w.+-]+\/[\w.+-]+$/.test(contentType) ||
          contentType.length > 127 ||
          !Number.isSafeInteger(size) ||
          size < 1 ||
          size > MAX_ASSET_BYTES
        )
          throw new AssetError(HTTP_STATUS.BAD_REQUEST, 'ASSET_INPUT_INVALID');
        const id = createId();
        const row = await store.create(id, actor.userId, filename, contentType, size);
        if (row.staging_key !== `mio/staging/${id}`)
          throw new AssetError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE');
        if (stop.signal.aborted)
          throw new AssetError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE');
        const audio = playableAudio.has(contentType.toLowerCase());
        const stagingKey = `mio/staging/${id}`;
        return {
          assetId: id,
          uploadUrl: audio
            ? objects.uploadUrl(stagingKey, size, 'private')
            : objects.uploadUrl(stagingKey, size),
          expiresIn: 300,
          ...(audio ? { uploadHeaders: { 'x-cos-acl': 'private' as const } } : {}),
        };
      });
    },
    get(actor: AssetPrincipal, id: string) {
      return admit(async () => {
        const row = await store.owned(id, actor.userId);
        if (stop.signal.aborted)
          throw new AssetError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE');
        return present(row);
      });
    },
    readVisionSource(
      ownerId: string,
      id: string,
      expected: { etagDigest: string; sourceDigest: string } | undefined,
      signal: AbortSignal,
    ): Promise<VisionSource> {
      return admit(async () => {
        const {
          rawKey: _key,
          rawEtag: _etag,
          size: _size,
          ...source
        } = await readOwnedImage(ownerId, id, MAX_VISION_SOURCE_BYTES, expected, signal);
        void _key;
        void _etag;
        void _size;
        return source;
      });
    },
    readMaterialSource(
      ownerId: string,
      id: string,
      signal: AbortSignal,
    ): Promise<MaterialImageSource> {
      return admit(() => readOwnedImage(ownerId, id, MAX_MATERIAL_SOURCE_BYTES, undefined, signal));
    },
    materialUrl(
      ownerId: string,
      source: MaterialImageSource,
      signal: AbortSignal,
    ): Promise<string> {
      return admit(async () => {
        signal.throwIfAborted();
        const row = await store.owned(source.assetId, ownerId);
        if (
          row.state !== 'ready' ||
          row.raw_key !== source.rawKey ||
          Number(row.size_bytes) !== source.size ||
          row.content_type !== source.contentType
        )
          throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SOURCE_CHANGED');
        if (!objects.materialUrl)
          throw new AssetError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_STORAGE_UNAVAILABLE');
        const combined = AbortSignal.any([signal, stop.signal, AbortSignal.timeout(60_000)]);
        const head = await waitObject(() => objects.head(source.rawKey), combined);
        if (head.etag !== source.rawEtag || head.size !== source.size)
          throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SOURCE_CHANGED');
        combined.throwIfAborted();
        return objects.materialUrl(source.rawKey);
      });
    },
    complete(actor: AssetPrincipal, id: string) {
      return admit(async () => {
        let row = await store.owned(id, actor.userId);
        if (stop.signal.aborted)
          throw new AssetError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE');
        if (row.state === 'ready') return present(row);
        if (row.state === 'expired' || row.upload_expired)
          throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_EXPIRED');
        const stagingKey = `mio/staging/${id}`;
        if (row.staging_key !== stagingKey)
          throw new AssetError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE');
        let head: { size: number; etag: string };
        try {
          head = await waitObject(() => objects.head(stagingKey));
        } catch (error) {
          if (statusCode(error) === 404)
            throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_UPLOAD_NOT_FOUND');
          throw new AssetError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_STORAGE_UNAVAILABLE');
        }
        if (head.size !== Number(row.size_bytes) || head.size > MAX_ASSET_BYTES)
          throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SIZE_MISMATCH');
        if (row.source_etag && row.source_etag !== head.etag)
          throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SOURCE_CHANGED');
        const lease = createId();
        const claimed = await store.claim(id, actor.userId, head.etag, lease);
        if (!claimed) {
          row = await store.owned(id, actor.userId);
          if (row.state === 'ready') return present(row);
          if (row.upload_expired || row.state === 'expired')
            throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_EXPIRED');
          if (row.source_etag && row.source_etag !== head.etag)
            throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SOURCE_CHANGED');
          throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_BUSY');
        }
        if (claimed.staging_key !== stagingKey) {
          await store.release(id, lease).catch(() => {});
          throw new AssetError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE');
        }
        const rawKey = `mio/raw/${id}/${createId()}`;
        try {
          if (playableAudio.has(claimed.content_type.toLowerCase())) {
            const ensurePrivate = objects.ensureAudioPrivate;
            if (!ensurePrivate)
              throw new AssetError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_STORAGE_UNAVAILABLE');
            await waitObject(() =>
              ensurePrivate(stagingKey, { sizeBytes: head.size, etag: head.etag }, stop.signal),
            );
            await waitObject(() => objects.copy(stagingKey, rawKey, head.etag, 'private'));
          } else {
            await waitObject(() => objects.copy(stagingKey, rawKey, head.etag));
          }
        } catch (error) {
          await store.release(id, lease).catch(() => {});
          if (statusCode(error) === 412)
            throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SOURCE_CHANGED');
          throw new AssetError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_STORAGE_UNAVAILABLE');
        }
        const saved = await store.commit(id, actor.userId, lease, rawKey);
        if (saved) return present(saved);
        row = await store.owned(id, actor.userId);
        if (row.state === 'ready') return present(row);
        throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_FINALIZE_SUPERSEDED');
      });
    },
    clean,
    close(): Promise<void> {
      if (closing) return closing;
      stopping = true;
      clearInterval(timer);
      closing = (async () => {
        const deadline = setTimeout(() => stop.abort(), 5000);
        try {
          await Promise.allSettled([...active, ...(cleanup ? [cleanup] : [])]);
        } finally {
          clearTimeout(deadline);
          await store.close();
        }
      })();
      return closing;
    },
  };
}
