import sharp from 'sharp';
import { sha256Bytes, sha256Utf8 } from '@mio/foundation/hash';
import { AssetError, MAX_ASSET_BYTES, waitForObjectHead } from './contracts.ts';
import type { AssetObjectStore, AssetPrincipal } from './contracts.ts';
import type { AssetRow, AssetStore } from './store.ts';

const MAX_GIF_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const STATIC_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// One decode across service instances in this process. No waiting queue or retained input backlog.
let normalizing = false;

function derivedId(sourceId: string) {
  const hash = sha256Utf8(`mio/avatar/v1:${sourceId}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function firstFrame(input: Buffer) {
  const invalid = () => new AssetError(400, 'ASSET_INPUT_INVALID');
  if (input.length < 13 || !['GIF87a', 'GIF89a'].includes(input.toString('ascii', 0, 6)))
    throw invalid();
  const width = input.readUInt16LE(6),
    height = input.readUInt16LE(8);
  if (!width || !height || width > 8192 || height > 8192 || width * height > MAX_PIXELS)
    throw invalid();
  try {
    const image = sharp(input, {
      pages: 1,
      failOn: 'warning',
      limitInputPixels: MAX_PIXELS,
    }).timeout({ seconds: 15 });
    const meta = await image.metadata();
    if (
      meta.format !== 'gif' ||
      meta.width !== width ||
      (meta.pageHeight ?? meta.height) !== height
    )
      throw invalid();
    const output = await image
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    if (!output.length || output.length > 2 * 1024 * 1024) throw invalid();
    return output;
  } catch {
    throw invalid();
  }
}

function statusCode(error: unknown) {
  return (error as { statusCode?: unknown } | null)?.statusCode;
}

/** Narrow avatar reads never invoke generic download signing or derivative/job services. */
export function createAvatarOperations(
  store: AssetStore,
  objects: AssetObjectStore,
  stop: AbortSignal,
) {
  const wait = <T>(read: () => Promise<T>, signal: AbortSignal) => waitForObjectHead(read, signal);
  const ready = (row: AssetRow, types: ReadonlySet<string>, maxBytes: number) => {
    if (row.state !== 'ready' || !row.raw_key) throw new AssetError(409, 'ASSET_NOT_READY');
    if (
      !types.has(row.content_type.toLowerCase()) ||
      !Number.isSafeInteger(Number(row.size_bytes)) ||
      Number(row.size_bytes) < 1 ||
      Number(row.size_bytes) > maxBytes
    )
      throw new AssetError(400, 'ASSET_INPUT_INVALID');
  };
  const head = async (row: AssetRow, signal: AbortSignal) => {
    const value = await wait(() => objects.head(row.raw_key!, signal), signal);
    if (
      value.size !== Number(row.size_bytes) ||
      !value.etag ||
      value.etag.length > 256 ||
      /[\x00-\x1f\x7f]/.test(value.etag)
    )
      throw new AssetError(409, 'ASSET_SIZE_MISMATCH');
    if (value.contentType?.toLowerCase() !== row.content_type.toLowerCase())
      throw new AssetError(400, 'ASSET_INPUT_INVALID');
    return value;
  };
  const verify = async (owner: AssetPrincipal, id: string) => {
    stop.throwIfAborted();
    const row = await store.owned(id, owner.userId);
    ready(row, STATIC_TYPES, MAX_ASSET_BYTES);
    await head(row, AbortSignal.any([stop, AbortSignal.timeout(5000)]));
    return row;
  };
  return {
    async verifyAvatar(
      owner: AssetPrincipal,
      id: string,
    ): Promise<'ok' | 'not_found' | 'not_ready' | 'invalid_type' | 'unavailable'> {
      try {
        await verify(owner, id);
        return 'ok';
      } catch (error) {
        if (error instanceof AssetError) {
          if (error.status === 404) return 'not_found';
          if (error.status === 409) return 'not_ready';
          if (error.status === 400) return 'invalid_type';
        }
        if (statusCode(error) === 404) return 'not_ready';
        return 'unavailable';
      }
    },
    async avatarUrl(owner: AssetPrincipal, id: string): Promise<string | null> {
      try {
        const row = await verify(owner, id);
        return objects.avatarInlineUrl?.(row.raw_key!, row.content_type.toLowerCase()) ?? null;
      } catch {
        return null;
      }
    },
    async normalizeAvatar(
      owner: AssetPrincipal,
      sourceId: string,
    ): Promise<{ avatarAssetId: string }> {
      try {
        stop.throwIfAborted();
        const source = await store.owned(sourceId, owner.userId);
        ready(source, new Set(['image/gif']), MAX_GIF_BYTES);
        const id = derivedId(sourceId),
          key = `mio/raw/${id}/${id}`;
        const filename = `avatar-${sourceId}.webp`;
        let existing: AssetRow | undefined;
        try {
          existing = await store.owned(id, owner.userId);
        } catch (error) {
          if (!(error instanceof AssetError && error.status === 404)) throw error;
        }
        if (existing) {
          if (
            existing.state !== 'ready' ||
            existing.raw_key !== key ||
            existing.content_type !== 'image/webp' ||
            existing.filename !== filename
          )
            throw new AssetError(409, 'ASSET_SOURCE_CHANGED');
          return { avatarAssetId: id };
        }
        if (normalizing) throw new AssetError(503, 'ASSET_BUSY');
        if (!objects.readImage || !objects.putImage)
          throw new AssetError(503, 'ASSET_STORAGE_UNAVAILABLE');
        normalizing = true;
        try {
          const signal = AbortSignal.any([stop, AbortSignal.timeout(60_000)]);
          const current = await head(source, signal);
          const bytes = await wait(
            () =>
              objects.readImage!(source.raw_key!, current.etag, Number(source.size_bytes), signal),
            signal,
          );
          if (bytes.byteLength !== Number(source.size_bytes))
            throw new AssetError(409, 'ASSET_SIZE_MISMATCH');
          const output = await firstFrame(
            Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          );
          signal.throwIfAborted();
          const sha256 = sha256Bytes(output);
          // Immutable deterministic key: reconcile interrupted/competing PUTs before publishing metadata.
          const checkOutput = (value: Awaited<ReturnType<AssetObjectStore['head']>>) => {
            if (
              value.size !== output.length ||
              value.sha256 !== sha256 ||
              value.contentType !== 'image/webp' ||
              !value.etag
            )
              throw new AssetError(409, 'ASSET_SOURCE_CHANGED');
            return value;
          };
          let published: Awaited<ReturnType<AssetObjectStore['head']>> | undefined;
          try {
            published = checkOutput(await wait(() => objects.head(key, signal), signal));
          } catch (error) {
            if (statusCode(error) !== 404) throw error;
          }
          if (!published) {
            await store.rememberObject(owner.userId, key);
            try {
              const value = await wait(
                () => objects.putImage!(key, output, 'webp', sha256, signal, 'private'),
                signal,
              );
              if (value.key !== key) throw new AssetError(409, 'ASSET_SOURCE_CHANGED');
              published = checkOutput({ size: value.sizeBytes, ...value });
            } catch {
              signal.throwIfAborted();
              published = checkOutput(await wait(() => objects.head(key, signal), signal));
            }
          }
          signal.throwIfAborted();
          await store.publishAvatar(source, {
            assetId: id,
            key,
            filename,
            sizeBytes: output.length,
            etag: published.etag,
          });
          return { avatarAssetId: id };
        } finally {
          normalizing = false;
        }
      } catch (error) {
        if (error instanceof AssetError) throw error;
        if (statusCode(error) === 412) throw new AssetError(409, 'ASSET_SOURCE_CHANGED');
        if (statusCode(error) === 404) throw new AssetError(409, 'ASSET_NOT_READY');
        throw new AssetError(503, 'ASSET_STORAGE_UNAVAILABLE');
      }
    },
  };
}
