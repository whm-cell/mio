import { HttpError } from '@mio/foundation/errors';
import type { AccountCredentialSnapshot } from '../providers/contracts.ts';

export class AudioError extends HttpError {}
export type AudioOperation = 'tts' | 'clone';
export type AudioFormat = 'mp3' | 'wav' | 'flac';
export interface AudioParameters {
  speed: number;
  volume: number;
  pitch: number;
  format: AudioFormat;
}
export interface AudioRange {
  min: number;
  max: number;
  default: number;
}
export interface AudioCapabilities {
  speed: AudioRange;
  volume: AudioRange;
  pitch: AudioRange;
  formats: AudioFormat[];
  defaultFormat: AudioFormat;
  textMaxCodePoints: number;
  textMaxBytes: number;
  sampleMaxBytes: number;
  sampleMinSeconds: number;
  sampleMaxSeconds: number;
}
export interface AudioAdmission extends AccountCredentialSnapshot {
  modelRef: string;
  modelId: string;
  /** Older persisted admissions have the same canonical modelRef without these fields. */
  modelKey?: string;
  profile?: 'minimax-tts' | 'minimax-clone';
  catalogVersion: number;
  adaptationVersion: number;
  operation: AudioOperation;
  submitPath: string;
  capabilities: AudioCapabilities;
}
export interface AudioContext {
  modelRef?: string;
  voiceRef?: string;
  parameters?: Partial<AudioParameters>;
  sample?: { assetId: string; authorized: true; name: string; auditionText: string };
}
export type AudioJobStatus =
  'queued' | 'submitted' | 'unknown' | 'materializing' | 'ready' | 'failed' | 'cancelled';
export interface AudioJobView {
  jobId: string;
  kind: AudioOperation;
  status: AudioJobStatus;
  errorCode: string | null;
  recordId: string | null;
  voiceRef: string | null;
  text: string;
  parameters: AudioParameters | null;
  recoverable: boolean;
  upstreamConfirmed?: boolean;
  cancelRequested: boolean;
  assetIds: string[];
  outputs: { index: number; assetId: string; durationMs: number; format: string }[];
}
export const AUDIO_TEXT_POINTS = 10000;
export const AUDIO_TEXT_BYTES = 80 * 1024;
export const AUDIO_OUTPUT_BYTES = 100 * 1024 * 1024;
export const AUDIO_SAMPLE_BYTES = 20 * 1024 * 1024;
export function audioText(
  value: unknown,
  maxPoints = AUDIO_TEXT_POINTS,
  maxBytes = AUDIO_TEXT_BYTES,
): string {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    !value.trim() ||
    Array.from(value).length > maxPoints ||
    Buffer.byteLength(value) > maxBytes ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    throw new AudioError(400, 'AUDIO_TEXT_INVALID');
  return value;
}
export function audioParameters(value: unknown, capabilities: AudioCapabilities): AudioParameters {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['speed', 'volume', 'pitch', 'format'].includes(key))
  )
    throw new AudioError(400, 'AUDIO_PARAMETERS_INVALID');
  const raw = value as Record<string, unknown>;
  const result = {} as AudioParameters;
  for (const key of ['speed', 'volume', 'pitch'] as const) {
    const range = capabilities[key],
      entry = raw[key] ?? range.default;
    if (
      typeof entry !== 'number' ||
      !Number.isFinite(entry) ||
      entry < range.min ||
      entry > range.max ||
      (key === 'pitch' && !Number.isInteger(entry))
    )
      throw new AudioError(400, 'AUDIO_PARAMETERS_INVALID');
    result[key] = entry;
  }
  const format = raw.format ?? capabilities.defaultFormat;
  if (!capabilities.formats.includes(format as AudioFormat))
    throw new AudioError(400, 'AUDIO_FORMAT_INVALID');
  result.format = format as AudioFormat;
  return result;
}
