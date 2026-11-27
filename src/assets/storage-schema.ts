import type { Pool } from 'pg';

/** Media-local holds and indexed, materialized accounting. No authentication database dependency. */
export const storageSchemaSQL = `
ALTER TABLE mio_assets ADD COLUMN IF NOT EXISTS asset_kind text NOT NULL DEFAULT 'original'
  CHECK (asset_kind IN ('original','derived'));
ALTER TABLE mio_assets ADD COLUMN IF NOT EXISTS storage_class text NOT NULL DEFAULT 'content'
  CHECK (storage_class IN ('content','internal'));
CREATE UNIQUE INDEX IF NOT EXISTS mio_assets_owner_identity ON mio_assets(owner_id,id);
CREATE TABLE IF NOT EXISTS mio_storage_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  revision bigint NOT NULL, quota_bytes bigint NOT NULL CHECK(quota_bytes>0),
  warning_available_bytes bigint NOT NULL CHECK(warning_available_bytes>0 AND warning_available_bytes<quota_bytes)
);
CREATE TABLE IF NOT EXISTS mio_storage_setup (version integer PRIMARY KEY);
CREATE TABLE IF NOT EXISTS mio_storage_usage (
  owner_id text PRIMARY KEY, used_bytes bigint NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
  object_count bigint NOT NULL DEFAULT 0 CHECK(object_count>=0),
  waterline_epoch bigint NOT NULL DEFAULT 0 CHECK(waterline_epoch>=0),
  acknowledged_version text, calculated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mio_asset_holders (
  owner_id text NOT NULL, asset_id uuid NOT NULL,
  holder_type text NOT NULL CHECK(length(holder_type)>0),
  holder_id text NOT NULL CHECK(length(holder_id)>0),
  PRIMARY KEY(owner_id,holder_type,holder_id,asset_id),
  FOREIGN KEY(owner_id,asset_id) REFERENCES mio_assets(owner_id,id)
);
CREATE INDEX IF NOT EXISTS mio_asset_holders_asset ON mio_asset_holders(owner_id,asset_id);
CREATE TABLE IF NOT EXISTS mio_storage_objects (
  owner_id text NOT NULL, object_key text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes>0),
  PRIMARY KEY(owner_id,object_key)
);
CREATE OR REPLACE FUNCTION mio_storage_rank(used bigint, quota bigint, warning bigint)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN used>=quota THEN 2 WHEN quota-used<warning THEN 1 ELSE 0 END
$$;
CREATE OR REPLACE FUNCTION mio_storage_adjust(p_owner text, bytes_delta bigint, count_delta bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE u mio_storage_usage; p mio_storage_policy;
BEGIN
  INSERT INTO mio_storage_usage(owner_id) VALUES(p_owner) ON CONFLICT DO NOTHING;
  SELECT * INTO u FROM mio_storage_usage WHERE owner_id=p_owner FOR UPDATE;
  SELECT * INTO STRICT p FROM mio_storage_policy WHERE singleton;
  UPDATE mio_storage_usage SET used_bytes=used_bytes+bytes_delta,object_count=object_count+count_delta,
    waterline_epoch=waterline_epoch+CASE WHEN
      mio_storage_rank(u.used_bytes,p.quota_bytes,p.warning_available_bytes)>
      mio_storage_rank(u.used_bytes+bytes_delta,p.quota_bytes,p.warning_available_bytes) THEN 1 ELSE 0 END,
    calculated_at=clock_timestamp()
    WHERE owner_id=p_owner;
END $$;
CREATE OR REPLACE FUNCTION mio_storage_refresh_object(p_owner text,p_key text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE old_size bigint; new_size bigint;
BEGIN
  IF p_key IS NULL THEN RETURN; END IF;
  INSERT INTO mio_storage_usage(owner_id) VALUES(p_owner) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM mio_storage_usage WHERE owner_id=p_owner FOR UPDATE;
  SELECT size_bytes INTO old_size FROM mio_storage_objects WHERE owner_id=p_owner AND object_key=p_key;
  SELECT max(a.size_bytes) INTO new_size FROM mio_assets a
    WHERE a.owner_id=p_owner AND a.raw_key=p_key AND a.state='ready' AND a.storage_class='content'
      AND a.raw_key ~ '^mio/(raw|derived|media)/'
      AND EXISTS(SELECT 1 FROM mio_asset_holders h WHERE h.owner_id=a.owner_id AND h.asset_id=a.id);
  IF old_size IS NOT DISTINCT FROM new_size THEN RETURN; END IF;
  IF new_size IS NULL THEN
    DELETE FROM mio_storage_objects WHERE owner_id=p_owner AND object_key=p_key;
  ELSE
    INSERT INTO mio_storage_objects(owner_id,object_key,size_bytes) VALUES(p_owner,p_key,new_size)
      ON CONFLICT(owner_id,object_key) DO UPDATE SET size_bytes=EXCLUDED.size_bytes;
  END IF;
  PERFORM mio_storage_adjust(p_owner,COALESCE(new_size,0)-COALESCE(old_size,0),
    (new_size IS NOT NULL)::integer-(old_size IS NOT NULL)::integer);
END $$;
CREATE OR REPLACE FUNCTION mio_storage_holder_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h mio_asset_holders; k text;
BEGIN
  IF TG_OP='DELETE' THEN h:=OLD; ELSE h:=NEW; END IF;
  SELECT raw_key INTO k FROM mio_assets WHERE id=h.asset_id AND owner_id=h.owner_id;
  PERFORM mio_storage_refresh_object(h.owner_id,k);
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER mio_storage_holder_changed AFTER INSERT OR DELETE ON mio_asset_holders
  FOR EACH ROW EXECUTE FUNCTION mio_storage_holder_changed();
-- A trusted metadata ownership change revokes the old owner's holds before the local FK check.
-- Readers still recheck ownership after object I/O; no former business location transfers with it.
CREATE OR REPLACE FUNCTION mio_storage_owner_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    DELETE FROM mio_asset_holders WHERE owner_id=OLD.owner_id AND asset_id=OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER mio_storage_owner_changed BEFORE UPDATE OF owner_id ON mio_assets
  FOR EACH ROW EXECUTE FUNCTION mio_storage_owner_changed();
CREATE OR REPLACE FUNCTION mio_storage_asset_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='ready' AND NEW.storage_class='content' AND NEW.raw_key ~ '^mio/(raw|derived|media)/'
    AND (TG_OP='INSERT' OR OLD.state<>'ready' OR OLD.owner_id<>NEW.owner_id) THEN
    INSERT INTO mio_asset_holders(owner_id,asset_id,holder_type,holder_id)
      VALUES(NEW.owner_id,NEW.id,'asset',NEW.id::text) ON CONFLICT DO NOTHING;
  END IF;
  IF TG_OP='UPDATE' THEN
    PERFORM mio_storage_refresh_object(OLD.owner_id,OLD.raw_key);
  END IF;
  PERFORM mio_storage_refresh_object(NEW.owner_id,NEW.raw_key);
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER mio_storage_asset_changed
  AFTER INSERT OR UPDATE OF owner_id,state,raw_key,size_bytes,storage_class ON mio_assets
  FOR EACH ROW EXECUTE FUNCTION mio_storage_asset_changed();
-- Older media outputs predate storage_class. Classify them before the one-time reference backfill.
DO $$ BEGIN
  IF to_regclass('mio_media_files') IS NOT NULL THEN
    EXECUTE 'UPDATE mio_assets a SET storage_class=''internal'' FROM mio_media_files f
      WHERE f.asset_id=a.id AND f.role IN (''preview'',''poster'',''hls'',''segment'')
        AND a.storage_class<>''internal''';
  END IF;
END $$;
-- Reapplying never resurrects ownership holds explicitly released by a consumer.
INSERT INTO mio_storage_policy(singleton,revision,quota_bytes,warning_available_bytes)
  SELECT true,0,5368709120,1073741824 WHERE NOT EXISTS(SELECT 1 FROM mio_storage_policy)
  ON CONFLICT DO NOTHING;
INSERT INTO mio_asset_holders(owner_id,asset_id,holder_type,holder_id)
  SELECT owner_id,id,'asset',id::text FROM mio_assets
  WHERE state='ready' AND storage_class='content' AND raw_key ~ '^mio/(raw|derived|media)/'
    AND NOT EXISTS(SELECT 1 FROM mio_storage_setup WHERE version=1)
  ON CONFLICT DO NOTHING;
INSERT INTO mio_storage_setup(version) VALUES(1) ON CONFLICT DO NOTHING;
`;

/** Never repairs structures or takes row locks during startup. */
export async function checkStorageSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query('SELECT asset_kind,storage_class FROM mio_assets LIMIT 0');
  await pool.query('SELECT owner_id,asset_id,holder_type,holder_id FROM mio_asset_holders LIMIT 0');
  await pool.query('SELECT owner_id,object_key,size_bytes FROM mio_storage_objects LIMIT 0');
  await pool.query(
    'SELECT owner_id,used_bytes,object_count,waterline_epoch,acknowledged_version,calculated_at FROM mio_storage_usage LIMIT 0',
  );
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND ((tgrelid='mio_assets'::regclass AND tgname IN ('mio_storage_asset_changed','mio_storage_owner_changed'))
        OR (tgrelid='mio_asset_holders'::regclass AND tgname='mio_storage_holder_changed'))`,
  );
  if (result.rows[0]?.count !== '3')
    throw new Error('STORAGE_SCHEMA: accounting triggers required');
  const policy = await pool.query(
    'SELECT revision,quota_bytes,warning_available_bytes FROM mio_storage_policy WHERE singleton',
  );
  const setup = await pool.query('SELECT version FROM mio_storage_setup WHERE version=1');
  if (policy.rowCount !== 1 || setup.rowCount !== 1)
    throw new Error('STORAGE_SCHEMA: initial backfill required');
}
