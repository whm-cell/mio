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
import type {
  VideoProbeCommandV1,
  VideoProbeResultV1,
  WorkerTelemetryEvent,
} from '@mio/compute-contracts';
import { Journal } from '../src/adapters/journal.ts';
import { probePath } from '../src/adapters/media.ts';
import { ResourceSlots } from '../src/resource-slots.ts';
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
  const { promise: confirmed, resolve: confirm } = Promise.withResolvers<void>();
  const slots = new ResourceSlots();
  slots.setLimits({ total: 1, encode: 0, probe: 1 });
  slots.setHold('encode', 'encode-recovery', true);
  slots.setHold('probe', 'media-attempt', true);
  const events: WorkerTelemetryEvent[] = [];
  const unsubscribe = slots.subscribe((message) => events.push(message));
  const downloadVideoProbe = vi.fn(async (command: VideoProbeCommandV1, directory: string) => {
    const destination = probePath(directory, command.messageId);
    copyFileSync(file, destination);
    return destination;
  });
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
      downloadVideoProbe,
    },
    {
      async publish() {},
      async publishVideoProbe(message) {
        event.push(parseVideoProbeResultV1(message));
        await confirmed;
      },
    },
    root,
    slots,
  );
  const ack = vi.fn();
  const duplicateAck = vi.fn();
  const handling = worker.handleVideoProbe(input, ack);
  const duplicate = worker.handleVideoProbe(structuredClone(input), duplicateAck);
  try {
    expect(slots.snapshot().waiting).toEqual({ total: 1, encode: 0, probe: 1 });
    expect(downloadVideoProbe).not.toHaveBeenCalled();
    await expect(
      worker.handleVideoProbe({ ...input, source: { ...input.source, etag: '"other"' } }, vi.fn()),
    ).rejects.toThrow('ATTEMPT_CONFLICT');
    slots.setHold('probe', 'media-attempt', false);
    await vi.waitFor(() => expect(event).toHaveLength(1));
    expect(downloadVideoProbe).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    expect(duplicateAck).not.toHaveBeenCalled();
    const identity = {
      protocol: 'video.probe.v1',
      jobId: input.jobId,
      attemptId: input.attemptId,
      inspectionId: null,
      resource: 'probe',
      slots: 1,
    };
    expect(slots.snapshot()).toMatchObject({
      usage: { total: 1, encode: 0, probe: 1 },
      active: [identity],
      holds: { encode: ['encode-recovery'], probe: [] },
    });
    confirm();
    await Promise.all([handling, duplicate]);
    expect(ack).toHaveBeenCalledOnce();
    expect(duplicateAck).toHaveBeenCalledOnce();
    expect(slots.snapshot()).toMatchObject({
      usage: { total: 0, encode: 0, probe: 0 },
      active: [],
    });
    const executionEvents = events.filter((event) => 'execution' in event);
    expect(executionEvents.map((event) => event.execution)).toEqual(
      Array(6).fill(expect.objectContaining(identity)),
    );
    expect(new Set(executionEvents.map((event) => event.execution.executionId)).size).toBe(1);
    expect(
      executionEvents.map((event) => (event.kind === 'phase' ? event.phase : event.state)),
    ).toEqual(['queued', 'acquired', 'downloading', 'processing', 'finalizing', 'released']);
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
    confirm();
    worker.stop();
    await Promise.allSettled([handling, duplicate]);
    unsubscribe();
    journal.close();
  }
});

it('cleans up on an unconfirmed result, accepts redelivery, and cancels a waiting probe on stop', async () => {
  const root = directory();
  const input = command(fixture(root));
  const journal = new Journal(root, 'probe-test', true);
  const event: VideoProbeResultV1[] = [];
  const publishVideoProbe = vi
    .fn(async (message: VideoProbeResultV1) => {
      event.push(message);
    })
    .mockRejectedValueOnce(new Error('CONFIRM_TIMEOUT'));
  const slots = new ResourceSlots();
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
      publishVideoProbe,
    },
    root,
    slots,
  );
  const ack = vi.fn();
  try {
    await expect(worker.handleVideoProbe(input, ack)).rejects.toThrow('CONFIRM_TIMEOUT');
    expect(ack).not.toHaveBeenCalled();
    expect(existsSync(probePath(root, input.messageId))).toBe(false);
    expect(slots.snapshot().usage.total).toBe(0);

    await worker.handleVideoProbe(input, ack);
    expect(ack).toHaveBeenCalledOnce();
    expect(event[0]).toMatchObject({ state: 'failed', errorCode: 'SOURCE_INVALID' });
    expect(existsSync(probePath(root, input.messageId))).toBe(false);
    slots.setLimits({ total: 0, encode: 0, probe: 0 });
    const pending = worker.handleVideoProbe(input, ack);
    expect(slots.snapshot().waiting.probe).toBe(1);
    worker.stop();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    expect(ack).toHaveBeenCalledOnce();
    expect(slots.snapshot().waiting.probe).toBe(0);
    await worker.waitIdle();
  } finally {
    journal.close();
  }
});
