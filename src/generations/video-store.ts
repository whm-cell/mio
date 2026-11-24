import type { Pool, PoolClient } from 'pg';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createId } from '@mio/foundation/identifiers';
import { GenerationError } from './errors.ts';
import { transaction } from './transaction.ts';
import { VideoExecutionStore } from './video-execution-store.ts';
import type { VideoJobCommand } from './video-execution.ts';
export type { VideoJobCommand } from './video-execution.ts';
import { VIDEO_GLOBAL_QUOTA, VIDEO_USER_QUOTA } from './video-contracts.ts';
import type { VideoCreateRequest, VideoJobView } from './video-contracts.ts';

const VIDEO_QUOTA_LOCK = 672049926;
const ACTIVE_STATES = "'accepted','submitted','processing','materializing'";

interface VideoJobRow {
  id: string;
  request_id: string;
  command: VideoJobCommand;
  state: VideoJobView['state'];
  error_code: string | null;
  cancellation_requested: boolean;
  cancellation_supported: boolean;
  cancellation_status: VideoJobView['cancellation']['status'];
  phase: VideoJobView['stage'];
  upstream_task_id: string | null;
  query_attempt: number;
  async_max_queries: number | null;
  async_deadline: Date | null;
  checkpoint: { videos?: unknown; cleaned?: boolean } | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  outputs: {
    index: number;
    assetId: string | null;
    status: VideoJobView['outputs'][number]['status'];
    errorCode: string | null;
    sizeBytes: number | null;
    sha256: string | null;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    hasAudio: boolean | null;
  }[];
}

export interface VideoJobCursor {
  createdAt: string;
  id: string;
}

async function capacity(client: PoolClient, ownerId: string): Promise<void> {
  const counts = await client.query<{ all_count: string; owner_count: string }>(
    `SELECT count(*) AS all_count,
       count(*) FILTER (WHERE owner_id=$1) AS owner_count
     FROM mio_video_jobs WHERE state IN (${ACTIVE_STATES})`,
    [ownerId],
  );
  if (
    Number(counts.rows[0]!.all_count) >= VIDEO_GLOBAL_QUOTA ||
    Number(counts.rows[0]!.owner_count) >= VIDEO_USER_QUOTA
  )
    throw new GenerationError(HTTP_STATUS.TOO_MANY_REQUESTS, 'VIDEO_QUOTA_EXCEEDED');
}

export class VideoGenerationStore {
  private readonly pool: Pool;
  private readonly execution: VideoExecutionStore;

  constructor(pool: Pool) {
    this.pool = pool;
    this.execution = new VideoExecutionStore(pool);
  }

  executorStore() {
    return this.execution;
  }

  async byRequest(ownerId: string, requestId: string) {
    const row = (
      await this.pool.query<{ id: string; input_hash: string }>(
        'SELECT id,input_hash FROM mio_video_jobs WHERE owner_id=$1 AND request_id=$2',
        [ownerId, requestId],
      )
    ).rows[0];
    return row ? { jobId: row.id, inputHash: row.input_hash } : undefined;
  }

  async recover(ownerId: string, jobId: string): Promise<void> {
    await transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [VIDEO_QUOTA_LOCK]);
      const result = await client.query<{ state: string; phase: string; checkpoint: unknown }>(
        `SELECT j.state,e.phase,e.checkpoint FROM mio_video_jobs j
         JOIN mio_video_executions e ON e.job_id=j.id
         WHERE j.id=$1 AND j.owner_id=$2 FOR UPDATE OF j,e`, [jobId, ownerId],
      );
      const row = result.rows[0];
      if (!row) throw new GenerationError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
      if (row.state === 'completed' || (row.state === 'materializing' && row.phase === 'materializing')) return;
      const checkpoint = row.checkpoint as { videos?: unknown; cleaned?: boolean } | null;
      if (row.state !== 'materialization_failed' || row.phase !== 'done' ||
          !checkpoint || checkpoint.cleaned || !Array.isArray(checkpoint.videos) ||
          checkpoint.videos.length < 1 || checkpoint.videos.length > 16)
        throw new GenerationError(HTTP_STATUS.CONFLICT, 'RESULT_CONFLICT');
      await capacity(client, ownerId);
      await client.query(`UPDATE mio_video_executions SET phase='materializing',claim_id=NULL,
        next_query_at=NULL,checkpoint=jsonb_set(checkpoint,'{materializationAttempts}','0'::jsonb),updated_at=now()
        WHERE job_id=$1`, [jobId]);
      await client.query(`UPDATE mio_video_jobs SET state='materializing',error_code=NULL,
        completed_at=NULL,updated_at=now() WHERE id=$1`, [jobId]);
    });
  }

  async create(
    ownerId: string,
    request: VideoCreateRequest,
    inputHash: string,
    command: VideoJobCommand,
    admitted: Record<string, unknown>,
    snapshot: Record<string, unknown>,
    routeSnapshot: Record<string, unknown>,
  ): Promise<{ jobId: string; created: boolean }> {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [VIDEO_QUOTA_LOCK]);
      const existing = await client.query<{ id: string; input_hash: string }>(
        'SELECT id,input_hash FROM mio_video_jobs WHERE owner_id=$1 AND request_id=$2',
        [ownerId, request.requestId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].input_hash !== inputHash)
          throw new GenerationError(HTTP_STATUS.CONFLICT, 'REQUEST_CONFLICT');
        return { jobId: existing.rows[0].id, created: false };
      }
      await capacity(client, ownerId);
      const jobId = createId();
      await client.query(
        `INSERT INTO mio_video_jobs
          (id,owner_id,request_id,input_hash,command,admitted,route_snapshot,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,'accepted')`,
        [
          jobId,
          ownerId,
          request.requestId,
          inputHash,
          JSON.stringify(command),
          JSON.stringify(admitted),
          JSON.stringify(routeSnapshot),
        ],
      );
      await client.query(
        "INSERT INTO mio_video_executions(job_id,phase,snapshot) VALUES($1,'ready',$2)",
        [jobId, JSON.stringify(snapshot)],
      );
      return { jobId, created: true };
    });
  }

  async get(ownerId: string, jobId: string): Promise<VideoJobView> {
    const row = (
      await this.pool.query<VideoJobRow>(
        `SELECT j.id,j.request_id,j.command,j.state,j.error_code,
          j.cancellation_requested,j.cancellation_supported,j.cancellation_status,
          e.phase,e.upstream_task_id,e.query_attempt,e.async_max_queries,e.async_deadline,e.checkpoint,
          j.created_at,j.updated_at,j.completed_at,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'index',o.output_index,'assetId',o.asset_id,'status',o.phase,
              'errorCode',o.error_code,'sizeBytes',o.size_bytes,'sha256',o.sha256,
              'width',o.width,'height',o.height,'durationMs',o.duration_ms,'hasAudio',o.has_audio
            ) ORDER BY o.output_index)
            FROM mio_video_outputs o WHERE o.job_id=j.id
          ),'[]'::jsonb) AS outputs
         FROM mio_video_jobs j JOIN mio_video_executions e ON e.job_id=j.id
         WHERE j.owner_id=$1 AND j.id=$2`,
        [ownerId, jobId],
      )
    ).rows[0];
    if (!row) throw new GenerationError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
    const request = row.command.request;
    const recoverable = row.state === 'materialization_failed' && row.phase === 'done' &&
      !row.checkpoint?.cleaned && Array.isArray(row.checkpoint?.videos) &&
      row.checkpoint.videos.length > 0 && row.checkpoint.videos.length <= 16;
    return {
      id: row.id,
      requestId: row.request_id,
      modelRef: request.modelRef,
      mode: request.parameters.mode,
      state: row.state,
      stage: row.phase,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
      effectiveParameters: request.parameters,
      inputSnapshot: row.command.inputSnapshot,
      outputs: row.outputs.map((output) => ({
        index: output.index,
        assetId: output.assetId,
        mediaType: 'video' as const,
        status: output.status,
        errorCode: output.errorCode,
        sizeBytes: output.sizeBytes,
        sha256: output.sha256,
        width: output.width,
        height: output.height,
        durationSeconds: output.durationMs === null ? null : output.durationMs / 1000,
        hasAudio: output.hasAudio,
      })),
      error: row.error_code ? { code: row.error_code } : null,
      cancellation: {
        requested: row.cancellation_requested,
        supported: row.cancellation_supported,
        status: row.cancellation_status,
      },
      recovery: {
        available: recoverable,
        reason: recoverable ? null : 'NO_RECOVERABLE_RESULT',
      },
    };
  }

  async list(ownerId: string, limit: number, cursor?: VideoJobCursor) {
    const cursorClause = cursor ? 'AND (j.created_at,j.id)<($2::timestamptz,$3::uuid)' : '';
    const limitParameter = cursor ? '$4' : '$2';
    const parameters = cursor
      ? [ownerId, cursor.createdAt, cursor.id, limit + 1]
      : [ownerId, limit + 1];
    const rows = (
      await this.pool.query<{
        id: string;
        request_id: string;
        model_ref: string;
        mode: string;
        state: VideoJobView['state'];
        phase: VideoJobView['stage'];
        error_code: string | null;
        created_at: Date;
        updated_at: Date;
        cursor_time: string;
      }>(
        `SELECT j.id,j.request_id,
          j.command#>>'{request,modelRef}' AS model_ref,
          j.command#>>'{request,parameters,mode}' AS mode,
          j.state,e.phase,j.error_code,j.created_at,j.updated_at,
          to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
         FROM mio_video_jobs j JOIN mio_video_executions e ON e.job_id=j.id
         WHERE j.owner_id=$1 ${cursorClause}
         ORDER BY j.created_at DESC,j.id DESC LIMIT ${limitParameter}`,
        parameters,
      )
    ).rows;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        requestId: row.request_id,
        modelRef: row.model_ref,
        mode: row.mode,
        state: row.state,
        stage: row.phase,
        error: row.error_code ? { code: row.error_code } : null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ createdAt: last.cursor_time, id: last.id })).toString(
              'base64url',
            )
          : null,
    };
  }
}
