import type { MediaCommand } from '@mio/compute-contracts';
import type {
  LocalMediaFile,
  MediaExecutionContext,
  MediaExecutionResult,
} from '../media-execution.ts';
import { mediaError, probeInput } from './probe.ts';

export async function executeTrim(
  command: Extract<MediaCommand, { operation: 'video.trim' }>,
  ctx: MediaExecutionContext,
): Promise<MediaExecutionResult> {
  const { startSeconds: start, endSeconds: end } = command.parameters;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start)
    throw mediaError('INPUT_INVALID');
  if (end - start > 600) throw mediaError('INPUT_TOO_LONG');
  const source = await probeInput(0, ctx);
  if (
    !source.hasVideo ||
    !source.width ||
    !source.height ||
    !Number.isFinite(source.durationSeconds) ||
    source.durationSeconds <= 0 ||
    start >= source.durationSeconds ||
    end > source.durationSeconds + 0.35
  )
    throw mediaError('INPUT_INVALID');
  const duration = Math.min(end, source.durationSeconds) - start;
  // The public probe reports audio presence only; count the mapped tracks so a
  // successful encode cannot silently drop one of several source audio streams.
  const tracks = await ctx.run({
    id: 'trim-source-tracks',
    tool: 'ffprobe',
    capture: 'json',
    args: [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=index',
      '-of',
      'json',
      '@file:input-0',
    ],
  });
  let audioCount: number;
  try {
    const parsed = JSON.parse(tracks.stdout) as { streams: { index: number }[] };
    if (!Array.isArray(parsed.streams) || parsed.streams.length > 0 !== source.hasAudio)
      throw new Error();
    audioCount = parsed.streams.length;
  } catch {
    throw mediaError('INPUT_INVALID');
  }
  // Shared probe dimensions describe the display after rotation and SAR.
  const width = Math.floor(source.width / 2) * 2,
    height = Math.floor(source.height / 2) * 2;
  if (width < 2 || height < 2) throw mediaError('INPUT_INVALID');
  const output: LocalMediaFile = { name: 'trim.mp4', role: 'primary', contentType: 'video/mp4' };
  // Decode through the requested point, so a non-keyframe start is an accurate
  // cut. Re-encode audio to AAC because packet copying cannot guarantee that cut.
  await ctx.run({
    id: 'trim-encode',
    tool: 'ffmpeg',
    durationSeconds: duration,
    outputs: [output],
    args: [
      '-v',
      'error',
      '-xerror',
      '-i',
      '@file:input-0',
      '-ss',
      String(start),
      '-t',
      String(duration),
      '-map',
      '0:V:0',
      '-map',
      '0:a?',
      '-vf',
      `scale=${width}:${height},setsar=1`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-map_metadata',
      '-1',
      '-metadata:s:v:0',
      'rotate=0',
      '-movflags',
      '+faststart',
      '@file:trim.mp4',
    ],
  });
  const check = await ctx.run({
    id: 'trim-verify',
    tool: 'ffprobe',
    capture: 'json',
    outputs: [output],
    args: [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height,start_time,duration,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation',
      '-of',
      'json',
      '@file:trim.mp4',
    ],
  });
  try {
    const actual = JSON.parse(check.stdout) as {
      format: { duration: string };
      streams: {
        codec_type: string;
        codec_name: string;
        width: number;
        height: number;
        start_time: string;
        duration: string;
        sample_aspect_ratio: string;
        tags?: { rotate?: string };
        side_data_list?: { rotation?: number }[];
      }[];
    };
    const video = actual.streams.find((s) => s.codec_type === 'video'),
      audio = actual.streams.filter((s) => s.codec_type === 'audio');
    const measured = Number(actual.format.duration);
    if (
      !video ||
      video.codec_name !== 'h264' ||
      video.width !== width ||
      video.height !== height ||
      video.sample_aspect_ratio !== '1:1' ||
      Number(video.tags?.rotate ?? 0) !== 0 ||
      video.side_data_list?.some((s) => Number(s.rotation ?? 0) !== 0) ||
      !Number.isFinite(measured) ||
      measured <= 0 ||
      Math.abs(measured - duration) > 0.35 ||
      !Number.isFinite(Number(video.start_time)) ||
      Math.abs(Number(video.start_time)) > 0.35 ||
      !Number.isFinite(Number(video.duration)) ||
      Number(video.duration) <= 0 ||
      Math.abs(Number(video.duration) - duration) > 0.35 ||
      audio.length !== audioCount ||
      audio.some(
        (stream) =>
          stream.codec_name !== 'aac' ||
          !Number.isFinite(Number(stream.duration)) ||
          Number(stream.duration) <= 0 ||
          Number(stream.duration) - duration > 0.35 ||
          !Number.isFinite(Number(stream.start_time)) ||
          Math.abs(Number(stream.start_time)) > 0.35,
      )
    )
      throw new Error();
  } catch {
    throw mediaError('OUTPUT_INVALID');
  }
  await ctx.run({
    id: 'trim-decode',
    tool: 'ffmpeg',
    durationSeconds: duration,
    outputs: [output],
    args: [
      '-v',
      'error',
      '-xerror',
      '-i',
      '@file:trim.mp4',
      '-map',
      '0:V:0',
      '-map',
      '0:a?',
      '-f',
      'null',
      '-',
    ],
  });
  return { files: [output], data: { trimmed: true } };
}
