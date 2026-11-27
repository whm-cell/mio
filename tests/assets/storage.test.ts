import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AssetStore } from '../../src/assets/store.ts';
import { StorageAccounting } from '../../src/assets/storage-store.ts';
import { defaultStoragePolicy } from '../../src/assets/storage.ts';
import type { StoragePolicy } from '../../src/assets/storage.ts';
import { storageDatabase, resetStorageAccounting } from './storage-fixture.ts';

let db: Awaited<ReturnType<typeof storageDatabase>>['database'];
let pool: Pool;
let storage: StorageAccounting;
let policy: StoragePolicy;
const owner = 'storage-owner';
const gib = 1024 ** 3;
async function asset(
  size: number,
  options: {
    owner?: string;
    kind?: string;
    storageClass?: string;
    state?: string;
    key?: string;
  } = {},
) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at,asset_kind,storage_class)
    VALUES($1,$2,'test','image/png',$3,$4,$5,$6,now()+interval '1 day',$7,$8)`,
    [
      id,
      options.owner ?? owner,
      size,
      `mio/staging/${id}`,
      options.key ?? `mio/raw/${id}/test`,
      options.state ?? 'ready',
      options.kind ?? 'original',
      options.storageClass ?? 'content',
    ],
  );
  return id;
}
const release = (id: string) => storage.replaceHolder(owner, { type: 'asset', id, assetIds: [] });
beforeAll(async () => {
  ({ database: db, pool } = await storageDatabase());
});
beforeEach(async () => {
  policy = { revision: 1, quotaBytes: 1000, warningAvailableBytes: 200 };
  storage = await resetStorageAccounting(pool, () => policy);
});
afterAll(async () => {
  await pool?.end();
  await db?.close();
});

it('uses exact default waterlines and real over-quota ratios without blocking further ready publications', async () => {
  policy = { ...defaultStoragePolicy, revision: 2 };
  await storage.updatePolicy();
  for (let i = 0; i < 4; i++) await asset(gib);
  expect(await storage.usage(owner)).toMatchObject({
    usedBytes: 4 * gib,
    availableBytes: gib,
    status: 'safe',
    thresholdReminderPending: false,
  });
  await asset(1);
  expect(await storage.usage(owner)).toMatchObject({
    availableBytes: gib - 1,
    status: 'warning',
    thresholdReminderPending: true,
  });
  await asset(gib);
  const full = await storage.usage(owner);
  expect(full).toMatchObject({
    quotaBytes: 5 * gib,
    usedBytes: 5 * gib + 1,
    availableBytes: 0,
    status: 'full',
    objectCount: 6,
  });
  expect(full.usageRatio).toBeGreaterThan(1);
  await asset(10);
  expect((await storage.usage(owner)).usedBytes).toBe(5 * gib + 11);
});

it('accounts at real upload commit and idempotent audio/avatar publication, including derived objects', async () => {
  const assets = new AssetStore(pool);
  const upload = randomUUID(),
    lease = randomUUID();
  await assets.create(upload, owner, 'source.png', 'image/png', 80);
  expect((await storage.usage(owner)).usedBytes).toBe(0);
  await assets.claim(upload, owner, 'etag', lease);
  expect((await storage.usage(owner)).usedBytes).toBe(0);
  const source = await assets.commit(upload, owner, lease, `mio/raw/${upload}/a`);
  expect(source).not.toBeNull();
  const audio = {
    assetId: randomUUID(),
    ownerId: owner,
    filename: 'speech.wav',
    contentType: 'audio/wav',
    sizeBytes: 60,
    key: `mio/derived/${randomUUID()}/audio.wav`,
    etag: 'audio',
  };
  await assets.publishAudio(audio);
  await assets.publishAudio(audio);
  const avatar = {
    assetId: randomUUID(),
    key: `mio/derived/${randomUUID()}/avatar.webp`,
    filename: 'avatar.webp',
    sizeBytes: 20,
    etag: 'avatar',
  };
  await assets.publishAvatar(source!, avatar);
  await assets.publishAvatar(source!, avatar);
  await asset(40, { kind: 'derived', key: `mio/derived/${randomUUID()}/image.png` });
  await asset(50, { kind: 'derived', key: `mio/derived/${randomUUID()}/video.mp4` });
  expect(await storage.usage(owner)).toMatchObject({ usedBytes: 250, objectCount: 5 });
});

it('excludes internal previews, HLS, staging, unfinished and supplier-only rows', async () => {
  await asset(20, {
    storageClass: 'internal',
    key: `mio/media/${randomUUID()}/preview.mp4`,
    kind: 'derived',
  });
  await asset(30, {
    storageClass: 'internal',
    key: `mio/media/${randomUUID()}/master.m3u8`,
    kind: 'derived',
  });
  await asset(40, { key: `mio/staging/${randomUUID()}` });
  await asset(50, { state: 'pending' });
  await asset(60, { key: 'https://supplier.invalid/result.png' });
  await asset(70, { kind: 'derived', key: `mio/media/${randomUUID()}/output.wav` });
  expect(await storage.usage(owner)).toMatchObject({ usedBytes: 70, objectCount: 1 });
});

it('holds one bottom object once across directories, copies, trash, avatar and works until the last release', async () => {
  const id = await asset(400);
  const holds = ['folder-a', 'folder-copy', 'recycle', 'avatar', 'work'];
  for (const type of holds)
    await storage.replaceHolder(owner, { type, id: 'position', assetIds: [id, id] });
  expect(await storage.usage(owner)).toMatchObject({ usedBytes: 400, objectCount: 1 });
  await release(id);
  for (const type of holds.slice(0, -1)) {
    await storage.replaceHolder(owner, { type, id: 'position', assetIds: [] });
    expect((await storage.usage(owner)).usedBytes).toBe(400);
    expect((await new AssetStore(pool).owned(id, owner)).state).toBe('ready');
  }
  await storage.replaceHolder(owner, { type: 'work', id: 'position', assetIds: [] });
  expect(await storage.usage(owner)).toMatchObject({ usedBytes: 0, objectCount: 0 });
  await storage.reconcileOwner(owner);
  expect((await storage.usage(owner)).usedBytes).toBe(0);
});

it('rejects foreign ownership and atomically rolls back failed holder replacement', async () => {
  const mine = await asset(25),
    foreign = await asset(50, { owner: 'other' });
  await storage.replaceHolder(owner, { type: 'work', id: 'slot', assetIds: [mine] });
  await expect(
    storage.replaceHolder(owner, { type: 'work', id: 'slot', assetIds: [foreign] }),
  ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  await expect(
    pool.query("INSERT INTO mio_asset_holders VALUES($1,$2,'forged','x')", [owner, foreign]),
  ).rejects.toMatchObject({ code: '23503' });
  await release(mine);
  expect((await storage.usage(owner)).usedBytes).toBe(25);
  expect((await storage.usage('other')).usedBytes).toBe(50);
});

it('persists every downward region transition and never lets an old full receipt clear a later full reminder', async () => {
  const base = await asset(900),
    extra = await asset(100);
  const full = await storage.usage(owner);
  await storage.acknowledge(owner, full.reminderVersion);
  await storage.acknowledge(owner, full.reminderVersion);
  expect((await storage.usage(owner)).thresholdReminderPending).toBe(false);
  await release(extra);
  const warning = await storage.usage(owner);
  expect(warning.status).toBe('warning');
  expect(warning.reminderVersion).toMatch(/:1$/);
  const replacement = await asset(100);
  const fullAgain = await storage.usage(owner);
  expect(fullAgain.reminderVersion).not.toBe(full.reminderVersion);
  await storage.acknowledge(owner, full.reminderVersion);
  expect((await storage.usage(owner)).thresholdReminderPending).toBe(true);
  await storage.acknowledge(owner, fullAgain.reminderVersion);
  await release(base);
  expect(await storage.usage(owner)).toMatchObject({
    status: 'safe',
    thresholdReminderPending: false,
  });
  await asset(900);
  const restarted = new StorageAccounting(pool, () => policy);
  expect((await restarted.usage(owner)).reminderVersion).toMatch(/:2$/);
  expect((await restarted.usage(owner)).thresholdReminderPending).toBe(true);
  await release(replacement);
  expect((await restarted.usage(owner)).reminderVersion).toMatch(/:3$/);
});

it('keeps same-region refreshes, cleanups and unchanged settings stable; actual policy changes remind once', async () => {
  await asset(890);
  const small = await asset(10);
  const before = await storage.usage(owner);
  await storage.acknowledge(owner, before.reminderVersion);
  await release(small);
  await storage.updatePolicy();
  expect(await storage.usage(owner)).toMatchObject({
    reminderVersion: before.reminderVersion,
    thresholdReminderPending: false,
  });
  policy = { ...policy, revision: 2, warningAvailableBytes: 300 };
  await storage.updatePolicy();
  const after = await storage.usage(owner);
  expect(after.reminderVersion).not.toBe(before.reminderVersion);
  expect(after.thresholdReminderPending).toBe(true);
  await storage.acknowledge(owner, after.reminderVersion);
  policy = { ...policy, revision: 3, quotaBytes: 500 };
  await storage.updatePolicy();
  expect(await storage.usage(owner)).toMatchObject({
    status: 'full',
    usedBytes: 890,
    availableBytes: 0,
    thresholdReminderPending: true,
  });
  expect((await storage.usage('new-account')).quotaBytes).toBe(500);
});

it('reconciles drift and holder changes, advances the epoch on a reconciled full-to-warning fall, preserves failed source holds', async () => {
  await asset(900);
  const extra = await asset(100);
  const prior = await storage.usage(owner);
  await storage.acknowledge(owner, prior.reminderVersion);
  // Simulate a historical writer that bypassed the trigger. The periodic path must repair the actual source.
  await pool.query('ALTER TABLE mio_asset_holders DISABLE TRIGGER mio_storage_holder_changed');
  await pool.query('DELETE FROM mio_asset_holders WHERE asset_id=$1', [extra]);
  await pool.query('ALTER TABLE mio_asset_holders ENABLE TRIGGER mio_storage_holder_changed');
  expect((await storage.usage(owner)).usedBytes).toBe(1000);
  await storage.reconcileOwner(owner);
  expect(await storage.usage(owner)).toMatchObject({ status: 'warning', usedBytes: 900 });
  expect((await storage.usage(owner)).reminderVersion).toMatch(/:1$/);
  const source = {
    type: 'avatar',
    read: vi.fn(async () => [{ type: 'avatar', id: owner, assetIds: [extra] }]),
  };
  await storage.reconcileOwner(owner, [source]);
  expect((await storage.usage(owner)).usedBytes).toBe(1000);
  source.read.mockRejectedValueOnce(new Error('auth unavailable'));
  await expect(storage.reconcileOwner(owner, [source])).rejects.toThrow('auth unavailable');
  expect((await storage.usage(owner)).usedBytes).toBe(1000);
  await pool.query(
    'UPDATE mio_storage_usage SET used_bytes=123,object_count=99 WHERE owner_id=$1',
    [owner],
  );
  await storage.reconcileOwner(owner, [source]);
  expect(await storage.usage(owner)).toMatchObject({ usedBytes: 1000, objectCount: 2 });
});

it('GET runs in a read-only transaction, takes no row lock, avoids asset/holder scans and does not create a new account row', async () => {
  await asset(40);
  const client = await pool.connect();
  await client.query('BEGIN READ ONLY');
  const query = vi.spyOn(client, 'query');
  try {
    const readonly = new StorageAccounting(client as unknown as Pool, () => policy);
    expect((await readonly.usage(owner)).usedBytes).toBe(40);
    expect((await readonly.usage('brand-new')).usedBytes).toBe(0);
    for (const [sql] of query.mock.calls) {
      expect(sql).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|DISTINCT|FOR|mio_assets|mio_asset_holders)\b/i,
      );
    }
  } finally {
    query.mockRestore();
    await client.query('ROLLBACK');
    client.release();
  }
  expect(
    (await pool.query("SELECT 1 FROM mio_storage_usage WHERE owner_id='brand-new'")).rowCount,
  ).toBe(0);
  const writer = await pool.connect();
  await writer.query('BEGIN');
  await writer.query('SELECT 1 FROM mio_storage_usage WHERE owner_id=$1 FOR UPDATE', [owner]);
  try {
    expect((await storage.usage(owner)).usedBytes).toBe(40);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
  }
});

it('serializes concurrent holder mutations without double counting or premature release', async () => {
  const id = await asset(400);
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      storage.replaceHolder(owner, { type: 'work', id: String(i), assetIds: [id] }),
    ),
  );
  await release(id);
  await Promise.all(
    Array.from({ length: 9 }, (_, i) =>
      storage.replaceHolder(owner, { type: 'work', id: String(i), assetIds: [] }),
    ),
  );
  expect(await storage.usage(owner)).toMatchObject({ usedBytes: 400, objectCount: 1 });
  await storage.replaceHolder(owner, { type: 'work', id: '9', assetIds: [] });
  expect((await storage.usage(owner)).usedBytes).toBe(0);
});

it('keeps a local materials.source_asset_id hold transactionally until deletion, excludes remote-only materials', async () => {
  const id = await asset(75),
    group = randomUUID(),
    material = randomUUID();
  await pool.query(
    `INSERT INTO mio_material_groups(id,owner_id,provider_type,provider_config_id,upstream_scope,group_type,name,auth_status,state)
    VALUES($1,$2,'onelink',$3,'onelink-volc-ark','aigc','group','not_applicable','ready')`,
    [group, owner, randomUUID()],
  );
  await pool.query(
    `INSERT INTO mio_materials(id,owner_id,provider_type,group_id,source_asset_id,asset_type,name,state,registration_credential_version)
    VALUES($1,$2,'onelink',$3,$4,'image','m','active',1)`,
    [material, owner, group, id],
  );
  await release(id);
  expect((await storage.usage(owner)).usedBytes).toBe(75);
  await pool.query("UPDATE mio_materials SET state='deleting' WHERE id=$1", [material]);
  expect((await storage.usage(owner)).usedBytes).toBe(75);
  await pool.query("UPDATE mio_materials SET state='deleted' WHERE id=$1", [material]);
  await pool.query(
    `INSERT INTO mio_materials(id,owner_id,provider_type,group_id,source_asset_id,asset_type,name,state,registration_credential_version)
    VALUES($1,$2,'onelink',$3,NULL,'image','remote','active',1)`,
    [randomUUID(), owner, group],
  );
  expect((await storage.usage(owner)).usedBytes).toBe(0);
});

it('revokes former owner holds on authoritative reassignment without bypassing post-I/O ownership checks', async () => {
  const id = await asset(70);
  await storage.replaceHolder(owner, { type: 'avatar', id: owner, assetIds: [id] });
  await pool.query('UPDATE mio_assets SET owner_id=$2 WHERE id=$1', [id, 'reassigned-owner']);
  expect((await storage.usage(owner)).usedBytes).toBe(0);
  expect((await storage.usage('reassigned-owner')).usedBytes).toBe(70);
  expect(
    (
      await pool.query('SELECT 1 FROM mio_asset_holders WHERE owner_id=$1 AND asset_id=$2', [
        owner,
        id,
      ])
    ).rowCount,
  ).toBe(0);
  await expect(new AssetStore(pool).owned(id, owner)).rejects.toMatchObject({
    code: 'ASSET_NOT_FOUND',
  });
});
