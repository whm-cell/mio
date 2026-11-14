import type { Pool } from 'pg';

/** Incremental media-domain migration; existing original assets remain intact. */
export const computeSchemaSQL = `
ALTER TABLE mio_assets ALTER COLUMN staging_key DROP NOT NULL;
ALTER TABLE mio_assets ADD COLUMN IF NOT EXISTS asset_kind text NOT NULL DEFAULT 'original'
  CHECK (asset_kind IN ('original','derived'));
CREATE TABLE IF NOT EXISTS mio_compute_jobs (
  id uuid PRIMARY KEY, owner_id text NOT NULL, request_id uuid NOT NULL,
  input_asset_id uuid NOT NULL REFERENCES mio_assets(id),
  input_key text NOT NULL, input_size bigint NOT NULL, input_etag text NOT NULL,
  state text NOT NULL CHECK (state IN ('accepted','queued','running','succeeded','failed')),
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  attempt_id uuid NOT NULL, command_id uuid NOT NULL,
  result_asset_id uuid REFERENCES mio_assets(id), error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,request_id)
);
CREATE INDEX IF NOT EXISTS mio_compute_jobs_unfinished ON mio_compute_jobs(owner_id)
  WHERE state IN ('accepted','queued','running');
CREATE TABLE IF NOT EXISTS mio_compute_outbox (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES mio_compute_jobs(id),
  command jsonb NOT NULL, lease_id uuid, lease_until timestamptz, sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mio_compute_outbox_pending ON mio_compute_outbox(created_at)
  WHERE sent_at IS NULL;
CREATE TABLE IF NOT EXISTS mio_image_jobs (
  id uuid PRIMARY KEY, owner_id text NOT NULL, request_id uuid NOT NULL,
  input_hash text NOT NULL, command jsonb NOT NULL, admitted jsonb NOT NULL DEFAULT '{}', error_code text,
  state text NOT NULL CHECK(state IN ('accepted','materializing','completed','partial','materialization_failed','unknown','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,request_id)
);
CREATE TABLE IF NOT EXISTS mio_image_outbox (
  job_id uuid PRIMARY KEY REFERENCES mio_image_jobs(id), sent_at timestamptz
);
ALTER TABLE mio_image_jobs DROP CONSTRAINT IF EXISTS mio_image_jobs_state_check;
ALTER TABLE mio_image_jobs ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE mio_image_jobs ADD COLUMN IF NOT EXISTS active_recovery_id uuid;
ALTER TABLE mio_image_jobs ADD COLUMN IF NOT EXISTS active_recovery_seq integer NOT NULL DEFAULT 0;
ALTER TABLE mio_image_outbox ADD COLUMN IF NOT EXISTS recovery_command jsonb;
ALTER TABLE mio_image_jobs ADD CONSTRAINT mio_image_jobs_state_check
  CHECK(state IN ('accepted','materializing','completed','partial','materialization_failed','unknown','rejected'));
CREATE INDEX IF NOT EXISTS mio_image_jobs_unfinished ON mio_image_jobs(owner_id)
  WHERE state IN ('accepted','materializing');
CREATE INDEX IF NOT EXISTS mio_image_outbox_pending ON mio_image_outbox(job_id) WHERE sent_at IS NULL;
CREATE TABLE IF NOT EXISTS mio_image_outputs (
  job_id uuid NOT NULL REFERENCES mio_image_jobs(id), output_index integer NOT NULL,
  asset_id uuid NOT NULL REFERENCES mio_assets(id), PRIMARY KEY(job_id,output_index)
);
CREATE TABLE IF NOT EXISTS mio_compute_inbox (
  id uuid PRIMARY KEY, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);`;

export async function checkComputeSchema(pool: Pool, images = false): Promise<void> {
  await pool.query('SELECT asset_kind FROM mio_assets LIMIT 0');
  await pool.query(
    'SELECT id,owner_id,request_id,input_asset_id,input_key,input_size,input_etag,state,attempt,attempt_id,command_id,result_asset_id,error_code,created_at,updated_at FROM mio_compute_jobs LIMIT 0',
  );
  await pool.query(
    'SELECT id,job_id,command,lease_id,lease_until,sent_at,created_at FROM mio_compute_outbox LIMIT 0',
  );
  await pool.query('SELECT id,payload,created_at FROM mio_compute_inbox LIMIT 0');
  if (images) {
    await pool.query(
      'SELECT id,owner_id,request_id,input_hash,command,admitted,error_code,active_recovery_id,active_recovery_seq,state,created_at FROM mio_image_jobs LIMIT 0',
    );
    await pool.query('SELECT job_id,sent_at,recovery_command FROM mio_image_outbox LIMIT 0');
    await pool.query('SELECT job_id,output_index,asset_id FROM mio_image_outputs LIMIT 0');
    const constraint = await pool.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='mio_image_jobs'::regclass AND conname='mio_image_jobs_state_check'",
    );
    if (
      !['partial', 'materialization_failed'].every((value) =>
        constraint.rows[0]?.definition.includes(`'${value}'`),
      )
    )
      throw new Error('COMPUTE_IMAGE_SCHEMA_OUTDATED');
  }
}
