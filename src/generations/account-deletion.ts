import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createId, isUuidV4 } from '@mio/foundation/identifiers';
import type { AccountDomainStore } from '../account-deletion/domain-store.ts';
import type { AssetGc } from '../assets/gc.ts';
import { GenerationFiles } from './image/files.ts';
import { imageOutputIndex } from './image/contracts.ts';
import type { GenerationRequest } from './image/execution.ts';
import { readVideoRecoveryReceipt } from './video/media.ts';

/** Recovery files remain the authoritative locators until their keys have a durable GC receipt. */
export async function deleteGenerationFiles(
  store: AccountDomainStore,
  gc: AssetGc,
  owner: string,
  directory: string | undefined,
  signal: AbortSignal,
  drain: (kinds: readonly ('image' | 'video')[]) => Promise<void>,
) {
  const images = await store.read<{
    id: string;
    command: GenerationRequest;
    checkpoint: unknown;
    deletion_keys: string[] | null;
  }>(
    `SELECT j.id,j.command,e.checkpoint,e.checkpoint->'accountDeletionKeys' AS deletion_keys
    FROM mio_image_jobs j LEFT JOIN mio_image_executions e ON e.job_id=j.id WHERE j.owner_id=$1 ORDER BY j.id LIMIT 25`,
    [owner],
  );
  const videos = await store.read<{ id: string }>(
    'SELECT id FROM mio_video_jobs WHERE owner_id=$1 ORDER BY id LIMIT 25',
    [owner],
  );
  if ((images.length || videos.length) && !directory)
    throw new Error('LOCAL_GENERATION_VOLUME_NOT_OWNED');
  if (images.length || videos.length)
    await drain([
      ...(images.length ? ['image' as const] : []),
      ...(videos.length ? ['video' as const] : []),
    ]);
  if (directory) {
    const files = new GenerationFiles(directory);
    for (const row of images) {
      signal.throwIfAborted();
      let keys = row.deletion_keys;
      if (keys === null) {
        const saved = await files.load(row.id, row.command.messageId, row.command.input.n ?? 1);
        if (row.checkpoint && !saved) throw new Error('IMAGE_CHECKPOINT_MISSING');
        keys = Object.values(saved?.checkpoint.attemptedKeys ?? {}).flat();
      }
      if (
        !Array.isArray(keys) ||
        keys.some(
          (key) =>
            typeof key !== 'string' ||
            imageOutputIndex(row.id, key, 'image/' + key.split('.').at(-1)) === null,
        )
      )
        throw new Error('IMAGE_CHECKPOINT_INVALID');
      await gc.enqueue(owner, keys);
      if (row.deletion_keys === null)
        await store.transaction(owner, async (client) => {
          // Commit the exact-key handoff before removing its only file receipt.
          await client.query(
            `INSERT INTO mio_image_executions(job_id,phase,checkpoint)
            VALUES($1,'done',jsonb_build_object('accountDeletionKeys',$2::jsonb))
            ON CONFLICT(job_id) DO UPDATE SET checkpoint=
              COALESCE(mio_image_executions.checkpoint,'{}'::jsonb)||EXCLUDED.checkpoint`,
            [row.id, JSON.stringify(keys)],
          );
        });
      await rm(join(directory, row.id), { recursive: true, force: true });
    }
    for (const row of videos) {
      signal.throwIfAborted();
      if (!isUuidV4(row.id)) throw new Error('VIDEO_CHECKPOINT_INVALID');
      for (let index = 0; index < 16; index++) {
        const saved = await readVideoRecoveryReceipt(
          join(directory, 'video', row.id, index + '.json'),
          row.id,
          index,
          signal,
        );
        if (!saved) continue;
        await gc.enqueue(owner, [`mio/raw/${saved.assetId}/${saved.attemptId}`]);
        const key = `mio/staging/video/${row.id}/${index}/${saved.attemptId}.media`;
        await store.transaction(owner, async (client) => {
          // These expired locators are consumed by the existing assets staging cleaner.
          await client.query(
            `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,state,expires_at)
            VALUES($1,$2,'deleted-upload','application/octet-stream',$3,$4,'expired',clock_timestamp())
            ON CONFLICT(staging_key) DO NOTHING`,
            [createId(), owner, saved.sizeBytes, key],
          );
        });
      }
      const submission = join(directory, 'video-submissions', row.id + '.json');
      const receipt = await readFile(submission, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (receipt) {
        const value = JSON.parse(receipt) as { jobId?: string; ownerId?: string };
        if (value.jobId !== row.id || value.ownerId !== owner)
          throw new Error('VIDEO_SUBMISSION_RECEIPT_INVALID');
      }
      await rm(submission, { force: true });
      await rm(join(directory, 'video', row.id), { recursive: true, force: true });
    }
  }
  signal.throwIfAborted();
  return { images: images.map((row) => row.id), videos: videos.map((row) => row.id) };
}

export function deleteGenerationRows(
  store: AccountDomainStore,
  owner: string,
  ids: { images: string[]; videos: string[] },
) {
  return store.batch(owner, 'generations', async (client) => {
    await client.query('DELETE FROM mio_image_outputs WHERE job_id=ANY($1::uuid[])', [ids.images]);
    await client.query('DELETE FROM mio_image_executions WHERE job_id=ANY($1::uuid[])', [
      ids.images,
    ]);
    await client.query('DELETE FROM mio_image_jobs WHERE owner_id=$1 AND id=ANY($2::uuid[])', [
      owner,
      ids.images,
    ]);
    await client.query('DELETE FROM mio_video_outputs WHERE job_id=ANY($1::uuid[])', [ids.videos]);
    await client.query('DELETE FROM mio_video_executions WHERE job_id=ANY($1::uuid[])', [
      ids.videos,
    ]);
    await client.query('DELETE FROM mio_video_jobs WHERE owner_id=$1 AND id=ANY($2::uuid[])', [
      owner,
      ids.videos,
    ]);
    return (
      await client.query<{ remaining: number }>(
        `SELECT ((SELECT count(*) FROM mio_image_jobs WHERE owner_id=$1)+
      (SELECT count(*) FROM mio_video_jobs WHERE owner_id=$1))::integer AS remaining`,
        [owner],
      )
    ).rows[0]!.remaining;
  });
}
