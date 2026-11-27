/** One exact-key journal for formal assets, write-ahead locators and validated late Worker outputs. */
export const assetGcSchemaSQL = `
CREATE TABLE IF NOT EXISTS mio_asset_gc_objects (
  object_key text PRIMARY KEY, owner_id text NOT NULL,
  state text NOT NULL CHECK(state IN ('held','pending','deleting','deleted','retained')),
  lease_id uuid,lease_until timestamptz,deleted_at timestamptz,
  retained_reason text,retained_refs integer,created_at timestamptz NOT NULL DEFAULT now()
  ,next_attempt_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0,error_code text,source_etag text,source_sha256 text
);
ALTER TABLE mio_asset_gc_objects ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE mio_asset_gc_objects ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE mio_asset_gc_objects ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE mio_asset_gc_objects ADD COLUMN IF NOT EXISTS source_etag text;
ALTER TABLE mio_asset_gc_objects ADD COLUMN IF NOT EXISTS source_sha256 text;
CREATE INDEX IF NOT EXISTS mio_asset_gc_pending ON mio_asset_gc_objects(created_at,object_key)
  WHERE state IN ('pending','deleting');
CREATE INDEX IF NOT EXISTS mio_asset_gc_owner ON mio_asset_gc_objects(owner_id,state);
CREATE TABLE IF NOT EXISTS mio_asset_gc_requests (
  owner_id text NOT NULL,object_key text NOT NULL REFERENCES mio_asset_gc_objects(object_key),
  requested_at timestamptz NOT NULL DEFAULT now(),retained_at timestamptz,retained_refs integer,
  settled_at timestamptz,
  PRIMARY KEY(owner_id,object_key)
);
ALTER TABLE mio_asset_gc_requests ADD COLUMN IF NOT EXISTS settled_at timestamptz;
CREATE INDEX IF NOT EXISTS mio_asset_gc_requests_key ON mio_asset_gc_requests(object_key);
CREATE INDEX IF NOT EXISTS mio_asset_gc_requests_pending ON mio_asset_gc_requests(owner_id,requested_at,object_key) WHERE settled_at IS NULL;
CREATE TABLE IF NOT EXISTS mio_deleted_compute_attempts (
  job_id uuid NOT NULL,attempt_id uuid NOT NULL,command_id uuid NOT NULL,
  owner_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('transcode','media')),
  operation text,PRIMARY KEY(job_id,attempt_id,command_id)
);
CREATE OR REPLACE FUNCTION mio_gc_guard_live_key() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  IF TG_TABLE_NAME='mio_asset_holders' THEN
    SELECT raw_key INTO k FROM mio_assets WHERE id=NEW.asset_id;
  ELSE k:=NEW.raw_key; END IF;
  IF k IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='mio_assets' AND TG_OP='UPDATE'
    AND (to_jsonb(NEW)-ARRAY['state','staging_deleted_at'])=(to_jsonb(OLD)-ARRAY['state','staging_deleted_at'])
    AND ((to_jsonb(NEW)->>'state')='expired' OR (to_jsonb(NEW)->>'state')=(to_jsonb(OLD)->>'state')) THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mio:asset-gc:'||k,0));
  IF EXISTS(SELECT 1 FROM mio_asset_gc_objects WHERE object_key=k AND state IN ('pending','deleting','deleted'))
    AND current_setting('mio.cleanup_owner',true) IS DISTINCT FROM NEW.owner_id THEN
    RAISE EXCEPTION 'ASSET_GC_CLOSED' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mio_gc_live_key ON mio_assets;
CREATE TRIGGER mio_gc_live_key BEFORE INSERT OR UPDATE ON mio_assets FOR EACH ROW EXECUTE FUNCTION mio_gc_guard_live_key();
DROP TRIGGER IF EXISTS mio_gc_live_key ON mio_asset_holders;
CREATE TRIGGER mio_gc_live_key BEFORE INSERT OR UPDATE ON mio_asset_holders FOR EACH ROW EXECUTE FUNCTION mio_gc_guard_live_key();`;
import type { Pool } from 'pg';

export async function checkAssetGcSchema(pool: Pick<Pool, 'query'>) {
  await pool.query(
    'SELECT object_key,owner_id,state,lease_id,lease_until,deleted_at,retained_reason,retained_refs,created_at,next_attempt_at,attempts,error_code,source_etag,source_sha256 FROM mio_asset_gc_objects LIMIT 0',
  );
  await pool.query(
    'SELECT owner_id,object_key,requested_at,retained_at,retained_refs,settled_at FROM mio_asset_gc_requests LIMIT 0',
  );
  await pool.query(
    'SELECT job_id,attempt_id,command_id,owner_id,kind,operation FROM mio_deleted_compute_attempts LIMIT 0',
  );
  const result = await pool.query<{
    count: string;
  }>(`SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
    AND tgname='mio_gc_live_key' AND tgrelid IN ('mio_assets'::regclass,'mio_asset_holders'::regclass)`);
  if (result.rows[0]!.count !== '2')
    throw new Error('ASSET_GC_SCHEMA: run account-deletion:migrate --apply');
}
