import { sha256Utf8 } from '@mio/foundation/hash';
import { isDeepStrictEqual } from 'node:util';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { createLogger } from '@mio/foundation/logging';
import { AudioError, audioText, audioParameters, AUDIO_SAMPLE_BYTES } from '../contracts.ts';
import type { AudioContext, AudioJobView, AudioOperation } from '../contracts.ts';
import type { ProviderService } from '../../providers/service.ts';
import type { AssetObjectStore } from '../../assets/contracts.ts';
import type { AssetStore } from '../../assets/store.ts';
import type { AudioStore, AudioJobViewRow } from './store.ts';
import type { submitAudio, downloadAudio } from '../../integrations/onelink/audio.ts';
import { createAudioExecution } from './execution.ts';
import type { AudioInspector } from './execution.ts';
import { audioSampleFingerprint, freezeAudioSample } from './sample.ts';

const log = createLogger('app', 'audio-jobs');

export type FrozenAudioContext = Omit<AudioContext, 'sample'> & {
  sample?: NonNullable<AudioContext['sample']> & { fingerprint: string };
};
type RequestRow = NonNullable<Awaited<ReturnType<AudioStore['request']>>>;

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new AudioError(400, 'BODY_INVALID');
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !isUuidV4(value)) throw new AudioError(400, 'AUDIO_ID_INVALID');
  return value;
}
function parameterInput(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const input = closed(value, ['speed', 'volume', 'pitch', 'format']);
  if (Object.values(input).some((item) => typeof item !== 'number' && typeof item !== 'string'))
    throw new AudioError(400, 'AUDIO_PARAMETERS_INVALID');
  return input;
}
function sorted(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(input)
      .sort()
      .map((key) => [key, input[key]]),
  );
}
function digest(
  kind: AudioOperation,
  body: Record<string, unknown>,
  params?: Record<string, unknown>,
) {
  // Preserve the ordering used by A's digest for valid persisted requests.
  const input =
    params && body.parameters !== undefined ? { ...body, parameters: sorted(params) } : body;
  return sha256Utf8(JSON.stringify([kind, sorted(input)]));
}
function sameTts(
  row: RequestRow,
  modelRef: string,
  voiceRef: string,
  text: string,
  params: Record<string, unknown>,
): boolean {
  if (
    row.kind !== 'tts' ||
    row.input.modelRef !== modelRef ||
    row.input.voiceRef !== voiceRef ||
    row.input.text !== text
  )
    return false;
  try {
    // Equivalent requests may omit parameters or spell out the original defaults.
    return isDeepStrictEqual(audioParameters(params, row.capabilities), row.input.parameters);
  } catch {
    return false;
  }
}

function view(job: AudioJobViewRow): AudioJobView {
  const ready = job.status === 'ready' && job.record_id && job.inspection;
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    errorCode: job.error_code,
    recordId: job.record_id,
    voiceRef: job.voice_ref ?? job.input.voiceRef ?? null,
    text: job.input.text,
    parameters: job.input.parameters ?? null,
    recoverable:
      job.status === 'materializing' && !!job.error_code && job.has_output && !job.lease_id,
    cancelRequested: job.cancel_requested,
    ...(job.kind === 'clone' ? { upstreamConfirmed: job.upstream_confirmed } : {}),
    assetIds: ready ? [job.output_asset_id] : [],
    outputs: ready
      ? [
          {
            index: 0,
            assetId: job.output_asset_id,
            durationMs: ready.durationMs,
            format: ready.format,
          },
        ]
      : [],
  };
}

/** Tracks HTTP admissions and drains claimed jobs before closing the media client. */
export function createAudioJobService(
  store: AudioStore,
  providers: ProviderService,
  objects: AssetObjectStore,
  media: AudioInspector,
  assets: Pick<AssetStore, 'owned' | 'publishAudio'>,
  dependencies: {
    submit?: typeof submitAudio;
    download?: typeof downloadAudio;
    pollMs?: number;
  } = {},
) {
  const stop = new AbortController();
  const active = new Set<Promise<void>>();
  const admissions = new Set<Promise<unknown>>();
  let polling: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const execute = createAudioExecution(
    store,
    providers,
    objects,
    media,
    assets,
    stop.signal,
    dependencies.submit,
    dependencies.download,
  );
  const assertOpen = () => {
    if (stop.signal.aborted) throw new AudioError(503, 'AUDIO_UNAVAILABLE');
  };
  const track = <T>(action: () => Promise<T>): Promise<T> => {
    assertOpen();
    const task = action().finally(() => admissions.delete(task));
    admissions.add(task);
    return task;
  };
  const poll = () => {
    if (polling || stop.signal.aborted || active.size >= 2) return polling;
    polling = (async () => {
      try {
        while (!stop.signal.aborted && active.size < 2) {
          const job = await store.claim();
          if (!job) break;
          const task = execute(job).finally(() => {
            active.delete(task);
          });
          active.add(task);
        }
      } catch {
        log.error('AUDIO_JOB_CLAIM_FAILED');
      }
    })().finally(() => {
      polling = undefined;
    });
    return polling;
  };
  const timer = setInterval(() => void poll(), dependencies.pollMs ?? 1000);
  timer.unref();
  void poll();

  return {
    listModels(actor: { userId: string }, operation: AudioOperation) {
      return track(() => providers.listAudioModels(actor, operation));
    },
    listVoices(actor: { userId: string }, query: URLSearchParams) {
      return track(() => providers.voices.list(actor.userId, query));
    },
    resolveVoice(actor: { userId: string }, voiceRef: string) {
      return track(async () => {
        const voice = await providers.voices.get(actor.userId, uuid(voiceRef));
        if (!voice.available || !voice.generationAvailable)
          throw new AudioError(409, 'VOICE_UNAVAILABLE');
        return { voiceRef: voice.voiceRef, name: voice.name };
      });
    },
    create(actor: { userId: string }, value: unknown) {
      return track(async () => {
        const body = closed(value, [
          'requestId',
          'modelRef',
          'voiceRef',
          'text',
          'mode',
          'parameters',
        ]);
        const requestId = uuid(body.requestId);
        const voiceRef = uuid(body.voiceRef);
        const modelRef = body.modelRef;
        if (typeof modelRef !== 'string' || body.mode !== 'standard')
          throw new AudioError(400, 'BODY_INVALID');
        const text = audioText(body.text);
        const params = parameterInput(body.parameters);
        const hash = digest('tts', body, params);
        const replay = (row: RequestRow) => {
          if (row.digest !== hash && !sameTts(row, modelRef, voiceRef, text, params))
            throw new AudioError(409, 'REQUEST_CONFLICT');
          return { created: false, job: view(row) };
        };
        const prior = await store.request(actor.userId, requestId);
        if (prior) return replay(prior);

        const admission = await providers.snapshotAudio(actor, modelRef, 'tts');
        audioText(
          text,
          admission.capabilities.textMaxCodePoints,
          admission.capabilities.textMaxBytes,
        );
        const parameters = audioParameters(params, admission.capabilities);
        const voice = await providers.resolveAudioVoice(actor.userId, voiceRef, admission);
        assertOpen();
        const result = await store.create(
          actor.userId,
          requestId,
          hash,
          'tts',
          {
            modelRef: admission.modelRef,
            voiceRef,
            upstreamVoiceId: voice.upstream_id,
            voiceName: voice.name,
            voiceSource: voice.source,
            text,
            mode: 'standard',
            parameters,
          },
          admission,
        );
        if (!result.created) return replay(result.job);
        void poll();
        return { created: true, job: view(result.job) };
      });
    },
    clone(actor: { userId: string }, value: unknown, expectedSampleFingerprint?: string) {
      return track(async () => {
        const body = closed(value, [
          'requestId',
          'modelRef',
          'sampleAssetId',
          'name',
          'auditionText',
          'sampleAuthorization',
        ]);
        const requestId = uuid(body.requestId);
        const sampleAssetId = uuid(body.sampleAssetId);
        const modelRef = body.modelRef;
        if (body.sampleAuthorization !== true)
          throw new AudioError(400, 'AUDIO_SAMPLE_AUTHORIZATION_REQUIRED');
        if (typeof modelRef !== 'string') throw new AudioError(400, 'BODY_INVALID');
        const name = audioText(body.name, 100, 1000);
        const text = audioText(body.auditionText, 1000);
        const hash = digest('clone', body);
        const replay = (row: RequestRow) => {
          if (row.digest !== hash) throw new AudioError(409, 'REQUEST_CONFLICT');
          return { created: false, job: view(row) };
        };
        const prior = await store.request(actor.userId, requestId);
        if (prior) return replay(prior);

        const admission = await providers.snapshotAudio(actor, modelRef, 'clone');
        audioText(
          text,
          Math.min(1000, admission.capabilities.textMaxCodePoints),
          admission.capabilities.textMaxBytes,
        );
        const sample = await freezeAudioSample(
          assets,
          objects,
          actor.userId,
          sampleAssetId,
          admission.capabilities.sampleMaxBytes,
        );
        if (
          expectedSampleFingerprint !== undefined &&
          expectedSampleFingerprint !== audioSampleFingerprint(sample)
        )
          throw new AudioError(409, 'AUDIO_SAMPLE_CHANGED');
        assertOpen();
        const result = await store.create(
          actor.userId,
          requestId,
          hash,
          'clone',
          {
            modelRef: admission.modelRef,
            text,
            name,
            sampleAssetId,
            sampleAuthorization: true,
            sample,
          },
          admission,
        );
        if (!result.created) return replay(result.job);
        void poll();
        return { created: true, job: view(result.job) };
      });
    },
    get(actor: { userId: string }, id: string) {
      return track(async () => view(await store.owned(actor.userId, uuid(id))));
    },
    recover(actor: { userId: string }, id: string) {
      return track(async () => {
        const job = await store.recover(actor.userId, uuid(id));
        void poll();
        return view(job);
      });
    },
    cancel(actor: { userId: string }, id: string) {
      return track(async () => view(await store.cancel(actor.userId, uuid(id))));
    },
    records(actor: { userId: string }, query: URLSearchParams) {
      return track(async () => {
        const before = query.get('before');
        const rawLimit = query.get('limit') ?? '20';
        const limit = Number(rawLimit);
        if (
          [...query.keys()].some((key) => !['before', 'limit'].includes(key)) ||
          new Set(query.keys()).size !== query.size ||
          (before !== null && !isUuidV4(before)) ||
          !/^\d{1,3}$/.test(rawLimit) ||
          limit < 1 ||
          limit > 100
        )
          throw new AudioError(400, 'QUERY_INVALID');
        const rows = await store.records(actor.userId, before, limit);
        return {
          items: rows.slice(0, limit),
          nextCursor: rows.length > limit ? rows[limit - 1]!.recordId : null,
        };
      });
    },
    record(actor: { userId: string }, id: string) {
      return track(() => store.record(actor.userId, uuid(id)));
    },
    freezeContext(actor: { userId: string }, value: unknown): Promise<FrozenAudioContext> {
      return track(async () => {
        const raw = closed(value ?? {}, ['modelRef', 'voiceRef', 'parameters', 'sample']);
        const result: FrozenAudioContext = {};
        let sampleMaxBytes = AUDIO_SAMPLE_BYTES;
        if (raw.modelRef !== undefined) {
          if (typeof raw.modelRef !== 'string') throw new AudioError(400, 'BODY_INVALID');
          const admission = await providers.snapshotAudio(
            actor,
            raw.modelRef,
            raw.sample ? 'clone' : 'tts',
          );
          result.modelRef = admission.modelRef;
          if (raw.parameters !== undefined)
            result.parameters = audioParameters(
              parameterInput(raw.parameters),
              admission.capabilities,
            );
          if (raw.voiceRef !== undefined) {
            const voiceRef = uuid(raw.voiceRef);
            if (!raw.sample) await providers.resolveAudioVoice(actor.userId, voiceRef, admission);
            else await providers.voices.get(actor.userId, voiceRef);
            result.voiceRef = voiceRef;
          }
          sampleMaxBytes = admission.capabilities.sampleMaxBytes;
        } else if (
          raw.voiceRef !== undefined ||
          raw.parameters !== undefined ||
          raw.sample !== undefined
        ) {
          throw new AudioError(400, 'AUDIO_MODEL_REQUIRED');
        }
        if (raw.sample !== undefined) {
          const sample = closed(raw.sample, ['assetId', 'authorized', 'name', 'auditionText']);
          if (sample.authorized !== true)
            throw new AudioError(400, 'AUDIO_SAMPLE_AUTHORIZATION_REQUIRED');
          const assetId = uuid(sample.assetId);
          const frozen = await freezeAudioSample(
            assets,
            objects,
            actor.userId,
            assetId,
            sampleMaxBytes,
          );
          result.sample = {
            assetId,
            authorized: true,
            name: audioText(sample.name, 100, 1000),
            auditionText: audioText(sample.auditionText, 1000),
            fingerprint: audioSampleFingerprint(frozen),
          };
        }
        return result;
      });
    },
    close() {
      if (!closing) {
        clearInterval(timer);
        stop.abort();
        closing = (async () => {
          await Promise.allSettled([...admissions]);
          await polling;
          await Promise.allSettled([...active]);
          await media.close();
        })();
      }
      return closing;
    },
  };
}
export type AudioJobService = ReturnType<typeof createAudioJobService>;
