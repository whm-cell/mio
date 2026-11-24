import type { MediaFailureCode, MediaProbe } from '@mio/compute-contracts';
import type { MediaExecutionContext } from '../media-execution.ts';

export function mediaError(code: MediaFailureCode): Error {
  return Object.assign(new Error(code), { code });
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  duration?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
}
function ratio(value: string | undefined, separator: string): number | null {
  const [a, b] = (value ?? '').split(separator).map(Number);
  return a !== undefined && b !== undefined && a > 0 && b > 0 && Number.isFinite(a / b)
    ? a / b
    : null;
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
  const rawRotation =
    video?.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ??
    Number(video?.tags?.rotate ?? 0);
  if (!Number.isFinite(rawRotation)) throw mediaError('INPUT_INVALID');
  const rotation = ((rawRotation % 360) + 360) % 360;
  const sar = ratio(video?.sample_aspect_ratio, ':') ?? 1;
  let width: number | null = null,
    height: number | null = null;
  if (video) {
    if (
      !video.width ||
      !video.height ||
      !Number.isSafeInteger(video.width) ||
      !Number.isSafeInteger(video.height) ||
      video.width < 1 ||
      video.height < 1
    )
      throw mediaError('INPUT_INVALID');
    const radians = (rotation * Math.PI) / 180;
    width = Math.round(
      Math.abs(Math.cos(radians)) * video.width * sar + Math.abs(Math.sin(radians)) * video.height,
    );
    height = Math.round(
      Math.abs(Math.sin(radians)) * video.width * sar + Math.abs(Math.cos(radians)) * video.height,
    );
  }
  return {
    durationSeconds,
    format: parsed.format?.format_name ?? 'unknown',
    hasVideo: !!video,
    hasAudio: !!audio,
    width,
    height,
    rotation,
    sampleAspectRatio:
      video?.sample_aspect_ratio && ratio(video.sample_aspect_ratio, ':')
        ? video.sample_aspect_ratio
        : '1:1',
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    sampleRate: audio && Number(audio.sample_rate) > 0 ? Number(audio.sample_rate) : null,
    channels: audio?.channels ?? null,
    fps: ratio(video?.avg_frame_rate, '/'),
  };
}

export async function probeInput(
  index: number,
  context: MediaExecutionContext,
): Promise<MediaProbe> {
  if (!Number.isInteger(index) || index < 0 || index > 63) throw mediaError('INPUT_INVALID');
  return probeFile(`input-${index}`, `probe-input-${index}`, context);
}

/** The first actual video stream can end before the container's other streams. */
export async function primaryVideoEnd(probe: MediaProbe, context: MediaExecutionContext) {
  const source = await context.run({
    id: 'probe-video-timing',
    tool: 'ffprobe',
    capture: 'json',
    args: [
      '-v',
      'error',
      '-select_streams',
      'V:0',
      '-show_entries',
      'format=start_time:stream=start_time,duration',
      '-of',
      'json',
      '@file:input-0',
    ],
  });
  const timing = JSON.parse(source.stdout) as {
    format?: { start_time?: string };
    streams?: { start_time?: string; duration?: string }[];
  };
  const overallStart = Number(timing.format?.start_time);
  const formatStart = Number.isFinite(overallStart) ? overallStart : 0;
  const video = timing.streams?.[0];
  const duration = Number(video?.duration);
  const start = Number(video?.start_time);
  if (Number.isFinite(duration) && duration > 0) {
    const end = duration + (Number.isFinite(start) ? start - formatStart : 0);
    if (end > 0 && end <= probe.durationSeconds + 0.35) return end;
  }
  // Some containers omit stream duration. Scan only the video packet timestamps.
  const { packetEndSeconds } = await context.run({
    id: 'probe-video-packet-end',
    tool: 'ffprobe',
    packetEnd: { frameSeconds: probe.fps ? 1 / probe.fps : 0 },
    args: [
      '-v',
      'error',
      '-select_streams',
      'V:0',
      '-show_entries',
      'packet=pts_time,duration_time',
      '-of',
      'csv=p=0',
      '@file:input-0',
    ],
  });
  const end = packetEndSeconds === undefined ? 0 : packetEndSeconds - formatStart;
  return end > 0 && end <= probe.durationSeconds + 0.35 ? end : null;
}
