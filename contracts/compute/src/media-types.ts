/** General media processing uses a separate, additive envelope. */
export const MEDIA_VERSION = 1 as const;
export const MEDIA_PROFILE = 'standard-media' as const;
export const MEDIA_MAX_MESSAGE_BYTES = 256 * 1024;
export const MEDIA_MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MEDIA_MAX_FILES = 4096;
export const MEDIA_MAX_INPUTS = 64;
export const MEDIA_MAX_ITEMS = 256;
export const MEDIA_ENCODE_QUEUE = 'mio.compute.media.encode';
export const MEDIA_PROBE_QUEUE = 'mio.compute.media.probe';
export const MEDIA_CONTROL_QUEUE = 'mio.compute.media.control';
export const MEDIA_RESULT_QUEUE = 'mio.compute.media.results';
export const MEDIA_ENCODE_ROUTING_KEY = 'media.encode';
export const MEDIA_PROBE_ROUTING_KEY = 'media.probe';
export const MEDIA_CONTROL_ROUTING_KEY = 'media.control';
export const MEDIA_RESULT_ROUTING_KEY = 'media.result';

export interface SubtitleCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}
export interface SubtitleStyle {
  font?: 'sans' | 'serif';
  fontSize?: number;
  color?: string;
  background?: string;
  outlineColor?: string;
  outline?: number;
  alignment?: 'bottom' | 'middle' | 'top';
  margin?: number;
}
export interface TimelineTrack {
  kind: 'video' | 'audio' | 'subtitle';
  index: number;
  hidden?: boolean;
  locked?: boolean;
  volume?: number;
}
export interface TimelineItem {
  kind: 'video' | 'image' | 'audio' | 'subtitle';
  track: number;
  inputIndex?: number;
  startSeconds: number;
  durationSeconds: number;
  sourceStartSeconds?: number;
  speed?: number;
  volume?: number;
  muted?: boolean;
  hidden?: boolean;
  transform?: {
    x: number;
    y: number;
    scale: number;
    rotation: number;
    fit: 'contain' | 'cover' | 'manual';
    width?: number;
    height?: number;
  };
  text?: string;
  style?: SubtitleStyle;
}
export interface MediaParameters {
  'media.probe': Record<string, never>;
  'video.reference_prepare': Record<string, never>;
  'video.derivatives': { profile: 'ordinary' | 'canvas' };
  'video.trim': { startSeconds: number; endSeconds: number };
  'frames.extract': {
    mode: 'first_last' | 'timestamps' | 'interval' | 'scene';
    timestamps?: number[];
    intervalSeconds?: number;
    threshold?: number;
    maxFrames?: number;
    width?: number;
  };
  'scenes.detect': { threshold?: number; minSceneSeconds?: number };
  'video.split': { boundaries: number[] };
  'audio.extract': { profile: 'original' | 'asr'; format?: 'wav' | 'mp3' | 'm4a' };
  'audio.waveform': { points?: number };
  'audio.remux': { sourceDurationSeconds?: number };
  'audio.concat': { subtitles?: { inputIndex: number; cues: SubtitleCue[] }[] };
  'media.export': { format: 'mp4' | 'webm' | 'gif' | 'mp3'; height?: number; fps?: number };
  'subtitle.burn': { cues: SubtitleCue[]; style?: SubtitleStyle };
  'composition.render': {
    resolution: '720p' | '1080p' | '4k';
    fps?: number;
    durationSeconds: number;
    tracks: TimelineTrack[];
    items: TimelineItem[];
  };
  'video.mix': {
    clips: { inputIndex: number; startSeconds: number; durationSeconds: number }[];
    seed: number;
    bgmInputIndex?: number;
    bgmVolume?: number;
  };
  'video.narration_render': {
    videoInputIndex: number;
    narrationInputIndex: number;
    bgmInputIndex?: number;
    bgmVolume?: number;
    cues?: SubtitleCue[];
    style?: SubtitleStyle;
  };
}
export type MediaOperation = keyof MediaParameters;
export const MEDIA_OPERATIONS: readonly MediaOperation[] = [
  'composition.render',
  'video.derivatives',
  'video.trim',
  'video.mix',
  'video.narration_render',
  'media.export',
  'subtitle.burn',
  'video.reference_prepare',
  'frames.extract',
  'scenes.detect',
  'video.split',
  'media.probe',
  'audio.extract',
  'audio.waveform',
  'audio.remux',
  'audio.concat',
];
/** Operations implemented by the base media runtime. */
export const MEDIA_CORE_OPERATIONS: readonly MediaOperation[] = [
  'media.probe',
  'video.reference_prepare',
  'video.trim',
  'frames.extract',
  'scenes.detect',
  'video.split',
  'media.export',
  'audio.extract',
  'audio.waveform',
  'audio.remux',
  'audio.concat',
];
/** Keep admission and Worker capability checks aligned during the incremental rollout. */
export const MEDIA_AVAILABLE_OPERATIONS: readonly MediaOperation[] = [
  ...MEDIA_CORE_OPERATIONS,
  'video.derivatives',
  'composition.render',
  'video.mix',
  'video.narration_render',
  'subtitle.burn',
];
export type MediaRequest = {
  [O in MediaOperation]: {
    requestId: string;
    operation: O;
    inputs: { assetId: string }[];
    parameters: MediaParameters[O];
  };
}[MediaOperation];
export interface MediaInputSnapshot {
  assetId: string;
  key: string;
  sizeBytes: number;
  etag: string;
}
export type MediaCommand = {
  [O in MediaOperation]: {
    version: typeof MEDIA_VERSION;
    type: 'media.request';
    messageId: string;
    jobId: string;
    attemptId: string;
    attempt: 1 | 2 | 3;
    profile: typeof MEDIA_PROFILE;
    operation: O;
    inputs: MediaInputSnapshot[];
    parameters: MediaParameters[O];
  };
}[MediaOperation];
export interface MediaControl {
  version: typeof MEDIA_VERSION;
  type: 'media.control';
  messageId: string;
  jobId: string;
  attemptId: string;
  action: 'cancel' | 'recover';
}
export interface MediaObject {
  key: string;
  sizeBytes: number;
  etag: string;
  sha256: string;
}
export interface MediaFile extends MediaObject {
  name: string;
  role: 'primary' | 'preview' | 'poster' | 'hls' | 'frame' | 'segment' | 'audio' | 'data';
  contentType: string;
}
export interface MediaProbe {
  durationSeconds: number;
  format: string;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
  rotation: number;
  sampleAspectRatio: string;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  fps: number | null;
}
export interface MediaData {
  probe?: MediaProbe;
  scenes?: number[];
  waveform?: number[];
  compressed?: boolean;
  trimmed?: boolean;
  subtitles?: SubtitleCue[];
}
export interface MediaManifest {
  version: typeof MEDIA_VERSION;
  jobId: string;
  attemptId: string;
  profile: typeof MEDIA_PROFILE;
  operation: MediaOperation;
  files: MediaFile[];
  data: MediaData;
}
export type MediaFailureCode =
  | 'INPUT_INVALID'
  | 'INPUT_CHANGED'
  | 'INPUT_TOO_LARGE'
  | 'INPUT_TOO_LONG'
  | 'OUTPUT_INVALID'
  | 'CAPABILITY_UNAVAILABLE'
  | 'EXECUTION_FAILED'
  | 'EXECUTION_TIMEOUT'
  | 'STORAGE_FAILURE'
  | 'WORKER_INTERRUPTED'
  | 'DISK_FULL';
export type MediaUnknownCode = 'PROCESS_UNKNOWN' | 'UPLOAD_UNKNOWN' | 'OUTPUT_MISMATCH';
export type MediaResult = {
  version: typeof MEDIA_VERSION;
  type: 'media.result';
  messageId: string;
  commandId: string;
  jobId: string;
  attemptId: string;
  attempt: 1 | 2 | 3;
} & (
  | { state: 'running'; stage: string; progress: number }
  | { state: 'succeeded'; manifest: MediaObject }
  | { state: 'failed'; errorCode: MediaFailureCode }
  | { state: 'reconciling'; errorCode: MediaUnknownCode }
  | { state: 'cancelled' }
);

export function mediaResourceClass(operation: MediaOperation): 'encode' | 'probe' {
  return operation === 'media.probe' ||
    operation === 'scenes.detect' ||
    operation === 'audio.waveform'
    ? 'probe'
    : 'encode';
}
export function mediaObjectPrefix(jobId: string, attemptId: string): string {
  return `mio/media/${jobId}/${attemptId}/`;
}
