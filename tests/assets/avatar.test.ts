import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { sha256Bytes } from '@mio/foundation/hash';
import { AssetError } from '../../src/assets/contracts.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import { assetSchemaSQL, checkAssetSchema } from '../../src/assets/schema.ts';
import { AssetStore } from '../../src/assets/store.ts';
import { createAssetService } from '../../src/assets/service.ts';
import { authDatabase } from '../support/auth-database.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let service: ReturnType<typeof createAssetService>;
let store: AssetStore;
let objects: AssetObjectStore;
const owner = { userId: 'avatar-owner', sessionId: 'session' };
const cloud = new Map<
  string,
  { bytes: Buffer; contentType: string; etag: string; sha256: string }
>();
const missing = () => Object.assign(new Error('missing'), { statusCode: 404 });
const remember = (key: string, bytes: Buffer, contentType: string) => {
  const value = { bytes, contentType, etag: `"${sha256Bytes(bytes)}"`, sha256: sha256Bytes(bytes) };
  cloud.set(key, value);
  return value;
};
async function source(bytes: Buffer, contentType = 'image/gif', size = bytes.length) {
  const id = randomUUID(),
    key = `mio/raw/${id}/${randomUUID()}`;
  remember(key, bytes, contentType);
  await pool.query(
    `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,source_etag,expires_at,staging_deleted_at)
    VALUES($1,$2,'input.gif',$3,$4,$5,$5,'ready','original',now(),now())`,
    [id, owner.userId, contentType, size, key],
  );
  return { id, key };
}
async function animation() {
  const pixels = Buffer.alloc(2 * 4 * 3);
  for (let i = 0; i < 8; i++) pixels[i * 3 + (i < 4 ? 0 : 2)] = 255;
  const gif = await sharp(pixels, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } })
    .gif({ delay: [100, 100], loop: 0 })
    .toBuffer();
  expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(2);
  return gif;
}
function padGif(gif: Buffer, target: number) {
  const parts = [gif.subarray(0, -1)];
  let remaining = target - gif.length;
  while (remaining) {
    let count = Math.min(255, remaining - 4);
    if (remaining - count - 4 > 0 && remaining - count - 4 < 4) count -= 4;
    parts.push(
      Buffer.concat([Buffer.from([0x21, 0xfe, count]), Buffer.alloc(count, 65), Buffer.from([0])]),
    );
    remaining -= count + 4;
  }
  return Buffer.concat([...parts, gif.subarray(-1)]);
}

beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
});
beforeEach(async () => {
  await pool.query('TRUNCATE mio_assets CASCADE');
  cloud.clear();
  objects = {
    uploadUrl: () => {
      throw new Error('unused');
    },
    downloadUrl: () => {
      throw new Error('download signer unavailable');
    },
    avatarInlineUrl: (key, contentType) => `https://private.invalid/${key}?type=${contentType}`,
    head: vi.fn(async (key) => {
      const value = cloud.get(key);
      if (!value) throw missing();
      return { size: value.bytes.length, ...value };
    }),
    readImage: vi.fn(async (key, etag, _size, signal) => {
      signal.throwIfAborted();
      const value = cloud.get(key);
      if (!value || value.etag !== etag)
        throw Object.assign(new Error('changed'), { statusCode: 412 });
      return value.bytes;
    }),
    putImage: vi.fn(async (key, bytes, format, digest, signal) => {
      signal.throwIfAborted();
      if (cloud.has(key)) throw Object.assign(new Error('immutable'), { statusCode: 409 });
      expect(format).toBe('webp');
      expect(sha256Bytes(bytes)).toBe(digest);
      const value = remember(key, Buffer.from(bytes), 'image/webp');
      return { key, sizeBytes: bytes.byteLength, ...value };
    }),
    copy: async () => {
      throw new Error('unused');
    },
    delete: async () => {},
  };
  store = new AssetStore(new Pool({ connectionString: database.url }));
  service = createAssetService(store, objects);
});
afterEach(async () => {
  await service.close();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await pool?.end();
  await database?.close();
});

it('verifies owner, state, actual size and static type independently of download signing', async () => {
  const input = await source(
    await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
      .png()
      .toBuffer(),
    'image/png',
  );
  expect(await service.verifyAvatar(owner, input.id)).toBe('ok');
  expect(await service.avatarUrl(owner, input.id)).toContain(input.key);
  expect(await service.verifyAvatar({ ...owner, userId: 'other' }, input.id)).toBe('not_found');
  expect(await service.avatarUrl({ ...owner, userId: 'other' }, input.id)).toBeNull();
  await pool.query("UPDATE mio_assets SET state='pending' WHERE id=$1", [input.id]);
  expect(await service.verifyAvatar(owner, input.id)).toBe('not_ready');
  await pool.query("UPDATE mio_assets SET state='ready',size_bytes=size_bytes+1 WHERE id=$1", [
    input.id,
  ]);
  expect(await service.verifyAvatar(owner, input.id)).toBe('not_ready');
  await pool.query('UPDATE mio_assets SET size_bytes=size_bytes-1 WHERE id=$1', [input.id]);
  cloud.get(input.key)!.contentType = 'image/svg+xml';
  expect(await service.verifyAvatar(owner, input.id)).toBe('invalid_type');
  cloud.get(input.key)!.contentType = 'image/png';
  objects.avatarInlineUrl = () => {
    throw new Error('signing down');
  };
  expect(await service.verifyAvatar(owner, input.id)).toBe('ok');
  expect(await service.avatarUrl(owner, input.id)).toBeNull();
  vi.mocked(objects.head).mockRejectedValue(new Error('storage down'));
  expect(await service.verifyAvatar(owner, input.id)).toBe('unavailable');
  expect(await service.avatarUrl(owner, input.id)).toBeNull();
});

it('normalizes only the first frame, publishes a private-ready WebP and reuses it after restart', async () => {
  const input = await source(await animation());
  const result = await service.normalizeAvatar(owner, input.id);
  const row = await store.owned(result.avatarAssetId, owner.userId);
  expect(row).toMatchObject({
    state: 'ready',
    content_type: 'image/webp',
    filename: `avatar-${input.id}.webp`,
  });
  const output = cloud.get(row.raw_key!)!.bytes;
  const meta = await sharp(output).metadata();
  expect(meta).toMatchObject({ format: 'webp', width: 2, height: 2 });
  expect(meta.pages ?? 1).toBe(1);
  const { data } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  expect(data[0]).toBeGreaterThan(200);
  expect(data[2]).toBeLessThan(60);
  expect(await service.verifyAvatar(owner, result.avatarAssetId)).toBe('ok');
  expect(await service.normalizeAvatar(owner, input.id)).toEqual(result);
  await service.close();
  store = new AssetStore(new Pool({ connectionString: database.url }));
  service = createAssetService(store, objects);
  expect(await service.normalizeAvatar(owner, input.id)).toEqual(result);
  expect(objects.putImage).toHaveBeenCalledTimes(1);
  const stored = (await pool.query('SELECT * FROM mio_assets WHERE id=$1', [result.avatarAssetId]))
    .rows[0];
  expect(stored.staging_key).toBe(stored.raw_key);
  expect(stored.staging_deleted_at).not.toBeNull();
  expect(JSON.stringify(stored)).not.toContain('https:');
  await checkAssetSchema(pool);
  await pool.query(assetSchemaSQL);
  expect((await pool.query('SELECT count(*) FROM mio_assets')).rows[0].count).toBe('2');
});

it('accepts an exactly 20 MiB valid animation, rejects above the byte cap before reading', async () => {
  const gif = padGif(await animation(), 20 * 1024 * 1024);
  expect(gif.length).toBe(20 * 1024 * 1024);
  const input = await source(gif);
  await expect(service.normalizeAvatar(owner, input.id)).resolves.toHaveProperty('avatarAssetId');
  const large = await source(gif, 'image/gif', gif.length + 1);
  vi.mocked(objects.readImage!).mockClear();
  await expect(service.normalizeAvatar(owner, large.id)).rejects.toMatchObject({ status: 400 });
  expect(objects.readImage).not.toHaveBeenCalled();
});

it('rejects foreign, missing, pending, forged format, bad dimensions, pixels and decode failures', async () => {
  const valid = await source(await animation());
  await expect(
    service.normalizeAvatar({ ...owner, userId: 'other' }, valid.id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(service.normalizeAvatar(owner, randomUUID())).rejects.toMatchObject({ status: 404 });
  await pool.query("UPDATE mio_assets SET state='pending' WHERE id=$1", [valid.id]);
  await expect(service.normalizeAvatar(owner, valid.id)).rejects.toMatchObject({ status: 409 });
  const wrongType = await source(await animation(), 'image/png');
  await expect(service.normalizeAvatar(owner, wrongType.id)).rejects.toMatchObject({ status: 400 });
  const png = await source(
    await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
      .png()
      .toBuffer(),
  );
  await expect(service.normalizeAvatar(owner, png.id)).rejects.toMatchObject({ status: 400 });
  for (const [width, height] of [
    [8193, 1],
    [1, 8193],
    [4001, 4000],
    [0, 1],
  ]) {
    const gif = await animation();
    gif.writeUInt16LE(width!, 6);
    gif.writeUInt16LE(height!, 8);
    const invalid = await source(gif);
    await expect(service.normalizeAvatar(owner, invalid.id)).rejects.toMatchObject({ status: 400 });
  }
  const truncated = await source((await animation()).subarray(0, 14));
  await expect(service.normalizeAvatar(owner, truncated.id)).rejects.toMatchObject({ status: 400 });
  expect(objects.putImage).not.toHaveBeenCalled();
});

it('checks ETag, actual byte length and storage errors without publishing a derived asset', async () => {
  const input = await source(await animation());
  const original = cloud.get(input.key)!;
  const head = vi.mocked(objects.head);
  head.mockResolvedValueOnce({
    size: original.bytes.length + 1,
    etag: original.etag,
    contentType: 'image/gif',
  });
  await expect(service.normalizeAvatar(owner, input.id)).rejects.toMatchObject({ status: 409 });
  vi.mocked(objects.readImage!).mockRejectedValueOnce(
    Object.assign(new Error('changed'), { statusCode: 412 }),
  );
  await expect(service.normalizeAvatar(owner, input.id)).rejects.toMatchObject({
    status: 409,
    code: 'ASSET_SOURCE_CHANGED',
  });
  vi.mocked(objects.readImage!).mockResolvedValueOnce(original.bytes.subarray(0, -1));
  await expect(service.normalizeAvatar(owner, input.id)).rejects.toMatchObject({
    status: 409,
    code: 'ASSET_SIZE_MISMATCH',
  });
  head.mockRejectedValueOnce(new Error('head down'));
  await expect(service.normalizeAvatar(owner, input.id)).rejects.toMatchObject({ status: 503 });
  expect((await pool.query('SELECT count(*) FROM mio_assets')).rows[0].count).toBe('1');
});

it('fast-fails concurrent decoding without queuing, while ordinary reads remain responsive', async () => {
  const input = await source(await animation());
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const read = objects.readImage!;
  vi.mocked(objects.readImage!).mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return read(...args);
  });
  const working = service.normalizeAvatar(owner, input.id);
  await entered.promise;
  try {
    await expect(service.normalizeAvatar(owner, input.id)).rejects.toMatchObject({
      status: 503,
      code: 'ASSET_BUSY',
    });
    expect(await service.verifyAvatar(owner, input.id)).toBe('invalid_type');
    expect(await service.avatarUrl(owner, input.id)).toBeNull();
  } finally {
    release.resolve();
  }
  const result = await working;
  expect(await service.normalizeAvatar(owner, input.id)).toEqual(result);
});

it('recovers ambiguous PUT and a database publication failure without another object or asset identity', async () => {
  const input = await source(await animation());
  const put = vi.mocked(objects.putImage!).getMockImplementation()!;
  vi.mocked(objects.putImage!).mockImplementationOnce(async (...args) => {
    await put(...args);
    throw new Error('ack lost');
  });
  const publish = vi
    .spyOn(store, 'publishAvatar')
    .mockRejectedValueOnce(new Error('database down'));
  await expect(service.normalizeAvatar(owner, input.id)).rejects.toMatchObject({ status: 503 });
  expect(cloud.size).toBe(2);
  publish.mockRestore();
  await service.close();
  store = new AssetStore(new Pool({ connectionString: database.url }));
  service = createAssetService(store, objects);
  const result = await service.normalizeAvatar(owner, input.id);
  expect(await service.normalizeAvatar(owner, input.id)).toEqual(result);
  expect(objects.putImage).toHaveBeenCalledTimes(1);
  expect((await pool.query('SELECT count(*) FROM mio_assets')).rows[0].count).toBe('2');
});

it('does not publish if the owned source changes while the first frame is being read', async () => {
  const input = await source(await animation());
  const read = objects.readImage!;
  vi.mocked(objects.readImage!).mockImplementationOnce(async (...args) => {
    await pool.query("UPDATE mio_assets SET state='expired' WHERE id=$1", [input.id]);
    return read(...args);
  });
  await expect(service.normalizeAvatar(owner, input.id)).rejects.toBeInstanceOf(AssetError);
  expect((await pool.query('SELECT count(*) FROM mio_assets')).rows[0].count).toBe('1');
});

it('reconciles an immutable PUT race and rejects a conflicting recovered object', async () => {
  const input = await source(await animation());
  const put = vi.mocked(objects.putImage!).getMockImplementation()!;
  vi.mocked(objects.putImage!).mockImplementationOnce(async (...args) => {
    await put(...args);
    throw Object.assign(new Error('competing writer won'), { statusCode: 409 });
  });
  const normalized = await service.normalizeAvatar(owner, input.id);
  expect(await service.normalizeAvatar(owner, input.id)).toEqual(normalized);
  expect(objects.putImage).toHaveBeenCalledTimes(1);
  expect((await pool.query('SELECT count(*) FROM mio_assets')).rows[0].count).toBe('2');
  const next = await source(await animation());
  vi.mocked(objects.putImage!).mockImplementationOnce(async (...args) => {
    const output = await put(...args);
    cloud.get(output.key)!.sha256 = '0'.repeat(64);
    throw Object.assign(new Error('conflicting writer'), { statusCode: 409 });
  });
  await expect(service.normalizeAvatar(owner, next.id)).rejects.toMatchObject({
    status: 409,
    code: 'ASSET_SOURCE_CHANGED',
  });
  expect((await pool.query('SELECT count(*) FROM mio_assets')).rows[0].count).toBe('3');
});

it('returns null/unavailable on stopped avatar reads and rejects additional normalization', async () => {
  const input = await source(await animation());
  await service.close();
  expect(await service.avatarUrl(owner, input.id)).toBeNull();
  expect(await service.verifyAvatar(owner, input.id)).toBe('unavailable');
  expect(() => service.normalizeAvatar(owner, input.id)).toThrow('ASSET_UNAVAILABLE');
});
