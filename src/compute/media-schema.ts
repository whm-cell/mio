import type { Pool } from 'pg';

/** Additive media tables: immutable input snapshots and independently durable control intents. */
export const mediaSchemaSQL = `
CREATE TABLE IF NOT EXISTS mio_media_jobs (
  id uuid PRIMARY KEY, owner_id text NOT NULL, request_id uuid NOT NULL,
  request_hash text NOT NULL, operation text NOT NULL, parameters jsonb NOT NULL,
  inputs jsonb NOT NULL, profile text NOT NULL CHECK(profile = 'standard-media'),
  state text NOT NULL CHECK(state IN ('accepted','queued','running','reconciling','cancel_requested','succeeded','failed','cancelled')),
  attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  attempt_id uuid NOT NULL, command_id uuid NOT NULL,
  cancel_requested boolean NOT NULL DEFAULT false,
  error_code text, stage text, progress double precision NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,request_id)
);
CREATE INDEX IF NOT EXISTS mio_media_jobs_owner ON mio_media_jobs(owner_id,created_at DESC);
CREATE INDEX IF NOT EXISTS mio_media_jobs_active ON mio_media_jobs(owner_id)
  WHERE state NOT IN ('succeeded','failed','cancelled');
CREATE TABLE IF NOT EXISTS mio_media_outbox (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES mio_media_jobs(id),
  command jsonb NOT NULL, lease_id uuid, lease_until timestamptz, sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mio_media_outbox_pending ON mio_media_outbox(created_at) WHERE sent_at IS NULL;
CREATE TABLE IF NOT EXISTS mio_media_inbox (
  id uuid PRIMARY KEY, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mio_media_retries (
  owner_id text NOT NULL, request_id uuid NOT NULL, job_id uuid NOT NULL REFERENCES mio_media_jobs(id),
  attempt_id uuid NOT NULL, PRIMARY KEY(owner_id,request_id)
);
CREATE TABLE IF NOT EXISTS mio_media_controls (
  job_id uuid NOT NULL REFERENCES mio_media_jobs(id), attempt_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('cancel','recover')), message_id uuid NOT NULL,
  PRIMARY KEY(job_id,attempt_id,action)
);
CREATE TABLE IF NOT EXISTS mio_media_files (
  asset_id uuid PRIMARY KEY REFERENCES mio_assets(id), job_id uuid NOT NULL REFERENCES mio_media_jobs(id),
  name text NOT NULL, role text NOT NULL, object_key text NOT NULL UNIQUE,
  size_bytes bigint NOT NULL, etag text NOT NULL, sha256 text NOT NULL, content_type text NOT NULL,
  UNIQUE(job_id,name)
);`;

export async function checkMediaSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query(
    'SELECT id,owner_id,request_id,request_hash,operation,parameters,inputs,profile,state,attempt,attempt_id,command_id,cancel_requested,error_code,stage,progress,data,created_at,updated_at FROM mio_media_jobs LIMIT 0',
  );
  await pool.query(
    'SELECT id,job_id,command,lease_id,lease_until,sent_at,created_at FROM mio_media_outbox LIMIT 0',
  );
  await pool.query('SELECT id,payload,created_at FROM mio_media_inbox LIMIT 0');
  await pool.query(
    'SELECT asset_id,job_id,name,role,object_key,size_bytes,etag,sha256,content_type FROM mio_media_files LIMIT 0',
  );
  await pool.query('SELECT owner_id,request_id,job_id,attempt_id FROM mio_media_retries LIMIT 0');
  await pool.query('SELECT job_id,attempt_id,action,message_id FROM mio_media_controls LIMIT 0');
}
