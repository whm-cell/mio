import { sha256Bytes, sha256Utf8 } from '@mio/foundation/hash';
import { isDeepStrictEqual } from 'node:util';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { AUDIO_INSPECTION_LIMITS } from '@mio/compute-contracts';
import { AssetError } from '../../assets/contracts.ts';
import type { AssetObjectStore } from '../../assets/contracts.ts';
import type { AssetStore } from '../../assets/store.ts';
import { AudioError } from '../contracts.ts';
import type { createAudioMediaClient } from '../media.ts';
import type { AudioJobRow, AudioSample } from './store.ts';

const sampleFormats: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
};

async function sampleMetadata(
  assets: Pick<AssetStore, 'owned'>,
  owner: string,
  id: string,
  maxBytes: number,
): Promise<Omit<AudioSample, 'etag'>> {
  const asset = await assets.owned(id, owner).catch((error: unknown) => {
    throw error instanceof AssetError
      ? new AudioError(error.status, error.code)
      : new AudioError(503, 'AUDIO_STORAGE_UNAVAILABLE');
  });
  const sizeBytes = Number(asset.size_bytes);
  const prefix = `mio/raw/${id}/`;
  const contentType = asset.content_type.toLowerCase();
  if (
    asset.state !== 'ready' ||
    !asset.raw_key?.startsWith(prefix) ||
    !isUuidV4(asset.raw_key.slice(prefix.length)) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > Math.min(maxBytes, AUDIO_INSPECTION_LIMITS.sample.maxBytes)
  )
    throw new AudioError(400, 'AUDIO_SAMPLE_INVALID');
  const extension = asset.filename.split('.').at(-1)?.toLowerCase();
  if (!sampleFormats[contentType] || sampleFormats[contentType] !== extension)
    throw new AudioError(400, 'AUDIO_SAMPLE_FORMAT_INVALID');
  return { key: asset.raw_key, sizeBytes, filename: asset.filename, contentType };
}

export async function freezeAudioSample(
  assets: Pick<AssetStore, 'owned'>,
  objects: AssetObjectStore,
  owner: string,
  id: string,
  maxBytes: number,
): Promise<AudioSample> {
  const sample = await sampleMetadata(assets, owner, id, maxBytes);
  const head = await objects.head(sample.key).catch((error: unknown) => {
    const status = (error as { statusCode?: number } | null)?.statusCode;
    throw status === 404 || status === 412
      ? new AudioError(409, 'AUDIO_SAMPLE_CHANGED')
      : new AudioError(503, 'AUDIO_STORAGE_UNAVAILABLE');
  });
  if (
    head.size !== sample.sizeBytes ||
    !head.etag ||
    head.etag.length > 256 ||
    /[\x00-\x1f\x7f]/.test(head.etag)
  )
    throw new AudioError(409, 'AUDIO_SAMPLE_CHANGED');
  return { ...sample, etag: head.etag };
}

/** A conversation can freeze the sample identity without exposing COS metadata. */
export function audioSampleFingerprint(sample: AudioSample): string {
  return sha256Utf8(
    JSON.stringify([
      sample.key,
      sample.sizeBytes,
      sample.etag,
      sample.filename,
      sample.contentType,
    ]),
  );
}

export async function readCloneSample(
  job: AudioJobRow,
  assets: Pick<AssetStore, 'owned'>,
  objects: AssetObjectStore,
  media: Pick<ReturnType<typeof createAudioMediaClient>, 'inspect'>,
  signal: AbortSignal,
) {
  const sample = job.input.sample;
  const id = job.input.sampleAssetId;
  if (!sample || !id || job.input.sampleAuthorization !== true)
    throw new AudioError(400, 'AUDIO_SAMPLE_AUTHORIZATION_REQUIRED');
  if (!objects.readAudio || !objects.ensureAudioPrivate)
    throw new AudioError(503, 'AUDIO_STORAGE_UNAVAILABLE');
  const caps = job.admission.capabilities;
  const info = await media
    .inspect(
      {
        jobId: job.id,
        assetId: id,
        key: sample.key,
        sizeBytes: sample.sizeBytes,
        etag: sample.etag,
        purpose: 'sample',
      },
      signal,
    )
    .catch((error: unknown) => {
      if (error instanceof AudioError && error.code === 'AUDIO_INPUT_CHANGED')
        throw new AudioError(409, 'AUDIO_SAMPLE_CHANGED');
      if (error instanceof AudioError && error.code === 'AUDIO_DURATION_INVALID')
        throw new AudioError(400, 'AUDIO_SAMPLE_DURATION_INVALID');
      if (error instanceof AudioError && error.code === 'AUDIO_INPUT_INVALID')
        throw new AudioError(400, 'AUDIO_SAMPLE_FORMAT_INVALID');
      throw error;
    });
  if (info.format !== sampleFormats[sample.contentType])
    throw new AudioError(400, 'AUDIO_SAMPLE_FORMAT_INVALID');
  if (
    info.durationMs < Math.max(10, caps.sampleMinSeconds) * 1000 ||
    info.durationMs > Math.min(300, caps.sampleMaxSeconds) * 1000
  )
    throw new AudioError(400, 'AUDIO_SAMPLE_DURATION_INVALID');

  // Ownership can change while a slow inspection is in progress. Recheck the
  // same asset before accessing its bytes and require its frozen object identity.
  const current = await sampleMetadata(assets, job.owner_id, id, caps.sampleMaxBytes);
  if (!isDeepStrictEqual({ ...current, etag: sample.etag }, sample))
    throw new AudioError(409, 'AUDIO_SAMPLE_CHANGED');
  const bytes = await objects
    .readAudio(sample.key, sample.etag, sample.sizeBytes, signal)
    .catch((error: unknown) => {
      const status = (error as { statusCode?: number } | null)?.statusCode;
      if (status === 404 || status === 412 || (error instanceof AssetError && error.status === 409))
        throw new AudioError(409, 'AUDIO_SAMPLE_CHANGED');
      throw error;
    });
  if (bytes.byteLength !== sample.sizeBytes || sha256Bytes(bytes) !== info.sha256)
    throw new AudioError(409, 'AUDIO_SAMPLE_CHANGED');
  // Legacy copies can lack SHA-256 metadata. Full inspection and the
  // conditional byte read above prove their contents before narrowing the ACL.
  await objects
    .ensureAudioPrivate(sample.key, { sizeBytes: sample.sizeBytes, etag: sample.etag }, signal)
    .catch((error: unknown) => {
      if ((error as { statusCode?: number } | null)?.statusCode === 412)
        throw new AudioError(409, 'AUDIO_SAMPLE_CHANGED');
      throw new AudioError(503, 'AUDIO_STORAGE_UNAVAILABLE');
    });
  return { bytes, filename: sample.filename, contentType: sample.contentType };
}
