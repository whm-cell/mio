import type { AccountDomainStore } from '../account-deletion/domain-store.ts';
import type { AssetGc } from './gc.ts';

export function releaseDeletedAccountHolds(store: AccountDomainStore, owner: string) {
  return store.batch(owner, 'asset-holds', async (client) => {
    await client.query(
      `DELETE FROM mio_asset_holders WHERE ctid IN
      (SELECT ctid FROM mio_asset_holders WHERE owner_id=$1 LIMIT 100)`,
      [owner],
    );
    return Number(
      (
        await client.query<{ count: string }>(
          'SELECT count(*) FROM mio_asset_holders WHERE owner_id=$1',
          [owner],
        )
      ).rows[0]!.count,
    );
  });
}

export async function collectDeletedAccountAssets(
  store: AccountDomainStore,
  gc: AssetGc,
  owner: string,
  finalizedAt: Date,
  signal: AbortSignal,
  cleanStaging: () => Promise<void>,
  drain: () => Promise<void>,
) {
  await drain();
  const cutoff = new Date(finalizedAt.getTime() + 300_000);
  await store.transaction(owner, async (client) => {
    await client.query(
      `UPDATE mio_assets SET expires_at=LEAST(expires_at,clock_timestamp())
      WHERE id IN (SELECT id FROM mio_assets WHERE owner_id=$1 AND staging_key LIKE 'mio/staging/%'
        AND expires_at>clock_timestamp() ORDER BY id LIMIT 100)`,
      [owner],
    );
    // Keep each staging locator until a deletion after the original five-minute PUT window.
    await client.query(
      `UPDATE mio_assets SET staging_deleted_at=NULL WHERE id IN
      (SELECT id FROM mio_assets WHERE owner_id=$1 AND staging_key LIKE 'mio/staging/%'
       AND staging_deleted_at<$2 AND $2::timestamptz<=clock_timestamp() ORDER BY id LIMIT 100)`,
      [owner, cutoff],
    );
  });
  const candidates = await store.read<{ key: string }>(
    `SELECT raw_key AS key FROM mio_assets a WHERE owner_id=$1 AND raw_key IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM mio_asset_gc_requests r WHERE r.owner_id=$1 AND r.object_key=a.raw_key) LIMIT 100`,
    [owner],
  );
  const held = await store.read<{ key: string }>(
    `SELECT object_key AS key FROM mio_asset_gc_objects g WHERE owner_id=$1 AND state='held'
    AND NOT EXISTS(SELECT 1 FROM mio_asset_gc_requests r WHERE r.owner_id=$1 AND r.object_key=g.object_key) LIMIT 100`,
    [owner],
  );
  await gc.enqueue(
    owner,
    [...candidates, ...held].map((row) => row.key),
  );
  await cleanStaging();
  signal.throwIfAborted();
  if (
    !(
      await store.read<{ due: boolean }>('SELECT clock_timestamp()>=$1::timestamptz AS due', [
        cutoff,
      ])
    )[0]!.due
  )
    return { done: false, remaining: 1 };
  const staging = (
    await store.read<{ count: string }>(
      `SELECT count(*) FROM mio_assets WHERE owner_id=$1
    AND staging_key LIKE 'mio/staging/%' AND (staging_deleted_at IS NULL OR staging_deleted_at<$2)`,
      [owner, cutoff],
    )
  )[0]!.count;
  if (staging !== '0') return { done: false, remaining: Number(staging) };
  const result = await gc.collect(owner, signal);
  const missing =
    Number(
      (
        await store.read<{ count: string }>(
          `SELECT count(*) FROM mio_assets a WHERE owner_id=$1 AND raw_key IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM mio_asset_gc_requests r WHERE r.owner_id=$1 AND r.object_key=a.raw_key)`,
          [owner],
        )
      )[0]!.count,
    ) +
    Number(
      (
        await store.read<{ count: string }>(
          `SELECT count(*) FROM mio_asset_gc_objects g WHERE owner_id=$1 AND state='held'
    AND NOT EXISTS(SELECT 1 FROM mio_asset_gc_requests r WHERE r.owner_id=$1 AND r.object_key=g.object_key)`,
          [owner],
        )
      )[0]!.count,
    );
  return { done: result.done && missing === 0, remaining: result.remaining + missing };
}

export function deleteAssetAccountRows(store: AccountDomainStore, owner: string) {
  return store.batch(owner, 'assets', async (client) => {
    await client.query(
      'DELETE FROM mio_asset_derivative_intents WHERE asset_id IN (SELECT id FROM mio_assets WHERE owner_id=$1 ORDER BY id LIMIT 100)',
      [owner],
    );
    await client.query(
      `DELETE FROM mio_assets WHERE id IN (SELECT a.id FROM mio_assets a WHERE a.owner_id=$1
      AND NOT EXISTS(SELECT 1 FROM mio_asset_holders h WHERE h.asset_id=a.id)
      AND (a.staging_key IS NULL OR a.staging_deleted_at IS NOT NULL)
      AND (a.raw_key IS NULL OR EXISTS(SELECT 1 FROM mio_asset_gc_objects g WHERE g.object_key=a.raw_key AND g.state='deleted'))
      ORDER BY a.id LIMIT 100)`,
      [owner],
    );
    const remaining = Number(
      (
        await client.query<{ count: string }>('SELECT count(*) FROM mio_assets WHERE owner_id=$1', [
          owner,
        ])
      ).rows[0]!.count,
    );
    if (!remaining) {
      await client.query('DELETE FROM mio_storage_objects WHERE owner_id=$1', [owner]);
      await client.query('DELETE FROM mio_storage_usage WHERE owner_id=$1', [owner]);
    }
    return remaining;
  });
}
