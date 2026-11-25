import type {
  MediaOperation,
  MediaParameters,
  SubtitleCue,
  SubtitleStyle,
  TimelineTrack,
} from './media-types.ts';
import { MEDIA_MAX_ITEMS, MEDIA_OPERATIONS } from './media-types.ts';
import {
  mediaArray as array,
  mediaEnum as choice,
  mediaFields as fields,
  mediaInvalid as invalid,
  mediaNumber as number,
  mediaRecord as object,
  mediaString as string,
} from './media-validation.ts';

function cues(value: unknown): SubtitleCue[] {
  return array(value, 256).map((v) => {
    const c = object(v);
    fields(c, ['startSeconds', 'endSeconds', 'text']);
    const startSeconds = number(c.startSeconds, 0, 3600);
    const endSeconds = number(c.endSeconds, 0.001, 3600);
    const text = string(c.text, 4096);
    if (endSeconds <= startSeconds || !text.trim()) return invalid();
    return { startSeconds, endSeconds, text };
  });
}
function style(value: unknown): SubtitleStyle {
  const s = object(value);
  fields(
    s,
    [],
    ['font', 'fontSize', 'color', 'background', 'outlineColor', 'outline', 'alignment', 'margin'],
  );
  if (s.font !== undefined) choice(s.font, ['sans', 'serif']);
  if (s.fontSize !== undefined) number(s.fontSize, 8, 240);
  if (s.outline !== undefined) number(s.outline, 0, 12);
  if (s.margin !== undefined) number(s.margin, 0, 500);
  if (s.alignment !== undefined) choice(s.alignment, ['bottom', 'middle', 'top']);
  for (const k of ['color', 'background', 'outlineColor'])
    if (s[k] !== undefined && !/^#[a-fA-F0-9]{6}(?:[a-fA-F0-9]{2})?$/.test(string(s[k], 9)))
      invalid();
  return s as SubtitleStyle;
}
function optionalNumber(
  p: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  integer = false,
): void {
  if (p[key] !== undefined) number(p[key], min, max, integer);
}
function inputIndex(value: unknown, count: number): number {
  return number(value, 0, count - 1, true);
}
function timeline(p: Record<string, unknown>, count: number): void {
  fields(p, ['resolution', 'durationSeconds', 'tracks', 'items'], ['fps']);
  choice(p.resolution, ['720p', '1080p', '4k']);
  const duration = number(p.durationSeconds, 0.001, 3600);
  optionalNumber(p, 'fps', 1, 60, true);
  const tracks = array(p.tracks, 18, 1).map((v) => {
    const t = object(v);
    fields(t, ['kind', 'index'], ['hidden', 'locked', 'volume']);
    choice(t.kind, ['video', 'audio', 'subtitle']);
    number(t.index, 0, 5, true);
    optionalNumber(t, 'volume', 0, 2);
    for (const key of ['hidden', 'locked'])
      if (t[key] !== undefined && typeof t[key] !== 'boolean') invalid();
    return t as unknown as TimelineTrack;
  });
  const keys = new Set(tracks.map((t) => `${t.kind}:${t.index}`));
  if (keys.size !== tracks.length) invalid();
  array(p.items, MEDIA_MAX_ITEMS).forEach((v) => {
    const t = object(v);
    fields(
      t,
      ['kind', 'track', 'startSeconds', 'durationSeconds'],
      [
        'inputIndex',
        'sourceStartSeconds',
        'speed',
        'volume',
        'muted',
        'hidden',
        'transform',
        'text',
        'style',
      ],
    );
    choice(t.kind, ['video', 'image', 'audio', 'subtitle']);
    number(t.track, 0, 5, true);
    if (!keys.has(`${t.kind === 'image' ? 'video' : String(t.kind)}:${String(t.track)}`)) invalid();
    const start = number(t.startSeconds, 0, duration),
      length = number(t.durationSeconds, 0.001, duration);
    if (start + length > duration + 0.000001) invalid();
    if (t.kind === 'subtitle') {
      if (!string(t.text, 4096).trim() || t.inputIndex !== undefined || t.transform !== undefined)
        invalid();
    } else {
      inputIndex(t.inputIndex, count);
      if (t.text !== undefined || t.style !== undefined) invalid();
    }
    optionalNumber(t, 'sourceStartSeconds', 0, 3600);
    optionalNumber(t, 'speed', 0.5, 4);
    optionalNumber(t, 'volume', 0, 2);
    for (const key of ['hidden', 'muted'])
      if (t[key] !== undefined && typeof t[key] !== 'boolean') invalid();
    if (t.style !== undefined) style(t.style);
    if (t.transform !== undefined) {
      const f = object(t.transform);
      fields(f, ['x', 'y', 'scale', 'rotation', 'fit'], ['width', 'height']);
      number(f.x, -8192, 8192);
      number(f.y, -8192, 8192);
      number(f.scale, 0.01, 8);
      number(f.rotation, -360, 360);
      choice(f.fit, ['contain', 'cover', 'manual']);
      optionalNumber(f, 'width', 2, 16384);
      optionalNumber(f, 'height', 2, 16384);
      if (f.fit === 'manual' && (f.width === undefined || f.height === undefined)) invalid();
    }
  });
}

/** Validate only application parameters. Paths, URLs and filter expressions have no fields. */
export function parseMediaParameters<O extends MediaOperation>(
  operation: O,
  value: unknown,
  inputCount: number,
): MediaParameters[O] {
  choice(operation, MEDIA_OPERATIONS);
  const p = object(value);
  if (operation === 'media.probe' || operation === 'video.reference_prepare') fields(p, []);
  else if (operation === 'video.derivatives') {
    fields(p, ['profile']);
    choice(p.profile, ['ordinary', 'canvas']);
  } else if (operation === 'video.trim') {
    fields(p, ['startSeconds', 'endSeconds']);
    const start = number(p.startSeconds, 0, 3600),
      end = number(p.endSeconds, 0.001, 3600);
    if (end <= start || end - start > 600) invalid();
  } else if (operation === 'frames.extract') {
    fields(p, ['mode'], ['timestamps', 'intervalSeconds', 'threshold', 'maxFrames', 'width']);
    choice(p.mode, ['first_last', 'timestamps', 'interval', 'scene']);
    optionalNumber(p, 'maxFrames', 1, 256, true);
    optionalNumber(p, 'width', 16, 1920, true);
    optionalNumber(p, 'threshold', 0.01, 1);
    if (p.mode === 'timestamps') array(p.timestamps, 256, 1).forEach((v) => number(v, 0, 3600));
    else if (p.timestamps !== undefined) invalid();
    if (p.mode === 'interval') number(p.intervalSeconds, 0.04, 3600);
    else if (p.intervalSeconds !== undefined) invalid();
    if (p.mode !== 'scene' && p.threshold !== undefined) invalid();
  } else if (operation === 'scenes.detect') {
    fields(p, [], ['threshold', 'minSceneSeconds']);
    optionalNumber(p, 'threshold', 0.01, 1);
    optionalNumber(p, 'minSceneSeconds', 0.04, 600);
  } else if (operation === 'video.split') {
    fields(p, ['boundaries']);
    let previous = 0;
    for (const v of array(p.boundaries, 255, 1)) {
      const n = number(v, 0.001, 3600);
      if (n <= previous) invalid();
      previous = n;
    }
  } else if (operation === 'audio.extract') {
    fields(p, ['profile'], ['format']);
    choice(p.profile, ['original', 'asr']);
    if (p.format !== undefined) choice(p.format, ['wav', 'mp3', 'm4a']);
    if (p.profile === 'asr' && p.format !== undefined && p.format !== 'wav') invalid();
  } else if (operation === 'audio.waveform') {
    fields(p, [], ['points']);
    optionalNumber(p, 'points', 1, 4096, true);
  } else if (operation === 'audio.remux') {
    fields(p, [], ['sourceDurationSeconds']);
    optionalNumber(p, 'sourceDurationSeconds', 0.001, 3600);
    if (inputCount !== 2) invalid();
  } else if (operation === 'audio.concat') {
    fields(p, [], ['subtitles']);
    if (p.subtitles !== undefined) {
      const seen = new Set<number>();
      for (const v of array(p.subtitles, 64)) {
        const s = object(v);
        fields(s, ['inputIndex', 'cues']);
        const index = inputIndex(s.inputIndex, inputCount);
        if (seen.has(index)) invalid();
        seen.add(index);
        cues(s.cues);
      }
    }
  } else if (operation === 'media.export') {
    fields(p, ['format'], ['height', 'fps']);
    choice(p.format, ['mp4', 'webm', 'gif', 'mp3']);
    optionalNumber(p, 'height', 16, 2160, true);
    optionalNumber(p, 'fps', 1, 60, true);
    if (p.format === 'mp3' && (p.height !== undefined || p.fps !== undefined)) invalid();
  } else if (operation === 'subtitle.burn') {
    fields(p, ['cues'], ['style']);
    cues(p.cues);
    if (p.style !== undefined) style(p.style);
  } else if (operation === 'composition.render') timeline(p, inputCount);
  else if (operation === 'video.mix') {
    fields(p, ['clips', 'seed'], ['bgmInputIndex', 'bgmVolume']);
    number(p.seed, 0, 0xffffffff, true);
    let duration = 0;
    array(p.clips, MEDIA_MAX_ITEMS, 1).forEach((v) => {
      const c = object(v);
      fields(c, ['inputIndex', 'startSeconds', 'durationSeconds']);
      inputIndex(c.inputIndex, inputCount);
      number(c.startSeconds, 0, 3600);
      duration += number(c.durationSeconds, 0.001, 600);
    });
    if (duration > 3600) invalid();
    if (p.bgmInputIndex !== undefined) inputIndex(p.bgmInputIndex, inputCount);
    optionalNumber(p, 'bgmVolume', 0, 1);
  } else if (operation === 'video.narration_render') {
    fields(
      p,
      ['videoInputIndex', 'narrationInputIndex'],
      ['bgmInputIndex', 'bgmVolume', 'cues', 'style'],
    );
    inputIndex(p.videoInputIndex, inputCount);
    inputIndex(p.narrationInputIndex, inputCount);
    if (p.bgmInputIndex !== undefined) inputIndex(p.bgmInputIndex, inputCount);
    optionalNumber(p, 'bgmVolume', 0, 1);
    if (p.cues !== undefined) cues(p.cues);
    if (p.style !== undefined) style(p.style);
  }
  if (
    ![
      'composition.render',
      'video.mix',
      'video.narration_render',
      'audio.concat',
      'audio.remux',
    ].includes(operation) &&
    inputCount !== 1
  )
    invalid();
  return structuredClone(p) as unknown as MediaParameters[O];
}
