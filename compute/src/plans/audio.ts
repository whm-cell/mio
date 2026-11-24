import type {
  MediaCommand,
  MediaParameters,
  MediaProbe,
  SubtitleCue,
} from '@mio/compute-contracts';
import type {
  LocalMediaFile,
  MediaExecutionContext,
  MediaExecutionResult,
} from '../media-execution.ts';
import { mediaError, primaryVideoEnd, probeFile, probeInput } from './probe.ts';

export async function extractAudio(
  parameters: MediaParameters['audio.extract'],
  probe: MediaProbe,
  context: MediaExecutionContext,
): Promise<MediaExecutionResult> {
  if (!probe.hasAudio) throw mediaError('INPUT_INVALID');
  const format = parameters.profile === 'asr' ? 'wav' : (parameters.format ?? 'wav');
  const file: LocalMediaFile = {
    name: `audio.${format}`,
    role: 'audio',
    contentType: { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4' }[format],
  };
  const args = ['-v', 'error', '-i', '@file:input-0', '-map', '0:a:0', '-vn'];
  if (parameters.profile === 'asr') args.push('-ac', '1', '-ar', '16000');
  args.push(
    '-c:a',
    { wav: 'pcm_s16le', mp3: 'libmp3lame', m4a: 'aac' }[format],
    `@file:${file.name}`,
  );
  await context.run({
    id: 'extract-audio',
    tool: 'ffmpeg',
    ...(probe.durationSeconds > 0 ? { durationSeconds: probe.durationSeconds } : {}),
    args,
    outputs: [file],
  });
  return { files: [file], data: {} };
}

export async function waveform(
  parameters: MediaParameters['audio.waveform'],
  probe: MediaProbe,
  context: MediaExecutionContext,
): Promise<MediaExecutionResult> {
  if (!probe.hasAudio || probe.durationSeconds <= 0) throw mediaError('INPUT_INVALID');
  const points = parameters.points ?? 1024;
  if (!Number.isInteger(points) || points < 1 || points > 4096) throw mediaError('INPUT_INVALID');
  const rate = probe.sampleRate;
  if (!rate || !Number.isSafeInteger(rate) || rate < 1 || rate > 384_000)
    throw mediaError('INPUT_INVALID');
  const samples = Math.ceil(probe.durationSeconds * rate);
  const frameSamples = Math.min(1024, Math.max(1, Math.floor(samples / points)));
  // FFmpeg reduces original-rate audio into <=1024-sample RMS measurements.
  // The process adapter merges frames into the requested buckets as metadata arrives.
  const result = await context.run({
    id: 'waveform-pcm',
    tool: 'ffmpeg',
    durationSeconds: probe.durationSeconds,
    waveform: { points, samples, frameSamples },
    args: [
      '-v',
      'error',
      '-i',
      '@file:input-0',
      '-map',
      '0:a:0',
      '-vn',
      '-af',
      `atrim=end_sample=${samples},asetnsamples=n=${frameSamples}:p=0,ametadata=mode=delete,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level+Number_of_samples,ametadata=mode=print:file=-:direct=1`,
      '-f',
      'null',
      '-',
    ],
  });
  if (!result.waveform) throw mediaError('OUTPUT_INVALID');
  return { files: [], data: { waveform: result.waveform } };
}

export async function remuxAudio(
  parameters: MediaParameters['audio.remux'],
  video: MediaProbe,
  context: MediaExecutionContext,
): Promise<MediaExecutionResult> {
  const audio = await probeInput(1, context);
  if (!video.hasVideo || !audio.hasAudio || video.durationSeconds <= 0)
    throw mediaError('INPUT_INVALID');
  const videoEnd = await primaryVideoEnd(video, context);
  if (!videoEnd) throw mediaError('INPUT_INVALID');
  const duration = parameters.sourceDurationSeconds ?? videoEnd;
  if (duration > videoEnd + 0.000001) throw mediaError('INPUT_INVALID');
  const file: LocalMediaFile = { name: 'remux.mp4', role: 'primary', contentType: 'video/mp4' };
  // Keep the source video duration; short audio ends naturally and long audio is cut.
  await context.run({
    id: 'remux-audio',
    tool: 'ffmpeg',
    durationSeconds: duration,
    outputs: [file],
    args: [
      '-v',
      'error',
      '-i',
      '@file:input-0',
      '-i',
      '@file:input-1',
      '-map',
      '0:V:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-t',
      String(duration),
      '-movflags',
      '+faststart',
      `@file:${file.name}`,
    ],
  });
  return { files: [file], data: {} };
}

export async function concatAudio(
  command: Extract<MediaCommand, { operation: 'audio.concat' }>,
  context: MediaExecutionContext,
): Promise<MediaExecutionResult> {
  const normalized: LocalMediaFile[] = [],
    durations: number[] = [];
  let total = 0;
  const probes: MediaProbe[] = [];
  for (let i = 0; i < command.inputs.length; i++) {
    const probe = await probeInput(i, context);
    if (!probe.hasAudio || probe.durationSeconds <= 0) throw mediaError('INPUT_INVALID');
    probes.push(probe);
  }
  if (probes.reduce((sum, p) => sum + p.durationSeconds, 0) > 3600)
    throw mediaError('INPUT_TOO_LONG');
  for (let i = 0; i < probes.length; i++) {
    const file: LocalMediaFile = {
      name: `concat-${i}.wav`,
      role: 'data',
      contentType: 'audio/wav',
    };
    await context.run({
      id: `normalize-audio-${i}`,
      tool: 'ffmpeg',
      durationSeconds: probes[i]!.durationSeconds,
      outputs: [file],
      args: [
        '-v',
        'error',
        '-i',
        `@file:input-${i}`,
        '-map',
        '0:a:0',
        '-vn',
        '-ac',
        '2',
        '-ar',
        '48000',
        '-c:a',
        'pcm_s16le',
        `@file:${file.name}`,
      ],
    });
    const actual = await probeFile(file.name, `probe-concat-${i}`, context);
    durations.push(actual.durationSeconds);
    total += actual.durationSeconds;
    if (total > 3600) throw mediaError('INPUT_TOO_LONG');
    normalized.push(file);
  }
  const subtitles: SubtitleCue[] = [];
  let offset = 0;
  for (let i = 0; i < durations.length; i++) {
    for (const cue of command.parameters.subtitles?.find((s) => s.inputIndex === i)?.cues ?? []) {
      if (
        cue.startSeconds < 0 ||
        cue.endSeconds > durations[i]! + 0.000001 ||
        cue.endSeconds <= cue.startSeconds
      )
        throw mediaError('INPUT_INVALID');
      subtitles.push({
        ...cue,
        startSeconds: cue.startSeconds + offset,
        endSeconds: cue.endSeconds + offset,
      });
    }
    offset += durations[i]!;
  }
  if (subtitles.length > 4096) throw mediaError('INPUT_INVALID');
  const file: LocalMediaFile = { name: 'concat.wav', role: 'audio', contentType: 'audio/wav' };
  const args = [
    '-v',
    'error',
    ...normalized.flatMap((f) => ['-i', `@file:${f.name}`]),
    '-filter_complex',
    normalized.map((_, i) => `[${i}:a:0]asetpts=PTS-STARTPTS[a${i}]`).join(';') +
      ';' +
      normalized.map((_, i) => `[a${i}]`).join('') +
      `concat=n=${normalized.length}:v=0:a=1[out]`,
    '-map',
    '[out]',
    '-c:a',
    'pcm_s16le',
    `@file:${file.name}`,
  ];
  await context.run({
    id: 'concat-audio',
    tool: 'ffmpeg',
    durationSeconds: total,
    outputs: [file],
    args,
  });
  return { files: [file], data: { subtitles } };
}
