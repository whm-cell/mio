import type { Pool } from 'pg';

/** Unit 1 owns three tables; authentication sessions and video references arrive with their consumers. */
export const materialSchemaSQL = `
CREATE TABLE IF NOT EXISTS mio_material_groups (
 id uuid PRIMARY KEY, owner_id text NOT NULL, provider_type text NOT NULL CHECK(provider_type='onelink'),
 provider_config_id uuid NOT NULL, upstream_scope text NOT NULL CHECK(upstream_scope='onelink-volc-ark'),
 upstream_group_id text, group_type text NOT NULL CHECK(group_type IN ('real','aigc')),
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100),
 auth_status text NOT NULL CHECK(auth_status IN ('not_applicable','verified')),
 state text NOT NULL CHECK(state IN ('creating','ready','unknown','deleting','deleted','failed')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), sync_cursor text,
 sync_lease_id uuid, sync_lease_until timestamptz, last_sync_attempt_at timestamptz,
 last_sync_status text CHECK(last_sync_status IN ('running','succeeded','failed')),
 last_sync_error_code text, last_synced_at timestamptz, source_session_id uuid UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 UNIQUE(owner_id,id), UNIQUE(owner_id,provider_type,id),
 CHECK((group_type='aigc' AND auth_status='not_applicable') OR (group_type='real' AND auth_status='verified'))
);
CREATE UNIQUE INDEX IF NOT EXISTS mio_material_groups_upstream_unique ON mio_material_groups(provider_type,upstream_group_id) WHERE upstream_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mio_material_groups_owner_page ON mio_material_groups(owner_id,group_type,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS mio_materials (
 id uuid PRIMARY KEY, owner_id text NOT NULL, provider_type text NOT NULL CHECK(provider_type='onelink'),
 group_id uuid NOT NULL, source_asset_id uuid REFERENCES mio_assets(id), upstream_asset_id text,
 asset_type text NOT NULL CHECK(asset_type='image'), name text NOT NULL CHECK(char_length(name)<=100),
 state text NOT NULL CHECK(state IN ('registering','processing','active','rejected','unknown','deleting','deleted','failed')),
 upstream_status text, raw_snapshot jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(raw_snapshot)='object' AND octet_length(raw_snapshot::text)<=4096),
 registration_credential_version integer NOT NULL CHECK(registration_credential_version>0),
 last_synced_at timestamptz,next_query_at timestamptz,error_code text,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,
 UNIQUE(owner_id,id), FOREIGN KEY(owner_id,provider_type,group_id) REFERENCES mio_material_groups(owner_id,provider_type,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS mio_materials_upstream_unique ON mio_materials(provider_type,upstream_asset_id) WHERE upstream_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mio_materials_group_page ON mio_materials(owner_id,group_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS mio_material_operations (
 id uuid PRIMARY KEY,owner_id text NOT NULL,request_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('create_group','register_material','delete_material_upstream','delete_group_upstream')),
 target_group_id uuid,target_material_id uuid,input_hash text NOT NULL CHECK(length(input_hash)=64),
 state text NOT NULL CHECK(state IN ('creating','deleting','succeeded','failed','unknown')),
 provider_config_id uuid NOT NULL,credential_version integer NOT NULL CHECK(credential_version>0),
 protocol_snapshot jsonb NOT NULL CHECK(jsonb_typeof(protocol_snapshot)='object' AND protocol_snapshot->>'version'='1' AND octet_length(protocol_snapshot::text)<=1024),
 upstream_request_id text,attempt integer NOT NULL DEFAULT 1 CHECK(attempt=1),lease_id uuid,lease_until timestamptz,
 next_query_at timestamptz,result_local_id uuid,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,kind,request_id),
 FOREIGN KEY(owner_id,target_group_id) REFERENCES mio_material_groups(owner_id,id),
 FOREIGN KEY(owner_id,target_material_id) REFERENCES mio_materials(owner_id,id)
);
CREATE INDEX IF NOT EXISTS mio_material_operations_recovery ON mio_material_operations(next_query_at,lease_until) WHERE state IN ('creating','deleting','unknown');
`;

export async function checkMaterialSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query(
    'SELECT id,owner_id,provider_type,provider_config_id,upstream_scope,upstream_group_id,group_type,name,auth_status,state,revision,sync_cursor,sync_lease_id,sync_lease_until,last_sync_attempt_at,last_sync_status,last_sync_error_code,last_synced_at,source_session_id,created_at,updated_at,deleted_at FROM mio_material_groups LIMIT 0',
  );
  await pool.query(
    'SELECT id,owner_id,provider_type,group_id,source_asset_id,upstream_asset_id,asset_type,name,state,upstream_status,raw_snapshot,registration_credential_version,last_synced_at,next_query_at,error_code,revision,created_at,updated_at,deleted_at FROM mio_materials LIMIT 0',
  );
  await pool.query(
    'SELECT id,owner_id,request_id,kind,target_group_id,target_material_id,input_hash,state,provider_config_id,credential_version,protocol_snapshot,upstream_request_id,attempt,lease_id,lease_until,next_query_at,result_local_id,error_code,created_at,updated_at FROM mio_material_operations LIMIT 0',
  );
  for (const [table, name, idColumn] of [
    ['mio_material_groups', 'mio_material_groups_upstream_unique', 'upstream_group_id'],
    ['mio_materials', 'mio_materials_upstream_unique', 'upstream_asset_id'],
  ] as const) {
    const result = await pool.query<{
      indisunique: boolean;
      indisvalid: boolean;
      indnkeyatts: number;
      indnatts: number;
      columns: string[];
      predicate: string;
    }>(
      `SELECT i.indisunique,i.indisvalid,i.indnkeyatts,i.indnatts,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord) AS columns,
      pg_get_expr(i.indpred,i.indrelid) AS predicate
      FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
      WHERE i.indrelid=to_regclass($1) AND ix.relname=$2`,
      [table, name],
    );
    const index = result.rows[0];
    if (
      !index ||
      !index.indisunique ||
      !index.indisvalid ||
      index.indnkeyatts !== 2 ||
      index.indnatts !== 2 ||
      index.columns.join(',') !== `provider_type,${idColumn}` ||
      index.predicate !== `(${idColumn} IS NOT NULL)`
    )
      throw new Error('MATERIAL_SCHEMA: exact global upstream uniqueness required');
  }
}
