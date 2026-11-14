import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { createId } from '@mio/foundation/identifiers';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { COMPUTE_PROFILE, COMPUTE_VERSION, imageOutputIndex } from '@mio/compute-contracts';
import type { ComputeAttempt, ComputeCommandV1, ComputeResultV1 } from '@mio/compute-contracts';
import type { ImageCommandV1, ImageRecoveryCommandV1, ImageResultV1 } from '@mio/compute-contracts';
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

async function checkCapacity(client: PoolClient, owner: string, images: boolean): Promise<void> {
  const video = (
    await client.query<{ global_count: string; owner_count: string }>(
      "SELECT count(*) AS global_count, count(*) FILTER (WHERE owner_id=$1) AS owner_count FROM mio_compute_jobs WHERE state IN ('accepted','queued','running')",
      [owner],
    )
  ).rows[0]!;
  const image = images
    ? (
        await client.query<{ global_count: string; owner_count: string }>(
          "SELECT count(*) AS global_count, count(*) FILTER (WHERE owner_id=$1) AS owner_count FROM mio_image_jobs WHERE state IN ('accepted','materializing')",
          [owner],
        )
      ).rows[0]!
    : { global_count: '0', owner_count: '0' };
  if (
    Number(video.global_count) + Number(image.global_count) >= 500 ||
    Number(video.owner_count) + Number(image.owner_count) >= 10
  )
    throw new ComputeError(HTTP_STATUS.TOO_MANY_REQUESTS, 'COMPUTE_QUOTA_EXCEEDED');
}

export class ComputeStore {
  private readonly pool: Pool;
  readonly imagesAvailable: boolean;
  constructor(pool: Pool, imagesEnabled = false) {
    this.pool = pool;
    this.imagesAvailable = imagesEnabled;
  }

  async imageRequest(owner: string, requestId: string) {
    return (
      await this.pool.query<{ id: string; input_hash: string }>(
        'SELECT id,input_hash FROM mio_image_jobs WHERE owner_id=$1 AND request_id=$2',
        [owner, requestId],
      )
    ).rows[0];
  }
  async imageCreate(
    owner: string,
    requestId: string,
    hash: string,
    command: ImageCommandV1,
    admitted: Record<string, unknown> = {},
  ) {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [672049923]);
      const existing = (
        await client.query<{ id: string; input_hash: string }>(
          'SELECT id,input_hash FROM mio_image_jobs WHERE owner_id=$1 AND request_id=$2',
          [owner, requestId],
        )
      ).rows[0];
      if (existing) {
        if (existing.input_hash !== hash) throw new ComputeError(409, 'REQUEST_CONFLICT');
        return existing.id;
      }
      await checkCapacity(client, owner, true);
      const saved = await client.query(
        "INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,admitted,state) VALUES($1,$2,$3,$4,$5,$6,'accepted') ON CONFLICT(owner_id,request_id) DO NOTHING RETURNING id",
        [command.jobId, owner, requestId, hash, JSON.stringify(command), JSON.stringify(admitted)],
      );
      if (saved.rowCount)
        await client.query('INSERT INTO mio_image_outbox(job_id) VALUES($1)', [command.jobId]);
      const row = (
        await client.query<{ id: string; input_hash: string }>(
          'SELECT id,input_hash FROM mio_image_jobs WHERE owner_id=$1 AND request_id=$2',
          [owner, requestId],
        )
      ).rows[0]!;
      if (row.input_hash !== hash) throw new ComputeError(409, 'REQUEST_CONFLICT');
      return row.id;
    });
  }
  async imageGet(owner: string, id: string) {
    const row = (
      await this.pool.query<{
        id: string;
        state: string;
        error_code: string | null;
        command: ImageCommandV1;
      }>('SELECT id,state,error_code,command FROM mio_image_jobs WHERE owner_id=$1 AND id=$2', [
        owner,
        id,
      ])
    ).rows[0];
    if (!row) throw new ComputeError(404, 'JOB_NOT_FOUND');
    const outputs = await this.pool.query<{ output_index: number; asset_id: string }>(
      'SELECT output_index,asset_id FROM mio_image_outputs WHERE job_id=$1 ORDER BY output_index',
      [id],
    );
    return {
      jobId: row.id,
      status: row.state,
      requestedCount: row.command.input.n ?? 1,
      errorCode: row.error_code,
      assetIds: outputs.rows.map((item) => item.asset_id),
      outputs: outputs.rows.map((item) => ({ index: item.output_index, assetId: item.asset_id })),
    };
  }
  async imagePending(): Promise<ImageCommandV1 | ImageRecoveryCommandV1 | undefined> {
    return (
      await this.pool.query<{ command: ImageCommandV1 | ImageRecoveryCommandV1 }>(
        'SELECT COALESCE(o.recovery_command,j.command) AS command FROM mio_image_jobs j JOIN mio_image_outbox o ON o.job_id=j.id WHERE o.sent_at IS NULL ORDER BY j.created_at LIMIT 1',
      )
    ).rows[0]?.command;
  }
  async imageSent(id: string, messageId: string) {
    await this.pool.query(
      `UPDATE mio_image_outbox o SET sent_at=now() FROM mio_image_jobs j
      WHERE o.job_id=$1 AND j.id=o.job_id AND COALESCE(o.recovery_command,j.command)->>'messageId'=$2`,
      [id, messageId],
    );
  }
  async imageRecover(owner: string, id: string) {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [672049923]);
      const job = (
        await client.query<{ state: string; command: ImageCommandV1; active_recovery_seq: number }>(
          'SELECT state,command,active_recovery_seq FROM mio_image_jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [id, owner],
        )
      ).rows[0];
      if (!job) throw new ComputeError(404, 'JOB_NOT_FOUND');
      if (job.state === 'materializing') return;
      if (job.state !== 'materialization_failed') throw new ComputeError(409, 'RESULT_CONFLICT');
      if (job.active_recovery_seq >= 2147483647) throw new ComputeError(409, 'RESULT_CONFLICT');
      await checkCapacity(client, owner, true);
      const recovery: ImageRecoveryCommandV1 = {
        version: 1,
        type: 'image.recover',
        messageId: createId(),
        commandId: job.command.messageId,
        jobId: id,
        sequence: job.active_recovery_seq + 1,
      };
      await client.query(
        "UPDATE mio_image_jobs SET state='materializing',error_code=NULL,active_recovery_id=$2,active_recovery_seq=$3 WHERE id=$1",
        [id, recovery.messageId, recovery.sequence],
      );
      await client.query('INSERT INTO mio_image_outbox(job_id,recovery_command) VALUES($1,$2)', [
        id,
        JSON.stringify(recovery),
      ]);
    });
  }
  async imageAccept(result: ImageResultV1) {
    await transaction(this.pool, async (client) => {
      const job = (
        await client.query<{
          owner_id: string;
          command: ImageCommandV1;
          state: string;
          active_recovery_id: string | null;
        }>(
          'SELECT owner_id,command,state,active_recovery_id FROM mio_image_jobs WHERE id=$1 FOR UPDATE',
          [result.jobId],
        )
      ).rows[0];
      if (!job || job.command.messageId !== result.commandId)
        throw new ComputeError(409, 'RESULT_CONFLICT');
      if (job.active_recovery_id !== (result.recoveryId ?? null)) return;
      if (
        ['completed', 'partial', 'materialization_failed', 'unknown', 'rejected'].includes(
          job.state,
        )
      )
        return;
      const requested = job.command.input.n ?? 1;
      if (
        result.outputs.length > requested ||
        (result.state === 'completed' && result.outputs.length !== requested) ||
        (result.state === 'partial' && result.outputs.length >= requested)
      )
        throw new ComputeError(409, 'RESULT_CONFLICT');
      if (
        ['completed', 'partial', 'materializing', 'materialization_failed'].includes(result.state)
      ) {
        let previousIndex = -1;
        for (const output of result.outputs) {
          const index = imageOutputIndex(result.jobId, output.key, output.contentType);
          if (index === null || index >= requested || index <= previousIndex)
            throw new ComputeError(409, 'RESULT_CONFLICT');
          previousIndex = index;
          const existing = await client.query<{
            raw_key: string;
            size_bytes: string;
            content_type: string;
          }>(
            `SELECT a.raw_key,a.size_bytes,a.content_type FROM mio_image_outputs o
             JOIN mio_assets a ON a.id=o.asset_id WHERE o.job_id=$1 AND o.output_index=$2`,
            [result.jobId, index],
          );
          if (existing.rows[0]) {
            const asset = existing.rows[0];
            if (
              asset.raw_key !== output.key ||
              Number(asset.size_bytes) !== output.sizeBytes ||
              asset.content_type !== output.contentType
            )
              throw new ComputeError(409, 'RESULT_CONFLICT');
            continue;
          }
          const asset = createId();
          await client.query(
            `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at,staging_deleted_at,asset_kind)
            VALUES($1,$2,$3,$4,$5,NULL,$6,'ready',now(),now(),'derived')`,
            [
              asset,
              job.owner_id,
              `image-${index}`,
              output.contentType,
              output.sizeBytes,
              output.key,
            ],
          );
          await client.query('INSERT INTO mio_image_outputs VALUES($1,$2,$3)', [
            result.jobId,
            index,
            asset,
          ]);
        }
      }
      await client.query('UPDATE mio_image_jobs SET state=$2,error_code=$3 WHERE id=$1', [
        result.jobId,
        result.state,
        result.errorCode ?? null,
      ]);
      if (result.state !== 'materializing') {
        await client.query("UPDATE mio_image_jobs SET command=command-'credential' WHERE id=$1", [
          result.jobId,
        ]);
        await client.query('DELETE FROM mio_image_outbox WHERE job_id=$1', [result.jobId]);
      }
    });
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
      await checkCapacity(client, owner, this.imagesAvailable);
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

export async function createComputeStore(
  databaseURL: string,
  images = false,
): Promise<ComputeStore> {
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
    const found = await pool.query<{ images: boolean }>(
      "SELECT to_regclass('mio_image_jobs') IS NOT NULL OR to_regclass('mio_image_outbox') IS NOT NULL OR to_regclass('mio_image_outputs') IS NOT NULL AS images",
    );
    const imagesAvailable = images || found.rows[0]!.images;
    if (imagesAvailable) await checkComputeSchema(pool, true);
    return new ComputeStore(pool, imagesAvailable);
  } catch {
    await pool.end();
    throw new Error('COMPUTE_SCHEMA: run compute:migrate and check database access');
  }
}
