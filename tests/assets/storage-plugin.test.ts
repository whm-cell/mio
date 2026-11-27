import { randomBytes } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import * as Mio from '../../src/plugin.ts';
import * as Auth from '../../src/auth/service.ts';
import type { Authentication } from '../../src/auth/service.ts';
import * as Cos from '../../src/integrations/cos.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { adminSchemaSQL } from '../../src/admin/schema.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { createAdminStore } from '../../src/admin/store.ts';
import { hashAdminPassword } from '../../src/auth/admin-password.ts';
import { authDatabase } from '../support/auth-database.ts';

it('keeps the real plugin admin PATCH successful after media projection fails, recovers in background, and preserves admin transaction errors', async () => {
  const adminDB = await authDatabase(),
    mediaDB = await authDatabase();
  const admin = new Pool({ connectionString: adminDB.url }),
    media = new Pool({ connectionString: mediaDB.url });
  const ctx = new Context();
  let plugin: Awaited<ReturnType<typeof ctx.plugin>> | undefined;
  try {
    await admin.query(providerSchemaSQL);
    await admin.query(adminSchemaSQL);
    await media.query(assetSchemaSQL);
    const bootstrap = await createAdminStore({ databaseURL: adminDB.url, allowedOrigins: [] });
    try {
      await bootstrap.bootstrapSuperAdmin(
        'storage-admin',
        await hashAdminPassword('fixture-password-123'),
      );
    } finally {
      await bootstrap.close();
    }
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Tools);
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
    const origin = ctx.webServer.getOrigin();
    for (const [key, value] of Object.entries({
      MIO_API_TOKEN: randomBytes(32).toString('hex'),
      MIO_AUTH_DATABASE_URL: adminDB.url,
      MIO_AUTH_BASE_URL: origin,
      MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
      MIO_AUTH_RATE_LIMIT_BACKEND: 'database',
      MIO_AUTH_ALLOWED_ORIGINS: JSON.stringify([origin]),
      MIO_PROVIDERS_DATABASE_URL: adminDB.url,
      MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
      MIO_PROVIDERS_MASTER_KEY_ID: 'u6-plugin',
      MIO_ASSETS_DATABASE_URL: mediaDB.url,
      MIO_COS_BUCKET: 'mio-fixture-1234567890',
      MIO_COS_REGION: 'ap-shanghai',
      MIO_COS_SECRET_ID: 'fixture',
      MIO_COS_SECRET_KEY: 'fixture',
      MIO_ADMIN_ENABLED: 'true',
    }))
      vi.stubEnv(key, value);
    for (const key of [
      'MIO_COMPUTE_ENABLED',
      'MIO_GENERATIONS_ENABLED',
      'MIO_MATERIALS_ENABLED',
      'MIO_CONVERSATIONS_DATABASE_URL',
      'MIO_NOTIFICATIONS_ENABLED',
      'MIO_AUTH_SMS_ENABLED',
      'MIO_AUTH_WECHAT_ENABLED',
      'MIO_COS_SESSION_TOKEN',
    ])
      vi.stubEnv(key, undefined);
    vi.spyOn(Auth, 'createAuthentication').mockResolvedValue({
      identity: async (headers: Headers) =>
        headers.get('cookie') === 'session=user'
          ? { userId: 'storage-user', sessionId: 'fixture' }
          : null,
      avatarAssetId: async () => null,
      close: async () => {},
    } as unknown as Authentication);
    vi.spyOn(Cos, 'createCosStorage').mockReturnValue({
      head: vi.fn().mockRejectedValue(new Error('unexpected COS')),
    } as unknown as ReturnType<typeof Cos.createCosStorage>);
    plugin = await ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
    const request = (
      path: string,
      body?: unknown,
      cookie = '',
      method = body === undefined ? 'GET' : 'PATCH',
    ) =>
      fetch(`${origin}${path}`, {
        method,
        headers: {
          origin,
          cookie,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const login = await request(
      '/api/v1/admin/auth/login',
      { username: 'storage-admin', password: 'fixture-password-123' },
      '',
      'POST',
    );
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    // The actual second database rejects policy writes after the first database has committed.
    await media.query(`CREATE FUNCTION reject_policy_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'fixture media unavailable'; END $$;
      CREATE TRIGGER reject_policy_projection BEFORE UPDATE ON mio_storage_policy
        FOR EACH ROW EXECUTE FUNCTION reject_policy_projection()`);
    const input = { expectedRevision: 0, quotaBytes: 8_589_934_592 };
    const saved = await request('/api/v1/admin/settings/storage', input, cookie);
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await saved.json()).toEqual({
      revision: 1,
      quotaBytes: 8_589_934_592,
      warningAvailableBytes: 1_073_741_824,
    });
    const rows = () =>
      admin.query(
        "SELECT revision,value FROM mio_admin_global_settings WHERE setting_key='storage'",
      );
    expect((await rows()).rows[0]).toMatchObject({
      revision: 1,
      value: { quotaBytes: 8_589_934_592 },
    });
    expect(
      (
        await admin.query(
          "SELECT count(*) FROM mio_admin_audit_logs WHERE action='settings.storage.update'",
        )
      ).rows[0].count,
    ).toBe('1');
    const staleUsage = await request('/api/v1/me/storage-usage', undefined, 'session=user');
    expect(staleUsage.status).toBe(503);
    await media.query('DROP TRIGGER reject_policy_projection ON mio_storage_policy');
    // Recovery uses the real periodic policy projection without resubmitting the admin mutation.
    await vi.waitFor(
      async () => {
        expect(
          (await media.query('SELECT revision FROM mio_storage_policy')).rows[0].revision,
        ).toBe('1');
      },
      { timeout: 5000, interval: 50 },
    );
    const usage = await request('/api/v1/me/storage-usage', undefined, 'session=user');
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({ quotaBytes: 8_589_934_592, usedBytes: 0 });
    await admin.query(`CREATE FUNCTION reject_storage_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='settings.storage.update' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_storage_audit BEFORE INSERT ON mio_admin_audit_logs
        FOR EACH ROW EXECUTE FUNCTION reject_storage_audit()`);
    const failure = await request(
      '/api/v1/admin/settings/storage',
      { expectedRevision: 1, quotaBytes: 9_663_676_416 },
      cookie,
    );
    expect(failure.status).toBe(503);
    expect(await failure.json()).toMatchObject({ error: { code: 'ADMIN_UNAVAILABLE' } });
    expect((await rows()).rows[0].revision).toBe(1);
    expect(
      (
        await admin.query(
          "SELECT count(*) FROM mio_admin_audit_logs WHERE action='settings.storage.update'",
        )
      ).rows[0].count,
    ).toBe('1');
    expect((await request('/api/v1/admin/settings/storage', input, cookie)).status).toBe(409);
  } finally {
    await plugin?.dispose();
    await ctx.fiber.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await admin.end();
    await media.end();
    await adminDB.close();
    await mediaDB.close();
  }
});
