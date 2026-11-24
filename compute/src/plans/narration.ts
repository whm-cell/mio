import type { MediaCommand } from '@mio/compute-contracts';
import type {
  LocalMediaFile,
  MediaExecutionContext,
  MediaFileExecutionContext,
} from '../media-execution.ts';
import { mediaError, probeFile, probeInput } from './probe.ts';
import {
  bgmFilter,
  fitFullHd,
  frameNumber,
  h264Video,
  mp4Output,
  verifyRender,
  videoOutput,
} from './render-video.ts';
import { subtitleFilter } from './subtitles.ts';

type NarrationCommand = Extract<MediaCommand, { operation: 'video.narration_render' }>;

async function normalizeVoice(
  index: number,
  estimatedSeconds: number,
  context: MediaExecutionContext,
) {
  // Decode only the selected audio stream. An MP4/WebM voice asset can have a
  // video track with a longer duration, or omit duration on the audio track.
  const file: LocalMediaFile = {
    name: 'narration-voice.wav',
    role: 'audio',
    contentType: 'audio/wav',
  };
  await context.run({
    id: 'normalize-narration',
    tool: 'ffmpeg',
    durationSeconds: estimatedSeconds,
    args: [
      '-v',
      'error',
      '-xerror',
      '-i',
      `@file:input-${index}`,
      '-map',
      '0:a:0',
      '-af',
      'asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100,aformat=channel_layouts=stereo',
      '-c:a',
      'pcm_s16le',
      `@file:${file.name}`,
    ],
    outputs: [file],
  });
  const probe = await probeFile(file.name, 'probe-narration-voice', context);
  if (!probe.hasAudio || !probe.durationSeconds) throw mediaError('INPUT_INVALID');
  return { name: file.name, duration: probe.durationSeconds };
}

export async function renderNarration(
  command: NarrationCommand,
  context: MediaFileExecutionContext,
) {
  const p = command.parameters;
  const video = await probeInput(p.videoInputIndex, context);
  const voice = await probeInput(p.narrationInputIndex, context);
  if (!video.hasVideo || !video.durationSeconds || !voice.hasAudio || !voice.durationSeconds)
    throw mediaError('INPUT_INVALID');
  const bgm = p.bgmInputIndex;
  if (bgm !== undefined && !(await probeInput(bgm, context)).hasAudio)
    throw mediaError('INPUT_INVALID');
  const normalized = await normalizeVoice(p.narrationInputIndex, voice.durationSeconds, context);
  const { duration } = normalized;
  const args = [
    '-v',
    'error',
    '-xerror',
    '-i',
    `@file:input-${p.videoInputIndex}`,
    '-i',
    `@file:${normalized.name}`,
  ];
  const canvas = { width: 1920, height: 1080 };
  const fps = 30;
  let picture = [
    '[0:V:0]setpts=PTS-STARTPTS',
    fitFullHd(video),
    'tpad=stop_mode=clone:stop=-1',
    `fps=${fps}:start_time=0`,
    `trim=end_frame=${frameNumber(duration, fps)}`,
  ].join(',');
  if (p.cues?.length) {
    const style = p.style;
    picture +=
      ',' +
      (await subtitleFilter(
        context,
        p.cues.map((cue) => ({ ...cue, ...(style ? { style } : {}) })),
        canvas,
      ));
  }
  const filters = [`${picture}[picture]`];
  let audio = '1:a:0';
  if (bgm !== undefined && p.bgmVolume !== 0) {
    args.push('-i', `@file:input-${bgm}`);
    filters.push(
      bgmFilter(2, duration, p.bgmVolume ?? 0.3),
      '[1:a:0][bgm]amix=inputs=2:duration=first:dropout_transition=3[voice]',
    );
    audio = '[voice]';
  }
  const output = videoOutput('narration.mp4');
  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[picture]',
    '-map',
    audio,
    ...h264Video,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    ...mp4Output,
    `@file:${output.name}`,
  );
  await context.run({
    id: 'render-narration',
    tool: 'ffmpeg',
    durationSeconds: duration,
    outputs: [output],
    args,
  });
  await verifyRender(
    output,
    { ...canvas, duration, audio: true, tolerance: 1 / fps + 0.03 },
    context,
  );
  return { files: [output], data: p.cues ? { subtitles: p.cues } : {} };
}
