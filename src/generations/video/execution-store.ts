import type { Pool, PoolClient } from 'pg';
import { createId } from '@mio/foundation/identifiers';
import { GenerationError } from '../errors.ts';
import { transaction } from '../transaction.ts';
import type { VideoJobState } from './contracts.ts';
import type {
  VideoExecution,
  VideoMaterializedOutput,
  VideoQueryRetryCode,
  VideoResultSource,
  VideoSubmissionDisposition,
  VideoSubmissionReceipt,
} from './execution.ts';
import {
  hasVideoQueryBudget,
  VIDEO_EXECUTOR_MAX_AGE_SECONDS,
  VIDEO_EXECUTOR_MAX_QUERIES,
  VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
  VIDEO_QUERY_RETRY_CODES,
  VIDEO_QUOTA_LOCK,
} from './execution.ts';

const EXECUTOR_LOCK = 672049927;
const queryRetryCodes = new Set<string>(VIDEO_QUERY_RETRY_CODES);
const selection = `SELECT j.id,j.owner_id,j.state,j.error_code,j.command,j.admitted,j.route_snapshot,
  e.phase,e.claim_id,e.snapshot,e.upstream_task_id,e.query_attempt,e.async_max_queries,
  e.async_deadline,e.checkpoint FROM mio_video_jobs j
  JOIN mio_video_executions e ON e.job_id=j.id`;

/** One session lock owns restart reconciliation; each operation also checks its claim. */
export class VideoExecutionStore {
  private executor: PoolClient | undefined;
  private executorFailure: (() => void) | undefined;
  private readonly pool: Pool;
  private readonly capacity: (client: PoolClient, ownerId: string) => Promise<void>;

  constructor(pool: Pool, capacity: (client: PoolClient, ownerId: string) => Promise<void>) {
    this.pool = pool;
    this.capacity = capacity;
  }

  async startExecutor(onLost: () => void): Promise<void> {
    const client = await this.pool.connect();
    try {
      const lock = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext(current_schema()),$1) AS acquired',
        [EXECUTOR_LOCK],
      );
      if (!lock.rows[0]?.acquired) throw new Error('VIDEO_EXECUTOR_ALREADY_RUNNING');
      this.executorFailure = onLost;
      client.on('error', onLost);
      this.executor = client;
      // A previous executor may not have seen the lost lease yet. Let its dispatch
      // window end before applying the interval. Legacy rows have no such window.
      await client.query(
        `UPDATE mio_video_executions SET claim_id=NULL,
        phase=CASE WHEN phase='querying' THEN 'waiting' ELSE phase END,
        next_query_at=CASE WHEN phase='querying'
          THEN GREATEST(next_query_at,clock_timestamp())+$1*interval '1 millisecond'
          ELSE next_query_at END,updated_at=now()
        WHERE phase<>'done' AND (claim_id IS NOT NULL OR phase='querying')`,
        [VIDEO_EXECUTOR_QUERY_INTERVAL_MS],
      );
    } catch (error) {
      client.release(true);
      this.executor = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    const executor = this.executor;
    this.executor = undefined;
    if (!executor) return;
    if (this.executorFailure) executor.removeListener('error', this.executorFailure);
    try {
      await executor.query('SELECT pg_advisory_unlock(hashtext(current_schema()),$1)', [
        EXECUTOR_LOCK,
      ]);
    } finally {
      executor.release(true);
    }
  }

  async claim(): Promise<VideoExecution | undefined> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<{ job_id: string }>(
        `UPDATE mio_video_executions SET claim_id=$1,updated_at=now()
         WHERE job_id=(SELECT e.job_id FROM mio_video_executions e
           JOIN mio_video_jobs j ON j.id=e.job_id
           WHERE e.claim_id IS NULL AND e.phase IN ('ready','submitting','waiting','materializing')
           AND (e.next_query_at IS NULL OR e.next_query_at<=statement_timestamp()
             OR (e.phase='waiting' AND (e.async_deadline<=statement_timestamp()
               OR e.query_attempt>=e.async_max_queries)))
           ORDER BY j.created_at LIMIT 1 FOR UPDATE OF e SKIP LOCKED)
         RETURNING job_id`,
        [createId()],
      );
      const id = result.rows[0]?.job_id;
      return id
        ? (await client.query<VideoExecution>(selection + ' WHERE j.id=$1', [id])).rows[0]
        : undefined;
    });
  }

  async completedCleanup(): Promise<VideoExecution[]> {
    return (
      await this.pool.query<VideoExecution>(
        selection +
          `
      WHERE j.state='completed' AND e.phase='done' AND e.checkpoint IS NOT NULL
        AND e.checkpoint->'cleaned' IS DISTINCT FROM 'true'::jsonb
      ORDER BY e.updated_at LIMIT 10`,
      )
    ).rows;
  }
  async cleanupResult(id: string, cleaned: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE mio_video_executions SET
      checkpoint=CASE WHEN $2 THEN checkpoint||'{"cleaned":true}'::jsonb ELSE checkpoint END,
      updated_at=now() WHERE job_id=$1 AND phase='done'`,
      [id, cleaned],
    );
  }

  async release(row: VideoExecution): Promise<void> {
    await this.pool.query(
      `UPDATE mio_video_executions SET claim_id=NULL,
      phase=CASE WHEN phase='querying' THEN 'waiting' ELSE phase END,
      next_query_at=GREATEST(next_query_at,CASE WHEN phase='querying'
        THEN clock_timestamp()+$3*interval '1 millisecond'
        ELSE statement_timestamp()+interval '1 second' END),updated_at=now()
      WHERE job_id=$1 AND claim_id=$2`,
      [row.id, row.claim_id, VIDEO_EXECUTOR_QUERY_INTERVAL_MS],
    );
  }

  async submitting(row: VideoExecution): Promise<boolean> {
    return Boolean(
      (
        await this.pool.query(
          `UPDATE mio_video_executions
      SET phase='submitting',async_max_queries=$3,
      async_deadline=statement_timestamp()+$4*interval '1 second',updated_at=now()
      WHERE job_id=$1 AND claim_id=$2 AND phase='ready'`,
          [row.id, row.claim_id, VIDEO_EXECUTOR_MAX_QUERIES, VIDEO_EXECUTOR_MAX_AGE_SECONDS],
        )
      ).rowCount,
    );
  }

  async receive(
    receipt: VideoSubmissionReceipt,
    canReplay: boolean,
  ): Promise<VideoSubmissionDisposition> {
    return transaction(this.pool, async (client) => {
      // Match the admission lock order before touching either job row.
      await client.query('SELECT pg_advisory_xact_lock($1)', [VIDEO_QUOTA_LOCK]);
      const execution = (
        await client.query<{
          phase: VideoExecution['phase'];
          upstream_task_id: string | null;
          has_intent: boolean;
          can_query: boolean | null;
        }>(
          `SELECT phase,upstream_task_id,
            (checkpoint IS NULL AND async_max_queries IS NOT NULL AND async_deadline IS NOT NULL)
              AS has_intent,
            (query_attempt<async_max_queries AND async_deadline>statement_timestamp()) AS can_query
           FROM mio_video_executions WHERE job_id=$1 FOR UPDATE`,
          [receipt.jobId],
        )
      ).rows[0];
      if (!execution) return 'ineligible';
      const job = (
        await client.query<{ state: VideoJobState; error_code: string | null }>(
          `SELECT state,error_code FROM mio_video_jobs
           WHERE id=$1 AND owner_id=$2 AND request_id=$3 FOR UPDATE`,
          [receipt.jobId, receipt.ownerId, receipt.requestId],
        )
      ).rows[0];
      if (!job) return 'ineligible';
      const submitting = execution.phase === 'submitting' && job.state === 'accepted';
      const submissionUnknown =
        execution.phase === 'done' &&
        job.state === 'unknown' &&
        job.error_code === 'VIDEO_SUBMISSION_UNKNOWN';
      let canQuery = execution.can_query === true;
      if (execution.upstream_task_id !== null) {
        if (execution.upstream_task_id !== receipt.upstreamTaskId) return 'ineligible';
        // A volatile fallback may have logged the ID while the published file was still unsynced.
        if (!(canReplay && submissionUnknown && execution.has_intent && canQuery))
          return 'confirmed';
      }
      if (!execution.has_intent || (!submitting && !submissionUnknown)) return 'ineligible';
      if (canQuery && submissionUnknown) {
        try {
          await this.capacity(client, receipt.ownerId);
        } catch (error) {
          if (!(error instanceof GenerationError) || error.code !== 'VIDEO_QUOTA_EXCEEDED')
            throw error;
          if (canReplay) return 'deferred';
          canQuery = false;
        }
      }
      // Keep an expired ID or a volatile ID without quota for reconciliation only.
      const changed = await client.query<{ phase: 'waiting' | 'done' }>(
        `WITH recovery AS (
           SELECT ($4::boolean AND async_deadline>statement_timestamp()) AS can_query
           FROM mio_video_executions WHERE job_id=$1
         )
         UPDATE mio_video_executions e
         SET phase=CASE WHEN recovery.can_query THEN 'waiting' ELSE 'done' END,
           snapshot=CASE WHEN recovery.can_query THEN e.snapshot ELSE '{}'::jsonb END,
           claim_id=NULL,upstream_task_id=$2,
           next_query_at=CASE WHEN NOT recovery.can_query THEN NULL
             WHEN e.phase='done' THEN statement_timestamp()
             ELSE statement_timestamp()+$3*interval '1 millisecond' END,updated_at=now()
         FROM recovery WHERE e.job_id=$1 RETURNING e.phase`,
        [receipt.jobId, receipt.upstreamTaskId, VIDEO_EXECUTOR_QUERY_INTERVAL_MS, canQuery],
      );
      const waiting = changed.rows[0]!.phase === 'waiting';
      if (waiting || submitting)
        await client.query(
          `UPDATE mio_video_jobs SET state=$2,error_code=$3,
            completed_at=CASE WHEN $2='submitted' THEN NULL ELSE now() END,updated_at=now()
           WHERE id=$1`,
          [
            receipt.jobId,
            waiting ? 'submitted' : 'unknown',
            waiting ? null : 'VIDEO_SUBMISSION_UNKNOWN',
          ],
        );
      return 'confirmed';
    });
  }

  async beginQuery(row: VideoExecution) {
    const { rows } = await this.pool.query<
      Pick<VideoExecution, 'phase' | 'query_attempt' | 'async_max_queries' | 'async_deadline'> & {
        next_query_at: Date;
      }
    >(
      `UPDATE mio_video_executions SET phase='querying',query_attempt=query_attempt+1,
      next_query_at=GREATEST(next_query_at,clock_timestamp()+$3*interval '1 millisecond'),updated_at=now()
      WHERE job_id=$1 AND claim_id=$2 AND phase='waiting' AND upstream_task_id IS NOT NULL
      AND query_attempt<async_max_queries AND async_deadline>clock_timestamp()
      RETURNING phase,query_attempt,async_max_queries,async_deadline,next_query_at`,
      [row.id, row.claim_id, VIDEO_EXECUTOR_QUERY_INTERVAL_MS],
    );
    return rows[0] ? { ...row, ...rows[0] } : undefined;
  }

  async queryLimit(row: VideoExecution): Promise<void> {
    if (row.error_code && queryRetryCodes.has(row.error_code))
      await this.terminal(row, 'unknown', row.error_code);
    else await this.terminal(row, 'failed', 'VIDEO_QUERY_LIMIT');
  }

  async continueQuery(row: VideoExecution, code: VideoQueryRetryCode | null): Promise<void> {
    if (!hasVideoQueryBudget(row)) {
      await this.terminal(row, code ? 'unknown' : 'failed', code ?? 'VIDEO_QUERY_LIMIT');
      return;
    }
    await transaction(this.pool, async (client) => {
      const changed = await client.query(
        `UPDATE mio_video_executions SET phase='waiting',claim_id=NULL,
        next_query_at=GREATEST(next_query_at,clock_timestamp()+$3*interval '1 millisecond'),updated_at=now()
        WHERE job_id=$1 AND claim_id=$2 RETURNING job_id`,
        [row.id, row.claim_id, VIDEO_EXECUTOR_QUERY_INTERVAL_MS],
      );
      if (changed.rowCount)
        await client.query(
          `UPDATE mio_video_jobs
           SET state=$2,error_code=$3,updated_at=now() WHERE id=$1`,
          [row.id, code ? 'submitted' : 'processing', code],
        );
    });
  }

  async returned(row: VideoExecution, videos: VideoResultSource[]): Promise<boolean> {
    if (!videos.length || videos.length > 16) throw new Error('VIDEO_RESULT_INVALID');
    return transaction(this.pool, async (client) => {
      const changed = await client.query(
        `UPDATE mio_video_executions SET phase='materializing',
        checkpoint=$3,next_query_at=NULL,updated_at=now()
        WHERE job_id=$1 AND claim_id=$2 RETURNING job_id`,
        [row.id, row.claim_id, JSON.stringify({ videos, materializationAttempts: 0 })],
      );
      if (changed.rowCount)
        await client.query(
          `UPDATE mio_video_jobs
        SET state='materializing',error_code=NULL,updated_at=now() WHERE id=$1`,
          [row.id],
        );
      return Boolean(changed.rowCount);
    });
  }

  async beginMaterialization(row: VideoExecution): Promise<boolean> {
    return Boolean(
      (
        await this.pool.query(
          `UPDATE mio_video_executions
      SET checkpoint=jsonb_set(checkpoint,'{materializationAttempts}',
        to_jsonb(COALESCE((checkpoint->>'materializationAttempts')::integer,0)+1)),updated_at=now()
      WHERE job_id=$1 AND claim_id=$2 AND phase='materializing'
      AND COALESCE((checkpoint->>'materializationAttempts')::integer,0)<3`,
          [row.id, row.claim_id],
        )
      ).rowCount,
    );
  }

  async terminal(row: VideoExecution, state: VideoJobState, code: string | null): Promise<void> {
    await transaction(this.pool, async (client) => {
      const changed = await client.query(
        `UPDATE mio_video_executions SET phase='done',claim_id=NULL,
        snapshot='{}'::jsonb,next_query_at=NULL,updated_at=now()
        WHERE job_id=$1 AND claim_id=$2 RETURNING job_id`,
        [row.id, row.claim_id],
      );
      if (changed.rowCount)
        await client.query(
          `UPDATE mio_video_jobs SET state=$2,error_code=$3,
        completed_at=now(),updated_at=now() WHERE id=$1`,
          [row.id, state, code],
        );
    });
  }

  async complete(row: VideoExecution, outputs: VideoMaterializedOutput[]): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT job_id FROM mio_video_executions
        WHERE job_id=$1 AND claim_id=$2 AND phase='materializing' FOR UPDATE`,
        [row.id, row.claim_id],
      );
      if (!locked.rowCount) return false;
      if (
        !outputs.length ||
        outputs.length !== row.checkpoint?.videos.length ||
        new Set(outputs.map((output) => output.index)).size !== outputs.length ||
        outputs.some(
          (output) =>
            !Number.isInteger(output.index) || output.index < 0 || output.index >= outputs.length,
        )
      )
        throw new Error('VIDEO_RESULT_INVALID');
      for (const output of outputs) {
        await client.query(
          `INSERT INTO mio_assets
          (id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,
           expires_at,staging_deleted_at,asset_kind,source_etag)
          VALUES($1,$2,$3,$4,$5,NULL,$6,'ready',now(),now(),'derived',$7)`,
          [
            output.assetId,
            row.owner_id,
            'video-' + output.index + '.mp4',
            output.contentType,
            output.sizeBytes,
            output.key,
            output.etag,
          ],
        );
        await client.query(
          `INSERT INTO mio_video_outputs
          (job_id,output_index,asset_id,phase,content_type,size_bytes,sha256,width,height,duration_ms,has_audio)
          VALUES($1,$2,$3,'registered',$4,$5,$6,$7,$8,$9,$10)`,
          [
            row.id,
            output.index,
            output.assetId,
            output.contentType,
            output.sizeBytes,
            output.sha256,
            output.width,
            output.height,
            output.durationMs,
            output.hasAudio,
          ],
        );
      }
      await client.query(
        `UPDATE mio_video_executions SET phase='done',claim_id=NULL,
        snapshot='{}'::jsonb,next_query_at=NULL,updated_at=now() WHERE job_id=$1`,
        [row.id],
      );
      await client.query(
        `UPDATE mio_video_jobs SET state='completed',error_code=NULL,
        completed_at=now(),updated_at=now() WHERE id=$1`,
        [row.id],
      );
      return true;
    });
  }
}
