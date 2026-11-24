/** Shared message v1. The transport authenticates publishers separately from these values. */
export const COMPUTE_VERSION = 1 as const;
export const COMPUTE_PROFILE = 'mp4-h264-aac-720p24-v1' as const;
export const COMPUTE_MAX_MESSAGE_BYTES = 8192;
export const COMPUTE_MAX_MEDIA_BYTES = 1024 ** 3;
export const COMMAND_EXCHANGE = 'mio.compute.commands.v1';
export const COMMAND_QUEUE = 'mio.compute.commands.v1';
export const COMMAND_ROUTING_KEY = 'transcode.v1';
export const RESULT_EXCHANGE = 'mio.compute.results.v1';
export const RESULT_QUEUE = 'mio.compute.results.v1';
export const RESULT_ROUTING_KEY = 'transcode.result.v1';
export const VIDEO_PROBE_COMMAND_ROUTING_KEY = 'video.probe.v1';
export const VIDEO_PROBE_RESULT_ROUTING_KEY = 'video.probe.result.v1';

export type ComputeAttempt = 1 | 2 | 3;
export type ComputeProfileV1 = typeof COMPUTE_PROFILE;
export type ComputeFailureCodeV1 =
  | 'INPUT_INVALID'
  | 'INPUT_TOO_LARGE'
  | 'INPUT_TOO_LONG'
  | 'INPUT_CHANGED'
  | 'TRANSCODE_FAILED'
  | 'EXECUTION_TIMEOUT'
  | 'STORAGE_FAILURE'
  | 'WORKER_INTERRUPTED'
  | 'OUTPUT_INVALID';
export type ComputeUnknownCodeV1 = 'PROCESS_UNKNOWN' | 'UPLOAD_UNKNOWN' | 'OUTPUT_MISMATCH';

export interface ComputeCommandV1 {
  version: 1;
  type: 'transcode.request';
  messageId: string;
  jobId: string;
  attemptId: string;
  attempt: ComputeAttempt;
  profile: ComputeProfileV1;
  input: { assetId: string; key: string; sizeBytes: number; etag: string };
}

export interface ComputeOutputV1 {
  key: string;
  sizeBytes: number;
  etag: string;
  sha256: string;
}

interface ResultEnvelopeV1 {
  version: 1;
  type: 'transcode.result';
  messageId: string;
  commandId: string;
  jobId: string;
  attemptId: string;
  attempt: ComputeAttempt;
}
export type ComputeResultV1 = ResultEnvelopeV1 &
  (
    | { state: 'running' }
    | { state: 'succeeded'; output: ComputeOutputV1 }
    | { state: 'failed'; errorCode: ComputeFailureCodeV1 }
    | { state: 'unknown'; errorCode: ComputeUnknownCodeV1 }
  );

export interface VideoProbeSourceV1 {
  stagingKey: string;
  sizeBytes: number;
  etag: string;
  sha256: string;
}

/** Read-only media inspection over private COS staging; it never runs a transcode. */
export interface VideoProbeCommandV1 {
  version: 1;
  type: 'video.probe';
  messageId: string;
  jobId: string;
  outputIndex: number;
  attemptId: string;
  attempt: ComputeAttempt;
  source: VideoProbeSourceV1;
}

export interface VideoProbeMetadataV1 {
  container: string;
  videoCodec: string;
  width: number;
  height: number;
  durationSeconds: number;
  hasAudio: boolean;
  audioCodec: string | null;
}

export type VideoProbeFailureCodeV1 =
  | 'SOURCE_INVALID'
  | 'SOURCE_TOO_LARGE'
  | 'SOURCE_CHANGED'
  | 'PROBE_FAILED'
  | 'EXECUTION_TIMEOUT'
  | 'STORAGE_FAILURE'
  | 'WORKER_INTERRUPTED';

interface VideoProbeResultEnvelopeV1 {
  version: 1;
  type: 'video.probe.result';
  messageId: string;
  commandId: string;
  jobId: string;
  outputIndex: number;
  attemptId: string;
  attempt: ComputeAttempt;
  source: VideoProbeSourceV1;
}

export type VideoProbeResultV1 = VideoProbeResultEnvelopeV1 &
  (
    | { state: 'succeeded'; media: VideoProbeMetadataV1 }
    | { state: 'failed'; errorCode: VideoProbeFailureCodeV1 }
  );

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const failures = new Set<ComputeFailureCodeV1>([
  'INPUT_INVALID',
  'INPUT_TOO_LARGE',
  'INPUT_TOO_LONG',
  'INPUT_CHANGED',
  'TRANSCODE_FAILED',
  'EXECUTION_TIMEOUT',
  'STORAGE_FAILURE',
  'WORKER_INTERRUPTED',
  'OUTPUT_INVALID',
]);
const unknowns = new Set<ComputeUnknownCodeV1>([
  'PROCESS_UNKNOWN',
  'UPLOAD_UNKNOWN',
  'OUTPUT_MISMATCH',
]);
const videoProbeFailures = new Set<VideoProbeFailureCodeV1>([
  'SOURCE_INVALID',
  'SOURCE_TOO_LARGE',
  'SOURCE_CHANGED',
  'PROBE_FAILED',
  'EXECUTION_TIMEOUT',
  'STORAGE_FAILURE',
  'WORKER_INTERRUPTED',
]);

function invalid(): never {
  throw new Error('COMPUTE_MESSAGE_INVALID');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key)))
    invalid();
}
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}
function isAttempt(value: unknown): value is ComputeAttempt {
  return value === 1 || value === 2 || value === 3;
}
function isEtag(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function parseComputeCommandV1(value: unknown): ComputeCommandV1 {
  const message = object(value);
  fields(message, [
    'version',
    'type',
    'messageId',
    'jobId',
    'attemptId',
    'attempt',
    'profile',
    'input',
  ]);
  const input = object(message.input);
  fields(input, ['assetId', 'key', 'sizeBytes', 'etag']);
  if (
    message.version !== COMPUTE_VERSION ||
    message.type !== 'transcode.request' ||
    !isUuid(message.messageId) ||
    !isUuid(message.jobId) ||
    !isUuid(message.attemptId) ||
    !isAttempt(message.attempt) ||
    message.profile !== COMPUTE_PROFILE ||
    !isUuid(input.assetId) ||
    typeof input.key !== 'string' ||
    !input.key.startsWith(`mio/raw/${input.assetId}/`) ||
    !isUuid(input.key.slice(`mio/raw/${input.assetId}/`.length)) ||
    !isSize(input.sizeBytes) ||
    input.sizeBytes > COMPUTE_MAX_MEDIA_BYTES ||
    !isEtag(input.etag)
  )
    return invalid();
  return {
    version: COMPUTE_VERSION,
    type: 'transcode.request',
    messageId: message.messageId,
    jobId: message.jobId,
    attemptId: message.attemptId,
    attempt: message.attempt,
    profile: COMPUTE_PROFILE,
    input: { assetId: input.assetId, key: input.key, sizeBytes: input.sizeBytes, etag: input.etag },
  };
}

export function parseComputeResultV1(value: unknown): ComputeResultV1 {
  const message = object(value);
  const base = [
    'version',
    'type',
    'messageId',
    'commandId',
    'jobId',
    'attemptId',
    'attempt',
    'state',
  ];
  if (message.state === 'running') fields(message, base);
  else if (message.state === 'succeeded') fields(message, [...base, 'output']);
  else if (message.state === 'failed' || message.state === 'unknown')
    fields(message, [...base, 'errorCode']);
  else return invalid();
  if (
    message.version !== COMPUTE_VERSION ||
    message.type !== 'transcode.result' ||
    !isUuid(message.messageId) ||
    !isUuid(message.commandId) ||
    !isUuid(message.jobId) ||
    !isUuid(message.attemptId) ||
    !isAttempt(message.attempt)
  )
    return invalid();
  const envelope = {
    version: COMPUTE_VERSION,
    type: 'transcode.result' as const,
    messageId: message.messageId,
    commandId: message.commandId,
    jobId: message.jobId,
    attemptId: message.attemptId,
    attempt: message.attempt,
  };
  if (message.state === 'running') return { ...envelope, state: 'running' };
  if (message.state === 'succeeded') {
    const output = object(message.output);
    fields(output, ['key', 'sizeBytes', 'etag', 'sha256']);
    if (
      output.key !== `mio/derived/${message.jobId}/${message.attemptId}/result.mp4` ||
      !isSize(output.sizeBytes) ||
      output.sizeBytes > COMPUTE_MAX_MEDIA_BYTES ||
      !isEtag(output.etag) ||
      typeof output.sha256 !== 'string' ||
      !digest.test(output.sha256)
    )
      return invalid();
    return {
      ...envelope,
      state: 'succeeded',
      output: {
        key: output.key,
        sizeBytes: output.sizeBytes,
        etag: output.etag,
        sha256: output.sha256,
      },
    };
  }
  if (message.state === 'failed' && failures.has(message.errorCode as ComputeFailureCodeV1))
    return { ...envelope, state: 'failed', errorCode: message.errorCode as ComputeFailureCodeV1 };
  if (message.state === 'unknown' && unknowns.has(message.errorCode as ComputeUnknownCodeV1))
    return { ...envelope, state: 'unknown', errorCode: message.errorCode as ComputeUnknownCodeV1 };
  return invalid();
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && digest.test(value);
}

function parseVideoProbeSource(
  value: unknown,
  jobId: string,
  outputIndex: number,
  attemptId: string,
): VideoProbeSourceV1 {
  const source = object(value);
  fields(source, ['stagingKey', 'sizeBytes', 'etag', 'sha256']);
  if (
    typeof source.stagingKey !== 'string' ||
    source.stagingKey !== `mio/staging/video/${jobId}/${outputIndex}/${attemptId}.media` ||
    !isSize(source.sizeBytes) ||
    source.sizeBytes > COMPUTE_MAX_MEDIA_BYTES ||
    !isEtag(source.etag) ||
    !isDigest(source.sha256)
  )
    return invalid();
  return {
    stagingKey: source.stagingKey,
    sizeBytes: source.sizeBytes,
    etag: source.etag,
    sha256: source.sha256,
  };
}

function validVideoProbeIdentity(value: Record<string, unknown>): boolean {
  return (
    value.version === 1 &&
    isUuid(value.messageId) &&
    isUuid(value.jobId) &&
    typeof value.outputIndex === 'number' &&
    Number.isSafeInteger(value.outputIndex) &&
    (value.outputIndex as number) >= 0 &&
    (value.outputIndex as number) <= 15 &&
    isUuid(value.attemptId) &&
    isAttempt(value.attempt)
  );
}

export function parseVideoProbeCommandV1(value: unknown): VideoProbeCommandV1 {
  const message = object(value);
  fields(message, [
    'version',
    'type',
    'messageId',
    'jobId',
    'outputIndex',
    'attemptId',
    'attempt',
    'source',
  ]);
  if (message.type !== 'video.probe' || !validVideoProbeIdentity(message)) return invalid();
  const source = parseVideoProbeSource(
    message.source,
    message.jobId as string,
    message.outputIndex as number,
    message.attemptId as string,
  );
  return {
    version: 1,
    type: 'video.probe',
    messageId: message.messageId as string,
    jobId: message.jobId as string,
    outputIndex: message.outputIndex as number,
    attemptId: message.attemptId as string,
    attempt: message.attempt as ComputeAttempt,
    source,
  };
}

function parseVideoProbeMetadata(value: unknown): VideoProbeMetadataV1 {
  const media = object(value);
  fields(media, [
    'container',
    'videoCodec',
    'width',
    'height',
    'durationSeconds',
    'hasAudio',
    'audioCodec',
  ]);
  const validName = (name: unknown): name is string =>
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 128 &&
    /^[A-Za-z0-9_,.+-]+$/.test(name);
  const audioCodec = media.audioCodec;
  if (
    !validName(media.container) ||
    !validName(media.videoCodec) ||
    typeof media.width !== 'number' ||
    !Number.isSafeInteger(media.width) ||
    (media.width as number) < 1 ||
    (media.width as number) > 65536 ||
    typeof media.height !== 'number' ||
    !Number.isSafeInteger(media.height) ||
    (media.height as number) < 1 ||
    (media.height as number) > 65536 ||
    typeof media.durationSeconds !== 'number' ||
    !Number.isFinite(media.durationSeconds) ||
    media.durationSeconds <= 0 ||
    media.durationSeconds > 1800 ||
    typeof media.hasAudio !== 'boolean' ||
    (audioCodec !== null && !validName(audioCodec)) ||
    (!media.hasAudio && audioCodec !== null)
  )
    return invalid();
  return {
    container: media.container,
    videoCodec: media.videoCodec,
    width: media.width as number,
    height: media.height as number,
    durationSeconds: media.durationSeconds,
    hasAudio: media.hasAudio,
    audioCodec: audioCodec as string | null,
  };
}

export function parseVideoProbeResultV1(value: unknown): VideoProbeResultV1 {
  const message = object(value);
  const state = message.state;
  if (state === 'succeeded')
    fields(message, [
      'version',
      'type',
      'messageId',
      'commandId',
      'jobId',
      'outputIndex',
      'attemptId',
      'attempt',
      'source',
      'state',
      'media',
    ]);
  else if (state === 'failed')
    fields(message, [
      'version',
      'type',
      'messageId',
      'commandId',
      'jobId',
      'outputIndex',
      'attemptId',
      'attempt',
      'source',
      'state',
      'errorCode',
    ]);
  else return invalid();
  if (
    message.type !== 'video.probe.result' ||
    !validVideoProbeIdentity(message) ||
    !isUuid(message.commandId)
  )
    return invalid();
  const source = parseVideoProbeSource(
    message.source,
    message.jobId as string,
    message.outputIndex as number,
    message.attemptId as string,
  );
  const envelope = {
    version: 1 as const,
    type: 'video.probe.result' as const,
    messageId: message.messageId as string,
    commandId: message.commandId as string,
    jobId: message.jobId as string,
    outputIndex: message.outputIndex as number,
    attemptId: message.attemptId as string,
    attempt: message.attempt as ComputeAttempt,
    source,
  };
  if (state === 'succeeded')
    return { ...envelope, state: 'succeeded', media: parseVideoProbeMetadata(message.media) };
  if (videoProbeFailures.has(message.errorCode as VideoProbeFailureCodeV1))
    return {
      ...envelope,
      state: 'failed',
      errorCode: message.errorCode as VideoProbeFailureCodeV1,
    };
  return invalid();
}
