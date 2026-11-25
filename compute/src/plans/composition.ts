import type { MediaCommand, MediaProbe, TimelineItem, TimelineTrack } from '@mio/compute-contracts';
import { mediaError, primaryStreamRange, probeInput } from './probe.ts';
import type { MediaStreamRange } from './probe.ts';
import {
  audioTempo,
  checkWindow,
  displaySize,
  evenDimension,
  frameNumber,
  h264SliceVideo,
  h264Video,
  joinVideoSlices,
  mp4Output,
  verifyRender,
  videoOutput,
} from './render-video.ts';
import type { VideoSlice } from './render-video.ts';
import type { MediaFileExecutionContext } from '../media-execution.ts';
import { subtitleFilter } from './subtitles.ts';

type CompositionCommand = Extract<MediaCommand, { operation: 'composition.render' }>;
type Picture = {
  item: TimelineItem;
  probe: MediaProbe;
  first: number;
  end: number;
  sourceStart: number;
};
type Canvas = { width: number; height: number; fps: number };
type Clip = { item: TimelineItem; track: TimelineTrack; probe?: MediaProbe; sourceStart?: number };

function visual(item: TimelineItem): boolean {
  return item.kind === 'video' || item.kind === 'image';
}

async function resolveClips(
  command: CompositionCommand,
  context: MediaFileExecutionContext,
): Promise<Clip[]> {
  const p = command.parameters;
  const tracks = new Map(p.tracks.map((track) => [`${track.kind}:${track.index}`, track]));
  const sources = new Map<number, MediaProbe>();
  const ranges = new Map<string, MediaStreamRange | null>();
  const clips: Clip[] = [];
  for (const item of p.items) {
    const track = tracks.get(`${item.kind === 'image' ? 'video' : item.kind}:${item.track}`)!;
    if (item.hidden || track.hidden) continue;
    if (item.kind === 'subtitle') {
      clips.push({ item, track });
      continue;
    }
    const index = item.inputIndex!;
    let probe = sources.get(index);
    if (!probe) {
      probe = await probeInput(index, context);
      sources.set(index, probe);
    }
    if (visual(item)) displaySize(probe);
    let sourceStart = 0;
    if (item.kind !== 'image') {
      const stream = item.kind === 'audio' ? 'a' : 'V';
      if ((stream === 'a' && !probe.hasAudio) || probe.durationSeconds <= 0)
        throw mediaError('INPUT_INVALID');
      const key = `${stream}:${index}`;
      let range = ranges.get(key);
      if (range === undefined) {
        range = await primaryStreamRange(probe, context, index, stream);
        ranges.set(key, range);
      }
      checkWindow(item.sourceStartSeconds ?? 0, item.durationSeconds * (item.speed ?? 1), range);
      sourceStart = range.start;
    }
    clips.push({ item, track, probe, sourceStart });
  }
  return clips;
}

function rectangle({ item, probe }: Picture, canvas: Canvas) {
  const source = displaySize(probe);
  const transform = item.transform;
  const proportion = transform?.fit === 'cover' ? Math.max : Math.min;
  const factor =
    proportion(canvas.width / source.width, canvas.height / source.height) *
    (transform?.scale ?? 1);
  const width = evenDimension(
    transform?.fit === 'manual' ? transform.width! : source.width * factor,
  );
  const height = evenDimension(
    transform?.fit === 'manual' ? transform.height! : source.height * factor,
  );
  return {
    width,
    height,
    x: Math.round((canvas.width - width) / 2 + (transform?.x ?? 0)),
    y: Math.round((canvas.height - height) / 2 + (transform?.y ?? 0)),
  };
}

function layerFilter(
  picture: Picture,
  canvas: Canvas,
  first: number,
  input: number,
  args: string[],
) {
  const { item } = picture;
  const speed = item.speed ?? 1;
  let filter = `[${input}:V:0]`;
  let gap = 0;
  if (item.kind === 'image') {
    filter += 'trim=end_frame=1,setpts=PTS-STARTPTS';
  } else {
    const offset = Math.max(
      0,
      (item.sourceStartSeconds ?? 0) + (first / canvas.fps - item.startSeconds) * speed,
    );
    // Keep the previous keyframe's decoded pictures. In a VFR source, the frame
    // spanning the in-point can be much older than the nominal frame interval.
    args.push('-ss', offset.toFixed(6), '-noaccurate_seek');
    gap = Math.max(0, (picture.sourceStart - offset) / speed);
    filter += `setpts=PTS/${speed}`;
  }
  args.push('-i', `@file:input-${item.inputIndex!}`);
  const rect = rectangle(picture, canvas);
  const angle = ((item.transform?.rotation ?? 0) * Math.PI) / 180;
  filter += `,scale=${rect.width}:${rect.height},setsar=1,format=rgba,tpad=stop_mode=clone:stop=-1,fps=${canvas.fps}:start_time=0:round=up`;
  if (angle) filter += `,rotate=${angle}:ow=rotw(${angle}):oh=roth(${angle}):c=black@0`;
  return { filter, rect, gap };
}

async function renderSlice(
  context: MediaFileExecutionContext,
  layers: Picture[],
  first: number,
  frames: number,
  index: number,
  canvas: Canvas,
): Promise<VideoSlice> {
  const { width, height, fps } = canvas;
  const args = [
    '-v',
    'error',
    '-xerror',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${width}x${height}:r=${fps}`,
  ];
  const filters = ['[0:v]setsar=1[base]'];
  let previous = '[base]';
  for (const [i, picture] of layers.entries()) {
    const input = i + 1;
    const { filter, rect, gap } = layerFilter(picture, canvas, first, input, args);
    const visibleAt = gap > 0 ? `:enable='gte(t,${gap.toFixed(6)})'` : '';
    filters.push(
      `${filter}[layer${input}]`,
      `${previous}[layer${input}]overlay=x=${rect.x}+(${rect.width}-overlay_w)/2:y=${rect.y}+(${rect.height}-overlay_h)/2:shortest=1${visibleAt}[out${input}]`,
    );
    previous = `[out${input}]`;
  }
  const file = videoOutput(`composition-slice-${index}.mp4`);
  await context.run({
    id: `composition-slice-${index}`,
    tool: 'ffmpeg',
    durationSeconds: frames / fps,
    outputs: [file],
    args: [
      ...args,
      '-filter_complex',
      filters.join(';'),
      '-map',
      previous,
      '-frames:v',
      String(frames),
      '-an',
      ...h264SliceVideo,
      ...mp4Output,
      `@file:${file.name}`,
    ],
  });
  return { file, frames };
}

async function renderPictureTimeline(
  context: MediaFileExecutionContext,
  clips: Clip[],
  p: CompositionCommand['parameters'],
): Promise<{ base: string; canvas: Canvas }> {
  const fps = p.fps ?? 30;
  const frames = frameNumber(p.durationSeconds, fps);
  const pictures: Picture[] = clips
    .filter(({ item }) => visual(item))
    .map(({ item, probe, sourceStart }) => ({
      item,
      probe: probe!,
      sourceStart: sourceStart!,
      first: frameNumber(item.startSeconds, fps),
      end: Math.min(frames, frameNumber(item.startSeconds + item.durationSeconds, fps)),
    }))
    .sort((a, b) => a.item.startSeconds - b.item.startSeconds);
  const first = pictures.find((picture) => picture.end > picture.first);
  const source = first ? displaySize(first.probe) : { width: 16, height: 9 };
  const shortEdge = { '720p': 720, '1080p': 1080, '4k': 2160 }[p.resolution];
  const scale = shortEdge / Math.min(source.width, source.height);
  const canvas = {
    width: evenDimension(source.width * scale),
    height: evenDimension(source.height * scale),
    fps,
  };
  // Slice on a single global frame clock so fractional windows do not grow
  // the output by an independent rounding error at every boundary.
  const visible = pictures.filter((picture) => picture.end > picture.first);
  const boundaries = [
    ...new Set([0, frames, ...visible.flatMap(({ first, end }) => [first, end])]),
  ].sort((a, b) => a - b);
  const slices: VideoSlice[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!;
    const length = boundaries[i + 1]! - start;
    const layers = visible
      .filter(({ first, end }) => first <= start && end > start)
      .sort((a, b) => a.item.track - b.item.track);
    slices.push(await renderSlice(context, layers, start, length, i, canvas));
  }
  return { base: await joinVideoSlices('composition', slices, fps, context), canvas };
}

function audioTimeline(clips: Clip[], duration: number) {
  const args = ['-f', 'lavfi', '-i', `anullsrc=cl=stereo:r=44100:d=${duration.toFixed(6)}`];
  const filters: string[] = [];
  const labels = ['[1:a:0]'];
  for (const { item, track, probe } of clips) {
    if (
      (item.kind !== 'audio' && item.kind !== 'video') ||
      !probe?.hasAudio ||
      item.muted ||
      (track.volume ?? 1) === 0 ||
      (item.volume ?? 1) === 0
    )
      continue;
    const input = labels.length + 1;
    const speed = item.speed ?? 1;
    const offset = item.sourceStartSeconds ?? 0;
    const duration = item.durationSeconds * speed;
    const gain = Math.min(2, (track.volume ?? 1) * (item.volume ?? 1));
    args.push(
      '-ss',
      offset.toFixed(6),
      '-t',
      duration.toFixed(6),
      '-i',
      `@file:input-${item.inputIndex!}`,
    );
    const delay = Math.round(item.startSeconds * 44100);
    const label = `[a${input}]`;
    filters.push(
      `[${input}:a:0]aresample=44100:async=1:first_pts=0,${audioTempo(speed)},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,atrim=duration=${item.durationSeconds.toFixed(6)},volume=${gain},adelay=${delay}S:all=1${label}`,
    );
    labels.push(label);
  }
  // Preserve the composition's default normalized mix with a silent timing input.
  filters.push(
    `${labels.join('')}amix=inputs=${labels.length}:duration=first:dropout_transition=0[composed]`,
  );
  return { args, filter: filters.join(';') };
}

export async function renderComposition(
  command: CompositionCommand,
  context: MediaFileExecutionContext,
) {
  const clips = await resolveClips(command, context);
  const duration = command.parameters.durationSeconds;
  const { base, canvas } = await renderPictureTimeline(context, clips, command.parameters);
  const audio = audioTimeline(clips, duration);
  const cues = clips
    .filter(({ item }) => item.kind === 'subtitle')
    .sort((a, b) => a.item.startSeconds - b.item.startSeconds)
    .map(({ item }) => ({
      startSeconds: item.startSeconds,
      endSeconds: item.startSeconds + item.durationSeconds,
      text: item.text!,
      track: item.track,
      ...(item.style ? { style: item.style } : {}),
    }));
  const filters = cues.length
    ? ['-vf', await subtitleFilter(context, cues, canvas), ...h264Video]
    : ['-c:v', 'copy'];
  const output = videoOutput('composition.mp4');
  await context.run({
    id: 'composition-mux',
    tool: 'ffmpeg',
    durationSeconds: duration,
    outputs: [output],
    args: [
      '-v',
      'error',
      '-xerror',
      '-i',
      `@file:${base}`,
      ...audio.args,
      '-filter_complex',
      audio.filter,
      '-map',
      '0:V:0',
      '-map',
      '[composed]',
      ...filters,
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      ...mp4Output,
      `@file:${output.name}`,
    ],
  });
  await verifyRender(
    output,
    { ...canvas, duration, audio: true, tolerance: 1 / canvas.fps + 0.03 },
    context,
  );
  return { files: [output], data: {} };
}
