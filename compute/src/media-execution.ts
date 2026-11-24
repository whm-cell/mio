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
/** Resolve bounded, deterministic filenames from a completed tool output. */
export type DiscoverMediaOutputs = () => Promise<LocalMediaFile[]>;

export interface MediaExecutionContext {
  /** Adapter replaces each @file:<name> argument (and filter path) with a trusted path. */
  run(step: MediaStep, discoverOutputs?: DiscoverMediaOutputs): Promise<MediaProcessResult>;
}
export interface MediaFileExecutionContext extends MediaExecutionContext {
  read(name: string, maxBytes: number): Promise<Uint8Array>;
  write(name: string, value: string | Uint8Array): Promise<void>;
}
export interface MediaExecutionResult {
  files: LocalMediaFile[];
  data: MediaData;
}
export type MediaExecutor = (
  command: MediaCommand,
  context: MediaFileExecutionContext,
) => Promise<MediaExecutionResult>;
