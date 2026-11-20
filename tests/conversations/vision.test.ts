import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { prepareImageFile } from '@deepseek-ai/dsh-attachment-local';
import type * as AttachmentLocal from '@deepseek-ai/dsh-attachment-local';
import { createConversationVision } from '../../src/dsh/vision.ts';
import type { VisionSource } from '../../src/assets/contracts.ts';

vi.mock('@deepseek-ai/dsh-attachment-local', async (original) => {
  const module = await original<typeof AttachmentLocal>();
  return { ...module, prepareImageFile: vi.fn(module.prepareImageFile) };
});

const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

it('prepares the admission reference and target byte budget from one private read', async () => {
  const assetId = randomUUID();
  const data = await sharp({
    create: { width: 13, height: 7, channels: 4, background: '#4488aa80' },
  })
    .png()
    .toBuffer();
  let etag = 'immutable';
  const read = vi.fn(
    async (
      _owner: string,
      _id: string,
      expected: { etagDigest: string; sourceDigest: string } | undefined,
    ) => {
      if (expected && expected.etagDigest !== digest(etag)) throw new Error('source changed');
      return {
        assetId,
        contentType: 'image/png' as const,
        data,
        etagDigest: digest(etag),
        sourceDigest: digest(data),
      };
    },
  );
  const vision = createConversationVision(read);
  const signal = new AbortController().signal;
  const budget = { maxPixels: 30, maxBytes: 1024 * 1024 };
  vi.mocked(prepareImageFile).mockClear();
  const admitted = await vision.prepareRequest('owner', assetId, budget, signal);
  expect(read).toHaveBeenCalledOnce();
  expect(prepareImageFile).toHaveBeenCalledTimes(2);
  expect(vision.assetId(admitted.reference)).toBe(assetId);
  const preview = await vision.preview(
    'owner',
    admitted.reference,
    vision.target(admitted.reference, budget),
    signal,
  );
  expect(preview.bytes).toBe(admitted.previewBytes);
  expect(read).toHaveBeenCalledTimes(2);
  etag = 'changed before sending';
  await expect(
    vision.preview('owner', admitted.reference, vision.target(admitted.reference, budget), signal),
  ).rejects.toThrow('source changed');
});

it('rechecks source identity and fits a non-integral transparent preview in memory', async () => {
  const assetId = randomUUID();
  const data = await sharp({
    create: { width: 13, height: 7, channels: 4, background: { r: 20, g: 60, b: 90, alpha: 0.4 } },
  })
    .png()
    .toBuffer();
  let etag = 'raw-etag';
  let bytes = data;
  const reads: string[] = [];
  const vision = createConversationVision(
    async (owner, id, expected, signal): Promise<VisionSource> => {
      signal.throwIfAborted();
      reads.push(owner);
      if (owner !== 'owner' || id !== assetId) throw new Error('not owned');
      const etagDigest = digest(etag);
      const sourceDigest = digest(bytes);
      if (
        expected &&
        (expected.etagDigest !== etagDigest || expected.sourceDigest !== sourceDigest)
      )
        throw new Error('source changed');
      return { assetId, contentType: 'image/png', data: bytes, etagDigest, sourceDigest };
    },
  );
  const signal = new AbortController().signal;
  const ref = await vision.prepare('owner', assetId, signal);
  expect(vision.assetId(ref)).toBe(assetId);
  const target = { width: 7, height: 3, maxBytes: 1024 * 1024 };
  const preview = await vision.preview('owner', ref, target, signal);
  const actual = await sharp(preview.data).metadata();
  expect(preview.width).toBeLessThanOrEqual(target.width);
  expect(preview.height).toBeLessThanOrEqual(target.height);
  expect(actual).toMatchObject({ width: preview.width, height: preview.height, hasAlpha: true });
  expect(preview).toMatchObject({
    bytes: preview.data.byteLength,
    hasAlpha: true,
    fingerprint: digest(preview.data),
    depth: 'uchar',
    space: 'srgb',
  });
  const repeated = await vision.preview('owner', ref, target, signal);
  expect(repeated.fingerprint).toBe(preview.fingerprint);
  expect(reads).toEqual(['owner', 'owner', 'owner']);
  etag = 'changed';
  await expect(vision.preview('owner', ref, target, signal)).rejects.toThrow('source changed');
  etag = 'raw-etag';
  bytes = Buffer.from('changed');
  await expect(vision.preview('owner', ref, target, signal)).rejects.toThrow('source changed');
  await expect(vision.prepare('other', assetId, signal)).rejects.toThrow('not owned');
});

it('rejects an overlong source dimension and a cancelled preparation', async () => {
  const assetId = randomUUID();
  const data = await sharp({
    create: { width: 8193, height: 1, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  const vision = createConversationVision(async () => ({
    assetId,
    contentType: 'image/png',
    data,
    etagDigest: digest('etag'),
    sourceDigest: digest(data),
  }));
  await expect(
    vision.prepare('owner', assetId, new AbortController().signal),
  ).rejects.toMatchObject({
    code: 'IMAGE_INPUT_INVALID',
  });
  const controller = new AbortController();
  controller.abort();
  await expect(vision.prepare('owner', assetId, controller.signal)).rejects.toThrow();
});

it('accepts the exact source pixel and side limits and rejects the next row', async () => {
  const assetId = randomUUID();
  const raster = async (height: number) =>
    sharp({ create: { width: 8192, height, channels: 3, background: '#336699' } })
      .png()
      .toBuffer();
  let data = await raster(2048);
  const vision = createConversationVision(async () => ({
    assetId,
    contentType: 'image/png',
    data,
    etagDigest: digest('etag'),
    sourceDigest: digest(data),
  }));
  const signal = new AbortController().signal;
  expect(await vision.prepare('owner', assetId, signal)).toMatchObject({
    width: 8192,
    height: 2048,
  });
  data = await raster(2049);
  await expect(vision.prepare('owner', assetId, signal)).rejects.toMatchObject({
    code: 'IMAGE_INPUT_INVALID',
  });
}, 30000);

it('uses normalized EXIF orientation and actual output dimensions for the preview target', async () => {
  const assetId = randomUUID();
  const data = await sharp({ create: { width: 13, height: 7, channels: 3, background: '#7799bb' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const vision = createConversationVision(async () => ({
    assetId,
    contentType: 'image/jpeg',
    data,
    etagDigest: digest('etag'),
    sourceDigest: digest(data),
  }));
  const signal = new AbortController().signal;
  const ref = await vision.prepare('owner', assetId, signal);
  expect(ref).toMatchObject({ width: 7, height: 13 });
  const target = { width: 3, height: 7, maxBytes: 1024 * 1024 };
  const preview = await vision.preview('owner', ref, target, signal);
  const metadata = await sharp(preview.data).metadata();
  expect(metadata).toMatchObject({ width: preview.width, height: preview.height });
  expect(preview.width).toBeLessThanOrEqual(target.width);
  expect(preview.height).toBeLessThanOrEqual(target.height);
  expect(preview.fingerprint).toBe(digest(preview.data));
});

it('reports normalization infrastructure failures as unavailable, not invalid user input', async () => {
  const assetId = randomUUID();
  const data = Buffer.from('fixture');
  const vision = createConversationVision(async () => ({
    assetId,
    contentType: 'image/png',
    data,
    etagDigest: digest('etag'),
    sourceDigest: digest(data),
  }));
  vi.mocked(prepareImageFile).mockRejectedValueOnce(new Error('private native failure'));
  await expect(
    vision.prepare('owner', assetId, new AbortController().signal),
  ).rejects.toMatchObject({
    status: 503,
    code: 'IMAGE_UNAVAILABLE',
  });
});

it('releases queued and active request/decode permits on abort', async () => {
  const assetId = randomUUID();
  const data = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } })
    .png()
    .toBuffer();
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  let calls = 0;
  let blocking = true;
  const vision = createConversationVision(async (_owner, _id, _expected, signal) => {
    calls++;
    if (calls === 2) entered.resolve();
    if (blocking)
      await Promise.race([
        held.promise,
        new Promise<never>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
      ]);
    return {
      assetId,
      contentType: 'image/png',
      data,
      etagDigest: digest('etag'),
      sourceDigest: digest(data),
    };
  });
  const first = new AbortController(),
    second = new AbortController(),
    queued = new AbortController();
  const a = vision.prepare('owner', assetId, first.signal);
  const b = vision.prepare('owner', assetId, second.signal);
  await entered.promise;
  await expect(
    vision.prepareRequest(
      'owner',
      assetId,
      { maxPixels: 4, maxBytes: 1024 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 503, code: 'IMAGE_UNAVAILABLE' });
  expect(calls).toBe(2);
  const c = vision.prepare('owner', assetId, queued.signal);
  const cancelledC = expect(c).rejects.toThrow();
  queued.abort();
  await cancelledC;
  const cancelledA = expect(a).rejects.toThrow();
  first.abort();
  await cancelledA;
  blocking = false;
  await expect(
    vision.prepare('owner', assetId, new AbortController().signal),
  ).resolves.toMatchObject({ width: 2 });
  held.resolve();
  await b;

  const releaseA = await vision.acquireRequest(new AbortController().signal);
  const releaseB = await vision.acquireRequest(new AbortController().signal);
  const waiter = new AbortController();
  const waiting = vision.acquireRequest(waiter.signal);
  const cancelled = expect(waiting).rejects.toThrow();
  waiter.abort();
  await cancelled;
  releaseA();
  const releaseC = await vision.acquireRequest(new AbortController().signal);
  releaseC();
  releaseB();
});
