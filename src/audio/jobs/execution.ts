import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@mio/foundation/logging';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { AUDIO_INSPECTION_LIMITS } from '@mio/compute-contracts';
import type { AudioInspection, AudioInspectionInput } from '@mio/compute-contracts';
import type { ProviderService } from '../../providers/service.ts';
import type { AssetObjectStore } from '../../assets/contracts.ts';
import type { AssetStore } from '../../assets/store.ts';
import { downloadAudio, submitAudio } from '../../integrations/onelink/audio.ts';
import { AudioError } from '../contracts.ts';
import { readCloneSample } from './sample.ts';
import type { AudioJobRow, AudioStore } from './store.ts';

const log = createLogger('app', 'audio-jobs');

export interface AudioInspector {
  inspect(input: AudioInspectionInput, signal?: AbortSignal): Promise<AudioInspection>;
  close(): Promise<void>;
}

export type AudioAssets = Pick<
  AssetStore,
  'owned' | 'publishAudio' | 'checkAudioPublicationIdentity'
>;

async function materialize(
  job: AudioJobRow,
  store: AudioStore,
  objects: AssetObjectStore,
  media: AudioInspector,
  assets: AudioAssets,
  download: typeof downloadAudio,
  signal: AbortSignal,
) {
  const limit = AUDIO_INSPECTION_LIMITS.output;
  const keyPrefix = `mio/raw/${job.output_asset_id}/`;
  if (
    !isUuidV4(job.output_asset_id) ||
    !job.output_key.startsWith(keyPrefix) ||
    !isUuidV4(job.output_key.slice(keyPrefix.length))
  )
    throw new AudioError(409, 'AUDIO_OUTPUT_MISMATCH');
  let bytes: Uint8Array | null = job.output_bytes;
  if (!bytes && job.output_url) {
    bytes = await download(job.output_url, signal);
    if (!bytes.length || bytes.length > limit.maxBytes)
      throw new AudioError(400, 'AUDIO_OUTPUT_INVALID');
    await store.bytes(job, bytes);
  }
  if (!bytes?.length)
    throw new AudioError(
      503,
      job.kind === 'clone' ? 'AUDIO_AUDITION_MISSING' : 'AUDIO_OUTPUT_INVALID',
    );
  if (!objects.putAudio) throw new AudioError(503, 'AUDIO_STORAGE_UNAVAILABLE');
  const sizeBytes = bytes.byteLength;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let head = await objects.head(job.output_key).catch((error: unknown) => {
    if ((error as { statusCode?: number } | null)?.statusCode === 404) return;
    throw new AudioError(503, 'AUDIO_STORAGE_UNAVAILABLE');
  });
  const reused = head !== undefined;
  if (!head) {
    const format = job.input.parameters?.format ?? 'mp3';
    await objects.putAudio(job.output_key, bytes, format, sha256, signal);
    head = await objects.head(job.output_key);
  }
  if (!head.etag || head.size !== sizeBytes || head.sha256 !== sha256)
    throw new AudioError(409, 'AUDIO_OUTPUT_MISMATCH');

  signal.throwIfAborted();
  await store.stored(job, head.etag, sha256);
  const inspection = await media.inspect(
    {
      jobId: job.id,
      assetId: job.output_asset_id,
      key: job.output_key,
      sizeBytes,
      etag: head.etag,
      purpose: 'output',
      sha256,
    },
    signal,
  );
  if (
    inspection.sha256 !== sha256 ||
    inspection.sizeBytes !== sizeBytes ||
    inspection.durationMs < limit.minDurationMs ||
    inspection.durationMs > limit.maxDurationMs ||
    (job.kind === 'tts' && inspection.format !== job.input.parameters?.format) ||
    inspection.format === 'm4a'
  )
    throw new AudioError(400, 'AUDIO_OUTPUT_INVALID');

  // The two databases commit separately. After an interrupted publication,
  // registering the already verified file under its fixed ID is safe to repeat.
  signal.throwIfAborted();
  const publication = {
    assetId: job.output_asset_id,
    ownerId: job.owner_id,
    filename: `audio-${job.id}.${inspection.format}`,
    contentType: inspection.mimeType,
    sizeBytes,
    key: job.output_key,
    etag: head.etag,
  };
  try {
    if (reused) {
      // A recovered object from before explicit ACLs may inherit its parent ACL.
      // Confirm ownership and inspected bytes before changing that exact key.
      await assets.checkAudioPublicationIdentity(publication);
      if (!objects.ensureAudioPrivate) throw new AudioError(503, 'AUDIO_STORAGE_UNAVAILABLE');
      await objects.ensureAudioPrivate(
        job.output_key,
        { sizeBytes, etag: head.etag, sha256 },
        signal,
      );
    }
    await assets.publishAudio(publication);
  } catch (error) {
    if ((error as { statusCode?: number } | null)?.statusCode === 412)
      throw new AudioError(409, 'AUDIO_OUTPUT_MISMATCH');
    throw new AudioError(503, 'AUDIO_STORAGE_UNAVAILABLE');
  }
  await store.publish(job, inspection);
}

async function saveCheckpoint(
  store: AudioStore,
  job: AudioJobRow,
  result: Awaited<ReturnType<typeof submitAudio>>,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await store.checkpoint(job, result);
      return;
    } catch (error) {
      if (attempt >= 2 || (error instanceof AudioError && error.code === 'AUDIO_LEASE_LOST'))
        throw error;
      // Retry only the same local checkpoint if its database acknowledgement was lost.
      await delay(50 * (attempt + 1));
    }
  }
}

export function createAudioExecution(
  store: AudioStore,
  providers: ProviderService,
  objects: AssetObjectStore,
  media: AudioInspector,
  assets: AudioAssets,
  stop: AbortSignal,
  submit = submitAudio,
  download = downloadAudio,
) {
  return async (original: AudioJobRow) => {
    let job = original;
    const signal = AbortSignal.any([stop, AbortSignal.timeout(30 * 60 * 1000)]);
    try {
      signal.throwIfAborted();
      if (job.status === 'queued') {
        const sample =
          job.kind === 'clone'
            ? await readCloneSample(job, assets, objects, media, signal)
            : undefined;
        const apiKey = providers.openAudioSnapshot(job.owner_id, job.admission);
        signal.throwIfAborted();
        // This transition wins or loses against a cancellation atomically.
        // A reclaimed submitted row can never authorize another supplier POST.
        await store.beginSubmission(job);
        job = { ...job, status: 'submitted' };
        const result = await submit(
          job.admission,
          apiKey,
          {
            text: job.input.text,
            ...(job.input.parameters ? { parameters: job.input.parameters } : {}),
            ...(job.input.upstreamVoiceId ? { upstreamVoiceId: job.input.upstreamVoiceId } : {}),
            ...(sample ? { sample, voiceId: 'mio_' + job.id.replaceAll('-', '') } : {}),
          },
          AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
        );
        await saveCheckpoint(store, job, result);
        job = {
          ...job,
          status: 'materializing',
          output_bytes: result.bytes
            ? Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength)
            : null,
          output_url: result.url ?? null,
        };
        if (result.voiceId || result.bytes || result.url)
          await providers
            .recordAudioVerification(
              job.owner_id,
              job.admission,
              job.kind === 'clone'
                ? `OneLink confirmed clone (job ${job.id})`
                : `OneLink TTS returned output (job ${job.id})`,
            )
            .catch(() => {
              log.warn('AUDIO_VERIFICATION_WRITE_FAILED', { jobId: job.id });
            });
      }
      await materialize(job, store, objects, media, assets, download, signal);
    } catch (error) {
      const code = error instanceof AudioError ? error.code : 'AUDIO_PROCESSING_UNAVAILABLE';
      const missingOutput = job.status === 'materializing' && !job.output_bytes && !job.output_url;
      const unknown = job.status === 'submitted' && code !== 'AUDIO_UPSTREAM_REJECTED';
      const resume =
        stop.aborted && !unknown && !missingOutput && code !== 'AUDIO_UPSTREAM_REJECTED';
      const status = unknown
        ? 'unknown'
        : job.status === 'materializing' && !missingOutput
          ? 'materializing'
          : resume && job.status === 'queued'
            ? 'queued'
            : 'failed';
      await store
        .defer(job, status, unknown ? 'AUDIO_SUBMIT_UNKNOWN' : resume ? null : code)
        .catch(() => {
          log.error('AUDIO_JOB_STATE_WRITE_FAILED', { jobId: job.id });
        });
    }
  };
}
