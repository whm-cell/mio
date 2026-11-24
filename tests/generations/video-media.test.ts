import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { VideoProbe } from '../../src/generations/video-media.ts';
import { createVideoMaterializer, createVideoCleanup } from '../../src/generations/video-media.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import type { VideoExecution } from '../../src/generations/video-execution.ts';
import type { withPublicHttps } from '../../src/integrations/onelink/public-https.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mio-video-media-'));
  const bytes = Buffer.from('fixture MP4 bytes checked by the worker probe');
  const saved = new Map<string, { bytes: Buffer; sha256: string; etag: string }>();
  const objects: AssetObjectStore = {
    uploadUrl: () => '',
    downloadUrl: () => '',
    copy: async () => {},
    delete: vi.fn(async (key: string) => {
      saved.delete(key);
    }),
    head: vi.fn(async (key) => {
      const value = saved.get(key);
      if (!value) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return { size: value.bytes.length, sha256: value.sha256, etag: value.etag };
    }),
    putVideo: vi.fn(async (key, stream, sizeBytes, sha256) => {
      if (saved.has(key)) throw new Error('overwrite');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const actual = Buffer.concat(chunks);
      expect(actual.length).toBe(sizeBytes);
      expect(createHash('sha256').update(actual).digest('hex')).toBe(sha256);
      const etag = 'etag-' + saved.size;
      saved.set(key, { bytes: actual, sha256, etag });
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
  const run = createVideoMaterializer(objects, directory, probe, download);
  return {
    directory,
    objects,
    saved,
    download,
    probe,
    row,
    run,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

describe('durable video materialization', () => {
  it('streams private staging, probes its exact identity, and publishes a reusable raw asset without repeating work', async () => {
    const f = await fixture();
    try {
      const videos = [{ url: 'https://video.fixture/result.mp4' }];
      const output = await f.run(f.row, videos, AbortSignal.timeout(5000));
      expect(output[0]).toMatchObject({
        width: 640,
        height: 360,
        durationMs: 4000,
        contentType: 'video/mp4',
      });
      expect(output[0]!.key).toMatch(new RegExp('^mio/raw/' + output[0]!.assetId + '/'));
      const command = f.probe.mock.calls[0]?.[0] as unknown as { source: { stagingKey: string } };
      expect(command.source.stagingKey).toContain('mio/staging/video/' + f.row.id + '/0/');
      expect(await f.run(f.row, videos, AbortSignal.timeout(5000))).toEqual(output);
      expect(f.download).toHaveBeenCalledTimes(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(2);
      expect(f.probe).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
  it('reconciles a completed upload after its acknowledgement is lost', async () => {
    const f = await fixture();
    try {
      const put = f.objects.putVideo!;
      let lost = false;
      f.objects.putVideo = vi.fn(async (key, stream, size, sha, signal) => {
        const value = await put(key, stream, size, sha, signal);
        if (!lost) {
          lost = true;
          throw new Error('lost acknowledgement');
        }
        return value;
      });
      const videos = [{ url: 'https://video.fixture/result.mp4' }];
      await expect(f.run(f.row, videos, AbortSignal.timeout(5000))).rejects.toThrow(
        'lost acknowledgement',
      );
      expect((await f.run(f.row, videos, AbortSignal.timeout(5000))).length).toBe(1);
      expect(f.download).toHaveBeenCalledTimes(1);
      expect(f.objects.putVideo).toHaveBeenCalledTimes(2);
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
      const videos = [{ url: 'https://video.fixture/result.mp4' }];
      await expect(f.run(f.row, videos, AbortSignal.timeout(5000))).rejects.toThrow('unavailable');
      expect(f.objects.putVideo).not.toHaveBeenCalled();
      f.probe.mockRejectedValueOnce(new Error('VIDEO_PROBE_FAILED'));
      await expect(f.run(f.row, videos, AbortSignal.timeout(5000))).rejects.toThrow(
        'VIDEO_PROBE_FAILED',
      );
      expect([...f.saved.keys()].every((key) => key.startsWith('mio/staging/'))).toBe(true);
    } finally {
      await f.close();
    }
  });
});

it('cleans committed staging and recovery files only after reconciling the reusable raw object', async () => {
  const f = await fixture();
  try {
    const videos = [{ url: 'https://video.fixture/result.mp4' }];
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
