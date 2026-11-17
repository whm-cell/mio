import type { Pool } from 'pg';

/** The media database is retained; this migration never rebuilds jobs or assets. */
export const generationSchemaSQL = `
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
  WHERE phase <> 'done';`;

export async function checkGenerationSchema(pool: Pool): Promise<void> {
  await pool.query('SELECT asset_kind FROM mio_assets LIMIT 0');
  await pool.query(
    'SELECT id,owner_id,request_id,input_hash,command,admitted,error_code,state,created_at,active_recovery_id,active_recovery_seq,upstream_task_id,query_attempt,async_max_queries,async_deadline,next_query_at,route_snapshot FROM mio_image_jobs LIMIT 0',
  );
  await pool.query('SELECT job_id,output_index,asset_id FROM mio_image_outputs LIMIT 0');
  await pool.query(
    'SELECT job_id,phase,claim_id,snapshot,checkpoint,updated_at,storage_failed FROM mio_image_executions LIMIT 0',
  );
  const constraint = await pool.query<{ definition: string }>(
    "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='mio_image_jobs'::regclass AND conname='mio_image_jobs_state_check' AND contype='c' AND convalidated",
  );
  if (
    !['partial', 'materialization_failed', 'submitted', 'processing', 'failed'].every((value) =>
      constraint.rows[0]?.definition.includes(`'${value}'`),
    )
  )
    throw new Error('GENERATION_IMAGE_SCHEMA_OUTDATED');
}
