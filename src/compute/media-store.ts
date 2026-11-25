import { createLogger } from '@mio/foundation/logging';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { checkMediaSchema } from './media-schema.ts';
import { createId } from '@mio/foundation/identifiers';
import { Pool } from 'pg';
import { MEDIA_OPERATIONS, mediaResourceClass } from '@mio/compute-contracts';
import type {
  MediaCommand,
  MediaControl,
  MediaInputSnapshot,
  MediaManifest,
  MediaRequest,
  MediaResult,
} from '@mio/compute-contracts';
import { checkComputeCapacity, lockComputeCapacity } from './capacity.ts';
import { computeTransaction } from './database.ts';
import { MediaError, mediaRequestHash } from './media-model.ts';
import type { MediaHlsPackage } from './media-hls.ts';
import type {
  MediaCommandLane,
  MediaInputRow,
  MediaJobViewRow,
  MediaJobRow,
} from './media-model.ts';
import { controlMedia, insertMedia, nextMediaAttempt } from './media-mutations.ts';
import { acceptMedia, currentMedia, recoveryMediaResult } from './media-results.ts';

const log = createLogger('app', 'media-store');
const probeOperations = MEDIA_OPERATIONS.filter(
  (operation) => mediaResourceClass(operation) === 'probe',
);
const viewSQL = (selected: string) => `
  WITH selected AS (${selected}), output_groups AS (
    SELECT f.job_id,jsonb_agg(jsonb_build_object(
      'assetId',f.asset_id,'name',f.name,'role',f.role,
      'contentType',f.content_type,'sizeBytes',f.size_bytes
    ) ORDER BY f.ordinal,f.name) AS outputs
    FROM mio_media_files f JOIN selected j ON j.id=f.job_id AND j.state='succeeded'
    GROUP BY f.job_id
  )
  SELECT j.*,COALESCE(g.outputs,'[]'::jsonb) AS outputs
  FROM selected j LEFT JOIN output_groups g ON g.job_id=j.id
  ORDER BY j.created_at DESC,j.id DESC`;

export class MediaStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }
  async ownerView(id: string, owner: string): Promise<MediaJobViewRow | undefined> {
    return (
      await this.pool.query<MediaJobViewRow>(
        viewSQL('SELECT * FROM mio_media_jobs WHERE id=$1 AND owner_id=$2'),
        [id, owner],
      )
    ).rows[0];
  }
  async hlsPackage(id: string, owner: string): Promise<MediaHlsPackage | undefined> {
    return (
      await this.pool.query<MediaHlsPackage>(
        `SELECT j.attempt_id AS "attemptId",jsonb_agg(jsonb_build_object(
          'asset_id',f.asset_id,'name',f.name,'role',f.role,'content_type',f.content_type,
          'object_key',f.object_key,'size_bytes',f.size_bytes::text,'etag',f.etag,'sha256',f.sha256
        )) AS files
        FROM mio_media_jobs j JOIN mio_media_files f ON f.job_id=j.id
        WHERE j.id=$1 AND j.owner_id=$2 AND j.state='succeeded' AND j.operation='video.derivatives'
          AND f.role IN ('hls','segment')
        GROUP BY j.id`,
        [id, owner],
      )
    ).rows[0];
  }
  async list(owner: string): Promise<MediaJobViewRow[]> {
    return (
      await this.pool.query<MediaJobViewRow>(
        viewSQL(
          'SELECT * FROM mio_media_jobs WHERE owner_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',
        ),
        [owner],
      )
    ).rows;
  }
  async request(owner: string, requestId: string): Promise<MediaJobRow | undefined> {
    return (
      await this.pool.query<MediaJobRow>(
        'SELECT * FROM mio_media_jobs WHERE owner_id=$1 AND request_id=$2',
        [owner, requestId],
      )
    ).rows[0];
  }
  async inputs(owner: string, ids: string[]): Promise<MediaInputRow[]> {
    return (
      await this.pool.query<MediaInputRow>(
        "SELECT id,raw_key,size_bytes,source_etag FROM mio_assets WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND state='ready' AND raw_key IS NOT NULL",
        [ids, owner],
      )
    ).rows;
  }
  async create(owner: string, request: MediaRequest, inputs: MediaInputSnapshot[]) {
    const hash = mediaRequestHash(request);
    return computeTransaction(this.pool, async (client) => {
      await lockComputeCapacity(client);
      const previous = (
        await client.query<MediaJobRow>(
          'SELECT * FROM mio_media_jobs WHERE owner_id=$1 AND request_id=$2',
          [owner, request.requestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== hash)
          throw new MediaError(HTTP_STATUS.CONFLICT, 'REQUEST_CONFLICT');
        return { created: false, job: previous };
      }
      await checkComputeCapacity(client, owner);
      if (
        inputs.length !== request.inputs.length ||
        inputs.some((input, index) => input.assetId !== request.inputs[index]!.assetId)
      )
        throw new MediaError(HTTP_STATUS.BAD_REQUEST, 'MEDIA_INPUT_INVALID');
      return { created: true, job: await insertMedia(client, owner, request, hash, inputs) };
    });
  }
  async control(owner: string, id: string, action: 'cancel' | 'recover') {
    return computeTransaction(this.pool, async (client) => {
      const job = (
        await client.query<MediaJobRow>(
          'SELECT * FROM mio_media_jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [id, owner],
        )
      ).rows[0];
      if (!job) throw new MediaError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
      // A rejected manifest still proves B reached a settled outcome. Once
      // cancelled, it cannot publish user assets and doesn't need a new B result.
      const settledResult =
        action === 'cancel' && job.state === 'reconciling'
          ? Boolean(await recoveryMediaResult(client, job))
          : false;
      return controlMedia(client, job, action, settledResult);
    });
  }
  async retry(owner: string, id: string, requestId: string) {
    return computeTransaction(this.pool, async (client) => {
      // Order admission before the row lock, also serializing an independent retry request ID.
      await lockComputeCapacity(client);
      const job = (
        await client.query<MediaJobRow>(
          'SELECT * FROM mio_media_jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [id, owner],
        )
      ).rows[0];
      if (!job) throw new MediaError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
      const previous = (
        await client.query<{ job_id: string }>(
          'SELECT job_id FROM mio_media_retries WHERE owner_id=$1 AND request_id=$2',
          [owner, requestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.job_id !== id) throw new MediaError(HTTP_STATUS.CONFLICT, 'REQUEST_CONFLICT');
        return job;
      }
      if (job.state !== 'failed' || job.cancel_requested || job.attempt >= 3)
        throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_RETRY_NOT_ALLOWED');
      await checkComputeCapacity(client, owner);
      const next = await nextMediaAttempt(client, job);
      await client.query(
        'INSERT INTO mio_media_retries(owner_id,request_id,job_id,attempt_id) VALUES($1,$2,$3,$4)',
        [owner, requestId, id, next.attempt_id],
      );
      return next;
    });
  }
  async current(result: MediaResult): Promise<MediaJobRow | undefined> {
    const job = (
      await this.pool.query<MediaJobRow>('SELECT * FROM mio_media_jobs WHERE id=$1', [result.jobId])
    ).rows[0];
    return currentMedia(job, result) ? job : undefined;
  }
  recoveryResult(job: MediaJobRow) {
    return recoveryMediaResult(this.pool, job);
  }
  async accept(
    result: MediaResult,
    manifest?: MediaManifest,
    verificationError?: string,
  ): Promise<void> {
    await computeTransaction(this.pool, (client) =>
      acceptMedia(client, result, manifest, verificationError),
    );
  }
  async claim(
    lane: MediaCommandLane,
  ): Promise<{ command: MediaCommand | MediaControl; lease: string } | undefined> {
    const lease = createId();
    const row = (
      await this.pool.query<{ command: MediaCommand | MediaControl }>(
        `UPDATE mio_media_outbox SET lease_id=$1,lease_until=now()+interval '2 minutes'
       WHERE id=(SELECT id FROM mio_media_outbox WHERE sent_at IS NULL AND (lease_until IS NULL OR lease_until<=now())
       AND CASE WHEN command->>'type'='media.control' THEN 'control'
           WHEN command->>'operation'=ANY($3::text[]) THEN 'probe' ELSE 'encode' END=$2
       ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING command`,
        [lease, lane, probeOperations],
      )
    ).rows[0];
    return row ? { command: row.command, lease } : undefined;
  }
  async sent(command: MediaCommand | MediaControl, lease: string): Promise<void> {
    await computeTransaction(this.pool, async (client) => {
      const sent = await client.query(
        'UPDATE mio_media_outbox SET sent_at=now(),lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2 AND sent_at IS NULL RETURNING id',
        [command.messageId, lease],
      );
      if (sent.rowCount && command.type === 'media.request')
        await client.query(
          "UPDATE mio_media_jobs SET state='queued',updated_at=now() WHERE id=$1 AND command_id=$2 AND state='accepted'",
          [command.jobId, command.messageId],
        );
    });
  }
  async release(id: string, lease: string): Promise<void> {
    await this.pool.query(
      'UPDATE mio_media_outbox SET lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2 AND sent_at IS NULL',
      [id, lease],
    );
  }
  close(): Promise<void> {
    return this.pool.end();
  }
}
export async function createMediaStore(databaseURL: string): Promise<MediaStore> {
  const pool = new Pool({
    connectionString: databaseURL,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 5000,
    application_name: 'mio-media',
  });
  pool.on('error', () => log.error('MEDIA_DATABASE_CONNECTION_ERROR'));
  try {
    await checkMediaSchema(pool);
    return new MediaStore(pool);
  } catch {
    await pool.end();
    throw new Error('MEDIA_SCHEMA: run compute:migrate and check database access');
  }
}
