import { utcISOString } from '@mio/foundation/time';
import { Pool } from 'pg';
import { createId } from '@mio/foundation/identifiers';
import { checkAccountDeletionSchema } from './schema.ts';

export interface CleanupJob {
  user_id: string;
  finalized_at: Date;
  deadline_at: Date;
  progress: Record<string, string>;
  remaining: Record<string, number>;
  lease_id: string;
  attempts: number;
  required_domains: string[];
}

/** Every operation releases its connection before a domain or object-store call starts. */
export class AccountDeletionStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async claim(): Promise<CleanupJob | undefined> {
    return (
      await this.pool.query<CleanupJob>(
        `WITH due AS (
      SELECT user_id FROM mio_account_cleanup_jobs WHERE completed_at IS NULL
      AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
      ORDER BY last_attempt_at NULLS FIRST,deadline_at,user_id LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE mio_account_cleanup_jobs j SET lease_id=$1,lease_until=clock_timestamp()+interval '30 seconds',
      last_attempt_at=clock_timestamp() FROM due WHERE j.user_id=due.user_id RETURNING j.*`,
        [createId()],
      )
    ).rows[0];
  }

  async receipt(job: CleanupJob, step: string, done: boolean, remaining: number) {
    const result = await this.pool.query(
      `UPDATE mio_account_cleanup_jobs SET
      progress=CASE WHEN $4 THEN progress||jsonb_build_object($3::text,clock_timestamp()) ELSE progress END,
      remaining=remaining||jsonb_build_object($3::text,$5::integer),attempts=0,failed_step=NULL,error_code=NULL
      WHERE user_id=$1 AND lease_id=$2 AND lease_until>clock_timestamp() AND completed_at IS NULL`,
      [job.user_id, job.lease_id, step, done, remaining],
    );
    if (result.rowCount && done) job.progress[step] = utcISOString();
    return result.rowCount === 1;
  }

  async release(job: CleanupJob, failure?: { step: string; code: string }) {
    await this.pool.query(
      `UPDATE mio_account_cleanup_jobs SET lease_id=NULL,lease_until=NULL,
      next_attempt_at=clock_timestamp()+CASE WHEN $3::text IS NULL THEN interval '0 seconds'
        WHEN attempts=0 THEN interval '1 minute' WHEN attempts=1 THEN interval '5 minutes' ELSE interval '15 minutes' END,
      attempts=CASE WHEN $3::text IS NULL THEN attempts ELSE attempts+1 END,failed_step=$3,error_code=$4
      WHERE user_id=$1 AND lease_id=$2 AND lease_until>clock_timestamp() AND completed_at IS NULL`,
      [job.user_id, job.lease_id, failure?.step ?? null, failure?.code ?? null],
    );
  }

  async complete(job: CleanupJob, steps: readonly string[]) {
    const result = await this.pool.query(
      `UPDATE mio_account_cleanup_jobs SET completed_at=clock_timestamp(),
      warning_at=CASE WHEN (replayed_at IS NULL OR prior_completed_at IS NOT NULL) AND COALESCE(prior_completed_at,clock_timestamp())>finalized_at+interval '20 hours' THEN COALESCE(warning_at,finalized_at+interval '20 hours') ELSE warning_at END,
      overdue_at=CASE WHEN (replayed_at IS NULL OR prior_completed_at IS NOT NULL) AND COALESCE(prior_completed_at,clock_timestamp())>deadline_at THEN COALESCE(overdue_at,deadline_at) ELSE overdue_at END,
      lease_id=NULL,lease_until=NULL WHERE user_id=$1 AND lease_id=$2 AND lease_until>clock_timestamp()
      AND completed_at IS NULL AND progress ?& $3::text[]`,
      [job.user_id, job.lease_id, steps],
    );
    return result.rowCount === 1;
  }

  async heartbeat(id: string) {
    await this.pool.query(
      `INSERT INTO mio_account_cleanup_executors(id,heartbeat_at) VALUES($1,clock_timestamp())
      ON CONFLICT(id) DO UPDATE SET heartbeat_at=EXCLUDED.heartbeat_at`,
      [id],
    );
    await this.pool.query(`DELETE FROM mio_account_cleanup_executors WHERE id IN
      (SELECT id FROM mio_account_cleanup_executors WHERE heartbeat_at<clock_timestamp()-interval '24 hours' ORDER BY heartbeat_at LIMIT 100)`);
  }

  /** Independent of leases/backoff. A late monitor also records a breach followed by late success. */
  async monitor() {
    await this.pool.query(`UPDATE mio_account_cleanup_jobs SET
      warning_at=CASE WHEN COALESCE(prior_completed_at,clock_timestamp())>=finalized_at+interval '20 hours'
        THEN COALESCE(warning_at,finalized_at+interval '20 hours') ELSE warning_at END,
      overdue_at=CASE WHEN COALESCE(prior_completed_at,clock_timestamp())>=deadline_at
        THEN COALESCE(overdue_at,deadline_at) ELSE overdue_at END
      WHERE completed_at IS NULL AND (replayed_at IS NULL OR prior_completed_at IS NOT NULL) AND finalized_at<=clock_timestamp()-interval '20 hours'
        AND (warning_at IS NULL OR overdue_at IS NULL)`);
  }

  close() {
    return this.pool.end();
  }
}

export async function createAccountDeletionStore(databaseURL: string) {
  const pool = new Pool({
    connectionString: databaseURL,
    max: 3,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 5000,
    application_name: 'mio-account-deletion',
  });
  pool.on('error', () => {});
  try {
    await checkAccountDeletionSchema(pool);
    return new AccountDeletionStore(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
}
