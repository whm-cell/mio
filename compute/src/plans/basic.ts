import type { MediaCommand, MediaProbe } from '@mio/compute-contracts';
import type {
  LocalMediaFile,
  MediaExecutionContext,
  MediaExecutionResult,
} from '../media-execution.ts';
import { concatAudio, extractAudio, remuxAudio, waveform } from './audio.ts';
import { exportMedia } from './export.ts';
import { detectScenes, extractFrames } from './frames.ts';
import { mediaError, probeInput } from './probe.ts';

async function reference(
  probe: MediaProbe,
  context: MediaExecutionContext,
): Promise<MediaExecutionResult> {
  if (!probe.hasVideo || probe.durationSeconds <= 0) throw mediaError('INPUT_INVALID');
  const compressed =
    Math.max(probe.width!, probe.height!) > 1920 || Math.min(probe.width!, probe.height!) > 1080;
  const trimmed = probe.durationSeconds > 15;
  // The legacy preparation path keeps a suitable source unchanged. An empty
  // output set tells the caller to use the already registered input asset.
  if (!compressed && !trimmed) return { files: [], data: { compressed: false, trimmed: false } };
  const file: LocalMediaFile = { name: 'reference.mp4', role: 'primary', contentType: 'video/mp4' };
  const landscape = probe.width! >= probe.height!;
  const width = landscape ? 1920 : 1080,
    height = landscape ? 1080 : 1920;
  const filter = `scale=trunc(iw*sar/2)*2:ih,setsar=1,scale=w='min(iw,${width})':h='min(ih,${height})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  await context.run({
    id: 'reference-prepare',
    tool: 'ffmpeg',
    durationSeconds: Math.min(probe.durationSeconds, 15),
    outputs: [file],
    args: [
      '-v',
      'error',
      '-i',
      '@file:input-0',
      '-map',
      '0:V:0',
      '-map',
      '0:a:0?',
      '-t',
      String(Math.min(probe.durationSeconds, 15)),
      '-vf',
      filter,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'fast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      `@file:${file.name}`,
    ],
  });
  return { files: [file], data: { compressed, trimmed } };
}

async function splitVideo(
  boundaries: number[],
  probe: MediaProbe,
  context: MediaExecutionContext,
): Promise<MediaExecutionResult> {
  if (!probe.hasVideo || boundaries.some((t) => t >= probe.durationSeconds))
    throw mediaError('INPUT_INVALID');
  const points = [0, ...boundaries, probe.durationSeconds],
    files: LocalMediaFile[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const file: LocalMediaFile = {
      name: `segment-${i}.mp4`,
      role: 'segment',
      contentType: 'video/mp4',
    };
    // Input-side seeking with stream copy preserves keyframe-aligned copy semantics.
    await context.run({
      id: `split-video-${i}`,
      tool: 'ffmpeg',
      durationSeconds: points[i + 1]! - points[i]!,
      outputs: [file],
      args: [
        '-v',
        'error',
        '-ss',
        String(points[i]),
        '-i',
        '@file:input-0',
        '-t',
        String(points[i + 1]! - points[i]!),
        '-map',
        '0:V:0',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-avoid_negative_ts',
        'make_zero',
        `@file:${file.name}`,
      ],
    });
    files.push(file);
  }
  return { files, data: {} };
}

export async function executeBasic(
  command: MediaCommand,
  context: MediaExecutionContext,
): Promise<MediaExecutionResult> {
  if (command.operation === 'audio.concat') return concatAudio(command, context);
  if (
    command.operation === 'frames.extract' &&
    command.parameters.mode === 'timestamps' &&
    command.parameters.timestamps!.length > (command.parameters.maxFrames ?? 256)
  )
    throw mediaError('INPUT_INVALID');
  const probe = await probeInput(0, context);
  switch (command.operation) {
    case 'media.probe':
      return { files: [], data: { probe } };
    case 'video.reference_prepare':
      return reference(probe, context);
    case 'frames.extract':
      return extractFrames(command.parameters, probe, context);
    case 'scenes.detect':
      return {
        files: [],
        data: { scenes: await detectScenes(command.parameters, probe, context) },
      };
    case 'video.split':
      return splitVideo(command.parameters.boundaries, probe, context);
    case 'audio.extract':
      return extractAudio(command.parameters, probe, context);
    case 'audio.waveform':
      return waveform(command.parameters, probe, context);
    case 'audio.remux':
      return remuxAudio(command.parameters, probe, context);
    case 'media.export':
      return exportMedia(command.parameters, probe, context);
    default:
      throw mediaError('CAPABILITY_UNAVAILABLE');
  }
}
