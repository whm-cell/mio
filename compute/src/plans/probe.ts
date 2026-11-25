import type { MediaFailureCode, MediaProbe } from '@mio/compute-contracts';
import type { MediaExecutionContext } from '../media-execution.ts';
import { probeRatio, videoDisplayGeometry } from '../video-display.ts';
import type { VideoDisplayStream } from '../video-display.ts';

export function mediaError(code: MediaFailureCode): Error {
  return Object.assign(new Error(code), { code });
}

interface ProbeStream extends VideoDisplayStream {
  codec_type?: string;
  codec_name?: string;
  duration?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
}

/** Shared by output verification; only the adapter can resolve the local name. */
export async function probeFile(
  name: string,
  id: string,
  context: MediaExecutionContext,
): Promise<MediaProbe> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw mediaError('INPUT_INVALID');
  let stdout: string;
  try {
    ({ stdout } = await context.run({
      id,
      tool: 'ffprobe',
      capture: 'json',
      args: [
        '-v',
        'error',
        '-show_entries',
        'format=duration,format_name:stream=codec_type,codec_name,duration,width,height,sample_aspect_ratio,avg_frame_rate,sample_rate,channels:stream_tags=rotate:stream_side_data=rotation:stream_disposition=attached_pic',
        '-of',
        'json',
        `@file:${name}`,
      ],
    }));
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'EXECUTION_FAILED' ||
        ('code' in error && error.code === 'EXECUTION_FAILED'))
    )
      throw mediaError('INPUT_INVALID');
    throw error;
  }
  let parsed: { streams?: ProbeStream[]; format?: { duration?: string; format_name?: string } };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw mediaError('INPUT_INVALID');
  }
  if (!parsed || !Array.isArray(parsed.streams)) throw mediaError('INPUT_INVALID');
  const video = parsed.streams.find(
    (s) => s.codec_type === 'video' && !s.disposition?.attached_pic,
  );
  const audio = parsed.streams.find((s) => s.codec_type === 'audio');
  if (!video && !audio) throw mediaError('INPUT_INVALID');
  const durations = [parsed.format?.duration, video?.duration, audio?.duration]
    .filter((v) => v !== undefined && v !== 'N/A')
    .map(Number);
  if (durations.some((v) => !Number.isFinite(v) || v < 0)) throw mediaError('INPUT_INVALID');
  const durationSeconds = Math.max(0, ...durations);
  if (durationSeconds > 3600) throw mediaError('INPUT_TOO_LONG');
  if (!durationSeconds && !video) throw mediaError('INPUT_INVALID');
  const display = video ? videoDisplayGeometry(video) : null;
  if (video && !display) throw mediaError('INPUT_INVALID');
  return {
    durationSeconds,
    format: parsed.format?.format_name ?? 'unknown',
    hasVideo: !!video,
    hasAudio: !!audio,
    width: display?.width ?? null,
    height: display?.height ?? null,
    rotation: display?.rotation ?? 0,
    sampleAspectRatio: display?.sampleAspectRatio ?? '1:1',
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    sampleRate: audio && Number(audio.sample_rate) > 0 ? Number(audio.sample_rate) : null,
    channels: audio?.channels ?? null,
    fps: probeRatio(video?.avg_frame_rate, '/'),
  };
}

export async function probeInput(
  index: number,
  context: MediaExecutionContext,
): Promise<MediaProbe> {
  if (!Number.isInteger(index) || index < 0 || index > 63) throw mediaError('INPUT_INVALID');
  return probeFile(`input-${index}`, `probe-input-${index}`, context);
}

export interface MediaStreamRange {
  start: number;
  end: number;
}

/** Report the selected stream bounds relative to the container timeline. */
export async function primaryStreamRange(
  probe: MediaProbe,
  context: MediaExecutionContext,
  inputIndex: number,
  stream: 'V' | 'a',
): Promise<MediaStreamRange | null> {
  const kind = stream === 'V' ? 'video' : 'audio';
  const suffix = inputIndex === 0 ? '' : `-${inputIndex}`;
  const input = `@file:input-${inputIndex}`;
  const selection = `${stream}:0`;
  const source = await context.run({
    id: `probe-${kind}-timing${suffix}`,
    tool: 'ffprobe',
    capture: 'json',
    args: [
      '-v',
      'error',
      '-select_streams',
      selection,
      '-show_entries',
      'format=start_time:stream=start_time,duration',
      '-of',
      'json',
      input,
    ],
  });
  const timing = JSON.parse(source.stdout) as {
    format?: { start_time?: string };
    streams?: { start_time?: string; duration?: string }[];
  };
  const overallStart = Number(timing.format?.start_time);
  const formatStart = Number.isFinite(overallStart) ? overallStart : 0;
  const selected = timing.streams?.[0];
  const duration = Number(selected?.duration);
  const start = Number(selected?.start_time) - formatStart;
  if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0) {
    const end = start + duration;
    if (end > 0 && end <= probe.durationSeconds + 0.35) return { start: Math.max(0, start), end };
  }
  // Some containers omit stream duration. Scan only the selected stream's timestamps.
  const { packetStartSeconds, packetEndSeconds } = await context.run({
    id: `probe-${kind}-packet-end${suffix}`,
    tool: 'ffprobe',
    packetEnd: { frameSeconds: stream === 'V' && probe.fps ? 1 / probe.fps : 0 },
    args: [
      '-v',
      'error',
      '-select_streams',
      selection,
      '-show_entries',
      'packet=pts_time,duration_time',
      '-of',
      'csv=p=0',
      input,
    ],
  });
  const end = packetEndSeconds === undefined ? 0 : packetEndSeconds - formatStart;
  // Pre-existing M2 checkpoints recorded the packet end only.
  const first = packetStartSeconds === undefined ? start : packetStartSeconds - formatStart;
  const relativeStart = Number.isFinite(first) ? Math.max(0, first) : 0;
  if (end > relativeStart && end <= probe.durationSeconds + 0.35)
    return { start: relativeStart, end };
  return null;
}

export async function primaryVideoEnd(probe: MediaProbe, context: MediaExecutionContext) {
  return (await primaryStreamRange(probe, context, 0, 'V'))?.end ?? null;
}
