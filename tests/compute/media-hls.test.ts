import { createHash, randomUUID } from 'node:crypto';
import { mediaObjectPrefix } from '@mio/compute-contracts';
import { describe, expect, it, vi } from 'vitest';
import { mediaHls, mediaHlsPath } from '../../src/compute/media/hls.ts';
import type { MediaHlsPackage } from '../../src/compute/media/hls.ts';

const header = '#EXTM3U\n#EXT-X-VERSION:3\n';
const masterText = (reference: string) =>
  header + '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=160x90\n' + reference + '\n';
const childText = (reference: string) =>
  header +
  '#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
  '#EXTINF:6.000000,\n' +
  reference +
  '\n#EXT-X-ENDLIST\n';

function setup(
  master = masterText('sub-ordinary.m3u8'),
  child = childText('sub-ordinary0.ts'),
  rendition: 'ordinary' | '720' = 'ordinary',
  count = 1,
) {
  const owner = 'fixture-owner';
  const jobId = randomUUID();
  const attemptId = randomUUID();
  const prefix = mediaObjectPrefix(jobId, attemptId);
  const contents = new Map<string, Buffer>();
  const file = (name: string, role: string, bytes: Buffer) => {
    const key = prefix + name;
    contents.set(key, bytes);
    return {
      asset_id: randomUUID(),
      name,
      role,
      content_type: role === 'hls' ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      object_key: key,
      size_bytes: String(bytes.length),
      etag: 'private-fixture',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  };
  const parent = file('master.m3u8', 'hls', Buffer.from(master));
  const variant = file(`sub-${rendition}.m3u8`, 'hls', Buffer.from(child));
  const segments = Array.from({ length: count }, (_, index) => {
    const name =
      rendition === 'ordinary'
        ? `sub-ordinary${index}.ts`
        : `seg-${rendition}-${String(index).padStart(3, '0')}.ts`;
    return file(name, 'segment', Buffer.from('local MPEG-TS fixture'));
  });
  const bundle: MediaHlsPackage = { attemptId, files: [parent, variant, ...segments] };
  const hlsPackage = vi.fn(async (id: string, user: string) =>
    id === jobId && user === owner ? bundle : undefined,
  );
  const readMedia = vi.fn(async (key: string) => contents.get(key)!);
  const clock = { now: 1_000 };
  const sign = vi.fn(
    (key: string, expiresIn: number) =>
      `https://private.example/${key}?signature=fixture&expires=${clock.now + expiresIn}`,
  );
  const readSigned = (uri: string) => {
    const link = new URL(uri);
    if (clock.now >= Number(link.searchParams.get('expires'))) return 403;
    return contents.has(link.pathname.slice(1)) ? 200 : 404;
  };
  const signal = new AbortController().signal;
  const get = (assetId?: string, user = owner, id = jobId) =>
    mediaHls({ hlsPackage }, { readMedia }, sign, user, id, assetId, signal);
  return {
    get,
    jobId,
    parent,
    variant,
    segment: segments[0]!,
    contents,
    readMedia,
    sign,
    clock,
    readSigned,
  };
}

describe('owner-bound HLS playlists', () => {
  it('returns a MIME-compatible master with an authenticated child, then signs only its registered TS file', async () => {
    const { get, jobId, variant, segment, readMedia, sign } = setup();
    expect(await get()).toContain(mediaHlsPath(jobId, variant.asset_id));
    expect(sign).not.toHaveBeenCalled();
    const result = await get(variant.asset_id);
    expect(result).toContain(`https://private.example/${segment.object_key}?signature=fixture`);
    expect(sign).toHaveBeenCalledExactlyOnceWith(segment.object_key, 300);
    expect(readMedia).toHaveBeenLastCalledWith(
      variant.object_key,
      variant.etag,
      Number(variant.size_bytes),
      expect.any(AbortSignal),
    );
  });

  it.each([
    ['720', 120],
    ['ordinary', 600],
  ] as const)(
    'keeps %s late segments readable at 1x and denies them after their own expiration',
    async (rendition, count) => {
      const names = Array.from({ length: count }, (_, index) =>
        rendition === 'ordinary'
          ? `sub-ordinary${index}.ts`
          : `seg-${rendition}-${String(index).padStart(3, '0')}.ts`,
      );
      const list = childText(names.join('\n#EXTINF:6.000000,\n'));
      const { get, variant, clock, readSigned, sign } = setup(
        masterText(`sub-${rendition}.m3u8`),
        list,
        rendition,
        count,
      );
      const issued = clock.now;
      const source = await get(variant.asset_id);
      const urls = source.split('\n').filter((line) => line.startsWith('https:'));
      expect(urls).toHaveLength(count);
      const playbackTime = 6 * (count - 1);
      const first = urls[0]!,
        last = urls.at(-1)!;
      clock.now = issued + playbackTime;
      expect(readSigned(first)).toBe(403);
      expect(readSigned(last)).toBe(200);
      clock.now = issued + playbackTime + 299;
      expect(readSigned(last)).toBe(200);
      clock.now++;
      expect(readSigned(last)).toBe(403);
      expect(sign.mock.calls.at(-1)?.[1]).toBe(playbackTime + 300);
    },
  );

  it('rejects wrong users, wrong jobs, foreign child IDs, and direct master-as-child before storage', async () => {
    const { get, parent, variant, readMedia, sign } = setup();
    for (const request of [
      () => get(undefined, 'another-user'),
      () => get(variant.asset_id, 'another-user'),
      () => get(variant.asset_id, 'fixture-owner', randomUUID()),
      () => get(randomUUID()),
      () => get(parent.asset_id),
    ])
      await expect(request()).rejects.toMatchObject({ status: 404, code: 'MEDIA_HLS_NOT_FOUND' });
    expect(readMedia).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it.each([
    'master.m3u8',
    'https://outside.example/sub-ordinary.m3u8',
    '../sub-ordinary.m3u8',
    'sub-ordinary.m3u8?token=private',
  ])('rejects a non-package master URI %s', async (reference) => {
    const { get, sign } = setup(masterText(reference));
    await expect(get()).rejects.toMatchObject({ status: 409, code: 'MEDIA_HLS_INVALID' });
    expect(sign).not.toHaveBeenCalled();
  });

  it.each([
    'master.m3u8',
    'sub-ordinary.m3u8',
    '../sub-ordinary0.ts',
    '#EXT-X-KEY:METHOD=AES-128,URI="key"',
    'sub-ordinary0.ts\n#EXTINF:6,\nsub-ordinary0.ts',
  ])('rejects a non-package child reference %s without signing any segment', async (reference) => {
    const { get, variant, sign } = setup(undefined, childText(reference));
    await expect(get(variant.asset_id)).rejects.toMatchObject({
      status: 409,
      code: 'MEDIA_HLS_INVALID',
    });
    expect(sign).not.toHaveBeenCalled();
  });

  it('rejects mismatched content or a segment backed by an object from a different job', async () => {
    const first = setup();
    first.contents.set(first.variant.object_key, Buffer.from(childText('sub-ordinary1.ts')));
    await expect(first.get(first.variant.asset_id)).rejects.toMatchObject({
      code: 'MEDIA_HLS_INVALID',
    });
    const second = setup();
    second.segment.object_key = mediaObjectPrefix(randomUUID(), randomUUID()) + 'sub-ordinary0.ts';
    await expect(second.get(second.variant.asset_id)).rejects.toMatchObject({
      code: 'MEDIA_HLS_INVALID',
    });
    expect(first.sign).not.toHaveBeenCalled();
    expect(second.sign).not.toHaveBeenCalled();
  });
});
