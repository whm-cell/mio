import { createId } from '@mio/foundation/identifiers';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import type { PoolClient } from './database.ts';
import type { MediaManifest, MediaResult } from '@mio/compute-contracts';
import { canonicalMedia, MediaError, mediaTerminal } from './media-model.ts';
import type { MediaJobRow } from './media-model.ts';
import { nextMediaAttempt } from './media-mutations.ts';

const retryable = new Set(['EXECUTION_TIMEOUT', 'STORAGE_FAILURE', 'WORKER_INTERRUPTED']);
export function currentMedia(
  job: MediaJobRow | undefined,
  result: MediaResult,
): job is MediaJobRow {
  return Boolean(
    job &&
    !mediaTerminal(job) &&
    job.command_id === result.commandId &&
    job.attempt_id === result.attemptId &&
    job.attempt === result.attempt,
  );
}
/** Only A-side verification failures designate a result as the attempt's recovery authority. */
export async function recoveryMediaResult(db: Pick<PoolClient, 'query'>, job: MediaJobRow) {
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
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,source_etag,expires_at,staging_deleted_at,asset_kind)
       SELECT id,$1,name,type,size,NULL,key,'ready',etag,now(),now(),'derived'
       FROM unnest($2::uuid[],$3::text[],$4::text[],$5::bigint[],$6::text[],$7::text[]) AS f(id,name,type,size,key,etag)`,
      [job.owner_id, ids, names, types, sizes, keys, etags],
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
