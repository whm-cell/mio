import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { expect, it, onTestFinished } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { checkStorageSchema, storageSchemaSQL } from '../../src/assets/storage-schema.ts';
import { createStorageAccounting, StorageAccounting } from '../../src/assets/storage-store.ts';
import { defaultStoragePolicy } from '../../src/assets/storage.ts';

async function fixture() {
  const db = await authDatabase();
  const pool = new Pool({ connectionString: db.url });
  onTestFinished(async () => {
    await pool.end();
    await db.close();
  });
  return { db, pool };
}
it('previews without writes, applies incrementally twice, backfills existing ready originals/derived/materials and never resurrects released ownership', async () => {
  const { db, pool } = await fixture();
  await pool.query(assetSchemaSQL.slice(0, assetSchemaSQL.indexOf(storageSchemaSQL)));
  await pool.query("ALTER TABLE mio_assets ADD COLUMN asset_kind text NOT NULL DEFAULT 'original'");
  await pool.query('CREATE TABLE mio_media_files(asset_id uuid PRIMARY KEY,role text NOT NULL)');
  await pool.query(
    'CREATE TABLE mio_materials(id uuid PRIMARY KEY,owner_id text NOT NULL,source_asset_id uuid,state text NOT NULL)',
  );
  const original = randomUUID(),
    derived = randomUUID(),
    preview = randomUUID(),
    hls = randomUUID(),
    pending = randomUUID(),
    remote = randomUUID();
  for (const [id, size, kind, state, key] of [
    [original, 100, 'original', 'ready', `mio/raw/${original}/original`],
    [derived, 20, 'derived', 'ready', `mio/derived/${derived}/final.png`],
    [preview, 30, 'derived', 'ready', `mio/media/${preview}/preview.mp4`],
    [hls, 40, 'derived', 'ready', `mio/media/${hls}/segment.ts`],
    [pending, 50, 'original', 'pending', null],
    [remote, 60, 'derived', 'ready', 'https://supplier.invalid/x'],
  ])
    await pool.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at,asset_kind)
    VALUES($1,'legacy','x','image/png',$2,$3,$4,$5,now()+interval '1 day',$6)`,
      [id, size, `mio/staging/${id}`, key, state, kind],
    );
  await pool.query("INSERT INTO mio_media_files VALUES($1,'preview'),($2,'segment')", [
    preview,
    hls,
  ]);
  const material = randomUUID();
  await pool.query("INSERT INTO mio_materials VALUES($1,'legacy',$2,'active')", [
    material,
    original,
  ]);
  const before = (
    await pool.query('SELECT id,raw_key,size_bytes,state,asset_kind FROM mio_assets ORDER BY id')
  ).rows;
  const run = (apply: boolean) =>
    spawnSync(
      process.execPath,
      ['scripts/service/migrate-storage.ts', ...(apply ? ['--apply'] : [])],
      {
        env: { PATH: process.env.PATH, MIO_ASSETS_DATABASE_URL: db.url },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
  const previewRun = run(false);
  expect(previewRun.status, previewRun.stderr).toBe(0);
  expect(previewRun.stdout).toContain('mio_storage_objects');
  expect(
    (await pool.query("SELECT to_regclass('mio_storage_usage') AS name")).rows[0].name,
  ).toBeNull();
  await expect(createStorageAccounting(db.url, () => defaultStoragePolicy)).rejects.toThrow();
  expect(
    (await pool.query("SELECT to_regclass('mio_storage_usage') AS name")).rows[0].name,
  ).toBeNull();
  for (let n = 0; n < 2; n++) {
    const result = run(true);
    expect(result.status, result.stderr).toBe(0);
  }
  await checkStorageSchema(pool);
  expect(
    (await pool.query('SELECT id,raw_key,size_bytes,state,asset_kind FROM mio_assets ORDER BY id'))
      .rows,
  ).toEqual(before);
  const storage = new StorageAccounting(pool, () => defaultStoragePolicy);
  expect(await storage.usage('legacy')).toMatchObject({ usedBytes: 120, objectCount: 2 });
  await storage.replaceHolder('legacy', { type: 'asset', id: original, assetIds: [] });
  expect((await storage.usage('legacy')).usedBytes).toBe(120);
  await pool.query("UPDATE mio_materials SET state='deleted' WHERE id=$1", [material]);
  expect((await storage.usage('legacy')).usedBytes).toBe(20);
  const again = run(true);
  expect(again.status, again.stderr).toBe(0);
  expect((await storage.usage('legacy')).usedBytes).toBe(20);
});

it('starts and reads under a database-enforced read-only connection and refuses disabled accounting triggers without repairing them', async () => {
  const { db, pool } = await fixture();
  await pool.query(assetSchemaSQL);
  const url = new URL(db.url);
  url.searchParams.set(
    'options',
    `${url.searchParams.get('options')} -cdefault_transaction_read_only=on`,
  );
  const resource = await createStorageAccounting(url.toString(), () => defaultStoragePolicy);
  try {
    expect((await resource.store.usage('new')).usedBytes).toBe(0);
    expect((await pool.query('SELECT count(*) FROM mio_storage_usage')).rows[0].count).toBe('0');
  } finally {
    await resource.close();
  }
  await pool.query('ALTER TABLE mio_assets DISABLE TRIGGER mio_storage_asset_changed');
  await expect(createStorageAccounting(db.url, () => defaultStoragePolicy)).rejects.toThrow(
    'accounting triggers required',
  );
  expect(
    (
      await pool.query(
        "SELECT tgenabled FROM pg_trigger WHERE tgname='mio_storage_asset_changed' AND tgrelid='mio_assets'::regclass",
      )
    ).rows[0].tgenabled,
  ).toBe('D');
});
