import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { materialSchemaSQL } from '../../src/materials/schema.ts';
import { StorageAccounting } from '../../src/assets/storage-store.ts';
import { startStorageReconciliation } from '../../src/assets/storage-worker.ts';
import type { StoragePolicy } from '../../src/assets/storage.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let storage: StorageAccounting;
let policy: StoragePolicy;
const owner = 'z-account';
beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(materialSchemaSQL);
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE mio_assets,mio_asset_holders,mio_storage_objects,mio_storage_usage CASCADE',
  );
  policy = { revision: 1, quotaBytes: 1000, warningAvailableBytes: 200 };
  await pool.query('UPDATE mio_storage_policy SET revision=0');
  storage = new StorageAccounting(pool, () => policy);
  await storage.updatePolicy();
});
afterAll(async () => {
  await pool?.end();
  await database?.close();
});
async function ready(size: number) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at)
    VALUES($1,$2,'x','image/png',$3,$4,$5,'ready',now())`,
    [id, owner, size, `mio/staging/${id}`, `mio/raw/${id}/content`],
  );
  return id;
}

it.each(['revision', 'epoch', 'status'] as const)(
  'keeps a newer PostgreSQL receipt when an earlier %s ACK finishes last',
  async (change) => {
    const base = await ready(900);
    const before = await storage.usage(owner);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const query = pool.query.bind(pool);
    // Delay only delivery of the first UPDATE. Both old and new SQL execute unchanged in PostgreSQL.
    const spy = vi
      .spyOn(pool, 'query')
      .mockImplementationOnce(async (...args: Parameters<Pool['query']>) => {
        entered.resolve();
        await release.promise;
        return query(...args);
      });
    const old = storage.acknowledge(owner, before.reminderVersion);
    try {
      await entered.promise;
      if (change === 'revision') {
        policy = { revision: 2, quotaBytes: 1100, warningAvailableBytes: 300 };
        await storage.updatePolicy();
      } else if (change === 'epoch') {
        await storage.replaceHolder(owner, { type: 'asset', id: base, assetIds: [] });
        await ready(900);
      } else await ready(100);
      const current = await storage.usage(owner);
      expect(current.reminderVersion).not.toBe(before.reminderVersion);
      await storage.acknowledge(owner, current.reminderVersion);
      expect((await storage.usage(owner)).thresholdReminderPending).toBe(false);
      release.resolve();
      await old;
      const receipt = (
        await pool.query('SELECT acknowledged_version FROM mio_storage_usage WHERE owner_id=$1', [
          owner,
        ])
      ).rows[0];
      expect(receipt.acknowledged_version).toBe(current.reminderVersion);
      expect((await storage.usage(owner)).thresholdReminderPending).toBe(false);
    } finally {
      release.resolve();
      await old;
      spy.mockRestore();
    }
  },
);

it('prevents an old PostgreSQL statement snapshot from overwriting a newer receipt after waiting on its row lock', async () => {
  await ready(900);
  const original = await storage.usage(owner);
  const locker = await pool.connect(),
    delayedClient = await pool.connect();
  const delayed = new StorageAccounting(delayedClient as unknown as Pool, () => policy);
  const lockerPid = (await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
    .pid;
  let pending: Promise<void> | undefined;
  try {
    await locker.query('BEGIN');
    await locker.query('SELECT 1 FROM mio_storage_usage WHERE owner_id=$1 FOR UPDATE', [owner]);
    pending = delayed.acknowledge(owner, original.reminderVersion);
    await vi.waitFor(async () => {
      expect(
        (
          await pool.query(
            'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting',
            [lockerPid],
          )
        ).rows[0].waiting,
      ).toBe(true);
    });
    policy = { revision: 2, quotaBytes: 1100, warningAvailableBytes: 300 };
    await storage.updatePolicy();
    const current = new StorageAccounting(locker as unknown as Pool, () => policy);
    const version = (await current.usage(owner)).reminderVersion;
    await current.acknowledge(owner, version);
    await locker.query('COMMIT');
    await pending;
    expect((await storage.usage(owner)).reminderVersion).toBe(version);
    expect((await storage.usage(owner)).thresholdReminderPending).toBe(false);
  } finally {
    await locker.query('ROLLBACK');
    await pending;
    locker.release();
    delayedClient.release();
  }
});

it('withholds new-policy reads and confirmations until the readonly media projection matches', async () => {
  await ready(900);
  policy = { revision: 2, quotaBytes: 1100, warningAvailableBytes: 300 };
  await expect(storage.usage(owner)).rejects.toMatchObject({
    status: 503,
    code: 'STORAGE_UNAVAILABLE',
  });
  await storage.acknowledge(owner, 'storage:v1:warning:2:0');
  expect(
    (
      await pool.query('SELECT acknowledged_version FROM mio_storage_usage WHERE owner_id=$1', [
        owner,
      ])
    ).rows[0].acknowledged_version,
  ).toBeNull();
  await storage.updatePolicy();
  expect((await storage.usage(owner)).status).toBe('warning');
});

it('refreshes policy during a blocked owner reconciliation and records actual material-release and upload waterline transitions', async () => {
  await ready(1700);
  const removable = await ready(300),
    group = randomUUID(),
    material = randomUUID();
  await pool.query(
    `INSERT INTO mio_material_groups(id,owner_id,provider_type,provider_config_id,upstream_scope,group_type,name,auth_status,state)
    VALUES($1,$2,'onelink',$3,'onelink-volc-ark','aigc','g','not_applicable','ready')`,
    [group, owner, randomUUID()],
  );
  await pool.query(
    `INSERT INTO mio_materials(id,owner_id,provider_type,group_id,source_asset_id,asset_type,name,state,registration_credential_version)
    VALUES($1,$2,'onelink',$3,$4,'image','m','active',1)`,
    [material, owner, group, removable],
  );
  await storage.replaceHolder(owner, { type: 'asset', id: removable, assetIds: [] });
  await pool.query("INSERT INTO mio_storage_usage(owner_id) VALUES('a-slow')");
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const reconcile = storage.reconcileOwner.bind(storage);
  const slow = vi.spyOn(storage, 'reconcileOwner').mockImplementation(async (...args) => {
    if (args[0] === 'a-slow') {
      entered.resolve();
      await release.promise;
    } else await reconcile(...args);
  });
  // Only interval scheduling is controlled; every policy/usage/material write runs in real PostgreSQL.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const worker = startStorageReconciliation(storage, []);
  try {
    await vi.advanceTimersByTimeAsync(1000);
    await entered.promise;
    policy = { revision: 2, quotaBytes: 2000, warningAvailableBytes: 200 };
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => {
      expect((await pool.query('SELECT revision FROM mio_storage_policy')).rows[0].revision).toBe(
        '2',
      );
    });
    const full = await storage.usage(owner);
    expect(full.status).toBe('full');
    await storage.acknowledge(owner, full.reminderVersion);
    await pool.query("UPDATE mio_materials SET state='deleted' WHERE id=$1", [material]);
    expect((await storage.usage(owner)).status).toBe('safe');
    await ready(300);
    const again = await storage.usage(owner);
    expect(again).toMatchObject({
      status: 'full',
      usedBytes: 2000,
      thresholdReminderPending: true,
    });
    expect(again.reminderVersion).not.toBe(full.reminderVersion);
  } finally {
    release.resolve();
    await worker.close();
    vi.useRealTimers();
    slow.mockRestore();
  }
});
