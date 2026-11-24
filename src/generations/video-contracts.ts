import { createHash } from 'node:crypto';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { GenerationError } from './errors.ts';

export const VIDEO_MAX_HTTP_BODY_BYTES = 256 * 1024;
export const VIDEO_MAX_PROMPT_CODEPOINTS = 5_000;
/** Parser-level array cap; a model route may impose a smaller value. */
export const VIDEO_MAX_INPUT_ITEMS = 16;
export const VIDEO_USER_QUOTA = 5;
export const VIDEO_GLOBAL_QUOTA = 50;

export const VIDEO_MODES = [
  'text_to_video',
  'first_frame',
  'last_frame',
  'start_end',
  'reference_subjects',
  'full',
  'video_ref',
  'video_edit',
  'multiframe',
] as const;
export type VideoMode = (typeof VIDEO_MODES)[number];

export const VIDEO_DRIVERS = [
  'volcengine-ark-videos',
  'kling-videos',
  'vidu-videos',
  'veo-videos',
  'happyhorse-videos',
] as const;
export type VideoDriver = (typeof VIDEO_DRIVERS)[number];

export const VIDEO_JOB_STATES = [
  'accepted',
  'submitted',
  'processing',
  'materializing',
  'completed',
  'partial',
  'materialization_failed',
  'unknown',
  'failed',
  'rejected',
  'cancelled',
] as const;
export type VideoJobState = (typeof VIDEO_JOB_STATES)[number];

export const VIDEO_EXECUTION_PHASES = [
  'ready',
  'submitting',
  'waiting',
  'querying',
  'materializing',
  'done',
] as const;
export type VideoExecutionPhase = (typeof VIDEO_EXECUTION_PHASES)[number];

export const VIDEO_OUTPUT_PHASES = [
  'pending',
  'staging',
  'probed',
  'registered',
  'failed',
] as const;
export type VideoOutputPhase = (typeof VIDEO_OUTPUT_PHASES)[number];

export interface VideoAssetReference {
  assetId: string;
  mediaType?: 'image' | 'audio' | 'video';
  role?: string;
}

export interface VideoRequestParameters {
  mode: VideoMode;
  prompt: string;
  ratio?: string;
  resolution?: string;
  durationSeconds?: number;
  generateAudio?: boolean;
  audioType?: string;
  audioSetting?: string;
  watermark?: boolean;
  offPeak?: boolean;
  firstFrame?: { assetId: string };
  lastFrame?: { assetId: string };
  references?: VideoAssetReference[];
  subjects?: { name: string; images: { assetId: string }[] }[];
  multiShot?: boolean;
  shots?: { prompt: string; durationSeconds: number }[];
  multiframeSegments?: {
    prompt: string;
    keyImage: { assetId: string };
    durationSeconds: number;
  }[];
}

export interface VideoCreateRequest {
  requestId: string;
  modelRef: string;
  expectedCapabilitiesVersion: string;
  parameters: VideoRequestParameters;
}

export interface VideoCapabilityMode {
  mode: VideoMode;
  supported: boolean;
  parameters?: Record<string, unknown>;
}

export interface VideoCapabilitiesView {
  modelRef: string;
  capabilitiesVersion: string;
  available: boolean;
  unavailableReason: string | null;
  modes: VideoCapabilityMode[];
  cancellation: { supported: boolean };
}

export interface VideoJobView {
  id: string;
  requestId: string;
  modelRef: string;
  mode: VideoMode;
  state: VideoJobState;
  stage: VideoExecutionPhase;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  effectiveParameters: VideoRequestParameters;
  inputSnapshot: VideoAssetReference[];
  outputs: VideoOutputView[];
  error: { code: string } | null;
  cancellation: {
    requested: boolean;
    supported: boolean;
    status: 'pending' | 'confirmed' | 'not_supported' | 'rejected' | 'unknown' | 'too_late' | null;
  };
  recovery: { available: boolean; reason: string | null };
}

export interface VideoOutputView {
  index: number;
  assetId: string | null;
  mediaType: 'video';
  status: VideoOutputPhase;
  errorCode: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  hasAudio: boolean | null;
}

const ROOT_FIELDS = new Set(['requestId', 'modelRef', 'expectedCapabilitiesVersion', 'parameters']);
const PARAMETER_FIELDS = new Set([
  'mode',
  'prompt',
  'ratio',
  'resolution',
  'durationSeconds',
  'generateAudio',
  'audioType',
  'audioSetting',
  'watermark',
  'offPeak',
  'firstFrame',
  'lastFrame',
  'references',
  'subjects',
  'multiShot',
  'shots',
  'multiframeSegments',
]);
const ASSET_REFERENCE_FIELDS = new Set(['assetId']);
const MEDIA_REFERENCE_FIELDS = new Set(['assetId', 'mediaType', 'role']);
const SUBJECT_FIELDS = new Set(['name', 'images']);
const SHOT_FIELDS = new Set(['prompt', 'durationSeconds']);
const MULTIFRAME_FIELDS = new Set(['prompt', 'keyImage', 'durationSeconds']);

function invalid(): never {
  throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'VIDEO_INPUT_INVALID');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !fields.has(key))) invalid();
}

function text(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.isWellFormed() &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
  );
}

function codepointCount(value: string): number {
  let count = 0;
  for (let offset = 0; offset < value.length; count++) {
    offset += value.codePointAt(offset)! > 0xffff ? 2 : 1;
  }
  return count;
}

function assetReference(value: unknown): { assetId: string } {
  if (!isPlainObject(value)) return invalid();
  exactFields(value, ASSET_REFERENCE_FIELDS);
  if (typeof value.assetId !== 'string' || !isUuidV4(value.assetId)) return invalid();
  return { assetId: value.assetId };
}

function boundedDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function decodePrompt(value: unknown): string {
  if (!text(value, 20_000)) return invalid();
  const prompt = value.trim();
  if (!prompt || codepointCount(prompt) > VIDEO_MAX_PROMPT_CODEPOINTS) return invalid();
  return prompt;
}

function decodeParameters(value: unknown): VideoRequestParameters {
  if (!isPlainObject(value)) return invalid();
  exactFields(value, PARAMETER_FIELDS);
  if (!VIDEO_MODES.includes(value.mode as VideoMode)) return invalid();
  const prompt = decodePrompt(value.prompt);
  const mode = value.mode as VideoMode;
  if (value.ratio !== undefined && (!text(value.ratio, 16) || !value.ratio)) return invalid();
  if (value.resolution !== undefined && (!text(value.resolution, 24) || !value.resolution))
    return invalid();
  if (value.durationSeconds !== undefined && !boundedDuration(value.durationSeconds))
    return invalid();
  if (value.generateAudio !== undefined && typeof value.generateAudio !== 'boolean')
    return invalid();
  if (value.watermark !== undefined && typeof value.watermark !== 'boolean') return invalid();
  if (value.offPeak !== undefined && typeof value.offPeak !== 'boolean') return invalid();
  if (value.audioType !== undefined && (!text(value.audioType, 64) || !value.audioType))
    return invalid();
  if (value.audioSetting !== undefined && (!text(value.audioSetting, 128) || !value.audioSetting))
    return invalid();
  if (value.multiShot !== undefined && typeof value.multiShot !== 'boolean') return invalid();

  const firstFrame = value.firstFrame === undefined ? undefined : assetReference(value.firstFrame);
  const lastFrame = value.lastFrame === undefined ? undefined : assetReference(value.lastFrame);
  const references = value.references;
  if (
    references !== undefined &&
    (!Array.isArray(references) || references.length > VIDEO_MAX_INPUT_ITEMS)
  )
    return invalid();
  const decodedReferences = references?.map((entry) => {
    if (!isPlainObject(entry)) return invalid();
    exactFields(entry, MEDIA_REFERENCE_FIELDS);
    if (typeof entry.assetId !== 'string' || !isUuidV4(entry.assetId)) return invalid();
    if (
      entry.mediaType !== undefined &&
      entry.mediaType !== 'image' &&
      entry.mediaType !== 'audio' &&
      entry.mediaType !== 'video'
    )
      return invalid();
    if (entry.role !== undefined && (!text(entry.role, 64) || !entry.role)) return invalid();
    return {
      assetId: entry.assetId,
      ...(entry.mediaType !== undefined
        ? { mediaType: entry.mediaType as 'image' | 'audio' | 'video' }
        : {}),
      ...(entry.role !== undefined ? { role: entry.role as string } : {}),
    };
  });

  const subjects = value.subjects;
  if (
    subjects !== undefined &&
    (!Array.isArray(subjects) || subjects.length > VIDEO_MAX_INPUT_ITEMS)
  )
    return invalid();
  const decodedSubjects = subjects?.map((entry) => {
    if (!isPlainObject(entry)) return invalid();
    exactFields(entry, SUBJECT_FIELDS);
    if (!text(entry.name, 128) || !entry.name.trim()) return invalid();
    if (
      !Array.isArray(entry.images) ||
      entry.images.length < 1 ||
      entry.images.length > VIDEO_MAX_INPUT_ITEMS
    )
      return invalid();
    return { name: entry.name.trim(), images: entry.images.map(assetReference) };
  });
  if (
    decodedSubjects &&
    new Set(decodedSubjects.map((subject) => subject.name)).size !== decodedSubjects.length
  )
    return invalid();

  const shots = value.shots;
  if (shots !== undefined && (!Array.isArray(shots) || shots.length > VIDEO_MAX_INPUT_ITEMS))
    return invalid();
  const decodedShots = shots?.map((entry) => {
    if (!isPlainObject(entry)) return invalid();
    exactFields(entry, SHOT_FIELDS);
    if (!boundedDuration(entry.durationSeconds)) return invalid();
    return { prompt: decodePrompt(entry.prompt), durationSeconds: entry.durationSeconds };
  });

  const segments = value.multiframeSegments;
  if (
    segments !== undefined &&
    (!Array.isArray(segments) || segments.length > VIDEO_MAX_INPUT_ITEMS)
  )
    return invalid();
  const decodedSegments = segments?.map((entry) => {
    if (!isPlainObject(entry)) return invalid();
    exactFields(entry, MULTIFRAME_FIELDS);
    if (!boundedDuration(entry.durationSeconds)) return invalid();
    return {
      prompt: decodePrompt(entry.prompt),
      keyImage: assetReference(entry.keyImage),
      durationSeconds: entry.durationSeconds,
    };
  });

  const hasFrames = Boolean(firstFrame || lastFrame);
  const hasReferences = Boolean(decodedReferences?.length);
  const hasSubjects = Boolean(decodedSubjects?.length);
  const hasShots = Boolean(decodedShots?.length);
  const hasSegments = Boolean(decodedSegments?.length);
  const hasVideoReference =
    decodedReferences?.some((reference) => reference.mediaType === 'video') ?? false;
  const totalInputs =
    Number(Boolean(firstFrame)) +
    Number(Boolean(lastFrame)) +
    (decodedReferences?.length ?? 0) +
    (decodedSubjects?.reduce((total, subject) => total + subject.images.length, 0) ?? 0) +
    (decodedSegments?.length ?? 0);
  if (totalInputs > VIDEO_MAX_INPUT_ITEMS) return invalid();

  if (
    mode === 'first_frame' &&
    (!firstFrame || lastFrame || hasReferences || hasSubjects || hasSegments)
  )
    return invalid();
  if (
    mode === 'last_frame' &&
    (!lastFrame || firstFrame || hasReferences || hasSubjects || hasSegments)
  )
    return invalid();
  if (
    mode === 'start_end' &&
    (!firstFrame || !lastFrame || hasReferences || hasSubjects || hasSegments)
  )
    return invalid();
  if (mode === 'text_to_video' && (hasFrames || hasReferences || hasSubjects || hasSegments))
    return invalid();
  if (
    mode === 'reference_subjects' &&
    (!hasSubjects || hasFrames || hasReferences || hasShots || hasSegments)
  )
    return invalid();
  if (mode === 'full' && (!hasReferences || hasFrames || hasSubjects || hasShots || hasSegments))
    return invalid();
  if (
    (mode === 'video_ref' || mode === 'video_edit') &&
    (!hasVideoReference || hasFrames || hasSubjects || hasShots || hasSegments)
  )
    return invalid();
  if (
    mode === 'multiframe' &&
    (!hasSegments || hasFrames || hasReferences || hasSubjects || hasShots || value.multiShot)
  )
    return invalid();
  if (mode !== 'multiframe' && hasSegments) return invalid();
  if (hasShots && (!value.multiShot || !['text_to_video', 'first_frame'].includes(mode)))
    return invalid();
  if (value.multiShot && !['text_to_video', 'first_frame'].includes(mode)) return invalid();

  const durationTotal =
    (decodedShots?.reduce((total, shot) => total + shot.durationSeconds, 0) ?? 0) +
    (decodedSegments?.reduce((total, segment) => total + segment.durationSeconds, 0) ?? 0);
  if (!Number.isFinite(durationTotal)) return invalid();

  return {
    mode,
    prompt,
    ...(value.ratio !== undefined ? { ratio: value.ratio as string } : {}),
    ...(value.resolution !== undefined ? { resolution: value.resolution as string } : {}),
    ...(value.durationSeconds !== undefined
      ? { durationSeconds: value.durationSeconds as number }
      : {}),
    ...(value.generateAudio !== undefined ? { generateAudio: value.generateAudio as boolean } : {}),
    ...(value.audioType !== undefined ? { audioType: value.audioType as string } : {}),
    ...(value.audioSetting !== undefined ? { audioSetting: value.audioSetting as string } : {}),
    ...(value.watermark !== undefined ? { watermark: value.watermark as boolean } : {}),
    ...(value.offPeak !== undefined ? { offPeak: value.offPeak as boolean } : {}),
    ...(firstFrame ? { firstFrame } : {}),
    ...(lastFrame ? { lastFrame } : {}),
    ...(decodedReferences ? { references: decodedReferences } : {}),
    ...(decodedSubjects ? { subjects: decodedSubjects } : {}),
    ...(value.multiShot !== undefined ? { multiShot: value.multiShot as boolean } : {}),
    ...(decodedShots ? { shots: decodedShots } : {}),
    ...(decodedSegments ? { multiframeSegments: decodedSegments } : {}),
  };
}

export function decodeVideoCreateRequest(value: Record<string, unknown>): VideoCreateRequest {
  exactFields(value, ROOT_FIELDS);
  if (
    typeof value.requestId !== 'string' ||
    !isUuidV4(value.requestId) ||
    typeof value.modelRef !== 'string' ||
    !value.modelRef.startsWith('onelink:model:') ||
    value.modelRef.length > 300 ||
    typeof value.expectedCapabilitiesVersion !== 'string' ||
    !value.expectedCapabilitiesVersion ||
    value.expectedCapabilitiesVersion.length > 200
  )
    return invalid();
  return {
    requestId: value.requestId,
    modelRef: value.modelRef,
    expectedCapabilitiesVersion: value.expectedCapabilitiesVersion,
    parameters: decodeParameters(value.parameters),
  };
}

/** Input order and repeated positions are intentional parts of the request identity. */
export function videoRequestHash(request: VideoCreateRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}
