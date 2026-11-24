import { Pool } from 'pg';
import type { AssetObjectStore } from '../assets/contracts.ts';
import type { VideoAssetReference } from './video-contracts.ts';

/** A signed reference is issued only after rechecking the persisted owner's ready asset. */
export function createVideoInputResolver(databaseURL: string, objects: AssetObjectStore) {
  const pool = new Pool({ connectionString: databaseURL, max: 2 });
  let closing: Promise<void> | undefined;
  return {
    async resolve(
      ownerId: string,
      references: readonly VideoAssetReference[],
      signal: AbortSignal,
    ) {
      const urls: Record<string, string> = {};
      if (!references.length) return urls;
      if (!objects.materialUrl) throw new Error('VIDEO_INPUT_UNAVAILABLE');
      const ids = [...new Set(references.map((input) => input.assetId))];
      const assets = (
        await pool.query<{
          id: string;
          raw_key: string;
          content_type: string;
          size_bytes: string;
        }>(
          `SELECT id,raw_key,content_type,size_bytes FROM mio_assets
          WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND state='ready' AND raw_key IS NOT NULL`,
          [ownerId, ids],
        )
      ).rows;
      for (const reference of references) {
        signal.throwIfAborted();
        const asset = assets.find((item) => item.id === reference.assetId);
        if (!asset) throw new Error('VIDEO_INPUT_UNAVAILABLE');
        const type = asset.content_type.split('/')[0];
        if (
          !['image', 'audio', 'video'].includes(type!) ||
          (reference.mediaType ?? 'image') !== type
        )
          throw new Error('VIDEO_INPUT_INVALID');
        const actual = await objects.head(asset.raw_key);
        if (
          actual.size !== Number(asset.size_bytes) ||
          actual.size < 1 ||
          actual.size > 1024 * 1024 * 1024 ||
          !actual.etag
        )
          throw new Error('VIDEO_INPUT_CHANGED');
        urls[asset.id] = objects.materialUrl(asset.raw_key);
      }
      return urls;
    },
    close() {
      return (closing ??= pool.end());
    },
  };
}
