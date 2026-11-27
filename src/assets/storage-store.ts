import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { createLogger } from '@mio/foundation/logging';
import { checkStorageSchema } from './storage-schema.ts';
import { storageReminderVersion, storageStatus, StorageError } from './storage.ts';
import type { StorageHolder, StoragePolicy, StorageUsage } from './storage.ts';

const log = createLogger('app', 'storage-accounting');
interface UsageRow {
  used_bytes: string;
  object_count: string;
  waterline_epoch: string;
  acknowledged_version: string | null;
  calculated_at: Date;
}
/** One indexed GET. All writes are mutations, explicit migration, acknowledgment or background work. */
export class StorageAccounting {
  private readonly pool: Pool;
  private readonly policy: () => Readonly<StoragePolicy>;
  constructor(pool: Pool, policy: () => Readonly<StoragePolicy>) {
    this.pool = pool;
    this.policy = policy;
  }

  async usage(owner: string): Promise<StorageUsage> {
    const policy = this.policy();
    const { rows } = await this.pool.query<UsageRow>(
      `SELECT COALESCE(u.used_bytes,0)::text AS used_bytes,COALESCE(u.object_count,0)::text AS object_count,
        COALESCE(u.waterline_epoch,0)::text AS waterline_epoch,u.acknowledged_version,
        COALESCE(u.calculated_at,statement_timestamp()) AS calculated_at
       FROM (VALUES($1::text)) AS actor(owner_id) LEFT JOIN mio_storage_usage u USING(owner_id)
       JOIN mio_storage_policy p ON p.singleton AND p.revision=$2
         AND p.quota_bytes=$3 AND p.warning_available_bytes=$4`,
      [owner, policy.revision, policy.quotaBytes, policy.warningAvailableBytes],
    );
    const row = rows[0];
    if (!row) throw new StorageError(503, 'STORAGE_UNAVAILABLE');
    const usedBytes = Number(row.used_bytes),
      objectCount = Number(row.object_count);
    if (!Number.isSafeInteger(usedBytes) || !Number.isSafeInteger(objectCount))
      throw new StorageError(503, 'STORAGE_UNAVAILABLE');
    const status = storageStatus(usedBytes, policy);
    const reminderVersion = storageReminderVersion(status, policy.revision, row.waterline_epoch);
    return {
      quotaBytes: policy.quotaBytes,
      warningAvailableBytes: policy.warningAvailableBytes,
      usedBytes,
      availableBytes: Math.max(0, policy.quotaBytes - usedBytes),
      usageRatio: usedBytes / policy.quotaBytes,
      objectCount,
      status,
      reminderVersion,
      thresholdReminderPending: status !== 'safe' && row.acknowledged_version !== reminderVersion,
      calculatedAt: row.calculated_at.toISOString(),
    };
  }

  async acknowledge(owner: string, version: string): Promise<void> {
    const policy = this.policy();
    // The policy join rejects delayed snapshots; the row predicate also survives a row-lock wait
    // whose statement snapshot still sees an old policy after a newer receipt has committed.
    await this.pool.query(
      `UPDATE mio_storage_usage u SET acknowledged_version=$2 FROM mio_storage_policy p
       WHERE u.owner_id=$1 AND p.singleton AND p.revision=$5
        AND p.quota_bytes=$3 AND p.warning_available_bytes=$4
        AND u.used_bytes>$3::bigint-$4::bigint
        AND $2='storage:v1:'||CASE WHEN u.used_bytes>=$3 THEN 'full' ELSE 'warning' END||':'||$5::text||':'||u.waterline_epoch
        AND (u.acknowledged_version IS NULL OR split_part(u.acknowledged_version,':',4)::bigint<=$5::bigint)
        AND u.acknowledged_version IS DISTINCT FROM $2`,
      [owner, version, policy.quotaBytes, policy.warningAvailableBytes, policy.revision],
    );
  }

  async updatePolicy(): Promise<void> {
    const policy = this.policy();
    await this.pool.query(
      `UPDATE mio_storage_policy SET revision=$1,quota_bytes=$2,warning_available_bytes=$3
       WHERE singleton AND revision<=$1 AND (revision,quota_bytes,warning_available_bytes)
         IS DISTINCT FROM ($1::bigint,$2::bigint,$3::bigint)`,
      [policy.revision, policy.quotaBytes, policy.warningAvailableBytes],
    );
  }

  private async transaction<T>(owner: string, work: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    client.on('error', disconnected);
    function disconnected() {
      /* Rollback and release discard a disconnected transaction. */
    }
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO mio_storage_usage(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
        [owner],
      );
      await client.query('SELECT 1 FROM mio_storage_usage WHERE owner_id=$1 FOR UPDATE', [owner]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.removeListener('error', disconnected);
      client.release();
    }
  }

  private async replace(client: PoolClient, owner: string, holder: StorageHolder) {
    const ids = [...new Set(holder.assetIds)];
    const assets = await client.query(
      `SELECT id FROM mio_assets WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND state='ready'`,
      [owner, ids],
    );
    if (assets.rowCount !== ids.length) throw new StorageError(404, 'ASSET_NOT_FOUND');
    // Add before removing: replacing a location with another alias cannot momentarily release both.
    await client.query(
      `INSERT INTO mio_asset_holders(owner_id,asset_id,holder_type,holder_id)
       SELECT $1,id,$3,$4 FROM unnest($2::uuid[]) AS id ON CONFLICT DO NOTHING`,
      [owner, ids, holder.type, holder.id],
    );
    await client.query(
      `DELETE FROM mio_asset_holders WHERE owner_id=$1 AND holder_type=$2 AND holder_id=$3
         AND NOT(asset_id=ANY($4::uuid[]))`,
      [owner, holder.type, holder.id, ids],
    );
  }

  /** Trusted consumer bridge. No caller-supplied owner or holder IDs reach an HTTP route. */
  async replaceHolder(
    owner: string,
    holder: StorageHolder | (() => Promise<StorageHolder>),
  ): Promise<void> {
    await this.updatePolicy();
    await this.transaction(owner, async (client) =>
      this.replace(client, owner, typeof holder === 'function' ? await holder() : holder),
    );
  }

  /** A source failure leaves its previous durable holds untouched. Reads happen inside the owner queue. */
  async reconcileOwner(
    owner: string,
    sources: readonly {
      type: string;
      read: (owner: string) => Promise<readonly StorageHolder[]>;
    }[] = [],
  ): Promise<void> {
    await this.updatePolicy();
    await this.transaction(owner, async (client) => {
      for (const source of sources) {
        const holders = await source.read(owner);
        for (const holder of holders) {
          if (holder.type !== source.type) throw new Error('STORAGE_HOLDER_SOURCE_INVALID');
          await this.replace(client, owner, holder);
        }
        await client.query(
          `DELETE FROM mio_asset_holders WHERE owner_id=$1 AND holder_type=$2 AND NOT(holder_id=ANY($3::text[]))`,
          [owner, source.type, holders.map((holder) => holder.id)],
        );
      }
      const materials = await client.query<{ present: boolean }>(
        "SELECT to_regclass('mio_materials') IS NOT NULL AS present",
      );
      if (materials.rows[0]?.present) {
        await client.query(
          `INSERT INTO mio_asset_holders(owner_id,asset_id,holder_type,holder_id)
          SELECT m.owner_id,a.id,'material',m.id::text FROM mio_materials m JOIN mio_assets a ON a.id=m.source_asset_id AND a.owner_id=m.owner_id
          WHERE m.owner_id=$1 AND m.state<>'deleted' ON CONFLICT DO NOTHING`,
          [owner],
        );
        await client.query(
          `DELETE FROM mio_asset_holders h WHERE h.owner_id=$1 AND h.holder_type='material'
          AND NOT EXISTS(SELECT 1 FROM mio_materials m WHERE m.id::text=h.holder_id AND m.owner_id=h.owner_id
            AND m.source_asset_id=h.asset_id AND m.state<>'deleted')`,
          [owner],
        );
      }
      // One set-based owner scan repairs missing objects and totals, even after legacy writers drifted.
      await client.query(
        `WITH desired AS MATERIALIZED (
           SELECT a.raw_key AS object_key,max(a.size_bytes) AS size_bytes FROM mio_assets a
           WHERE a.owner_id=$1 AND a.state='ready' AND a.storage_class='content'
             AND a.raw_key ~ '^mio/(raw|derived|media)/'
             AND EXISTS(SELECT 1 FROM mio_asset_holders h WHERE h.owner_id=a.owner_id AND h.asset_id=a.id)
           GROUP BY a.raw_key
         ), updated AS (
           INSERT INTO mio_storage_objects(owner_id,object_key,size_bytes)
             SELECT $1,object_key,size_bytes FROM desired
           ON CONFLICT(owner_id,object_key) DO UPDATE SET size_bytes=EXCLUDED.size_bytes
             WHERE mio_storage_objects.size_bytes<>EXCLUDED.size_bytes
         ), removed AS (
           DELETE FROM mio_storage_objects o WHERE o.owner_id=$1
             AND NOT EXISTS(SELECT 1 FROM desired d WHERE d.object_key=o.object_key)
         )
         SELECT mio_storage_adjust($1,COALESCE(sum(d.size_bytes),0)::bigint-u.used_bytes,
           count(d.object_key)-u.object_count)
         FROM mio_storage_usage u LEFT JOIN desired d ON true
         WHERE u.owner_id=$1 GROUP BY u.used_bytes,u.object_count`,
        [owner],
      );
    });
  }

  async owners(after: string, limit = 10): Promise<string[]> {
    const { rows } = await this.pool.query<{ owner_id: string }>(
      `SELECT owner_id FROM mio_storage_usage WHERE owner_id>$1 ORDER BY owner_id LIMIT $2`,
      [after, limit],
    );
    return rows.map((row) => row.owner_id);
  }
}

export async function createStorageAccounting(
  databaseURL: string,
  policy: () => Readonly<StoragePolicy>,
) {
  const pool = new Pool({
    connectionString: databaseURL,
    max: 3,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 5000,
  });
  pool.on('error', () => log.error('STORAGE_DATABASE_CONNECTION_ERROR'));
  try {
    await checkStorageSchema(pool);
    return { store: new StorageAccounting(pool, policy), close: () => pool.end() };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
