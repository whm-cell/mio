import { creationLogSchemaSQL, checkCreationLogSchema } from '../notifications/creation-schema.ts';
import type { Pool } from 'pg';
import { accountClosureSchemaSQL } from '../account-deletion/domain-schema.ts';

/** The media database is retained; this migration never rebuilds jobs or assets. */
export const generationSchemaSQL = `${creationLogSchemaSQL}

ALTER TABLE mio_assets ALTER COLUMN staging_key DROP NOT NULL;
ALTER TABLE mio_assets ADD COLUMN IF NOT EXISTS asset_kind text NOT NULL DEFAULT 'original'
  CHECK (asset_kind IN ('original','derived'));
CREATE TABLE IF NOT EXISTS mio_image_jobs (
  id uuid PRIMARY KEY, owner_id text NOT NULL, request_id uuid NOT NULL,
  input_hash text NOT NULL, command jsonb NOT NULL, admitted jsonb NOT NULL DEFAULT '{}',
  error_code text,
  state text NOT NULL CHECK(state IN ('accepted','submitted','processing','materializing','completed','partial','materialization_failed','unknown','failed','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,request_id)
);
ALTER TABLE mio_image_jobs ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE mio_image_jobs ADD COLUMN IF NOT EXISTS active_recovery_id uuid;
ALTER TABLE mio_image_jobs ADD COLUMN IF NOT EXISTS active_recovery_seq integer NOT NULL DEFAULT 0;
ALTER TABLE mio_image_jobs ADD COLUMN IF NOT EXISTS upstream_task_id text;
ALTER TABLE mio_image_jobs ADD COLUMN IF NOT EXISTS query_attempt integer NOT NULL DEFAULT 0;
ALTER TABLE mio_image_jobs ADD COLUMN IF NOT EXISTS async_max_queries integer;
ALTER TABLE mio_image_jobs ADD COLUMN IF NOT EXISTS async_deadline timestamptz;
ALTER TABLE mio_image_jobs ADD COLUMN IF NOT EXISTS next_query_at timestamptz;
ALTER TABLE mio_image_jobs ADD COLUMN IF NOT EXISTS route_snapshot jsonb;
ALTER TABLE mio_image_jobs DROP CONSTRAINT IF EXISTS mio_image_jobs_state_check;
ALTER TABLE mio_image_jobs ADD CONSTRAINT mio_image_jobs_state_check
  CHECK(state IN ('accepted','submitted','processing','materializing','completed','partial','materialization_failed','unknown','failed','rejected'));
CREATE INDEX IF NOT EXISTS mio_image_jobs_unfinished ON mio_image_jobs(owner_id)
  WHERE state IN ('accepted','submitted','processing','materializing');
CREATE TABLE IF NOT EXISTS mio_image_outputs (
  job_id uuid NOT NULL REFERENCES mio_image_jobs(id), output_index integer NOT NULL,
  asset_id uuid NOT NULL REFERENCES mio_assets(id), PRIMARY KEY(job_id,output_index)
);
CREATE TABLE IF NOT EXISTS mio_image_executions (
  job_id uuid PRIMARY KEY REFERENCES mio_image_jobs(id),
  phase text NOT NULL CHECK(phase IN ('ready','submitting','waiting','querying','materializing','done')),
  claim_id uuid, snapshot jsonb, checkpoint jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mio_image_executions ADD COLUMN IF NOT EXISTS storage_failed boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS mio_image_executions_storage_failed ON mio_image_executions(job_id) WHERE storage_failed;
CREATE INDEX IF NOT EXISTS mio_image_executions_pending ON mio_image_executions(phase)
  WHERE phase <> 'done';
CREATE INDEX IF NOT EXISTS mio_image_executions_cleanup ON mio_image_executions(job_id)
  WHERE phase='done' AND checkpoint IS NOT NULL
    AND checkpoint->'cleaned' IS DISTINCT FROM 'true'::jsonb;
CREATE TABLE IF NOT EXISTS mio_video_jobs (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  request_id uuid NOT NULL,
  input_hash text NOT NULL,
  command jsonb NOT NULL,
  admitted jsonb NOT NULL DEFAULT '{}',
  route_snapshot jsonb,
  state text NOT NULL CHECK (state IN (
    'accepted','submitted','processing','materializing','completed','partial',
    'materialization_failed','unknown','failed','rejected','cancelled'
  )),
  error_code text,
  cancellation_requested boolean NOT NULL DEFAULT false,
  cancellation_supported boolean NOT NULL DEFAULT false,
  cancellation_status text CHECK (cancellation_status IS NULL OR cancellation_status IN (
    'pending','confirmed','not_supported','rejected','unknown','too_late'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(owner_id,request_id)
);
CREATE INDEX IF NOT EXISTS mio_video_jobs_active_owner ON mio_video_jobs(state,owner_id)
  WHERE state IN ('accepted','submitted','processing','materializing');
CREATE INDEX IF NOT EXISTS mio_video_jobs_owner_created ON mio_video_jobs(owner_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS mio_video_executions (
  job_id uuid PRIMARY KEY REFERENCES mio_video_jobs(id),
  phase text NOT NULL CHECK (phase IN ('ready','submitting','waiting','querying','materializing','done')),
  claim_id uuid,
  snapshot jsonb NOT NULL,
  upstream_task_id text,
  query_attempt integer NOT NULL DEFAULT 0 CHECK (query_attempt >= 0),
  async_max_queries integer CHECK (async_max_queries IS NULL OR async_max_queries > 0),
  async_deadline timestamptz,
  next_query_at timestamptz,
  checkpoint jsonb,
  storage_failed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mio_video_executions_pending ON mio_video_executions(phase,next_query_at)
  WHERE phase <> 'done';
CREATE TABLE IF NOT EXISTS mio_video_outputs (
  job_id uuid NOT NULL REFERENCES mio_video_jobs(id),
  output_index integer NOT NULL CHECK (output_index BETWEEN 0 AND 15),
  asset_id uuid REFERENCES mio_assets(id),
  phase text NOT NULL CHECK (phase IN ('pending','staging','probed','registered','failed')),
  error_code text,
  content_type text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes > 0),
  sha256 text,
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms > 0),
  has_audio boolean,
  PRIMARY KEY(job_id,output_index),
  CHECK (phase <> 'registered' OR asset_id IS NOT NULL)
);
${accountClosureSchemaSQL([
  ['mio_image_jobs', 'owner_id'],
  ['mio_image_executions', 'mio_image_jobs', 'job_id'],
  ['mio_image_outputs', 'mio_image_jobs', 'job_id'],
  ['mio_video_jobs', 'owner_id'],
  ['mio_video_executions', 'mio_video_jobs', 'job_id'],
  ['mio_video_outputs', 'mio_video_jobs', 'job_id'],
])}`;

export async function checkGenerationSchema(database: Pick<Pool, 'query'>): Promise<void> {
  await checkCreationLogSchema(database);
  await database.query('SELECT asset_kind FROM mio_assets LIMIT 0');
  await database.query(
    'SELECT id,owner_id,request_id,input_hash,command,admitted,error_code,state,created_at,active_recovery_id,active_recovery_seq,upstream_task_id,query_attempt,async_max_queries,async_deadline,next_query_at,route_snapshot FROM mio_image_jobs LIMIT 0',
  );
  await database.query('SELECT job_id,output_index,asset_id FROM mio_image_outputs LIMIT 0');
  await database.query(
    'SELECT job_id,phase,claim_id,snapshot,checkpoint,updated_at,storage_failed FROM mio_image_executions LIMIT 0',
  );
  await database.query(
    'SELECT id,owner_id,request_id,input_hash,command,admitted,route_snapshot,state,error_code,cancellation_requested,cancellation_supported,cancellation_status,created_at,updated_at,completed_at FROM mio_video_jobs LIMIT 0',
  );
  await database.query(
    'SELECT job_id,phase,claim_id,snapshot,upstream_task_id,query_attempt,async_max_queries,async_deadline,next_query_at,checkpoint,storage_failed,updated_at FROM mio_video_executions LIMIT 0',
  );
  await database.query(
    'SELECT job_id,output_index,asset_id,phase,error_code,content_type,size_bytes,sha256,width,height,duration_ms,has_audio FROM mio_video_outputs LIMIT 0',
  );
  const constraint = await database.query<{ definition: string }>(
    "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='mio_image_jobs'::regclass AND conname='mio_image_jobs_state_check' AND contype='c' AND convalidated",
  );
  if (
    !['partial', 'materialization_failed', 'submitted', 'processing', 'failed'].every((value) =>
      constraint.rows[0]?.definition.includes(`'${value}'`),
    )
  )
    throw new Error('GENERATION_IMAGE_SCHEMA_OUTDATED');
}
