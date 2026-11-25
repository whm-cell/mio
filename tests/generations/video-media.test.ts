import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
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
import type { VideoExecution, VideoProtocol } from '../../src/generations/video/execution.ts';
import type { withPublicHttps } from '../../src/integrations/onelink/public-https.ts';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { authDatabase } from '../support/auth-database.ts';

const videos = [{ url: 'https://video.fixture/result.mp4' }];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mio-video-media-'));
  const bytes = Buffer.from('fixture MP4 bytes checked by the worker probe');
  const saved = new Map<
    string,
    { bytes: Buffer; sha256: string; etag: string; contentType: string }
  >();
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
      const etag = 'etag-' + saved.size;
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
    directory,
    objects,
    saved,
    download,
    probe,
    row,
    run: start(),
    start,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

describe('durable video materialization', () => {
  it('uses one MD5-checked staging PUT and one copy bound to the probed source', async () => {
    const f = await fixture();
    try {
      const output = await f.run(f.row, videos, AbortSignal.timeout(5000));
      expect(output[0]).toMatchObject({
        width: 640,
        height: 360,
        durationMs: 4000,
        contentType: 'video/mp4',
      });
      expect(output[0]!.key).toMatch(new RegExp('^mio/raw/' + output[0]!.assetId + '/'));
      const command = f.probe.mock.calls[0]![0];
      expect(command.source.stagingKey).toContain('mio/staging/video/' + f.row.id + '/0/');
      expect(f.objects.copy).toHaveBeenCalledWith(
        command.source.stagingKey,
        output[0]!.key,
        command.source.etag,
        'private',
        { contentType: 'video/mp4', sha256: output[0]!.sha256, signal: expect.any(AbortSignal) },
      );
      expect(await f.start()(f.row, videos, AbortSignal.timeout(5000))).toEqual(output);
      expect(f.download).toHaveBeenCalledTimes(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
      expect(f.objects.copy).toHaveBeenCalledTimes(1);
      expect(f.probe).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
  it('reconciles a completed upload after its acknowledgement is lost', async () => {
    const f = await fixture();
    try {
      const put = f.objects.putVideo!;
      const upload = vi.mocked(put).getMockImplementation()!;
      vi.mocked(put).mockImplementationOnce(async (...args) => {
        await upload(...args);
        throw new Error('lost acknowledgement');
      });
      await expect(f.run(f.row, videos, AbortSignal.timeout(5000))).rejects.toThrow(
        'lost acknowledgement',
      );
      expect((await f.run(f.row, videos, AbortSignal.timeout(5000))).length).toBe(1);
      expect(f.download).toHaveBeenCalledTimes(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
      expect(f.objects.copy).toHaveBeenCalledTimes(1);
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
      await expect(f.run(f.row, videos, AbortSignal.timeout(5000))).rejects.toThrow('unavailable');
      expect(f.objects.putVideo).not.toHaveBeenCalled();
      f.probe.mockRejectedValueOnce(new Error('VIDEO_PROBE_FAILED'));
      await expect(f.run(f.row, videos, AbortSignal.timeout(5000))).rejects.toThrow(
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
      const pending = f.run(f.row, videos, stop.signal);
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
      const pending = f.run(f.row, videos, stop.signal);
      await started.promise;
      stop.abort(reason);
      reply.resolve();
      await expect(pending).rejects.toBe(reason);
      const original = vi.mocked(f.objects.copy).mock.calls[0]!;
      const restored = await f.start()(f.row, videos, AbortSignal.timeout(5000));
      expect(restored[0]?.key).toBe(original[1]);
      expect(f.objects.copy).toHaveBeenCalledTimes(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
      expect(f.probe).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it('keeps the probed ETag in an old receipt when staging changes before copy', async () => {
    const f = await fixture();
    try {
      const probe = f.probe.getMockImplementation()!;
      f.probe.mockImplementationOnce(async (command, signal) => {
        const metadata = await probe(command, signal);
        const source = f.saved.get(command.source.stagingKey)!;
        f.saved.set(command.source.stagingKey, { ...source, etag: 'replacement' });
        return metadata;
      });
      await expect(f.run(f.row, videos, AbortSignal.timeout(5000))).rejects.toMatchObject({
        statusCode: 412,
      });
      const receipt = JSON.parse(
        await readFile(join(f.directory, 'video', f.row.id, '0.json'), 'utf8'),
      );
      const command = f.probe.mock.calls[0]![0];
      expect(receipt.etag).toBe(command.source.etag);
      expect(receipt.rawEtag).toBeUndefined();
      await expect(f.start()(f.row, videos, AbortSignal.timeout(5000))).rejects.toMatchObject({
        statusCode: 412,
      });
      const target = `mio/raw/${receipt.assetId}/${receipt.attemptId}`;
      expect(vi.mocked(f.objects.copy).mock.calls.map((args) => args.slice(0, 4))).toEqual([
        [command.source.stagingKey, target, command.source.etag, 'private'],
        [command.source.stagingKey, target, command.source.etag, 'private'],
      ]);
      expect(f.saved.has(target)).toBe(false);
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
      await expect(f.run(f.row, videos, AbortSignal.timeout(5000))).rejects.toThrow(
        'VIDEO_OBJECT_MISMATCH',
      );
      await expect(f.start()(f.row, videos, AbortSignal.timeout(5000))).rejects.toThrow(
        'VIDEO_OBJECT_MISMATCH',
      );
      expect(f.objects.copy).toHaveBeenCalledTimes(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it('rejects an existing raw object with a different size, digest or MIME', async () => {
    const f = await fixture();
    try {
      const [output] = await f.run(f.row, videos, AbortSignal.timeout(5000));
      const raw = f.saved.get(output!.key)!;
      const changed = [
        { ...raw, bytes: Buffer.concat([raw.bytes, Buffer.from([0])]) },
        { ...raw, sha256: 'f'.repeat(64) },
        { ...raw, contentType: 'application/octet-stream' },
      ];
      for (const object of changed) {
        f.saved.set(output!.key, object);
        await expect(f.start()(f.row, videos, AbortSignal.timeout(5000))).rejects.toThrow(
          'VIDEO_OBJECT_MISMATCH',
        );
      }
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
    const outputs = await f.run(f.row, videos, AbortSignal.timeout(5000));
    const row = { ...f.row, checkpoint: { videos, materializationAttempts: 1 } };
    const clean = createVideoCleanup(f.objects, f.directory);
    await clean(row, AbortSignal.timeout(5000));
    expect([...f.saved.keys()]).toEqual([outputs[0]!.key]);
    await clean(row, AbortSignal.timeout(5000));
    expect(f.objects.delete).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});
