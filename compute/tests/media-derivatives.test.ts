import { MEDIA_PROFILE, MEDIA_VERSION } from '@mio/compute-contracts';
import type { MediaCommand } from '@mio/compute-contracts';
import type { MediaFileExecutionContext, MediaStep } from '../src/media-execution.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Journal } from '../src/adapters/journal.ts';
import { MediaFiles } from '../src/adapters/media-files.ts';
import { MediaProcessAdapter } from '../src/adapters/media-process.ts';
import { executeDerivatives } from '../src/plans/derivatives.ts';

type DerivativesCommand = Extract<MediaCommand, { operation: 'video.derivatives' }>;
const resources: { root: string; journal: Journal }[] = [];
afterEach(() => {
  for (const { root, journal } of resources.splice(0)) {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function identity(profile: 'ordinary' | 'canvas'): DerivativesCommand {
  const assetId = randomUUID();
  return {
    version: MEDIA_VERSION,
    type: 'media.request',
    messageId: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    attempt: 1,
    profile: MEDIA_PROFILE,
    operation: 'video.derivatives',
    parameters: { profile },
    inputs: [{ assetId, key: `mio/raw/${assetId}/${randomUUID()}`, sizeBytes: 1, etag: 'fixture' }],
  };
}

function setup(
  profile: 'ordinary' | 'canvas',
  size: string,
  seconds: number,
  {
    audio,
    fps = 24,
    sampleRate = 48000,
    audioSignal,
  }: { audio?: number; fps?: number; sampleRate?: number; audioSignal?: string } = {},
) {
  const command = identity(profile);
  const root = mkdtempSync(join(tmpdir(), 'mio-derivatives-test-'));
  const journal = new Journal(root, 'derivatives', true);
  resources.push({ root, journal });
  const files = new MediaFiles(root, command.attemptId);
  const waveform =
    audioSignal === undefined
      ? `sine=frequency=440:sample_rate=${sampleRate}:duration=${audio}`
      : `aevalsrc=${audioSignal}:s=${sampleRate}:d=${audio}`;
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '2',
      '-filter_threads',
      '2',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${size}:rate=${fps}:duration=${seconds}`,
      ...(audio ? ['-f', 'lavfi', '-i', waveform] : []),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '240',
      ...(audio ? ['-c:a', audioSignal === undefined ? 'aac' : 'pcm_s16le'] : []),
      '-f',
      audioSignal === undefined ? 'mp4' : 'mov',
      files.path('input-0'),
    ],
    { timeout: 30000 },
  );
  command.inputs[0]!.sizeBytes = statSync(files.path('input-0')).size;
  journal.media.accept(command);
  const executed: string[] = [];
  function context(): MediaFileExecutionContext {
    const attempt = journal.media.get(command.attemptId)!;
    const signal = AbortSignal.timeout(60000);
    const runner = new MediaProcessAdapter(files, journal.media, attempt, signal, () => {});
    return {
      run: async (step, discover) => {
        if (!attempt.steps[step.id]) executed.push(step.id);
        return runner.run(step, discover);
      },
      read: (name, length) => files.read(name, length),
      write: (name, text) => files.write(name, text),
    };
  }
  return { command, files, journal, executed, context };
}

function rawProbe(name: string): {
  streams: { width: number; height: number; codec_type: string; codec_name: string }[];
} {
  return JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', name], {
      encoding: 'utf8',
    }),
  );
}

function strictPlayback(path: string, seconds: number) {
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'warning',
      '-xerror',
      '-err_detect',
      'explode',
      '-i',
      path,
      '-map',
      '0:V:0',
      '-map',
      '0:a:0?',
      '-stats_period',
      '3600',
      '-progress',
      'pipe:1',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
  expect(result.error).toBeUndefined();
  expect({ status: result.status, diagnostic: result.stderr }).toEqual({
    status: 0,
    diagnostic: '',
  });
  const decoded = result.stdout
    .match(/out_time_us=(\d+)(?=\r?$)/gm)
    ?.at(-1)
    ?.split('=')[1];
  expect(Math.abs(Number(decoded) / 1000000 - seconds)).toBeLessThanOrEqual(0.35);
}

function audioCoverage(path: string) {
  const raw = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'packet=pts_time,dts_time,duration_time',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  const { packets } = JSON.parse(raw) as {
    packets: { pts_time: string; dts_time: string; duration_time: string }[];
  };
  expect(packets.length).toBeGreaterThan(0);
  const first = packets[0]!,
    last = packets.at(-1)!;
  expect(packets.every((packet) => packet.pts_time === packet.dts_time)).toBe(true);
  return { start: Number(first.dts_time), end: Number(last.dts_time) + Number(last.duration_time) };
}

function decodedAudio(path: string): Buffer {
  return execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-xerror',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1',
    ],
    { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
  );
}

function rms(bytes: Buffer, start: number, end: number): number {
  const first = Math.round(start * 48000);
  const last = Math.round(end * 48000);
  let energy = 0;
  for (let index = first; index < last; index++) energy += bytes.readFloatLE(index * 4) ** 2;
  return Math.sqrt(energy / (last - first));
}

const boundarySignal = 'if(between(t\\,6.004\\,6.012)\\,0.7*sin(2*PI*1000*t)\\,0)';

describe('video.derivatives through the safe FFmpeg process adapter', () => {
  it.each([false, true])(
    'packages a small ordinary source at its actual size (audio = %s)',
    async (audio) => {
      const { command, context, files, executed } = setup(
        'ordinary',
        '160x90',
        6.3,
        audio ? { audio: 3 } : {},
      );
      const result = await executeDerivatives(command, context());
      expect(result.files.map((f) => f.name)).toEqual([
        'preview.mp4',
        'poster.jpg',
        'sub-ordinary0.ts',
        'sub-ordinary1.ts',
        'sub-ordinary.m3u8',
        'master.m3u8',
      ]);
      const known = new Set(result.files.map((file) => file.name));
      for (const output of result.files.filter((file) => file.role === 'hls')) {
        const text = readFileSync(files.path(output.name), 'utf8');
        for (const uri of text.split('\n').filter((line) => line && !line.startsWith('#')))
          expect(known.has(uri)).toBe(true);
      }
      const master = readFileSync(files.path('master.m3u8'), 'utf8');
      expect(master).toContain('RESOLUTION=160x90');
      for (const name of ['preview.mp4', 'sub-ordinary1.ts']) {
        const streams = rawProbe(files.path(name)).streams;
        expect(streams.find((stream) => stream.codec_type === 'video')).toMatchObject({
          width: 160,
          height: 90,
        });
        expect(streams.some((stream) => stream.codec_name === 'aac')).toBe(audio);
      }
      const steps = [...executed];
      expect(await executeDerivatives(command, context())).toEqual(result);
      expect(executed).toEqual(steps);
    },
    60000,
  );

  it.each([
    ['ordinary', 4, 48000],
    ['canvas', 2, 16000],
  ] as const)(
    'keeps %s video and AAC aligned at %s fps',
    async (profile, fps, sampleRate) => {
      const { command, context, files } = setup(profile, '960x720', 13, {
        audio: 13,
        fps,
        sampleRate,
      });
      const { files: outputs } = await executeDerivatives(command, context());
      const pieces = outputs.filter((file) => file.role === 'segment');
      expect(pieces).toHaveLength(profile === 'ordinary' ? 3 : 6);
      const playlist = readFileSync(files.path('master.m3u8'), 'utf8');
      expect(playlist).toContain('RESOLUTION=960x720');
      if (profile === 'canvas') expect(playlist).toContain('RESOLUTION=640x480');
      for (const piece of pieces) {
        const streams = rawProbe(files.path(piece.name)).streams;
        expect(streams).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ codec_name: 'h264' }),
            expect.objectContaining({ codec_name: 'aac' }),
          ]),
        );
      }
      for (const sub of outputs.filter(
        (file) => file.name.startsWith('sub-') && file.role === 'hls',
      ))
        strictPlayback(files.path(sub.name), 13);
      if (profile === 'canvas') {
        for (const edge of [720, 480]) {
          const range = pieces
            .filter((piece) => piece.name.startsWith(`seg-${edge}-`))
            .map((piece) => audioCoverage(files.path(piece.name)));
          for (const [index, current] of range.slice(1).entries())
            expect(current.start).toBeCloseTo(range[index]!.end, 5);
        }
      }
    },
    60000,
  );

  it.each([
    ['ordinary', false],
    ['ordinary', true],
    ['canvas', false],
    ['canvas', true],
  ] as const)(
    'publishes a valid sub-second %s target (audio = %s)',
    async (profile, audio) => {
      const { command, context, files, journal } = setup(
        profile,
        '160x90',
        0.25,
        audio ? { audio: 0.25 } : {},
      );
      const result = await executeDerivatives(command, context());
      const sub = result.files.find((file) => file.role === 'hls' && file.name.startsWith('sub-'))!;
      const ts = result.files.find((file) => file.role === 'segment')!;
      const playlist = readFileSync(files.path(sub.name), 'utf8');
      expect(playlist).toContain('#EXT-X-TARGETDURATION:1');
      expect(playlist).toContain('#EXTINF:0.250000,');
      expect(
        rawProbe(files.path(ts.name)).streams.some((stream) => stream.codec_name === 'aac'),
      ).toBe(audio);
      if (profile === 'ordinary') {
        const temporary = readFileSync(files.path('sub-ordinary.ffmpeg'), 'utf8');
        expect(temporary).toContain('#EXTINF:0.250000,');
        expect(result.files.some((file) => file.name.endsWith('.ffmpeg'))).toBe(false);
        const step = journal.media.get(command.attemptId)?.steps['derivatives-hls-ordinary'];
        expect(Object.keys(step?.outputs ?? {})).toEqual([sub.name, ts.name]);
      }
    },
    60000,
  );

  it.each([
    ['ordinary', false],
    ['ordinary', true],
    ['canvas', false],
    ['canvas', true],
  ] as const)(
    'continuously plays a multi-piece %s with a short tail (audio = %s)',
    async (profile, audio) => {
      const { command, context, files } = setup(
        profile,
        '160x90',
        6.25,
        audio ? { audio: 6.25 } : {},
      );
      const result = await executeDerivatives(command, context());
      expect(result.files.filter((file) => file.role === 'segment')).toHaveLength(2);
      const sub = result.files.find((file) => file.name.startsWith('sub-') && file.role === 'hls')!;
      expect(readFileSync(files.path(sub.name), 'utf8')).toContain('#EXTINF:0.250000,');
      strictPlayback(files.path(sub.name), 6.25);
    },
    60000,
  );

  it('retains a tail shorter than the next AAC frame in the preceding canvas piece', async () => {
    const { command, context, files } = setup('canvas', '96x54', 6.01, { audio: 6.01, fps: 100 });
    const result = await executeDerivatives(command, context());
    expect(result.files.filter((file) => file.role === 'segment')).toHaveLength(1);
    expect(readFileSync(files.path('sub-720.m3u8'), 'utf8')).toContain('#EXTINF:6.010000,');
    strictPlayback(files.path('sub-720.m3u8'), 6.01);
  }, 60000);

  it.each([
    [6.008, 1],
    [6.016, 1],
    [6.024, 2],
  ])(
    'preserves boundary samples of a %s-second source across %s canvas pieces',
    async (duration, count) => {
      const { command, context, files, journal } = setup('canvas', '96x54', duration, {
        audio: duration,
        fps: 125,
        audioSignal: boundarySignal,
      });
      const result = await executeDerivatives(command, context());
      const pieces = result.files.filter((file) => file.role === 'segment');
      expect(pieces).toHaveLength(count);
      const sub = files.path('sub-720.m3u8');
      strictPlayback(sub, duration);
      const last = Math.min(6.012, duration);
      const source = rms(decodedAudio(files.path('input-0')), 6.004, last);
      expect(source).toBeGreaterThan(0.45);
      expect(rms(decodedAudio(sub), 6.004, last)).toBeGreaterThan(source * 0.85);
      if (count === 2) {
        expect(audioCoverage(files.path(pieces[0]!.name)).end).toBeCloseTo(6.016, 5);
        expect(audioCoverage(files.path(pieces[1]!.name)).start).toBeCloseTo(6.016, 5);
      }
      const audioStep = journal.media.get(command.attemptId)?.steps['derivatives-canvas-audio'];
      expect(Object.keys(audioStep?.outputs ?? {})).toHaveLength(count + 1);
      expect(result.files.some((file) => file.name.startsWith('canvas-audio-'))).toBe(false);
    },
    60000,
  );

  it.each([
    { title: 'shorter source audio', audio: 1.2, signal: '0.7*sin(2*PI*731.7*t)', silence: true },
    { title: 'silent source audio', audio: 13, signal: '0', silence: true },
    {
      title: 'continuous source audio',
      audio: 13,
      signal: '0.7*sin(2*PI*731.7*t)',
      silence: false,
    },
  ])(
    'preserves timestamps and samples with $title',
    async ({ audio, signal, silence }) => {
      const { command, context, files } = setup('canvas', '96x54', 13, {
        audio,
        fps: 2,
        audioSignal: signal,
      });
      const result = await executeDerivatives(command, context());
      const sub = files.path('sub-720.m3u8');
      strictPlayback(sub, 13);
      const pcm = decodedAudio(sub);
      const original = decodedAudio(files.path('input-0'));
      const ranges = result.files
        .filter((file) => file.role === 'segment')
        .map((file) => audioCoverage(files.path(file.name)));
      for (const [index, next] of ranges.slice(1).entries())
        expect(next.start).toBeCloseTo(ranges[index]!.end, 5);
      for (const time of [5.99, 6, 6.01, 11.99, 12, 12.01]) {
        const level = rms(pcm, time, time + 0.01);
        if (silence) expect(level).toBeLessThan(0.005);
        else expect(level).toBeGreaterThan(rms(original, time, time + 0.01) * 0.85);
      }
      if (audio < 13) expect(rms(pcm, 0.5, 0.6)).toBeGreaterThan(rms(original, 0.5, 0.6) * 0.85);
    },
    60000,
  );

  it('reuses ordinary packaging after interruption before individual segment probes', async () => {
    const { command, files, journal, executed, context } = setup('ordinary', '160x90', 6.3);
    const interrupted = context();
    const run = interrupted.run;
    interrupted.run = async (step, discover) => {
      const result = await run(step, discover);
      if (step.id === 'derivatives-hls-ordinary') throw new Error('INTERRUPTED');
      return result;
    };
    await expect(executeDerivatives(command, interrupted)).rejects.toThrow('INTERRUPTED');
    const checkpoint = journal.media.get(command.attemptId)?.steps['derivatives-hls-ordinary'];
    expect(Object.keys(checkpoint?.outputs ?? {})).toEqual([
      'sub-ordinary.m3u8',
      'sub-ordinary0.ts',
      'sub-ordinary1.ts',
    ]);
    await executeDerivatives(command, context());
    expect(executed.filter((id) => id === 'derivatives-hls-ordinary')).toHaveLength(1);
    writeFileSync(files.path('sub-ordinary1.ts'), 'changed');
    await expect(executeDerivatives(command, context())).rejects.toThrow('OUTPUT_MISMATCH');
  }, 60000);

  it('recovers the last completed canvas piece and deduplicates a smaller source', async () => {
    const { command, files, executed, context } = setup('canvas', '160x90', 6.3, { audio: 6.1 });
    const interrupted = context();
    const run = interrupted.run;
    interrupted.run = async (step, discover) => {
      const result = await run(step, discover);
      if (step.id === 'encode-seg-720-000.ts') throw new Error('INTERRUPTED');
      return result;
    };
    await expect(executeDerivatives(command, interrupted)).rejects.toThrow('INTERRUPTED');
    const result = await executeDerivatives(command, context());
    const names = result.files.filter((file) => file.role === 'segment').map((file) => file.name);
    expect(names).toEqual(['seg-720-000.ts', 'seg-720-001.ts']);
    for (const name of names)
      expect(statSync(files.path(name)).size).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(executed.filter((id) => id === 'encode-seg-720-000.ts')).toHaveLength(1);
    const master = readFileSync(files.path('master.m3u8'), 'utf8');
    expect(master).toContain('RESOLUTION=160x90');
    expect(master).not.toContain('sub-480');
  }, 60000);

  it('publishes two canvas variants for a portrait source', async () => {
    const { command, context, files } = setup('canvas', '720x1280', 0.5);
    await executeDerivatives(command, context());
    for (const [rendition, width, height] of [
      [720, 720, 1280],
      [480, 468, 832],
    ]) {
      const streams = rawProbe(files.path(`seg-${rendition}-000.ts`)).streams;
      expect(streams.find((stream) => stream.codec_type === 'video')).toMatchObject({
        width,
        height,
      });
      expect(readFileSync(files.path('master.m3u8'), 'utf8')).toContain(
        `RESOLUTION=${width}x${height}`,
      );
    }
  }, 60000);
});

function boundedFixture(duration: number, mutate?: (stream: Record<string, unknown>) => void) {
  const steps: MediaStep[] = [];
  const content = new Map<string, string>();
  const context: MediaFileExecutionContext = {
    run: async (step) => {
      steps.push(step);
      let body: object | undefined;
      if (step.id === 'probe-input-0')
        body = {
          format: { duration, format_name: 'mov' },
          streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }],
        };
      else if (step.id === 'probe-video-timing')
        body = { format: { start_time: 0 }, streams: [{ start_time: 0, duration }] };
      else if (step.id.startsWith('verify-')) {
        const segment = /^verify-seg-(720|480)-([0-9]+)\.ts$/.exec(step.id);
        const small = segment?.[1] === '480';
        const seconds = segment ? 6 : duration;
        const stream = {
          codec_type: 'video',
          codec_name: 'h264',
          width: small ? 832 : 1280,
          height: small ? 468 : 720,
          sample_aspect_ratio: '1:1',
          start_time: segment ? Number(segment[2]) * 6 : 0,
          duration: seconds,
        };
        const format = { format_name: segment ? 'mpegts' : 'mp4', duration: seconds, size: 1024 };
        if (segment) mutate?.({ format, stream });
        body = { format, streams: [stream] };
      }
      return { stdout: body ? JSON.stringify(body) : '', diagnostic: '' };
    },
    read: async () => {
      throw new Error('UNEXPECTED_READ');
    },
    write: async (name, text) => {
      content.set(name, String(text));
    },
  };
  return { steps, content, context };
}

describe('canvas policy boundaries', () => {
  it('allows 720 seconds and plans exactly 120 six-second pieces per rendition', async () => {
    const { steps, context, content } = boundedFixture(720);
    const result = await executeDerivatives(identity('canvas'), context);
    const segments = result.files.filter((file) => file.role === 'segment');
    expect(segments).toHaveLength(240);
    expect(segments.at(-1)?.name).toBe('seg-480-119.ts');
    const encoded = steps.filter((step) => step.id.startsWith('encode-seg'));
    expect(encoded.every((step) => step.durationSeconds === 6)).toBe(true);
    expect(content.get('sub-720.m3u8')?.match(/#EXTINF:6\.000000/g)).toHaveLength(120);
  });

  it('rejects a source over 720 seconds before any encoding', async () => {
    const { steps, context } = boundedFixture(720.01);
    await expect(executeDerivatives(identity('canvas'), context)).rejects.toMatchObject({
      code: 'INPUT_TOO_LONG',
    });
    expect(steps.map((step) => step.id)).toEqual(['probe-input-0']);
  });

  it.each([
    { field: 'size', value: 4 * 1024 * 1024 + 1 },
    { field: 'duration', value: 5.64 },
  ])(
    'rejects a TS with invalid $field before any playlist is written',
    async ({ field, value }) => {
      const { context, content } = boundedFixture(6, (probe) => {
        (probe.format as Record<string, unknown>)[field] = value;
      });
      await expect(executeDerivatives(identity('canvas'), context)).rejects.toMatchObject({
        code: 'OUTPUT_INVALID',
      });
      expect(content.size).toBe(0);
    },
  );
});
