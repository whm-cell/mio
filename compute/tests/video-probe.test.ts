import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseVideoProbeCommandV1, parseVideoProbeResultV1 } from '@mio/compute-contracts';
import type { VideoProbeCommandV1, VideoProbeResultV1 } from '@mio/compute-contracts';
import { Journal } from '../src/adapters/journal.ts';
import { probePath } from '../src/adapters/media.ts';
import { Worker } from '../src/worker.ts';

const directories: string[] = [];

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'mio-video-probe-'));
  directories.push(path);
  return path;
}

function fixture(root: string): string {
  const path = join(root, 'fixture.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=black:size=320x240:rate=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:sample_rate=48000',
    '-t',
    '1.25',
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    path,
  ]);
  return path;
}

function command(file: string): VideoProbeCommandV1 {
  const jobId = randomUUID();
  const outputIndex = 0;
  const attemptId = randomUUID();
  const bytes = readFileSync(file);
  return parseVideoProbeCommandV1({
    version: 1,
    type: 'video.probe',
    messageId: randomUUID(),
    jobId,
    outputIndex,
    attemptId,
    attempt: 1,
    source: {
      stagingKey: `mio/staging/video/${jobId}/${outputIndex}/${attemptId}.media`,
      sizeBytes: bytes.length,
      etag: '"staging-etag"',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('accepts only a small v1 identity envelope with a fixed private staging key', () => {
  const input = command(fixture(directory()));
  expect(parseVideoProbeCommandV1(input)).toEqual(input);
  expect(() =>
    parseVideoProbeCommandV1({
      ...input,
      source: { ...input.source, stagingKey: 'https://example.invalid/video.mp4' },
    }),
  ).toThrow('COMPUTE_MESSAGE_INVALID');
  expect(() => parseVideoProbeCommandV1({ ...input, credential: 'never-forward-this' })).toThrow(
    'COMPUTE_MESSAGE_INVALID',
  );
});

it('probes the streamed local file and returns source identity and media metadata', async () => {
  const root = directory();
  const file = fixture(root);
  const input = command(file);
  const journal = new Journal(root, 'probe-test', true);
  const event: VideoProbeResultV1[] = [];
  const worker = new Worker(
    journal,
    {
      async download() {},
      async head() {
        return null;
      },
      async verify() {
        return false;
      },
      async upload() {},
      async downloadVideoProbe(command, directory) {
        const destination = probePath(directory, command.messageId);
        copyFileSync(file, destination);
        return destination;
      },
    },
    {
      async publish() {},
      async publishVideoProbe(message) {
        event.push(parseVideoProbeResultV1(message));
      },
    },
    root,
  );
  const ack = vi.fn();
  try {
    await worker.handleVideoProbe(input, ack);
    expect(ack).toHaveBeenCalledOnce();
    expect(event).toHaveLength(1);
    expect(event[0]).toMatchObject({
      version: 1,
      type: 'video.probe.result',
      commandId: input.messageId,
      jobId: input.jobId,
      outputIndex: input.outputIndex,
      attemptId: input.attemptId,
      attempt: input.attempt,
      source: input.source,
      state: 'succeeded',
      media: {
        container: expect.stringContaining('mp4'),
        videoCodec: 'h264',
        width: 320,
        height: 240,
        hasAudio: true,
        audioCodec: 'aac',
      },
    });
    expect(event[0]?.state === 'succeeded' ? event[0].media.durationSeconds : 0).toBeCloseTo(1.25);
    expect(statSync(file).size).toBe(input.source.sizeBytes);
    expect(existsSync(probePath(root, input.messageId))).toBe(false);
    expect(journal.get(input.attemptId)).toBeNull();
  } finally {
    journal.close();
  }
});

it('publishes a bounded failure result and removes the temporary file on invalid media', async () => {
  const root = directory();
  const input = command(fixture(root));
  const journal = new Journal(root, 'probe-test', true);
  const event: VideoProbeResultV1[] = [];
  const worker = new Worker(
    journal,
    {
      async download() {},
      async head() {
        return null;
      },
      async verify() {
        return false;
      },
      async upload() {},
      async downloadVideoProbe(command, directory) {
        const destination = probePath(directory, command.messageId);
        writeFileSync(destination, Buffer.from('not media'));
        return destination;
      },
    },
    {
      async publish() {},
      async publishVideoProbe(message) {
        event.push(message);
      },
    },
    root,
  );
  const ack = vi.fn();
  try {
    await worker.handleVideoProbe(input, ack);
    expect(ack).toHaveBeenCalledOnce();
    expect(event[0]).toMatchObject({ state: 'failed', errorCode: 'SOURCE_INVALID' });
    expect(existsSync(probePath(root, input.messageId))).toBe(false);
  } finally {
    journal.close();
  }
});
