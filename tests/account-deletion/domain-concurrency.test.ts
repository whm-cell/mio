import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { AccountDomainStore } from '../../src/account-deletion/domain-store.ts';
import { ComputeStore } from '../../src/compute/transcode/store.ts';

it('lets a pre-closure row writer reject terminally while a cleanup batch waits for that row, without a fence/row deadlock', async () => {
  const database = await authDatabase(),
    pool = new Pool({ connectionString: database.url, max: 3 }),
    store = new AccountDomainStore(pool);
  const writer = await pool.connect();
  let cleanup: Promise<unknown> | undefined;
  try {
    await pool.query(assetSchemaSQL);
    const id = randomUUID(),
      owner = 'old';
    await pool.query(
      "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,state,expires_at) VALUES($1,$2,'private','image/png',1,$3,'pending',now())",
      [id, owner, 'mio/staging/' + id],
    );
    await writer.query('BEGIN');
    await writer.query('SELECT id FROM mio_assets WHERE id=$1 FOR UPDATE', [id]);
    await store.closeAccount(owner, new Date());
    const entered = Promise.withResolvers<number>();
    cleanup = store.batch(owner, 'assets', async (client) => {
      entered.resolve(
        (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      await client.query('DELETE FROM mio_assets WHERE id=$1', [id]);
      return 0;
    });
    const pid = await entered.promise;
    await expect
      .poll(
        async () =>
          (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid]))
            .rows[0]?.wait_event_type,
      )
      .toBe('Lock');
    await expect(
      writer.query("UPDATE mio_assets SET filename='late' WHERE id=$1", [id]),
    ).rejects.toThrow('ACCOUNT_DELETED');
    await writer.query('ROLLBACK');
    await expect(cleanup).resolves.toMatchObject({ done: true, remaining: 0 });
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
    await cleanup?.catch(() => {});
    await store.close();
    await database.close();
  }
});

it('serializes an ordinary result behind an already locked job using the same row-before-owner order as controls', async () => {
  const database = await authDatabase(),
    pool = new Pool({ connectionString: database.url, max: 4 }),
    compute = new ComputeStore(pool);
  const writer = await pool.connect();
  let accepting: Promise<void> | undefined;
  try {
    await pool.query(assetSchemaSQL + computeSchemaSQL);
    const owner = 'open',
      asset = randomUUID(),
      raw = `mio/raw/${asset}/${randomUUID()}`;
    await pool.query(
      "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at) VALUES($1,$2,'source','video/mp4',1,$3,$3,'ready',now())",
      [asset, owner, raw],
    );
    const job = (await compute.create(owner, randomUUID(), asset, raw, 1, 'etag')).job;
    await writer.query('BEGIN');
    await writer.query('SELECT id FROM mio_compute_jobs WHERE id=$1 FOR UPDATE', [job.id]);
    accepting = compute.accept({
      version: 1,
      type: 'transcode.result',
      messageId: randomUUID(),
      commandId: job.command_id,
      jobId: job.id,
      attemptId: job.attempt_id,
      attempt: job.attempt,
      state: 'running',
    });
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM mio_compute_jobs%' ",
            )
          ).rows[0].count,
      )
      .toBe('1');
    await writer.query('UPDATE mio_compute_jobs SET updated_at=now() WHERE id=$1', [job.id]);
    await writer.query('COMMIT');
    await accepting;
    expect(
      (await pool.query('SELECT state FROM mio_compute_jobs WHERE id=$1', [job.id])).rows[0].state,
    ).toBe('running');
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
    await accepting?.catch(() => {});
    await compute.close();
    await database.close();
  }
});
