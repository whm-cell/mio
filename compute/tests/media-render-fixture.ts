import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, statSync } from 'node:fs';
import { MEDIA_PROFILE, MEDIA_VERSION, parseMediaCommand } from '@mio/compute-contracts';
import type { MediaCommand, MediaOperation, MediaParameters } from '@mio/compute-contracts';
import type { Journal } from '../src/adapters/journal.ts';
import { MediaFiles } from '../src/adapters/media-files.ts';
import { MediaProcessAdapter } from '../src/adapters/media-process.ts';
import type { MediaFileExecutionContext, MediaStep } from '../src/media-execution.ts';

export function ffmpeg(...args: string[]): Buffer {
  return execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-threads',
      '2',
      '-filter_threads',
      '2',
      '-filter_complex_threads',
      '2',
      ...args,
    ],
    { timeout: 15000, maxBuffer: 9 * 1024 ** 2 },
  );
}

export function renderFixture<O extends MediaOperation>(
  root: string,
  journal: Journal,
  operation: O,
  parameters: MediaParameters[O],
  sources: string[],
  signal = AbortSignal.timeout(60000),
) {
  const command = parseMediaCommand({
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
        etag: 'local-fixture',
      };
    }),
  }) as Extract<MediaCommand, { operation: O }>;
  const files = new MediaFiles(root, command.attemptId);
  sources.forEach((source, index) => copyFileSync(source, files.path(`input-${index}`)));
  const attempt = journal.media.accept(command);
  const steps: MediaStep[] = [];
  const context = (): MediaFileExecutionContext => {
    const current = journal.media.get(command.attemptId) ?? attempt;
    const process = new MediaProcessAdapter(files, journal.media, current, signal, () => {});
    return {
      run: (step, discover) => {
        steps.push(step);
        return process.run(step, discover);
      },
      read: (name, limit) => files.read(name, limit),
      write: (name, value) => files.write(name, value),
    };
  };
  return { command, files, steps, context, attempt };
}

export function pixels(file: string, time: number, crop: string): Buffer {
  return ffmpeg(
    '-ss',
    String(time),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    `format=rgb24,${crop}`,
    '-c:v',
    'rawvideo',
    '-threads',
    '2',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  );
}

export function pixel(frame: Buffer, width: number, x: number, y: number): number[] {
  return [...frame.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
}

export function audioSamples(file: string, time: number, seconds: number): Buffer {
  return ffmpeg(
    '-ss',
    String(time),
    '-i',
    file,
    '-t',
    String(seconds),
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    '8000',
    '-f',
    's16le',
    '-',
  );
}

// Project onto one sine/cosine pair so overlapping audio fixtures remain distinguishable.
export function tone(samples: Buffer, frequency: number): number {
  let real = 0;
  let imag = 0;
  for (let i = 0; i < samples.length / 2; i++) {
    const value = samples.readInt16LE(i * 2);
    const angle = (2 * Math.PI * frequency * i) / 8000;
    real += value * Math.cos(angle);
    imag += value * Math.sin(angle);
  }
  return Math.hypot(real, imag) / (samples.length / 4);
}

export function dominantColors(frame: Buffer): {
  red: number;
  green: number;
  blue: number;
  white: number;
} {
  const counts = { red: 0, green: 0, blue: 0, white: 0 };
  for (let i = 0; i < frame.length; i += 3) {
    const [r, g, b] = [frame[i]!, frame[i + 1]!, frame[i + 2]!];
    if (r > 160 && g < 85 && b < 85) counts.red++;
    if (g > 125 && r < 100 && b < 100) counts.green++;
    if (b > 150 && r < 85 && g < 85) counts.blue++;
    if (r > 200 && g > 200 && b > 200) counts.white++;
  }
  return counts;
}

export function videoPacketTimes(file: string): { presentation: number; decode: number }[] {
  const json = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'V:0',
      '-show_entries',
      'packet=pts_time,dts_time',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 },
  );
  const { packets } = JSON.parse(json) as { packets: { pts_time: string; dts_time: string }[] };
  return packets.map((packet) => ({
    presentation: Number(packet.pts_time),
    decode: Number(packet.dts_time),
  }));
}
