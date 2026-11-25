import { mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TimelineItem, TimelineTrack } from '@mio/compute-contracts';
import { Journal } from '../src/adapters/journal.ts';
import { MEDIA_FILE_LIMIT } from '../src/adapters/media-files.ts';
import { renderComposition } from '../src/plans/composition.ts';
import { renderMix } from '../src/plans/mix.ts';
import { renderNarration } from '../src/plans/narration.ts';
import { probeFile } from '../src/plans/probe.ts';
import { renderSubtitleCommand } from '../src/plans/subtitles.ts';
import {
  audioSamples,
  dominantColors,
  ffmpeg,
  pixel,
  pixels,
  renderFixture,
  tone,
  videoPacketTimes,
} from './media-render-fixture.ts';

const root = mkdtempSync(join(tmpdir(), 'mio-media-render-'));
const journal = new Journal(root, 'm4-synthetic', true);
const red = join(root, 'red.mp4');
const blue = join(root, 'blue.mp4');
const image = join(root, 'image.png');
const cut = join(root, 'cut.mp4');
const voice = join(root, 'voice.mp4');
const corrupt = join(root, 'invalid');
const frequencies = [513, 637, 781, 907, 1123, 1291];
const voices = frequencies.map((frequency) => join(root, `sine-${frequency}.wav`));

beforeAll(() => {
  ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=160x90:r=25:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    red,
  );
  ffmpeg('-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25:d=0.4', '-c:v', 'libx264', blue);
  ffmpeg('-f', 'lavfi', '-i', 'color=c=yellow:s=160x90', '-frames:v', '1', '-c:v', 'png', image);
  ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=160x90:r=25:d=1',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=160x90:r=25:d=1',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    cut,
  );
  ffmpeg(
    '-i',
    red,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=721:sample_rate=44100:duration=0.73',
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    voice,
  );
  for (const [index, frequency] of frequencies.entries())
    ffmpeg('-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=2`, voices[index]!);
  writeFileSync(corrupt, 'invalid fixture');
}, 30000);

afterAll(() => {
  journal.close();
  rmSync(root, { recursive: true, force: true });
});

function visual(
  inputIndex: number,
  track: number,
  startSeconds: number,
  durationSeconds: number,
): TimelineItem {
  return { kind: 'video', inputIndex, track, startSeconds, durationSeconds };
}

function tracks(kind: TimelineTrack['kind']): TimelineTrack[] {
  return Array.from({ length: 6 }, (_, index) => ({ kind, index, locked: index === 5 }));
}

describe('M4 real media through the process, journal, and file adapters', () => {
  it('renders six video, audio, and subtitle tracks with lock, hide, crop, and a black gap', async () => {
    const visuals = tracks('video').map(({ index }): TimelineItem =>
      index === 0
        ? visual(0, 0, 0, 0.6)
        : {
            ...visual(1, index, 0, 0.3),
            kind: 'image',
            transform: {
              x: -720 + (index - 1) * 235,
              y: -100,
              width: 240,
              height: 100,
              scale: 1,
              rotation: index === 5 ? 90 : 0,
              fit: 'manual',
            },
          },
    );
    const sounds = tracks('audio').map(({ index }): TimelineItem => ({
      kind: 'audio',
      track: index,
      inputIndex: 2 + index,
      startSeconds: 0.3,
      durationSeconds: 0.45,
      sourceStartSeconds: 0.1,
      volume: 1,
    }));
    const subtitles = tracks('subtitle').map(({ index }): TimelineItem => ({
      kind: 'subtitle',
      track: index,
      startSeconds: 0.3,
      durationSeconds: 0.25,
      text: '中国',
      style: { fontSize: 55, alignment: 'top', margin: 30 + index * 88 },
    }));
    const setup = renderFixture(
      root,
      journal,
      'composition.render',
      {
        resolution: '720p',
        durationSeconds: 1.05,
        tracks: [...tracks('video'), ...tracks('audio'), ...tracks('subtitle')],
        items: [
          ...visuals,
          ...sounds,
          ...subtitles,
          { ...visual(8, 5, 0, 1), hidden: true },
          {
            kind: 'subtitle',
            track: 5,
            startSeconds: 0.75,
            durationSeconds: 0.2,
            text: '隐藏',
            hidden: true,
          },
        ],
      },
      [red, image, ...voices, corrupt],
    );
    const context = setup.context();
    const result = await renderComposition(setup.command, context);
    const output = setup.files.path(result.files[0]!.name);
    expect(await probeFile(result.files[0]!.name, 'measure-composition', context)).toMatchObject({
      width: 1280,
      height: 720,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
    const layers = pixels(output, 0.15, 'crop=1280:720:0:0');
    for (const x of [5, 160, 420, 630, 860]) {
      const [r, g, b] = pixel(layers, 1280, x, 260);
      expect(r).toBeGreaterThan(210);
      expect(g).toBeGreaterThan(210);
      expect(b).toBeLessThan(80);
    }
    expect(pixel(layers, 1280, 80, 180)).toEqual(pixel(layers, 1280, 50, 50));
    const speech = audioSamples(output, 0.36, 0.12);
    for (const frequency of [...frequencies, 440])
      expect(tone(speech, frequency)).toBeGreaterThan(120);
    for (let index = 0; index < 6; index++) {
      const frame = pixels(
        output,
        0.4,
        `crop=176:54:552:${Math.round(((30 + index * 88) * 2) / 3)}`,
      );
      expect(dominantColors(frame).white).toBeGreaterThan(50);
    }
    expect(Math.max(...pixels(output, 0.95, 'crop=8:8:620:370'))).toBeLessThan(8);
    expect(setup.steps.some(({ id }) => id === 'probe-input-8')).toBe(false);
  }, 60000);

  it('joins two- and five-frame slices on the presentation clock', async () => {
    // A two-frame black gap has no decode preroll. Longer x264 slices used
    // to begin decoding before it ended, failing the copy mux on decreasing DTS.
    const composition = renderFixture(
      root,
      journal,
      'composition.render',
      {
        resolution: '720p',
        fps: 10,
        durationSeconds: 0.7,
        tracks: [{ kind: 'video', index: 0 }],
        items: [visual(0, 0, 0.2, 0.5)],
      },
      [red],
    );
    const mixed = renderFixture(
      root,
      journal,
      'video.mix',
      {
        seed: 1,
        clips: [
          { inputIndex: 0, startSeconds: 0.1, durationSeconds: 2 / 30 },
          { inputIndex: 1, startSeconds: 0.1, durationSeconds: 5 / 30 },
        ],
      },
      [red, blue],
    );
    const composed = await renderComposition(composition.command, composition.context());
    const mixedResult = await renderMix(mixed.command, mixed.context());
    for (const [path, fps] of [
      [composition.files.path(composed.files[0]!.name), 10],
      [mixed.files.path(mixedResult.files[0]!.name), 30],
    ] as const) {
      const packets = videoPacketTimes(path);
      expect(packets).toHaveLength(7);
      for (const [index, { presentation, decode }] of packets.entries()) {
        expect(presentation).toBeCloseTo(index / fps, 5);
        expect(decode).toBeCloseTo(index / fps, 5);
      }
    }
  }, 45000);

  it('uses source offsets and both speed boundaries on one output clock', async () => {
    const setup = renderFixture(
      root,
      journal,
      'composition.render',
      {
        resolution: '720p',
        fps: 25,
        durationSeconds: 0.82,
        tracks: [{ kind: 'video', index: 0 }],
        items: [
          { ...visual(0, 0, 0, 0.2), speed: 4, sourceStartSeconds: 0.6 },
          { ...visual(0, 0, 0.2, 0.6), speed: 0.5, sourceStartSeconds: 0.9 },
        ],
      },
      [cut],
    );
    const result = await renderComposition(setup.command, setup.context());
    const path = setup.files.path(result.files[0]!.name);
    for (const [time, channel] of [
      [0.04, 0],
      [0.16, 2],
      [0.24, 0],
      [0.6, 2],
    ] as const)
      expect(pixels(path, time, 'crop=2:2:610:350')[channel]).toBeGreaterThan(210);
    expect(Math.max(...pixels(path, 0.81, 'crop=2:2:610:350'))).toBeLessThan(10);
  }, 45000);

  it('omits hidden tracks and sorts a same-track overlap by start time with stable ties', async () => {
    const fixture = renderFixture(
      root,
      journal,
      'composition.render',
      {
        resolution: '720p',
        durationSeconds: 0.35,
        tracks: [
          { kind: 'video', index: 0 },
          { kind: 'video', index: 5, hidden: true },
        ],
        items: [
          visual(1, 0, 0.1, 0.15),
          visual(0, 0, 0, 0.35),
          { ...visual(2, 0, 0.1, 0.15), kind: 'image' },
          visual(3, 5, 0, 0.35),
        ],
      },
      [red, blue, image, corrupt],
    );
    const result = await renderComposition(fixture.command, fixture.context());
    const output = fixture.files.path(result.files[0]!.name);
    expect(pixels(output, 0.02, 'crop=2:2:610:350')[1]).toBeLessThan(20);
    expect(pixels(output, 0.12, 'crop=2:2:610:350')[1]).toBeGreaterThan(220);
    expect(fixture.steps.some(({ id }) => id === 'probe-input-3')).toBe(false);
  }, 45000);

  it('orders same-track subtitles by start time and keeps submission order for equal times', async () => {
    const subtitles = [
      { startSeconds: 0.25, durationSeconds: 0.3, background: '#0000ff' },
      { startSeconds: 0, durationSeconds: 0.5, background: '#ff0000' },
      { startSeconds: 0.25, durationSeconds: 0.12, background: '#00ff00' },
    ].map(({ startSeconds, durationSeconds, background }): TimelineItem => ({
      kind: 'subtitle',
      track: 0,
      text: '中国',
      startSeconds,
      durationSeconds,
      style: { fontSize: 100, alignment: 'middle', background },
    }));
    const fixture = renderFixture(
      root,
      journal,
      'composition.render',
      {
        resolution: '720p',
        durationSeconds: 0.6,
        tracks: [{ kind: 'subtitle', index: 0 }],
        items: subtitles,
      },
      [red],
    );
    const result = await renderComposition(fixture.command, fixture.context());
    const path = fixture.files.path(result.files[0]!.name);
    for (const [time, expected] of [
      [0.12, 'red'],
      [0.3, 'green'],
      [0.44, 'blue'],
    ] as const) {
      const colors = dominantColors(pixels(path, time, 'crop=160:120:560:300'));
      expect(colors[expected]).toBeGreaterThan(1000);
    }
  }, 45000);

  it('keeps the picture spanning a VFR source window without moving forward to the next frame', async () => {
    const source = join(root, 'vfr.mp4');
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=160x90:r=10:d=1',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x90:r=10:d=0.3',
      '-filter_complex',
      "[0:v][1:v]concat=n=2:v=1:a=0,select='eq(n,0)+eq(n,1)+eq(n,2)+gte(n,10)'",
      '-fps_mode',
      'vfr',
      '-c:v',
      'libx264',
      '-bf',
      '0',
      source,
    );
    // The red frame at 0.2s persists until the blue frame at 1s.
    const window = { startSeconds: 0.7, durationSeconds: 0.15 };
    const mix = renderFixture(
      root,
      journal,
      'video.mix',
      { seed: 1, clips: [{ inputIndex: 0, ...window }] },
      [source],
    );
    const composition = renderFixture(
      root,
      journal,
      'composition.render',
      {
        resolution: '720p',
        durationSeconds: window.durationSeconds,
        tracks: [{ kind: 'video', index: 0 }],
        items: [
          { ...visual(0, 0, 0, window.durationSeconds), sourceStartSeconds: window.startSeconds },
        ],
      },
      [source],
    );
    const mixed = await renderMix(mix.command, mix.context());
    const composed = await renderComposition(composition.command, composition.context());
    for (const time of [0, 0.033, 0.066, 0.099, 0.132]) {
      expect(
        pixels(mix.files.path(mixed.files[0]!.name), time, 'crop=2:2:960:540')[0],
      ).toBeGreaterThan(220);
      expect(
        pixels(composition.files.path(composed.files[0]!.name), time, 'crop=2:2:640:360')[0],
      ).toBeGreaterThan(220);
    }
  }, 45000);

  it('rejects windows wholly before the first picture and renders only the in-window picture', async () => {
    const source = join(root, 'late-picture.mp4');
    ffmpeg(
      '-itsoffset',
      '0.6',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x90:r=25:d=0.4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=617:sample_rate=44100:duration=1',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      source,
    );
    const mixed = (startSeconds: number, durationSeconds: number) =>
      renderFixture(
        root,
        journal,
        'video.mix',
        { seed: 1, clips: [{ inputIndex: 0, startSeconds, durationSeconds }] },
        [source],
      );
    const composed = (startSeconds: number, durationSeconds: number) =>
      renderFixture(
        root,
        journal,
        'composition.render',
        {
          resolution: '720p',
          durationSeconds,
          tracks: [{ kind: 'video', index: 0 }],
          items: [{ ...visual(0, 0, 0, durationSeconds), sourceStartSeconds: startSeconds }],
        },
        [source],
      );
    const invalidMix = mixed(0.1, 0.16);
    const invalidComposition = composed(0.1, 0.16);
    await expect(renderMix(invalidMix.command, invalidMix.context())).rejects.toMatchObject({
      code: 'INPUT_INVALID',
    });
    await expect(
      renderComposition(invalidComposition.command, invalidComposition.context()),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    expect(invalidMix.steps.some(({ id }) => id.startsWith('mix-slice'))).toBe(false);
    expect(invalidComposition.steps.some(({ id }) => id.startsWith('composition-slice'))).toBe(
      false,
    );
    const mix = mixed(0.4, 0.4);
    const composition = composed(0.4, 0.4);
    const mixResult = await renderMix(mix.command, mix.context());
    const compositionResult = await renderComposition(composition.command, composition.context());
    for (const [path, crop] of [
      [mix.files.path(mixResult.files[0]!.name), 'crop=2:2:960:540'],
      [composition.files.path(compositionResult.files[0]!.name), 'crop=2:2:640:360'],
    ] as const) {
      expect(Math.max(...pixels(path, 0.08, crop))).toBeLessThan(10);
      expect(pixels(path, 0.28, crop)[2]).toBeGreaterThan(220);
    }
  }, 45000);

  it('preserves the video timeline before late original audio starts', async () => {
    const source = join(root, 'late-audio.mp4');
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=160x90:r=25:d=1.2',
      '-itsoffset',
      '0.6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=725:sample_rate=48000:duration=0.38',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      source,
    );
    const fixture = renderFixture(
      root,
      journal,
      'composition.render',
      {
        resolution: '720p',
        durationSeconds: 1.2,
        tracks: [{ kind: 'video', index: 0 }],
        items: [visual(0, 0, 0, 1.2)],
      },
      [source],
    );
    const result = await renderComposition(fixture.command, fixture.context());
    const path = fixture.files.path(result.files[0]!.name);
    expect(tone(audioSamples(path, 0.12, 0.12), 725)).toBeLessThan(50);
    expect(tone(audioSamples(path, 0.68, 0.12), 725)).toBeGreaterThan(1000);
  }, 45000);

  it('uses the effective rotation and SAR once and preserves portrait display axes', async () => {
    const sar = join(root, 'sar.mp4');
    const rotated = join(root, 'rotated.mp4');
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=80x90:r=25:d=0.4',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=80x90:r=25:d=0.4',
      '-filter_complex',
      '[0:v][1:v]hstack,setsar=2/1',
      '-c:v',
      'libx264',
      sar,
    );
    ffmpeg('-display_rotation', '90', '-i', sar, '-c', 'copy', rotated);
    const setup = renderFixture(
      root,
      journal,
      'composition.render',
      {
        resolution: '720p',
        durationSeconds: 0.2,
        tracks: [{ kind: 'video', index: 0 }],
        items: [visual(0, 0, 0, 0.2)],
      },
      [rotated],
    );
    const ctx = setup.context();
    const result = await renderComposition(setup.command, ctx);
    expect(await probeFile('input-0', 'source-display', ctx)).toMatchObject({
      width: 90,
      height: 320,
      sampleAspectRatio: '2:1',
      rotation: 90,
    });
    expect(await probeFile(result.files[0]!.name, 'output-display', ctx)).toMatchObject({
      width: 720,
      height: 2560,
      sampleAspectRatio: '1:1',
      rotation: 0,
    });
    const path = setup.files.path(result.files[0]!.name);
    expect(pixels(path, 0.1, 'crop=2:2:360:500')[2]).toBeGreaterThan(220);
    expect(pixels(path, 0.1, 'crop=2:2:360:2000')[0]).toBeGreaterThan(220);
  }, 45000);

  it('uses fixed seed order and the clip clock despite a longer BGM', async () => {
    const p = {
      seed: 17,
      clips: [
        { inputIndex: 0, startSeconds: 0.1, durationSeconds: 0.14 },
        { inputIndex: 1, startSeconds: 0.1, durationSeconds: 0.22 },
        { inputIndex: 0, startSeconds: 0.3, durationSeconds: 0.01 },
      ],
      bgmInputIndex: 2,
      bgmVolume: 0.8,
    };
    const a = renderFixture(root, journal, 'video.mix', p, [red, blue, voices[0]!]);
    const b = renderFixture(root, journal, 'video.mix', p, [red, blue, voices[0]!]);
    const first = await renderMix(a.command, a.context());
    const second = await renderMix(b.command, b.context());
    const getOrder = (setup: typeof a) =>
      setup.steps
        .filter(({ id }) => id.startsWith('mix-slice'))
        .map(({ args }) => args[args.indexOf('-i') + 1]);
    expect(getOrder(a)).toEqual(getOrder(b));
    expect(getOrder(a)).toEqual(['@file:input-1', '@file:input-0', '@file:input-0']);
    const output = a.files.path(first.files[0]!.name);
    const replay = b.files.path(second.files[0]!.name);
    expect(await a.files.digest(first.files[0]!.name, new AbortController().signal)).toEqual(
      await b.files.digest(second.files[0]!.name, new AbortController().signal),
    );
    const probe = await probeFile(first.files[0]!.name, 'mix-measured', a.context());
    expect(probe).toMatchObject({ width: 1920, height: 1080, hasAudio: true });
    expect(Math.abs(probe.durationSeconds - 0.37)).toBeLessThan(0.035);
    expect(pixels(output, 0.02, 'crop=2:2:900:500')[2]).toBeGreaterThan(220);
    expect(pixels(replay, 0.3, 'crop=2:2:900:500')[0]).toBeGreaterThan(220);
    const samples = audioSamples(output, 0.02, 0.15);
    expect(tone(samples, frequencies[0]!)).toBeGreaterThan(300);
    expect(tone(samples, 440)).toBeLessThan(80);
  }, 45000);

  it('uses the decoded voice track, freezes the last picture, and trims excessive source windows', async () => {
    const fixture = renderFixture(
      root,
      journal,
      'video.narration_render',
      {
        videoInputIndex: 0,
        narrationInputIndex: 1,
        bgmInputIndex: 2,
        bgmVolume: 0.2,
      },
      [blue, voice, voices[1]!],
    );
    const ctx = fixture.context();
    const result = await renderNarration(fixture.command, ctx);
    const meta = await probeFile(result.files[0]!.name, 'actual-narration', ctx);
    const path = fixture.files.path(result.files[0]!.name);
    expect(Math.abs(meta.durationSeconds - 0.73)).toBeLessThan(0.055);
    expect(meta).toMatchObject({ width: 1920, height: 1080, channels: 2, sampleRate: 44100 });
    expect(pixels(path, 0.62, 'crop=2:2:900:500')[2]).toBeGreaterThan(220);
    expect(tone(audioSamples(path, 0.2, 0.2), 721)).toBeGreaterThan(500);

    const invalid = renderFixture(
      root,
      journal,
      'video.mix',
      {
        clips: [{ inputIndex: 0, startSeconds: 0.3, durationSeconds: 0.2 }],
        seed: 1,
      },
      [blue],
    );
    await expect(renderMix(invalid.command, invalid.context())).rejects.toMatchObject({
      code: 'INPUT_INVALID',
    });
    expect(invalid.steps.some(({ id }) => id.startsWith('mix-slice'))).toBe(false);
  }, 45000);

  it('draws different Chinese glyphs with independent background and outline colors', async () => {
    const source = join(root, 'subtitle-base.mp4');
    ffmpeg('-i', red, '-vf', 'scale=640:360', '-c:v', 'libx264', '-c:a', 'copy', source);
    const fixture = renderFixture(
      root,
      journal,
      'subtitle.burn',
      {
        cues: [
          { startSeconds: 0.1, endSeconds: 1, text: '中国' },
          { startSeconds: 1, endSeconds: 1.8, text: '山水' },
        ],
        style: {
          font: 'serif',
          fontSize: 240,
          color: '#ffffff',
          background: '#00ff00',
          outlineColor: '#0000ff',
          outline: 12,
          alignment: 'middle',
        },
      },
      [source],
    );
    const result = await renderSubtitleCommand(fixture.command, fixture.context());
    const output = fixture.files.path(result.files[0]!.name);
    const frame1 = pixels(output, 0.3, 'crop=224:112:208:124');
    const frame2 = pixels(output, 1.3, 'crop=224:112:208:124');
    expect(frame1.equals(frame2)).toBe(false);
    const counts = dominantColors(frame1);
    expect(counts.white).toBeGreaterThan(20);
    expect(counts.green).toBeGreaterThan(120);
    expect(counts.blue).toBeGreaterThan(5);
    expect(dominantColors(pixels(output, 1.9, 'crop=224:112:208:124')).white).toBe(0);
  }, 45000);

  it('renders a 4K still, reuses verified steps after restart, and rejects changed or oversize files', async () => {
    const setup = renderFixture(
      root,
      journal,
      'composition.render',
      {
        resolution: '4k',
        durationSeconds: 0.08,
        tracks: [{ kind: 'video', index: 0 }],
        items: [{ ...visual(0, 0, 0, 0.08), kind: 'image' }],
      },
      [image],
    );
    const result = await renderComposition(setup.command, setup.context());
    const output = result.files[0]!.name;
    expect(await probeFile(output, 'verify-4k', setup.context())).toMatchObject({
      width: 3840,
      height: 2160,
      hasAudio: true,
    });
    const before = statSync(setup.files.path(output)).mtimeMs;
    expect(await renderComposition(setup.command, setup.context())).toEqual(result);
    expect(statSync(setup.files.path(output)).mtimeMs).toBe(before);
    writeFileSync(setup.files.path('composition-slice-0.mp4'), 'changed after checkpoint');
    await expect(renderComposition(setup.command, setup.context())).rejects.toThrow(
      'OUTPUT_MISMATCH',
    );

    const rejected = renderFixture(root, journal, 'composition.render', setup.command.parameters, [
      image,
    ]);
    const large = rejected.files.path('oversize-render.mp4');
    try {
      writeFileSync(large, '');
      truncateSync(large, MEDIA_FILE_LIMIT + 1);
      await expect(renderComposition(rejected.command, rejected.context())).rejects.toThrow(
        'OUTPUT_INVALID',
      );
    } finally {
      rmSync(large, { force: true });
    }
  }, 45000);

  it('kills and reaps a real in-progress 4K composition child on cancel', async () => {
    const cancellation = new AbortController();
    const fixture = renderFixture(
      root,
      journal,
      'composition.render',
      {
        resolution: '4k',
        durationSeconds: 8,
        tracks: [{ kind: 'video', index: 0 }],
        items: [{ ...visual(0, 0, 0, 8), kind: 'image' }],
      },
      [image],
      cancellation.signal,
    );
    const context = fixture.context();
    const run = context.run;
    context.run = async (step) => {
      if (step.id !== 'composition-slice-0') return run(step);
      const running = run(step);
      const cancel = async () => {
        for (let i = 0; i < 200; i++) {
          const active = journal.media.get(fixture.command.attemptId)?.steps[step.id];
          if (active?.state === 'running' && active.pid) {
            cancellation.abort(new Error('CANCELLED'));
            return;
          }
          await delay(5);
        }
        throw new Error('render child did not start');
      };
      const [closed] = await Promise.allSettled([running, cancel()]);
      if (closed.status === 'fulfilled') return closed.value;
      throw closed.reason;
    };
    await expect(renderComposition(fixture.command, context)).rejects.toThrow('CANCELLED');
    const attempt = journal.media.get(fixture.command.attemptId)!;
    const slice = attempt.steps['composition-slice-0']!;
    expect(attempt.steps['probe-input-0']!.state).toBe('complete');
    expect(slice).toMatchObject({ state: 'exited', signal: 'SIGKILL' });
    expect(slice.pid).toBeGreaterThan(0);
    expect(() => process.kill(slice.pid!, 0)).toThrow(/ESRCH/);
  }, 45000);
});
