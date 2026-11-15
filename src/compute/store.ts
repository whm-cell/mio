import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { createId } from '@mio/foundation/identifiers';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { COMPUTE_PROFILE, COMPUTE_VERSION, imageOutputIndex } from '@mio/compute-contracts';
import type { ComputeAttempt, ComputeCommandV1, ComputeResultV1 } from '@mio/compute-contracts';
import type {
  ImageCommandV1,
  ImageEnvelope,
  ImageQueryCommandV1,
  ImageRecoveryCommandV1,
  ImageResultV1,
} from '@mio/compute-contracts';
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

function imageQueryCommand(
  source: ImageCommandV1,
  upstreamTaskId: string,
  queryAttempt: number,
): ImageQueryCommandV1 {
  return {
    version: 1,
    type: 'image.query',
    messageId: createId(),
    commandId: source.messageId,
    jobId: source.jobId,
    ownerId: source.ownerId,
    expiresAt: source.expiresAt,
    profile: source.profile,
    operation: source.input.operation ?? 'generate',
    input: source.input,
    upstreamTaskId,
    queryAttempt,
    credential: source.credential,
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
      const asyncCapability =
        admitted.async && typeof admitted.async === 'object'
          ? (admitted.async as { maxQueries?: unknown; maxAgeSeconds?: unknown })
          : undefined;
      const asyncMaxQueries =
        Number.isSafeInteger(asyncCapability?.maxQueries) && Number(asyncCapability?.maxQueries) > 0
          ? Number(asyncCapability?.maxQueries)
          : null;
      const asyncDeadline =
        asyncMaxQueries !== null &&
        Number.isSafeInteger(asyncCapability?.maxAgeSeconds) &&
        Number(asyncCapability?.maxAgeSeconds) > 0
          ? new Date(
              Math.min(
                command.expiresAt,
                Date.now() + Number(asyncCapability?.maxAgeSeconds) * 1000,
              ),
            ).toISOString()
          : null;
      const saved = await client.query(
        "INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,admitted,async_max_queries,async_deadline,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'accepted') ON CONFLICT(owner_id,request_id) DO NOTHING RETURNING id",
        [
          command.jobId,
          owner,
          requestId,
          hash,
          JSON.stringify(command),
          JSON.stringify(admitted),
          asyncMaxQueries,
          asyncDeadline,
        ],
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
  async imagePending(): Promise<
    ImageCommandV1 | ImageQueryCommandV1 | ImageRecoveryCommandV1 | undefined
  > {
    return transaction(this.pool, async (client) => {
      const due = `o.sent_at IS NULL AND (
        j.next_query_at IS NULL OR j.next_query_at<=statement_timestamp() OR
        (o.query_command IS NOT NULL AND (
          j.async_max_queries IS NULL OR j.query_attempt>j.async_max_queries OR
          j.async_deadline IS NULL OR j.async_deadline<=statement_timestamp() OR
          to_timestamp((j.command->>'expiresAt')::double precision/1000)<=statement_timestamp()
        ))
      )`;
      const candidate = (
        await client.query<{ id: string }>(
          `SELECT j.id FROM mio_image_jobs j JOIN mio_image_outbox o ON o.job_id=j.id
           WHERE ${due} ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j`,
        )
      ).rows[0];
      if (!candidate) return undefined;
      const row = (
        await client.query<{
          id: string;
          owner_id: string;
          command: ImageCommandV1 | ImageQueryCommandV1 | ImageRecoveryCommandV1;
          query_expired: boolean;
          effective_deadline: string | null;
        }>(
          `SELECT j.id,j.owner_id,COALESCE(o.query_command,o.recovery_command,j.command) AS command,
            floor(extract(epoch FROM LEAST(j.async_deadline,to_timestamp((j.command->>'expiresAt')::double precision/1000)))*1000)::bigint AS effective_deadline,
            o.query_command IS NOT NULL AND (
              j.async_max_queries IS NULL OR j.query_attempt>j.async_max_queries OR
              j.async_deadline IS NULL OR j.async_deadline<=statement_timestamp() OR
              to_timestamp((j.command->>'expiresAt')::double precision/1000)<=statement_timestamp()
            ) AS query_expired
          FROM mio_image_jobs j JOIN mio_image_outbox o ON o.job_id=j.id
          WHERE j.id=$1 AND ${due}`,
          [candidate.id],
        )
      ).rows[0];
      if (!row) return undefined;
      if (row.command.type === 'image.query' && row.command.ownerId !== row.owner_id)
        throw new Error('IMAGE_QUERY_OWNER_MISMATCH');
      if (row.query_expired) {
        await client.query(
          "UPDATE mio_image_jobs SET state='failed',error_code='IMAGE_QUERY_LIMIT',next_query_at=NULL,command=command-'credential' WHERE id=$1",
          [row.id],
        );
        await client.query(
          'UPDATE mio_image_outbox SET query_command=NULL,sent_at=now() WHERE job_id=$1',
          [row.id],
        );
        return undefined;
      }
      if (row.command.type === 'image.query' && !row.command.queryCredential) {
        const queryDeadline = Number(row.effective_deadline);
        if (!Number.isSafeInteger(queryDeadline) || queryDeadline < 1)
          throw new Error('IMAGE_QUERY_DEADLINE_INVALID');
        return { ...row.command, queryDeadline };
      }
      return row.command;
    });
  }
  async imageSent(id: string, messageId: string) {
    await transaction(this.pool, async (client) => {
      await client.query('SELECT id FROM mio_image_jobs WHERE id=$1 FOR UPDATE', [id]);
      const sent = await client.query(
        `UPDATE mio_image_outbox o SET sent_at=now() FROM mio_image_jobs j
        WHERE o.job_id=$1 AND j.id=o.job_id AND COALESCE(o.query_command,o.recovery_command,j.command)->>'messageId'=$2`,
        [id, messageId],
      );
      if (sent.rowCount)
        await client.query('UPDATE mio_image_jobs SET next_query_at=NULL WHERE id=$1', [id]);
    });
  }
  async imagePrepareQuery(
    id: string,
    messageId: string,
    queryDeadline: number,
    credential?: ImageEnvelope,
  ) {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT id FROM mio_image_jobs WHERE id=$1 FOR UPDATE', [id]);
      const row = (
        await client.query<{
          owner_id: string;
          state: string;
          query_command: ImageQueryCommandV1 | null;
          sent_at: Date | null;
          expired: boolean;
          effective_deadline: string | null;
        }>(
          `SELECT j.owner_id,j.state,o.query_command,o.sent_at,
            floor(extract(epoch FROM LEAST(j.async_deadline,to_timestamp((j.command->>'expiresAt')::double precision/1000)))*1000)::bigint AS effective_deadline,
            j.async_max_queries IS NULL OR j.query_attempt>j.async_max_queries OR
            j.async_deadline IS NULL OR j.async_deadline<=statement_timestamp() OR
            to_timestamp((j.command->>'expiresAt')::double precision/1000)<=statement_timestamp() AS expired
          FROM mio_image_jobs j JOIN mio_image_outbox o ON o.job_id=j.id WHERE j.id=$1`,
          [id],
        )
      ).rows[0];
      const query = row?.query_command;
      if (
        !row ||
        !query ||
        row.sent_at ||
        !['submitted', 'processing'].includes(row.state) ||
        query.messageId !== messageId ||
        query.ownerId !== row.owner_id
      )
        return undefined;
      if (row.expired) {
        await client.query(
          "UPDATE mio_image_jobs SET state='failed',error_code='IMAGE_QUERY_LIMIT',next_query_at=NULL,command=command-'credential' WHERE id=$1",
          [id],
        );
        await client.query(
          'UPDATE mio_image_outbox SET query_command=NULL,sent_at=now() WHERE job_id=$1',
          [id],
        );
        return undefined;
      }
      if (query.queryCredential && query.queryDeadline !== Number(row.effective_deadline)) {
        await client.query(
          "UPDATE mio_image_jobs SET state='failed',error_code='IMAGE_CREDENTIAL_UNAVAILABLE',next_query_at=NULL WHERE id=$1",
          [id],
        );
        await client.query(
          'UPDATE mio_image_outbox SET query_command=NULL,sent_at=now() WHERE job_id=$1',
          [id],
        );
        return undefined;
      }
      if (queryDeadline !== Number(row.effective_deadline)) return undefined;
      if (query.queryCredential) return query;
      if (!credential) return undefined;
      const prepared = { ...query, queryDeadline, queryCredential: credential };
      await client.query('UPDATE mio_image_outbox SET query_command=$2 WHERE job_id=$1', [
        id,
        JSON.stringify(prepared),
      ]);
      return prepared;
    });
  }
  async imageQueryUnavailable(
    id: string,
    messageId: string,
    code: 'IMAGE_CREDENTIAL_UNAVAILABLE' | 'IMAGE_QUERY_FAILED',
  ) {
    await transaction(this.pool, async (client) => {
      await client.query('SELECT id FROM mio_image_jobs WHERE id=$1 FOR UPDATE', [id]);
      const pending = await client.query(
        `UPDATE mio_image_outbox SET query_command=NULL,sent_at=now()
         WHERE job_id=$1 AND sent_at IS NULL AND query_command->>'messageId'=$2`,
        [id, messageId],
      );
      if (pending.rowCount)
        await client.query(
          "UPDATE mio_image_jobs SET state='failed',error_code=$2,next_query_at=NULL WHERE id=$1",
          [id, code],
        );
    });
  }
  async imageRecover(owner: string, id: string) {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [672049923]);
      await client.query('SELECT id FROM mio_image_jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
        id,
        owner,
      ]);
      const job = (
        await client.query<{
          state: string;
          command: ImageCommandV1;
          active_recovery_seq: number;
          upstream_task_id: string | null;
          query_attempt: number;
          async_max_queries: number | null;
          async_deadline: Date | null;
          next_query_at: Date | null;
          async_expired: boolean;
        }>(
          `SELECT state,command,active_recovery_seq,upstream_task_id,query_attempt,async_max_queries,async_deadline,next_query_at,
            async_deadline IS NULL OR LEAST(async_deadline,to_timestamp((command->>'expiresAt')::double precision/1000))<=statement_timestamp() AS async_expired
          FROM mio_image_jobs WHERE id=$1 AND owner_id=$2`,
          [id, owner],
        )
      ).rows[0];
      if (!job) throw new ComputeError(404, 'JOB_NOT_FOUND');
      if (job.state === 'materializing') return;
      if (
        job.upstream_task_id &&
        ['submitted', 'processing', 'failed', 'unknown'].includes(job.state)
      ) {
        if (!job.async_max_queries || job.async_expired)
          throw new ComputeError(409, 'RESULT_CONFLICT');
        if (job.state === 'submitted' || job.state === 'processing') {
          const pending = (
            await client.query<{ query_command: ImageQueryCommandV1 | null }>(
              'SELECT query_command FROM mio_image_outbox WHERE job_id=$1',
              [id],
            )
          ).rows[0]?.query_command;
          if (
            !pending ||
            pending.upstreamTaskId !== job.upstream_task_id ||
            pending.queryAttempt !== job.query_attempt
          )
            throw new ComputeError(409, 'RESULT_CONFLICT');
          return;
        }
        const nextAttempt = job.query_attempt + 1;
        if (nextAttempt > job.async_max_queries) throw new ComputeError(409, 'RESULT_CONFLICT');
        const query = imageQueryCommand(job.command, job.upstream_task_id, nextAttempt);
        await client.query(
          "UPDATE mio_image_jobs SET state='processing',error_code=NULL,query_attempt=$2,next_query_at=now() WHERE id=$1",
          [id, nextAttempt],
        );
        await client.query(
          'UPDATE mio_image_outbox SET query_command=$2,recovery_command=NULL,sent_at=NULL WHERE job_id=$1',
          [id, JSON.stringify(query)],
        );
        return;
      }
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
      await client.query('SELECT id FROM mio_image_jobs WHERE id=$1 FOR UPDATE', [result.jobId]);
      const job = (
        await client.query<{
          owner_id: string;
          command: ImageCommandV1;
          state: string;
          active_recovery_id: string | null;
          upstream_task_id: string | null;
          query_attempt: number;
          async_max_queries: number | null;
          async_deadline: Date | null;
          async_expired: boolean;
        }>(
          `SELECT owner_id,command,state,active_recovery_id,upstream_task_id,query_attempt,async_max_queries,async_deadline,next_query_at,
            async_deadline IS NULL OR LEAST(async_deadline,to_timestamp((command->>'expiresAt')::double precision/1000))<=statement_timestamp() AS async_expired
          FROM mio_image_jobs WHERE id=$1`,
          [result.jobId],
        )
      ).rows[0];
      if (!job || job.command.messageId !== result.commandId)
        throw new ComputeError(409, 'RESULT_CONFLICT');
      if (job.active_recovery_id !== (result.recoveryId ?? null)) return;
      if (
        [
          'completed',
          'partial',
          'materialization_failed',
          'unknown',
          'failed',
          'rejected',
        ].includes(job.state)
      )
        return;
      if (
        result.state === 'submitted' &&
        job.state === 'submitted' &&
        result.upstreamTaskId === job.upstream_task_id
      )
        return;
      if (
        result.state === 'processing' &&
        job.state === 'processing' &&
        result.upstreamTaskId === job.upstream_task_id &&
        Number(result.queryAttempt) < job.query_attempt
      )
        return;
      if (['submitted', 'processing', 'failed'].includes(result.state)) {
        if (
          !job.command.input.async ||
          typeof result.upstreamTaskId !== 'string' ||
          (result.upstreamTaskId !== job.upstream_task_id && result.state !== 'submitted')
        )
          throw new ComputeError(409, 'RESULT_CONFLICT');
        if (result.state === 'submitted') {
          if (job.state !== 'accepted' || result.queryAttempt !== 0 || job.upstream_task_id)
            throw new ComputeError(409, 'RESULT_CONFLICT');
          const nextAttempt = 1;
          if (!job.async_max_queries || nextAttempt > job.async_max_queries || job.async_expired) {
            await client.query(
              "UPDATE mio_image_jobs SET state='failed',error_code='IMAGE_QUERY_LIMIT',upstream_task_id=$2,next_query_at=NULL WHERE id=$1",
              [result.jobId, result.upstreamTaskId],
            );
            await client.query(
              'UPDATE mio_image_outbox SET query_command=NULL,sent_at=now() WHERE job_id=$1',
              [result.jobId],
            );
            await client.query(
              "UPDATE mio_image_jobs SET command=command-'credential' WHERE id=$1",
              [result.jobId],
            );
            return;
          }
          const query = imageQueryCommand(job.command, result.upstreamTaskId, nextAttempt);
          await client.query(
            "UPDATE mio_image_jobs SET state='submitted',error_code=NULL,upstream_task_id=$2,query_attempt=$3,next_query_at=now()+interval '250 milliseconds' WHERE id=$1",
            [result.jobId, result.upstreamTaskId, nextAttempt],
          );
          await client.query(
            'UPDATE mio_image_outbox SET query_command=$2,recovery_command=NULL,sent_at=NULL WHERE job_id=$1',
            [result.jobId, JSON.stringify(query)],
          );
          return;
        }
        if (result.state === 'processing') {
          if (
            (job.state !== 'processing' && job.state !== 'submitted') ||
            result.queryAttempt !== job.query_attempt ||
            !job.upstream_task_id
          )
            throw new ComputeError(409, 'RESULT_CONFLICT');
          const nextAttempt = Number(result.queryAttempt) + 1;
          if (!job.async_max_queries || nextAttempt > job.async_max_queries || job.async_expired) {
            await client.query(
              "UPDATE mio_image_jobs SET state='failed',error_code='IMAGE_QUERY_LIMIT',next_query_at=NULL WHERE id=$1",
              [result.jobId],
            );
            await client.query(
              'UPDATE mio_image_outbox SET query_command=NULL,sent_at=now() WHERE job_id=$1',
              [result.jobId],
            );
            await client.query(
              "UPDATE mio_image_jobs SET command=command-'credential' WHERE id=$1",
              [result.jobId],
            );
            return;
          }
          const query = imageQueryCommand(job.command, job.upstream_task_id, nextAttempt);
          await client.query(
            `UPDATE mio_image_jobs SET state='processing',error_code=NULL,query_attempt=$2,
              next_query_at=statement_timestamp()+(LEAST(async_deadline,to_timestamp((command->>'expiresAt')::double precision/1000))-statement_timestamp())/$3::double precision
            WHERE id=$1`,
            [result.jobId, nextAttempt, job.async_max_queries - Number(result.queryAttempt) + 1],
          );
          await client.query(
            'UPDATE mio_image_outbox SET query_command=$2,recovery_command=NULL,sent_at=NULL WHERE job_id=$1',
            [result.jobId, JSON.stringify(query)],
          );
          return;
        }
        if (result.queryAttempt === undefined || !job.upstream_task_id)
          throw new ComputeError(409, 'RESULT_CONFLICT');
        if (result.queryAttempt < job.query_attempt) return;
        if (result.queryAttempt !== job.query_attempt)
          throw new ComputeError(409, 'RESULT_CONFLICT');
        await client.query(
          'UPDATE mio_image_jobs SET state=$2,error_code=$3,next_query_at=NULL WHERE id=$1',
          [result.jobId, 'failed', result.errorCode ?? 'IMAGE_QUERY_FAILED'],
        );
        await client.query(
          'UPDATE mio_image_outbox SET query_command=NULL,sent_at=now() WHERE job_id=$1',
          [result.jobId],
        );
        const retainAsyncCredential =
          job.command.input.async === true &&
          !!job.upstream_task_id &&
          !!job.async_max_queries &&
          job.query_attempt < job.async_max_queries &&
          !job.async_expired;
        if (!retainAsyncCredential)
          await client.query("UPDATE mio_image_jobs SET command=command-'credential' WHERE id=$1", [
            result.jobId,
          ]);
        return;
      }
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

  async imageInput(
    owner: string,
    id: string,
  ): Promise<{ raw_key: string; size_bytes: string; content_type: string } | undefined> {
    return (
      await this.pool.query<{ raw_key: string; size_bytes: string; content_type: string }>(
        "SELECT raw_key,size_bytes,content_type FROM mio_assets WHERE id=$1 AND owner_id=$2 AND state='ready' AND asset_kind='original' AND raw_key IS NOT NULL",
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
