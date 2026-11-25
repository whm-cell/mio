import { createHash } from 'node:crypto';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import {
  MEDIA_MAX_MANIFEST_BYTES,
  MEDIA_MAX_FILES,
  mediaObjectPrefix,
  parseMediaManifest,
} from '@mio/compute-contracts';
import type { MediaManifest, MediaObject } from '@mio/compute-contracts';
import type { AssetObjectStore } from '../assets/contracts.ts';
import type { MediaJobRow } from './media-model.ts';
import { MediaError } from './media-model.ts';
import { mediaHead } from './media-objects.ts';

export async function verifyMediaManifest(
  objects: AssetObjectStore,
  job: MediaJobRow,
  object: MediaObject,
  signal: AbortSignal,
): Promise<MediaManifest> {
  if (
    object.sizeBytes > MEDIA_MAX_MANIFEST_BYTES ||
    !object.key.startsWith(mediaObjectPrefix(job.id, job.attempt_id))
  )
    throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_MANIFEST_MISMATCH');
  const meta = await mediaHead(objects, object.key, signal);
  if (meta.size !== object.sizeBytes || meta.etag !== object.etag || meta.sha256 !== object.sha256)
    throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_MANIFEST_MISMATCH');
  const bytes = await objects.readMedia!(object.key, object.etag, object.sizeBytes, signal);
  signal.throwIfAborted();
  if (
    bytes.length !== object.sizeBytes ||
    createHash('sha256').update(bytes).digest('hex') !== object.sha256
  )
    throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_MANIFEST_MISMATCH');
  let manifest: MediaManifest;
  try {
    manifest = parseMediaManifest(bytes);
  } catch {
    throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_MANIFEST_INVALID');
  }
  if (
    manifest.jobId !== job.id ||
    manifest.attemptId !== job.attempt_id ||
    manifest.operation !== job.operation ||
    manifest.profile !== job.profile ||
    manifest.files.length > MEDIA_MAX_FILES
  )
    throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_MANIFEST_MISMATCH');
  // Sequential HEADs keep memory, socket use and shutdown work bounded even at 4096 entries.
  for (const file of manifest.files) {
    signal.throwIfAborted();
    if (file.key === object.key || !file.key.startsWith(mediaObjectPrefix(job.id, job.attempt_id)))
      throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_MANIFEST_MISMATCH');
    const head = await mediaHead(objects, file.key, signal);
    if (head.size !== file.sizeBytes || head.etag !== file.etag || head.sha256 !== file.sha256)
      throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_FILE_MISMATCH');
  }
  return manifest;
}
