import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import type * as Fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  parseVideoProbeCommandV1,
  parseVideoProbeResultV1,
  VIDEO_PROBE_ADMISSION_MS,
  VIDEO_PROBE_EXECUTION_MS,
} from '@mio/compute-contracts';
import type {
  VideoProbeCommandV1,
  VideoProbeResultV1,
  WorkerTelemetryEvent,
} from '@mio/compute-contracts';
import { writeVideoProbeFixture } from '../../tests/support/video-probe-fixtures.ts';
import type { ObjectStore } from '../src/adapters/cos.ts';
import { Journal } from '../src/adapters/journal.ts';
import { drainProbeInput, paths, probePath, requireProbeSpace } from '../src/adapters/media.ts';
import type { Broker } from '../src/adapters/rabbitmq.ts';
import { ResourceSlots } from '../src/resource-slots.ts';
import { Worker } from '../src/worker.ts';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  return { ...fs, statfsSync: vi.fn(fs.statfsSync) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const childProcess = await importOriginal<typeof ChildProcess>();
  return { ...childProcess, spawn: vi.fn(childProcess.spawn) };
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

function runWorkerCommand(root: string, action: 'init' | 'start') {
  const mainUrl = new URL('../src/main.ts', import.meta.url).href;
  const script = `
    process.argv = [process.execPath, 'worker', ${JSON.stringify(action)}];
    await import(${JSON.stringify(mainUrl)});
    process.emit('SIGTERM');
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      PATH: root,
      MIO_COMPUTE_DIRECTORY: root,
      MIO_COMPUTE_INSTANCE_ID: 'probe-test',
      // Broker rejects this protocol locally, before opening any sockets.
      RABBITMQ_URL: 'fixture://worker@127.0.0.1/fixture',
      MIO_COMPUTE_BROKER_USER: 'worker',
      MIO_COMPUTE_EXPECTED_COMMAND_USER: 'app',
      MIO_COS_BUCKET: 'fixture',
      MIO_COS_REGION: 'fixture',
      MIO_COS_SECRET_ID: 'fixture',
      MIO_COS_SECRET_KEY: 'fixture',
    },
  });
}

function fixture(root: string): string {
  return writeVideoProbeFixture(root, 'mp4');
}

function openEndedMedia(file: string) {
  const bytes = readFileSync(file);
  const mediaBox = bytes.lastIndexOf('mdat') - 4;
  expect(mediaBox).toBeGreaterThanOrEqual(0);
  expect(bytes.readUInt32BE(mediaBox)).toBe(bytes.length - mediaBox);
  bytes.writeUInt32BE(0, mediaBox);
  return { bytes, mediaBox };
}

function lastAudioPacketOffset(file: string): number {
  const { packets } = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'packet=pos,size',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8' },
    ),
  ) as { packets: { pos: string; size: string }[] };
  const last = packets.at(-1)!;
  expect(Number(last.pos) + Number(last.size)).toBe(statSync(file).size);
  return Number(last.pos);
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

async function inspectFixture(root: string, file: string) {
  const journal = new Journal(root, 'probe-test', true);
  const slots = new ResourceSlots();
  const input = command(file);
  const events: VideoProbeResultV1[] = [];
  const ack = vi.fn();
  const worker = probeWorker(
    journal,
    root,
    slots,
    (command, directory, signal) =>
      drainProbeInput(
        createReadStream(file),
        directory,
        command.messageId,
        command.source.sizeBytes,
        command.source.sha256,
        signal,
      ),
    async (message) => {
      events.push(parseVideoProbeResultV1(message));
    },
  );
  try {
    await worker.handleVideoProbe(input, ack);
    expect(ack).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toEqual(input.source);
    expect(slots.snapshot().usage.total).toBe(0);
    expect(existsSync(probePath(root, input.messageId))).toBe(false);
    return events[0];
  } finally {
    worker.stop();
    journal.close();
  }
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
  vi.mocked(spawn).mockReset();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('sweeps orphaned probe files only on worker start after acquiring the journal lock', async () => {
  const root = directory();
  const messageId = randomUUID();
  const orphan = probePath(root, messageId);
  const nested = probePath(root, randomUUID());
  const outside = join(directory(), 'outside.media');
  const link = probePath(root, randomUUID());
  mkdirSync(nested);
  const preserved = [
    ...Object.values(paths(root, randomUUID())),
    probePath(nested, randomUUID()),
    join(root, '.video-probe-00000000-0000-1000-8000-000000000000.media'),
    probePath(root, randomUUID()) + '.bak',
    outside,
  ];
  for (const path of preserved) writeFileSync(path, 'keep');
  symlinkSync(outside, link);
  writeFileSync(orphan, 'init marker', { mode: 0o600 });
  const initialized = runWorkerCommand(root, 'init');
  expect(initialized.status, initialized.stderr).toBe(0);
  expect(readFileSync(orphan, 'utf8')).toBe('init marker');

  const journalUrl = new URL('../src/adapters/journal.ts', import.meta.url).href;
  const mediaUrl = new URL('../src/adapters/media.ts', import.meta.url).href;
  const script = `
    import { PassThrough } from 'node:stream';
    import { Journal } from ${JSON.stringify(journalUrl)};
    import { drainProbeInput } from ${JSON.stringify(mediaUrl)};
    const [root, messageId] = process.argv.slice(1);
    const journal = new Journal(root, 'probe-test');
    const input = new PassThrough();
    void drainProbeInput(input, root, messageId, 100, 'a'.repeat(64), new AbortController().signal);
    input.write('in-flight probe bytes');
    process.on('SIGTERM', () => journal.close());
    setInterval(() => {}, 1000);
  `;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', script, root, messageId], {
    env: {},
    stdio: 'ignore',
    timeout: 12_000,
    killSignal: 'SIGKILL',
  });
  const exited = once(owner, 'exit');
  try {
    await vi.waitFor(() => expect(readFileSync(orphan, 'utf8')).toBe('in-flight probe bytes'), {
      timeout: 5_000,
    });
    const contender = runWorkerCommand(root, 'start');
    expect(contender.status, contender.stderr).toBe(1);
    expect(contender.stderr).toContain('WORKER_STARTUP_FAILED');
    expect(readFileSync(orphan, 'utf8')).toBe('in-flight probe bytes');
  } finally {
    owner.kill('SIGKILL');
    await exited;
  }
  expect(await exited).toEqual([null, 'SIGKILL']);

  const restarted = runWorkerCommand(root, 'start');
  expect(restarted.status, restarted.stderr).toBe(0);
  expect(existsSync(orphan)).toBe(false);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  for (const path of preserved) expect(readFileSync(path, 'utf8')).toBe('keep');
  new Journal(root, 'probe-test').close();
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
        container: 'mp4',
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

it.each(['attached-cover', 'truncated-mp4', 'corrupt-mp4', 'mov', '3gp'] as const)(
  'rejects a real %s fixture whose FFprobe header still looks like video',
  async (kind) => {
    const root = directory();
    const file = writeVideoProbeFixture(root, kind);
    const metadata = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type:format=format_name',
        '-of',
        'compact',
        file,
      ],
      { encoding: 'utf8' },
    );
    expect(metadata).toContain('codec_type=video');
    expect(metadata).toContain('format_name=mov,mp4,m4a,3gp,3g2,mj2');
    expect(await inspectFixture(root, file)).toMatchObject({
      state: 'failed',
      errorCode: 'SOURCE_INVALID',
    });
  },
);

it.each(['short', 'missing'] as const)(
  'detects a %s final packet when the MP4 media box is declared to extend to EOF',
  async (damage) => {
    const root = directory();
    const file = fixture(root);
    const { bytes } = openEndedMedia(file);
    const lastPacket = lastAudioPacketOffset(file);
    writeFileSync(file, bytes.subarray(0, damage === 'short' ? lastPacket + 1 : lastPacket));
    expect(await inspectFixture(root, file)).toMatchObject({
      state: 'failed',
      errorCode: 'SOURCE_INVALID',
    });
  },
);

it('checks an open-ended MP4 with edited video start and PCM packets covering multiple samples', async () => {
  const root = directory();
  const file = join(root, 'edited.mp4');
  execFileSync('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-itsoffset',
    '1.75',
    '-i',
    fixture(root),
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=900:sample_rate=48000:duration=4',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'copy',
    '-c:a',
    'pcm_s16le',
    '-movflags',
    '+faststart',
    file,
  ]);
  const cutAt = lastAudioPacketOffset(file);
  const { bytes } = openEndedMedia(file);
  writeFileSync(file, bytes);
  expect(await inspectFixture(directory(), file)).toMatchObject({
    state: 'succeeded',
    media: {
      container: 'mp4',
      width: 320,
      height: 240,
      audioCodec: 'pcm_s16le',
      durationSeconds: 4,
    },
  });
  writeFileSync(file, bytes.subarray(0, cutAt));
  expect(await inspectFixture(directory(), file)).toMatchObject({
    state: 'failed',
    errorCode: 'SOURCE_INVALID',
  });
});

it('checks fragment declarations for a complete or truncated open-ended final MP4 fragment', async () => {
  const root = directory();
  const file = join(root, 'fragmented.mp4');
  execFileSync('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-i',
    fixture(root),
    '-c',
    'copy',
    '-movflags',
    '+frag_keyframe+empty_moov+default_base_moof+skip_trailer',
    file,
  ]);
  const audioTail = lastAudioPacketOffset(file);
  const { bytes, mediaBox } = openEndedMedia(file);
  writeFileSync(file, bytes);
  expect(await inspectFixture(directory(), file)).toMatchObject({
    state: 'succeeded',
    media: { container: 'mp4', width: 320, height: 240, audioCodec: 'aac' },
  });
  for (const cutAt of [audioTail, mediaBox + 8, mediaBox]) {
    writeFileSync(file, bytes.subarray(0, cutAt));
    expect(await inspectFixture(directory(), file)).toMatchObject({
      state: 'failed',
      errorCode: 'SOURCE_INVALID',
    });
  }
});

it('rejects an indexed MP4 that ends before a declared fragment', async () => {
  const root = directory();
  const file = join(root, 'indexed.mp4');
  execFileSync('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-i',
    fixture(root),
    '-c',
    'copy',
    '-movflags',
    '+frag_keyframe+empty_moov+default_base_moof+global_sidx+skip_trailer',
    file,
  ]);
  const bytes = readFileSync(file);
  const fragmentOffsets: number[] = [];
  let hasIndex = false;
  for (let offset = 0; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    expect(size).toBeGreaterThanOrEqual(8);
    expect(offset + size).toBeLessThanOrEqual(bytes.length);
    if (type === 'sidx') hasIndex = true;
    if (type === 'moof') fragmentOffsets.push(offset);
    offset += size;
  }
  expect(hasIndex).toBe(true);
  expect(fragmentOffsets.length).toBeGreaterThanOrEqual(2);
  expect(await inspectFixture(directory(), file)).toMatchObject({
    state: 'succeeded',
    media: { container: 'mp4', width: 320, height: 240 },
  });
  writeFileSync(file, bytes.subarray(0, fragmentOffsets.at(-1)));
  expect(await inspectFixture(directory(), file)).toMatchObject({
    state: 'failed',
    errorCode: 'SOURCE_INVALID',
  });
});

it.each(['mp4', 'corrupt-mp4'] as const)(
  'uses the first non-cover video stream’s absolute index in a multi-video %s file',
  async (kind) => {
    const root = directory();
    const file = join(root, 'multiple.mp4');
    const primary = writeVideoProbeFixture(root, kind);
    execFileSync('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-fflags',
      '+noparse+nofillin',
      '-i',
      primary,
      '-f',
      'lavfi',
      '-i',
      'color=blue:size=96x64:rate=12:duration=0.5',
      '-f',
      'lavfi',
      '-i',
      'color=red:size=32x32:rate=1:duration=1',
      '-map',
      '0:a',
      '-map',
      '0:v',
      '-map',
      '1:v',
      '-map',
      '2:v',
      '-c:a',
      'copy',
      '-c:v:0',
      'copy',
      '-c:v:1',
      'libx264',
      '-c:v:2',
      'mjpeg',
      '-threads',
      '1',
      '-disposition:v:0',
      '0',
      '-disposition:v:1',
      'default',
      '-disposition:v:2',
      'attached_pic',
      '-movflags',
      '+faststart',
      file,
    ]);
    expect(await inspectFixture(root, file)).toMatchObject(
      kind === 'mp4'
        ? { state: 'succeeded', media: { container: 'mp4', width: 320, height: 240 } }
        : { state: 'failed', errorCode: 'SOURCE_INVALID' },
    );
  },
);

it.each(['single-frame', 'fragmented-vfr'] as const)(
  'verifies the selected video’s own tail in a %s MP4',
  async (kind) => {
    const root = directory();
    const file = join(root, 'video.mp4');
    const single = kind === 'single-frame';
    execFileSync('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      single
        ? 'color=black:size=96x64:rate=1:duration=1'
        : 'color=black:size=96x64:rate=12:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=900:sample_rate=48000:duration=4',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-g',
      '6',
      '-c:a',
      'aac',
      '-brand',
      single ? 'mp42' : 'dash',
      ...(single
        ? []
        : [
            '-vf',
            'select=not(between(n\\,4\\,31))',
            '-fps_mode',
            'vfr',
            '-movflags',
            '+frag_keyframe+empty_moov+default_base_moof',
          ]),
      file,
    ]);
    expect(await inspectFixture(root, file)).toMatchObject({
      state: 'succeeded',
      media: {
        container: 'mp4',
        width: 96,
        height: 64,
        hasAudio: true,
        audioCodec: 'aac',
        durationSeconds: expect.closeTo(4, 0),
      },
    });
  },
);

it('kills a running late-decode subprocess and releases its Worker slot and file on stop', async () => {
  const root = directory();
  const file = fixture(root);
  const input = command(file);
  const journal = new Journal(root, 'probe-test', true);
  const slots = new ResourceSlots();
  const publish = vi.fn(async () => {});
  const worker = probeWorker(
    journal,
    root,
    slots,
    async (command, directory) => {
      const destination = probePath(directory, command.messageId);
      copyFileSync(file, destination);
      return destination;
    },
    publish,
  );
  const original = await vi.importActual<typeof ChildProcess>('node:child_process');
  let decoderCount = 0;
  let exited: Promise<unknown[]> | undefined;
  vi.mocked(spawn).mockImplementation((binary, args, options) => {
    const child = original.spawn(binary, args, options);
    if (binary === 'ffmpeg' && ++decoderCount === 2) {
      exited = once(child, 'exit');
      child.once('spawn', () => worker.stop());
    }
    return child;
  });
  const ack = vi.fn();
  try {
    await worker.handleVideoProbe(input, ack);
    expect(decoderCount).toBe(2);
    expect(await exited).toEqual([null, 'SIGKILL']);
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: 'failed', errorCode: 'WORKER_INTERRUPTED' }),
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(slots.snapshot().usage.total).toBe(0);
    expect(existsSync(probePath(root, input.messageId))).toBe(false);
  } finally {
    worker.stop();
    journal.close();
  }
});

it('gives a probe admitted near the queue deadline its full execution budget', async () => {
  const root = directory();
  const file = fixture(root);
  const journal = new Journal(root, 'probe-test', true);
  const slots = new ResourceSlots();
  slots.setHold('probe', 'other-probe', true);
  const finishDownload = Promise.withResolvers<void>();
  const download = vi.fn(async (input: VideoProbeCommandV1, directory: string) => {
    await finishDownload.promise;
    const path = probePath(directory, input.messageId);
    copyFileSync(file, path);
    return path;
  });
  const publish = vi.fn(async () => {});
  const worker = probeWorker(journal, root, slots, download, publish);
  vi.useFakeTimers();
  const input = { ...command(file), admitBy: Date.now() + VIDEO_PROBE_ADMISSION_MS };
  const ack = vi.fn();
  const handling = worker.handleVideoProbe(input, ack);
  try {
    await vi.advanceTimersByTimeAsync(VIDEO_PROBE_ADMISSION_MS - 1);
    expect(download).not.toHaveBeenCalled();
    slots.setHold('probe', 'other-probe', false);
    await vi.advanceTimersByTimeAsync(0);
    expect(download).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(VIDEO_PROBE_EXECUTION_MS - 1);
    expect(publish).not.toHaveBeenCalled();
    finishDownload.resolve();
    await handling;
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ commandId: input.messageId, state: 'succeeded' }),
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(slots.snapshot().usage.total).toBe(0);
    expect(existsSync(probePath(root, input.messageId))).toBe(false);
  } finally {
    finishDownload.resolve();
    worker.stop();
    await Promise.allSettled([handling]);
    vi.useRealTimers();
    journal.close();
  }
});

it.each(['already expired', 'held until timeout', 'granted at deadline'] as const)(
  'publishes a timeout without download when a delivery is %s',
  async (admission) => {
    const root = directory();
    const file = fixture(root);
    const journal = new Journal(root, 'probe-test', true);
    const slots = new ResourceSlots();
    slots.setHold('probe', 'other-probe', true);
    const download = vi.fn();
    const publish = vi.fn(async () => {});
    const worker = probeWorker(journal, root, slots, download, publish);
    vi.useFakeTimers();
    // Most of the admission window was already spent in the broker before delivery.
    const remaining = 100;
    const input = {
      ...command(file),
      admitBy: Date.now() + (admission === 'already expired' ? 0 : remaining),
    };
    const ack = vi.fn();
    const handling = worker.handleVideoProbe(input, ack);
    try {
      if (admission === 'held until timeout') {
        await vi.advanceTimersByTimeAsync(remaining - 1);
        expect(slots.snapshot().waiting.probe).toBe(1);
        expect(publish).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      if (admission === 'granted at deadline') {
        vi.setSystemTime(input.admitBy);
        slots.setHold('probe', 'other-probe', false);
      }
      await handling;
      expect(download).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ commandId: input.messageId, errorCode: 'EXECUTION_TIMEOUT' }),
      );
      expect(ack).toHaveBeenCalledOnce();
      expect(slots.snapshot()).toMatchObject({ waiting: { probe: 0 }, usage: { total: 0 } });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      worker.stop();
      await Promise.allSettled([handling]);
      vi.useRealTimers();
      journal.close();
    }
  },
);

it('aborts the download at the execution deadline and releases the slot and file', async () => {
  const root = directory();
  const file = fixture(root);
  const journal = new Journal(root, 'probe-test', true);
  const slots = new ResourceSlots();
  const input = command(file);
  const path = probePath(root, input.messageId);
  const abort = vi.fn();
  const download = vi.fn(
    async (_input: VideoProbeCommandV1, _root: string, signal: AbortSignal) => {
      copyFileSync(file, path);
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            abort();
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  );
  const publish = vi.fn(async () => {});
  const worker = probeWorker(journal, root, slots, download, publish);
  vi.useFakeTimers();
  const ack = vi.fn();
  const handling = worker.handleVideoProbe(input, ack);
  try {
    await vi.advanceTimersByTimeAsync(VIDEO_PROBE_EXECUTION_MS - 1);
    expect(existsSync(path)).toBe(true);
    expect(slots.snapshot().usage.probe).toBe(1);
    expect(abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await handling;
    expect(abort).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ commandId: input.messageId, errorCode: 'EXECUTION_TIMEOUT' }),
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(existsSync(path)).toBe(false);
    expect(slots.snapshot().usage.total).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    worker.stop();
    await Promise.allSettled([handling]);
    vi.useRealTimers();
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
