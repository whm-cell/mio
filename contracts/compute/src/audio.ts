/** Read-only inspection of an existing private COS object. */
export const AUDIO_INSPECT_PROFILE = 'audio-decode-inspect-v1' as const;
export const AUDIO_COMMAND_QUEUE = 'mio.compute.audio.commands.v1';
export const AUDIO_COMMAND_ROUTING_KEY = 'audio.inspect.v1';
export const AUDIO_RESULT_QUEUE = 'mio.compute.audio.results.v1';
export const AUDIO_RESULT_ROUTING_KEY = 'audio.inspect.result.v1';
export const AUDIO_MAX_MESSAGE_BYTES = 8192;
export const AUDIO_MAX_SAMPLE_BYTES = 20 * 1024 * 1024;
export const AUDIO_MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

export const AUDIO_MIME_TYPES = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
} as const;

type AudioFormat = keyof typeof AUDIO_MIME_TYPES;
type AudioPurpose = 'sample' | 'output';

export const AUDIO_INSPECTION_LIMITS = {
  sample: { maxBytes: AUDIO_MAX_SAMPLE_BYTES, minDurationMs: 10_000, maxDurationMs: 300_000 },
  output: { maxBytes: AUDIO_MAX_OUTPUT_BYTES, minDurationMs: 1, maxDurationMs: 3_600_000 },
} as const;

interface AudioObject {
  assetId: string;
  key: string;
  sizeBytes: number;
  etag: string;
  sha256?: string;
}

export interface AudioInspectionInput extends AudioObject {
  jobId: string;
  purpose: AudioPurpose;
}

export interface AudioInspection {
  durationMs: number;
  format: AudioFormat;
  mimeType: (typeof AUDIO_MIME_TYPES)[AudioFormat];
  codec: string;
  sampleRate: number;
  channels: 1 | 2;
  sizeBytes: number;
  sha256: string;
}

export interface AudioInspectCommandV1 {
  version: 1;
  type: 'audio.inspect.request';
  profile: typeof AUDIO_INSPECT_PROFILE;
  messageId: string;
  inspectionId: string;
  jobId: string;
  purpose: AudioPurpose;
  input: AudioObject;
}

interface AudioInspectEnvelopeV1 {
  version: 1;
  type: 'audio.inspect.result';
  messageId: string;
  commandId: string;
  inspectionId: string;
  jobId: string;
}

const failures = [
  'AUDIO_INPUT_INVALID',
  'AUDIO_INPUT_CHANGED',
  'AUDIO_DURATION_INVALID',
  'AUDIO_STORAGE_UNAVAILABLE',
  'AUDIO_INSPECTION_TIMEOUT',
] as const;

export type AudioInspectFailure = (typeof failures)[number];

export type AudioInspectResultV1 = AudioInspectEnvelopeV1 &
  (
    | { state: 'succeeded'; inspection: AudioInspection }
    | { state: 'failed'; errorCode: AudioInspectFailure }
  );

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[a-f0-9]{64}$/;

function invalid(): never {
  throw new Error('AUDIO_MESSAGE_INVALID');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, expected: readonly string[]): void {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}

function id(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && digest.test(value);
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function parseAudioInspectCommandV1(value: unknown): AudioInspectCommandV1 {
  const message = object(value);
  fields(message, [
    'version',
    'type',
    'profile',
    'messageId',
    'inspectionId',
    'jobId',
    'purpose',
    'input',
  ]);
  const input = object(message.input);
  const keys = ['assetId', 'key', 'sizeBytes', 'etag'];
  if (Object.hasOwn(input, 'sha256')) keys.push('sha256');
  fields(input, keys);
  if (
    message.version !== 1 ||
    message.type !== 'audio.inspect.request' ||
    message.profile !== AUDIO_INSPECT_PROFILE ||
    !id(message.messageId) ||
    !id(message.inspectionId) ||
    !id(message.jobId) ||
    (message.purpose !== 'sample' && message.purpose !== 'output') ||
    !id(input.assetId) ||
    typeof input.key !== 'string' ||
    !boundedInteger(input.sizeBytes, 1, AUDIO_INSPECTION_LIMITS[message.purpose].maxBytes) ||
    typeof input.etag !== 'string' ||
    !input.etag ||
    input.etag.length > 256 ||
    /[\x00-\x1f\x7f]/.test(input.etag) ||
    (keys.length > 4 && !isDigest(input.sha256))
  )
    return invalid();
  const rawPrefix = `mio/raw/${input.assetId}/`;
  if (!input.key.startsWith(rawPrefix) || !id(input.key.slice(rawPrefix.length))) return invalid();
  return {
    version: 1,
    type: 'audio.inspect.request',
    profile: AUDIO_INSPECT_PROFILE,
    messageId: message.messageId,
    inspectionId: message.inspectionId,
    jobId: message.jobId,
    purpose: message.purpose,
    input: {
      assetId: input.assetId,
      key: input.key,
      sizeBytes: input.sizeBytes,
      etag: input.etag,
      ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    },
  };
}

export function parseAudioInspectResultV1(value: unknown): AudioInspectResultV1 {
  const message = object(value);
  const envelope = ['version', 'type', 'messageId', 'commandId', 'inspectionId', 'jobId', 'state'];
  if (message.state === 'succeeded') fields(message, [...envelope, 'inspection']);
  else if (message.state === 'failed') fields(message, [...envelope, 'errorCode']);
  else return invalid();
  if (
    message.version !== 1 ||
    message.type !== 'audio.inspect.result' ||
    !id(message.messageId) ||
    !id(message.commandId) ||
    !id(message.inspectionId) ||
    !id(message.jobId)
  )
    return invalid();
  const base = {
    version: 1 as const,
    type: 'audio.inspect.result' as const,
    messageId: message.messageId,
    commandId: message.commandId,
    inspectionId: message.inspectionId,
    jobId: message.jobId,
  };
  if (message.state === 'failed') {
    const code = failures.find((failure) => failure === message.errorCode);
    if (!code) return invalid();
    return { ...base, state: 'failed', errorCode: code };
  }
  const inspection = object(message.inspection);
  fields(inspection, [
    'durationMs',
    'format',
    'mimeType',
    'codec',
    'sampleRate',
    'channels',
    'sizeBytes',
    'sha256',
  ]);
  if (
    !boundedInteger(inspection.durationMs, 1, AUDIO_INSPECTION_LIMITS.output.maxDurationMs) ||
    typeof inspection.format !== 'string' ||
    !Object.hasOwn(AUDIO_MIME_TYPES, inspection.format) ||
    inspection.mimeType !== AUDIO_MIME_TYPES[inspection.format as AudioFormat] ||
    typeof inspection.codec !== 'string' ||
    !/^[a-z0-9_]{1,40}$/.test(inspection.codec) ||
    !boundedInteger(inspection.sampleRate, 8000, 192000) ||
    (inspection.channels !== 1 && inspection.channels !== 2) ||
    !boundedInteger(inspection.sizeBytes, 1, AUDIO_MAX_OUTPUT_BYTES) ||
    !isDigest(inspection.sha256)
  )
    return invalid();
  return { ...base, state: 'succeeded', inspection: inspection as unknown as AudioInspection };
}
