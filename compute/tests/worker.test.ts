import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPUTE_PROFILE, parseComputeCommandV1 } from '@mio/compute-contracts';
import type { ComputeCommandV1, ComputeResultV1 } from '@mio/compute-contracts';
import { Journal } from '../src/adapters/journal.ts';
import { paths, processGone, processIdentity, transcode } from '../src/adapters/media.ts';
import type { MediaError } from '../src/adapters/media.ts';
import { Worker } from '../src/worker.ts';

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'mio-compute-test-'));
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
    'testsrc=size=320x240:rate=24',
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
function command(file: string): ComputeCommandV1 {
  const assetId = randomUUID();
  return {
    version: 1,
    type: 'transcode.request',
    messageId: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    attempt: 1,
    profile: COMPUTE_PROFILE,
    input: {
      assetId,
      key: `mio/raw/${assetId}/${randomUUID()}`,
      sizeBytes: statSync(file).size,
      etag: '"raw"',
    },
  };
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('worker journal and real ffmpeg', () => {
  it('commits WAL across a killed process and holds an exclusive lock while open', () => {
    const root = directory();
    const moduleUrl = new URL('../src/adapters/journal.ts', import.meta.url).href;
    const init = `import {Journal} from ${JSON.stringify(moduleUrl)}; const j=new Journal(${JSON.stringify(root)},'instance',true); j.close();`;
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', init]).status).toBe(0);
    const journal = new Journal(root, 'instance');
    const opener = `import {Journal} from ${JSON.stringify(moduleUrl)}; try {const j=new Journal(${JSON.stringify(root)},'instance');j.close();} catch {process.exitCode=23;}`;
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', opener]).status).toBe(23);
    journal.close();
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', opener]).status).toBe(0);
    const saved = command(fixture(root));
    const killed = `import {Journal} from ${JSON.stringify(moduleUrl)}; const j=new Journal(${JSON.stringify(root)},'instance'); j.accept(${JSON.stringify(saved)}); process.kill(process.pid,'SIGKILL');`;
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', killed]).signal).toBe(
      'SIGKILL',
    );
    const recovered = new Journal(root, 'instance');
    expect(recovered.get(saved.attemptId)?.command).toEqual(saved);
    recovered.close();
  });

  it('compares command values independently of JSON field order and rejects a changed input', () => {
    const root = directory();
    const source = fixture(root);
    const journal = new Journal(root, 'instance', true);
    const input = command(source);
    journal.accept(input);
    const reordered = parseComputeCommandV1({
      input: {
        etag: input.input.etag,
        sizeBytes: input.input.sizeBytes,
        key: input.input.key,
        assetId: input.input.assetId,
      },
      profile: input.profile,
      attempt: input.attempt,
      attemptId: input.attemptId,
      jobId: input.jobId,
      messageId: input.messageId,
      type: input.type,
      version: input.version,
    });
    expect(() => journal.accept(reordered)).not.toThrow();
    expect(() =>
      journal.accept({ ...input, input: { ...input.input, etag: '"changed"' } }),
    ).toThrow('ATTEMPT_CONFLICT');
    journal.close();
  });

  it('refuses a missing journal and a logically corrupted attempt on startup', () => {
    const empty = directory();
    expect(() => new Journal(empty, 'instance')).toThrow();
    const root = directory();
    const source = fixture(directory());
    const journal = new Journal(root, 'instance', true);
    journal.accept(command(source));
    journal.close();
    const db = new DatabaseSync(join(root, 'journal.sqlite3'));
    db.exec("UPDATE attempts SET phase = 'corrupt-state'");
    db.close();
    expect(() => new Journal(root, 'instance')).toThrow('JOURNAL_CORRUPT');
  });

  it('migrates the v3 journal without treating ACK dispatch as broker confirmation', async () => {
    const source = fixture(directory());
    const root = directory();
    const input = command(source);
    let journal = new Journal(root, 'instance', true);
    journal.accept(input);
    const terminal: ComputeResultV1 = {
      version: 1,
      type: 'transcode.result',
      messageId: randomUUID(),
      commandId: input.messageId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      attempt: input.attempt,
      state: 'failed',
      errorCode: 'TRANSCODE_FAILED',
    };
    journal.transition(input.attemptId, 'failed', terminal);
    journal.confirm(terminal.messageId);
    writeFileSync(paths(root, input.attemptId).input, 'retained');
    journal.close();
    const old = new DatabaseSync(join(root, 'journal.sqlite3'));
    old.exec(`BEGIN IMMEDIATE;
      DROP INDEX attempts_cleanup;
      ALTER TABLE attempts RENAME COLUMN ack_dispatched TO acknowledged;
      CREATE INDEX attempts_cleanup ON attempts(attempt_id) WHERE phase IN ('succeeded','failed') AND acknowledged = 1 AND cleaned = 0;
      UPDATE metadata SET schema_version = 3;
      COMMIT;`);
    old.close();
    journal = new Journal(root, 'instance');
    expect(journal.get(input.attemptId)).toMatchObject({
      ackDispatched: false,
      cleaned: false,
      phase: 'failed',
    });
    const store = {
      async download() {},
      async head() {
        return null;
      },
      async verify() {
        return false;
      },
      async upload() {},
    };
    const worker = new Worker(journal, store, { async publish() {} }, root);
    await worker.reconcileOne();
    expect(journal.get(input.attemptId)).toMatchObject({ ackDispatched: false, cleaned: true });
    expect(existsSync(paths(root, input.attemptId).input)).toBe(false);
    journal.close();
  });

  it('cleans after a crash before ACK and replays a later command without recomputing', async () => {
    const source = fixture(directory());
    const root = directory();
    const input = command(source);
    const terminal: ComputeResultV1 = {
      version: 1,
      type: 'transcode.result',
      messageId: randomUUID(),
      commandId: input.messageId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      attempt: input.attempt,
      state: 'failed',
      errorCode: 'TRANSCODE_FAILED',
    };
    const initial = new Journal(root, 'instance', true);
    initial.close();
    const journalUrl = new URL('../src/adapters/journal.ts', import.meta.url).href;
    const mediaUrl = new URL('../src/adapters/media.ts', import.meta.url).href;
    const script = `import {writeFileSync} from 'node:fs';import {Journal} from ${JSON.stringify(journalUrl)};import {paths} from ${JSON.stringify(mediaUrl)};
      const j=new Journal(${JSON.stringify(root)},'instance');const c=${JSON.stringify(input)};const e=${JSON.stringify(terminal)};
      j.accept(c);j.transition(c.attemptId,'failed',e);j.confirm(e.messageId);writeFileSync(paths(${JSON.stringify(root)},c.attemptId).input,'x');process.kill(process.pid,'SIGKILL');`;
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', script]).signal).toBe(
      'SIGKILL',
    );
    const journal = new Journal(root, 'instance');
    let downloads = 0;
    const store = {
      async download() {
        downloads++;
      },
      async head() {
        return null;
      },
      async verify() {
        return false;
      },
      async upload() {},
    };
    const worker = new Worker(journal, store, { async publish() {} }, root);
    expect(journal.get(input.attemptId)).toMatchObject({ ackDispatched: false, cleaned: false });
    await worker.reconcileOne();
    expect(journal.get(input.attemptId)).toMatchObject({ ackDispatched: false, cleaned: true });
    expect(existsSync(paths(root, input.attemptId).input)).toBe(false);
    let dispatched = false;
    await worker.handle(input, () => {
      dispatched = true;
    });
    expect(dispatched).toBe(true);
    expect(downloads).toBe(0);
    expect(journal.lastEvent(input.attemptId)?.message.messageId).toBe(terminal.messageId);
    expect(journal.get(input.attemptId)?.ackDispatched).toBe(true);
    journal.close();
  });

  it('does not leak files if killed after the ACK call reaches the constructed broker boundary', async () => {
    const source = fixture(directory());
    const root = directory();
    const input = command(source);
    const terminal: ComputeResultV1 = {
      version: 1,
      type: 'transcode.result',
      messageId: randomUUID(),
      commandId: input.messageId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      attempt: input.attempt,
      state: 'failed',
      errorCode: 'TRANSCODE_FAILED',
    };
    const journal = new Journal(root, 'instance', true);
    journal.accept(input);
    journal.transition(input.attemptId, 'failed', terminal);
    journal.confirm(terminal.messageId);
    writeFileSync(paths(root, input.attemptId).input, 'x');
    journal.close();
    const journalUrl = new URL('../src/adapters/journal.ts', import.meta.url).href;
    const workerUrl = new URL('../src/worker.ts', import.meta.url).href;
    const marker = join(root, 'ack-boundary');
    const script = `import {writeFileSync} from 'node:fs';import {Journal} from ${JSON.stringify(journalUrl)};import {Worker} from ${JSON.stringify(workerUrl)};
      const j=new Journal(${JSON.stringify(root)},'instance');const w=new Worker(j,{async download(){},async head(){return null},async verify(){return false},async upload(){}},{async publish(){}},${JSON.stringify(root)});
      await w.handle(${JSON.stringify(input)},()=>{writeFileSync(${JSON.stringify(marker)},'reached');process.kill(process.pid,'SIGKILL')});`;
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', script]).signal).toBe(
      'SIGKILL',
    );
    expect(existsSync(marker)).toBe(true);
    const reopened = new Journal(root, 'instance');
    expect(reopened.get(input.attemptId)).toMatchObject({
      ackDispatched: false,
      cleaned: true,
      phase: 'failed',
    });
    expect(existsSync(paths(root, input.attemptId).input)).toBe(false);
    expect(reopened.recoverableAfter('')).toBeNull();
    reopened.close();
  });

  it('keeps unknown-attempt evidence even after ACK is dispatched', async () => {
    const source = fixture(directory());
    const root = directory();
    const input = command(source);
    const journal = new Journal(root, 'instance', true);
    const contents = Buffer.from('output');
    journal.accept(input);
    journal.transition(input.attemptId, 'launching');
    journal.recordPid(input.attemptId, process.pid, processIdentity() as string);
    journal.recordOutput(
      input.attemptId,
      contents.length,
      createHash('sha256').update(contents).digest('hex'),
    );
    journal.transition(input.attemptId, 'unknown_upload');
    writeFileSync(paths(root, input.attemptId).output, contents);
    const store = {
      async download() {},
      async head() {
        throw new Error('network unavailable');
      },
      async verify() {
        return false;
      },
      async upload() {},
    };
    const worker = new Worker(journal, store, { async publish() {} }, root);
    await worker.handle(input, () => {});
    expect(journal.get(input.attemptId)).toMatchObject({
      phase: 'unknown_upload',
      ackDispatched: true,
      cleaned: false,
    });
    expect(existsSync(paths(root, input.attemptId).output)).toBe(true);
    journal.close();
  });

  it('does not ACK a terminal journal record without a confirmed outcome', async () => {
    const source = fixture(directory());
    const root = directory();
    const journal = new Journal(root, 'instance', true);
    const input = command(source);
    journal.accept(input);
    journal.transition(input.attemptId, 'failed');
    const store = {
      async download() {},
      async head() {
        return null;
      },
      async verify() {
        return false;
      },
      async upload() {},
    };
    const worker = new Worker(journal, store, { async publish() {} }, root);
    let acknowledged = false;
    await expect(
      worker.handle(input, () => {
        acknowledged = true;
      }),
    ).rejects.toThrow('JOURNAL_OUTCOME_UNCONFIRMED');
    expect(acknowledged).toBe(false);
    journal.close();
  });

  it('holds an existing remote object unknown when its persisted local output is missing', async () => {
    const source = fixture(directory());
    const root = directory();
    const journal = new Journal(root, 'instance', true);
    const input = command(source);
    const digest = 'a'.repeat(64);
    journal.accept(input);
    journal.transition(input.attemptId, 'launching');
    journal.recordPid(input.attemptId, process.pid, processIdentity() as string);
    journal.recordOutput(input.attemptId, 1, digest);
    journal.transition(input.attemptId, 'unknown_upload');
    const messages: ComputeResultV1[] = [];
    const store = {
      async download() {},
      async head() {
        return { sizeBytes: 1, sha256: digest, etag: '"object"' };
      },
      async verify() {
        return true;
      },
      async upload() {},
    };
    const worker = new Worker(
      journal,
      store,
      {
        async publish(message) {
          messages.push(message);
        },
      },
      root,
    );
    await worker.reconcileOne();
    expect(journal.get(input.attemptId)?.phase).toBe('unknown_mismatch');
    expect(messages.at(-1)).toMatchObject({ state: 'unknown', errorCode: 'OUTPUT_MISMATCH' });
    journal.close();
  });

  it('rejects a real video longer than 30 minutes before encoding or upload', async () => {
    const source = join(directory(), 'over-duration.mp4');
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=black:size=16x16:rate=1',
        '-t',
        '1801',
        '-c:v',
        'libx264',
        '-threads',
        '1',
        source,
      ],
      { timeout: 10_000 },
    );
    const root = directory();
    const input = command(source);
    const journal = new Journal(root, 'instance', true);
    const media = await import('../src/adapters/media.ts');
    const realTranscode = media.transcode;
    const encoderStarted = vi.fn();
    const transcodeCall = vi
      .spyOn(media, 'transcode')
      .mockImplementation((directory, attemptId, signal, onSpawn) =>
        realTranscode(directory, attemptId, signal, (pid) => {
          encoderStarted(pid);
          onSpawn(pid);
        }),
      );
    const upload = vi.fn(async () => {});
    const published: ComputeResultV1[] = [];
    const ack = vi.fn();
    try {
      const worker = new Worker(
        journal,
        {
          async download() {
            copyFileSync(source, paths(root, input.attemptId).input);
          },
          async head() {
            return null;
          },
          async verify() {
            return false;
          },
          upload,
        },
        {
          async publish(message) {
            published.push(message);
          },
        },
        root,
      );
      await worker.handle(input, ack);
      expect(transcodeCall).toHaveBeenCalledTimes(1);
      expect(encoderStarted).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
      expect(published).toMatchObject([
        { state: 'running' },
        { state: 'failed', errorCode: 'INPUT_TOO_LONG' },
      ]);
      expect(journal.get(input.attemptId)).toMatchObject({
        phase: 'failed',
        pid: null,
        cleaned: true,
        ackDispatched: true,
      });
      expect(existsSync(paths(root, input.attemptId).input)).toBe(false);
      expect(ack).toHaveBeenCalledTimes(1);
    } finally {
      transcodeCall.mockRestore();
      journal.close();
    }
  }, 30_000);

  it('uses a real fixed-profile transcode, keeps unknown upload, and reconciles without re-execution', async () => {
    const fixtureRoot = directory();
    const source = fixture(fixtureRoot);
    const root = directory();
    const journal = new Journal(root, 'instance', true);
    const input = command(source);
    const published: ComputeResultV1[] = [];
    let downloads = 0;
    let failSuccess = true;
    let object: { sizeBytes: number; etag: string; sha256: string; bytes: Buffer } | null = null;
    const store = {
      async download(value: ComputeCommandV1) {
        downloads++;
        copyFileSync(source, paths(root, value.attemptId).input);
      },
      async head() {
        return object;
      },
      async verify(_key: string, size: number, sha256: string) {
        return (
          object?.sizeBytes === size &&
          createHash('sha256').update(object.bytes).digest('hex') === sha256
        );
      },
      async upload(
        _key: string,
        directoryPath: string,
        attemptId: string,
        size: number,
        sha256: string,
      ) {
        object = {
          sizeBytes: size,
          etag: '"output"',
          sha256,
          bytes: readFileSync(paths(directoryPath, attemptId).output),
        };
        throw new Error('simulated lost response after PUT');
      },
    };
    const worker = new Worker(
      journal,
      store,
      {
        async publish(value) {
          published.push(value);
          if (value.state === 'succeeded' && failSuccess) {
            failSuccess = false;
            throw new Error('confirm lost');
          }
        },
      },
      root,
    );
    let acks = 0;
    await worker.handle(input, () => {
      acks++;
    });
    expect(published.map((value) => value.state)).toEqual(['running', 'unknown']);
    expect(journal.get(input.attemptId)?.phase).toBe('unknown_upload');
    expect(existsSync(paths(root, input.attemptId).output)).toBe(true);
    expect(acks).toBe(1);
    await expect(worker.reconcileOne()).rejects.toThrow('confirm lost');
    const pendingId = published.at(-1)?.messageId;
    expect(journal.get(input.attemptId)?.phase).toBe('succeeded');
    expect(existsSync(paths(root, input.attemptId).output)).toBe(true);
    await worker.reconcileOne();
    expect(published.map((value) => value.state)).toEqual([
      'running',
      'unknown',
      'succeeded',
      'succeeded',
    ]);
    expect(published.at(-1)?.messageId).toBe(pendingId);
    expect(journal.get(input.attemptId)?.phase).toBe('succeeded');
    expect(existsSync(paths(root, input.attemptId).output)).toBe(false);
    await worker.handle(input, () => {
      acks++;
    });
    expect(downloads).toBe(1);
    expect(acks).toBe(2);
    journal.close();
  }, 30_000);

  it('holds a launch without PID across reopen and reports a known-dead process interrupted', async () => {
    const fixtureRoot = directory();
    const root = directory();
    const input = command(fixture(fixtureRoot));
    let journal = new Journal(root, 'instance', true);
    journal.accept(input);
    journal.transition(input.attemptId, 'launching');
    journal.close();
    journal = new Journal(root, 'instance');
    const published: ComputeResultV1[] = [];
    const store = {
      async download() {},
      async head() {
        return null;
      },
      async verify() {
        return false;
      },
      async upload() {},
    };
    let worker = new Worker(
      journal,
      store,
      {
        async publish(value) {
          published.push(value);
        },
      },
      root,
    );
    await worker.reconcileOne();
    expect(journal.hasUnknownProcess()).toBe(true);
    expect(journal.get(input.attemptId)?.phase).toBe('unknown_process');
    expect(published.at(-1)).toMatchObject({ state: 'unknown', errorCode: 'PROCESS_UNKNOWN' });
    journal.resolveNoPid(input.attemptId, 'human verified the isolated runtime stopped');
    await worker.reconcileOne();
    expect(published.at(-1)).toMatchObject({ state: 'failed', errorCode: 'WORKER_INTERRUPTED' });
    expect(journal.hasUnknownProcess()).toBe(false);
    journal.close();

    const other = directory();
    const second = new Journal(other, 'instance', true);
    second.accept(input);
    second.transition(input.attemptId, 'launching');
    const child = spawnSync(process.execPath, ['-e', '']);
    const identity = processIdentity();
    expect(identity).not.toBeNull();
    second.recordPid(input.attemptId, child.pid, identity as string);
    worker = new Worker(
      second,
      store,
      {
        async publish(value) {
          published.push(value);
        },
      },
      other,
    );
    await worker.reconcileOne();
    expect(second.get(input.attemptId)?.phase).toBe('failed');
    expect(published.at(-1)).toMatchObject({ state: 'failed', errorCode: 'WORKER_INTERRUPTED' });
    second.close();
  }, 30_000);

  it('holds after a real worker crash while its FFmpeg child survives, then resolves only after it exits', async () => {
    const source = fixture(directory());
    const root = directory();
    const input = command(source);
    const initialized = new Journal(root, 'instance', true);
    initialized.close();
    const journalUrl = new URL('../src/adapters/journal.ts', import.meta.url).href;
    const mediaUrl = new URL('../src/adapters/media.ts', import.meta.url).href;
    const script = `import {spawn} from 'node:child_process'; import {Journal} from ${JSON.stringify(journalUrl)}; import {processIdentity} from ${JSON.stringify(mediaUrl)};
      const j=new Journal(${JSON.stringify(root)},'instance'); const c=${JSON.stringify(input)}; j.accept(c); j.transition(c.attemptId,'launching');
      const ff=spawn('ffmpeg',['-hide_banner','-loglevel','quiet','-re','-f','lavfi','-i','testsrc=size=64x64:rate=24','-t','3','-f','null','-'],{stdio:'ignore'});
      j.recordPid(c.attemptId,ff.pid,processIdentity()); process.stdout.write(String(ff.pid),()=>process.kill(process.pid,'SIGKILL'));`;
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });
    expect(crashed.signal).toBe('SIGKILL');
    const pid = Number(crashed.stdout);
    expect(pid).toBeGreaterThan(0);
    const journal = new Journal(root, 'instance');
    const published: ComputeResultV1[] = [];
    const store = {
      async download() {},
      async head() {
        return null;
      },
      async verify() {
        return false;
      },
      async upload() {},
    };
    const worker = new Worker(
      journal,
      store,
      {
        async publish(value) {
          published.push(value);
        },
      },
      root,
    );
    await worker.reconcileOne();
    expect(journal.get(input.attemptId)?.phase).toBe('unknown_process');
    const identity = journal.get(input.attemptId)?.processIdentity ?? null;
    for (let i = 0; i < 100 && !processGone(pid, identity); i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(processGone(pid, identity)).toBe(true);
    await worker.reconcileOne();
    expect(journal.get(input.attemptId)?.phase).toBe('failed');
    expect(published.map((value) => value.state)).toEqual(['unknown', 'failed']);
    journal.close();
  }, 15_000);

  it('kills and waits for a real FFmpeg child when the deadline fires', async () => {
    const fixtureRoot = directory();
    const source = fixture(fixtureRoot);
    const root = directory();
    const input = command(source);
    copyFileSync(source, paths(root, input.attemptId).input);
    const controller = new AbortController();
    let pid = 0;
    await expect(
      transcode(root, input.attemptId, controller.signal, (value) => {
        pid = value;
        controller.abort();
      }),
    ).rejects.toMatchObject({ code: 'EXECUTION_TIMEOUT' } satisfies Partial<MediaError>);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);

  it.each([
    { width: 240, height: 320, outputWidth: 320, outputHeight: 240 },
    { width: 1080, height: 1920, outputWidth: 1280, outputHeight: 720 },
  ])(
    'transcodes a real 90-degree display-matrix video without enlarging',
    async ({ width, height, outputWidth, outputHeight }) => {
      const root = directory();
      const original = join(root, 'portrait-encoded.mp4');
      const rotated = join(root, 'portrait-rotated.mp4');
      const attemptId = randomUUID();
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=blue:size=${width}x${height}:rate=24`,
        '-t',
        '0.5',
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-pix_fmt',
        'yuv420p',
        original,
      ]);
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-display_rotation',
        '90',
        '-i',
        original,
        '-c',
        'copy',
        rotated,
      ]);
      copyFileSync(rotated, paths(root, attemptId).input);
      await transcode(root, attemptId, AbortSignal.timeout(30_000), () => {});
      const output = JSON.parse(
        execFileSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-show_streams',
            '-select_streams',
            'v:0',
            '-of',
            'json',
            paths(root, attemptId).output,
          ],
          { encoding: 'utf8' },
        ),
      ) as { streams: { width: number; height: number }[] };
      expect(output.streams[0]).toMatchObject({ width: outputWidth, height: outputHeight });
    },
    30_000,
  );

  it.each([false, true])(
    'reconciles disk backpressure before admission; redelivered=%s',
    async (redelivered) => {
      const fixtureRoot = directory();
      const source = fixture(fixtureRoot);
      const root = directory();
      const journal = new Journal(root, 'instance', true);
      const old = command(source);
      const incoming = command(source);
      if (redelivered) journal.accept(incoming);
      const original = Buffer.alloc(1024 * 1024, 7);
      const digest = createHash('sha256').update(original).digest('hex');
      journal.accept(old);
      journal.transition(old.attemptId, 'launching');
      journal.recordPid(old.attemptId, process.pid, processIdentity() as string);
      journal.recordOutput(old.attemptId, original.length, digest);
      const unknown: ComputeResultV1 = {
        version: 1,
        type: 'transcode.result',
        messageId: randomUUID(),
        commandId: old.messageId,
        jobId: old.jobId,
        attemptId: old.attemptId,
        attempt: old.attempt,
        state: 'unknown',
        errorCode: 'UPLOAD_UNKNOWN',
      };
      journal.transition(old.attemptId, 'unknown_upload', unknown);
      journal.confirm(unknown.messageId);
      journal.markAckDispatched(old.attemptId);
      const retained = paths(root, old.attemptId).output;
      writeFileSync(retained, original);
      const used = readdirSync(root).reduce(
        (total, name) => total + statSync(join(root, name)).size,
        0,
      );
      const pressure = join(root, 'pressure.sparse');
      writeFileSync(pressure, '');
      truncateSync(pressure, 10 * 1024 ** 3 - used + 1);
      let downloads = 0;
      let ack = false;
      const store = {
        async download() {
          downloads++;
          throw new Error('controlled input failure');
        },
        async head() {
          return { sizeBytes: original.length, sha256: digest, etag: '"object"' };
        },
        async verify() {
          return true;
        },
        async upload() {},
      };
      const worker = new Worker(journal, store, { async publish() {} }, root);
      expect(worker.admissionReady()).toBe(false);
      await expect(
        worker.handle(incoming, () => {
          ack = true;
        }),
      ).rejects.toThrow('WORKER_NOT_READY');
      expect(journal.get(incoming.attemptId)?.phase ?? null).toBe(redelivered ? 'received' : null);
      expect(ack).toBe(false);
      await worker.reconcileOne();
      expect(worker.admissionReady()).toBe(true);
      await worker.handle(incoming, () => {
        ack = true;
      });
      expect(journal.get(old.attemptId)).toMatchObject({ phase: 'succeeded', cleaned: true });
      expect(existsSync(retained)).toBe(false);
      expect(downloads).toBe(1);
      expect(ack).toBe(true);
      journal.close();
    },
    10_000,
  );

  it('keeps the admission gate closed for an unknown process without creating a new attempt', async () => {
    const source = fixture(directory());
    const root = directory();
    const journal = new Journal(root, 'instance', true);
    const old = command(source);
    const incoming = command(source);
    journal.accept(old);
    journal.transition(old.attemptId, 'launching');
    const store = {
      async download() {},
      async head() {
        return null;
      },
      async verify() {
        return false;
      },
      async upload() {},
    };
    const worker = new Worker(journal, store, { async publish() {} }, root);
    expect(worker.admissionReady()).toBe(false);
    await expect(worker.handle(incoming, () => {})).rejects.toThrow('WORKER_NOT_READY');
    expect(journal.get(incoming.attemptId)).toBeNull();
    await worker.reconcileOne();
    expect(journal.get(old.attemptId)?.phase).toBe('unknown_process');
    expect(worker.admissionReady()).toBe(false);
    journal.resolveNoPid(old.attemptId, 'human verified the isolated runtime stopped');
    await worker.reconcileOne();
    expect(worker.admissionReady()).toBe(true);
    journal.close();
  });
});
