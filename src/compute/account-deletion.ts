import type { AccountDomainStore } from '../account-deletion/domain-store.ts';
import type { AssetGc } from '../assets/gc.ts';
import { parseComputeResultV1, parseMediaResult } from '@mio/compute-contracts';
import type { AssetObjectStore } from '../assets/contracts.ts';
import { readDeletedAttempt, reclaimDeletedMedia } from './deleted-results.ts';

/** A retains only immutable attempt identities for offline B; no B database or local-file protocol. */
export async function deleteComputeAccount(
  store: AccountDomainStore,
  gc: AssetGc,
  owner: string,
  objects: AssetObjectStore,
  signal: AbortSignal,
) {
  const media = await store.read<{ id: string }>(
    'SELECT id FROM mio_media_jobs WHERE owner_id=$1 ORDER BY id LIMIT 1',
    [owner],
  );
  const transcode = await store.read<{ id: string }>(
    'SELECT id FROM mio_compute_jobs WHERE owner_id=$1 ORDER BY id LIMIT 25',
    [owner],
  );
  const mediaIds = media.map((row) => row.id),
    transcodeIds = transcode.map((row) => row.id);
  const files = await store.read<{ object_key: string }>(
    'SELECT object_key FROM mio_media_files WHERE job_id=ANY($1::uuid[])',
    [mediaIds],
  );
  await gc.enqueue(
    owner,
    files.map((file) => file.object_key),
  );
  const manifests = await store.read<{ id: string; payload: Record<string, unknown> }>(
    `SELECT id,payload FROM mio_media_inbox
    WHERE payload->>'jobId'=ANY($1::text[]) AND payload->>'state'='succeeded' ORDER BY id LIMIT 1`,
    [mediaIds],
  );
  for (const inbox of manifests) {
    const { _verificationErrors, ...payload } = inbox.payload;
    void _verificationErrors;
    const result = parseMediaResult(payload);
    const attempt = await store.transaction(owner, (client) =>
      readDeletedAttempt(client, 'media', result),
    );
    if (!attempt) throw new Error('MEDIA_DELETED_ATTEMPT_INVALID');
    await reclaimDeletedMedia(attempt, result, objects, gc, signal);
    signal.throwIfAborted();
    await store.transaction(owner, async (client) => {
      await client.query('DELETE FROM mio_media_inbox WHERE id=$1', [inbox.id]);
    });
    // Persisted inbox is the cursor. A large account yields before the next manifest or metadata batch.
    return { done: false, remaining: 1 };
  }
  const transcodeResults = await store.read<{ id: string; payload: unknown }>(
    `SELECT id,payload FROM mio_compute_inbox
    WHERE payload->>'jobId'=ANY($1::text[]) AND payload->>'state'='succeeded' ORDER BY id LIMIT 1`,
    [transcodeIds],
  );
  for (const inbox of transcodeResults) {
    const result = parseComputeResultV1(inbox.payload);
    const attempt = await store.transaction(owner, (client) =>
      readDeletedAttempt(client, 'transcode', result),
    );
    if (!attempt || result.state !== 'succeeded')
      throw new Error('COMPUTE_DELETED_ATTEMPT_INVALID');
    await gc.enqueue(owner, [result.output.key]);
    signal.throwIfAborted();
    await store.transaction(owner, async (client) => {
      await client.query('DELETE FROM mio_compute_inbox WHERE id=$1', [inbox.id]);
    });
    return { done: false, remaining: 1 };
  }
  return store.batch(owner, 'compute', async (client) => {
    for (const [kind, table, outbox, ids] of [
      ['media', 'mio_media_jobs', 'mio_media_outbox', mediaIds],
      ['transcode', 'mio_compute_jobs', 'mio_compute_outbox', transcodeIds],
    ] as const) {
      await client.query(
        `INSERT INTO mio_deleted_compute_attempts(job_id,attempt_id,command_id,owner_id,kind,operation)
        SELECT id,attempt_id,command_id,owner_id,$2,${kind === 'media' ? 'operation' : 'NULL'} FROM ${table}
        WHERE id=ANY($1::uuid[]) ON CONFLICT DO NOTHING`,
        [ids, kind],
      );
      await client.query(
        `INSERT INTO mio_deleted_compute_attempts(job_id,attempt_id,command_id,owner_id,kind,operation)
        SELECT j.id,(o.command->>'attemptId')::uuid,o.id,j.owner_id,$2,${kind === 'media' ? 'j.operation' : 'NULL'}
        FROM ${outbox} o JOIN ${table} j ON j.id=o.job_id WHERE j.id=ANY($1::uuid[])
        AND o.command->>'attemptId' IS NOT NULL ON CONFLICT DO NOTHING`,
        [ids, kind],
      );
    }
    await client.query('DELETE FROM mio_media_files WHERE job_id=ANY($1::uuid[])', [mediaIds]);
    await client.query('DELETE FROM mio_media_controls WHERE job_id=ANY($1::uuid[])', [mediaIds]);
    await client.query('DELETE FROM mio_media_retries WHERE job_id=ANY($1::uuid[])', [mediaIds]);
    await client.query('DELETE FROM mio_media_outbox WHERE job_id=ANY($1::uuid[])', [mediaIds]);
    await client.query("DELETE FROM mio_media_inbox WHERE payload->>'jobId'=ANY($1::text[])", [
      mediaIds,
    ]);
    await client.query('DELETE FROM mio_media_jobs WHERE owner_id=$1 AND id=ANY($2::uuid[])', [
      owner,
      mediaIds,
    ]);
    await client.query('DELETE FROM mio_compute_outbox WHERE job_id=ANY($1::uuid[])', [
      transcodeIds,
    ]);
    await client.query("DELETE FROM mio_compute_inbox WHERE payload->>'jobId'=ANY($1::text[])", [
      transcodeIds,
    ]);
    await client.query('DELETE FROM mio_compute_jobs WHERE owner_id=$1 AND id=ANY($2::uuid[])', [
      owner,
      transcodeIds,
    ]);
    return (
      await client.query<{ remaining: number }>(
        `SELECT ((SELECT count(*) FROM mio_media_jobs WHERE owner_id=$1)+
      (SELECT count(*) FROM mio_compute_jobs WHERE owner_id=$1))::integer AS remaining`,
        [owner],
      )
    ).rows[0]!.remaining;
  });
}
