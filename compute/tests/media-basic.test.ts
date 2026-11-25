import { MEDIA_VERSION } from '@mio/compute-contracts';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaCommand, MediaOperation, MediaParameters } from '@mio/compute-contracts';
import { MEDIA_PROFILE } from '@mio/compute-contracts';
import type { MediaExecutionContext, MediaStep } from '../src/media-execution.ts';
import { MediaFiles } from '../src/adapters/media-files.ts';
import { probeVideoFile } from '../src/adapters/media.ts';
import { Journal } from '../src/adapters/journal.ts';
import { MediaProcessAdapter } from '../src/adapters/media-process.ts';
import { waveform } from '../src/plans/audio.ts';
import { executeBasic } from '../src/plans/basic.ts';
import { probeFile, probeInput } from '../src/plans/probe.ts';

const root = mkdtempSync(join(tmpdir(), 'mio-media-basic-'));
const journal = new Journal(root, 'basic-operations', true);
const video = join(root, 'video.mp4'),
  audio = join(root, 'audio.wav'),
  videoWithLongAudio = join(root, 'audio-tail.mp4'),
  videoWithoutStreamDuration = join(root, 'audio-tail.mkv');
function ffmpeg(args: string[]): void {
  execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-threads', '2', '-filter_threads', '2', ...args],
    { timeout: 30000 },
  );
}
function setup<O extends MediaOperation>(
  operation: O,
  parameters: MediaParameters[O],
  sources = [video],
) {
  const command = {
    version: MEDIA_VERSION,
    type: 'media.request',
    messageId: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    attempt: 1,
    profile: MEDIA_PROFILE,
    operation,
    parameters,
    inputs: sources.map((source) => {
      const assetId = randomUUID();
      return {
        assetId,
        key: `mio/raw/${assetId}/${randomUUID()}`,
        sizeBytes: statSync(source).size,
        etag: 'fixture',
      };
    }),
  } as MediaCommand;
  const files = new MediaFiles(root, command.attemptId);
  sources.forEach((source, i) => copyFileSync(source, files.path(`input-${i}`)));
  const attempt = journal.media.accept(command);
  const steps: MediaStep[] = [];
  const signal = AbortSignal.timeout(60000);
  const adapter = new MediaProcessAdapter(files, journal.media, attempt, signal, () => {});
  const context: MediaExecutionContext = {
    run: async (step) => {
      steps.push(step);
      return adapter.run(step);
    },
  };
  return { command, context, files, steps };
}
beforeAll(() => {
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=10:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v',
    'libx264',
    '-g',
    '10',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    video,
  ]);
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:sample_rate=22050:duration=0.75',
    '-c:a',
    'pcm_s16le',
    audio,
  ]);
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=black:size=160x90:rate=10:duration=1',
    '-f',
    'lavfi',
    '-i',
    'color=white:size=160x90:rate=10:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660:sample_rate=48000:duration=4',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map',
    '[v]',
    '-map',
    '2:a:0',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    videoWithLongAudio,
  ]);
  ffmpeg(['-i', videoWithLongAudio, '-c', 'copy', videoWithoutStreamDuration]);
});
afterAll(() => {
  journal.close();
  rmSync(root, { recursive: true, force: true });
});

describe('real FFmpeg media plans through production process/file adapters', () => {
  it('probes media and keeps the required readonly input step identity', async () => {
    const task = setup('media.probe', {});
    const result = await executeBasic(task.command, task.context);
    expect(result.data.probe).toMatchObject({
      hasAudio: true,
      hasVideo: true,
      width: 320,
      height: 180,
      rotation: 0,
      sampleAspectRatio: '1:1',
      videoCodec: 'h264',
    });
    expect(result.data.probe!.durationSeconds).toBeCloseTo(2, 1);
    expect(await probeVideoFile(video, AbortSignal.timeout(10_000))).toMatchObject({
      width: 320,
      height: 180,
      hasAudio: true,
    });
    expect(task.steps[0]).toMatchObject({ id: 'probe-input-0', capture: 'json', tool: 'ffprobe' });
    expect(task.steps[0]!.args.at(-1)).toBe('@file:input-0');
    await expect(probeInput(64, task.context)).rejects.toMatchObject({ code: 'INPUT_INVALID' });
  });
  it('applies SAR and rotation to display dimensions', async () => {
    const sar = join(root, 'sar.mp4'),
      rotated = join(root, 'rotated.mp4');
    ffmpeg(['-i', video, '-vf', 'setsar=2/1', '-c:v', 'libx264', '-an', sar]);
    ffmpeg(['-display_rotation', '90', '-i', sar, '-c', 'copy', rotated]);
    const task = setup('media.probe', {}, [rotated]);
    expect(await probeInput(0, task.context)).toMatchObject({
      width: 180,
      height: 640,
      rotation: 90,
      sampleAspectRatio: '2:1',
    });
    expect(await probeVideoFile(rotated, AbortSignal.timeout(10_000))).toMatchObject({
      width: 180,
      height: 640,
      hasAudio: false,
    });
    const frameTask = setup('frames.extract', { mode: 'first_last', maxFrames: 1, width: 180 }, [
      rotated,
    ]);
    const frames = await executeBasic(frameTask.command, frameTask.context);
    expect(
      await probeFile(frames.files[0]!.name, 'check-display-frame', frameTask.context),
    ).toMatchObject({ width: 180, height: 640 });
  });
  it('preserves each probe operation’s duration boundary', async () => {
    const source = join(root, 'long-video.mp4');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=black:size=32x32:rate=1:duration=1801',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      source,
    ]);
    const task = setup('media.probe', {}, [source]);
    expect((await executeBasic(task.command, task.context)).data.probe?.durationSeconds).toBe(1801);
    await expect(probeVideoFile(source, AbortSignal.timeout(10_000))).rejects.toMatchObject({
      code: 'SOURCE_INVALID',
    });
  });
  it('rejects malformed media, actual overlong input and source windows beyond EOF', async () => {
    const bad = join(root, 'bad'),
      long = join(root, 'long.wav');
    writeFileSync(bad, 'not media');
    const invalid = setup('media.probe', {}, [bad]);
    await expect(executeBasic(invalid.command, invalid.context)).rejects.toMatchObject({
      code: 'INPUT_INVALID',
    });
    ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=1000:cl=mono', '-t', '3600.1', long]);
    const overlong = setup('media.probe', {}, [long]);
    await expect(executeBasic(overlong.command, overlong.context)).rejects.toMatchObject({
      code: 'INPUT_TOO_LONG',
    });
    for (const [operation, parameters] of [
      ['frames.extract', { mode: 'timestamps', timestamps: [3] }],
      ['video.split', { boundaries: [3] }],
    ] as const) {
      const task = setup(operation, parameters as unknown as MediaParameters[typeof operation]);
      await expect(executeBasic(task.command, task.context)).rejects.toMatchObject({
        code: 'INPUT_INVALID',
      });
      expect(task.steps).toHaveLength(1);
    }
  });
  it.each(['first_last', 'timestamps', 'interval', 'scene'] as const)(
    'extracts bounded %s frames',
    async (mode) => {
      const parameters: MediaParameters['frames.extract'] =
        mode === 'timestamps'
          ? { mode, timestamps: [0, 1] }
          : mode === 'interval'
            ? { mode, intervalSeconds: 0.04, maxFrames: 3 }
            : { mode };
      const task = setup('frames.extract', parameters);
      const result = await executeBasic(task.command, task.context);
      expect(result.files.length).toBeLessThanOrEqual(mode === 'interval' ? 3 : 2);
      if (mode !== 'scene') expect(result.files.length).toBeGreaterThan(0);
      for (const file of result.files) {
        const probe = await probeFile(file.name, `check-${file.name}`, task.context);
        expect(probe).toMatchObject({ videoCodec: 'mjpeg', width: 640, height: 360 });
      }
    },
  );
  it('detects real scene boundaries with minimum spacing', async () => {
    const source = join(root, 'scenes.mp4');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=black:s=160x90:r=10:d=1',
      '-f',
      'lavfi',
      '-i',
      'color=white:s=160x90:r=10:d=1',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      source,
    ]);
    const task = setup('scenes.detect', { threshold: 0.1, minSceneSeconds: 0.5 }, [source]);
    const result = await executeBasic(task.command, task.context);
    expect(result.data.scenes).toHaveLength(1);
    expect(result.data.scenes![0]).toBeCloseTo(1, 1);
  });
  it('rejects excessive frame counts and retains the final decoded frame', async () => {
    const invalid = setup('frames.extract', {
      mode: 'timestamps',
      timestamps: Array.from({ length: 257 }, () => 0),
    });
    await expect(executeBasic(invalid.command, invalid.context)).rejects.toMatchObject({
      code: 'INPUT_INVALID',
    });
    expect(invalid.steps).toHaveLength(0);
    const task = setup('frames.extract', { mode: 'first_last' });
    const result = await executeBasic(task.command, task.context);
    const expected = join(root, 'last.jpg');
    ffmpeg([
      '-i',
      video,
      '-vf',
      'select=eq(n\\,19),scale=640:360,setsar=1',
      '-frames:v',
      '1',
      '-q:v',
      '2',
      expected,
    ]);
    expect(readFileSync(task.files.path(result.files[1]!.name))).toEqual(readFileSync(expected));
  });
  it.each([videoWithLongAudio, videoWithoutStreamDuration])(
    'extracts the real last image when the audio stream outlasts the video in %s',
    async (source) => {
      const task = setup('frames.extract', { mode: 'first_last', width: 80 }, [source]);
      const result = await executeBasic(task.command, task.context);
      expect(result.files.map((file) => file.name)).toEqual(['frame-0.jpg', 'frame-1.jpg']);
      const luminance = result.files.map((file) =>
        execFileSync(
          'ffmpeg',
          [
            '-nostdin',
            '-v',
            'error',
            '-threads',
            '2',
            '-i',
            task.files.path(file.name),
            '-vf',
            'scale=1:1,format=gray',
            '-frames:v',
            '1',
            '-f',
            'rawvideo',
            '-',
          ],
          { timeout: 5000 },
        ),
      );
      expect(luminance.map((frame) => frame.length)).toEqual([1, 1]);
      expect(luminance[0]![0]).toBeLessThan(24);
      expect(luminance[1]![0]).toBeGreaterThan(230);
      expect(task.steps.some((step) => step.id === 'probe-video-packet-end')).toBe(
        source === videoWithoutStreamDuration,
      );
    },
  );
  it('returns true reference trim/scale flags and a playable first 15 seconds', async () => {
    const source = join(root, 'large.mp4');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=red:s=2048x1152:r=2:d=16',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      source,
    ]);
    const task = setup('video.reference_prepare', {}, [source]);
    const result = await executeBasic(task.command, task.context);
    expect(result.data).toEqual({ compressed: true, trimmed: true });
    const probe = await probeFile(result.files[0]!.name, 'check-reference', task.context);
    expect(probe.width).toBe(1920);
    expect(probe.height).toBe(1080);
    expect(probe.durationSeconds).toBeCloseTo(15, 1);
    const small = setup('video.reference_prepare', {});
    expect((await executeBasic(small.command, small.context)).data).toEqual({
      compressed: false,
      trimmed: false,
    });
    expect(small.steps.map((step) => step.tool)).toEqual(['ffprobe']);
    const unchanged = setup('video.reference_prepare', {});
    expect((await executeBasic(unchanged.command, unchanged.context)).files).toEqual([]);
  });
  it('splits by stream copy without promising frame-accurate cuts', async () => {
    const task = setup('video.split', { boundaries: [0.7, 1.4] });
    const result = await executeBasic(task.command, task.context);
    expect(result.files).toHaveLength(3);
    for (const file of result.files)
      expect((await probeFile(file.name, `check-${file.name}`, task.context)).videoCodec).toBe(
        'h264',
      );
    expect(
      task.steps.filter((s) => s.id.startsWith('split')).every((s) => s.args.includes('copy')),
    ).toBe(true);
  });
  it.each(['wav', 'mp3', 'm4a'] as const)('extracts original audio as %s', async (format) => {
    const task = setup('audio.extract', { profile: 'original', format });
    const result = await executeBasic(task.command, task.context);
    const probe = await probeFile(result.files[0]!.name, 'check-audio', task.context);
    expect(probe.hasAudio).toBe(true);
    expect(probe.hasVideo).toBe(false);
  });
  it('extracts ASR PCM as 16k mono and bounds waveform storage/reads', async () => {
    const task = setup('audio.extract', { profile: 'asr' });
    const result = await executeBasic(task.command, task.context);
    expect(await probeFile(result.files[0]!.name, 'check-asr', task.context)).toMatchObject({
      sampleRate: 16000,
      channels: 1,
      audioCodec: 'pcm_s16le',
    });
    const wave = setup('audio.waveform', { points: 4096 });
    const values = (await executeBasic(wave.command, wave.context)).data.waveform!;
    expect(values).toHaveLength(4096);
    expect(wave.steps.at(-1)?.waveform?.points).toBe(4096);
    expect(Math.max(...values)).toBeGreaterThan(0.02);
    expect(values.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
    const longWave = setup('audio.waveform', { points: 1 });
    const onePoint = (await executeBasic(longWave.command, longWave.context)).data.waveform!;
    expect(onePoint).toHaveLength(1);
    expect(onePoint[0]).toBeGreaterThan(0.001);
  });
  it('covers late audio at one, four and ordinary waveform resolutions with bounded reads', async () => {
    const source = join(root, 'late-tone.wav');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=if(lt(t\\,50)\\,0\\,0.8*sin(2*PI*440*t)):s=48000:d=60',
      '-c:a',
      'pcm_f32le',
      source,
    ]);
    for (const points of [1, 4, 1024, 4096]) {
      const task = setup('audio.waveform', { points }, [source]);
      const values = (await executeBasic(task.command, task.context)).data.waveform!;
      expect(values).toHaveLength(points);
      const statistics = task.steps.find((step) => step.id === 'waveform-pcm')!;
      expect(statistics.capture).toBeUndefined();
      expect(statistics.outputs).toBeUndefined();
      expect(statistics.waveform?.points).toBe(points);
      expect(values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(
        true,
      );
      if (points === 1) {
        expect(values[0]).toBeCloseTo(0.8 / Math.sqrt(12), 3);
      } else {
        expect(values[0]).toBe(0);
        expect(values.at(-1)).toBeCloseTo(
          points === 4 ? 0.8 / Math.sqrt(3) : 0.8 / Math.sqrt(2),
          2,
        );
      }
    }
  });
  it('retains high-frequency source energy before aggregation at 192 kHz', async () => {
    const source = join(root, 'high-frequency.wav');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.8*sin(2*PI*40000*t):s=192000:d=2',
      '-c:a',
      'pcm_f32le',
      source,
    ]);
    for (const points of [1, 4, 1024]) {
      const task = setup('audio.waveform', { points }, [source]);
      const values = (await executeBasic(task.command, task.context)).data.waveform!;
      expect(values).toHaveLength(points);
      expect(values.every((value) => Math.abs(value - 0.8 / Math.sqrt(2)) < 0.003)).toBe(true);
    }
  });
  it('measures stereo energy without cancelling opposite phases during waveform analysis', async () => {
    const source = join(root, 'stereo-opposite-phase.wav');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.8*sin(2*PI*440*t)|-0.8*sin(2*PI*440*t):s=48000:d=0.035',
      '-c:a',
      'pcm_f32le',
      source,
    ]);
    const task = setup('audio.waveform', { points: 1 }, [source]);
    const values = (await executeBasic(task.command, task.context)).data.waveform;
    expect(values?.[0]).toBeCloseTo(0.8 / Math.sqrt(2), 2);
  });
  it('caps waveform frames for a one-hour 192 kHz input independently of point count', async () => {
    const task = setup('audio.waveform', { points: 1 }, [audio]);
    const probe = {
      ...(await probeInput(0, task.context)),
      durationSeconds: 3600,
      sampleRate: 192000,
    };
    const plans: MediaStep[] = [];
    for (const points of [1, 4, 4096]) {
      await waveform({ points }, probe, {
        ...task.context,
        run: async (step) => {
          plans.push(step);
          return { stdout: '', diagnostic: '', waveform: Array(points).fill(0) };
        },
      });
    }
    for (const step of plans) {
      const filter = step.args[step.args.indexOf('-af') + 1]!;
      expect(Number(filter.match(/asetnsamples=n=(\d+)/)?.[1])).toBeLessThanOrEqual(1024);
      expect(filter).toContain('astats=metadata=1:reset=1');
      expect(filter).toContain('measure_overall=RMS_level+Number_of_samples');
      expect(filter).not.toContain('aresample');
      expect(step.capture).toBeUndefined();
      expect(step.waveform).toMatchObject({ samples: 691_200_000, frameSamples: 1024 });
      expect(step.args.slice(-3)).toEqual(['-f', 'null', '-']);
    }
  });
  it('remuxes audio against measured source length without padding', async () => {
    const task = setup('audio.remux', {}, [video, audio]);
    const result = await executeBasic(task.command, task.context);
    const probe = await probeFile(result.files[0]!.name, 'check-remux', task.context);
    expect(probe.durationSeconds).toBeCloseTo(2, 1);
    const streams = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_streams', '-of', 'json', task.files.path(result.files[0]!.name)],
        { encoding: 'utf8' },
      ),
    ) as { streams: { codec_type: string; duration: string }[] };
    expect(Number(streams.streams.find((s) => s.codec_type === 'audio')!.duration)).toBeLessThan(1);
    const invalid = setup('audio.remux', { sourceDurationSeconds: 3 }, [video, audio]);
    await expect(executeBasic(invalid.command, invalid.context)).rejects.toMatchObject({
      code: 'INPUT_INVALID',
    });
  });
  it.each([videoWithLongAudio, videoWithoutStreamDuration])(
    'cuts the remux audio at the actual primary video end in %s',
    async (source) => {
      const task = setup('audio.remux', {}, [source, videoWithLongAudio]);
      const result = await executeBasic(task.command, task.context);
      const duration = await probeFile(result.files[0]!.name, 'check-remux-end', task.context);
      expect(duration).toMatchObject({ hasVideo: true, hasAudio: true });
      expect(duration.durationSeconds).toBeCloseTo(2, 1);
      const streams = JSON.parse(
        execFileSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-show_entries',
            'stream=codec_type,duration',
            '-of',
            'json',
            task.files.path(result.files[0]!.name),
          ],
          { encoding: 'utf8' },
        ),
      ) as { streams: { codec_type: 'video' | 'audio'; duration: string }[] };
      expect(streams.streams.map((stream) => stream.codec_type)).toEqual(['video', 'audio']);
      for (const stream of streams.streams) expect(Number(stream.duration)).toBeCloseTo(2, 1);
      const tooLong = setup('audio.remux', { sourceDurationSeconds: 2.5 }, [
        source,
        videoWithLongAudio,
      ]);
      await expect(executeBasic(tooLong.command, tooLong.context)).rejects.toThrow('INPUT_INVALID');
    },
  );
  it('concatenates in input order and offsets subtitles by decoded durations', async () => {
    const task = setup(
      'audio.concat',
      {
        subtitles: [
          { inputIndex: 1, cues: [{ startSeconds: 0, endSeconds: 1, text: 'second' }] },
          { inputIndex: 0, cues: [{ startSeconds: 0, endSeconds: 0.5, text: 'first' }] },
        ],
      },
      [audio, video],
    );
    const result = await executeBasic(task.command, task.context);
    const firstDuration = (await probeFile('concat-0.wav', 'measure-first-concat', task.context))
      .durationSeconds;
    expect(result.data.subtitles).toEqual([
      { startSeconds: 0, endSeconds: 0.5, text: 'first' },
      { startSeconds: firstDuration, endSeconds: 1 + firstDuration, text: 'second' },
    ]);
    const combined = await probeFile(result.files[0]!.name, 'check-concat', task.context);
    expect(combined.durationSeconds).toBeGreaterThanOrEqual(2.75);
    expect(combined.durationSeconds).toBeLessThan(2.8);
    const first = readFileSync(task.files.path('concat-0.wav'));
    const output = readFileSync(task.files.path('concat.wav'));
    const dataOffset = (bytes: Buffer) => bytes.indexOf(Buffer.from('data')) + 8;
    expect(output.subarray(dataOffset(output), dataOffset(output) + 4000)).toEqual(
      first.subarray(dataOffset(first), dataOffset(first) + 4000),
    );
    const bad = setup(
      'audio.concat',
      {
        subtitles: [{ inputIndex: 0, cues: [{ startSeconds: 0, endSeconds: 1, text: 'beyond' }] }],
      },
      [audio],
    );
    await expect(executeBasic(bad.command, bad.context)).rejects.toMatchObject({
      code: 'INPUT_INVALID',
    });
  });
  it.each(['mp4', 'webm', 'gif', 'mp3'] as const)('exports a real %s artifact', async (format) => {
    const task = setup(
      'media.export',
      format === 'mp3' ? { format } : { format, height: 90, fps: 5 },
    );
    const result = await executeBasic(task.command, task.context);
    const probe = await probeFile(result.files[0]!.name, 'check-export', task.context);
    expect(format === 'mp3' ? probe.audioCodec : probe.videoCodec).toBe(
      { mp4: 'h264', webm: 'vp9', gif: 'gif', mp3: 'mp3' }[format],
    );
    if (format !== 'mp3') expect(probe.height).toBe(90);
  });
});
