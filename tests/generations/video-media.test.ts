import { randomUUID, createHash } from 'node:crypto';
import { lstatSync, statfsSync } from 'node:fs';
import type * as FileSystem from 'node:fs';
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import type * as AsyncFileSystem from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import COS from 'cos-nodejs-sdk-v5';
import type { VideoProbe } from '../../src/generations/video/media.ts';
import { createVideoMaterializer, createVideoCleanup } from '../../src/generations/video/media.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { createVideoExecutor } from '../../src/generations/video/executor.ts';
import { createVideoRunner } from '../../src/generations/video/runner.ts';
import { VideoSubmissionReceipts } from '../../src/generations/video/submission-receipts.ts';
import { VideoGenerationStore } from '../../src/generations/video/store.ts';
import type { VideoCreateRequest } from '../../src/generations/video/contracts.ts';
import { VideoResultUrlExpired } from '../../src/generations/video/execution.ts';
import type { VideoExecution, VideoProtocol } from '../../src/generations/video/execution.ts';
import type { withPublicHttps } from '../../src/integrations/onelink/public-https.ts';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { authDatabase } from '../support/auth-database.ts';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof FileSystem>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync), statfsSync: vi.fn(fs.statfsSync) };
});

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof AsyncFileSystem>();
  return { ...fs, link: vi.fn(fs.link), open: vi.fn(fs.open), unlink: vi.fn(fs.unlink) };
});

const video = { url: 'https://video.fixture/result.mp4' };
const videos = [video];
const MiB = 1024 * 1024;

const cosFixture = () =>
  createCosStorage({
    databaseURL: 'postgresql://example.invalid/media',
    bucket: 'mio-test-1234567890',
    region: 'ap-shanghai',
    secretId: 'fixture',
    secretKey: 'fixture',
  });

function holdCosResponse(params: COS.RequestParams) {
  const reply = Promise.withResolvers<COS.RequestResult>();
  const body = params.Body as Readable;
  body.once('error', reply.reject);
  body.resume();
  return reply;
}

function pauseVideoBody(bytes: Buffer) {
  const finish = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    async pull(controller) {
      try {
        await finish.promise;
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return { response: new Response(body), finish };
}

function mockFreeSpace(directory: string, availableMiB: number) {
  const space = {
    ...statfsSync(directory, { bigint: true }),
    bavail: BigInt(availableMiB * MiB),
    bsize: 1n,
  };
  return vi.mocked(statfsSync).mockReturnValue(space);
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mio-video-media-'));
  const bytes = Buffer.from('fixture MP4 bytes checked by the worker probe');
  const saved = new Map<
    string,
    { bytes: Buffer; sha256: string; etag: string; contentType: string }
  >();
  let stagingVersion = 0;
  const objects: AssetObjectStore = {
    uploadUrl: () => '',
    downloadUrl: () => '',
    copy: vi.fn(async (source, target, sourceEtag, acl, replacement) => {
      const input = saved.get(source);
      if (!input || input.etag !== sourceEtag)
        throw Object.assign(new Error('copy source changed'), { statusCode: 412 });
      if (saved.has(target)) throw new Error('overwrite');
      expect(acl).toBe('private');
      expect(replacement?.contentType).toBe('video/mp4');
      expect(replacement?.sha256).toBe(input.sha256);
      expect(replacement?.signal.aborted).toBe(false);
      const etag = 'raw-etag-' + saved.size;
      saved.set(target, { ...input, etag, contentType: replacement!.contentType });
      return { etag };
    }),
    delete: vi.fn(async (key: string) => {
      saved.delete(key);
    }),
    head: vi.fn(async (key) => {
      const value = saved.get(key);
      if (!value) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return {
        size: value.bytes.length,
        sha256: value.sha256,
        etag: value.etag,
        contentType: value.contentType,
      };
    }),
    putVideo: vi.fn(async (key, stream, sizeBytes, sha256, contentMd5) => {
      expect(key).toMatch(/^mio\/staging\/video\//);
      if (saved.has(key)) throw new Error('overwrite');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const actual = Buffer.concat(chunks);
      expect(actual.length).toBe(sizeBytes);
      expect(createHash('sha256').update(actual).digest('hex')).toBe(sha256);
      expect(createHash('md5').update(actual).digest('base64')).toBe(contentMd5);
      const etag = 'etag-' + stagingVersion++;
      saved.set(key, { bytes: actual, sha256, etag, contentType: 'video/mp4' });
      return { key, sizeBytes, sha256, etag, contentType: 'video/mp4' };
    }),
  };
  const download = vi.fn(
    async (_url: URL, _signal: AbortSignal, consume: (response: Response) => Promise<unknown>) =>
      consume(new Response(bytes)),
  ) as unknown as typeof withPublicHttps;
  const probe = vi.fn<VideoProbe>(async () => ({
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoCodec: 'h264',
    width: 640,
    height: 360,
    durationSeconds: 4,
    hasAudio: false,
    audioCodec: null,
  }));
  const row = { id: randomUUID(), owner_id: randomUUID() } as VideoExecution;
  const start = (root = directory) => createVideoMaterializer(objects, root, probe, download);
  return {
    bytes,
    directory,
    objects,
    saved,
    download,
    probe,
    row,
    run: start(),
    start,
    checkpoint: (name: string) => join(directory, 'video', row.id, name),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

async function observeDirectorySync(directory: string, beforeSync: () => Promise<void>) {
  const handle = await open(directory, 'r');
  const { ino, dev } = await handle.stat();
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  const sync = prototype.sync;
  return vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
    const info = await this.stat();
    if (info.ino === ino && info.dev === dev) await beforeSync();
    await sync.call(this);
  });
}

describe('durable video materialization', () => {
  it('uses one MD5-checked staging PUT and one copy bound to the probed source', async () => {
    const f = await fixture();
    try {
      const output = await f.run(f.row, video, 0, AbortSignal.timeout(5000));
      expect(output).toMatchObject({
        width: 640,
        height: 360,
        durationMs: 4000,
        contentType: 'video/mp4',
      });
      expect(output.key).toMatch(new RegExp('^mio/raw/' + output.assetId + '/'));
      const command = f.probe.mock.calls[0]![0];
      expect(command.source.stagingKey).toContain('mio/staging/video/' + f.row.id + '/0/');
      expect(f.objects.copy).toHaveBeenCalledWith(
        command.source.stagingKey,
        output.key,
        command.source.etag,
        'private',
        { contentType: 'video/mp4', sha256: output.sha256, signal: expect.any(AbortSignal) },
      );
      expect(await f.start()(f.row, video, 0, AbortSignal.timeout(5000))).toEqual(output);
      expect(f.download).toHaveBeenCalledTimes(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
      expect(f.objects.copy).toHaveBeenCalledTimes(1);
      expect(f.probe).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
  it('reconciles staging before reading stale local bytes after a lost upload acknowledgement', async () => {
    const f = await fixture();
    try {
      const put = f.objects.putVideo!;
      const upload = vi.mocked(put).getMockImplementation()!;
      vi.mocked(put).mockImplementationOnce(async (...args) => {
        await upload(...args);
        throw new Error('lost acknowledgement');
      });
      await expect(f.run(f.row, video, 0, AbortSignal.timeout(5000))).rejects.toThrow(
        'lost acknowledgement',
      );
      await writeFile(f.checkpoint('0.media'), 'stale bytes');
      expect(await f.run(f.row, video, 0, AbortSignal.timeout(5000))).toMatchObject({ index: 0 });
      expect(f.download).toHaveBeenCalledTimes(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
      expect(f.objects.copy).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it.each(['media', 'json'])(
    'keeps the first %s publication during overlapping claims',
    async (boundary) => {
      const f = await fixture();
      const index = 3;
      const file = f.checkpoint(`${index}.media`);
      const receipt = f.checkpoint(`${index}.json`);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let sync: Awaited<ReturnType<typeof observeDirectorySync>> | undefined;
      if (boundary === 'media') {
        vi.mocked(f.download).mockImplementationOnce(async (_url, _signal, consume) => {
          entered.resolve();
          await resume.promise;
          return consume(new Response('older supplier bytes'));
        });
      } else {
        const directory = f.checkpoint('');
        await mkdir(directory, { recursive: true });
        let pause = true;
        sync = await observeDirectorySync(directory, async () => {
          if (!pause || !(await readdir(directory)).includes(`${index}.media`)) return;
          pause = false;
          entered.resolve();
          await resume.promise;
        });
      }

      const signal = AbortSignal.timeout(5000);
      const older = f.run({ ...f.row, claim_id: randomUUID() }, video, index, signal);
      try {
        await Promise.race([
          entered.promise,
          older.then(() => {
            throw new Error('older claim finished before the overlap');
          }),
        ]);
        const newer = await f.start()({ ...f.row, claim_id: randomUUID() }, video, index, signal);
        const winner = await readFile(receipt, 'utf8');
        expect(JSON.parse(winner)).toMatchObject({
          jobId: f.row.id,
          index,
          assetId: newer.assetId,
          rawEtag: newer.etag,
        });
        resume.resolve();

        await expect(older).resolves.toEqual(newer);
        expect(await readFile(receipt, 'utf8')).toBe(winner);
        expect(await readFile(file)).toEqual(f.bytes);
        expect((await readdir(f.checkpoint(''))).sort()).toEqual([
          `${index}.json`,
          `${index}.media`,
        ]);
        const probe = f.probe.mock.calls[0]![0];
        expect(newer.key).toBe(`mio/raw/${newer.assetId}/${probe.attemptId}`);
        expect([...f.saved.keys()]).toEqual([probe.source.stagingKey, newer.key]);
        expect(f.saved.get(newer.key)?.bytes).toEqual(f.bytes);
        expect(f.download).toHaveBeenCalledTimes(boundary === 'media' ? 2 : 1);
        expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
        expect(f.probe).toHaveBeenCalledTimes(1);
        expect(f.objects.copy).toHaveBeenCalledTimes(1);
      } finally {
        resume.resolve();
        await older.catch(() => {});
        sync?.mockRestore();
        await f.close();
      }
    },
  );

  it.each(['media', 'json'])(
    'retries a %s publication after its parent sync fails',
    async (extension) => {
      const f = await fixture();
      const index = 3;
      const error = Object.assign(new Error('checkpoint directory sync failed'), { code: 'EIO' });
      const directory = f.checkpoint('');
      await mkdir(directory, { recursive: true });
      let fail = true;
      const synced: string[][] = [];
      const sync = await observeDirectorySync(directory, async () => {
        const names = (await readdir(directory)).sort();
        if (fail && names.includes(`${index}.${extension}`)) {
          fail = false;
          throw error;
        }
        synced.push(names);
      });
      try {
        const signal = AbortSignal.timeout(5000);
        await expect(f.run(f.row, video, index, signal)).rejects.toBe(error);
        expect(await readFile(f.checkpoint(`${index}.media`))).toEqual(f.bytes);
        expect((await readdir(directory)).sort()).toEqual(
          extension === 'media' ? [`${index}.media`] : [`${index}.json`, `${index}.media`],
        );
        const firstReceipt = readFile(f.checkpoint(`${index}.json`), 'utf8');
        if (extension === 'media')
          await expect(firstReceipt).rejects.toMatchObject({ code: 'ENOENT' });
        else expect(JSON.parse(await firstReceipt)).toMatchObject({ jobId: f.row.id, index });
        expect(f.objects.putVideo).not.toHaveBeenCalled();
        expect(f.probe).not.toHaveBeenCalled();

        const fragment = f.checkpoint(`${index}.media.${randomUUID()}`);
        await writeFile(fragment, 'unrelated temporary bytes');
        vi.mocked(f.download).mockImplementationOnce(async (_url, _signal, consume) =>
          consume(new Response(null, { status: 403 })),
        );
        const output = await f.start()(f.row, video, index, signal);
        expect(output).toMatchObject({
          index,
          sha256: createHash('sha256').update(f.bytes).digest('hex'),
        });
        const receipt = JSON.parse(await readFile(f.checkpoint(`${index}.json`), 'utf8'));
        if (extension === 'json')
          expect(receipt.assetId).toBe(JSON.parse(await firstReceipt).assetId);
        expect(synced.some((names) => names.includes(`${index}.json`))).toBe(true);
        expect(f.probe.mock.calls[0]![0].outputIndex).toBe(index);
        expect(f.download).toHaveBeenCalledTimes(1);
        expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
        expect(await readFile(fragment, 'utf8')).toBe('unrelated temporary bytes');
      } finally {
        sync.mockRestore();
        await f.close();
      }
    },
  );

  it.each([401, 403, 404, 410, 503])(
    'classifies supplier HTTP %s with only a temporary fragment',
    async (status) => {
      const f = await fixture();
      try {
        const index = 3;
        await mkdir(f.checkpoint(''), { recursive: true });
        const fragment = `${index}.media.${randomUUID()}`;
        await writeFile(f.checkpoint(fragment), f.bytes);
        vi.mocked(f.download).mockImplementationOnce(async (_url, _signal, consume) =>
          consume(new Response(null, { status })),
        );
        const output = f.run(f.row, video, index, AbortSignal.timeout(5000));
        if (status === 503) await expect(output).rejects.toThrow('VIDEO_DOWNLOAD_FAILED');
        else await expect(output).rejects.toBeInstanceOf(VideoResultUrlExpired);
        expect(f.download).toHaveBeenCalledTimes(1);
        expect(f.objects.putVideo).not.toHaveBeenCalled();
        expect(await readFile(f.checkpoint(fragment))).toEqual(f.bytes);
        expect(await readdir(f.checkpoint(''))).toEqual([fragment]);
      } finally {
        await f.close();
      }
    },
  );

  it.each(['disconnect', 'shutdown'])(
    'removes its partly written download after %s and leaves an overlapping winner intact',
    async (failure) => {
      const f = await fixture();
      const stop = new AbortController();
      const reason = new Error(failure);
      const previous = `0.media.${randomUUID()}`;
      await mkdir(f.checkpoint(''), { recursive: true });
      await writeFile(f.checkpoint(previous), 'older fragment');
      const { response, finish } = pauseVideoBody(Buffer.from('interrupted source bytes'));
      vi.mocked(f.download).mockImplementationOnce((_url, _signal, consume) => consume(response));
      const operation = f.run(f.row, video, 0, stop.signal).catch((error: unknown) => error);
      try {
        await vi.waitFor(async () => {
          const names = (await readdir(f.checkpoint(''))).filter((name) => name !== previous);
          expect(names).toHaveLength(1);
          expect(await readFile(f.checkpoint(names[0]!), 'utf8')).toBe('interrupted source bytes');
        });
        await f.start()(f.row, video, 0, AbortSignal.timeout(5000));
        const winner = await readFile(f.checkpoint('0.json'));
        if (failure === 'disconnect') finish.reject(reason);
        else {
          stop.abort(reason);
          finish.resolve();
        }
        expect(await operation).toBe(reason);
        expect((await readdir(f.checkpoint(''))).sort()).toEqual(['0.json', '0.media', previous]);
        expect(await readFile(f.checkpoint('0.media'))).toEqual(f.bytes);
        expect(await readFile(f.checkpoint('0.json'))).toEqual(winner);
        expect(await readFile(f.checkpoint(previous), 'utf8')).toBe('older fragment');
        expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
      } finally {
        finish.resolve();
        await operation;
        await f.close();
      }
    },
  );

  it.each(['length mismatch', 'ENOSPC', 'link failure'])(
    'reclaims a download without publishing it after %s',
    async (failure) => {
      const f = await fixture();
      const reason = new Error(
        failure === 'length mismatch' ? 'VIDEO_DOWNLOAD_INCOMPLETE' : failure,
      );
      const sys = await vi.importActual<typeof AsyncFileSystem>('node:fs/promises');
      const opened = vi.mocked(open);
      const linked = vi.mocked(link);
      const previous = `0.media.${randomUUID()}`;
      try {
        await mkdir(f.checkpoint(''), { recursive: true });
        await writeFile(f.checkpoint(previous), 'older fragment');
        if (failure === 'length mismatch') {
          vi.mocked(f.download).mockImplementationOnce((_url, _signal, consume) =>
            consume(
              new Response(f.bytes, { headers: { 'content-length': String(f.bytes.length + 1) } }),
            ),
          );
        } else if (failure === 'ENOSPC') {
          Object.assign(reason, { code: 'ENOSPC' });
          opened.mockImplementation(async (path, ...options) => {
            const handle = await sys.open(path, ...options);
            if (String(path).startsWith(f.checkpoint('0.media.'))) {
              const write = handle.write.bind(handle);
              vi.spyOn(handle, 'write').mockImplementationOnce(async () => {
                await write(f.bytes, 0, 7);
                throw reason;
              });
            }
            return handle;
          });
        } else linked.mockRejectedValueOnce(reason);
        await expect(f.run(f.row, video, 0, AbortSignal.timeout(5000))).rejects.toThrow(reason);
        expect(await readdir(f.checkpoint(''))).toEqual([previous]);
        expect(await readFile(f.checkpoint(previous), 'utf8')).toBe('older fragment');
        expect(f.objects.putVideo).not.toHaveBeenCalled();
      } finally {
        opened.mockReset();
        linked.mockReset();
        await f.close();
      }
    },
  );

  it.each(['unlink error', 'shutdown'])(
    'retains the canonical download after the hard link followed by %s',
    async (failure) => {
      const f = await fixture();
      const stop = new AbortController();
      const reason = new Error(failure);
      const sys = await vi.importActual<typeof AsyncFileSystem>('node:fs/promises');
      const removed = vi.mocked(unlink);
      const linked = vi.mocked(link);
      try {
        if (failure === 'unlink error') removed.mockRejectedValueOnce(reason);
        else {
          linked.mockImplementationOnce(async (...args) => {
            await sys.link(...args);
            stop.abort(reason);
          });
        }
        await expect(f.run(f.row, video, 0, stop.signal)).rejects.toBe(reason);
        expect(await readdir(f.checkpoint(''))).toEqual(['0.media']);
        expect(await readFile(f.checkpoint('0.media'))).toEqual(f.bytes);
        expect(f.objects.putVideo).not.toHaveBeenCalled();
        await expect(f.start()(f.row, video, 0, AbortSignal.timeout(5000))).resolves.toMatchObject({
          index: 0,
        });
        expect(f.download).toHaveBeenCalledTimes(1);
      } finally {
        removed.mockReset();
        linked.mockReset();
        await f.close();
      }
    },
  );

  it('keeps a randomized path whose exclusive open collides and releases its reservation', async () => {
    const f = await fixture();
    const disk = mockFreeSpace(f.directory, 650);
    const sys = await vi.importActual<typeof AsyncFileSystem>('node:fs/promises');
    const opened = vi.mocked(open);
    let existing = '';
    try {
      opened.mockImplementation(async (path, ...options) => {
        if (String(path).startsWith(f.checkpoint('0.media.'))) {
          existing = String(path);
          await writeFile(path, 'existing unowned file', { flag: 'wx' });
        }
        return sys.open(path, ...options);
      });
      await expect(f.run(f.row, video, 0, AbortSignal.timeout(5000))).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(await readFile(existing, 'utf8')).toBe('existing unowned file');
      expect(f.download).not.toHaveBeenCalled();
      opened.mockReset();
      await expect(f.run(f.row, video, 0, AbortSignal.timeout(5000))).resolves.toMatchObject({
        index: 0,
      });
      expect(await readFile(existing, 'utf8')).toBe('existing unowned file');
    } finally {
      opened.mockReset();
      disk.mockReset();
      await f.close();
    }
  });

  it('reports a failed temporary unlink without exposing the path or losing the expiry error', async () => {
    const f = await fixture();
    const failure = Object.assign(new Error(f.checkpoint('private-fault-path')), { code: 'EIO' });
    const removed = vi.mocked(unlink).mockClear().mockRejectedValueOnce(failure);
    let logged = '';
    const output = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      logged += String(chunk);
      return true;
    });
    try {
      vi.mocked(f.download).mockImplementationOnce((_url, _signal, consume) =>
        consume(new Response(null, { status: 404 })),
      );
      await expect(f.run(f.row, video, 0, AbortSignal.timeout(5000))).rejects.toBeInstanceOf(
        VideoResultUrlExpired,
      );
      expect(JSON.parse(logged)).toMatchObject({ event: 'VIDEO_DOWNLOAD_CLEANUP_FAILED' });
      expect(logged).not.toContain('private-fault-path');
      expect(removed.mock.calls[0]![0]).toMatch(/^.*\/0\.media\.[a-f0-9-]+$/);
      expect(await readdir(f.checkpoint(''))).toHaveLength(1);
    } finally {
      output.mockRestore();
      removed.mockReset();
      await f.close();
    }
  });

  it.each(['shutdown', 'failure'])(
    'admits one of four downloads with 650 MiB free and releases it on %s',
    async (failure) => {
      const f = await fixture();
      const alias = join(f.directory, 'alias');
      await symlink(f.directory, alias, 'dir');
      const disk = mockFreeSpace(f.directory, 650);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const stop = new AbortController();
      const reason = new Error(failure);
      vi.mocked(f.download).mockImplementationOnce(async (_url, signal, consume) => {
        entered.resolve();
        await resume.promise;
        signal.throwIfAborted();
        if (failure === 'failure') throw reason;
        return consume(new Response(f.bytes));
      });
      const settled: unknown[] = [];
      const calls = Array.from({ length: 4 }, (_, index) => {
        const row = { ...f.row, id: randomUUID() };
        return f
          .start(index % 2 ? alias : f.directory)(row, video, index, stop.signal)
          .catch((error: unknown) => error)
          .then((outcome) => settled.push(outcome));
      });
      try {
        await entered.promise;
        await vi.waitFor(() => expect(settled).toHaveLength(3));
        for (const outcome of settled)
          expect(outcome).toMatchObject({ message: 'VIDEO_DISK_FULL' });
        expect(f.download).toHaveBeenCalledTimes(1);
        expect(f.objects.putVideo).not.toHaveBeenCalled();
        if (failure === 'shutdown') stop.abort(reason);
        resume.resolve();
        await Promise.all(calls);
        expect(settled[3]).toBe(reason);
        await expect(f.run(f.row, video, 0, AbortSignal.timeout(5000))).resolves.toMatchObject({
          index: 0,
        });
        expect(f.download).toHaveBeenCalledTimes(2);
      } finally {
        resume.resolve();
        await Promise.all(calls);
        disk.mockReset();
        await f.close();
      }
    },
  );

  it.each([
    { size: 450, allocated: 450, admits: true },
    { size: 450, allocated: 400, admits: false },
    { size: 400, allocated: 450, admits: false },
  ])(
    'uses both length $size MiB and allocation $allocated MiB before sampling free bytes',
    async ({ size, allocated, admits }) => {
      const f = await fixture();
      const disk = mockFreeSpace(f.directory, 650);
      const space = statfsSync(f.directory, { bigint: true });
      const inspect = vi.mocked(lstatSync);
      const { response, finish } = pauseVideoBody(f.bytes);
      vi.mocked(f.download).mockImplementationOnce((_url, _signal, consume) => consume(response));
      const first = f.run(f.row, video, 0, AbortSignal.timeout(5000));
      try {
        const temporary = await vi.waitFor(async () => {
          const names = await readdir(f.checkpoint(''));
          expect(names).toHaveLength(1);
          const path = f.checkpoint(names[0]!);
          expect(await readFile(path)).toEqual(f.bytes);
          return path;
        });
        const info = lstatSync(temporary);
        const observed: string[] = [];
        inspect.mockImplementation((path) => {
          expect(path).toBe(temporary);
          observed.push('allocated');
          return Object.assign(info, { size: size * MiB, blocks: (allocated * MiB) / 512 });
        });
        disk.mockImplementation(() => {
          observed.push('free');
          return space;
        });
        const second = f.start()(
          { ...f.row, id: randomUUID() },
          video,
          0,
          AbortSignal.timeout(5000),
        );
        if (admits) await expect(second).resolves.toMatchObject({ index: 0 });
        else await expect(second).rejects.toThrow('VIDEO_DISK_FULL');
        expect(observed).toEqual(['allocated', 'free']);
        finish.resolve();
        await expect(first).resolves.toMatchObject({ index: 0 });
      } finally {
        finish.resolve();
        await first.catch(() => {});
        inspect.mockReset();
        disk.mockReset();
        await f.close();
      }
    },
  );

  it('refuses a canonical media symlink and still materializes a different index', async () => {
    const f = await fixture();
    try {
      await mkdir(f.checkpoint(''), { recursive: true });
      const target = join(f.directory, 'other-identity');
      await writeFile(target, f.bytes);
      await symlink(target, f.checkpoint('3.media'));
      const signal = AbortSignal.timeout(5000);
      await expect(f.run(f.row, video, 3, signal)).rejects.toMatchObject({ code: 'ELOOP' });
      expect(f.download).not.toHaveBeenCalled();
      expect(f.objects.putVideo).not.toHaveBeenCalled();
      expect(await f.run(f.row, video, 4, signal)).toMatchObject({ index: 4 });
      expect(await readFile(target)).toEqual(f.bytes);
    } finally {
      await f.close();
    }
  });

  it('checks recovered bytes against the original receipt when all media copies were absent', async () => {
    const f = await fixture();
    try {
      const index = 3;
      const signal = AbortSignal.timeout(5000);
      vi.mocked(f.objects.putVideo!).mockRejectedValueOnce(new Error('staging unavailable'));
      await expect(f.run(f.row, video, index, signal)).rejects.toThrow('staging unavailable');
      const path = f.checkpoint(`${index}.json`);
      const firstReceipt = await readFile(path, 'utf8');
      await unlink(f.checkpoint(`${index}.media`));
      const fragment = `${index}.media.${randomUUID()}`;
      await writeFile(f.checkpoint(fragment), 'unrelated bytes');

      const restored = f.start();
      vi.mocked(f.download).mockImplementationOnce(async (_url, _signal, consume) =>
        consume(new Response(null, { status: 410 })),
      );
      await expect(restored(f.row, video, index, signal)).rejects.toBeInstanceOf(
        VideoResultUrlExpired,
      );
      vi.mocked(f.download).mockImplementationOnce(async (_url, _signal, consume) =>
        consume(new Response('different result content')),
      );
      const refreshed = { url: 'https://video.fixture/refreshed.mp4' };
      await expect(restored(f.row, refreshed, index, signal)).rejects.toThrow(
        'VIDEO_CHECKPOINT_INVALID',
      );
      expect(await readFile(path, 'utf8')).toBe(firstReceipt);
      expect((await readdir(f.checkpoint(''))).sort()).toEqual([`${index}.json`, fragment]);
      expect(await readFile(f.checkpoint(fragment), 'utf8')).toBe('unrelated bytes');
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
      const { assetId, attemptId, sha256 } = JSON.parse(firstReceipt);
      expect(await restored(f.row, refreshed, index, signal)).toMatchObject({
        index,
        assetId,
        key: `mio/raw/${assetId}/${attemptId}`,
        sha256,
      });
    } finally {
      await f.close();
    }
  });

  it('recovers byte loss with a saved probe receipt and reprobes the restored stage', async () => {
    const f = await fixture();
    try {
      const index = 3;
      const signal = AbortSignal.timeout(5000);
      const copy = vi.mocked(f.objects.copy);
      copy.mockRejectedValueOnce(new Error('interrupted before copy'));
      await expect(f.run(f.row, video, index, signal)).rejects.toThrow('interrupted before copy');
      const path = f.checkpoint(`${index}.json`);
      const firstReceipt = await readFile(path, 'utf8');
      const { assetId, attemptId, sha256, sizeBytes, etag } = JSON.parse(firstReceipt);
      const source = f.probe.mock.calls[0]![0].source;
      const rawKey = `mio/raw/${assetId}/${attemptId}`;
      expect(JSON.parse(firstReceipt)).toMatchObject({
        jobId: f.row.id,
        index,
        media: { width: 640 },
      });
      expect(etag).toBe(source.etag);
      expect(f.saved.has(rawKey)).toBe(false);
      expect(f.saved.delete(source.stagingKey)).toBe(true);
      await unlink(f.checkpoint(`${index}.media`));

      const restored = f.start();
      vi.mocked(f.download).mockImplementationOnce(async (_url, _signal, consume) =>
        consume(new Response(null, { status: 410 })),
      );
      await expect(restored(f.row, video, index, signal)).rejects.toBeInstanceOf(
        VideoResultUrlExpired,
      );
      vi.mocked(f.download).mockImplementationOnce(async (_url, _signal, consume) =>
        consume(new Response(Buffer.alloc(sizeBytes, 7))),
      );
      const refreshed = { url: 'https://video.fixture/refreshed.mp4' };
      await expect(restored(f.row, refreshed, index, signal)).rejects.toThrow(
        'VIDEO_CHECKPOINT_INVALID',
      );
      expect(await readFile(path, 'utf8')).toBe(firstReceipt);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
      expect(f.probe).toHaveBeenCalledTimes(1);
      expect(copy).toHaveBeenCalledTimes(1);

      const output = await restored(f.row, refreshed, index, signal);
      expect(output).toMatchObject({ index, key: rawKey, assetId, sha256, sizeBytes });
      expect(f.download).toHaveBeenCalledTimes(4);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(2);
      expect(f.probe).toHaveBeenCalledTimes(2);
      const reprobe = f.probe.mock.calls[1]![0];
      expect(reprobe).toMatchObject({ jobId: f.row.id, outputIndex: index, attemptId });
      expect(reprobe.source).toEqual({ ...source, etag: f.saved.get(source.stagingKey)!.etag });
      expect(reprobe.source.etag).not.toBe(etag);
      expect(copy).toHaveBeenCalledTimes(2);
      expect(copy.mock.calls[1]!.slice(0, 4)).toEqual([
        source.stagingKey,
        rawKey,
        reprobe.source.etag,
        'private',
      ]);
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        assetId,
        attemptId,
        etag: reprobe.source.etag,
      });
    } finally {
      await f.close();
    }
  });

  it('reconciles a restored stage after losing its upload acknowledgement', async () => {
    const f = await fixture();
    try {
      const index = 3;
      const signal = AbortSignal.timeout(5000);
      const copy = vi.mocked(f.objects.copy);
      copy.mockRejectedValueOnce(new Error('interrupted before copy'));
      await expect(f.run(f.row, video, index, signal)).rejects.toThrow('interrupted before copy');
      const path = f.checkpoint(`${index}.json`);
      const { assetId, attemptId, sha256, sizeBytes } = JSON.parse(await readFile(path, 'utf8'));
      const { stagingKey, etag } = f.probe.mock.calls[0]![0].source;
      expect(f.saved.delete(stagingKey)).toBe(true);

      const put = vi.mocked(f.objects.putVideo!);
      const upload = put.getMockImplementation()!;
      put.mockImplementationOnce(async (...args) => {
        await upload(...args);
        throw new Error('lost replacement acknowledgement');
      });
      await expect(f.start()(f.row, video, index, signal)).rejects.toThrow(
        'lost replacement acknowledgement',
      );
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        jobId: f.row.id,
        index,
        assetId,
        attemptId,
        sha256,
        sizeBytes,
      });
      expect(f.saved.get(stagingKey)?.etag).not.toBe(etag);

      const rawKey = `mio/raw/${assetId}/${attemptId}`;
      expect(await f.start()(f.row, video, index, signal)).toMatchObject({ index, key: rawKey });
      expect(f.download).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledTimes(2);
      expect(f.probe).toHaveBeenCalledTimes(2);
      const reprobe = f.probe.mock.calls[1]![0];
      expect(reprobe.source).toMatchObject({ stagingKey, etag: f.saved.get(stagingKey)!.etag });
      expect(copy).toHaveBeenCalledTimes(2);
      expect(copy.mock.calls[1]!.slice(0, 3)).toEqual([stagingKey, rawKey, reprobe.source.etag]);
    } finally {
      await f.close();
    }
  });
  it('does not upload when storage existence is unknown or publish unprobed bytes', async () => {
    const f = await fixture();
    try {
      vi.mocked(f.objects.head).mockRejectedValueOnce(
        Object.assign(new Error('unavailable'), { statusCode: 503 }),
      );
      await expect(f.run(f.row, video, 0, AbortSignal.timeout(5000))).rejects.toThrow(
        'unavailable',
      );
      expect(f.objects.putVideo).not.toHaveBeenCalled();
      f.probe.mockRejectedValueOnce(new Error('VIDEO_PROBE_FAILED'));
      await expect(f.run(f.row, video, 0, AbortSignal.timeout(5000))).rejects.toThrow(
        'VIDEO_PROBE_FAILED',
      );
      expect([...f.saved.keys()].every((key) => key.startsWith('mio/staging/'))).toBe(true);
      expect(f.objects.copy).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('stops materialization while staging HEAD is hung and ignores a late response', async () => {
    const f = await fixture();
    const started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<COS.HeadObjectResult>();
    const head = vi.spyOn(COS.prototype, 'headObject').mockImplementation(() => {
      started.resolve();
      return reply.promise;
    });
    const storage = cosFixture();
    const stop = new AbortController();
    const reason = new Error('fixture shutdown');
    try {
      vi.mocked(f.objects.head).mockImplementationOnce(storage.head);
      const pending = f.run(f.row, video, 0, stop.signal);
      await started.promise;
      stop.abort(reason);
      await expect(pending).rejects.toBe(reason);
      reply.reject(Object.assign(new Error('late staging miss'), { statusCode: 404 }));
      await reply.promise.catch(() => {});
      expect(f.objects.putVideo).not.toHaveBeenCalled();
      expect(f.objects.copy).not.toHaveBeenCalled();
      expect(f.probe).not.toHaveBeenCalled();
    } finally {
      head.mockRestore();
      await f.close();
    }
  });

  it('preserves the full probe wait and starts a fresh finalization deadline', async () => {
    const f = await fixture();
    const stop = new AbortController();
    const staging = new AbortController();
    const finalizing = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(staging.signal)
      .mockReturnValueOnce(finalizing.signal);
    const entered = Promise.withResolvers<AbortSignal>();
    const reply = Promise.withResolvers<void>();
    const probe = f.probe.getMockImplementation()!;
    f.probe.mockImplementationOnce(async (command, signal) => {
      entered.resolve(signal);
      await reply.promise;
      signal.throwIfAborted();
      return probe(command, signal);
    });
    try {
      const pending = f.run(f.row, video, 3, stop.signal);
      const probeSignal = await entered.promise;
      staging.abort(new Error('staging deadline elapsed during probe'));
      reply.resolve();
      await expect(pending).resolves.toMatchObject({ index: 3 });
      expect(probeSignal).toBe(stop.signal);
      const uploadSignal = vi.mocked(f.objects.putVideo!).mock.calls[0]![5];
      const copySignal = vi.mocked(f.objects.copy).mock.calls[0]![4]!.signal;
      expect(uploadSignal.aborted).toBe(true);
      expect(copySignal.aborted).toBe(false);
      expect(timeout.mock.calls).toEqual([[180_000], [180_000]]);
      finalizing.abort();
      expect(copySignal.aborted).toBe(true);
      expect(probeSignal.aborted).toBe(false);
    } finally {
      reply.resolve();
      timeout.mockRestore();
      await f.close();
    }
  });

  it('reconciles an in-flight copy after shutdown without a second write', async () => {
    const f = await fixture();
    const stop = new AbortController();
    const reason = new Error('fixture shutdown');
    let reply: ReturnType<typeof holdCosResponse> | undefined;
    const request = vi.spyOn(COS.prototype, 'request').mockImplementation(async (params) => {
      expect(params.Method).toBe('PUT');
      const stage = f.probe.mock.calls[0]![0].source.stagingKey;
      f.saved.set(params.Key!, { ...f.saved.get(stage)!, etag: 'copied-before-shutdown' });
      reply = holdCosResponse(params);
      return reply.promise;
    });
    const fallback = vi
      .spyOn(COS.prototype, 'putObjectCopy')
      .mockRejectedValue(new Error('unexpected uninterruptible copy'));
    try {
      vi.mocked(f.objects.copy).mockImplementationOnce(cosFixture().copy);
      const finished = vi.fn();
      const pending = f.run(f.row, video, 0, stop.signal).then(finished, finished);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      stop.abort(reason);
      await vi.waitFor(() => expect(finished).toHaveBeenCalledExactlyOnceWith(reason));
      await pending;
      expect(fallback).not.toHaveBeenCalled();
      const original = vi.mocked(f.objects.copy).mock.calls[0]!;
      expect(f.saved.get(original[1])?.etag).toBe('copied-before-shutdown');
      expect(JSON.parse(await readFile(f.checkpoint('0.json'), 'utf8')).rawEtag).toBeUndefined();
      const head = vi.mocked(f.objects.head).mockClear();
      const restored = await f.start()(f.row, video, 0, AbortSignal.timeout(5000));
      expect(restored).toMatchObject({ key: original[1], etag: 'copied-before-shutdown' });
      expect(head.mock.calls.map(([key]) => key)).toEqual([original[1]]);
      expect(f.objects.copy).toHaveBeenCalledTimes(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
      expect(f.probe).toHaveBeenCalledTimes(1);
    } finally {
      stop.abort(reason);
      reply?.reject(reason);
      request.mockRestore();
      fallback.mockRestore();
      await f.close();
    }
  });

  it('keeps the probed ETag and refuses an existing changed stage on restart', async () => {
    const f = await fixture();
    try {
      const probe = f.probe.getMockImplementation()!;
      f.probe.mockImplementationOnce(async (command, signal) => {
        const metadata = await probe(command, signal);
        const source = f.saved.get(command.source.stagingKey)!;
        f.saved.set(command.source.stagingKey, { ...source, etag: 'replacement' });
        return metadata;
      });
      await expect(f.run(f.row, video, 0, AbortSignal.timeout(5000))).rejects.toMatchObject({
        statusCode: 412,
      });
      const receipt = JSON.parse(
        await readFile(join(f.directory, 'video', f.row.id, '0.json'), 'utf8'),
      );
      const command = f.probe.mock.calls[0]![0];
      expect(receipt.etag).toBe(command.source.etag);
      expect(receipt.rawEtag).toBeUndefined();
      await expect(f.start()(f.row, video, 0, AbortSignal.timeout(5000))).rejects.toThrow(
        'VIDEO_OBJECT_MISMATCH',
      );
      const target = `mio/raw/${receipt.assetId}/${receipt.attemptId}`;
      expect(vi.mocked(f.objects.copy).mock.calls.map((args) => args.slice(0, 4))).toEqual([
        [command.source.stagingKey, target, command.source.etag, 'private'],
      ]);
      expect(f.saved.has(target)).toBe(false);
      expect(f.download).toHaveBeenCalledTimes(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
      expect(f.probe).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it('retains a known copy receipt across restarts when raw HEAD reports a different ETag', async () => {
    const f = await fixture();
    try {
      const copy = vi.mocked(f.objects.copy).getMockImplementation()!;
      vi.mocked(f.objects.copy).mockImplementationOnce(async (...args) => {
        await copy(...args);
        return { etag: 'copy-acknowledged-etag' };
      });
      await expect(f.run(f.row, video, 0, AbortSignal.timeout(5000))).rejects.toThrow(
        'VIDEO_OBJECT_MISMATCH',
      );
      await expect(f.start()(f.row, video, 0, AbortSignal.timeout(5000))).rejects.toThrow(
        'VIDEO_OBJECT_MISMATCH',
      );
      expect(f.objects.copy).toHaveBeenCalledTimes(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it('reuses a verified raw object before touching stale local bytes or the supplier', async () => {
    const f = await fixture();
    try {
      const index = 3;
      const signal = AbortSignal.timeout(5000);
      const output = await f.run(f.row, video, index, signal);
      f.saved.delete(f.probe.mock.calls[0]![0].source.stagingKey);
      const file = f.checkpoint(`${index}.media`);
      await writeFile(file, 'stale local bytes');
      const head = vi.mocked(f.objects.head);
      head.mockClear();
      vi.mocked(f.download).mockImplementationOnce(async (_url, _signal, consume) =>
        consume(new Response(null, { status: 403 })),
      );

      expect(await f.start()(f.row, video, index, signal)).toEqual(output);
      expect(head.mock.calls.map(([key]) => key)).toEqual([output.key]);
      expect(f.download).toHaveBeenCalledTimes(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
      expect(f.objects.copy).toHaveBeenCalledTimes(1);
      expect(f.probe).toHaveBeenCalledTimes(1);
      expect(await readFile(file, 'utf8')).toBe('stale local bytes');
    } finally {
      await f.close();
    }
  });

  it('rejects a known raw object that is missing or has a different size, digest or MIME', async () => {
    const f = await fixture();
    try {
      const output = await f.run(f.row, video, 0, AbortSignal.timeout(5000));
      const raw = f.saved.get(output.key)!;
      const changed = [
        { ...raw, bytes: Buffer.concat([raw.bytes, Buffer.from([0])]) },
        { ...raw, sha256: 'f'.repeat(64) },
        { ...raw, contentType: 'application/octet-stream' },
      ];
      for (const object of changed) {
        f.saved.set(output.key, object);
        await expect(f.start()(f.row, video, 0, AbortSignal.timeout(5000))).rejects.toThrow(
          'VIDEO_OBJECT_MISMATCH',
        );
      }
      f.saved.delete(output.key);
      await expect(f.start()(f.row, video, 0, AbortSignal.timeout(5000))).rejects.toThrow(
        'VIDEO_OBJECT_MISMATCH',
      );
      expect(f.download).toHaveBeenCalledTimes(1);
      expect(f.objects.copy).toHaveBeenCalledTimes(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
});

it('reconciles a lost copy acknowledgement and cleanup interrupted by executor shutdown', async () => {
  const f = await fixture();
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  const store = new VideoGenerationStore(pool);
  const execution = store.executorStore();
  try {
    await pool.query(assetSchemaSQL);
    await pool.query(generationSchemaSQL);
    await execution.startExecutor(() => {});
    const request: VideoCreateRequest = {
      requestId: randomUUID(),
      modelRef: 'onelink:model:' + randomUUID(),
      expectedCapabilitiesVersion: 'fixture-capabilities',
      parameters: { mode: 'text_to_video', prompt: 'recovery fixture' },
    };
    const owner = f.row.owner_id;
    const { jobId } = await store.create(
      owner,
      request,
      'fixture-request-hash',
      { request, inputSnapshot: [] },
      {},
      {},
      {},
    );
    const claimed = (await execution.claim())!;
    expect(await execution.returned(claimed, videos)).toBe(true);
    await execution.release(claimed);
    const copy = vi.mocked(f.objects.copy).getMockImplementation()!;
    vi.mocked(f.objects.copy).mockImplementationOnce(async (...args) => {
      await copy(...args);
      throw new Error('lost copy acknowledgement');
    });
    const protocol = vi.fn<() => VideoProtocol>();
    const receipts = new VideoSubmissionReceipts(f.directory);
    const signal = AbortSignal.timeout(5000);
    const due = async () => {
      await pool.query('UPDATE mio_video_executions SET next_query_at=now() WHERE job_id=$1', [
        jobId,
      ]);
      return (await execution.claim())!;
    };
    await createVideoRunner(
      execution,
      () => undefined,
      f.run,
      signal,
      { protocol },
      receipts,
    )(await due());
    expect((await store.get(owner, jobId)).state).toBe('materializing');
    expect((await pool.query('SELECT count(*) FROM mio_assets')).rows[0].count).toBe('0');
    const receipt = JSON.parse(await readFile(join(f.directory, 'video', jobId, '0.json'), 'utf8'));
    expect(receipt.rawEtag).toBeUndefined();
    const rawKey = `mio/raw/${receipt.assetId}/${receipt.attemptId}`;
    expect(f.saved.has(rawKey)).toBe(true);
    await unlink(join(f.directory, 'video', jobId, '0.media'));
    await execution.close();
    await execution.startExecutor(() => {});
    await createVideoRunner(
      execution,
      () => undefined,
      f.start(),
      signal,
      { protocol },
      receipts,
    )(await due());
    expect(await store.get(owner, jobId)).toMatchObject({
      state: 'completed',
      outputs: [{ assetId: receipt.assetId, status: 'registered' }],
    });
    const rows = (await pool.query('SELECT id,owner_id,raw_key,source_etag FROM mio_assets')).rows;
    expect(rows).toEqual([
      {
        id: receipt.assetId,
        owner_id: owner,
        raw_key: rawKey,
        source_etag: f.saved.get(rawKey)!.etag,
      },
    ]);
    expect(await execution.claim()).toBeUndefined();
    expect(f.download).toHaveBeenCalledTimes(1);
    expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
    expect(f.objects.copy).toHaveBeenCalledTimes(1);
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(protocol).not.toHaveBeenCalled();

    // Exercise cleanup with the same completed row and both recovery artifacts present.
    await execution.close();
    const mediaFile = join(f.directory, 'video', jobId, '0.media');
    const receiptFile = join(f.directory, 'video', jobId, '0.json');
    await writeFile(mediaFile, f.bytes);
    const durableReceipt = await readFile(receiptFile);
    const history = await store.list(owner, 10);
    const stage = f.probe.mock.calls[0]![0].source.stagingKey;
    let reply: ReturnType<typeof holdCosResponse> | undefined;
    const deleteRequest = vi.spyOn(COS.prototype, 'request').mockImplementation(async (params) => {
      expect(params).toMatchObject({ Key: stage, Method: 'DELETE' });
      expect(f.saved.delete(stage)).toBe(true);
      reply = holdCosResponse(params);
      return reply.promise;
    });
    const fallback = vi
      .spyOn(COS.prototype, 'deleteObject')
      .mockRejectedValue(new Error('unexpected uninterruptible delete'));
    let executor: Awaited<ReturnType<typeof createVideoExecutor>> | undefined;
    const startExecutor = () =>
      createVideoExecutor(
        store,
        () => undefined,
        f.run,
        { protocol, cleanup: createVideoCleanup(f.objects, f.directory) },
        f.directory,
      );
    try {
      vi.mocked(f.objects.delete).mockImplementationOnce(cosFixture().delete);
      executor = await startExecutor();
      await vi.waitFor(() => expect(deleteRequest).toHaveBeenCalledTimes(1), { timeout: 5000 });
      const stopped = vi.fn();
      const closing = executor.close().then(stopped);
      await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1), { timeout: 3000 });
      await closing;
      expect(fallback).not.toHaveBeenCalled();
      expect(await readFile(mediaFile)).toEqual(f.bytes);
      expect(await readFile(receiptFile)).toEqual(durableReceipt);
      expect((await execution.completedCleanup()).map((row) => row.id)).toEqual([jobId]);

      executor = await startExecutor();
      await vi.waitFor(async () => expect(await execution.completedCleanup()).toEqual([]), {
        timeout: 5000,
      });
      expect(await readdir(join(f.directory, 'video', jobId))).toEqual([]);
      expect(f.objects.delete).toHaveBeenCalledTimes(1);
      expect([...f.saved.keys()]).toEqual([rawKey]);
      expect(await store.list(owner, 10)).toEqual(history);
      expect(
        (await pool.query('SELECT id,owner_id,raw_key,source_etag FROM mio_assets')).rows,
      ).toEqual(rows);
    } finally {
      reply?.reject(new Error('fixture cleanup'));
      await executor?.close();
      deleteRequest.mockRestore();
      fallback.mockRestore();
    }
  } finally {
    await execution.close();
    await pool.end();
    await database.close();
    await f.close();
  }
});

it('cleans committed staging and recovery files only after reconciling the reusable raw object', async () => {
  const f = await fixture();
  try {
    const output = await f.run(f.row, video, 0, AbortSignal.timeout(5000));
    const row = { ...f.row, checkpoint: { videos, materializationAttempts: 1 } };
    const clean = createVideoCleanup(f.objects, f.directory);
    await clean(row, AbortSignal.timeout(5000));
    expect([...f.saved.keys()]).toEqual([output.key]);
    await clean(row, AbortSignal.timeout(5000));
    expect(f.objects.delete).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});
