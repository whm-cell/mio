import { sha256Bytes } from '@mio/foundation/hash';
import {
  MEDIA_MAX_MANIFEST_BYTES,
  mediaObjectPrefix,
  parseMediaManifest,
} from '@mio/compute-contracts';
import type { MediaObject } from '@mio/compute-contracts';
import { waitForObjectHead } from '../../assets/contracts.ts';
import type { AssetObjectStore } from '../../assets/contracts.ts';
import type { MediaJobRow } from './model.ts';
import { MediaError } from './model.ts';

/** Verify the frozen manifest identity and every exact member key before publication or reclamation. */
export async function readVerifiedMediaManifest(
  objects: AssetObjectStore,
  job: Pick<MediaJobRow, 'id' | 'attempt_id' | 'operation' | 'profile'>,
  object: MediaObject,
  signal: AbortSignal,
) {
  if (
    !objects.readMedia ||
    object.sizeBytes > MEDIA_MAX_MANIFEST_BYTES ||
    object.key !== mediaObjectPrefix(job.id, job.attempt_id) + 'manifest.json'
  )
    throw new MediaError(409, 'MEDIA_MANIFEST_MISMATCH');
  const meta = await waitForObjectHead(() => objects.head(object.key, signal), signal);
  if (meta.size !== object.sizeBytes || meta.etag !== object.etag || meta.sha256 !== object.sha256)
    throw new MediaError(409, 'MEDIA_MANIFEST_MISMATCH');
  const bytes = await objects.readMedia(object.key, object.etag, object.sizeBytes, signal);
  signal.throwIfAborted();
  if (bytes.length !== object.sizeBytes || sha256Bytes(bytes) !== object.sha256)
    throw new MediaError(409, 'MEDIA_MANIFEST_MISMATCH');
  let manifest;
  try {
    manifest = parseMediaManifest(bytes);
  } catch {
    throw new MediaError(409, 'MEDIA_MANIFEST_INVALID');
  }
  if (
    manifest.jobId !== job.id ||
    manifest.attemptId !== job.attempt_id ||
    manifest.operation !== job.operation ||
    manifest.profile !== job.profile
  )
    throw new MediaError(409, 'MEDIA_MANIFEST_MISMATCH');
  return manifest;
}
