import type { Pool } from 'pg';

/** User media metadata is separate from authentication and DSH session storage. */
export const assetSchemaSQL = `
CREATE TABLE IF NOT EXISTS mio_assets (
  id uuid PRIMARY KEY, owner_id text NOT NULL,
  filename text NOT NULL, content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1073741824),
  staging_key text NOT NULL UNIQUE, raw_key text UNIQUE,
  state text NOT NULL CHECK (state IN ('pending','finalizing','ready','expired')),
  source_etag text, lease_id uuid, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  staging_deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS mio_assets_cleanup ON mio_assets(expires_at)
  WHERE staging_deleted_at IS NULL;`;

export async function checkAssetSchema(pool: Pool): Promise<void> {
  const result = await pool.query(
    'SELECT id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,source_etag,lease_id,lease_until,created_at,expires_at,staging_deleted_at FROM mio_assets LIMIT 0',
  );
  const types = [2950, 25, 25, 25, 20, 25, 25, 25, 25, 2950, 1184, 1184, 1184, 1184];
  if (result.fields.some((field, index) => field.dataTypeID !== types[index]))
    throw new Error('ASSET_SCHEMA: incompatible metadata columns');
}
