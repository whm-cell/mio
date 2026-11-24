import { MEDIA_VERSION } from '@mio/compute-contracts';
import { createId } from '@mio/foundation/identifiers';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import type { PoolClient } from './database.ts';
import { MEDIA_PROFILE, parseMediaCommand } from '@mio/compute-contracts';
import type { MediaControl, MediaInputSnapshot, MediaRequest } from '@mio/compute-contracts';
import { MediaError, mediaCommand, mediaTerminal } from './media-model.ts';
import type { MediaInputRow, MediaJobRow } from './media-model.ts';

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
export async function insertMedia(
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
export async function nextMediaAttempt(client: PoolClient, job: MediaJobRow): Promise<MediaJobRow> {
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
