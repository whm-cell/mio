import {
  AccountResultClosed,
  closedComputeJob,
  guardDeletedResult,
  readDeletedAttempt,
} from '../deleted-results.ts';
import { createLogger } from '@mio/foundation/logging';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { checkMediaSchema } from './schema.ts';
import { createId } from '@mio/foundation/identifiers';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import {
  MEDIA_OPERATIONS,
  MEDIA_PROFILE,
  MEDIA_VERSION,
  mediaResourceClass,
  parseMediaCommand,
} from '@mio/compute-contracts';
import type {
  MediaCommand,
  MediaControl,
  MediaInputSnapshot,
  MediaManifest,
  MediaRequest,
  MediaResult,
} from '@mio/compute-contracts';
import { checkComputeCapacity, lockComputeCapacity } from '../capacity.ts';
import { computeTransaction } from '../database.ts';
import {
  canonicalMedia,
  MediaError,
  mediaCommand,
  mediaRequestHash,
  mediaTerminal,
} from './model.ts';
import type { MediaHlsPackage } from './hls.ts';
import type { MediaCommandLane, MediaInputRow, MediaJobViewRow, MediaJobRow } from './model.ts';

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
  deletedAttempt(result: { jobId: string; attemptId: string; commandId: string }) {
    return readDeletedAttempt(this.pool, 'media', result);
  }
  commandClosed(jobId: string) {
    return closedComputeJob(this.pool, 'media', jobId);
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
    return computeTransaction(this.pool, (client) =>
      acceptMedia(client, result, manifest, verificationError),
    );
  }
  async claim(
    lane: MediaCommandLane,
  ): Promise<{ command: MediaCommand | MediaControl; lease: string } | undefined> {
    const lease = createId();
    return computeTransaction(this.pool, async (client) => {
      // Take capacity before outbox/owner trigger locks, as ACK and result transactions do.
      await lockComputeCapacity(client);
      const row = (
        await client.query<{ command: MediaCommand | MediaControl }>(
          `UPDATE mio_media_outbox SET lease_id=$1,lease_until=now()+interval '2 minutes'
       WHERE id=(SELECT id FROM mio_media_outbox WHERE sent_at IS NULL AND (lease_until IS NULL OR lease_until<=now()) AND NOT EXISTS(SELECT 1 FROM mio_media_jobs j JOIN mio_closed_accounts c ON c.user_id=j.owner_id WHERE j.id=mio_media_outbox.job_id)
       AND CASE WHEN command->>'type'='media.control' THEN 'control'
           WHEN command->>'operation'=ANY($3::text[]) THEN 'probe' ELSE 'encode' END=$2
       ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING command`,
          [lease, lane, probeOperations],
        )
      ).rows[0];
      return row ? { command: row.command, lease } : undefined;
    });
  }
  async sent(command: MediaCommand | MediaControl, lease: string): Promise<void> {
    await computeTransaction(this.pool, async (client) => {
      if (await guardDeletedResult(client, 'media', command.jobId)) return;
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
    await computeTransaction(this.pool, async (client) => {
      await lockComputeCapacity(client);
      await client.query(
        'UPDATE mio_media_outbox SET lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2 AND sent_at IS NULL',
        [id, lease],
      );
    });
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

async function enqueueMedia(client: PoolClient, job: MediaJobRow): Promise<void> {
  let command;
  try {
    command = parseMediaCommand(mediaCommand(job));
  } catch {
    throw new MediaError(HTTP_STATUS.BAD_REQUEST, 'MEDIA_INPUT_INVALID');
  }
  await client.query('INSERT INTO mio_media_outbox(id,job_id,command) VALUES($1,$2,$3)', [
    job.command_id,
    job.id,
    JSON.stringify(command),
  ]);
}
async function insertMedia(
  client: PoolClient,
  owner: string,
  request: MediaRequest,
  hash: string,
  inputs: MediaInputSnapshot[],
) {
  // Lock assets in stable order without changing the order of the input snapshot.
  const ids = inputs.map((input) => input.assetId).sort();
  const assets = (
    await client.query<MediaInputRow>(
      "SELECT id,raw_key,size_bytes,source_etag FROM mio_assets WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND state='ready' ORDER BY id FOR SHARE",
      [ids, owner],
    )
  ).rows;
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  for (const input of inputs) {
    const asset = byId.get(input.assetId);
    if (!asset || asset.raw_key !== input.key || Number(asset.size_bytes) !== input.sizeBytes)
      throw new MediaError(HTTP_STATUS.NOT_FOUND, 'ASSET_NOT_FOUND');
    // For uploaded originals source_etag belongs to the staging object.
    if (!input.key.startsWith('mio/raw/') && asset.source_etag && asset.source_etag !== input.etag)
      throw new MediaError(HTTP_STATUS.CONFLICT, 'ASSET_SOURCE_CHANGED');
  }
  const job = (
    await client.query<MediaJobRow>(
      `INSERT INTO mio_media_jobs(id,owner_id,request_id,request_hash,operation,parameters,inputs,profile,state,attempt,attempt_id,command_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'accepted',1,$9,$10) RETURNING *`,
      [
        createId(),
        owner,
        request.requestId,
        hash,
        request.operation,
        JSON.stringify(request.parameters),
        JSON.stringify(inputs),
        MEDIA_PROFILE,
        createId(),
        createId(),
      ],
    )
  ).rows[0]!;
  await enqueueMedia(client, job);
  return job;
}
async function nextMediaAttempt(client: PoolClient, job: MediaJobRow): Promise<MediaJobRow> {
  const next = (
    await client.query<MediaJobRow>(
      `UPDATE mio_media_jobs SET attempt=attempt+1,attempt_id=$2,command_id=$3,state='accepted',error_code=NULL,stage=NULL,progress=0,updated_at=now() WHERE id=$1 RETURNING *`,
      [job.id, createId(), createId()],
    )
  ).rows[0]!;
  await enqueueMedia(client, next);
  return next;
}
export async function controlMedia(
  client: PoolClient,
  job: MediaJobRow,
  action: 'cancel' | 'recover',
  settledResult = false,
): Promise<MediaJobRow> {
  if (mediaTerminal(job)) return job;
  if (action === 'recover' && job.state !== 'reconciling' && job.state !== 'cancel_requested')
    throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_RECOVER_NOT_ALLOWED');
  const id = createId();
  const added = await client.query(
    `INSERT INTO mio_media_controls(job_id,attempt_id,action,message_id) VALUES($1,$2,$3,$4)
     ON CONFLICT(job_id,attempt_id,action) DO UPDATE SET message_id=EXCLUDED.message_id
     WHERE EXCLUDED.action='recover' AND NOT EXISTS (
       SELECT 1 FROM mio_media_outbox WHERE id=mio_media_controls.message_id AND sent_at IS NULL
     ) RETURNING message_id`,
    [job.id, job.attempt_id, action, id],
  );
  if (added.rowCount) {
    const message: MediaControl = {
      version: MEDIA_VERSION,
      type: 'media.control',
      messageId: id,
      jobId: job.id,
      attemptId: job.attempt_id,
      action,
    };
    await client.query('INSERT INTO mio_media_outbox(id,job_id,command) VALUES($1,$2,$3)', [
      id,
      job.id,
      JSON.stringify(message),
    ]);
  }
  if (action === 'cancel')
    return (
      await client.query<MediaJobRow>(
        "UPDATE mio_media_jobs SET cancel_requested=true,state=$2,error_code=CASE WHEN $2='cancelled' THEN NULL ELSE error_code END,updated_at=now() WHERE id=$1 RETURNING *",
        [job.id, settledResult ? 'cancelled' : 'cancel_requested'],
      )
    ).rows[0]!;
  return job;
}

const retryable = new Set(['EXECUTION_TIMEOUT', 'STORAGE_FAILURE', 'WORKER_INTERRUPTED']);
function currentMedia(job: MediaJobRow | undefined, result: MediaResult): job is MediaJobRow {
  return Boolean(
    job &&
    !mediaTerminal(job) &&
    job.command_id === result.commandId &&
    job.attempt_id === result.attemptId &&
    job.attempt === result.attempt,
  );
}
/** Only A-side verification failures designate a result as the attempt's recovery authority. */
async function recoveryMediaResult(db: Pick<PoolClient, 'query'>, job: MediaJobRow) {
  return (
    await db.query<{ payload: Extract<MediaResult, { state: 'succeeded' }> }>(
      `SELECT payload-'_verificationErrors' AS payload FROM mio_media_inbox
       WHERE payload->>'jobId'=$1 AND payload->>'attemptId'=$2
       AND payload->>'commandId'=$3 AND payload->>'state'='succeeded'
       AND payload ? '_verificationErrors' ORDER BY created_at,id LIMIT 1`,
      [job.id, job.attempt_id, job.command_id],
    )
  ).rows[0]?.payload;
}
async function registerFiles(
  client: PoolClient,
  job: MediaJobRow,
  manifest: MediaManifest,
): Promise<void> {
  if (manifest.files.length) {
    const ids = manifest.files.map(() => createId());
    const names = manifest.files.map((f) => f.name),
      keys = manifest.files.map((f) => f.key);
    const sizes = manifest.files.map((f) => f.sizeBytes),
      etags = manifest.files.map((f) => f.etag);
    const types = manifest.files.map((f) => f.contentType);
    await client.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,source_etag,expires_at,staging_deleted_at,asset_kind,storage_class)
       SELECT id,$1,name,type,size,NULL,key,'ready',etag,now(),now(),'derived',storage_class
       FROM unnest($2::uuid[],$3::text[],$4::text[],$5::bigint[],$6::text[],$7::text[],$8::text[]) AS f(id,name,type,size,key,etag,storage_class)`,
      [
        job.owner_id,
        ids,
        names,
        types,
        sizes,
        keys,
        etags,
        manifest.files.map((f) =>
          ['preview', 'poster', 'hls', 'segment'].includes(f.role) ? 'internal' : 'content',
        ),
      ],
    );
    await client.query(
      `INSERT INTO mio_media_files(asset_id,job_id,name,role,object_key,size_bytes,etag,sha256,content_type,ordinal)
       SELECT id,$1,name,role,key,size,etag,sha,type,ordinal-1
       FROM unnest($2::uuid[],$3::text[],$4::text[],$5::text[],$6::bigint[],$7::text[],$8::text[],$9::text[])
        WITH ORDINALITY AS f(id,name,role,key,size,etag,sha,type,ordinal)`,
      [
        job.id,
        ids,
        names,
        manifest.files.map((f) => f.role),
        keys,
        sizes,
        etags,
        manifest.files.map((f) => f.sha256),
        types,
      ],
    );
  }
  await client.query(
    "UPDATE mio_media_jobs SET state='succeeded',data=$2,error_code=NULL,progress=1,updated_at=now() WHERE id=$1",
    [job.id, JSON.stringify(manifest.data)],
  );
}
export async function acceptMedia(
  client: PoolClient,
  result: MediaResult,
  manifest?: MediaManifest,
  verificationError?: string,
): Promise<void> {
  if (await guardDeletedResult(client, 'media', result.jobId)) throw new AccountResultClosed();
  const inserted = await client.query(
    'INSERT INTO mio_media_inbox(id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',
    [result.messageId, JSON.stringify(result)],
  );
  if (!inserted.rowCount) {
    const same = await client.query(
      "SELECT id FROM mio_media_inbox WHERE id=$1 AND payload-'_verificationErrors'=$2::jsonb",
      [result.messageId, JSON.stringify(result)],
    );
    if (!same.rowCount) throw new MediaError(HTTP_STATUS.CONFLICT, 'RESULT_CONFLICT');
    // A verified replay can resolve an earlier A-side conflict on the same result ID.
    if (result.state !== 'succeeded') return;
  }
  const job = (
    await client.query<MediaJobRow>('SELECT * FROM mio_media_jobs WHERE id=$1 FOR UPDATE', [
      result.jobId,
    ])
  ).rows[0];
  if (!currentMedia(job, result)) return;
  // Preserve the first successful result as the recovery authority for this attempt.
  // Later worker failures or a different manifest must not turn unknown publication into a retry.
  let verificationId = result.messageId;
  if (job.state === 'reconciling' && !job.cancel_requested && result.state !== 'running') {
    const original = await recoveryMediaResult(client, job);
    if (original) {
      verificationId = original.messageId;
      if (['failed', 'cancelled', 'reconciling'].includes(result.state)) return;
    }
    if (
      original &&
      result.state === 'succeeded' &&
      canonicalMedia(original.manifest) !== canonicalMedia(result.manifest)
    )
      verificationError = 'RESULT_CONFLICT';
  }
  if (job.cancel_requested && ['succeeded', 'failed', 'cancelled'].includes(result.state)) {
    await client.query(
      "UPDATE mio_media_jobs SET state='cancelled',error_code=NULL,updated_at=now() WHERE id=$1",
      [job.id],
    );
  } else if (result.state === 'succeeded') {
    if (verificationError) {
      // Keep the immutable wire result and bounded distinct verification facts in the inbox.
      await client.query(
        `UPDATE mio_media_inbox SET payload=jsonb_set(payload,'{_verificationErrors}',
          COALESCE(payload->'_verificationErrors','[]'::jsonb) || to_jsonb($2::text))
         WHERE id=$1 AND NOT COALESCE(payload->'_verificationErrors','[]'::jsonb) @> to_jsonb(ARRAY[$2::text])`,
        [verificationId, verificationError],
      );
      await client.query(
        "UPDATE mio_media_jobs SET state='reconciling',error_code=$2,updated_at=now() WHERE id=$1",
        [job.id, verificationError],
      );
      return;
    }
    if (
      !manifest ||
      manifest.jobId !== job.id ||
      manifest.attemptId !== job.attempt_id ||
      manifest.operation !== job.operation ||
      manifest.profile !== job.profile
    )
      throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_MANIFEST_MISMATCH');
    await registerFiles(client, job, manifest);
  } else if (result.state === 'failed') {
    if (job.attempt < 3 && retryable.has(result.errorCode)) await nextMediaAttempt(client, job);
    else
      await client.query(
        "UPDATE mio_media_jobs SET state='failed',error_code=$2,updated_at=now() WHERE id=$1",
        [job.id, result.errorCode],
      );
  } else if (result.state === 'cancelled') {
    await client.query(
      "UPDATE mio_media_jobs SET state='cancelled',error_code=NULL,updated_at=now() WHERE id=$1",
      [job.id],
    );
  } else if (result.state === 'reconciling') {
    await client.query(
      "UPDATE mio_media_jobs SET state=CASE WHEN cancel_requested THEN 'cancel_requested' ELSE 'reconciling' END,error_code=$2,updated_at=now() WHERE id=$1",
      [job.id, result.errorCode],
    );
  } else if (job.state !== 'reconciling' && !job.cancel_requested) {
    await client.query(
      "UPDATE mio_media_jobs SET state='running',stage=$2,progress=CASE WHEN stage=$2 THEN GREATEST(progress,$3) ELSE $3 END,updated_at=now() WHERE id=$1",
      [job.id, result.stage, result.progress],
    );
  }
}
