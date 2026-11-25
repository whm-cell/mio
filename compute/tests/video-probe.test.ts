import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import type * as Fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseVideoProbeCommandV1, parseVideoProbeResultV1 } from '@mio/compute-contracts';
import type {
  VideoProbeCommandV1,
  VideoProbeResultV1,
  WorkerTelemetryEvent,
} from '@mio/compute-contracts';
import type { ObjectStore } from '../src/adapters/cos.ts';
import { Journal } from '../src/adapters/journal.ts';
import { probePath, requireProbeSpace } from '../src/adapters/media.ts';
import type { Broker } from '../src/adapters/rabbitmq.ts';
import { ResourceSlots } from '../src/resource-slots.ts';
import { Worker } from '../src/worker.ts';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  return { ...fs, statfsSync: vi.fn(fs.statfsSync) };
});

const MIB = 1024 ** 2;
const GIB = 1024 * MIB;
const STATFS_BLOCK_BYTES = 4096;
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

function command(file: string, sizeBytes?: number): VideoProbeCommandV1 {
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
      sizeBytes: sizeBytes ?? bytes.length,
      etag: '"staging-etag"',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  });
}

function probeWorker(
  journal: Journal,
  root: string,
  slots: ResourceSlots,
  downloadVideoProbe: ObjectStore['downloadVideoProbe'],
  publishVideoProbe: Broker['publishVideoProbe'],
): Worker {
  return new Worker(
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
    { async publish() {}, publishVideoProbe },
    root,
    slots,
  );
}

function mockFreeSpace(bytes: number): void {
  const bsize = STATFS_BLOCK_BYTES;
  const bavail = bytes / bsize;
  vi.mocked(statfsSync).mockReturnValue({
    type: 0,
    bsize,
    frsize: bsize,
    bavail,
    bfree: bavail + 1024,
    blocks: (16 * GIB) / bsize,
    files: 0,
    ffree: 0,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(statfsSync).mockReset();
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
  const worker = probeWorker(journal, root, slots, downloadVideoProbe, async (message) => {
    event.push(parseVideoProbeResultV1(message));
    await confirmed;
  });
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
  const worker = probeWorker(
    journal,
    root,
    slots,
    async (command, directory) => {
      const destination = probePath(directory, command.messageId);
      writeFileSync(destination, Buffer.from('not media'));
      return destination;
    },
    publishVideoProbe,
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

it('admits a second download with 128 MiB left in the probe directory budget', async () => {
  const root = directory();
  const file = fixture(directory());
  const first = command(file, 512 * MIB);
  const second = command(file, 512 * MIB);
  const firstPath = probePath(root, first.messageId);
  const journal = new Journal(root, 'probe-test', true);
  const finishFirst = Promise.withResolvers<void>();
  const confirmFirst = Promise.withResolvers<void>();
  const slots = new ResourceSlots({ total: 2, encode: 1, probe: 2 });
  const publish = vi.fn(async (message: VideoProbeResultV1) => {
    if (message.commandId === first.messageId) await confirmFirst.promise;
  });
  const download = vi.fn(async (input: VideoProbeCommandV1, directory: string) => {
    const destination = probePath(directory, input.messageId);
    if (input.messageId === first.messageId) {
      writeFileSync(destination, '');
      truncateSync(destination, 384 * MIB);
      await finishFirst.promise;
      throw new Error('SOURCE_CHANGED');
    }
    copyFileSync(file, destination);
    truncateSync(destination, input.source.sizeBytes);
    return destination;
  });
  const worker = probeWorker(journal, root, slots, download, publish);
  const ballast = join(root, 'existing-media');
  const journalBytes = readdirSync(root).reduce(
    (size, name) => size + statSync(join(root, name)).size,
    0,
  );
  const baseline = 9088 * MIB - journalBytes;
  writeFileSync(ballast, '');
  truncateSync(ballast, baseline);
  mockFreeSpace(4 * GIB);
  const firstAck = vi.fn();
  const pending = worker.handleVideoProbe(first, firstAck);
  const settled = Promise.allSettled([pending]);
  try {
    await vi.waitFor(() => expect(statSync(firstPath).size).toBe(384 * MIB));
    const secondAck = vi.fn();
    await worker.handleVideoProbe(second, secondAck);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ commandId: second.messageId, state: 'succeeded' }),
    );
    expect(secondAck).toHaveBeenCalledOnce();
    expect(firstAck).not.toHaveBeenCalled();

    finishFirst.resolve();
    await vi.waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith(
        expect.objectContaining({ commandId: first.messageId, errorCode: 'SOURCE_CHANGED' }),
      ),
    );
    expect(firstAck).not.toHaveBeenCalled();
    expect(existsSync(firstPath)).toBe(true);

    truncateSync(ballast, baseline + 384 * MIB);
    await worker.handleVideoProbe(second, vi.fn());
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ commandId: second.messageId, errorCode: 'STORAGE_FAILURE' }),
    );
    expect(download).toHaveBeenCalledTimes(2);

    truncateSync(ballast, baseline);
    mockFreeSpace(2 * GIB + second.source.sizeBytes);
    await worker.handleVideoProbe(second, vi.fn());
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ commandId: second.messageId, state: 'succeeded' }),
    );

    confirmFirst.resolve();
    await pending;
    expect(firstAck).toHaveBeenCalledOnce();
    expect(existsSync(firstPath)).toBe(false);
  } finally {
    finishFirst.resolve();
    confirmFirst.resolve();
    worker.stop();
    await settled;
    journal.close();
  }
});

it('caps rounded allocated blocks at the number of written bytes', () => {
  const root = directory();
  const path = probePath(root, randomUUID());
  const written = STATFS_BLOCK_BYTES - 1;
  writeFileSync(path, Buffer.alloc(written, 1), { flush: true });
  expect(statSync(path).blocks * 512).toBeGreaterThan(written);

  const reserved = 512 * MIB;
  const incoming = reserved + written;
  const active = new Map([[path, reserved]]);
  mockFreeSpace(2 * GIB + 2 * reserved);
  expect(() => requireProbeSpace(root, incoming, active)).not.toThrow();
  expect(() => requireProbeSpace(root, incoming + 1, active)).toThrow('DISK_FULL');
});

it('credits only allocated blocks at the free-volume floor and only for the active path', () => {
  const root = directory();
  const messageId = randomUUID();
  const path = probePath(root, messageId);
  const nested = join(root, 'nested');
  mkdirSync(nested);
  writeFileSync(path, Buffer.alloc(STATFS_BLOCK_BYTES, 1), { flush: true });
  truncateSync(path, 384 * MIB);
  const alias = probePath(nested, messageId);
  linkSync(path, alias);
  const allocated = statSync(path).blocks * 512;
  expect(allocated).toBeGreaterThan(0);
  expect(allocated).toBeLessThan(statSync(path).size);

  const reserved = 512 * MIB;
  const incoming = 512 * MIB + (allocated % STATFS_BLOCK_BYTES);
  const atFloor = 2 * GIB + reserved + incoming - allocated;
  const active = new Map([[path, reserved]]);
  mockFreeSpace(atFloor);
  expect(() => requireProbeSpace(root, incoming, active)).not.toThrow();
  mockFreeSpace(atFloor - STATFS_BLOCK_BYTES);
  expect(() => requireProbeSpace(root, incoming, active)).toThrow('DISK_FULL');

  // The same inode has space on the volume, but the active download has no file at its path.
  rmSync(path);
  expect(existsSync(alias)).toBe(true);
  mockFreeSpace(atFloor);
  expect(() => requireProbeSpace(root, incoming, active)).toThrow('DISK_FULL');
});

it('releases a disk-aborted download and waits for its result confirm before the next probe', async () => {
  const root = directory();
  const file = fixture(directory());
  const first = command(file);
  const second = command(file);
  const firstPath = probePath(root, first.messageId);
  const journal = new Journal(root, 'probe-test', true);
  const confirmFirst = Promise.withResolvers<void>();
  const slots = new ResourceSlots();
  const publish = vi.fn(async (message: VideoProbeResultV1) => {
    if (message.commandId === first.messageId) await confirmFirst.promise;
  });
  const download = vi.fn(
    async (input: VideoProbeCommandV1, directory: string, signal: AbortSignal) => {
      const destination = probePath(directory, input.messageId);
      copyFileSync(file, destination);
      if (input.messageId === first.messageId) {
        signal.throwIfAborted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return destination;
    },
  );
  const worker = probeWorker(journal, root, slots, download, publish);
  const firstAck = vi.fn();
  const secondAck = vi.fn();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  mockFreeSpace(4 * GIB);
  const handling = [
    worker.handleVideoProbe(first, firstAck),
    worker.handleVideoProbe(second, secondAck),
  ];
  const settled = Promise.allSettled(handling);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(download).toHaveBeenCalledOnce();
    expect(slots.snapshot().waiting.probe).toBe(1);
    expect(existsSync(firstPath)).toBe(true);

    mockFreeSpace(2 * GIB - STATFS_BLOCK_BYTES);
    await vi.advanceTimersByTimeAsync(4999);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ commandId: first.messageId, errorCode: 'STORAGE_FAILURE' }),
    );
    expect(firstAck).not.toHaveBeenCalled();
    expect(secondAck).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledOnce();
    expect(slots.snapshot().waiting.probe).toBe(1);
    expect(existsSync(firstPath)).toBe(true);

    const secondBlocks = Math.ceil(second.source.sizeBytes / STATFS_BLOCK_BYTES);
    mockFreeSpace(2 * GIB + secondBlocks * STATFS_BLOCK_BYTES);
    confirmFirst.resolve();
    await Promise.all(handling);
    expect(firstAck).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledTimes(2);
    expect(firstAck.mock.invocationCallOrder[0]).toBeLessThan(
      download.mock.invocationCallOrder[1]!,
    );
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ commandId: second.messageId, state: 'succeeded' }),
    );
    expect(secondAck).toHaveBeenCalledOnce();
    expect(existsSync(firstPath)).toBe(false);
    expect(existsSync(probePath(root, second.messageId))).toBe(false);
    expect(slots.snapshot().usage.probe).toBe(0);
  } finally {
    confirmFirst.resolve();
    worker.stop();
    await settled;
    vi.useRealTimers();
    journal.close();
  }
});
