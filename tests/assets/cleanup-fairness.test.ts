import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { AssetStore } from '../../src/assets/store.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { createAssetService } from '../../src/assets/service.ts';
import { authDatabase } from '../support/auth-database.ts';

it('advances beyond a full page of failed cleanup entries and revisits them after the scan wraps', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  const ids = Array.from({ length: 101 }, () => randomUUID()).sort();
  await pool.query(
    `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,state,expires_at)
     SELECT id,'owner','image','image/png',1,'mio/staging/'||id,'pending',
       statement_timestamp()-interval '1 day' FROM unnest($1::uuid[]) id`,
    [ids],
  );
  const store = new AssetStore(pool);
  const selected = vi.spyOn(store, 'expiredStaging');
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const attempts: string[] = [];
  const deleted: string[] = [];
  let failing = true;
  const service = createAssetService(store, {
    uploadUrl: () => '',
    downloadUrl: () => '',
    copy: async () => {},
    head: async () => ({ size: 1, etag: 'unused' }),
    async delete(key) {
      attempts.push(key);
      if (failing && key !== `mio/staging/${ids[100]}`) throw new Error('persistent failure');
      deleted.push(key);
    },
  });
  const firstPass = service.cleanup();
  try {
    await firstPass;
    expect(attempts).toHaveLength(100);
    const tick = intervals.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
    if (typeof tick !== 'function') throw new Error('cleanup interval missing');
    tick();
    await service.cleanup();
    expect(deleted).toEqual([`mio/staging/${ids[100]}`]);
    tick();
    await service.cleanup();
    expect(selected).toHaveBeenCalledTimes(3);
    await selected.mock.results[2]!.value;
    failing = false;
    tick();
    await service.cleanup();
    expect(deleted).toHaveLength(101);
    expect(
      (await pool.query('SELECT id FROM mio_assets WHERE staging_deleted_at IS NULL')).rowCount,
    ).toBe(0);
  } finally {
    intervals.mockRestore();
    await service.close();
    await database.close();
  }
});

it('keeps active finalization leases and ready raw objects out of staging cleanup', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  const store = new AssetStore(pool);
  const leased = randomUUID(),
    ready = randomUUID();
  try {
    await pool.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at,lease_until)
       VALUES($1,'owner','image','image/png',1,$3,NULL,'finalizing',now()-interval '1 day',now()+interval '1 hour'),
             ($2,'owner','image','image/png',1,$4,$5,'ready',now()-interval '1 day',NULL)`,
      [
        leased,
        ready,
        `mio/staging/${leased}`,
        `mio/staging/${ready}`,
        `mio/raw/${ready}/${randomUUID()}`,
      ],
    );
    const rows = await store.expiredStaging();
    expect(rows.map((row) => row.id)).toEqual([ready]);
    expect(rows[0]?.staging_key).toBe(`mio/staging/${ready}`);
    const current = (await pool.query('SELECT id,state,raw_key FROM mio_assets ORDER BY id')).rows;
    expect(current.find((row) => row.id === leased)?.state).toBe('finalizing');
    expect(current.find((row) => row.id === ready)).toMatchObject({
      state: 'ready',
      raw_key: expect.stringContaining(`mio/raw/${ready}/`),
    });
  } finally {
    await store.close();
    await database.close();
  }
});
