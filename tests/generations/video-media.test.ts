import { randomUUID, createHash } from 'node:crypto';
import {
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
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import COS from 'cos-nodejs-sdk-v5';
import type { VideoProbe } from '../../src/generations/video/media.ts';
import { createVideoMaterializer, createVideoCleanup } from '../../src/generations/video/media.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { createVideoRunner } from '../../src/generations/video/runner.ts';
import { VideoSubmissionReceipts } from '../../src/generations/video/submission-receipts.ts';
import { VideoGenerationStore } from '../../src/generations/video/store.ts';
import type { VideoCreateRequest } from '../../src/generations/video/contracts.ts';
import { VideoResultUrlExpired } from '../../src/generations/video/execution.ts';
import type { VideoExecution, VideoProtocol } from '../../src/generations/video/execution.ts';
import type { withPublicHttps } from '../../src/integrations/onelink/public-https.ts';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { authDatabase } from '../support/auth-database.ts';

const video = { url: 'https://video.fixture/result.mp4' };
const videos = [video];

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
  const start = () => createVideoMaterializer(objects, directory, probe, download);
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
        const fragment = f.checkpoint(`${index}.media.${randomUUID()}`);
        await writeFile(fragment, f.bytes);
        vi.mocked(f.download).mockImplementationOnce(async (_url, _signal, consume) =>
          consume(new Response(null, { status })),
        );
        const output = f.run(f.row, video, index, AbortSignal.timeout(5000));
        if (status === 503) await expect(output).rejects.toThrow('VIDEO_DOWNLOAD_FAILED');
        else await expect(output).rejects.toBeInstanceOf(VideoResultUrlExpired);
        expect(f.download).toHaveBeenCalledTimes(1);
        expect(f.objects.putVideo).not.toHaveBeenCalled();
        expect(await readFile(fragment)).toEqual(f.bytes);
      } finally {
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
    const storage = createCosStorage({
      databaseURL: 'postgresql://example.invalid/media',
      bucket: 'mio-test-1234567890',
      region: 'ap-shanghai',
      secretId: 'fixture',
      secretKey: 'fixture',
    });
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
    const started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<void>();
    const stop = new AbortController();
    const reason = new Error('fixture shutdown');
    try {
      const copy = vi.mocked(f.objects.copy).getMockImplementation()!;
      vi.mocked(f.objects.copy).mockImplementationOnce(async (...args) => {
        const result = await copy(...args);
        started.resolve();
        await reply.promise;
        return result;
      });
      const pending = f.run(f.row, video, 0, stop.signal);
      await started.promise;
      stop.abort(reason);
      reply.resolve();
      await expect(pending).rejects.toBe(reason);
      const original = vi.mocked(f.objects.copy).mock.calls[0]!;
      const restored = await f.start()(f.row, video, 0, AbortSignal.timeout(5000));
      expect(restored.key).toBe(original[1]);
      expect(f.objects.copy).toHaveBeenCalledTimes(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
      expect(f.probe).toHaveBeenCalledTimes(1);
    } finally {
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

it('recovers a lost copy acknowledgement to one owner asset in PostgreSQL after restart', async () => {
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
