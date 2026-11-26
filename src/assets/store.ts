import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { Pool } from 'pg';
import { checkAssetSchema } from './schema.ts';
import { AssetError } from './contracts.ts';
import { mediaHlsPath } from '../compute/media/hls.ts';

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

interface AudioPublication {
  assetId: string;
  ownerId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  key: string;
  etag: string;
}

interface DerivativeIntent {
  asset_id: string;
  owner_id: string;
  request_id: string;
  profile: 'ordinary';
}
interface DerivativeProfile {
  profile: 'ordinary';
  jobId: string | null;
  status: 'pending' | 'scheduled' | 'succeeded' | 'failed';
  errorCode: string | null;
  outputs: { assetId: string; name: string; role: string }[];
}
// Both the immutable request and its payload must belong to this intent.
const intentJob = `j.owner_id=i.owner_id AND j.request_id=i.request_id AND j.operation='video.derivatives'
  AND j.parameters->>'profile'=i.profile AND j.inputs->0->>'assetId'=i.asset_id::text`;

export class AssetStore {
  private readonly pool: Pool;
  private readonly derivativesEnabled: boolean;

  constructor(pool: Pool, derivativesEnabled = false) {
    this.pool = pool;
    this.derivativesEnabled = derivativesEnabled;
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

  /** Uploaded originals carry a staging ETag. Generated raw assets have no separate staging key. */
  async readyOwned(ownerId: string, ids: readonly string[]) {
    return (
      await this.pool.query<{
        id: string;
        raw_key: string;
        content_type: string;
        size_bytes: string;
        raw_etag: string | null;
      }>(
        `SELECT id,raw_key,content_type,size_bytes,
         CASE WHEN raw_key LIKE 'mio/raw/%' AND staging_key<>raw_key THEN NULL
              ELSE source_etag END AS raw_etag
         FROM mio_assets
         WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND state='ready' AND raw_key IS NOT NULL`,
        [ownerId, ids],
      )
    ).rows;
  }

  /** Check both unique identities before changing permissions on a recovered object. */
  async checkAudioPublicationIdentity(input: AudioPublication): Promise<void> {
    const conflict = await this.pool.query(
      `SELECT id FROM mio_assets WHERE (id=$1 OR raw_key=$2) AND
         (id=$1 AND raw_key=$2 AND owner_id=$3 AND state='ready' AND source_etag=$4
           AND size_bytes=$5 AND content_type=$6 AND filename=$7) IS NOT TRUE LIMIT 1`,
      [
        input.assetId,
        input.key,
        input.ownerId,
        input.etag,
        input.sizeBytes,
        input.contentType,
        input.filename,
      ],
    );
    if (conflict.rowCount) throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SOURCE_CHANGED');
  }

  /** The job owns the output ID; replay accepts only the same ready asset. */
  async publishAudio(input: AudioPublication): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,source_etag,expires_at,staging_deleted_at)
       VALUES($1,$2,$3,$4,$5,$6,$6,'ready',$7,now(),now())
       ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id
       WHERE mio_assets.owner_id=EXCLUDED.owner_id AND mio_assets.state='ready'
         AND mio_assets.raw_key=EXCLUDED.raw_key AND mio_assets.source_etag=EXCLUDED.source_etag
         AND mio_assets.size_bytes=EXCLUDED.size_bytes AND mio_assets.content_type=EXCLUDED.content_type
         AND mio_assets.filename=EXCLUDED.filename`,
      [
        input.assetId,
        input.ownerId,
        input.filename,
        input.contentType,
        input.sizeBytes,
        input.key,
        input.etag,
      ],
    );
    if (!result.rowCount) throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SOURCE_CHANGED');
  }

  /** Publish the immutable first-frame result only while the same owned original remains ready. */
  async publishAvatar(
    source: AssetRow,
    output: { assetId: string; key: string; filename: string; sizeBytes: number; etag: string },
  ): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,source_etag,expires_at,staging_deleted_at)
       SELECT $1,s.owner_id,$3,'image/webp',$4,$2,$2,'ready',$5,now(),now() FROM mio_assets s
       WHERE s.id=$6 AND s.owner_id=$7 AND s.state='ready' AND s.raw_key=$8
         AND s.size_bytes=$9 AND s.content_type=$10 AND s.source_etag IS NOT DISTINCT FROM $11
       ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id
       WHERE mio_assets.owner_id=EXCLUDED.owner_id AND mio_assets.state='ready'
         AND mio_assets.raw_key=EXCLUDED.raw_key AND mio_assets.source_etag=EXCLUDED.source_etag
         AND mio_assets.size_bytes=EXCLUDED.size_bytes AND mio_assets.content_type=EXCLUDED.content_type
         AND mio_assets.filename=EXCLUDED.filename`,
      [
        output.assetId,
        output.key,
        output.filename,
        output.sizeBytes,
        output.etag,
        source.id,
        source.owner_id,
        source.raw_key,
        source.size_bytes,
        source.content_type,
        source.source_etag,
      ],
    );
    if (!result.rowCount) throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SOURCE_CHANGED');
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
          `WITH ready AS (
             UPDATE mio_assets SET state='ready', raw_key=$4, lease_id=NULL, lease_until=NULL
             WHERE id=$1 AND owner_id=$2 AND state='finalizing' AND lease_id=$3
             AND lease_until>now() AND expires_at>now() RETURNING *
           ), intent AS (
             INSERT INTO mio_asset_derivative_intents(asset_id,owner_id,profile)
             SELECT id,owner_id,'ordinary' FROM ready
             WHERE $5 AND lower(content_type) LIKE 'video/%' AND staging_key='mio/staging/'||id
             ON CONFLICT(asset_id,profile) DO NOTHING
           )
           SELECT * FROM ready`,
          [id, owner, lease, rawKey, this.derivativesEnabled],
        )
      ).rows[0] ?? null
    );
  }

  async claimDerivative(): Promise<DerivativeIntent | undefined> {
    return (
      await this.pool.query<DerivativeIntent>(`
        WITH due AS (
          SELECT asset_id, profile FROM mio_asset_derivative_intents
          WHERE job_id IS NULL AND error_code IS NULL AND next_attempt_at<=now()
          ORDER BY next_attempt_at, asset_id, profile
          LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        UPDATE mio_asset_derivative_intents i SET next_attempt_at=now()+interval '5 seconds'
        FROM due WHERE i.asset_id=due.asset_id AND i.profile=due.profile
        RETURNING i.asset_id,i.owner_id,i.request_id,i.profile
      `)
    ).rows[0];
  }

  async linkDerivative(intent: DerivativeIntent, jobId: string): Promise<void> {
    await this.pool.query(
      `UPDATE mio_asset_derivative_intents i SET job_id=j.id, error_code=NULL
       FROM mio_media_jobs j WHERE i.asset_id=$1 AND i.profile=$2 AND j.id=$3 AND ${intentJob}
       AND i.job_id IS NULL`,
      [intent.asset_id, intent.profile, jobId],
    );
  }

  async rejectDerivative(intent: DerivativeIntent, errorCode: string): Promise<void> {
    await this.pool.query(
      `UPDATE mio_asset_derivative_intents i SET error_code=$3
       WHERE i.asset_id=$1 AND i.profile=$2 AND i.job_id IS NULL AND i.error_code IS NULL
       AND NOT EXISTS (SELECT 1 FROM mio_media_jobs j WHERE ${intentJob})`,
      [intent.asset_id, intent.profile, errorCode],
    );
  }

  async derivativeView(assetId: string, owner: string) {
    if (!this.derivativesEnabled)
      return { enabled: false as const, status: 'disabled' as const, profiles: [] };
    const { rows } = await this.pool.query<DerivativeProfile>(
      `SELECT i.profile,j.id AS "jobId",
        CASE WHEN j.state='succeeded' THEN 'succeeded'
             WHEN j.state IN ('failed','cancelled') OR i.error_code IS NOT NULL THEN 'failed'
             WHEN j.id IS NULL THEN 'pending' ELSE 'scheduled' END AS status,
        CASE WHEN j.state='cancelled' THEN 'MEDIA_CANCELLED' ELSE COALESCE(j.error_code,i.error_code) END AS "errorCode",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('assetId',f.asset_id,'name',f.name,'role',f.role)
                           ORDER BY f.ordinal,f.name)
          FROM mio_media_files f WHERE f.job_id=j.id AND j.state='succeeded'
        ),'[]'::jsonb) AS outputs
       FROM mio_asset_derivative_intents i
       LEFT JOIN mio_media_jobs j ON j.id=i.job_id AND j.owner_id=i.owner_id
       WHERE i.asset_id=$1 AND i.owner_id=$2 ORDER BY i.profile`,
      [assetId, owner],
    );
    return {
      enabled: true as const,
      status: rows.length ? ('enabled' as const) : ('not_applicable' as const),
      profiles: rows.map((row) => ({
        ...row,
        ...(row.jobId &&
        row.outputs.some((file) => file.role === 'hls' && file.name === 'master.m3u8')
          ? { playbackUrl: mediaHlsPath(row.jobId) }
          : {}),
      })),
    };
  }

  async release(id: string, lease: string): Promise<void> {
    await this.pool.query(
      `UPDATE mio_assets SET lease_until=now() WHERE id=$1 AND state='finalizing' AND lease_id=$2`,
      [id, lease],
    );
  }

  /** Only keys generated for this domain are selected; ready raw objects are never selected. */
  async expiredStaging(after?: {
    expires_at: string;
    id: string;
  }): Promise<{ id: string; staging_key: string; expires_at: string }[]> {
    return (
      await this.pool.query<{ id: string; staging_key: string; expires_at: string }>(
        `WITH selected AS (
           SELECT id FROM mio_assets WHERE expires_at<=now() AND staging_deleted_at IS NULL AND staging_key IS NOT NULL
           AND (state<>'finalizing' OR lease_until<=now())
           AND ($1::timestamptz IS NULL OR (expires_at,id)>($1::timestamptz,$2::uuid))
           ORDER BY expires_at,id LIMIT 100
         ), updated AS (
           UPDATE mio_assets SET state=CASE WHEN state='ready' THEN state ELSE 'expired' END
           WHERE id IN (SELECT id FROM selected)
           AND expires_at<=now() AND staging_deleted_at IS NULL
           AND (state<>'finalizing' OR lease_until<=now()) RETURNING id,staging_key,expires_at
         ) SELECT id,staging_key,expires_at::text FROM updated ORDER BY expires_at,id`,
        [after?.expires_at ?? null, after?.id ?? null],
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

export async function createAssetStore(
  databaseURL: string,
  derivativesEnabled = false,
): Promise<AssetStore> {
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
    return new AssetStore(pool, derivativesEnabled);
  } catch {
    await pool.end();
    throw new Error('ASSET_SCHEMA: run assets:migrate and check database access');
  }
}
