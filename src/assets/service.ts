import { randomUUID } from 'node:crypto';
import { AssetError, MAX_ASSET_BYTES } from './contracts.ts';
import type { AssetObjectStore, AssetPrincipal } from './contracts.ts';
import type { AssetRow, AssetStore } from './store.ts';

function view(row: AssetRow, objects: AssetObjectStore) {
  return {
    assetId: row.id,
    status: row.state !== 'ready' && row.upload_expired ? 'expired' : row.state,
    filename: row.filename,
    contentType: row.content_type,
    size: Number(row.size_bytes),
    createdAt: row.created_at.toISOString(),
    ...(row.state === 'ready' && row.raw_key
      ? { downloadUrl: objects.downloadUrl(row.raw_key) }
      : {}),
  };
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('statusCode' in error)) return;
  return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

/** Serial cleanup bounds each pass and deletes only stored, expired staging keys. */
export function createAssetService(store: AssetStore, objects: AssetObjectStore) {
  const active = new Set<Promise<unknown>>();
  const stop = new AbortController();
  let cleanup: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let stopping = false;
  const admit = <T>(work: () => Promise<T>): Promise<T> => {
    if (stopping) throw new AssetError(503, 'ASSET_UNAVAILABLE');
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
  const waitObject = <T>(start: () => Promise<T>): Promise<T> => {
    if (stop.signal.aborted) return Promise.reject(new AssetError(503, 'ASSET_UNAVAILABLE'));
    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        clearTimeout(deadline);
        stop.signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        finish();
        reject(new AssetError(503, 'ASSET_UNAVAILABLE'));
      };
      const deadline = setTimeout(() => {
        finish();
        reject(new Error('ASSET_OBJECT_TIMEOUT'));
      }, 180_000);
      stop.signal.addEventListener('abort', abort, { once: true });
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
  const clean = () => {
    if (stopping) return Promise.resolve();
    if (cleanup) return cleanup;
    cleanup = (async () => {
      for (const row of await store.expiredStaging()) {
        if (stopping) break;
        try {
          if (row.staging_key !== `mio/staging/${row.id}`) {
            console.error('ASSET_STAGING_KEY_INVALID');
            continue;
          }
          await waitObject(() => objects.delete(row.staging_key));
          await store.stagingDeleted(row.id, row.staging_key);
        } catch {
          console.error('ASSET_STAGING_CLEANUP_FAILED');
        }
      }
    })().finally(() => {
      cleanup = undefined;
    });
    return cleanup;
  };
  const timer = setInterval(
    () => void clean().catch(() => console.error('ASSET_CLEANUP_FAILED')),
    60_000,
  );
  timer.unref();
  void clean().catch(() => console.error('ASSET_CLEANUP_FAILED'));

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
          throw new AssetError(400, 'ASSET_INPUT_INVALID');
        const id = randomUUID();
        const row = await store.create(id, actor.userId, filename, contentType, size);
        if (row.staging_key !== `mio/staging/${id}`) throw new AssetError(503, 'ASSET_UNAVAILABLE');
        if (stop.signal.aborted) throw new AssetError(503, 'ASSET_UNAVAILABLE');
        return {
          assetId: id,
          uploadUrl: objects.uploadUrl(`mio/staging/${id}`, size),
          expiresIn: 300,
        };
      });
    },
    get(actor: AssetPrincipal, id: string) {
      return admit(async () => {
        const row = await store.owned(id, actor.userId);
        if (stop.signal.aborted) throw new AssetError(503, 'ASSET_UNAVAILABLE');
        return view(row, objects);
      });
    },
    complete(actor: AssetPrincipal, id: string) {
      return admit(async () => {
        let row = await store.owned(id, actor.userId);
        if (stop.signal.aborted) throw new AssetError(503, 'ASSET_UNAVAILABLE');
        if (row.state === 'ready') return view(row, objects);
        if (row.state === 'expired' || row.upload_expired)
          throw new AssetError(409, 'ASSET_EXPIRED');
        const stagingKey = `mio/staging/${id}`;
        if (row.staging_key !== stagingKey) throw new AssetError(503, 'ASSET_UNAVAILABLE');
        let head: { size: number; etag: string };
        try {
          head = await waitObject(() => objects.head(stagingKey));
        } catch (error) {
          if (statusCode(error) === 404) throw new AssetError(409, 'ASSET_UPLOAD_NOT_FOUND');
          throw new AssetError(503, 'ASSET_STORAGE_UNAVAILABLE');
        }
        if (head.size !== Number(row.size_bytes) || head.size > MAX_ASSET_BYTES)
          throw new AssetError(409, 'ASSET_SIZE_MISMATCH');
        if (row.source_etag && row.source_etag !== head.etag)
          throw new AssetError(409, 'ASSET_SOURCE_CHANGED');
        const lease = randomUUID();
        const claimed = await store.claim(id, actor.userId, head.etag, lease);
        if (!claimed) {
          row = await store.owned(id, actor.userId);
          if (row.state === 'ready') return view(row, objects);
          if (row.upload_expired || row.state === 'expired')
            throw new AssetError(409, 'ASSET_EXPIRED');
          if (row.source_etag && row.source_etag !== head.etag)
            throw new AssetError(409, 'ASSET_SOURCE_CHANGED');
          throw new AssetError(409, 'ASSET_BUSY');
        }
        if (claimed.staging_key !== stagingKey) {
          await store.release(id, lease).catch(() => {});
          throw new AssetError(503, 'ASSET_UNAVAILABLE');
        }
        const rawKey = `mio/raw/${id}/${randomUUID()}`;
        try {
          await waitObject(() => objects.copy(stagingKey, rawKey, head.etag));
        } catch (error) {
          await store.release(id, lease).catch(() => {});
          if (statusCode(error) === 412) throw new AssetError(409, 'ASSET_SOURCE_CHANGED');
          throw new AssetError(503, 'ASSET_STORAGE_UNAVAILABLE');
        }
        const saved = await store.commit(id, actor.userId, lease, rawKey);
        if (saved) return view(saved, objects);
        row = await store.owned(id, actor.userId);
        if (row.state === 'ready') return view(row, objects);
        throw new AssetError(409, 'ASSET_FINALIZE_SUPERSEDED');
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
