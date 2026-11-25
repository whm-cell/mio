import { MEDIA_VERSION } from '@mio/compute-contracts';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_PROFILE } from '@mio/compute-contracts';
import type { MediaCommand } from '@mio/compute-contracts';
import { Journal } from '../src/adapters/journal.ts';
import { MediaFiles, MEDIA_TEXT_LIMIT } from '../src/adapters/media-files.ts';
import {
  MediaProcessAdapter,
  mediaProcessGone,
  resolveMediaArgs,
  checkMediaCapabilities,
} from '../src/adapters/media-process.ts';
import { probeFile } from '../src/plans/probe.ts';
const roots: string[] = [];
const journals: Journal[] = [];
function fixture(signal = new AbortController().signal) {
  const directory = mkdtempSync(join(tmpdir(), 'mio-media-process-'));
  roots.push(directory);
  const journal = new Journal(directory, 'process-test', true);
  journals.push(journal);
  const assetId = randomUUID();
  const command: MediaCommand = {
    version: MEDIA_VERSION,
    type: 'media.request',
    messageId: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    attempt: 1,
    profile: MEDIA_PROFILE,
    operation: 'media.probe',
    inputs: [{ assetId, key: `mio/raw/${assetId}/${randomUUID()}`, sizeBytes: 1, etag: 'one' }],
    parameters: {},
  };
  const attempt = journal.media.accept(command),
    files = new MediaFiles(directory, command.attemptId);
  const progress = vi.fn();
  return {
    directory,
    journal,
    attempt,
    files,
    progress,
    adapter: new MediaProcessAdapter(files, journal.media, attempt, signal, progress),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const journal of journals.splice(0)) journal.close();
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});
describe('media process/files adapter with real FFmpeg', () => {
  it.each(['asetnsamples', 'astats', 'atrim', 'ametadata', 'ass', 'loudnorm'])(
    'refuses admission when media filter %s is unavailable',
    async (filter) => {
      const originalPath = process.env.PATH!;
      const ffmpeg = originalPath
        .split(delimiter)
        .map((directory) => join(directory, 'ffmpeg'))
        .find(existsSync);
      expect(ffmpeg).toBeTruthy();
      const directory = mkdtempSync(join(tmpdir(), 'mio-media-capability-'));
      roots.push(directory);
      writeFileSync(
        join(directory, 'ffmpeg'),
        `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const result = spawnSync(${JSON.stringify(ffmpeg)}, process.argv.slice(2), { encoding: 'utf8' });
const text = process.argv.includes('-filters')
  ? result.stdout.split('\\n').filter(line => line.trim().split(/\\s+/)[1] !== ${JSON.stringify(filter)}).join('\\n')
  : result.stdout;
process.stdout.write(text || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`,
        { mode: 0o700 },
      );
      vi.stubEnv('PATH', directory + delimiter + originalPath);
      await expect(checkMediaCapabilities()).rejects.toThrow('CAPABILITY_UNAVAILABLE');
    },
  );
  it('streams intermediate output-time progress for a long step without capturing stdout', async () => {
    const { adapter, progress, attempt } = fixture();
    await adapter.run({
      id: 'streamed',
      tool: 'ffmpeg',
      durationSeconds: 2.4,
      args: ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'sine=duration=2.4', '-f', 'null', '-'],
    });
    const values = progress.mock.calls.map((call) => call[1] as number);
    expect(values.some((value) => value > 0 && value < 1)).toBe(true);
    expect(values.at(-1)).toBe(1);
    expect(attempt.steps.streamed!.result!.stdout).toBe('');
  });

  it('checkpoints process identity, exit, streamed progress and output hash, then reuses the completed step', async () => {
    const { adapter, journal, attempt, files, progress } = fixture();
    const step = {
      id: 'fixture',
      tool: 'ffmpeg' as const,
      args: [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=0.2',
        '-c:a',
        'pcm_s16le',
        '@file:fixture.wav',
      ],
      outputs: [{ name: 'fixture.wav', role: 'audio' as const, contentType: 'audio/wav' }],
    };
    await adapter.run(step);
    const checkpoint = journal.media.get(attempt.command.attemptId)!.steps.fixture!;
    expect(checkpoint).toMatchObject({ state: 'complete', exitCode: 0 });
    expect(checkpoint.pid).toBeGreaterThan(0);
    expect(checkpoint.processIdentity).toBeTruthy();
    expect(checkpoint.outputs['fixture.wav']).toEqual(
      await files.digest('fixture.wav', new AbortController().signal),
    );
    expect(progress).toHaveBeenCalledWith('fixture', 1);
    const before = lstatSync(files.path('fixture.wav')).mtimeMs;
    await adapter.run(step);
    expect(lstatSync(files.path('fixture.wav')).mtimeMs).toBe(before);
    expect(journal.media.get(attempt.command.attemptId)!.steps.fixture!.pid).toBe(checkpoint.pid);
    const probe = await adapter.run({
      id: 'probe',
      tool: 'ffprobe',
      capture: 'json',
      args: ['-v', 'error', '-show_format', '-of', 'json', '@file:fixture.wav'],
    });
    expect(JSON.parse(probe.stdout).format.format_name).toBe('wav');
    writeFileSync(files.path('fixture.wav'), 'changed');
    await expect(adapter.run(step)).rejects.toThrow('OUTPUT_MISMATCH');
  });
  it('kills and reaps before reporting abort, records an exited checkpoint', async () => {
    const stop = new AbortController();
    const { adapter, journal, attempt } = fixture(stop.signal);
    const running = adapter.run({
      id: 'slow',
      tool: 'ffmpeg',
      args: ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'sine=duration=30', '-f', 'null', '-'],
    });
    const rejected = expect(running).rejects.toThrow('cancel-test');
    await vi.waitFor(() =>
      expect(journal.media.get(attempt.command.attemptId)!.steps.slow?.state).toBe('running'),
    );
    const record = journal.media.get(attempt.command.attemptId)!.steps.slow!;
    stop.abort(new Error('cancel-test'));
    await rejected;
    expect(journal.media.get(attempt.command.attemptId)!.steps.slow!.state).toBe('exited');
    expect(mediaProcessGone(record.pid, record.processIdentity)).toBe(true);
  });
  it('reaps the child when persisting the PID fails', async () => {
    const { adapter, journal, attempt } = fixture();
    const save = journal.media.save.bind(journal.media);
    let pid: number | null = null;
    vi.spyOn(journal.media, 'save').mockImplementation((value) => {
      if (value.steps.fail?.state === 'running') {
        pid = value.steps.fail.pid;
        throw new Error('JOURNAL_MEDIA_TEST');
      }
      save(value);
    });
    await expect(
      adapter.run({
        id: 'fail',
        tool: 'ffmpeg',
        args: ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'sine=duration=30', '-f', 'null', '-'],
      }),
    ).rejects.toThrow('JOURNAL_MEDIA_TEST');
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid!, 0)).toThrow();
    expect(attempt.steps.fail!.state).toBe('exited');
  });
  it('preserves a confirmed signal interruption through the probe input-error boundary', async () => {
    const { adapter, journal, attempt } = fixture();
    await adapter.run({
      id: 'prepare-input',
      tool: 'ffmpeg',
      args: ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.2', '@file:input.wav'],
      outputs: [{ name: 'input.wav', role: 'audio', contentType: 'audio/wav' }],
    });
    const save = journal.media.save.bind(journal.media);
    let interrupted = false;
    vi.spyOn(journal.media, 'save').mockImplementation((value) => {
      save(value);
      const child = value.steps['interrupted-probe'];
      if (!interrupted && child?.state === 'running') {
        interrupted = true;
        // The PID is this test's freshly spawned child, never a restored journal PID.
        process.kill(child.pid!, 'SIGKILL');
      }
    });
    await expect(
      probeFile('input.wav', 'interrupted-probe', {
        run: (step) => adapter.run(step),
      }),
    ).rejects.toThrow('WORKER_INTERRUPTED');
    const checkpoint = journal.media.get(attempt.command.attemptId)!.steps['interrupted-probe']!;
    expect(checkpoint).toMatchObject({ state: 'exited', exitCode: null, signal: 'SIGKILL' });
    expect(mediaProcessGone(checkpoint.pid, checkpoint.processIdentity)).toBe(true);
  });
  it('rejects traversal and symlinks, resolves file tokens inside filters, and bounds text I/O', async () => {
    const { files } = fixture();
    expect(
      resolveMediaArgs(
        ["subtitles='@file:captions.ass':force_style='Fontsize=24'", '@file:input-0'],
        files,
      ),
    ).toEqual(["subtitles='captions.ass':force_style='Fontsize=24'", 'input-0']);
    for (const name of [
      '../escape',
      'a/../escape',
      '/tmp/escape',
      'a//escape',
      'a\\escape',
      '.hidden',
    ]) {
      expect(() => files.path(name)).toThrow('MEDIA_PATH_INVALID');
      expect(() => resolveMediaArgs([`@file:${name}`], files)).toThrow();
    }
    symlinkSync('/tmp', join(files.directory, 'link'));
    expect(() => files.path('link/file')).toThrow();
    symlinkSync('/etc/passwd', join(files.directory, 'passwd'));
    await expect(files.read('passwd', 200)).rejects.toThrow();
    await expect(
      files.write('oversized.txt', new Uint8Array(MEDIA_TEXT_LIMIT + 1)),
    ).rejects.toThrow('MEDIA_WRITE_LIMIT');
  });
  it('uses bundled fonts only for the generated ASS and limits concat to generated list identities', async () => {
    const { adapter, files } = fixture();
    expect(resolveMediaArgs(['ass=@file:subtitles.ass:fontsdir=@font:bundled'], files)[0]).toMatch(
      /^ass=subtitles\.ass:fontsdir=\/.*\/compute\/fonts\/$/,
    );
    for (const value of [
      'ass=@file:subtitles.ass:fontsdir=external',
      'ass=@file:subtitles.ass:fontsdir=@font:unknown',
      'ass=@file:subtitles.ass:fontsdir=@font:bundled/other',
      'ass=@file:other.ass:fontsdir=@font:bundled',
    ])
      expect(() => resolveMediaArgs([value], files)).toThrow('MEDIA_PATH_INVALID');

    await adapter.run({
      id: 'fixture-visual',
      tool: 'ffmpeg',
      args: [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=red:s=16x16',
        '-frames:v',
        '1',
        '-c:v',
        'libx264',
        '@file:segment.mp4',
      ],
      outputs: [{ name: 'segment.mp4', role: 'segment', contentType: 'video/mp4' }],
    });
    const list = "ffconcat version 1.0\nfile 'segment.mp4'\n";
    await files.write('input-0', list);
    await files.write('composition.ffconcat', list);
    await adapter.run({
      id: 'generated-concat',
      tool: 'ffmpeg',
      args: [
        '-v',
        'error',
        '-f',
        'concat',
        '-safe',
        '1',
        '-i',
        '@file:composition.ffconcat',
        '-f',
        'null',
        '-',
      ],
    });
    await expect(
      adapter.run({
        id: 'untrusted-concat',
        tool: 'ffmpeg',
        args: [
          '-v',
          'error',
          '-f',
          'concat',
          '-safe',
          '1',
          '-i',
          '@file:input-0',
          '-f',
          'null',
          '-',
        ],
      }),
    ).rejects.toThrow('EXECUTION_FAILED');
  });

  it('does not rerun a durable launch intent and rejects changing thread limits', async () => {
    const { adapter, attempt } = fixture();
    const step = { id: 'unknown', tool: 'ffmpeg' as const, args: ['-version'] };
    const { mediaIdentity } = await import('../src/adapters/media-journal.ts');
    attempt.steps.unknown = {
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
    await expect(adapter.run(step)).rejects.toThrow('PROCESS_UNKNOWN');
    await expect(
      adapter.run({ id: 'threads', tool: 'ffmpeg', args: ['-threads', '8', '-version'] }),
    ).rejects.toThrow('MEDIA_THREADS_INVALID');
    expect(mediaProcessGone(123, 'foreign-host')).toBe(false);
  });
});

it('closes a supplied input stream even when local admission fails before opening a file', async () => {
  const { files } = fixture();
  const { Readable } = await import('node:stream');
  const source = new Readable({ read() {} });
  const destroyed = vi.spyOn(source, 'destroy');
  vi.spyOn(files, 'checkSpace').mockImplementation(() => {
    throw new Error('DISK_FULL');
  });
  await expect(files.receive('input-0', source, 1, new AbortController().signal)).rejects.toThrow(
    'DISK_FULL',
  );
  expect(destroyed).toHaveBeenCalledOnce();
  expect(source.destroyed).toBe(true);
  expect(existsSync(files.path('input-0'))).toBe(false);
});

it('rechecks work directory capacity while receiving and stops before writing the next block', async () => {
  const { files } = fixture();
  const { Readable } = await import('node:stream');
  const block = Buffer.alloc(8 * 1024 ** 2);
  const source = Readable.from([block, block]);
  const capacity = vi
    .spyOn(files, 'checkSpace')
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw new Error('DISK_FULL');
    });
  await expect(
    files.receive('input-0', source, 2 * block.length, new AbortController().signal),
  ).rejects.toThrow('DISK_FULL');
  expect(capacity).toHaveBeenCalledTimes(2);
  expect(lstatSync(files.path('input-0')).size).toBe(0);
  expect(source.destroyed).toBe(true);
});

it('replays an unpublished interrupted manifest write and still rejects different finalized bytes', async () => {
  const { files } = fixture();
  const temp = join(files.directory, '.manifest.json.pending');
  writeFileSync(temp, '{"incomplete":');
  await files.write('manifest.json', '{"complete":true}');
  expect(existsSync(temp)).toBe(false);
  expect(Buffer.from(await files.read('manifest.json', 64)).toString()).toBe('{"complete":true}');
  await expect(files.write('manifest.json', '{"different":true}')).rejects.toThrow(
    'OUTPUT_MISMATCH',
  );
});
