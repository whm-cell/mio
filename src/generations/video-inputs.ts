import { HTTP_STATUS } from '@mio/foundation/http-status';
import { MAX_ASSET_BYTES } from '../assets/contracts.ts';
import type { AssetObjectStore } from '../assets/contracts.ts';
import type { AssetStore } from '../assets/store.ts';
import { GenerationError } from './errors.ts';
import type { VideoAssetReference } from './video-contracts.ts';
import type { VideoJobCommand } from './video-execution.ts';

/** Resolve only ready objects owned by the requesting user. Sign after all checks pass. */
export function createVideoInputResolver(
  store: Pick<AssetStore, 'readyOwned'>,
  objects: AssetObjectStore,
) {
  const inspect = async (
    ownerId: string,
    references: readonly VideoAssetReference[],
    signal: AbortSignal,
    expected?: VideoJobCommand['inputObjects'],
  ): Promise<NonNullable<VideoJobCommand['inputObjects']>> => {
    if (!references.length) return {};
    signal.throwIfAborted();
    const ids = [...new Set(references.map((input) => input.assetId))];
    const assets = await store.readyOwned(ownerId, ids);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    for (const reference of references) {
      const asset = byId.get(reference.assetId);
      if (!asset) throw new GenerationError(HTTP_STATUS.NOT_FOUND, 'ASSET_NOT_FOUND');
      if (!asset.content_type.startsWith(`${reference.mediaType ?? 'image'}/`))
        throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'VIDEO_INPUT_INVALID');
    }
    if (!objects.materialUrl)
      throw new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'VIDEO_UNAVAILABLE');
    const identities: NonNullable<VideoJobCommand['inputObjects']> = {};
    for (const id of ids) {
      signal.throwIfAborted();
      const asset = byId.get(id)!;
      const head = await objects.head(asset.raw_key).catch((error: unknown) => {
        if ((error as { statusCode?: number } | null)?.statusCode === HTTP_STATUS.NOT_FOUND)
          throw new GenerationError(HTTP_STATUS.CONFLICT, 'VIDEO_INPUT_CHANGED');
        throw error;
      });
      signal.throwIfAborted();
      const frozen = expected?.[id];
      if (
        head.size !== Number(asset.size_bytes) ||
        head.size < 1 ||
        head.size > MAX_ASSET_BYTES ||
        !head.etag ||
        (asset.raw_etag && asset.raw_etag !== head.etag) ||
        (expected && (frozen?.key !== asset.raw_key || frozen.etag !== head.etag))
      )
        throw new GenerationError(HTTP_STATUS.CONFLICT, 'VIDEO_INPUT_CHANGED');
      identities[id] = { key: asset.raw_key, etag: head.etag };
    }
    return identities;
  };
  return {
    inspect,
    async resolve(
      ownerId: string,
      references: readonly VideoAssetReference[],
      signal: AbortSignal,
      expected?: VideoJobCommand['inputObjects'],
    ) {
      const identities = await inspect(ownerId, references, signal, expected);
      return Object.fromEntries(
        Object.entries(identities).map(([id, { key }]) => [id, objects.materialUrl!(key)]),
      );
    },
  };
}
