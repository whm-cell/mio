import type {
  MediaCommand,
  MediaControl,
  MediaData,
  MediaManifest,
  MediaObject,
  MediaRequest,
  MediaResult,
} from './media-types.ts';
import {
  MEDIA_MAX_FILES,
  MEDIA_MAX_INPUTS,
  MEDIA_MAX_MANIFEST_BYTES,
  MEDIA_MAX_MESSAGE_BYTES,
  MEDIA_OPERATIONS,
  MEDIA_PROFILE,
  MEDIA_VERSION,
  mediaObjectPrefix,
} from './media-types.ts';
import { parseMediaParameters } from './media-parameters.ts';
import {
  mediaArray as array,
  mediaPayload as payload,
  mediaEnum as choice,
  mediaFields as fields,
  mediaInvalid as invalid,
  mediaNumber as number,
  mediaRecord as object,
  mediaString as string,
  mediaUuid as uuid,
} from './media-validation.ts';

const MAX_FILE = 1024 ** 3;
function etag(value: unknown): string {
  const text = string(value, 256);
  if (!text || /[\r\n\t]/.test(text)) return invalid();
  return text;
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value))
    return invalid();
  return value;
}
export function parseMediaRequest(value: unknown): MediaRequest {
  const m = object(payload(value, MEDIA_MAX_MESSAGE_BYTES));
  fields(m, ['requestId', 'operation', 'inputs', 'parameters']);
  const requestId = uuid(m.requestId),
    operation = choice(m.operation, MEDIA_OPERATIONS);
  const inputs = array(m.inputs, MEDIA_MAX_INPUTS, 1).map((v) => {
    const input = object(v);
    fields(input, ['assetId']);
    return { assetId: uuid(input.assetId) };
  });
  if (new Set(inputs.map((i) => i.assetId)).size !== inputs.length) invalid();
  return {
    requestId,
    operation,
    inputs,
    parameters: parseMediaParameters(operation, m.parameters, inputs.length),
  } as MediaRequest;
}
function inputKey(value: unknown, assetId: string): string {
  const key = string(value, 512);
  if (
    !/^mio\/(raw|derived|media|audio)\/[a-zA-Z0-9/_\-.]+$/.test(key) ||
    key.split('/').some((p) => !p || p === '.' || p === '..')
  )
    return invalid();
  if (/\s/.test(key)) invalid();
  if (key.startsWith('mio/raw/')) {
    const prefix = `mio/raw/${assetId}/`;
    if (!key.startsWith(prefix)) invalid();
    uuid(key.slice(prefix.length));
  }
  return key;
}
export function parseMediaCommand(value: unknown): MediaCommand {
  const m = object(payload(value, MEDIA_MAX_MESSAGE_BYTES));
  fields(m, [
    'version',
    'type',
    'messageId',
    'jobId',
    'attemptId',
    'attempt',
    'profile',
    'operation',
    'inputs',
    'parameters',
  ]);
  if (m.version !== MEDIA_VERSION || m.type !== 'media.request' || m.profile !== MEDIA_PROFILE)
    invalid();
  const operation = choice(m.operation, MEDIA_OPERATIONS);
  const inputs = array(m.inputs, MEDIA_MAX_INPUTS, 1).map((v) => {
    const i = object(v);
    fields(i, ['assetId', 'key', 'sizeBytes', 'etag']);
    const assetId = uuid(i.assetId);
    return {
      assetId,
      key: inputKey(i.key, assetId),
      sizeBytes: number(i.sizeBytes, 1, MAX_FILE, true),
      etag: etag(i.etag),
    };
  });
  if (new Set(inputs.map((i) => i.assetId)).size !== inputs.length) invalid();
  return {
    version: MEDIA_VERSION,
    type: 'media.request',
    messageId: uuid(m.messageId),
    jobId: uuid(m.jobId),
    attemptId: uuid(m.attemptId),
    attempt: number(m.attempt, 1, 3, true),
    profile: MEDIA_PROFILE,
    operation,
    inputs,
    parameters: parseMediaParameters(operation, m.parameters, inputs.length),
  } as MediaCommand;
}
export function parseMediaControl(value: unknown): MediaControl {
  const m = object(payload(value, MEDIA_MAX_MESSAGE_BYTES));
  fields(m, ['version', 'type', 'messageId', 'jobId', 'attemptId', 'action']);
  if (m.version !== MEDIA_VERSION || m.type !== 'media.control') invalid();
  return {
    version: MEDIA_VERSION,
    type: 'media.control',
    messageId: uuid(m.messageId),
    jobId: uuid(m.jobId),
    attemptId: uuid(m.attemptId),
    action: choice(m.action, ['cancel', 'recover']),
  };
}
function output(value: unknown, prefix: string, manifest = false): MediaObject {
  const o = object(value);
  fields(o, ['key', 'sizeBytes', 'etag', 'sha256']);
  const key = string(o.key, 512);
  if (
    !key.startsWith(prefix) ||
    /\s/.test(key) ||
    !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/.test(key.slice(prefix.length)) ||
    (manifest && key !== `${prefix}manifest.json`)
  )
    invalid();
  return {
    key,
    sizeBytes: number(o.sizeBytes, 1, manifest ? MEDIA_MAX_MANIFEST_BYTES : MAX_FILE, true),
    etag: etag(o.etag),
    sha256: sha(o.sha256),
  };
}
export function parseMediaResult(value: unknown): MediaResult {
  const m = object(payload(value, MEDIA_MAX_MESSAGE_BYTES));
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
  const state = choice(m.state, ['running', 'succeeded', 'failed', 'reconciling', 'cancelled']);
  fields(m, [
    ...base,
    ...(state === 'running'
      ? ['stage', 'progress']
      : state === 'succeeded'
        ? ['manifest']
        : state === 'cancelled'
          ? []
          : ['errorCode']),
  ]);
  if (m.version !== MEDIA_VERSION || m.type !== 'media.result') invalid();
  const envelope = {
    version: MEDIA_VERSION,
    type: 'media.result' as const,
    messageId: uuid(m.messageId),
    commandId: uuid(m.commandId),
    jobId: uuid(m.jobId),
    attemptId: uuid(m.attemptId),
    attempt: number(m.attempt, 1, 3, true) as 1 | 2 | 3,
  };
  if (state === 'running') {
    const stage = string(m.stage, 80);
    if (/\s/.test(stage) || !/^[a-zA-Z0-9_.-]+$/.test(stage)) invalid();
    return { ...envelope, state, stage, progress: number(m.progress, 0, 1) };
  }
  if (state === 'succeeded')
    return {
      ...envelope,
      state,
      manifest: output(m.manifest, mediaObjectPrefix(envelope.jobId, envelope.attemptId), true),
    };
  if (state === 'cancelled') return { ...envelope, state };
  if (state === 'reconciling')
    return {
      ...envelope,
      state,
      errorCode: choice(m.errorCode, ['PROCESS_UNKNOWN', 'UPLOAD_UNKNOWN', 'OUTPUT_MISMATCH']),
    };
  return {
    ...envelope,
    state,
    errorCode: choice(m.errorCode, [
      'INPUT_INVALID',
      'INPUT_CHANGED',
      'INPUT_TOO_LARGE',
      'INPUT_TOO_LONG',
      'OUTPUT_INVALID',
      'CAPABILITY_UNAVAILABLE',
      'EXECUTION_FAILED',
      'EXECUTION_TIMEOUT',
      'STORAGE_FAILURE',
      'WORKER_INTERRUPTED',
      'DISK_FULL',
    ]),
  };
}
function data(value: unknown): MediaData {
  const d = object(value);
  fields(d, [], ['probe', 'scenes', 'waveform', 'compressed', 'trimmed', 'subtitles']);
  for (const k of ['compressed', 'trimmed'])
    if (d[k] !== undefined && typeof d[k] !== 'boolean') invalid();
  if (d.scenes !== undefined) {
    let last = -1;
    for (const v of array(d.scenes, 4096)) {
      const n = number(v, 0, 3600);
      if (n <= last) invalid();
      last = n;
    }
  }
  if (d.waveform !== undefined) array(d.waveform, 4096, 1).forEach((v) => number(v, 0, 1));
  if (d.subtitles !== undefined) {
    for (const v of array(d.subtitles, 4096)) {
      const c = object(v);
      fields(c, ['startSeconds', 'endSeconds', 'text']);
      if (number(c.endSeconds, 0.001, 3600) <= number(c.startSeconds, 0, 3600)) invalid();
      string(c.text, 4096);
    }
  }
  if (d.probe !== undefined) {
    const p = object(d.probe);
    fields(p, [
      'durationSeconds',
      'format',
      'hasVideo',
      'hasAudio',
      'width',
      'height',
      'rotation',
      'sampleAspectRatio',
      'videoCodec',
      'audioCodec',
      'sampleRate',
      'channels',
      'fps',
    ]);
    number(p.durationSeconds, 0.001, 3600);
    string(p.format, 120);
    if (typeof p.hasVideo !== 'boolean' || typeof p.hasAudio !== 'boolean') invalid();
    for (const k of ['width', 'height']) if (p[k] !== null) number(p[k], 1, 16384, true);
    number(p.rotation, -360, 360);
    if (!/^[0-9]{1,6}:[0-9]{1,6}$/.test(string(p.sampleAspectRatio, 20))) invalid();
    for (const k of ['videoCodec', 'audioCodec'])
      if (p[k] !== null && !/^[a-z0-9_]{1,40}$/.test(string(p[k], 40))) invalid();
    if (p.sampleRate !== null) number(p.sampleRate, 1, 384000, true);
    if (p.channels !== null) number(p.channels, 1, 64, true);
    if (p.fps !== null) number(p.fps, 0.001, 1000);
  }
  return structuredClone(d) as MediaData;
}
export function parseMediaManifest(value: unknown): MediaManifest {
  const m = object(payload(value, MEDIA_MAX_MANIFEST_BYTES));
  fields(m, ['version', 'jobId', 'attemptId', 'profile', 'operation', 'files', 'data']);
  if (m.version !== MEDIA_VERSION || m.profile !== MEDIA_PROFILE) invalid();
  const jobId = uuid(m.jobId),
    attemptId = uuid(m.attemptId),
    prefix = mediaObjectPrefix(jobId, attemptId);
  const names = new Set<string>();
  const files = array(m.files, MEDIA_MAX_FILES).map((v) => {
    const f = object(v);
    fields(f, ['name', 'role', 'contentType', 'key', 'sizeBytes', 'etag', 'sha256']);
    const name = string(f.name, 128);
    if (names.has(name) || name === 'manifest.json') invalid();
    names.add(name);
    const o = output(
      { key: f.key, sizeBytes: f.sizeBytes, etag: f.etag, sha256: f.sha256 },
      prefix,
    );
    if (o.key !== prefix + name) invalid();
    const contentType = choice(f.contentType, [
      'video/mp4',
      'video/webm',
      'video/mp2t',
      'application/vnd.apple.mpegurl',
      'application/json',
      'image/jpeg',
      'image/png',
      'image/gif',
      'audio/mpeg',
      'audio/wav',
      'audio/mp4',
      'text/plain',
      'text/vtt',
    ]);
    return {
      ...o,
      name,
      role: choice(f.role, [
        'primary',
        'preview',
        'poster',
        'hls',
        'frame',
        'segment',
        'audio',
        'data',
      ]),
      contentType,
    };
  });
  return {
    version: MEDIA_VERSION,
    jobId,
    attemptId,
    profile: MEDIA_PROFILE,
    operation: choice(m.operation, MEDIA_OPERATIONS),
    files,
    data: data(m.data),
  };
}
