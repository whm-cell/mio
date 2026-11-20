import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createId } from '@mio/foundation/identifiers';
import { createLogger } from '@mio/foundation/logging';
import {
  IMAGE_GLOBAL_QUOTA,
  IMAGE_USER_QUOTA,
  canonicalImageRouteConfig,
  imageOutputIndex,
  validateImageRouteConfig,
} from './contracts.ts';
import type { ImageAdmissionSnapshot } from '../providers/contracts.ts';
import type {
  CheckpointRef,
  GeneratedObject,
  GenerationExecution,
  GenerationRequest,
} from './execution.ts';
import { GenerationError } from './errors.ts';
import { checkGenerationSchema } from './schema.ts';

const log = createLogger('app', 'generation-store');
const QUOTA_LOCK = 672049924;
const EXECUTOR_LOCK = 672049925;

export interface ImageRequestRecord {
  id: string;
  input_hash: string;
  requiresAsync: boolean | null;
  supportsEdit: boolean | null;
  allowGenerateReferences: boolean | null;
}

async function findImageRequest(
  db: Pool | PoolClient,
  owner: string,
  requestId: string,
  includeToolDefaults: boolean,
): Promise<ImageRequestRecord | undefined> {
  return (
    await db.query<ImageRequestRecord>(
      `SELECT id,input_hash,
        route->'requiresAsync' AS "requiresAsync",
        (route#>'{paramSpec,supportedOperations}') ? 'edit' AS "supportsEdit",
        route#>'{paramSpec,allowGenerateReferences}' AS "allowGenerateReferences"
       FROM mio_image_jobs
       CROSS JOIN LATERAL (
         SELECT CASE WHEN $3::boolean THEN COALESCE(route_snapshot,command->'route') END AS route
       ) frozen
       WHERE owner_id=$1 AND request_id=$2`,
      [owner, requestId, includeToolDefaults],
    )
  ).rows[0];
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

async function capacity(client: PoolClient, owner: string): Promise<void> {
  const result = await client.query<{ all_count: string; owner_count: string }>(
    "SELECT count(*) AS all_count,count(*) FILTER (WHERE owner_id=$1) AS owner_count FROM mio_image_jobs WHERE state IN ('accepted','materializing')",
    [owner],
  );
  if (
    Number(result.rows[0]!.all_count) >= IMAGE_GLOBAL_QUOTA ||
    Number(result.rows[0]!.owner_count) >= IMAGE_USER_QUOTA
  )
    throw new GenerationError(HTTP_STATUS.TOO_MANY_REQUESTS, 'COMPUTE_QUOTA_EXCEEDED');
}

const selection = `SELECT j.id,j.owner_id,j.state,j.command,j.admitted,j.active_recovery_seq,
  j.upstream_task_id,j.query_attempt,j.async_max_queries,j.async_deadline,
  e.phase,e.claim_id,e.snapshot,e.checkpoint
  FROM mio_image_jobs j JOIN mio_image_executions e ON e.job_id=j.id`;

export class GenerationStore {
  private readonly pool: Pool;
  private executor: PoolClient | undefined;
  private executorFailure: (() => void) | undefined;

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
      if (!lock.rows[0]?.acquired) throw new Error('GENERATION_EXECUTOR_ALREADY_RUNNING');
      this.executorFailure = onLost;
      client.on('error', onLost);
      this.executor = client;
      await this.pool.query(
        "UPDATE mio_image_executions SET claim_id=NULL,phase=CASE WHEN phase='querying' THEN 'waiting' ELSE phase END WHERE phase <> 'done'",
      );
    } catch (error) {
      client.release(true);
      this.executor = undefined;
      throw error;
    }
  }

  async storageBlocked(): Promise<boolean> {
    return Boolean(
      (
        await this.pool.query(
          'SELECT job_id FROM mio_image_executions WHERE storage_failed LIMIT 1',
        )
      ).rowCount,
    );
  }

  async storageFailure(row: GenerationExecution): Promise<void> {
    await this.pool.query(
      'UPDATE mio_image_executions SET storage_failed=true WHERE job_id=$1 AND claim_id=$2',
      [row.id, row.claim_id],
    );
  }

  async completedCleanup(after?: string): Promise<GenerationExecution[]> {
    return (
      await this.pool.query<GenerationExecution>(
        selection +
          ` WHERE j.state='completed' AND e.phase='done' AND e.checkpoint IS NOT NULL
            AND e.checkpoint->'cleaned' IS DISTINCT FROM 'true'::jsonb
            AND ($1::uuid IS NULL OR j.id>$1::uuid) ORDER BY j.id LIMIT 100`,
        [after ?? null],
      )
    ).rows;
  }

  async markFilesCleaned(id: string, ref: CheckpointRef): Promise<void> {
    await this.pool.query(
      `UPDATE mio_image_executions e SET checkpoint=checkpoint||'{"cleaned":true}'::jsonb
       FROM mio_image_jobs j WHERE e.job_id=$1 AND j.id=e.job_id AND j.state='completed'
       AND e.phase='done' AND e.checkpoint=$2::jsonb`,
      [id, JSON.stringify(ref)],
    );
  }

  imageRequest(owner: string, requestId: string, includeToolDefaults = false) {
    return findImageRequest(this.pool, owner, requestId, includeToolDefaults);
  }

  async imageCreate(
    owner: string,
    requestId: string,
    hash: string,
    command: GenerationRequest,
    admitted: Record<string, unknown>,
    snapshot: ImageAdmissionSnapshot,
    matchesTool?: (previous: ImageRequestRecord) => boolean,
  ): Promise<string> {
    if (
      command.ownerId !== owner ||
      !validateImageRouteConfig(command.route) ||
      command.profile !== command.route.driver
    )
      throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [QUOTA_LOCK]);
      const existing = await findImageRequest(client, owner, requestId, Boolean(matchesTool));
      if (existing) {
        if (matchesTool ? !matchesTool(existing) : existing.input_hash !== hash)
          throw new GenerationError(HTTP_STATUS.CONFLICT, 'REQUEST_CONFLICT');
        return existing.id;
      }
      await capacity(client, owner);
      const async = command.input.async
        ? (command.route.paramSpec.async ?? snapshot.capabilityMetadata.image?.async)
        : undefined;
      await client.query(
        `INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,admitted,route_snapshot,async_max_queries,async_deadline,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted')`,
        [
          command.jobId,
          owner,
          requestId,
          hash,
          JSON.stringify(command),
          JSON.stringify(admitted),
          JSON.stringify(canonicalImageRouteConfig(command.route)),
          async?.maxQueries ?? null,
          async ? new Date(command.expiresAt) : null,
        ],
      );
      await client.query(
        "INSERT INTO mio_image_executions(job_id,phase,snapshot) VALUES($1,'ready',$2)",
        [command.jobId, JSON.stringify(snapshot)],
      );
      return command.jobId;
    });
  }

  async imageGet(owner: string, id: string) {
    const row = (
      await this.pool.query<{
        id: string;
        state: string;
        error_code: string | null;
        command: GenerationRequest;
      }>('SELECT id,state,error_code,command FROM mio_image_jobs WHERE owner_id=$1 AND id=$2', [
        owner,
        id,
      ])
    ).rows[0];
    if (!row) throw new GenerationError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
    const outputs = await this.pool.query<{ output_index: number; asset_id: string }>(
      'SELECT output_index,asset_id FROM mio_image_outputs WHERE job_id=$1 ORDER BY output_index',
      [id],
    );
    return {
      jobId: row.id,
      status: row.state,
      requestedCount: row.command.input.n ?? 1,
      errorCode: row.error_code,
      assetIds: outputs.rows.map((output) => output.asset_id),
      outputs: outputs.rows.map((output) => ({
        index: output.output_index,
        assetId: output.asset_id,
      })),
    };
  }

  async imageInput(owner: string, assetId: string) {
    return (
      await this.pool.query<{
        raw_key: string;
        content_type: string;
        size_bytes: string;
        asset_kind: string;
      }>(
        `SELECT raw_key,content_type,size_bytes,asset_kind FROM mio_assets
         WHERE id=$1 AND owner_id=$2 AND state='ready'
         AND content_type IN ('image/png','image/jpeg','image/webp')`,
        [assetId, owner],
      )
    ).rows[0];
  }

  async claim(): Promise<GenerationExecution | undefined> {
    return transaction(this.pool, async (client) => {
      const claimed = await client.query<{ job_id: string }>(
        `UPDATE mio_image_executions SET claim_id=$1,updated_at=now()
         WHERE job_id=(SELECT e.job_id FROM mio_image_executions e
           JOIN mio_image_jobs j ON j.id=e.job_id
           WHERE e.claim_id IS NULL AND e.phase IN ('ready','submitting','waiting','materializing')
           AND (e.phase <> 'waiting' OR j.next_query_at IS NULL OR j.next_query_at<=statement_timestamp())
           ORDER BY j.created_at LIMIT 1 FOR UPDATE OF e SKIP LOCKED)
         RETURNING job_id`,
        [createId()],
      );
      const id = claimed.rows[0]?.job_id;
      return id
        ? (await client.query<GenerationExecution>(selection + ' WHERE j.id=$1', [id])).rows[0]
        : undefined;
    });
  }

  async release(row: GenerationExecution): Promise<void> {
    await this.pool.query(
      "UPDATE mio_image_executions SET claim_id=NULL,phase=CASE WHEN phase='querying' THEN 'waiting' ELSE phase END WHERE job_id=$1 AND claim_id=$2",
      [row.id, row.claim_id],
    );
  }

  async submitting(row: GenerationExecution): Promise<boolean> {
    return Boolean(
      (
        await this.pool.query(
          "UPDATE mio_image_executions SET phase='submitting',updated_at=now() WHERE job_id=$1 AND claim_id=$2 AND phase='ready'",
          [row.id, row.claim_id],
        )
      ).rowCount,
    );
  }

  async terminal(row: GenerationExecution, state: string, code: string | null): Promise<void> {
    await transaction(this.pool, async (client) => {
      const changed = await client.query(
        "UPDATE mio_image_executions SET phase='done',claim_id=NULL,snapshot=NULL,updated_at=now() WHERE job_id=$1 AND claim_id=$2 RETURNING job_id",
        [row.id, row.claim_id],
      );
      if (changed.rowCount)
        await client.query(
          'UPDATE mio_image_jobs SET state=$2,error_code=$3,next_query_at=NULL WHERE id=$1',
          [row.id, state, code],
        );
    });
  }

  async submitted(row: GenerationExecution, taskId: string): Promise<void> {
    await transaction(this.pool, async (client) => {
      const changed = await client.query(
        "UPDATE mio_image_executions SET phase='waiting',claim_id=NULL,snapshot=NULL WHERE job_id=$1 AND claim_id=$2 RETURNING job_id",
        [row.id, row.claim_id],
      );
      if (changed.rowCount)
        await client.query(
          `UPDATE mio_image_jobs SET state='submitted',upstream_task_id=$2,query_attempt=0,
          next_query_at=now()+interval '250 milliseconds',error_code=NULL WHERE id=$1`,
          [row.id, taskId],
        );
    });
  }

  async beginQuery(row: GenerationExecution): Promise<GenerationExecution | undefined> {
    return transaction(this.pool, async (client) => {
      // Transitions touching both rows always lock execution before job.
      const execution = await client.query(
        "SELECT job_id FROM mio_image_executions WHERE job_id=$1 AND claim_id=$2 AND phase='waiting' FOR UPDATE",
        [row.id, row.claim_id],
      );
      if (!execution.rowCount) return undefined;
      const job = await client.query(
        `UPDATE mio_image_jobs j SET query_attempt=query_attempt+1,next_query_at=NULL
         FROM mio_image_executions e WHERE j.id=$1 AND e.job_id=j.id AND e.claim_id=$2
         AND e.phase='waiting' AND j.upstream_task_id IS NOT NULL
         AND j.query_attempt<j.async_max_queries AND j.async_deadline>statement_timestamp()
         AND to_timestamp((j.command->>'expiresAt')::double precision/1000)>statement_timestamp()
         RETURNING j.id`,
        [row.id, row.claim_id],
      );
      if (!job.rowCount) return undefined;
      await client.query("UPDATE mio_image_executions SET phase='querying' WHERE job_id=$1", [
        row.id,
      ]);
      return (await client.query<GenerationExecution>(selection + ' WHERE j.id=$1', [row.id]))
        .rows[0];
    });
  }

  async queryInTime(row: GenerationExecution): Promise<boolean> {
    return Boolean(
      (
        await this.pool.query(
          `SELECT j.id FROM mio_image_jobs j JOIN mio_image_executions e ON e.job_id=j.id
       WHERE j.id=$1 AND e.claim_id=$2 AND e.phase='querying'
       AND j.query_attempt<=j.async_max_queries AND j.async_deadline>statement_timestamp()
       AND to_timestamp((j.command->>'expiresAt')::double precision/1000)>statement_timestamp()`,
          [row.id, row.claim_id],
        )
      ).rowCount,
    );
  }

  async processing(row: GenerationExecution): Promise<void> {
    if (!row.async_max_queries || row.query_attempt >= row.async_max_queries) {
      await this.terminal(row, 'failed', 'IMAGE_QUERY_LIMIT');
      return;
    }
    const remaining = row.async_max_queries - row.query_attempt + 1;
    await transaction(this.pool, async (client) => {
      const changed = await client.query(
        "UPDATE mio_image_executions SET phase='waiting',claim_id=NULL WHERE job_id=$1 AND claim_id=$2 RETURNING job_id",
        [row.id, row.claim_id],
      );
      if (changed.rowCount)
        await client.query(
          `UPDATE mio_image_jobs SET state='processing',error_code=NULL,
         next_query_at=statement_timestamp()+(LEAST(async_deadline,to_timestamp((command->>'expiresAt')::double precision/1000))-statement_timestamp())/$2::double precision
         WHERE id=$1`,
          [row.id, remaining],
        );
    });
  }

  async checkpoint(row: GenerationExecution, ref: CheckpointRef): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const changed = await client.query(
        "UPDATE mio_image_executions SET phase='materializing',snapshot=NULL,checkpoint=$3 WHERE job_id=$1 AND claim_id=$2 RETURNING job_id",
        [row.id, row.claim_id, JSON.stringify(ref)],
      );
      if (changed.rowCount)
        await client.query(
          "UPDATE mio_image_jobs SET state='materializing',error_code=NULL,next_query_at=NULL WHERE id=$1",
          [row.id],
        );
      return Boolean(changed.rowCount);
    });
  }

  async acceptOutputs(
    row: GenerationExecution,
    outputs: GeneratedObject[],
    state: 'materializing' | 'materialization_failed' | 'completed' | 'partial',
    ref: CheckpointRef,
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const owned = await client.query(
        'SELECT job_id FROM mio_image_executions WHERE job_id=$1 AND claim_id=$2 FOR UPDATE',
        [row.id, row.claim_id],
      );
      if (!owned.rowCount) return false;
      const requested = row.command.input.n ?? 1;
      if (
        outputs.length > requested ||
        (state === 'completed' && outputs.length !== requested) ||
        (state === 'partial' && outputs.length >= requested)
      )
        throw new GenerationError(HTTP_STATUS.CONFLICT, 'RESULT_CONFLICT');
      let previousIndex = -1;
      for (const output of outputs) {
        const index = imageOutputIndex(row.id, output.key, output.contentType);
        if (index === null || index >= requested || index <= previousIndex)
          throw new GenerationError(HTTP_STATUS.CONFLICT, 'RESULT_CONFLICT');
        previousIndex = index;
        await this.acceptOutput(client, row, index, output);
      }
      await client.query(
        'UPDATE mio_image_jobs SET state=$2,error_code=NULL,next_query_at=NULL WHERE id=$1',
        [row.id, state],
      );
      await client.query(
        'UPDATE mio_image_executions SET phase=$3,claim_id=NULL,checkpoint=$4,snapshot=NULL WHERE job_id=$1 AND claim_id=$2',
        [
          row.id,
          row.claim_id,
          state === 'materializing' ? 'materializing' : 'done',
          JSON.stringify(ref),
        ],
      );
      return true;
    });
  }

  private async acceptOutput(
    client: PoolClient,
    row: GenerationExecution,
    index: number,
    output: GeneratedObject,
  ) {
    const existing = (
      await client.query<{ raw_key: string; size_bytes: string; content_type: string }>(
        'SELECT a.raw_key,a.size_bytes,a.content_type FROM mio_image_outputs o JOIN mio_assets a ON a.id=o.asset_id WHERE o.job_id=$1 AND o.output_index=$2',
        [row.id, index],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.raw_key !== output.key ||
        Number(existing.size_bytes) !== output.sizeBytes ||
        existing.content_type !== output.contentType
      )
        throw new GenerationError(HTTP_STATUS.CONFLICT, 'RESULT_CONFLICT');
      return;
    }
    const id = createId();
    await client.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at,staging_deleted_at,asset_kind)
       VALUES($1,$2,$3,$4,$5,NULL,$6,'ready',now(),now(),'derived')`,
      [id, row.owner_id, 'image-' + index, output.contentType, output.sizeBytes, output.key],
    );
    await client.query(
      'INSERT INTO mio_image_outputs(job_id,output_index,asset_id) VALUES($1,$2,$3)',
      [row.id, index, id],
    );
  }

  async imageRecover(owner: string, id: string): Promise<void> {
    await transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [QUOTA_LOCK]);
      // Take the execution lock first, then reread both rows after any wait.
      await client.query(
        `SELECT e.job_id FROM mio_image_executions e JOIN mio_image_jobs j ON j.id=e.job_id
         WHERE e.job_id=$1 AND j.owner_id=$2 FOR UPDATE OF e`,
        [id, owner],
      );
      const row = (
        await client.query<GenerationExecution>(
          selection + ' WHERE j.id=$1 AND j.owner_id=$2 FOR UPDATE OF j,e',
          [id, owner],
        )
      ).rows[0];
      if (!row) {
        const historical = await client.query(
          'SELECT id FROM mio_image_jobs WHERE id=$1 AND owner_id=$2',
          [id, owner],
        );
        if (!historical.rowCount) throw new GenerationError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
        throw new GenerationError(HTTP_STATUS.CONFLICT, 'RESULT_CONFLICT');
      }
      if (row.state === 'materializing' || row.state === 'submitted' || row.state === 'processing')
        return;
      if (row.upstream_task_id && ['failed', 'unknown'].includes(row.state)) {
        const allowed = await client.query(
          `UPDATE mio_image_jobs SET state='processing',error_code=NULL,next_query_at=now()
           WHERE id=$1 AND query_attempt<async_max_queries AND async_deadline>statement_timestamp()
           AND to_timestamp((command->>'expiresAt')::double precision/1000)>statement_timestamp() RETURNING id`,
          [id],
        );
        if (!allowed.rowCount) throw new GenerationError(HTTP_STATUS.CONFLICT, 'RESULT_CONFLICT');
        await client.query(
          "UPDATE mio_image_executions SET phase='waiting',claim_id=NULL WHERE job_id=$1",
          [id],
        );
        return;
      }
      if (row.state !== 'materialization_failed' || row.active_recovery_seq >= 2147483647)
        throw new GenerationError(HTTP_STATUS.CONFLICT, 'RESULT_CONFLICT');
      await capacity(client, owner);
      await client.query(
        "UPDATE mio_image_jobs SET state='materializing',error_code=NULL,active_recovery_seq=active_recovery_seq+1,active_recovery_id=$2 WHERE id=$1",
        [id, createId()],
      );
      await client.query(
        "UPDATE mio_image_executions SET phase='materializing',claim_id=NULL WHERE job_id=$1",
        [id],
      );
    });
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    if (this.executor) {
      if (this.executorFailure) this.executor.off('error', this.executorFailure);
      const client = this.executor;
      this.executor = undefined;
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext(current_schema()),$1)', [
          EXECUTOR_LOCK,
        ]);
      } catch (error) {
        errors.push(error);
      }
      try {
        client.release();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.pool.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'GENERATION_CLOSE_FAILED');
  }
}

export async function createGenerationStore(databaseURL: string): Promise<GenerationStore> {
  const pool = new Pool({ connectionString: databaseURL, max: 10, connectionTimeoutMillis: 5000 });
  pool.on('error', () => log.error('GENERATION_DATABASE_CONNECTION_ERROR'));
  try {
    await checkGenerationSchema(pool);
    return new GenerationStore(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
}
