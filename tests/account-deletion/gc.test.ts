import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { AccountDomainStore } from '../../src/account-deletion/domain-store.ts';
import { createAssetGc } from '../../src/assets/gc.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import {
  collectDeletedAccountAssets,
  releaseDeletedAccountHolds,
} from '../../src/assets/account-deletion.ts';
import { AssetStore } from '../../src/assets/store.ts';
import { createAssetService } from '../../src/assets/service.ts';

async function fixture() {
  const database = await authDatabase(),
    pool = new Pool({ connectionString: database.url, max: 2 });
  await pool.query(assetSchemaSQL);
  const store = new AccountDomainStore(pool),
    keys = new Set<string>();
  let blocked = false;
  const objects: AssetObjectStore = {
    uploadUrl: () => '',
    downloadUrl: () => '',
    copy: async () => {},
    hasPendingWrites: () => blocked,
    head: async (key) => {
      if (!keys.has(key)) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return { etag: 'e', size: 1 };
    },
    delete: vi.fn(async (key) => {
      keys.delete(key);
    }),
  };
  return {
    database,
    pool,
    store,
    keys,
    objects,
    setBlocked: (value: boolean) => {
      blocked = value;
    },
    async close() {
      await store.close();
      await database.close();
    },
  };
}

it('retains a live independent owner, deletes only closed zero-ref exact keys, and reclaims a late re-upload without publishing', async () => {
  const f = await fixture();
  try {
    const old = 'closed',
      other = 'new',
      id = randomUUID(),
      raw = `mio/raw/${id}/${randomUUID()}`;
    f.keys.add(raw);
    await f.pool.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at,staging_deleted_at)
      VALUES($1,$2,'private','image/png',1,$3,$3,'ready',now(),now())`,
      [id, other, raw],
    );
    await f.store.closeAccount(old, new Date());
    const gc = createAssetGc(f.store, f.objects, true);
    await gc.enqueue(old, [raw]);
    expect((await gc.collect(old, AbortSignal.timeout(5000))).done).toBe(true);
    expect(f.keys.has(raw)).toBe(true);
    expect(
      (await f.pool.query('SELECT retained_refs FROM mio_asset_gc_requests')).rows[0].retained_refs,
    ).toBeGreaterThan(0);
    await f.store.closeAccount(other, new Date());
    await releaseDeletedAccountHolds(f.store, other);
    await gc.enqueue(other, [raw]);
    f.setBlocked(true);
    expect((await gc.collect(other, AbortSignal.timeout(5000))).done).toBe(false);
    expect(f.keys.has(raw)).toBe(true);
    f.setBlocked(false);
    await f.pool.query('UPDATE mio_asset_gc_objects SET next_attempt_at=now()');
    expect((await gc.collect(other, AbortSignal.timeout(5000))).done).toBe(true);
    expect(f.keys.has(raw)).toBe(false);
    f.keys.add(raw);
    await gc.enqueue(other, [raw]);
    expect((await gc.collect(other, AbortSignal.timeout(5000))).done).toBe(true);
    expect(f.keys.has(raw)).toBe(false);
    await expect(
      f.pool.query(
        `INSERT INTO mio_asset_holders(owner_id,asset_id,holder_type,holder_id)
      VALUES($1,$2,'avatar','late')`,
        [other, id],
      ),
    ).rejects.toThrow('ACCOUNT_DELETED');
  } finally {
    await f.close();
  }
});

it('keeps failed delete locators, rejects stale leases, and requires enabled shared GC and actual physical absence', async () => {
  const f = await fixture();
  try {
    await f.store.closeAccount('old', new Date());
    const raw = `mio/raw/${randomUUID()}/${randomUUID()}`;
    f.keys.add(raw);
    const dry = createAssetGc(f.store, f.objects, false);
    await dry.enqueue('old', [raw]);
    await expect(dry.collect('old', AbortSignal.timeout(5000))).rejects.toThrow(
      'ASSET_GC_NOT_READY',
    );
    const objects = {
      ...f.objects,
      delete: vi.fn(async () => {
        throw new Error('private-key-do-not-log');
      }),
    };
    const gc = createAssetGc(f.store, objects, true);
    await expect(gc.collect('old', AbortSignal.timeout(5000))).rejects.toThrow();
    const row = (await f.pool.query('SELECT * FROM mio_asset_gc_objects')).rows[0];
    expect(row.object_key).toBe(raw);
    expect(row.error_code).toBe('ASSET_GC_DELETE_FAILED');
    expect(row.state).toBe('pending');
    expect(row.deleted_at).toBeNull();
    await f.pool.query('UPDATE mio_asset_gc_objects SET next_attempt_at=now()');
    const blocked = { ...f.objects, delete: async () => {} };
    await expect(
      createAssetGc(f.store, blocked, true).collect('old', AbortSignal.timeout(5000)),
    ).rejects.toThrow('ASSET_GC_DELETE_UNCONFIRMED');
  } finally {
    await f.close();
  }
});

it('accelerates staging through the existing cleaner and revisits writes from an unexpired five-minute PUT', async () => {
  const f = await fixture();
  let service: ReturnType<typeof createAssetService> | undefined;
  try {
    const id = randomUUID(),
      staging = 'mio/staging/' + id,
      owner = 'old';
    const assets = new AssetStore(new Pool({ connectionString: f.database.url }));
    await assets.create(id, owner, 'upload.png', 'image/png', 1);
    f.keys.add(staging);
    const videoKey = `mio/staging/video/${randomUUID()}/0/${randomUUID()}.media`,
      videoAsset = randomUUID();
    await f.pool.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,state,expires_at)
      VALUES($1,$2,'deleted-upload','application/octet-stream',1,$3,'expired',now()-interval '1 day')`,
      [videoAsset, owner, videoKey],
    );
    f.keys.add(videoKey);
    const finalizedAt = new Date();
    await f.store.closeAccount(owner, finalizedAt);
    service = createAssetService(assets, f.objects);
    const gc = createAssetGc(f.store, f.objects, true);
    expect(
      (
        await collectDeletedAccountAssets(
          f.store,
          gc,
          owner,
          finalizedAt,
          AbortSignal.timeout(5000),
          () => service!.cleanup(),
          async () => {},
        )
      ).done,
    ).toBe(false);
    await service.cleanup();
    expect(f.keys.has(staging)).toBe(false);
    expect(f.keys.has(videoKey)).toBe(false);
    f.keys.add(staging);
    f.keys.add(videoKey);
    const past = new Date(Date.now() - 301000);
    await f.pool.query('UPDATE mio_assets SET staging_deleted_at=$2 WHERE owner_id=$1', [
      owner,
      new Date(past.getTime() + 1000),
    ]);
    await collectDeletedAccountAssets(
      f.store,
      gc,
      owner,
      past,
      AbortSignal.timeout(5000),
      () => service!.cleanup(),
      async () => {},
    );
    await collectDeletedAccountAssets(
      f.store,
      gc,
      owner,
      past,
      AbortSignal.timeout(5000),
      () => service!.cleanup(),
      async () => {},
    );
    expect(f.keys.has(staging)).toBe(false);
    expect(f.keys.has(videoKey)).toBe(false);
    expect(
      (
        await f.pool.query('SELECT staging_deleted_at FROM mio_assets WHERE id=$1', [id])
      ).rows[0].staging_deleted_at.getTime(),
    ).toBeGreaterThan(past.getTime() + 300000);
  } finally {
    await service?.close();
    await f.close();
  }
});
