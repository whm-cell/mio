import { MEDIA_MAX_FILES } from '@mio/compute-contracts';
import type { MediaCommand, MediaProbe } from '@mio/compute-contracts';
import type {
  LocalMediaFile,
  MediaExecutionResult,
  MediaFileExecutionContext,
} from '../media-execution.ts';
import { mediaError, primaryVideoEnd, probeInput } from './probe.ts';

const SEGMENT_SECONDS = 6;
const CANVAS_SECONDS = 720;
const CANVAS_SEGMENTS = 120;
const CANVAS_BYTES = 4 * 1024 * 1024;
const PLAYLIST_BYTES = 256 * 1024;
const TOLERANCE = 0.35;
const AUDIO_RATE = 128000;
const CANVAS_AUDIO_SAMPLE_RATE = 48000;
const AAC_FRAME_SAMPLES = 1024;
const CANVAS_AUDIO_PATTERN = 'canvas-audio-%03d.m4a';
const aacEncode = ['-c:a', 'aac', '-b:a', String(AUDIO_RATE), '-ac', '2'];

interface Size {
  width: number;
  height: number;
}
interface Source extends Size {
  duration: number;
  hasAudio: boolean;
}
interface Encoded extends Size {
  duration: number;
  bytes: number;
  videoStart: number;
  videoDuration: number;
  audio: { start: number; duration: number } | null;
}

const master: LocalMediaFile = {
  name: 'master.m3u8',
  role: 'hls',
  contentType: 'application/vnd.apple.mpegurl',
};
const playlist = (name: string): LocalMediaFile => ({ ...master, name });
const segment = (name: string): LocalMediaFile => ({
  name,
  role: 'segment',
  contentType: 'video/mp2t',
});
const masterHeader = '#EXTM3U\n#EXT-X-VERSION:3\n';

function invalid(): never {
  throw mediaError('OUTPUT_INVALID');
}

function fit(source: Size, edge: number, portrait: boolean): Size {
  const boundWidth = portrait ? edge : (edge * 16) / 9;
  const boundHeight = portrait ? (edge * 16) / 9 : edge;
  const scale = Math.min(1, boundWidth / source.width, boundHeight / source.height);
  // Prefer an exact display ratio with even coded dimensions when it fits.
  let divisor = source.width;
  let remainder = source.height;
  while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
  const multiple = Math.floor((divisor * scale) / 2) * 2;
  if (multiple >= 2)
    return {
      width: (source.width / divisor) * multiple,
      height: (source.height / divisor) * multiple,
    };
  const width = Math.floor((source.width * scale) / 2) * 2;
  const height = Math.floor((source.height * scale) / 2) * 2;
  if (width < 2 || height < 2) throw mediaError('INPUT_INVALID');
  return { width, height };
}

function encode(size: Size, rate: number): string[] {
  return [
    '-map',
    '0:V:0',
    '-vf',
    `scale=${size.width}:${size.height},setsar=1`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '24',
    '-maxrate',
    String(rate),
    '-bufsize',
    String(rate * 2),
    '-pix_fmt',
    'yuv420p',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-metadata:s:v:0',
    'rotate=0',
  ];
}

interface EncodedStream {
  codec_type: string;
  codec_name: string;
  width: number;
  height: number;
  start_time: string;
  duration: string;
  sample_aspect_ratio?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

async function inspect(
  ctx: MediaFileExecutionContext,
  file: LocalMediaFile,
  size: Size,
  requested: number,
  hasAudio: boolean,
): Promise<Encoded> {
  const { stdout } = await ctx.run({
    id: `verify-${file.name}`,
    tool: 'ffprobe',
    capture: 'json',
    args: [
      '-v',
      'error',
      '-show_entries',
      'format=format_name,duration,size:stream=codec_type,codec_name,width,height,start_time,duration,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation',
      '-of',
      'json',
      `@file:${file.name}`,
    ],
  });
  try {
    const { format, streams } = JSON.parse(stdout) as {
      format: { duration: string; size: string; format_name: string };
      streams: EncodedStream[];
    };
    const videos = streams.filter((stream) => stream.codec_type === 'video');
    const audios = streams.filter((stream) => stream.codec_type === 'audio');
    const video = videos[0];
    const audio = audios[0];
    const container = file.role === 'segment' ? 'mpegts' : 'mp4';
    if (
      !video ||
      videos.length !== 1 ||
      audios.length !== Number(hasAudio) ||
      video.codec_name !== 'h264' ||
      (audio && audio.codec_name !== 'aac') ||
      video.sample_aspect_ratio !== '1:1' ||
      Number(video.tags?.rotate ?? 0) !== 0 ||
      video.side_data_list?.some((item) => Number(item.rotation ?? 0) !== 0) ||
      !format.format_name.split(',').includes(container)
    )
      invalid();
    const actual: Encoded = {
      width: video.width,
      height: video.height,
      duration: Number(format.duration),
      bytes: Number(format.size),
      videoStart: Number(video.start_time),
      videoDuration: Number(video.duration),
      audio: audio ? { start: Number(audio.start_time), duration: Number(audio.duration) } : null,
    };
    if (
      actual.width !== size.width ||
      actual.height !== size.height ||
      !Number.isSafeInteger(actual.bytes) ||
      actual.bytes <= 0 ||
      !closeDuration(actual.duration, requested) ||
      !closeDuration(actual.videoDuration, requested) ||
      !Number.isFinite(actual.videoStart) ||
      (actual.audio &&
        (!Number.isFinite(actual.audio.start) ||
          !Number.isFinite(actual.audio.duration) ||
          actual.audio.duration <= 0 ||
          actual.audio.duration > requested + TOLERANCE ||
          Math.abs(actual.videoStart - actual.audio.start) > TOLERANCE))
    )
      invalid();
    return actual;
  } catch {
    return invalid();
  }
}

function closeDuration(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && actual > 0 && Math.abs(actual - expected) <= TOLERANCE;
}

async function decode(ctx: MediaFileExecutionContext, file: LocalMediaFile, duration: number) {
  await ctx.run({
    id: `decode-${file.name}`,
    tool: 'ffmpeg',
    durationSeconds: duration,
    args: [
      '-v',
      'error',
      '-xerror',
      '-i',
      `@file:${file.name}`,
      '-map',
      '0:V:0',
      '-map',
      '0:a:0?',
      '-f',
      'null',
      '-',
    ],
  });
}

async function preview(
  ctx: MediaFileExecutionContext,
  source: Source,
  size: Size,
): Promise<LocalMediaFile[]> {
  const video: LocalMediaFile = { name: 'preview.mp4', role: 'preview', contentType: 'video/mp4' };
  await ctx.run({
    id: 'derivatives-preview',
    tool: 'ffmpeg',
    durationSeconds: source.duration,
    outputs: [video],
    args: [
      '-v',
      'error',
      '-xerror',
      '-i',
      '@file:input-0',
      '-t',
      String(source.duration),
      ...encode(size, 1800000),
      '-map',
      '0:a:0?',
      ...aacEncode,
      ...(source.hasAudio ? ['-af', 'apad'] : []),
      '-movflags',
      '+faststart',
      '@file:preview.mp4',
    ],
  });
  await inspect(ctx, video, size, source.duration, source.hasAudio);
  await decode(ctx, video, source.duration);
  const poster: LocalMediaFile = { name: 'poster.jpg', role: 'poster', contentType: 'image/jpeg' };
  await ctx.run({
    id: 'derivatives-poster',
    tool: 'ffmpeg',
    outputs: [poster],
    args: [
      '-v',
      'error',
      '-xerror',
      '-i',
      '@file:preview.mp4',
      '-map',
      '0:V:0',
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-update',
      '1',
      '@file:poster.jpg',
    ],
  });
  await decode(ctx, poster, 1);
  return [video, poster];
}

function entry(peak: number, size: Size, sub: LocalMediaFile): string {
  return `#EXT-X-STREAM-INF:BANDWIDTH=${peak},RESOLUTION=${size.width}x${size.height}\n${sub.name}\n`;
}
function peakBandwidth(peak: number, actual: Encoded): number {
  return Math.max(peak, Math.ceil(((actual.bytes * 8) / actual.duration) * 1.1));
}

async function readOrdinaryPlaylist(ctx: MediaFileExecutionContext, name: string) {
  const data = await ctx.read(name, PLAYLIST_BYTES);
  let lines: string[];
  try {
    lines = new TextDecoder('utf-8', { fatal: true }).decode(data).trimEnd().split(/\r?\n/);
  } catch {
    return invalid();
  }
  if (lines.shift() !== '#EXTM3U' || lines.pop() !== '#EXT-X-ENDLIST') invalid();
  let firstPiece = 0;
  let targetLine = -1;
  while (
    /^#EXT-X-(?:VERSION:[1-9][0-9]*|TARGETDURATION:[0-9]+|MEDIA-SEQUENCE:0|PLAYLIST-TYPE:VOD|INDEPENDENT-SEGMENTS)$/.test(
      lines[firstPiece] ?? '',
    )
  ) {
    if (lines[firstPiece]!.startsWith('#EXT-X-TARGETDURATION:')) {
      if (targetLine !== -1) invalid();
      targetLine = firstPiece;
    }
    firstPiece++;
  }
  const count = lines.length - firstPiece;
  if (targetLine < 0 || !count || count % 2 !== 0 || count / 2 > MEDIA_MAX_FILES - 4) invalid();
  const entries: { file: LocalMediaFile; duration: number }[] = [];
  let maxDuration = 0;
  for (let line = firstPiece; line < lines.length; line += 2) {
    const duration = Number(/^#EXTINF:([0-9]+(?:\.[0-9]+)?),$/.exec(lines[line]!)?.[1]);
    const name = `sub-ordinary${entries.length}.ts`;
    if (lines[line + 1] !== name || !Number.isFinite(duration) || duration <= 0) invalid();
    entries.push({ file: segment(name), duration });
    maxDuration = Math.max(maxDuration, duration);
  }
  // FFmpeg rounds a sub-half-second target to zero. Keep measured EXTINF and
  // emit an integer target that still covers the longest segment.
  lines[targetLine] = `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`;
  return { entries, text: ['#EXTM3U', ...lines, '#EXT-X-ENDLIST', ''].join('\n') };
}

async function ordinary(ctx: MediaFileExecutionContext, source: Source, size: Size) {
  const sub = playlist('sub-ordinary.m3u8');
  const packedName = 'sub-ordinary.ffmpeg';
  const rate = 1800000;
  // Freeze the canonical playlist and all its segments in the same step. A
  // retry needs only the committed inventory and skips the packager step.
  await ctx.run(
    {
      id: 'derivatives-hls-ordinary',
      tool: 'ffmpeg',
      durationSeconds: source.duration,
      args: [
        '-v',
        'error',
        '-xerror',
        '-i',
        '@file:input-0',
        '-t',
        String(source.duration),
        ...encode(size, rate),
        '-map',
        '0:a:0?',
        ...aacEncode,
        ...(source.hasAudio ? ['-af', 'apad'] : []),
        // Independent TS boundaries must retain their video PTS at low frame rates.
        '-bf',
        '0',
        '-force_key_frames',
        `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
        '-sc_threshold',
        '0',
        '-f',
        'hls',
        '-hls_time',
        String(SEGMENT_SECONDS),
        '-hls_playlist_type',
        'vod',
        '-hls_flags',
        'independent_segments',
        `@file:${packedName}`,
      ],
    },
    async () => {
      const { entries, text } = await readOrdinaryPlaylist(ctx, packedName);
      await ctx.write(sub.name, text);
      return [sub, ...entries.map(({ file }) => file)];
    },
  );
  const { entries: parts } = await readOrdinaryPlaylist(ctx, sub.name);
  let total = 0;
  let peak = rate + (source.hasAudio ? AUDIO_RATE : 0);
  let nextStart: number | undefined;
  for (const { file, duration } of parts) {
    const actual = await inspect(ctx, file, size, duration, source.hasAudio);
    if (nextStart !== undefined && Math.abs(actual.videoStart - nextStart) > TOLERANCE) invalid();
    await decode(ctx, file, duration);
    nextStart = actual.videoStart + duration;
    total += duration;
    peak = peakBandwidth(peak, actual);
  }
  if (!closeDuration(total, source.duration)) invalid();
  await ctx.write(master.name, masterHeader + entry(peak, size, sub));
  return [...parts.map(({ file }) => file), sub, master];
}

interface CanvasPlan {
  duration: number;
  count: number;
  audioSamples: number;
  audioFiles: LocalMediaFile[];
}

function canvasAudioStartSample(start: number): number {
  return Math.ceil((start * CANVAS_AUDIO_SAMPLE_RATE) / AAC_FRAME_SAMPLES) * AAC_FRAME_SAMPLES;
}

function planCanvas(source: Source): CanvasPlan {
  const duration = source.duration;
  let count = Math.ceil(duration / SEGMENT_SECONDS);
  const audioSamples = source.hasAudio
    ? Math.max(1, Math.round(duration * CANVAS_AUDIO_SAMPLE_RATE))
    : 0;
  // Compare absolute sample indices. If the next AAC packet would start at
  // or after EOF, the preceding packet owns the remaining video window.
  if (
    audioSamples &&
    count > 1 &&
    audioSamples <= canvasAudioStartSample((count - 1) * SEGMENT_SECONDS)
  )
    count--;
  const audioFiles = audioSamples
    ? Array.from({ length: count }, (_, index): LocalMediaFile => ({
        name: CANVAS_AUDIO_PATTERN.replace('%03d', String(index).padStart(3, '0')),
        role: 'audio',
        contentType: 'audio/mp4',
      }))
    : [];
  return { duration, count, audioSamples, audioFiles };
}

async function prepareCanvasAudio(ctx: MediaFileExecutionContext, plan: CanvasPlan): Promise<void> {
  const list: LocalMediaFile = {
    name: 'canvas-audio-list.txt',
    role: 'data',
    contentType: 'text/plain',
  };
  // Encode the whole audio track once. The segment muxer assigns intact AAC
  // packets to cuts, without discarding source samples around a video boundary.
  await ctx.run({
    id: 'derivatives-canvas-audio',
    tool: 'ffmpeg',
    durationSeconds: plan.duration,
    outputs: [...plan.audioFiles, list],
    args: [
      '-v',
      'error',
      '-xerror',
      '-i',
      '@file:input-0',
      '-map',
      '0:a:0',
      '-af',
      `aresample=${CANVAS_AUDIO_SAMPLE_RATE}:async=1:first_pts=0,apad,atrim=end_sample=${plan.audioSamples}`,
      ...aacEncode,
      '-ar',
      String(CANVAS_AUDIO_SAMPLE_RATE),
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-bsf:a',
      'noise=amount=0:drop=lt(pts\\,0)',
      '-f',
      'segment',
      '-segment_format',
      'mp4',
      '-reset_timestamps',
      '1',
      '-segment_time',
      String(SEGMENT_SECONDS),
      '-segment_list_type',
      'flat',
      '-segment_list',
      `@file:${list.name}`,
      // Fixed plan-owned pattern in the private step directory. Every concrete
      // output filename is checked and digested by the file adapter.
      CANVAS_AUDIO_PATTERN,
    ],
  });
  const inventory = new TextDecoder().decode(await ctx.read(list.name, 4096));
  if (inventory !== plan.audioFiles.map(({ name }) => name + '\n').join('')) invalid();
}

async function canvasRendition(
  ctx: MediaFileExecutionContext,
  plan: CanvasPlan,
  size: Size,
  edge: number,
) {
  const { count, duration: totalDuration, audioFiles } = plan;
  const hasAudio = audioFiles.length > 0;
  const pieces: { file: LocalMediaFile; actual: Encoded }[] = [];
  const rate = edge === 720 ? 2500000 : 1200000;
  let peak = rate + (hasAudio ? AUDIO_RATE : 0);
  for (let index = 0; index < count; index++) {
    const start = index * SEGMENT_SECONDS;
    const duration = index === count - 1 ? totalDuration - start : SEGMENT_SECONDS;
    const audio = audioFiles[index];
    const offset =
      (canvasAudioStartSample(start) - start * CANVAS_AUDIO_SAMPLE_RATE) / CANVAS_AUDIO_SAMPLE_RATE;
    const file = segment(`seg-${edge}-${String(index).padStart(3, '0')}.ts`);
    // FFmpeg can overshoot -fs by a packet. It can also stop early, so
    // require the measured duration and decode the entire bounded result.
    await ctx.run({
      id: `encode-${file.name}`,
      tool: 'ffmpeg',
      durationSeconds: duration,
      outputs: [file],
      args: [
        '-v',
        'error',
        '-xerror',
        '-ss',
        String(start),
        '-i',
        '@file:input-0',
        ...(audio ? ['-itsoffset', String(offset), '-i', `@file:${audio.name}`] : []),
        '-t',
        String(duration),
        ...encode(size, rate),
        ...(audio ? ['-map', '1:a:0', '-c:a', 'copy'] : []),
        '-bf',
        '0',
        '-sc_threshold',
        '0',
        '-output_ts_offset',
        String(start),
        '-muxdelay',
        '0',
        '-f',
        'mpegts',
        // Each standalone muxer starts its TS continuity counters afresh.
        '-mpegts_flags',
        '+initial_discontinuity',
        '-fs',
        String(CANVAS_BYTES - 64 * 1024),
        `@file:${file.name}`,
      ],
    });
    const actual = await inspect(ctx, file, size, duration, hasAudio);
    const previous = pieces.at(-1)?.actual;
    if (
      actual.bytes > CANVAS_BYTES ||
      Math.abs(actual.videoStart - start) > TOLERANCE ||
      (previous && !closeDuration(actual.videoStart - previous.videoStart, SEGMENT_SECONDS)) ||
      (actual.audio && !closeDuration(actual.audio.duration, duration))
    )
      invalid();
    await decode(ctx, file, duration);
    pieces.push({ file, actual });
    peak = peakBandwidth(peak, actual);
  }
  // Adjacent measured starts include the actual video timing. The last entry
  // uses the measured video duration, which excludes AAC encoder padding.
  const durations = pieces.map(({ actual }, index) => {
    const next = pieces[index + 1]?.actual;
    return next ? next.videoStart - actual.videoStart : actual.videoDuration;
  });
  if (
    !closeDuration(
      durations.reduce((sum, duration) => sum + duration, 0),
      totalDuration,
    )
  )
    invalid();
  const sub = playlist(`sub-${edge}.m3u8`);
  const header = `${masterHeader}#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n`;
  await ctx.write(
    sub.name,
    header +
      pieces
        .map(({ file }, index) => `#EXTINF:${durations[index]!.toFixed(6)},\n${file.name}\n`)
        .join('') +
      '#EXT-X-ENDLIST\n',
  );
  return { files: [...pieces.map(({ file }) => file), sub], entry: entry(peak, size, sub) };
}

export async function executeDerivatives(
  command: Extract<MediaCommand, { operation: 'video.derivatives' }>,
  ctx: MediaFileExecutionContext,
): Promise<MediaExecutionResult> {
  const probe: MediaProbe = await probeInput(0, ctx);
  if (!probe.hasVideo || !probe.width || !probe.height || probe.durationSeconds <= 0)
    throw mediaError('INPUT_INVALID');
  const canvas = command.parameters.profile === 'canvas';
  if (canvas && probe.durationSeconds > CANVAS_SECONDS) throw mediaError('INPUT_TOO_LONG');
  const duration = await primaryVideoEnd(probe, ctx);
  if (!duration) throw mediaError('INPUT_INVALID');
  if (canvas && Math.ceil(duration / SEGMENT_SECONDS) > CANVAS_SEGMENTS)
    throw mediaError('INPUT_TOO_LONG');
  const source = { width: probe.width, height: probe.height, duration, hasAudio: probe.hasAudio };
  const portrait = canvas && source.height > source.width;
  const high = fit(source, 720, portrait);
  const files = await preview(ctx, source, high);
  if (!canvas)
    return { files: [...files, ...(await ordinary(ctx, source, high))], data: { probe } };

  const low = fit(source, 480, portrait);
  const plan = planCanvas(source);
  if (plan.audioFiles.length) await prepareCanvasAudio(ctx, plan);
  const highRendition = await canvasRendition(ctx, plan, high, 720);
  files.push(...highRendition.files);
  let masterText = masterHeader + highRendition.entry;
  if (high.width !== low.width || high.height !== low.height) {
    const lowRendition = await canvasRendition(ctx, plan, low, 480);
    files.push(...lowRendition.files);
    masterText += lowRendition.entry;
  }
  await ctx.write(master.name, masterText);
  return { files: [...files, master], data: { probe } };
}
