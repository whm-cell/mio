import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, onTestFinished, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { AssetStore } from '../../src/assets/store.ts';

async function fixture() {
  const db = await authDatabase();
  const pool = new Pool({ connectionString: db.url });
  const application = db.applicationName + '_cleanup';
  const scoped = new URL(db.url);
  scoped.searchParams.set('application_name', application);
  const store = new AssetStore(
    new Pool({ connectionString: scoped.toString(), statement_timeout: 5000 }),
  );
  onTestFinished(async () => {
    await store.close();
    await pool.end();
    await db.close();
  });
  await pool.query(assetSchemaSQL);
  return { pool, store, application };
}

it('returns ready and expired staging keys without rewriting terminal rows, including retry passes', async () => {
  const { pool, store } = await fixture();
  const ids = Array.from({ length: 4 }, () => randomUUID()).sort();
  await pool.query(
    "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at,lease_until) SELECT id,'owner','image','image/png',1,'mio/staging/'||id,CASE WHEN n=1 THEN 'mio/raw/'||id ELSE NULL END,CASE n WHEN 1 THEN 'ready' WHEN 2 THEN 'expired' WHEN 3 THEN 'pending' ELSE 'finalizing' END,statement_timestamp()-interval '1 day',CASE WHEN n=4 THEN statement_timestamp()-interval '1 hour' ELSE NULL END FROM unnest($1::uuid[]) WITH ORDINALITY x(id,n)",
    [ids],
  );
  const before = (await pool.query('SELECT id,state,ctid::text FROM mio_assets ORDER BY id')).rows;
  const first = await store.expiredStaging();
  expect(first.map((row) => row.id)).toEqual(ids);
  expect(first.map((row) => row.staging_key)).toEqual(ids.map((id) => 'mio/staging/' + id));
  const transitioned = (await pool.query('SELECT id,state,ctid::text FROM mio_assets ORDER BY id'))
    .rows;
  expect(transitioned.map((row) => row.state)).toEqual(['ready', 'expired', 'expired', 'expired']);
  expect(transitioned.slice(0, 2)).toEqual(before.slice(0, 2));
  expect(await store.expiredStaging()).toEqual(first);
  expect((await pool.query('SELECT id,state,ctid::text FROM mio_assets ORDER BY id')).rows).toEqual(
    transitioned,
  );
  await store.stagingDeleted(ids[0]!, first[0]!.staging_key);
  expect((await store.expiredStaging()).map((row) => row.id)).toEqual(ids.slice(1));
});

it.each(['ready', 'renewed-lease'] as const)(
  'rechecks a mutable cleanup candidate after a concurrent finalizer becomes %s',
  async (outcome) => {
    const { pool, store, application } = await fixture();
    const id = randomUUID();
    await pool.query(
      "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,state,lease_id,lease_until,expires_at) VALUES($1,'owner','image','image/png',1,$2,'finalizing',$3,statement_timestamp()+interval '500 milliseconds',statement_timestamp()+interval '500 milliseconds')",
      [id, 'mio/staging/' + id, randomUUID()],
    );
    const locker = await pool.connect();
    let cleanup: Promise<Awaited<ReturnType<AssetStore['expiredStaging']>>> | undefined;
    try {
      await locker.query('BEGIN');
      if (outcome === 'ready') {
        const committed = await locker.query(
          "UPDATE mio_assets SET state='ready',raw_key=$2,lease_id=NULL,lease_until=NULL WHERE id=$1 AND state='finalizing' AND lease_until>now() AND expires_at>now()",
          [id, 'mio/raw/' + id],
        );
        expect(committed.rowCount).toBe(1);
      } else
        await locker.query(
          "UPDATE mio_assets SET lease_until=statement_timestamp()+interval '1 hour' WHERE id=$1",
          [id],
        );
      await pool.query('SELECT pg_sleep(0.6)');
      cleanup = store.expiredStaging();
      await vi.waitFor(async () => {
        expect(
          (
            await pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
              [application],
            )
          ).rowCount,
        ).toBe(1);
      });
      await locker.query('COMMIT');
      expect((await cleanup).map((row) => row.id)).toEqual(outcome === 'ready' ? [id] : []);
      expect((await store.owned(id, 'owner')).state).toBe(
        outcome === 'ready' ? 'ready' : 'finalizing',
      );
      if (outcome === 'ready')
        expect((await store.owned(id, 'owner')).raw_key).toBe('mio/raw/' + id);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      await cleanup;
    }
  },
);

it('upgrades the historical cleanup index without changing assets and preserves the new index across repeated migrations', async () => {
  const { pool, store } = await fixture();
  const id = randomUUID();
  await store.create(id, 'owner', 'history.png', 'image/png', 1);
  await pool.query(
    'DROP INDEX mio_assets_cleanup_order; CREATE INDEX mio_assets_cleanup ON mio_assets(expires_at) WHERE staging_deleted_at IS NULL',
  );
  const before = (await pool.query('SELECT * FROM mio_assets WHERE id=$1', [id])).rows;
  const indexes = async () =>
    (
      await pool.query(
        "SELECT c.oid,c.relfilenode,pg_get_indexdef(c.oid) AS definition FROM pg_class c WHERE c.oid=to_regclass('mio_assets_cleanup_order')",
      )
    ).rows;
  await pool.query(assetSchemaSQL);
  const first = await indexes();
  expect(first).toHaveLength(1);
  expect(first[0].definition).toContain('USING btree (expires_at, id)');
  expect(first[0].definition).toContain('WHERE (staging_deleted_at IS NULL)');
  expect(
    (await pool.query("SELECT to_regclass('mio_assets_cleanup') AS old")).rows[0].old,
  ).toBeNull();
  await pool.query(assetSchemaSQL);
  expect(await indexes()).toEqual(first);
  expect((await pool.query('SELECT * FROM mio_assets WHERE id=$1', [id])).rows).toEqual(before);
});
