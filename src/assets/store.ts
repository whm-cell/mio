import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { Pool } from 'pg';
import { checkAssetSchema } from './schema.ts';
import { AssetError } from './contracts.ts';

const log = createLogger('app', 'asset-store');

export interface AssetRow {
  id: string;
  owner_id: string;
  filename: string;
  content_type: string;
  size_bytes: string;
  staging_key: string | null;
  raw_key: string | null;
  state: 'pending' | 'finalizing' | 'ready' | 'expired';
  source_etag: string | null;
  lease_id: string | null;
  lease_until: Date | null;
  created_at: Date;
  expires_at: Date;
  upload_expired?: boolean;
}

export class AssetStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(id: string, owner: string, filename: string, contentType: string, size: number) {
    return (
      await this.pool.query<AssetRow>(
        `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,state,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,'pending',now()+interval '24 hours') RETURNING *`,
        [id, owner, filename, contentType, size, `mio/staging/${id}`],
      )
    ).rows[0]!;
  }

  async owned(id: string, owner: string): Promise<AssetRow> {
    const row = (
      await this.pool.query<AssetRow>(
        'SELECT *, expires_at<=now() AS upload_expired FROM mio_assets WHERE id=$1 AND owner_id=$2',
        [id, owner],
      )
    ).rows[0];
    if (!row) throw new AssetError(HTTP_STATUS.NOT_FOUND, 'ASSET_NOT_FOUND');
    return row;
  }

  async claim(id: string, owner: string, etag: string, lease: string): Promise<AssetRow | null> {
    return (
      (
        await this.pool.query<AssetRow>(
          `UPDATE mio_assets SET state='finalizing', source_etag=COALESCE(source_etag,$3),
         lease_id=$4, lease_until=now()+interval '5 minutes'
         WHERE id=$1 AND owner_id=$2 AND expires_at>now()
         AND (source_etag IS NULL OR source_etag=$3)
         AND (state='pending' OR (state='finalizing' AND lease_until<=now())) RETURNING *`,
          [id, owner, etag, lease],
        )
      ).rows[0] ?? null
    );
  }

  async commit(id: string, owner: string, lease: string, rawKey: string): Promise<AssetRow | null> {
    return (
      (
        await this.pool.query<AssetRow>(
          `UPDATE mio_assets SET state='ready', raw_key=$4, lease_id=NULL, lease_until=NULL
         WHERE id=$1 AND owner_id=$2 AND state='finalizing' AND lease_id=$3
         AND lease_until>now() AND expires_at>now()
         RETURNING *`,
          [id, owner, lease, rawKey],
        )
      ).rows[0] ?? null
    );
  }

  async release(id: string, lease: string): Promise<void> {
    await this.pool.query(
      `UPDATE mio_assets SET lease_until=now() WHERE id=$1 AND state='finalizing' AND lease_id=$2`,
      [id, lease],
    );
  }

  /** Only keys generated for this domain are selected; ready raw objects are never selected. */
  async expiredStaging(): Promise<{ id: string; staging_key: string }[]> {
    return (
      await this.pool.query<{ id: string; staging_key: string }>(
        `UPDATE mio_assets SET state=CASE WHEN state='ready' THEN state ELSE 'expired' END
         WHERE id IN (SELECT id FROM mio_assets WHERE expires_at<=now() AND staging_deleted_at IS NULL AND staging_key IS NOT NULL
         AND (state<>'finalizing' OR lease_until<=now()) ORDER BY expires_at LIMIT 100)
         AND expires_at<=now() AND staging_deleted_at IS NULL
         AND (state<>'finalizing' OR lease_until<=now()) RETURNING id,staging_key`,
      )
    ).rows;
  }

  async stagingDeleted(id: string, key: string): Promise<void> {
    await this.pool.query(
      'UPDATE mio_assets SET staging_deleted_at=now() WHERE id=$1 AND staging_key=$2 AND expires_at<=now()',
      [id, key],
    );
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

export async function createAssetStore(databaseURL: string): Promise<AssetStore> {
  const pool = new Pool({
    connectionString: databaseURL,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 5000,
    application_name: 'mio-assets',
  });
  pool.on('error', () => log.error('ASSET_DATABASE_CONNECTION_ERROR'));
  try {
    await checkAssetSchema(pool);
    return new AssetStore(pool);
  } catch {
    await pool.end();
    throw new Error('ASSET_SCHEMA: run assets:migrate and check database access');
  }
}
