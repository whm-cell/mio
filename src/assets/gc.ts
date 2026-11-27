import { createId } from '@mio/foundation/identifiers';
import type { AccountDomainStore } from '../account-deletion/domain-store.ts';
import type { AssetObjectStore } from './contracts.ts';

/** The sole formal-object deletion pipe. Staging continues through the existing staging cleaner. */
export function createAssetGc(
  store: AccountDomainStore,
  objects: AssetObjectStore,
  deleteEnabled: boolean,
) {
  const enqueue = async (
    owner: string,
    keys: readonly string[],
    manifest?: { key: string; etag: string; sha256: string },
  ) => {
    if (
      keys.length > 4097 ||
      keys.some(
        (key) => !/^mio\/(raw|derived|media)\/[A-Za-z0-9/_ .-]+$/.test(key) || key.includes('..'),
      ) ||
      (manifest && !keys.includes(manifest.key))
    )
      throw new Error('ASSET_GC_KEY_INVALID');
    const unique = [...new Set(keys)].sort();
    if (!unique.length) return;
    // One manifest and all members become eligible atomically. A crash cannot expose a partial key set to GC.
    await store.transaction(owner, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('mio:asset-gc:'||k,0)) FROM unnest($1::text[]) k ORDER BY k",
        [unique],
      );
      if (
        manifest &&
        (
          await client.query(
            'SELECT 1 FROM mio_asset_gc_objects WHERE object_key=$1 AND source_sha256 IS NOT NULL AND (source_sha256<>$2 OR source_etag<>$3)',
            [manifest.key, manifest.sha256, manifest.etag],
          )
        ).rowCount
      )
        throw new Error('ASSET_GC_SOURCE_CONFLICT');
      await client.query(
        `INSERT INTO mio_asset_gc_objects(object_key,owner_id,state)
        SELECT k,$2,'pending' FROM unnest($1::text[]) k
        ON CONFLICT(object_key) DO UPDATE SET state='pending',lease_id=NULL,lease_until=NULL`,
        [unique, owner],
      );
      await client.query(
        `INSERT INTO mio_asset_gc_requests(owner_id,object_key) SELECT $2,k FROM unnest($1::text[]) k
        ON CONFLICT DO NOTHING`,
        [unique, owner],
      );
      await client.query(
        'UPDATE mio_asset_gc_requests SET settled_at=NULL WHERE object_key=ANY($1::text[])',
        [unique],
      );
      if (manifest)
        await client.query(
          'UPDATE mio_asset_gc_objects SET source_etag=$2,source_sha256=$3 WHERE object_key=$1',
          [manifest.key, manifest.etag, manifest.sha256],
        );
    });
  };
  const knownManifestKeys = async (
    owner: string,
    manifest: { key: string; etag: string; sha256: string },
  ) => {
    const recorded = await store.read(
      `SELECT 1 FROM mio_asset_gc_objects g JOIN mio_asset_gc_requests r USING(object_key)
      WHERE r.owner_id=$1 AND g.object_key=$2 AND g.source_etag=$3 AND g.source_sha256=$4`,
      [owner, manifest.key, manifest.etag, manifest.sha256],
    );
    if (!recorded.length) return;
    const prefix = manifest.key.slice(0, manifest.key.lastIndexOf('/') + 1);
    const keys = await store.read<{ object_key: string }>(
      `SELECT object_key FROM mio_asset_gc_requests
      WHERE owner_id=$1 AND object_key LIKE $2||'%' ORDER BY object_key LIMIT 4098`,
      [owner, prefix],
    );
    if (keys.length > 4097) throw new Error('ASSET_GC_MANIFEST_INVALID');
    return keys.map((row) => row.object_key);
  };
  const collect = async (owner: string, signal: AbortSignal) => {
    if (!deleteEnabled) throw new Error('ASSET_GC_NOT_READY');
    if (!objects.hasPendingWrites) throw new Error('ASSET_GC_WRITE_TRACKING_REQUIRED');
    const rows = await store.read<{ object_key: string }>(
      `SELECT g.object_key FROM mio_asset_gc_requests r
      JOIN mio_asset_gc_objects g ON g.object_key=r.object_key WHERE r.owner_id=$1 AND r.settled_at IS NULL
      AND g.next_attempt_at<=clock_timestamp() AND (g.state='pending' OR (g.state='deleting' AND g.lease_until<=clock_timestamp()))
      ORDER BY r.requested_at,r.object_key LIMIT 10`,
      [owner],
    );
    for (const row of rows) {
      signal.throwIfAborted();
      if (objects.hasPendingWrites(row.object_key)) {
        await store.transaction(owner, async (client) => {
          await client.query(
            "UPDATE mio_asset_gc_objects SET next_attempt_at=clock_timestamp()+interval '1 minute' WHERE object_key=$1 AND state='pending'",
            [row.object_key],
          );
        });
        continue;
      }
      const lease = createId();
      const claimed = await store.transaction(owner, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('mio:asset-gc:'||$1,0))",
          [row.object_key],
        );
        const item = (
          await client.query<{ state: string; leased: boolean; due: boolean }>(
            'SELECT state,next_attempt_at<=clock_timestamp() AS due,lease_until>clock_timestamp() AS leased FROM mio_asset_gc_objects WHERE object_key=$1 FOR UPDATE',
            [row.object_key],
          )
        ).rows[0];
        if (
          !item ||
          !item.due ||
          !['pending', 'deleting'].includes(item.state) ||
          (item.state === 'deleting' && item.leased)
        )
          return false;
        const refs = (
          await client.query<{ count: string; legal: string }>(
            `SELECT
          (SELECT count(*) FROM mio_assets a JOIN mio_asset_holders h ON h.asset_id=a.id AND h.owner_id=a.owner_id WHERE a.raw_key=$1) AS count,
          (SELECT count(*) FROM mio_assets a WHERE a.raw_key=$1
            AND NOT EXISTS(SELECT 1 FROM mio_closed_accounts c WHERE c.user_id=a.owner_id)) AS legal`,
            [row.object_key],
          )
        ).rows[0]!;
        if (refs.legal !== '0') {
          await client.query(
            `UPDATE mio_asset_gc_objects SET state='retained',retained_reason='independent_holder',retained_refs=$2
            WHERE object_key=$1`,
            [row.object_key, Number(refs.legal)],
          );
          await client.query(
            `UPDATE mio_asset_gc_requests SET settled_at=clock_timestamp(),retained_at=clock_timestamp(),retained_refs=$2
            WHERE object_key=$1`,
            [row.object_key, Number(refs.legal)],
          );
          return false;
        }
        if (refs.count !== '0') {
          await client.query(
            "UPDATE mio_asset_gc_objects SET next_attempt_at=clock_timestamp()+interval '1 minute' WHERE object_key=$1",
            [row.object_key],
          );
          return false;
        }
        await client.query(
          `UPDATE mio_asset_gc_objects SET state='deleting',lease_id=$2,
          lease_until=clock_timestamp()+interval '30 seconds' WHERE object_key=$1`,
          [row.object_key, lease],
        );
        return true;
      });
      if (!claimed) continue;
      // No connection or transaction is retained during potentially slow object I/O.
      try {
        await objects.delete(row.object_key, signal);
        signal.throwIfAborted();
        let absent = false;
        try {
          await objects.head(row.object_key, signal);
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode === 404) absent = true;
          else throw error;
        }
        if (!absent) throw new Error('ASSET_GC_DELETE_UNCONFIRMED');
        await store.transaction(owner, async (client) => {
          await client.query(
            `WITH deleted AS(UPDATE mio_asset_gc_objects SET state='deleted',deleted_at=clock_timestamp(),lease_id=NULL,lease_until=NULL,attempts=0,error_code=NULL
          WHERE object_key=$1 AND lease_id=$2 AND lease_until>clock_timestamp() RETURNING object_key)
          UPDATE mio_asset_gc_requests SET settled_at=clock_timestamp() WHERE object_key IN(SELECT object_key FROM deleted)`,
            [row.object_key, lease],
          );
        });
      } catch (error) {
        await store.transaction(owner, async (client) => {
          await client.query(
            `UPDATE mio_asset_gc_objects SET state='pending',lease_id=NULL,lease_until=NULL,
            next_attempt_at=clock_timestamp()+CASE WHEN attempts=0 THEN interval '1 minute' WHEN attempts=1 THEN interval '5 minutes' ELSE interval '15 minutes' END,
            attempts=attempts+1,error_code='ASSET_GC_DELETE_FAILED'
            WHERE object_key=$1 AND lease_id=$2 AND lease_until>clock_timestamp()`,
            [row.object_key, lease],
          );
        });
        throw error;
      }
    }
    const remaining = (
      await store.read<{ remaining: number }>(
        `SELECT count(*)::integer AS remaining FROM
      (SELECT 1 FROM mio_asset_gc_requests WHERE owner_id=$1 AND settled_at IS NULL LIMIT 101) pending`,
        [owner],
      )
    )[0]!.remaining;
    return { done: remaining === 0, remaining };
  };
  return { enqueue, collect, deleteEnabled, knownManifestKeys };
}
export type AssetGc = ReturnType<typeof createAssetGc>;
