import { lockComputeCapacity } from './capacity.ts';
import type { Pool, PoolClient } from 'pg';
import { parseComputeResultV1, parseMediaResult } from '@mio/compute-contracts';
import type { ComputeResultV1, MediaOperation, MediaResult } from '@mio/compute-contracts';
import type { AssetObjectStore } from '../assets/contracts.ts';
import type { AssetGc } from '../assets/gc.ts';
import { readVerifiedMediaManifest } from './media/manifest.ts';

export class AccountResultClosed extends Error {
  constructor() {
    super('ACCOUNT_DELETED_RESULT');
  }
}
export interface DeletedAttempt {
  id: string;
  owner_id: string;
  attempt_id: string;
  command_id: string;
  operation: MediaOperation | null;
}
type ResultIdentity = { jobId: string; attemptId: string; commandId: string };

export async function readDeletedAttempt(
  database: Pick<Pool, 'query'>,
  kind: 'media' | 'transcode',
  result: ResultIdentity,
): Promise<DeletedAttempt | undefined> {
  const table = kind === 'media' ? 'mio_media_jobs' : 'mio_compute_jobs';
  const outbox = kind === 'media' ? 'mio_media_outbox' : 'mio_compute_outbox';
  return (
    await database.query<DeletedAttempt>(
      `SELECT job_id AS id,owner_id,attempt_id,command_id,operation
    FROM mio_deleted_compute_attempts WHERE job_id=$1 AND attempt_id=$2 AND command_id=$3 AND kind=$4
    UNION ALL SELECT j.id,j.owner_id,j.attempt_id,j.command_id,${kind === 'media' ? 'j.operation' : 'NULL AS operation'}
    FROM ${table} j JOIN mio_closed_accounts c ON c.user_id=j.owner_id WHERE j.id=$1 AND j.attempt_id=$2 AND j.command_id=$3
    UNION ALL SELECT j.id,j.owner_id,(o.command->>'attemptId')::uuid,o.id,${kind === 'media' ? 'j.operation' : 'NULL AS operation'}
    FROM ${outbox} o JOIN ${table} j ON j.id=o.job_id JOIN mio_closed_accounts c ON c.user_id=j.owner_id
    WHERE j.id=$1 AND o.command->>'attemptId'=$2::text AND o.id=$3 LIMIT 1`,
      [result.jobId, result.attemptId, result.commandId, kind],
    )
  ).rows[0];
}

export async function closedComputeJob(
  database: Pick<Pool, 'query'>,
  kind: 'media' | 'transcode',
  jobId: string,
) {
  const table = kind === 'media' ? 'mio_media_jobs' : 'mio_compute_jobs';
  return Boolean(
    (
      await database.query(
        `SELECT 1 FROM ${table} j JOIN mio_closed_accounts c ON c.user_id=j.owner_id WHERE j.id=$1
    UNION ALL SELECT 1 FROM mio_deleted_compute_attempts WHERE job_id=$1 AND kind=$2 LIMIT 1`,
        [jobId, kind],
      )
    ).rowCount,
  );
}

/** Serialize the final inbox/publication transaction with domain closure, including stale terminal messages. */
export async function guardDeletedResult(
  client: PoolClient,
  kind: 'media' | 'transcode',
  jobId: string,
) {
  const table = kind === 'media' ? 'mio_media_jobs' : 'mio_compute_jobs';
  // Admission/retry capacity comes first, then the job and owner fence. Outbox ACKs use this order too.
  await lockComputeCapacity(client);
  await client.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [jobId]);
  const owner = (
    await client.query<{ owner_id: string }>(
      `SELECT owner_id FROM ${table} WHERE id=$1
    UNION ALL SELECT owner_id FROM mio_deleted_compute_attempts WHERE job_id=$1 AND kind=$2 LIMIT 1`,
      [jobId, kind],
    )
  ).rows[0];
  if (!owner) return false;
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('mio:closed-account:'||$1,0))",
    [owner.owner_id],
  );
  return Boolean(
    (await client.query('SELECT 1 FROM mio_closed_accounts WHERE user_id=$1', [owner.owner_id]))
      .rowCount,
  );
}

export async function reclaimDeletedTranscode(
  attempt: DeletedAttempt,
  value: ComputeResultV1,
  gc: AssetGc,
) {
  const result = parseComputeResultV1(value);
  if (result.state === 'succeeded') await gc.enqueue(attempt.owner_id, [result.output.key]);
}

export async function reclaimDeletedMedia(
  attempt: DeletedAttempt,
  value: MediaResult,
  objects: AssetObjectStore,
  gc: AssetGc,
  signal: AbortSignal,
) {
  const result = parseMediaResult(value);
  if (result.state !== 'succeeded') return;
  if (!attempt.operation) throw new Error('MEDIA_DELETED_ATTEMPT_INVALID');
  let manifest;
  try {
    manifest = await readVerifiedMediaManifest(
      objects,
      {
        id: attempt.id,
        attempt_id: attempt.attempt_id,
        operation: attempt.operation,
        profile: 'standard-media',
      },
      result.manifest,
      signal,
    );
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    // Another valid cleanup may already have deleted this immutable manifest after journaling all members.
    const keys = await gc.knownManifestKeys(attempt.owner_id, result.manifest);
    if (!keys) throw error;
    await gc.enqueue(attempt.owner_id, keys, result.manifest);
    return;
  }
  await gc.enqueue(
    attempt.owner_id,
    [result.manifest.key, ...manifest.files.map((file) => file.key)],
    result.manifest,
  );
}
