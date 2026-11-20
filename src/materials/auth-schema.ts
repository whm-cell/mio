import type { Pool } from 'pg';
export const materialAuthSchemaSQL = `
CREATE TABLE IF NOT EXISTS mio_material_auth_sessions (
 id uuid PRIMARY KEY,owner_id text NOT NULL,provider_type text NOT NULL CHECK(provider_type='onelink'),
 provider_config_id uuid NOT NULL,credential_version integer NOT NULL CHECK(credential_version>0),
 request_id uuid NOT NULL,input_hash text NOT NULL CHECK(length(input_hash)=64),
 state text NOT NULL CHECK(state IN ('creating','pending','verifying','completed','failed','expired','unknown')),
 protocol_snapshot jsonb NOT NULL CHECK(protocol_snapshot='{"version":1}'::jsonb),return_target text NOT NULL CHECK(return_target='materials'),
 token_digest text CHECK(token_digest IS NULL OR token_digest~'^[a-f0-9]{64}$'),
 cipher_format smallint,master_key_id text,nonce bytea,ciphertext bytea,auth_tag bytea,
 group_id uuid,lease_id uuid,lease_until timestamptz,next_query_at timestamptz,query_count integer NOT NULL DEFAULT 0 CHECK(query_count BETWEEN 0 AND 8),
 error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 UNIQUE(owner_id,request_id),UNIQUE(owner_id,id),FOREIGN KEY(owner_id,group_id) REFERENCES mio_material_groups(owner_id,id),
 CHECK(num_nonnulls(cipher_format,master_key_id,nonce,ciphertext,auth_tag)=0 OR
   (num_nonnulls(cipher_format,master_key_id,nonce,ciphertext,auth_tag)=5 AND cipher_format=1 AND master_key_id IS NOT NULL AND octet_length(nonce)=12 AND octet_length(auth_tag)=16 AND octet_length(ciphertext) BETWEEN 1 AND 8192)),
 CHECK(ciphertext IS NULL OR token_digest IS NOT NULL),
 CHECK(state NOT IN ('completed','expired') OR ciphertext IS NULL),CHECK(state<>'completed' OR group_id IS NOT NULL),
 CHECK(expires_at=created_at+interval '20 minutes')
);
ALTER TABLE mio_material_auth_sessions
 ADD COLUMN IF NOT EXISTS upstream_create_request_id varchar(256),
 ADD COLUMN IF NOT EXISTS upstream_result_request_id varchar(256),
 ADD COLUMN IF NOT EXISTS upstream_group_request_id varchar(256);
CREATE INDEX IF NOT EXISTS mio_material_auth_sessions_expiry ON mio_material_auth_sessions(expires_at,id) WHERE state NOT IN ('completed','expired');
CREATE INDEX IF NOT EXISTS mio_material_auth_sessions_owner ON mio_material_auth_sessions(owner_id,created_at DESC,id DESC);
`;
export async function checkMaterialAuthSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query(
    'SELECT id,owner_id,provider_type,provider_config_id,credential_version,request_id,input_hash,state,protocol_snapshot,return_target,token_digest,cipher_format,master_key_id,nonce,ciphertext,auth_tag,group_id,lease_id,lease_until,next_query_at,query_count,error_code,created_at,updated_at,expires_at,upstream_create_request_id,upstream_result_request_id,upstream_group_request_id FROM mio_material_auth_sessions LIMIT 0',
  );
  const result = await pool.query<{
    unique_request: boolean;
    owner_group_fk: boolean;
    expiry_index: boolean;
  }>(
    `SELECT
    EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='mio_material_auth_sessions'::regclass AND c.contype='u' AND
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)=ARRAY['owner_id','request_id']::text[]) AS unique_request,
    EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='mio_material_auth_sessions'::regclass AND c.confrelid='mio_material_groups'::regclass AND c.contype='f' AND c.convalidated AND
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)=ARRAY['owner_id','group_id']::text[] AND
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum)=ARRAY['owner_id','id']::text[]) AS owner_group_fk,
    EXISTS(SELECT 1 FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid WHERE i.indrelid='mio_material_auth_sessions'::regclass AND ix.relname='mio_material_auth_sessions_expiry' AND i.indisvalid AND i.indnkeyatts=2 AND
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)=ARRAY['expires_at','id']::text[] AND
      pg_get_expr(i.indpred,i.indrelid)=$1) AS expiry_index`,
    ["(state <> ALL (ARRAY['completed'::text, 'expired'::text]))"],
  );
  const row = result.rows[0];
  if (!row?.unique_request || !row.owner_group_fk || !row.expiry_index)
    throw new Error(
      'MATERIAL_AUTH_SCHEMA: unique owner request, owner group FK and expiry index required',
    );
}
