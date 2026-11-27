import { Pool } from 'pg';
import { readAuthConfig } from '../../src/auth/config.ts';
import { AccountDeletionStore } from '../../src/account-deletion/store.ts';

if (process.argv.length !== 2) throw new Error('Usage: account-deletion:monitor');
const config = readAuthConfig();
if (!config) throw new Error('AUTH_CONFIG: authentication required');
const pool = new Pool({ connectionString: config.databaseURL, connectionTimeoutMillis: 5000 });
try {
  await new AccountDeletionStore(pool).monitor();
  const jobs =
    await pool.query(`SELECT user_id,finalized_at,deadline_at,completed_at,prior_completed_at,replayed_at,
    warning_at,overdue_at,failed_step,error_code,remaining,last_attempt_at,
    (replayed_at IS NOT NULL AND prior_completed_at IS NULL) AS historical_completion_unknown,
    EXTRACT(epoch FROM clock_timestamp()-finalized_at)::bigint AS age_seconds
    FROM mio_account_cleanup_jobs WHERE completed_at IS NULL OR overdue_at IS NOT NULL ORDER BY deadline_at,user_id LIMIT 100`);
  const executors = await pool.query(
    'SELECT id,heartbeat_at FROM mio_account_cleanup_executors ORDER BY heartbeat_at DESC LIMIT 20',
  );
  console.log(JSON.stringify({ jobs: jobs.rows, executors: executors.rows }, null, 2));
} finally {
  await pool.end();
}
