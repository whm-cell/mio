import type { Pool, PoolClient } from 'pg';
import { createId } from '@mio/foundation/identifiers';
import { GenerationError } from '../errors.ts';
import { transaction } from '../transaction.ts';
import type { VideoJobState } from './contracts.ts';
import type {
  VideoExecution,
  VideoMaterializedOutput,
  VideoQueryRetryCode,
  VideoRecoveryQuery,
  VideoResultSource,
  VideoSubmissionDisposition,
  VideoSubmissionReceipt,
} from './execution.ts';
import {
  hasVideoQueryBudget,
  VIDEO_EXECUTOR_MAX_AGE_SECONDS,
  VIDEO_EXECUTOR_MAX_QUERIES,
  VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
  VIDEO_INVALID_OUTPUT_ERRORS,
  VIDEO_MATERIALIZATION_MAX_ATTEMPTS,
  VIDEO_QUERY_RETRY_CODES,
  VIDEO_QUOTA_LOCK,
} from './execution.ts';

const EXECUTOR_LOCK = 672049927;
const CLAIM_SETTLEMENT_TIMEOUT_MS = 2000;
const CLEANUP_RETRY_INTERVAL_MS = 30_000;
const queryRetryCodes = new Set<string>(VIDEO_QUERY_RETRY_CODES);
const executionSelection = `SELECT j.id,j.owner_id,j.state,j.error_code,j.command,j.admitted,j.route_snapshot,
  e.phase,e.claim_id,e.snapshot,e.upstream_task_id,e.query_attempt,e.async_max_queries,
  e.async_deadline,e.checkpoint FROM mio_video_jobs j`;
const runnable = `e.claim_id IS NULL AND e.phase IN ('ready','submitting','waiting','materializing')
  AND (e.next_query_at IS NULL OR e.next_query_at<=statement_timestamp()
    OR (e.phase='waiting' AND (e.async_deadline<=statement_timestamp()
      OR e.query_attempt>=e.async_max_queries)))`;
const terminalExecutionSet = `phase='done',claim_id=NULL,
          snapshot='{}'::jsonb,next_query_at=NULL,updated_at=now()`;

export type VideoClaim = Pick<VideoExecution, 'id' | 'claim_id'>;

export class VideoClaimUnsettled extends Error {
  readonly claim: VideoClaim;

  constructor(claim: VideoClaim, cause: unknown) {
    super('VIDEO_CLAIM_OUTCOME_UNKNOWN', { cause });
    this.claim = claim;
  }
}

/** One session lock owns restart reconciliation; each operation also checks its claim. */
export class VideoExecutionStore {
  private executor: { client: PoolClient; onError: () => void; lost: boolean } | undefined;
  private readonly pool: Pool;
  private readonly capacity: (client: PoolClient, ownerId: string) => Promise<void>;

  constructor(pool: Pool, capacity: (client: PoolClient, ownerId: string) => Promise<void>) {
    this.pool = pool;
    this.capacity = capacity;
  }

  async startExecutor(onLost: () => void): Promise<void> {
    const client = await this.pool.connect();
    const executor = {
      client,
      lost: false,
      onError: () => {
        if (executor.lost) return;
        executor.lost = true;
        onLost();
      },
    };
    client.on('error', executor.onError);
    try {
      const lock = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext(current_schema()),$1) AS acquired',
        [EXECUTOR_LOCK],
      );
      if (!lock.rows[0]?.acquired) throw new Error('VIDEO_EXECUTOR_ALREADY_RUNNING');
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
      this.executor = executor;
    } catch (error) {
      client.removeListener('error', executor.onError);
      client.release(true);
      throw error;
    }
  }

  async close(): Promise<void> {
    const executor = this.executor;
    this.executor = undefined;
    if (!executor) return;
    try {
      if (!executor.lost) {
        const unlock = {
          text: 'SELECT pg_advisory_unlock(hashtext(current_schema()),$1)',
          values: [EXECUTOR_LOCK],
          query_timeout: CLAIM_SETTLEMENT_TIMEOUT_MS,
        };
        await executor.client.query(unlock);
      }
    } catch (error) {
      if (!executor.lost) throw error;
    } finally {
      executor.client.removeListener('error', executor.onError);
      executor.client.release(true);
    }
  }

  async claim(signal?: AbortSignal): Promise<VideoExecution | undefined> {
    signal?.throwIfAborted();
    const peek = await this.pool.query<{ due: boolean }>(
      `SELECT EXISTS (SELECT FROM mio_video_executions e WHERE ${runnable}) AS due`,
    );
    if (!peek.rows[0]?.due) return;
    signal?.throwIfAborted();
    let claim: VideoClaim | undefined;
    const claimId = createId();
    try {
      return await transaction(
        this.pool,
        async (client) => {
          const result = await client.query<VideoExecution>(
            `WITH claimed AS (
             UPDATE mio_video_executions SET claim_id=$1,updated_at=now()
             WHERE job_id=(SELECT e.job_id FROM mio_video_executions e
               JOIN mio_video_jobs j ON j.id=e.job_id
               WHERE ${runnable}
               ORDER BY j.created_at LIMIT 1 FOR UPDATE OF e SKIP LOCKED)
             RETURNING *
           ) ${executionSelection} JOIN claimed e ON e.job_id=j.id`,
            [claimId],
          );
          const row = result.rows[0];
          if (row) claim = { id: row.id, claim_id: claimId };
          return row;
        },
        signal,
      );
    } catch (error) {
      // PostgreSQL may have committed before the caller lost its COMMIT reply.
      if (claim) throw new VideoClaimUnsettled(claim, error);
      throw error;
    }
  }

  async completedCleanup(): Promise<VideoExecution[]> {
    return (
      await this.pool.query<VideoExecution>(
        `${executionSelection} JOIN mio_video_executions e ON e.job_id=j.id
      WHERE j.state='completed' AND e.phase='done' AND e.checkpoint IS NOT NULL
        AND e.checkpoint->'cleaned' IS DISTINCT FROM 'true'::jsonb
        AND COALESCE((e.checkpoint->>'cleanupRetryAt')::timestamptz,'-infinity')<=statement_timestamp()
      ORDER BY e.updated_at LIMIT 10`,
      )
    ).rows;
  }
  async cleanupResult(id: string, cleaned: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE mio_video_executions SET
      checkpoint=CASE WHEN $2 THEN (checkpoint-'cleanupRetryAt')||'{"cleaned":true}'::jsonb
        ELSE checkpoint||jsonb_build_object('cleanupRetryAt',clock_timestamp()+$3*interval '1 millisecond') END,
      updated_at=now() WHERE job_id=$1 AND phase='done' AND checkpoint IS NOT NULL
        AND checkpoint->'cleaned' IS DISTINCT FROM 'true'::jsonb`,
      [id, cleaned, CLEANUP_RETRY_INTERVAL_MS],
    );
  }

  async release(row: VideoClaim): Promise<void> {
    const release = {
      text: `UPDATE mio_video_executions SET claim_id=NULL,
      phase=CASE WHEN phase='querying' THEN 'waiting' ELSE phase END,
      next_query_at=GREATEST(next_query_at,CASE WHEN phase='querying'
        THEN clock_timestamp()+$3*interval '1 millisecond'
        ELSE statement_timestamp()+interval '1 second' END),updated_at=now()
      WHERE job_id=$1 AND claim_id=$2`,
      values: [row.id, row.claim_id, VIDEO_EXECUTOR_QUERY_INTERVAL_MS],
      query_timeout: CLAIM_SETTLEMENT_TIMEOUT_MS,
    };
    await this.pool.query(release);
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
        checkpoint=$3::jsonb||jsonb_build_object(
          'refreshAt',clock_timestamp()+$4*interval '1 millisecond'),
        next_query_at=NULL,updated_at=now()
        WHERE job_id=$1 AND claim_id=$2 RETURNING job_id`,
        [
          row.id,
          row.claim_id,
          JSON.stringify({ videos, materializationAttempts: 0 }),
          VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
        ],
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

  async beginMaterialization(row: VideoExecution, needsAttempt: boolean) {
    const { rows } = await this.pool.query<{ attempts: number; reserved: boolean }>(
      `WITH current_attempt AS (
        SELECT COALESCE((checkpoint->>'materializationAttempts')::integer,0) AS attempts
        FROM mio_video_executions WHERE job_id=$1 AND claim_id=$2 AND phase='materializing'
        FOR UPDATE
      ), reservation AS (
        SELECT attempts,($3::boolean AND attempts<$4) AS reserved FROM current_attempt
      )
      UPDATE mio_video_executions e SET checkpoint=CASE WHEN reservation.reserved
        THEN jsonb_set(checkpoint,'{materializationAttempts}',to_jsonb(reservation.attempts+1))
        ELSE checkpoint END,updated_at=now()
      FROM reservation WHERE job_id=$1 AND claim_id=$2 AND phase='materializing'
      RETURNING reservation.attempts+reservation.reserved::integer AS attempts, reservation.reserved`,
      [row.id, row.claim_id, needsAttempt, VIDEO_MATERIALIZATION_MAX_ATTEMPTS],
    );
    return rows[0];
  }

  async reserveRecoveryQuery(row: VideoExecution, taskId: string): Promise<Date | undefined> {
    const { rows } = await this.pool.query<{ dispatch_before: Date }>(
      `WITH reservation AS (SELECT clock_timestamp() AS start_at)
      UPDATE mio_video_executions e SET checkpoint=checkpoint||jsonb_build_object(
        'recoveryQuery','{"state":"reserved"}'::jsonb,
        'refreshAt',reservation.start_at+2*$4*interval '1 millisecond'),updated_at=now()
      FROM reservation WHERE job_id=$1 AND claim_id=$2 AND phase='materializing'
        AND upstream_task_id=$3 AND checkpoint#>>'{recoveryQuery,state}'='available'
        AND COALESCE((checkpoint->>'refreshAt')::timestamptz,'-infinity')<=reservation.start_at
      RETURNING reservation.start_at+$4*interval '1 millisecond' AS dispatch_before`,
      [row.id, row.claim_id, taskId, VIDEO_EXECUTOR_QUERY_INTERVAL_MS],
    );
    return rows[0]?.dispatch_before;
  }

  async finishRecoveryQuery(
    row: VideoExecution,
    videos: VideoResultSource[],
    recoveryQuery: VideoRecoveryQuery,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE mio_video_executions SET checkpoint=checkpoint||$4::jsonb,updated_at=now()
      WHERE job_id=$1 AND claim_id=$2 AND phase='materializing'
        AND upstream_task_id=$3 AND checkpoint#>>'{recoveryQuery,state}'='reserved'`,
      [row.id, row.claim_id, row.upstream_task_id, JSON.stringify({ videos, recoveryQuery })],
    );
    return Boolean(result.rowCount);
  }

  async settleInvalidRoute(
    row: VideoClaim,
    state: 'rejected' | 'failed',
    code: string,
  ): Promise<void> {
    // Lock the execution before its job and fail immediately if either row is locked.
    const settlement = {
      text: `WITH claimed AS (
        SELECT job_id FROM mio_video_executions WHERE job_id=$1 AND claim_id=$2
        FOR NO KEY UPDATE NOWAIT
      ), locked_job AS (
        SELECT j.id FROM mio_video_jobs j JOIN claimed c ON c.job_id=j.id
        FOR NO KEY UPDATE OF j NOWAIT
      ), settled AS (
        UPDATE mio_video_executions e SET ${terminalExecutionSet}
        FROM locked_job j WHERE e.job_id=j.id RETURNING e.job_id
      ) UPDATE mio_video_jobs j SET state=$3,error_code=$4,completed_at=now(),updated_at=now()
        FROM settled e WHERE j.id=e.job_id`,
      values: [row.id, row.claim_id, state, code],
      query_timeout: CLAIM_SETTLEMENT_TIMEOUT_MS,
    };
    await this.pool.query(settlement);
  }

  async terminal(
    row: VideoExecution,
    state: VideoJobState,
    code: string | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return transaction(
      this.pool,
      async (client) => {
        const changed = await client.query(
          `UPDATE mio_video_executions SET ${terminalExecutionSet}
          WHERE job_id=$1 AND claim_id=$2 RETURNING job_id`,
          [row.id, row.claim_id],
        );
        if (!changed.rowCount) return false;
        await client.query(
          `UPDATE mio_video_jobs SET state=$2,error_code=$3,
          completed_at=now(),updated_at=now() WHERE id=$1`,
          [row.id, state, code],
        );
        return true;
      },
      signal,
    );
  }

  async outputProgress(id: string) {
    const { rows } = await this.pool.query<{
      output_index: number;
      phase: 'registered' | 'failed';
    }>(
      `SELECT output_index,phase FROM mio_video_outputs
      WHERE job_id=$1 AND phase IN ('registered','failed')`,
      [id],
    );
    return new Map(rows.map((output) => [output.output_index, output.phase]));
  }

  async writeOutput(
    row: VideoExecution,
    index: number,
    result: VideoMaterializedOutput | string,
    signal: AbortSignal,
  ): Promise<'registered' | 'failed' | undefined> {
    if (!row.checkpoint?.videos[index]) throw new Error('VIDEO_RESULT_INVALID');
    const output = typeof result === 'string' ? null : result;
    if (output && output.index !== index) throw new Error('VIDEO_RESULT_INVALID');
    const phase = output ? 'registered' : 'failed';
    const errorCode = typeof result === 'string' ? result : null;
    const skipped =
      errorCode === 'VIDEO_RESULT_URL_EXPIRED'
        ? 'expired'
        : errorCode !== null && VIDEO_INVALID_OUTPUT_ERRORS.has(errorCode)
          ? 'invalidOutputs'
          : undefined;
    return transaction(
      this.pool,
      async (client) => {
        // Take the execution lock before an output FK can acquire a job row lock.
        const locked = await client.query(
          `SELECT job_id FROM mio_video_executions
        WHERE job_id=$1 AND claim_id=$2 AND phase='materializing' FOR UPDATE`,
          [row.id, row.claim_id],
        );
        if (!locked.rowCount) return;
        const registered = await client.query(
          `SELECT job_id FROM mio_video_outputs WHERE job_id=$1 AND output_index=$2
        AND phase='registered'`,
          [row.id, index],
        );
        if (registered.rowCount) return 'registered';
        if (output)
          await client.query(
            `INSERT INTO mio_assets
          (id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,
           expires_at,staging_deleted_at,asset_kind,source_etag)
          VALUES($1,$2,$3,$4,$5,NULL,$6,'ready',now(),now(),'derived',$7)`,
            [
              output.assetId,
              row.owner_id,
              'video-' + index + '.mp4',
              output.contentType,
              output.sizeBytes,
              output.key,
              output.etag,
            ],
          );
        await client.query(
          `INSERT INTO mio_video_outputs
        (job_id,output_index,asset_id,phase,error_code,content_type,size_bytes,sha256,width,height,duration_ms,has_audio)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(job_id,output_index) DO UPDATE SET asset_id=excluded.asset_id,
          phase=excluded.phase,error_code=excluded.error_code,content_type=excluded.content_type,
          size_bytes=excluded.size_bytes,sha256=excluded.sha256,width=excluded.width,
          height=excluded.height,duration_ms=excluded.duration_ms,has_audio=excluded.has_audio`,
          [
            row.id,
            index,
            output?.assetId ?? null,
            phase,
            errorCode,
            output?.contentType ?? null,
            output?.sizeBytes ?? null,
            output?.sha256 ?? null,
            output?.width ?? null,
            output?.height ?? null,
            output?.durationMs ?? null,
            output?.hasAudio ?? null,
          ],
        );
        if (row.checkpoint?.recoveryQuery?.refreshed?.[index] === 'pending')
          await client.query(
            `UPDATE mio_video_executions SET checkpoint=jsonb_set(checkpoint,
            ARRAY['recoveryQuery','refreshed',$2::text],'"finished"'::jsonb),updated_at=now()
          WHERE job_id=$1`,
            [row.id, index],
          );
        else if (skipped)
          await client.query(
            `UPDATE mio_video_executions SET checkpoint=jsonb_set(checkpoint,ARRAY[$3::text],
            COALESCE(checkpoint->$3::text,'{}'::jsonb)||jsonb_build_object($2::text,true)),updated_at=now()
          WHERE job_id=$1`,
            [row.id, index, skipped],
          );
        return phase;
      },
      signal,
    );
  }
}
