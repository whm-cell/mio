import { HTTP_STATUS } from '@mio/foundation/http-status';
import type { PoolClient } from 'pg';
import { ComputeError } from './errors.ts';

// Keep the lock used by the original video admission path across additive rollouts.
const COMPUTE_CAPACITY_LOCK = 672049923;

export async function lockComputeCapacity(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [COMPUTE_CAPACITY_LOCK]);
}

/** Call under the admission transaction lock after resolving request idempotency. */
export async function checkComputeCapacity(client: PoolClient, owner: string): Promise<void> {
  const { rows } = await client.query<{ global_count: string; owner_count: string }>(
    `SELECT count(*) AS global_count, count(*) FILTER (WHERE owner_id=$1) AS owner_count
     FROM (
       SELECT owner_id FROM mio_compute_jobs WHERE state IN ('accepted','queued','running')
       UNION ALL
       SELECT owner_id FROM mio_media_jobs WHERE state NOT IN ('succeeded','failed','cancelled')
     ) AS active_jobs`,
    [owner],
  );
  const active = rows[0]!;
  if (Number(active.global_count) >= 500 || Number(active.owner_count) >= 10)
    throw new ComputeError(HTTP_STATUS.TOO_MANY_REQUESTS, 'COMPUTE_QUOTA_EXCEEDED');
}
