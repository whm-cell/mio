import { storageSchemaSQL, checkStorageSchema } from './storage-schema.ts';
import type { Pool } from 'pg';
import { accountClosureSchemaSQL } from '../account-deletion/domain-schema.ts';
import { assetGcSchemaSQL, checkAssetGcSchema } from './gc-schema.ts';

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
  WHERE staging_deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS mio_asset_derivative_intents (
  asset_id uuid NOT NULL REFERENCES mio_assets(id), owner_id text NOT NULL,
  profile text NOT NULL CHECK (profile='ordinary'),
  request_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(), job_id uuid UNIQUE,
  error_code text, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(asset_id,profile)
);
CREATE INDEX IF NOT EXISTS mio_asset_derivatives_due
  ON mio_asset_derivative_intents(next_attempt_at,asset_id,profile)
  WHERE job_id IS NULL AND error_code IS NULL;
${storageSchemaSQL}
${accountClosureSchemaSQL([
  ['mio_assets', 'owner_id'],
  ['mio_asset_derivative_intents', 'owner_id'],
  ['mio_asset_holders', 'owner_id'],
  ['mio_storage_usage', 'owner_id'],
  ['mio_storage_objects', 'owner_id'],
])}
${assetGcSchemaSQL}`;

export async function checkAssetSchema(database: Pick<Pool, 'query'>): Promise<void> {
  await checkStorageSchema(database);
  await checkAssetGcSchema(database);
  const result = await database.query(
    'SELECT id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,source_etag,lease_id,lease_until,created_at,expires_at,staging_deleted_at FROM mio_assets LIMIT 0',
  );
  const types = [2950, 25, 25, 25, 20, 25, 25, 25, 25, 2950, 1184, 1184, 1184, 1184];
  if (result.fields.some((field, index) => field.dataTypeID !== types[index]))
    throw new Error('ASSET_SCHEMA: incompatible metadata columns');
  await database.query(
    'SELECT asset_id,owner_id,profile,request_id,job_id,error_code,next_attempt_at FROM mio_asset_derivative_intents LIMIT 0',
  );
}
