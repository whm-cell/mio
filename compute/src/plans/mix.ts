import type { MediaCommand, MediaProbe } from '@mio/compute-contracts';
import { mediaError, primaryStreamRange, probeInput } from './probe.ts';
import type { MediaStreamRange } from './probe.ts';
import {
  bgmFilter,
  checkWindow,
  fitFullHd,
  frameNumber,
  h264SliceVideo,
  joinVideoSlices,
  mp4Output,
  verifyRender,
  videoOutput,
} from './render-video.ts';
import type { VideoSlice } from './render-video.ts';
import type { MediaFileExecutionContext } from '../media-execution.ts';

type MixCommand = Extract<MediaCommand, { operation: 'video.mix' }>;
const fps = 30;

function shuffledClips(p: MixCommand['parameters']) {
  const clips = [...p.clips];
  // Mulberry32 and Fisher-Yates preserve the same order across JS runtimes.
  let state = p.seed >>> 0;
  for (let i = clips.length - 1; i > 0; i--) {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    const j = Math.floor((((value ^ (value >>> 14)) >>> 0) / 4294967296) * (i + 1));
    [clips[i], clips[j]] = [clips[j]!, clips[i]!];
  }
  return clips;
}

async function renderClip(
  input: number,
  probe: MediaProbe,
  index: number,
  start: number,
  gap: number,
  frames: number,
  context: MediaFileExecutionContext,
): Promise<VideoSlice> {
  const filter = [
    fitFullHd(probe),
    'tpad=stop_mode=clone:stop=-1',
    `fps=${fps}:start_time=0:round=up`,
    ...(gap > 0
      ? [`drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='lt(t,${gap.toFixed(6)})'`]
      : []),
  ].join(',');
  const file = videoOutput(`mix-slice-${index}.mp4`);
  await context.run({
    id: `mix-slice-${index}`,
    tool: 'ffmpeg',
    durationSeconds: frames / fps,
    outputs: [file],
    args: [
      '-v',
      'error',
      '-xerror',
      '-ss',
      start.toFixed(6),
      '-noaccurate_seek',
      '-i',
      `@file:input-${input}`,
      '-map',
      '0:V:0',
      '-vf',
      filter,
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

export async function renderMix(command: MixCommand, context: MediaFileExecutionContext) {
  const p = command.parameters;
  const clips = shuffledClips(p);
  const sources = new Map<number, { probe: MediaProbe; range: MediaStreamRange | null }>();
  for (const clip of clips) {
    let source = sources.get(clip.inputIndex);
    if (!source) {
      const probe = await probeInput(clip.inputIndex, context);
      if (!probe.hasVideo || !probe.durationSeconds) throw mediaError('INPUT_INVALID');
      source = { probe, range: await primaryStreamRange(probe, context, clip.inputIndex, 'V') };
      sources.set(clip.inputIndex, source);
    }
    checkWindow(clip.startSeconds, clip.durationSeconds, source.range);
  }
  if (p.bgmInputIndex !== undefined) {
    const probe =
      sources.get(p.bgmInputIndex)?.probe ?? (await probeInput(p.bgmInputIndex, context));
    if (!probe.hasAudio) throw mediaError('INPUT_INVALID');
  }

  const slices: VideoSlice[] = [];
  let duration = 0;
  for (const [index, clip] of clips.entries()) {
    const first = frameNumber(duration, fps);
    const start = clip.startSeconds + first / fps - duration;
    duration += clip.durationSeconds;
    const frames = frameNumber(duration, fps) - first;
    if (!frames) continue;
    const source = sources.get(clip.inputIndex)!;
    const gap = Math.max(0, source.range!.start - start);
    slices.push(
      await renderClip(clip.inputIndex, source.probe, index, start, gap, frames, context),
    );
  }
  const base = await joinVideoSlices('mix', slices, fps, context);
  const output = videoOutput('mix.mp4');
  const audio = p.bgmInputIndex !== undefined;
  const args = ['-v', 'error', '-xerror', '-i', `@file:${base}`];
  if (audio) {
    args.push(
      '-i',
      `@file:input-${p.bgmInputIndex}`,
      '-filter_complex',
      bgmFilter(1, duration, p.bgmVolume ?? 0.3),
      '-map',
      '[bgm]',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
    );
  }
  args.push('-map', '0:V:0', '-c:v', 'copy', ...mp4Output, `@file:${output.name}`);
  await context.run({
    id: 'render-mix',
    tool: 'ffmpeg',
    durationSeconds: duration,
    outputs: [output],
    args,
  });
  await verifyRender(
    output,
    { width: 1920, height: 1080, duration, audio, tolerance: 1 / fps + 0.03 },
    context,
  );
  return { files: [output], data: {} };
}
