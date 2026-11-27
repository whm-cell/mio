import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readNotificationsConfig } from '../../src/notifications/config.ts';
import { checkNotificationSchema, notificationSchemaSQL } from '../../src/notifications/schema.ts';
import { createNotificationStore } from '../../src/notifications/store.ts';
import { authDatabase } from '../support/auth-database.ts';
import { isolateProviderEnvironment } from '../providers-setup.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.observerURL });
});
afterAll(async () => {
  await pool?.end();
  await database?.close();
});

function migrate(apply = false, url?: string) {
  return spawnSync(
    process.execPath,
    ['scripts/service/migrate-notifications.ts', ...(apply ? ['--apply'] : [])],
    {
      env: {
        PATH: process.env.PATH ?? '',
        ...(url ? { MIO_NOTIFICATIONS_DATABASE_URL: url } : {}),
      },
      encoding: 'utf8',
      timeout: 30000,
    },
  );
}

it.each([true, false])(
  'isolates inherited notification configuration and restores it exactly (configured=%s)',
  (configured) => {
    const env: NodeJS.ProcessEnv = {
      MIO_AUTH_DATABASE_URL: 'postgres://auth-sentinel.invalid/auth',
      MIO_AUTH_SECRET: 'auth-secret-sentinel',
      MIO_AUTH_ALLOWED_ORIGINS: '["https://auth-sentinel.invalid"]',
      UNRELATED: 'unchanged',
      ...(configured
        ? { MIO_NOTIFICATIONS_DATABASE_URL: 'postgres://host-sentinel.invalid/business' }
        : {}),
    };
    const before = { ...env };
    expect(Boolean(readNotificationsConfig(env))).toBe(configured);
    const restore = isolateProviderEnvironment(env);
    try {
      expect(readNotificationsConfig(env)).toBeUndefined();
      expect(env).toEqual({
        MIO_AUTH_DATABASE_URL: before.MIO_AUTH_DATABASE_URL,
        MIO_AUTH_SECRET: before.MIO_AUTH_SECRET,
        MIO_AUTH_ALLOWED_ORIGINS: before.MIO_AUTH_ALLOWED_ORIGINS,
        UNRELATED: before.UNRELATED,
      });
      // A domain fixture must opt in again after common setup isolation.
      env.MIO_NOTIFICATIONS_DATABASE_URL = 'postgres://fixture-sentinel.invalid/random-schema';
      expect(readNotificationsConfig(env)).toEqual({
        databaseURL: 'postgres://fixture-sentinel.invalid/random-schema',
      });
      env.MIO_PROVIDERS_MASTER_KEY_ID = 'fixture-only';
    } finally {
      restore();
    }
    expect(env).toEqual(before);
    expect(Object.hasOwn(env, 'MIO_NOTIFICATIONS_DATABASE_URL')).toBe(configured);
  },
);

it('uses an explicit independent URL and previews SQL without requiring or connecting to a database', async () => {
  expect(
    readNotificationsConfig({ MIO_AUTH_DATABASE_URL: 'postgres://unrelated' }),
  ).toBeUndefined();
  expect(
    readNotificationsConfig({ MIO_NOTIFICATIONS_DATABASE_URL: '  postgres://notices  ' }),
  ).toEqual({ databaseURL: 'postgres://notices' });
  const preview = migrate(false, 'postgres://invalid:invalid@127.0.0.1:1/unreachable');
  expect(preview.status, preview.stderr).toBe(0);
  expect(preview.stdout.trim()).toBe(notificationSchemaSQL.trim());
  expect(
    (await pool.query("SELECT to_regclass('mio_announcements') AS relation")).rows[0]?.relation,
  ).toBeNull();
  expect(migrate(true).status).not.toBe(0);
});

it('applies incrementally and idempotently, preserves content and receipts, and permits read-only startup', async () => {
  expect(migrate(true, database.url).status).toBe(0);
  const id = randomUUID();
  await pool.query('INSERT INTO mio_announcements(id,title,body) VALUES($1,$2,$3)', [
    id,
    'Existing draft',
    'Saved body',
  ]);
  await pool.query('INSERT INTO mio_announcement_reads(user_id,announcement_id) VALUES($1,$2)', [
    'user-outside-this-database',
    id,
  ]);
  const before = (await pool.query('SELECT * FROM mio_announcements')).rows;
  const beforeReads = (await pool.query('SELECT * FROM mio_announcement_reads')).rows;
  const again = migrate(true, database.url);
  expect(again.status, again.stderr).toBe(0);
  expect((await pool.query('SELECT * FROM mio_announcements')).rows).toEqual(before);
  expect((await pool.query('SELECT * FROM mio_announcement_reads')).rows).toEqual(beforeReads);
  const url = new URL(database.url);
  url.searchParams.set(
    'options',
    `${url.searchParams.get('options')} -cdefault_transaction_read_only=on`,
  );
  const store = await createNotificationStore(url.toString());
  expect((await store.get(id)).body).toBe('Saved body');
  await store.close();
  expect((await pool.query('SELECT * FROM mio_announcements')).rows).toEqual(before);
});

it('fails readonly startup for missing structures and closes the acquired pool; never repairs on startup', async () => {
  await pool.query('DROP INDEX mio_announcements_popup_idx');
  const close = vi.spyOn(Pool.prototype, 'end');
  await expect(createNotificationStore(database.url)).rejects.toThrow('NOTIFICATIONS_SCHEMA');
  expect(close).toHaveBeenCalledTimes(1);
  close.mockRestore();
  expect(
    (await pool.query("SELECT to_regclass('mio_announcements_popup_idx') AS relation")).rows[0]
      ?.relation,
  ).toBeNull();
  expect(migrate(true, database.url).status).toBe(0);
  await checkNotificationSchema(pool);
  await pool.query(
    'ALTER TABLE mio_announcement_reads DROP CONSTRAINT mio_announcement_reads_pkey',
  );
  await expect(checkNotificationSchema(pool)).rejects.toThrow('NOTIFICATIONS_SCHEMA');
  expect(migrate(true, database.url).status).not.toBe(0);
});
