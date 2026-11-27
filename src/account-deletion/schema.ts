import type { Pool } from 'pg';

/** Auth owns the durable deletion fact. It contains no phone, credentials, URLs or content. */
export const accountDeletionSchemaSQL = `
CREATE TABLE IF NOT EXISTS mio_account_cleanup_jobs (
  user_id text PRIMARY KEY, finalized_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL, completed_at timestamptz,
  progress jsonb NOT NULL DEFAULT '{}', remaining jsonb NOT NULL DEFAULT '{}',
  required_domains text[] NOT NULL DEFAULT ARRAY['auth','archive']::text[],
  replayed_at timestamptz,prior_completed_at timestamptz,
  lease_id uuid, lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), last_attempt_at timestamptz,
  attempts integer NOT NULL DEFAULT 0, failed_step text, error_code text,
  warning_at timestamptz, overdue_at timestamptz,
  CHECK(deadline_at=finalized_at+interval '24 hours')
);
CREATE INDEX IF NOT EXISTS mio_account_cleanup_due ON mio_account_cleanup_jobs(next_attempt_at,last_attempt_at,deadline_at)
  WHERE completed_at IS NULL;
ALTER TABLE mio_account_cleanup_jobs ADD COLUMN IF NOT EXISTS required_domains text[] NOT NULL DEFAULT ARRAY['auth','archive']::text[];
ALTER TABLE mio_account_cleanup_jobs ADD COLUMN IF NOT EXISTS replayed_at timestamptz;
ALTER TABLE mio_account_cleanup_jobs ADD COLUMN IF NOT EXISTS prior_completed_at timestamptz;
CREATE INDEX IF NOT EXISTS mio_account_cleanup_deadline ON mio_account_cleanup_jobs(deadline_at) WHERE completed_at IS NULL;
CREATE TABLE IF NOT EXISTS mio_account_cleanup_executors (
  id uuid PRIMARY KEY, heartbeat_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS mio_account_cleanup_heartbeat ON mio_account_cleanup_executors(heartbeat_at);`;

export async function checkAccountDeletionSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query(`SELECT user_id,finalized_at,deadline_at,completed_at,progress,remaining,
    lease_id,lease_until,next_attempt_at,last_attempt_at,attempts,failed_step,error_code,
    warning_at,overdue_at,required_domains,replayed_at,prior_completed_at FROM mio_account_cleanup_jobs LIMIT 0`);
  await pool.query('SELECT id,heartbeat_at FROM mio_account_cleanup_executors LIMIT 0');
}
