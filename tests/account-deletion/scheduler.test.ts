import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { AccountDeletionStore } from '../../src/account-deletion/store.ts';
import { startAccountDeletion } from '../../src/account-deletion/scheduler.ts';

it('interleaves a large account with small accounts, resumes a lost receipt and fences stale lease acknowledgements', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  const store = new AccountDeletionStore(pool);
  let executor: ReturnType<typeof startAccountDeletion> | undefined;
  try {
    await pool.query(`INSERT INTO mio_account_cleanup_jobs(user_id,finalized_at,deadline_at)
      VALUES('large',now(),now()+interval '24 hours'),('small',now(),now()+interval '24 hours')`);
    const original = await store.claim();
    expect(original).toBeDefined();
    await pool.query(
      "UPDATE mio_account_cleanup_jobs SET lease_until=now()-interval '1 second' WHERE user_id=$1",
      [original!.user_id],
    );
    const current = await store.claim();
    expect(current!.user_id).toBe('small');
    await store.release(current!);
    const replacement = await store.claim();
    expect(replacement!.user_id).toBe(original!.user_id);
    expect(await store.receipt(original!, 'data', true, 0)).toBe(false);
    // Domain deletion survived; the auth-side acknowledgement was lost. Retry consumes the persisted empty domain.
    await store.release(replacement!);
    const order: string[] = [];
    let batches = 0;
    executor = startAccountDeletion(store, [
      {
        name: 'data',
        async run(job) {
          order.push(job.user_id);
          return job.user_id === 'large'
            ? { done: ++batches >= 100, remaining: 100 - batches }
            : { done: true, remaining: 0 };
        },
      },
    ]);
    await executor.round();
    await executor.round();
    expect(order.indexOf('small')).toBeLessThan(3);
    expect(
      (await pool.query("SELECT completed_at FROM mio_account_cleanup_jobs WHERE user_id='small'"))
        .rows[0].completed_at,
    ).not.toBeNull();
    expect(
      (await pool.query("SELECT completed_at FROM mio_account_cleanup_jobs WHERE user_id='large'"))
        .rows[0].completed_at,
    ).toBeNull();
  } finally {
    if (executor) await executor.close();
    else await store.close();
    await database.close();
  }
});

it('records the original 20h warning and 24h breach independently of backoff and preserves them after late success', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  const store = new AccountDeletionStore(pool);
  try {
    await pool.query(`INSERT INTO mio_account_cleanup_jobs(user_id,finalized_at,deadline_at,next_attempt_at)
      VALUES('warning',now()-interval '20 hours',now()+interval '4 hours',now()+interval '2 days'),
      ('overdue',now()-interval '25 hours',now()-interval '1 hour',now()+interval '2 days')`);
    await store.monitor();
    const warning = (
      await pool.query("SELECT * FROM mio_account_cleanup_jobs WHERE user_id='warning'")
    ).rows[0];
    expect(warning.warning_at).toEqual(new Date(warning.finalized_at.getTime() + 20 * 3600000));
    expect(warning.overdue_at).toBeNull();
    const overdue = (
      await pool.query("SELECT * FROM mio_account_cleanup_jobs WHERE user_id='overdue'")
    ).rows[0];
    expect(overdue.overdue_at).toEqual(overdue.deadline_at);
    await pool.query(
      "UPDATE mio_account_cleanup_jobs SET next_attempt_at=now() WHERE user_id='overdue'",
    );
    const job = await store.claim();
    expect(job!.user_id).toBe('overdue');
    await store.receipt(job!, 'archive', true, 0);
    expect(await store.complete(job!, ['archive'])).toBe(true);
    await store.monitor();
    const completed = (
      await pool.query("SELECT * FROM mio_account_cleanup_jobs WHERE user_id='overdue'")
    ).rows[0];
    expect(completed.overdue_at).toEqual(overdue.deadline_at);
    expect(completed.completed_at).not.toBeNull();
    await store.heartbeat(randomUUID());
    expect((await pool.query('SELECT id FROM mio_account_cleanup_executors')).rowCount).toBe(1);
  } finally {
    await store.close();
    await database.close();
  }
});

it('leases one job per executor, persists bounded 1/5/15 minute backoff and does not let an archive failure mark completion', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  const store = new AccountDeletionStore(pool);
  try {
    await pool.query(
      "INSERT INTO mio_account_cleanup_jobs(user_id,finalized_at,deadline_at) VALUES('owner',now(),now()+interval '24 hours')",
    );
    for (const minutes of [1, 5, 15, 15]) {
      const claimed = await Promise.all([store.claim(), store.claim()]);
      expect(claimed.filter(Boolean)).toHaveLength(1);
      const job = claimed.find(Boolean)!;
      await store.release(job, { step: 'archive', code: 'ACCOUNT_ARCHIVE_FAILED' });
      const row = (
        await pool.query(
          'SELECT *,extract(epoch FROM next_attempt_at-clock_timestamp()) AS seconds FROM mio_account_cleanup_jobs',
        )
      ).rows[0];
      expect(Number(row.seconds)).toBeGreaterThan(minutes * 60 - 3);
      expect(Number(row.seconds)).toBeLessThanOrEqual(minutes * 60);
      expect(row.failed_step).toBe('archive');
      expect(row.completed_at).toBeNull();
      await pool.query('UPDATE mio_account_cleanup_jobs SET next_attempt_at=now()');
    }
  } finally {
    await store.close();
    await database.close();
  }
});
