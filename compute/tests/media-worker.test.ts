import { MEDIA_VERSION } from '@mio/compute-contracts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_PROFILE } from '@mio/compute-contracts';
import type { MediaCommand, MediaControl, MediaResult } from '@mio/compute-contracts';
import { Journal } from '../src/adapters/journal.ts';
import { Broker } from '../src/adapters/rabbitmq.ts';
import { runMediaRuntime } from '../src/media-runtime.ts';
import { MediaWorker, reserveMediaProcesses } from '../src/media-worker.ts';
import type { MediaStore } from '../src/media-worker.ts';
import type { MediaExecutor } from '../src/media-execution.ts';
import { ResourceSlots } from '../src/resource-slots.ts';
import type { MediaFiles } from '../src/adapters/media-files.ts';
import type { MediaDigest } from '../src/adapters/media-journal.ts';
const roots: string[] = [];
const journals: Journal[] = [];
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function wav(): Buffer {
  const data = Buffer.alloc(44 + 3200);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24);
  data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(data.length - 44, 40);
  return data;
}
class Store implements MediaStore {
  readonly objects = new Map<string, Buffer>();
  readonly puts: string[] = [];
  readonly input = wav();
  unknown = false;
  saveUnknown = true;
  async downloadMedia(_input: unknown, files: MediaFiles, name: string, signal: AbortSignal) {
    await files.receive(name, Readable.from(this.input), this.input.length, signal);
  }
  async uploadMedia(
    key: string,
    files: MediaFiles,
    name: string,
    _digest: MediaDigest,
    _contentType: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.puts.push(key);
    if (!this.unknown || this.saveUnknown) this.objects.set(key, readFileSync(files.path(name)));
    if (this.unknown) {
      this.unknown = false;
      throw new Error('UPLOAD_UNKNOWN');
    }
  }
  async headMedia(key: string) {
    const value = this.objects.get(key);
    return value ? { sizeBytes: value.length, sha256: hash(value), etag: '"etag"' } : null;
  }
  async verifyMedia(key: string, _etag: string, size: number, sha: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const value = this.objects.get(key);
    return Boolean(value && value.length === size && hash(value) === sha);
  }
}
const execute: MediaExecutor = async (_command, context) => {
  const file = { name: 'audio.wav', role: 'audio' as const, contentType: 'audio/wav' };
  await context.run({
    id: 'encode',
    tool: 'ffmpeg',
    outputs: [file],
    args: ['-v', 'error', '-i', '@file:input-0', '-c:a', 'pcm_s16le', '@file:audio.wav'],
  });
  return { files: [file], data: {} };
};
function fixture(executor: MediaExecutor = execute, failed: (error: unknown) => void = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mio-media-worker-'));
  roots.push(directory);
  const journal = new Journal(directory, 'worker-test', true);
  journals.push(journal);
  const store = new Store(),
    events: MediaResult[] = [],
    slots = new ResourceSlots(),
    stop = new AbortController();
  const publisher = {
    publishMedia: vi.fn(async (event: MediaResult) => {
      events.push(event);
    }),
  };
  const worker = new MediaWorker(
    store,
    publisher,
    journal,
    directory,
    executor,
    stop.signal,
    slots,
    failed,
  );
  const assetId = randomUUID();
  const command: MediaCommand = {
    version: MEDIA_VERSION,
    type: 'media.request',
    messageId: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    attempt: 1,
    profile: MEDIA_PROFILE,
    operation: 'audio.extract',
    inputs: [
      {
        assetId,
        key: `mio/raw/${assetId}/${randomUUID()}`,
        sizeBytes: store.input.length,
        etag: '"snapshot"',
      },
    ],
    parameters: { profile: 'asr', format: 'wav' },
  };
  const control = (action: 'cancel' | 'recover' = 'cancel'): MediaControl => ({
    version: MEDIA_VERSION,
    type: 'media.control',
    messageId: randomUUID(),
    jobId: command.jobId,
    attemptId: command.attemptId,
    action,
  });
  return { directory, journal, store, events, slots, stop, publisher, worker, command, control };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const journal of journals.splice(0)) journal.close();
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});
describe('durable media execution', () => {
  it('uploads each artifact and the manifest last, confirms durable events before ACK, and deduplicates command replay', async () => {
    const { worker, command, store, events, journal, directory } = fixture();
    const ack = vi.fn(() => expect(events.at(-1)?.state).toBe('succeeded'));
    await worker.handle(command, ack);
    expect(ack).toHaveBeenCalledOnce();
    expect(store.puts.map((key) => key.split('/').at(-1))).toEqual(['audio.wav', 'manifest.json']);
    const manifest = JSON.parse(store.objects.get(store.puts.at(-1)!)!.toString());
    expect(manifest.files[0].sha256).toBe(hash(store.objects.get(store.puts[0]!)!));
    expect(journal.media.pending(command.attemptId)).toBeNull();
    expect(journal.media.get(command.attemptId)!.cleaned).toBe(true);
    expect(existsSync(join(directory, `media-${command.attemptId}`))).toBe(false);
    await worker.handle(command, ack);
    expect(store.puts).toHaveLength(2);
    expect(ack).toHaveBeenCalledTimes(2);
    // Same SQLite handle still serves v1; media creation does not replace its tables.
    expect(journal.get(randomUUID())).toBeNull();
    expect(existsSync(join(directory, 'journal.sqlite3'))).toBe(true);
  });
  it('persists control before command and cancels without downloading or launching', async () => {
    const { worker, control, command, journal, events, store } = fixture();
    const download = vi.spyOn(store, 'downloadMedia'),
      ack = vi.fn();
    await worker.control(control(), ack);
    expect(journal.media.cancelled(command.attemptId)).toBe(true);
    await worker.handle(command, ack);
    expect(events.at(-1)?.state).toBe('cancelled');
    expect(download).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(2);
  });
  it('cancels a real running FFmpeg and emits cancelled only after reap; recovery ignores the live attempt', async () => {
    const slow: MediaExecutor = async (_command, context) => {
      await context.run({
        id: 'slow',
        tool: 'ffmpeg',
        args: ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'sine=duration=30', '-f', 'null', '-'],
      });
      return { files: [], data: {} };
    };
    const { worker, command, control, journal, events } = fixture(slow);
    const ack = vi.fn(),
      running = worker.handle(command, ack);
    await vi.waitFor(() =>
      expect(journal.media.get(command.attemptId)?.steps.slow?.state).toBe('running'),
    );
    const pid = journal.media.get(command.attemptId)!.steps.slow!.pid!;
    await worker.recover();
    expect(journal.media.get(command.attemptId)!.phase).toBe('executing');
    await worker.control(control(), () => {});
    await running;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(events.at(-1)?.state).toBe('cancelled');
    expect(ack).toHaveBeenCalledOnce();
  });
  it('keeps an ambiguous PUT and files, reconciles it without overwriting and publishes manifest last', async () => {
    const { worker, command, store, journal, events, directory, control } = fixture();
    store.unknown = true;
    await worker.handle(command, () => {});
    expect(events.at(-1)).toMatchObject({ state: 'reconciling', errorCode: 'UPLOAD_UNKNOWN' });
    expect(existsSync(join(directory, `media-${command.attemptId}`, 'audio.wav'))).toBe(true);
    expect(store.puts).toHaveLength(1);
    await worker.control(control('recover'), () => {});
    await worker.recover();
    expect(store.puts.map((key) => key.split('/').at(-1))).toEqual(['audio.wav', 'manifest.json']);
    expect(journal.media.get(command.attemptId)!.phase).toBe('succeeded');
  });
  it('does not repeat an unknown PUT after a negative HEAD, including command redelivery', async () => {
    const { worker, command, store, events, control } = fixture();
    store.unknown = true;
    store.saveUnknown = false;
    await worker.handle(command, () => {});
    await worker.control(control('recover'), () => {});
    await worker.recover();
    await worker.handle(command, () => {});
    expect(store.puts).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ state: 'reconciling', errorCode: 'UPLOAD_UNKNOWN' });
  });
  it('keeps digest conflicts reconciling, and refuses a changed input snapshot', async () => {
    const { worker, command, store, events, control } = fixture();
    store.unknown = true;
    await worker.handle(command, () => {});
    store.objects.set(store.puts[0]!, Buffer.from('conflicting'));
    await worker.control(control('recover'), () => {});
    await worker.recover();
    expect(events.at(-1)).toMatchObject({ state: 'reconciling', errorCode: 'OUTPUT_MISMATCH' });
    await expect(
      worker.handle({ ...command, inputs: [{ ...command.inputs[0]!, etag: 'changed' }] }, () => {}),
    ).rejects.toThrow('ATTEMPT_CONFLICT');
    expect(store.puts).toHaveLength(1);
  });
  it('retains unconfirmed events, never ACKs on publisher failure, and replays without another encode or PUT', async () => {
    const { worker, command, publisher, journal, store } = fixture();
    publisher.publishMedia.mockRejectedValue(new Error('CONFIRM_FAILED'));
    const ack = vi.fn();
    await expect(worker.handle(command, ack)).rejects.toThrow('CONFIRM_FAILED');
    expect(ack).not.toHaveBeenCalled();
    expect(journal.media.pending(command.attemptId)).not.toBeNull();
    const puts = store.puts.length;
    publisher.publishMedia.mockResolvedValue();
    await worker.handle(command, ack);
    expect(ack).toHaveBeenCalledOnce();
    expect(store.puts).toHaveLength(puts);
    expect(journal.media.pending(command.attemptId)).toBeNull();
  });
  it('uses shared encode/probe slots, preserving a reserved legacy encode slot', async () => {
    const { worker, command, slots, journal } = fixture();
    const legacy = slots.acquire('encode')!;
    const ack = vi.fn(),
      work = worker.handle(command, ack);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(journal.media.get(command.attemptId)!.phase).toBe('received');
    expect(slots.available('probe')).toBe(true);
    legacy();
    await work;
    expect(ack).toHaveBeenCalledOnce();
    expect(slots.available('encode')).toBe(true);
  });
  it('cancels an admitted command waiting for a resource without waiting for another encode', async () => {
    const { worker, command, control, slots, journal, events, store } = fixture();
    const release = slots.acquire('encode')!;
    const download = vi.spyOn(store, 'downloadMedia');
    const running = worker.handle(command, () => {});
    try {
      await vi.waitFor(() => expect(journal.media.get(command.attemptId)).not.toBeNull());
      await worker.control(control(), () => {});
      await running;
      expect(events.at(-1)?.state).toBe('cancelled');
      expect(download).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
  it('reuses verified completed steps in a new attempt after a confirmed interruption', async () => {
    let interrupted = true;
    const executor: MediaExecutor = async (command, context) => {
      const result = await execute(command, context);
      if (interrupted) throw new Error('WORKER_INTERRUPTED');
      return result;
    };
    const { worker, command, journal, store, events } = fixture(executor);
    const download = vi.spyOn(store, 'downloadMedia');
    await worker.handle(command, () => {});
    expect(events.at(-1)).toMatchObject({ state: 'failed', errorCode: 'WORKER_INTERRUPTED' });
    const checkpoint = journal.media.get(command.attemptId)!.steps.encode!;
    interrupted = false;
    const retry = {
      ...command,
      attempt: 2 as const,
      attemptId: randomUUID(),
      messageId: randomUUID(),
    };
    await worker.handle(retry, () => {});
    const reused = journal.media.get(retry.attemptId)!.steps.encode!;
    expect(reused).toMatchObject({ pid: checkpoint.pid, reusedFromAttemptId: command.attemptId });
    expect(events.at(-1)?.state).toBe('succeeded');
    expect(download).toHaveBeenCalledOnce();
  });
  it('retains a modified checkpoint for reconciliation instead of reencoding or uploading', async () => {
    const executor: MediaExecutor = async (command, context) => {
      await execute(command, context);
      throw new Error('WORKER_INTERRUPTED');
    };
    const { worker, command, journal, directory, events, store } = fixture(executor);
    await worker.handle(command, () => {});
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(directory, `media-${command.attemptId}`, 'audio.wav'), 'tampered');
    const retry = {
      ...command,
      attempt: 2 as const,
      attemptId: randomUUID(),
      messageId: randomUUID(),
    };
    await worker.handle(retry, () => {});
    expect(events.at(-1)).toMatchObject({ state: 'reconciling', errorCode: 'OUTPUT_MISMATCH' });
    expect(journal.media.get(retry.attemptId)!.phase).toBe('reconciling');
    expect(store.puts).toHaveLength(0);
  });
  it('holds an orphan process slot across cancel/redelivery until an explicit no-PID resolution', async () => {
    const { worker, command, journal, slots, events, control, store } = fixture();
    const attempt = journal.media.accept(command);
    const step = { id: 'orphan', tool: 'ffmpeg' as const, args: ['-version'] };
    const { mediaIdentity } = await import('../src/adapters/media-journal.ts');
    attempt.phase = 'executing';
    attempt.steps.orphan = {
      step,
      identity: mediaIdentity(step),
      state: 'intent',
      pid: null,
      processIdentity: null,
      exitCode: null,
      signal: null,
      outputs: {},
      result: null,
    };
    journal.media.save(attempt);
    reserveMediaProcesses(journal.media, slots);
    expect(slots.available('encode')).toBe(false);
    expect(slots.available('probe')).toBe(true);
    await worker.recover();
    await worker.control(control(), () => {});
    await worker.recover();
    expect(events.at(-1)).toMatchObject({ state: 'reconciling', errorCode: 'PROCESS_UNKNOWN' });
    expect(slots.available('encode')).toBe(false);
    expect(store.puts).toHaveLength(0);
    expect(() => journal.media.resolveNoPid(command.attemptId, '')).toThrow('EVIDENCE_REQUIRED');
    journal.media.resolveNoPid(
      command.attemptId,
      'Operator confirmed all processes in the owning runtime terminated',
    );
    await worker.recover();
    expect(events.at(-1)?.state).toBe('cancelled');
    expect(slots.available('encode')).toBe(true);
    expect(() => journal.media.resolveNoPid(command.attemptId, 'Repeated confirmation')).toThrow(
      'NOT_APPLICABLE',
    );
  });
  it('settles a pre-cancelled command while another attempt blocks its resource', async () => {
    const { worker, command, control, slots, journal, events, store } = fixture();
    slots.setHold('encode', 'unresolved-other-attempt', true);
    const download = vi.spyOn(store, 'downloadMedia');
    await worker.control(control(), () => {});
    const ack = vi.fn();
    await worker.handle(command, ack);
    expect(ack).toHaveBeenCalledOnce();
    expect(events.at(-1)?.state).toBe('cancelled');
    expect(journal.media.get(command.attemptId)?.phase).toBe('cancelled');
    expect(download).not.toHaveBeenCalled();
    expect(slots.available('encode')).toBe(false);
  });
  it('accepts cancellation during startup reconciliation without a second recovery of the attempt', async () => {
    const { command, control, worker, journal, store, directory, slots, stop, events } = fixture();
    store.unknown = true;
    await worker.handle(command, () => {});
    expect(journal.media.get(command.attemptId)?.phase).toBe('reconciling');
    let onControl: ((control: MediaControl, ack: () => void) => Promise<void>) | undefined;
    const verify = vi
      .spyOn(store, 'verifyMedia')
      .mockImplementation(async (_key, _etag, _size, _sha, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        });
        return true;
      });
    const broker = {
      publishMedia: async (event: MediaResult) => {
        events.push(event);
      },
      consumeMediaControl: vi.fn(async (handler) => {
        onControl = handler;
      }),
      consumeMedia: vi.fn(async () => {}),
      closed: () => new Promise<void>(() => {}),
      close: vi.fn(async () => {}),
    };
    vi.spyOn(Broker, 'connect').mockResolvedValue(broker as unknown as Broker);
    const runtime = runMediaRuntime(
      { url: 'amqp://unused', userId: 'b', expectedUserId: 'a', directory },
      store,
      journal,
      execute,
      stop.signal,
      slots,
    );
    try {
      await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
      expect(onControl).toBeTypeOf('function');
      await onControl!(control('recover'), () => {});
      expect(verify).toHaveBeenCalledOnce();
      const ack = vi.fn();
      await onControl!(control(), ack);
      expect(ack).toHaveBeenCalledOnce();
      expect(journal.media.cancelled(command.attemptId)).toBe(true);
      await vi.waitFor(() => expect(broker.consumeMedia).toHaveBeenCalledTimes(2));
      // Aborting the verification does not prove the old PUT ended.
      expect(journal.media.get(command.attemptId)?.phase).toBe('reconciling');
      expect(existsSync(join(directory, `media-${command.attemptId}`, 'audio.wav'))).toBe(true);
      verify.mockRestore();
      await onControl!(control('recover'), () => {});
      await vi.waitFor(() => {
        expect(journal.media.get(command.attemptId)?.phase).toBe('cancelled');
        expect(existsSync(join(directory, `media-${command.attemptId}`))).toBe(false);
      });
    } finally {
      stop.abort();
      await runtime;
    }
  });
  it('retains failures for 24 hours from failure and sweeps only known terminal copies', async () => {
    const { worker, command, journal, directory } = fixture(async () => {
      throw new Error('WORKER_INTERRUPTED');
    });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await worker.handle(command, () => {});
    const failed = journal.media.get(command.attemptId)!;
    expect(failed.failedAt).toBe(now);
    failed.startedAt = now - 2 * 24 * 60 * 60 * 1000;
    journal.media.save(failed);
    const unknownCommand = {
      ...command,
      jobId: randomUUID(),
      messageId: randomUUID(),
      attemptId: randomUUID(),
    };
    const unknown = journal.media.accept(unknownCommand);
    unknown.phase = 'reconciling';
    unknown.unknownCode = 'UPLOAD_UNKNOWN';
    journal.media.save(unknown);
    const { MediaFiles } = await import('../src/adapters/media-files.ts');
    await new MediaFiles(directory, unknownCommand.attemptId).write('keep.txt', 'unknown');
    clock.mockReturnValue(now + 24 * 60 * 60 * 1000 - 1);
    await worker.cleanupExpired();
    expect(journal.media.get(command.attemptId)?.cleaned).not.toBe(true);
    clock.mockReturnValue(now + 24 * 60 * 60 * 1000);
    await worker.cleanupExpired();
    expect(journal.media.get(command.attemptId)?.cleaned).toBe(true);
    expect(existsSync(join(directory, `media-${command.attemptId}`))).toBe(false);
    expect(existsSync(join(directory, `media-${unknownCommand.attemptId}`, 'keep.txt'))).toBe(true);
    expect(journal.media.get(unknownCommand.attemptId)?.phase).toBe('reconciling');
  });
  it('starts a conservative retention window for older failed journal entries without failedAt', async () => {
    const { worker, command, journal } = fixture(async () => {
      throw new Error('INPUT_INVALID');
    });
    await worker.handle(command, () => {});
    const failed = journal.media.get(command.attemptId)!;
    delete failed.failedAt;
    failed.startedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    journal.media.save(failed);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await worker.cleanupExpired();
    expect(journal.media.get(command.attemptId)).toMatchObject({ failedAt: now });
    expect(journal.media.get(command.attemptId)?.cleaned).not.toBe(true);
  });
  it('cleans an expired known failure on the online runtime timer without reconnecting', async () => {
    const { command, worker, journal, store, directory, slots, stop } = fixture(async () => {
      throw new Error('INPUT_INVALID');
    });
    await worker.handle(command, () => {});
    const now = Date.now();
    const failed = journal.media.get(command.attemptId)!;
    failed.failedAt = now - 24 * 60 * 60 * 1000 + 60_000;
    journal.media.save(failed);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(now);
    const ready = Promise.withResolvers<void>();
    let consumers = 0;
    const broker = {
      publishMedia: async () => {},
      consumeMediaControl: vi.fn(async () => {}),
      consumeMedia: vi.fn(async () => {
        if (++consumers === 2) ready.resolve();
      }),
      closed: () => new Promise<void>(() => {}),
      close: vi.fn(async () => {}),
    };
    const connect = vi.spyOn(Broker, 'connect').mockResolvedValue(broker as unknown as Broker);
    const runtime = runMediaRuntime(
      { url: 'amqp://unused', userId: 'b', expectedUserId: 'a', directory },
      store,
      journal,
      execute,
      stop.signal,
      slots,
    );
    try {
      await ready.promise;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(journal.media.get(command.attemptId)?.cleaned).not.toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      // Directory removal uses real filesystem I/O; let the online sweep finish.
      await vi.waitFor(() => expect(journal.media.get(command.attemptId)?.cleaned).toBe(true));
      expect(existsSync(join(directory, `media-${command.attemptId}`))).toBe(false);
      expect(connect).toHaveBeenCalledOnce();
    } finally {
      stop.abort();
      await runtime;
    }
  });
  it('ACKs a slow online recover so the next prefetch-one control can persist cancellation', async () => {
    const { worker, command, control, journal, store, directory, slots, publisher } = fixture();
    store.unknown = true;
    await worker.handle(command, () => {});
    const entered = Promise.withResolvers<void>();
    const verify = vi
      .spyOn(store, 'verifyMedia')
      .mockImplementation(async (_key, _etag, _size, _sha, signal) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        });
        return true;
      });
    const recoverAck = vi.fn();
    await worker.control(control('recover'), recoverAck);
    await entered.promise;
    expect(recoverAck).toHaveBeenCalledOnce();
    await worker.control(control('recover'), () => {});
    expect(verify).toHaveBeenCalledOnce();
    // Delivery of the next message is allowed only after the recover handler/ACK returned.
    const cancelAck = vi.fn();
    await worker.control(control(), cancelAck);
    expect(cancelAck).toHaveBeenCalledOnce();
    expect(journal.media.cancelled(command.attemptId)).toBe(true);
    await worker.close();
    expect(journal.media.get(command.attemptId)?.phase).toBe('reconciling');
    expect(existsSync(join(directory, `media-${command.attemptId}`, 'audio.wav'))).toBe(true);
    verify.mockRestore();
    // No control redelivery is needed: startup scans the original persisted attempt.
    const restarted = new MediaWorker(
      store,
      publisher,
      journal,
      directory,
      execute,
      new AbortController().signal,
      slots,
    );
    await restarted.recover();
    expect(journal.media.get(command.attemptId)?.phase).toBe('cancelled');
    expect(store.puts).toHaveLength(1);
    expect(existsSync(join(directory, `media-${command.attemptId}`))).toBe(false);
  });
  it('waits for an ACKed background recovery to drain before closing', async () => {
    const { worker, command, control, store, journal } = fixture();
    store.unknown = true;
    await worker.handle(command, () => {});
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<boolean>();
    vi.spyOn(store, 'verifyMedia').mockImplementation(async () => {
      entered.resolve();
      return release.promise;
    });
    await worker.control(control('recover'), () => {});
    await entered.promise;
    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve(true);
    await closing;
    expect(closed).toBe(true);
    expect(journal.media.get(command.attemptId)?.uploads['audio.wav']?.state).toBe('intent');
    expect(journal.media.get(command.attemptId)?.phase).toBe('reconciling');
  });
  it('propagates an ACKed recovery journal failure and stops admission', async () => {
    const failure = vi.fn();
    const { worker, command, control, store, journal } = fixture(execute, failure);
    store.unknown = true;
    await worker.handle(command, () => {});
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<boolean>();
    vi.spyOn(store, 'verifyMedia').mockImplementation(async () => {
      entered.resolve();
      return release.promise;
    });
    const ack = vi.fn();
    await worker.control(control('recover'), ack);
    await entered.promise;
    const error = new Error('JOURNAL_MEDIA_WRITE_FAILED');
    vi.spyOn(journal.media, 'save').mockImplementation(() => {
      throw error;
    });
    release.resolve(true);
    await vi.waitFor(() => expect(failure).toHaveBeenCalledWith(error));
    expect(ack).toHaveBeenCalledOnce();
    await expect(worker.handle(command, () => {})).rejects.toThrow('WORKER_NOT_READY');
    await expect(worker.close()).rejects.toBe(error);
  });
});

it('cancels a recovery waiting for a slot without stopping the unrelated running attempt', async () => {
  const secondJob = randomUUID();
  const stoppedRound = vi.fn((error: unknown) => stop.abort(error));
  const actual: MediaExecutor = async (command, context) => {
    if (command.jobId === secondJob) {
      await context.run({
        id: 'hold-real-encode',
        tool: 'ffmpeg',
        args: ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'sine=duration=2.5', '-f', 'null', '-'],
      });
    }
    return execute(command, context);
  };
  const { worker, journal, store, command, control, slots, stop } = fixture(actual, stoppedRound);
  store.unknown = true;
  await worker.handle(command, () => {});
  expect(journal.media.get(command.attemptId)).toMatchObject({
    phase: 'reconciling',
    unknownCode: 'UPLOAD_UNKNOWN',
  });
  const second = { ...command, jobId: secondJob, messageId: randomUUID(), attemptId: randomUUID() };
  const ack = vi.fn();
  const running = worker.handle(second, ack);
  void running.catch(() => {});
  try {
    await vi.waitFor(() =>
      expect(journal.media.get(second.attemptId)?.steps['hold-real-encode']?.state).toBe('running'),
    );
    const waiter = vi.spyOn(slots, 'waitForOutputRecovery');
    await worker.control(control('recover'), () => {});
    expect(waiter).toHaveBeenCalledOnce();
    expect(slots.available('encode')).toBe(false);
    await worker.control(control(), () => {});
    await running;
    expect(ack).toHaveBeenCalledOnce();
    expect(stoppedRound).not.toHaveBeenCalled();
    expect(stop.signal.aborted).toBe(false);
    expect(journal.media.get(command.attemptId)).toMatchObject({
      phase: 'reconciling',
      unknownCode: 'UPLOAD_UNKNOWN',
      uploads: { 'audio.wav': { state: 'intent' } },
    });
    expect(journal.media.cancelled(command.attemptId)).toBe(true);
    expect(journal.media.get(second.attemptId)).toMatchObject({
      phase: 'succeeded',
      steps: { 'hold-real-encode': { state: 'complete', exitCode: 0 } },
    });
    expect(store.puts.filter((key) => key.includes(command.attemptId))).toHaveLength(1);
  } finally {
    await worker.close();
  }
});
