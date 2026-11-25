import type { Pool, PoolClient } from 'pg';
import { createId } from '@mio/foundation/identifiers';
import { epochMs } from '@mio/foundation/time';
import { transaction } from '../transaction.ts';
import type { VideoJobState } from './contracts.ts';
import type { VideoExecution, VideoMaterializedOutput, VideoResultSource } from './execution.ts';
import {
  VIDEO_EXECUTOR_MAX_AGE_SECONDS,
  VIDEO_EXECUTOR_MAX_QUERIES,
  VIDEO_EXECUTOR_QUERY_INTERVAL_MS,
} from './execution.ts';

const EXECUTOR_LOCK = 672049927;
const selection = `SELECT j.id,j.owner_id,j.state,j.command,j.admitted,j.route_snapshot,
  e.phase,e.claim_id,e.snapshot,e.upstream_task_id,e.query_attempt,e.async_max_queries,
  e.async_deadline,e.checkpoint FROM mio_video_jobs j
  JOIN mio_video_executions e ON e.job_id=j.id`;

/** One session lock owns restart reconciliation; each operation also checks its claim. */
export class VideoExecutionStore {
  private executor: PoolClient | undefined;
  private executorFailure: (() => void) | undefined;

  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
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
      await client.query(`UPDATE mio_video_executions SET claim_id=NULL,
        phase=CASE WHEN phase='querying' THEN 'waiting' ELSE phase END,updated_at=now()
        WHERE phase<>'done' AND (claim_id IS NOT NULL OR phase='querying')`);
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
           AND (e.next_query_at IS NULL OR e.next_query_at<=statement_timestamp())
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
      next_query_at=statement_timestamp()+interval '1 second',updated_at=now()
      WHERE job_id=$1 AND claim_id=$2`,
      [row.id, row.claim_id],
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

  async submitted(row: VideoExecution, taskId: string): Promise<void> {
    await transaction(this.pool, async (client) => {
      const changed = await client.query(
        `UPDATE mio_video_executions
        SET phase='waiting',claim_id=NULL,upstream_task_id=$3,
        next_query_at=statement_timestamp()+$4*interval '1 millisecond',updated_at=now()
        WHERE job_id=$1 AND claim_id=$2 AND phase='submitting' RETURNING job_id`,
        [row.id, row.claim_id, taskId, VIDEO_EXECUTOR_QUERY_INTERVAL_MS],
      );
      if (changed.rowCount)
        await client.query(
          `UPDATE mio_video_jobs
        SET state='submitted',error_code=NULL,updated_at=now() WHERE id=$1`,
          [row.id],
        );
    });
  }

  async beginQuery(row: VideoExecution): Promise<VideoExecution | undefined> {
    const changed = await this.pool.query(
      `UPDATE mio_video_executions SET phase='querying',
      query_attempt=query_attempt+1,next_query_at=NULL,updated_at=now()
      WHERE job_id=$1 AND claim_id=$2 AND phase='waiting' AND upstream_task_id IS NOT NULL
      AND query_attempt<async_max_queries AND async_deadline>statement_timestamp()
      RETURNING job_id`,
      [row.id, row.claim_id],
    );
    if (!changed.rowCount) return undefined;
    return (await this.pool.query<VideoExecution>(selection + ' WHERE j.id=$1', [row.id])).rows[0];
  }

  async processing(row: VideoExecution): Promise<void> {
    if (
      !row.async_max_queries ||
      row.query_attempt >= row.async_max_queries ||
      !row.async_deadline ||
      row.async_deadline.getTime() <= epochMs()
    ) {
      await this.terminal(row, 'failed', 'VIDEO_QUERY_LIMIT');
      return;
    }
    await transaction(this.pool, async (client) => {
      const changed = await client.query(
        `UPDATE mio_video_executions SET phase='waiting',
        claim_id=NULL,next_query_at=statement_timestamp()+$3*interval '1 millisecond',updated_at=now()
        WHERE job_id=$1 AND claim_id=$2 RETURNING job_id`,
        [row.id, row.claim_id, VIDEO_EXECUTOR_QUERY_INTERVAL_MS],
      );
      if (changed.rowCount)
        await client.query(
          `UPDATE mio_video_jobs
        SET state='processing',error_code=NULL,updated_at=now() WHERE id=$1`,
          [row.id],
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
