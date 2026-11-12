import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { createId } from '@mio/foundation/identifiers';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { COMPUTE_PROFILE, COMPUTE_VERSION } from '@mio/compute-contracts';
import type { ComputeAttempt, ComputeCommandV1, ComputeResultV1 } from '@mio/compute-contracts';
import { checkComputeSchema } from './schema.ts';
import { ComputeError } from './errors.ts';

const log = createLogger('app', 'compute-store');

export interface JobRow {
  id: string;
  owner_id: string;
  request_id: string;
  input_asset_id: string;
  input_key: string;
  input_size: string;
  input_etag: string;
  state: 'accepted' | 'queued' | 'running' | 'succeeded' | 'failed';
  attempt: ComputeAttempt;
  attempt_id: string;
  command_id: string;
  result_asset_id: string | null;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

function command(job: JobRow): ComputeCommandV1 {
  return {
    version: COMPUTE_VERSION,
    type: 'transcode.request',
    messageId: job.command_id,
    jobId: job.id,
    attemptId: job.attempt_id,
    attempt: job.attempt,
    profile: COMPUTE_PROFILE,
    input: {
      assetId: job.input_asset_id,
      key: job.input_key,
      sizeBytes: Number(job.input_size),
      etag: job.input_etag,
    },
  };
}

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const retryable = new Set([
  'TRANSCODE_FAILED',
  'EXECUTION_TIMEOUT',
  'STORAGE_FAILURE',
  'WORKER_INTERRUPTED',
  'OUTPUT_INVALID',
]);

export class ComputeStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async owned(id: string, owner: string): Promise<JobRow | undefined> {
    return (
      await this.pool.query<JobRow>('SELECT * FROM mio_compute_jobs WHERE id=$1 AND owner_id=$2', [
        id,
        owner,
      ])
    ).rows[0];
  }
  async request(owner: string, requestId: string): Promise<JobRow | undefined> {
    return (
      await this.pool.query<JobRow>(
        'SELECT * FROM mio_compute_jobs WHERE owner_id=$1 AND request_id=$2',
        [owner, requestId],
      )
    ).rows[0];
  }
  async input(
    owner: string,
    id: string,
  ): Promise<{ raw_key: string; size_bytes: string } | undefined> {
    return (
      await this.pool.query<{ raw_key: string; size_bytes: string }>(
        "SELECT raw_key,size_bytes FROM mio_assets WHERE id=$1 AND owner_id=$2 AND state='ready' AND asset_kind='original' AND raw_key IS NOT NULL",
        [id, owner],
      )
    ).rows[0];
  }

  async create(
    owner: string,
    requestId: string,
    assetId: string,
    key: string,
    size: number,
    etag: string,
  ): Promise<{ job: JobRow; created: boolean }> {
    return transaction(this.pool, async (client) => {
      // Serializing admission keeps both quotas exact, including concurrent first requests.
      await client.query('SELECT pg_advisory_xact_lock($1)', [672049923]);
      const existing = (
        await client.query<JobRow>(
          'SELECT * FROM mio_compute_jobs WHERE owner_id=$1 AND request_id=$2',
          [owner, requestId],
        )
      ).rows[0];
      if (existing) {
        if (existing.input_asset_id !== assetId)
          throw new ComputeError(HTTP_STATUS.CONFLICT, 'REQUEST_CONFLICT');
        return { job: existing, created: false };
      }
      const counts = (
        await client.query<{ global_count: string; owner_count: string }>(
          "SELECT count(*) AS global_count, count(*) FILTER (WHERE owner_id=$1) AS owner_count FROM mio_compute_jobs WHERE state IN ('accepted','queued','running')",
          [owner],
        )
      ).rows[0]!;
      if (Number(counts.global_count) >= 500 || Number(counts.owner_count) >= 10)
        throw new ComputeError(HTTP_STATUS.TOO_MANY_REQUESTS, 'COMPUTE_QUOTA_EXCEEDED');
      const asset = (
        await client.query<{ raw_key: string; size_bytes: string }>(
          "SELECT raw_key,size_bytes FROM mio_assets WHERE id=$1 AND owner_id=$2 AND state='ready' AND asset_kind='original' FOR SHARE",
          [assetId, owner],
        )
      ).rows[0];
      if (!asset || asset.raw_key !== key || Number(asset.size_bytes) !== size)
        throw new ComputeError(HTTP_STATUS.NOT_FOUND, 'ASSET_NOT_FOUND');
      const id = createId(),
        attemptId = createId(),
        commandId = createId();
      const job = (
        await client.query<JobRow>(
          `INSERT INTO mio_compute_jobs(id,owner_id,request_id,input_asset_id,input_key,input_size,input_etag,state,attempt,attempt_id,command_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,'accepted',1,$8,$9) RETURNING *`,
          [id, owner, requestId, assetId, key, size, etag, attemptId, commandId],
        )
      ).rows[0]!;
      await client.query('INSERT INTO mio_compute_outbox(id,job_id,command) VALUES($1,$2,$3)', [
        commandId,
        id,
        JSON.stringify(command(job)),
      ]);
      return { job, created: true };
    });
  }

  async claim(): Promise<{ command: ComputeCommandV1; lease: string } | undefined> {
    const lease = createId();
    const row = (
      await this.pool.query<{ command: ComputeCommandV1 }>(
        `UPDATE mio_compute_outbox SET lease_id=$1,lease_until=now()+interval '2 minutes'
       WHERE id=(SELECT id FROM mio_compute_outbox WHERE sent_at IS NULL AND (lease_until IS NULL OR lease_until<=now())
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING command`,
        [lease],
      )
    ).rows[0];
    return row ? { command: row.command, lease } : undefined;
  }

  async sent(message: ComputeCommandV1, lease: string): Promise<void> {
    await transaction(this.pool, async (client) => {
      const sent = await client.query(
        'UPDATE mio_compute_outbox SET sent_at=now(),lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2 AND sent_at IS NULL RETURNING id',
        [message.messageId, lease],
      );
      if (sent.rowCount)
        await client.query(
          "UPDATE mio_compute_jobs SET state='queued',updated_at=now() WHERE id=$1 AND command_id=$2 AND state='accepted'",
          [message.jobId, message.messageId],
        );
    });
  }
  async release(messageId: string, lease: string): Promise<void> {
    await this.pool.query(
      'UPDATE mio_compute_outbox SET lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2 AND sent_at IS NULL',
      [messageId, lease],
    );
  }

  async current(result: ComputeResultV1): Promise<boolean> {
    const row = (
      await this.pool.query<JobRow>('SELECT * FROM mio_compute_jobs WHERE id=$1', [result.jobId])
    ).rows[0];
    return Boolean(
      row &&
      row.command_id === result.commandId &&
      row.attempt_id === result.attemptId &&
      row.attempt === result.attempt &&
      !['succeeded', 'failed'].includes(row.state),
    );
  }

  async accept(result: ComputeResultV1): Promise<void> {
    await transaction(this.pool, async (client) => {
      const recorded = await client.query(
        'INSERT INTO mio_compute_inbox(id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',
        [result.messageId, JSON.stringify(result)],
      );
      if (!recorded.rowCount) {
        const same = await client.query(
          'SELECT id FROM mio_compute_inbox WHERE id=$1 AND payload=$2::jsonb',
          [result.messageId, JSON.stringify(result)],
        );
        if (!same.rowCount) throw new ComputeError(HTTP_STATUS.CONFLICT, 'RESULT_CONFLICT');
        return;
      }
      const job = (
        await client.query<JobRow>('SELECT * FROM mio_compute_jobs WHERE id=$1 FOR UPDATE', [
          result.jobId,
        ])
      ).rows[0];
      if (
        !job ||
        job.command_id !== result.commandId ||
        job.attempt_id !== result.attemptId ||
        job.attempt !== result.attempt ||
        ['succeeded', 'failed'].includes(job.state)
      )
        return;
      if (result.state === 'succeeded') {
        const asset = createId();
        await client.query(
          `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at,staging_deleted_at,asset_kind)
          VALUES($1,$2,'transcoded.mp4','video/mp4',$3,NULL,$4,'ready',now(),now(),'derived')`,
          [asset, job.owner_id, result.output.sizeBytes, result.output.key],
        );
        await client.query(
          "UPDATE mio_compute_jobs SET state='succeeded',result_asset_id=$2,error_code=NULL,updated_at=now() WHERE id=$1",
          [job.id, asset],
        );
      } else if (result.state === 'failed' && retryable.has(result.errorCode) && job.attempt < 3) {
        const next = (
          await client.query<JobRow>(
            `UPDATE mio_compute_jobs SET attempt=attempt+1,attempt_id=$2,command_id=$3,error_code=$4,updated_at=now() WHERE id=$1 RETURNING *`,
            [job.id, createId(), createId(), result.errorCode],
          )
        ).rows[0]!;
        await client.query('INSERT INTO mio_compute_outbox(id,job_id,command) VALUES($1,$2,$3)', [
          next.command_id,
          next.id,
          JSON.stringify(command(next)),
        ]);
      } else if (result.state === 'failed') {
        await client.query(
          "UPDATE mio_compute_jobs SET state='failed',error_code=$2,updated_at=now() WHERE id=$1",
          [job.id, result.errorCode],
        );
      } else {
        await client.query(
          "UPDATE mio_compute_jobs SET state='running',error_code=$2,updated_at=now() WHERE id=$1",
          [job.id, result.state === 'unknown' ? result.errorCode : job.error_code],
        );
      }
    });
  }
  close(): Promise<void> {
    return this.pool.end();
  }
}

export async function createComputeStore(databaseURL: string): Promise<ComputeStore> {
  const pool = new Pool({
    connectionString: databaseURL,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 5000,
    application_name: 'mio-compute',
  });
  pool.on('error', () => log.error('COMPUTE_DATABASE_CONNECTION_ERROR'));
  try {
    await checkComputeSchema(pool);
    return new ComputeStore(pool);
  } catch {
    await pool.end();
    throw new Error('COMPUTE_SCHEMA: run compute:migrate and check database access');
  }
}
