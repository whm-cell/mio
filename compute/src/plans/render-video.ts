import type { MediaProbe } from '@mio/compute-contracts';
import type {
  LocalMediaFile,
  MediaExecutionContext,
  MediaFileExecutionContext,
} from '../media-execution.ts';
import { mediaError, probeFile } from './probe.ts';
import type { MediaStreamRange } from './probe.ts';

export function displaySize(probe: MediaProbe): { width: number; height: number } {
  if (!probe.hasVideo || !probe.width || !probe.height) throw mediaError('INPUT_INVALID');
  // M2 has already applied source rotation and pixel aspect ratio.
  return { width: probe.width, height: probe.height };
}

export function evenDimension(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export function frameNumber(seconds: number, fps: number): number {
  return Math.ceil(seconds * fps - 0.000001);
}

export function videoOutput(name: string): LocalMediaFile {
  return { name, role: 'primary', contentType: 'video/mp4' };
}

export const h264Video = ['-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p'] as const;

// Each independently encoded slice starts its decode and presentation clocks
// together so stream-copy concatenation can join different frame counts.
export const h264SliceVideo = [...h264Video, '-bf', '0'] as const;

export const mp4Output = [
  '-map_metadata',
  '-1',
  '-map_chapters',
  '-1',
  '-movflags',
  '+faststart',
] as const;

export function fitFullHd(probe: MediaProbe): string {
  const { width, height } = displaySize(probe);
  const ratio = Math.min(1920 / width, 1080 / height);
  return `scale=${evenDimension(width * ratio)}:${evenDimension(height * ratio)},setsar=1,pad=1920:1080:(ow-iw)/2:(oh-ih)/2`;
}

export function checkWindow(
  start: number,
  duration: number,
  range: MediaStreamRange | null,
): asserts range is MediaStreamRange {
  const end = start + duration;
  if (!range || start >= range.end || end <= range.start || end > range.end + 0.000002)
    throw mediaError('INPUT_INVALID');
}

export function audioTempo(speed: number): string {
  return speed > 2 ? `atempo=2,atempo=${speed / 2}` : `atempo=${speed}`;
}

export function bgmFilter(index: number, duration: number, volume: number): string {
  const fade = Math.min(3, duration);
  return `[${index}:a:0]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=N/SR/TB,volume=${volume},apad,atrim=duration=${duration.toFixed(6)},afade=t=out:st=${(duration - fade).toFixed(6)}:d=${fade.toFixed(6)}[bgm]`;
}

export interface VideoSlice {
  file: LocalMediaFile;
  frames: number;
}

export async function joinVideoSlices(
  prefix: 'composition' | 'mix',
  slices: VideoSlice[],
  fps: number,
  context: MediaFileExecutionContext,
): Promise<string> {
  if (slices.length === 1) return slices[0]!.file.name;
  const list = `${prefix}.ffconcat`;
  // Round absolute cuts to FFmpeg's microsecond clock so rounding cannot
  // accumulate over the independently encoded slices.
  let totalFrames = 0;
  let previousCut = 0;
  const entries = slices.map(({ file, frames }) => {
    totalFrames += frames;
    const cut = Math.round((totalFrames * 1_000_000) / fps);
    const seconds = ((cut - previousCut) / 1_000_000).toFixed(6);
    previousCut = cut;
    return `file '${file.name}'\nduration ${seconds}\n`;
  });
  await context.write(list, 'ffconcat version 1.0\n' + entries.join(''));
  const output = videoOutput(`${prefix}-base.mp4`);
  await context.run({
    id: `${prefix}-concat`,
    tool: 'ffmpeg',
    durationSeconds: totalFrames / fps,
    outputs: [output],
    args: [
      '-v',
      'error',
      '-xerror',
      '-f',
      'concat',
      '-safe',
      '1',
      '-i',
      `@file:${list}`,
      '-map',
      '0:V:0',
      '-c:v',
      'copy',
      ...mp4Output,
      `@file:${output.name}`,
    ],
  });
  return output.name;
}

export async function verifyRender(
  file: LocalMediaFile,
  expected: { width: number; height: number; duration: number; audio: boolean; tolerance: number },
  context: MediaExecutionContext,
): Promise<void> {
  let actual: MediaProbe;
  try {
    actual = await probeFile(file.name, 'probe-render-output', context);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'INPUT_INVALID')
      throw mediaError('OUTPUT_INVALID');
    throw error;
  }
  if (
    !actual.hasVideo ||
    actual.videoCodec !== 'h264' ||
    actual.hasAudio !== expected.audio ||
    (actual.hasAudio && actual.audioCodec !== 'aac') ||
    actual.width !== expected.width ||
    actual.height !== expected.height ||
    actual.sampleAspectRatio !== '1:1' ||
    actual.rotation !== 0 ||
    actual.durationSeconds <= 0 ||
    Math.abs(actual.durationSeconds - expected.duration) > expected.tolerance
  )
    throw mediaError('OUTPUT_INVALID');
}
