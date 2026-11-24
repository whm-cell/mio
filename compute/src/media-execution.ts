import type { MediaCommand, MediaData, MediaFile } from '@mio/compute-contracts';

/** Names are relative to the attempt directory; only the file adapter resolves them. */
export interface LocalMediaFile {
  name: string;
  role: MediaFile['role'];
  contentType: string;
}
export interface MediaStep {
  id: string;
  tool: 'ffmpeg' | 'ffprobe';
  args: string[];
  /** Expected output duration for this step's streamed progress, in seconds. */
  durationSeconds?: number;
  outputs?: LocalMediaFile[];
  /** A bounded output is allowed for probe JSON and scene metadata only. */
  capture?: 'json' | 'lines';
  /** Specialized bounded stream for FFmpeg's fixed-frame audio statistics. */
  waveform?: { points: number; samples: number; frameSamples: number };
  /** Stream video packet times. Use the probed frame interval for missing packet durations. */
  packetEnd?: { frameSeconds: number };
}
export interface MediaProcessResult {
  stdout: string;
  diagnostic: string;
  waveform?: number[];
  packetEndSeconds?: number;
}
export interface MediaExecutionContext {
  /** Adapter replaces each @file:<name> argument (and filter path) with a trusted path. */
  run(step: MediaStep): Promise<MediaProcessResult>;
}
export interface MediaExecutionResult {
  files: LocalMediaFile[];
  data: MediaData;
}
export type MediaExecutor = (
  command: MediaCommand,
  context: MediaExecutionContext,
) => Promise<MediaExecutionResult>;
