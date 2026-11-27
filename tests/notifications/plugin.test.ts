import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as Mio from '../../src/plugin.ts';
import * as Notifications from '../../src/notifications/store.ts';
import { notificationSchemaSQL } from '../../src/notifications/schema.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { adminSchemaSQL } from '../../src/admin/schema.ts';
import { AdminStore } from '../../src/admin/store.ts';
import { hashAdminPassword } from '../../src/auth/admin-password.ts';
import { authDatabase } from '../support/auth-database.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
const contexts: Context[] = [];
const deploymentToken = randomBytes(32).toString('hex');
beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.observerURL });
});
afterAll(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose();
  vi.unstubAllEnvs();
  await pool?.end();
  await database?.close();
});

async function setup() {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  const origin = ctx.webServer.getOrigin();
  const env: NodeJS.ProcessEnv = {
    MIO_AUTH_BASE_URL: origin,
    MIO_AUTH_SECRET: randomBytes(32).toString('hex'),
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_AUTH_RATE_LIMIT_BACKEND: 'database',
    MIO_AUTH_ALLOWED_ORIGINS: JSON.stringify([origin]),
    MIO_NOTIFICATIONS_DATABASE_URL: database.url,
    MIO_PROVIDERS_DATABASE_URL: database.url,
    MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
    MIO_PROVIDERS_MASTER_KEY_ID: 'u4-plugin',
    MIO_ADMIN_ENABLED: 'true',
    MIO_U4_TEST_TOKEN: deploymentToken,
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const migration = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(migration.status, migration.stderr).toBe(0);
  return { ctx, origin };
}

it('mounts user/admin routes without granting service tokens and removes routes and its pool on unload', async () => {
  await pool.query(notificationSchemaSQL);
  await pool.query(providerSchemaSQL);
  await pool.query(adminSchemaSQL);
  const { ctx, origin } = await setup();
  const acquired = vi.spyOn(Notifications, 'createNotificationStore');
  const plugin = ctx.plugin(Mio, { tokenEnv: 'MIO_U4_TEST_TOKEN', allowedOrigins: [] });
  await plugin;
  expect(acquired).toHaveBeenCalledTimes(1);
  const store = await acquired.mock.results[0]!.value;
  const close = vi.spyOn(store, 'close');
  for (const [path, code] of [
    ['/api/v1/announcements', 'UNAUTHORIZED'],
    ['/api/v1/announcements/latest-popup', 'UNAUTHORIZED'],
    ['/api/v1/admin/announcements', 'ADMIN_UNAUTHORIZED'],
  ]) {
    const response = await fetch(`${origin}${path}`, {
      headers: { authorization: `Bearer ${deploymentToken}` },
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe(code);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  await plugin.dispose();
  expect(close).toHaveBeenCalledTimes(1);
  expect((await fetch(`${origin}/api/v1/announcements`)).status).toBe(404);
  expect((await fetch(`${origin}/api/v1/admin/announcements`)).status).toBe(404);
  acquired.mockRestore();
});

it('releases notifications even when disposed during acquisition and only checks schema on startup', async () => {
  const { ctx } = await setup();
  const real = Notifications.createNotificationStore;
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let close: ReturnType<typeof vi.spyOn> | undefined;
  const acquired = vi
    .spyOn(Notifications, 'createNotificationStore')
    .mockImplementationOnce(async (url) => {
      const store = await real(url);
      close = vi.spyOn(store, 'close');
      entered.resolve();
      await release.promise;
      return store;
    });
  const plugin = ctx.plugin(Mio, { tokenEnv: 'MIO_U4_TEST_TOKEN', allowedOrigins: [] });
  await entered.promise;
  const disposing = plugin.dispose();
  release.resolve();
  await Promise.allSettled([plugin, disposing]);
  expect(close).toHaveBeenCalledTimes(1);
  acquired.mockRestore();
});

it('drains an admitted announcement audit before either teardown path closes the admin pool', async () => {
  const { ctx, origin } = await setup();
  await pool.query(
    'INSERT INTO mio_admin_accounts(id,username,password_hash,is_super_admin) VALUES($1,$2,$3,true)',
    [randomUUID(), 'drain_admin', await hashAdminPassword('drain-password-123')],
  );
  const plugin = ctx.plugin(Mio, { tokenEnv: 'MIO_U4_TEST_TOKEN', allowedOrigins: [] });
  await plugin;
  const login = await fetch(`${origin}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'drain_admin', password: 'drain-password-123' }),
  });
  expect(login.status).toBe(200);
  const session = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const original = AdminStore.prototype.recordAnnouncementOperation;
  const audit = vi
    .spyOn(AdminStore.prototype, 'recordAnnouncementOperation')
    .mockImplementationOnce(async function (this: AdminStore, actor, action, id) {
      entered.resolve();
      await resume.promise;
      return original.call(this, actor, action, id);
    });
  const close = vi.spyOn(AdminStore.prototype, 'close');
  const pending = fetch(`${origin}/api/v1/admin/announcements`, {
    method: 'POST',
    headers: { origin, cookie: session, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Draining', body: 'Retain audited write' }),
  });
  try {
    await entered.promise;
    const disposing = plugin.dispose();
    await vi.waitFor(async () =>
      expect((await fetch(`${origin}/api/v1/announcements`)).status).toBe(404),
    );
    expect(close).not.toHaveBeenCalled();
    resume.resolve();
    expect((await pending).status).toBe(201);
    await disposing;
    expect(close).toHaveBeenCalledTimes(1);
    expect(
      (
        await pool.query(
          "SELECT actor_name FROM mio_admin_audit_logs WHERE action='announcement.create' AND actor_name='drain_admin'",
        )
      ).rows,
    ).toHaveLength(1);
  } finally {
    resume.resolve();
    await pending;
    await plugin.dispose();
    audit.mockRestore();
    close.mockRestore();
  }
});
