import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { adminSchemaSQL, checkAdminSchema } from '../../src/admin/schema.ts';
import { createAdminStore } from '../../src/admin/store.ts';
import { createAdminService } from '../../src/admin/service.ts';
import { createAdminHandler } from '../../src/admin/http.ts';
import { createCreationRetentionSnapshot } from '../../src/admin/creation-logs.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { hashAdminPassword } from '../../src/auth/admin-password.ts';

let db: Awaited<ReturnType<typeof authDatabase>>, pool: Pool;
beforeAll(async () => {
  db = await authDatabase();
  pool = new Pool({ connectionString: db.url });
  await pool.query(providerSchemaSQL);
  await pool.query(adminSchemaSQL);
});
afterAll(async () => {
  await pool?.end();
  await db?.close();
});
const actor = { id: 'bbbbbbbb-1111-4111-8111-111111111111', username: 'policy-admin' };

it('upgrades the old auth-only CHECK idempotently without changing auth, creation or storage rows and refuses unmigrated readonly startup', async () => {
  await pool.query(`ALTER TABLE mio_admin_global_settings DROP CONSTRAINT mio_admin_global_settings_setting_key_check;
    ALTER TABLE mio_admin_global_settings ADD CONSTRAINT mio_admin_global_settings_setting_key_check CHECK(setting_key='auth');
    INSERT INTO mio_admin_global_settings(setting_key,value) VALUES('auth','{"emailPasswordEnabled":true,"smsMode":"live","smsBypassCode":null}')`);
  const auth = (await pool.query('SELECT * FROM mio_admin_global_settings')).rows;
  await expect(checkAdminSchema(pool)).rejects.toThrow('migration required');
  await pool.query(adminSchemaSQL);
  await checkAdminSchema(pool);
  expect((await pool.query('SELECT * FROM mio_admin_global_settings')).rows).toEqual(auth);
  await pool.query(
    `INSERT INTO mio_admin_global_settings(setting_key,value) VALUES('storage','{"quota":5}')`,
  );
  const all = (await pool.query('SELECT * FROM mio_admin_global_settings ORDER BY setting_key'))
    .rows;
  await pool.query(adminSchemaSQL);
  expect(
    (await pool.query('SELECT * FROM mio_admin_global_settings ORDER BY setting_key')).rows,
  ).toEqual(all);
  await pool.query("DELETE FROM mio_admin_global_settings WHERE setting_key='auth'");
});

it('saves a single revision/audit atomically, rejects races and refreshes immediately and after restart', async () => {
  const store = await createAdminStore({ databaseURL: db.url, allowedOrigins: [] });
  try {
    expect(store.initialCreationLogSettings).toEqual({ revision: 0, retentionDays: null });
    await pool.query(`CREATE FUNCTION fail_retention_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='settings.creation-logs.update' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_retention_audit BEFORE INSERT ON mio_admin_audit_logs FOR EACH ROW EXECUTE FUNCTION fail_retention_audit()`);
    await expect(
      store.updateCreationLogSettings(
        { ...actor, isSuperAdmin: true, createdAt: '', updatedAt: '' },
        0,
        14,
      ),
    ).rejects.toMatchObject({ status: 503, code: 'ADMIN_UNAVAILABLE' });
    expect(await store.readCreationLogSettings()).toEqual({ revision: 0, retentionDays: null });
    await pool.query(
      'DROP TRIGGER fail_retention_audit ON mio_admin_audit_logs;DROP FUNCTION fail_retention_audit()',
    );
    const results = await Promise.allSettled(
      [14, 7].map((days) =>
        store.updateCreationLogSettings(
          { ...actor, isSuperAdmin: true, createdAt: '', updatedAt: '' },
          0,
          days,
        ),
      ),
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((x) => x.status === 'rejected')).toMatchObject({
      reason: { status: 409, code: 'SETTINGS_CONFLICT' },
    });
    const saved = await store.readCreationLogSettings();
    expect(
      (
        await pool.query(
          "SELECT * FROM mio_admin_audit_logs WHERE action='settings.creation-logs.update'",
        )
      ).rows,
    ).toMatchObject([
      {
        actor_id: actor.id,
        before_state: { revision: 0, retentionDays: null },
        after_state: saved,
      },
    ]);
    const restart = await createAdminStore({ databaseURL: db.url, allowedOrigins: [] });
    expect(restart.initialCreationLogSettings).toEqual(saved);
    await restart.close();
  } finally {
    await store.close();
  }
});

it('uses fresh synchronous snapshots, converges within five seconds, fails closed on expiry and drains refresh before close', async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => ({ revision: 1, retentionDays: 14 }));
  const snapshot = createCreationRetentionSnapshot({
    initialCreationLogSettings: { revision: 0, retentionDays: null },
    readCreationLogSettings: read,
  });
  try {
    expect(snapshot.get()).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(snapshot.get()).toBe(14);
    read.mockRejectedValue(new Error('admin offline'));
    snapshot.save({ revision: 2, retentionDays: 7 });
    expect(snapshot.get()).toBe(7);
    await vi.advanceTimersByTimeAsync(5000);
    expect(() => snapshot.get()).toThrow('CREATION_LOG_POLICY_UNAVAILABLE');
    read.mockResolvedValue({ revision: 3, retentionDays: 21 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(snapshot.get()).toBe(21);
    const pending = Promise.withResolvers<{ revision: number; retentionDays: number }>();
    read.mockImplementation(() => pending.promise);
    await vi.advanceTimersByTimeAsync(1000);
    const done = vi.fn();
    const closing = snapshot.close().then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    pending.resolve({ revision: 4, retentionDays: 28 });
    await closing;
    expect(() => snapshot.get()).toThrow('CREATION_LOG_POLICY_UNAVAILABLE');
  } finally {
    await snapshot.close();
    vi.useRealTimers();
  }
});

it('enforces admin cookie and exact Origin, validates positive integer days and keeps global auth-only', async () => {
  const config = {
    databaseURL: db.url,
    masterKey: randomBytes(32),
    masterKeyId: 'retention-fixture',
  };
  const providers = createProviderService(await createProviderStore(config), config);
  const adminStore = await createAdminStore({ databaseURL: db.url, allowedOrigins: [] });
  await adminStore.bootstrapSuperAdmin(
    'policy-admin',
    await hashAdminPassword('fixture-password-123'),
  );
  const admin = createAdminService(adminStore, providers, config);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error();
  const origin = `http://127.0.0.1:${addr.port}`;
  const handler = createAdminHandler(admin, [origin]);
  const request = (
    path: string,
    method = 'GET',
    body?: unknown,
    session = '',
    o: string | undefined = origin,
  ) =>
    fetch(`${origin}/api/v1/admin${path}`, {
      method,
      headers: {
        ...(o ? { origin: o } : {}),
        cookie: session,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  try {
    expect((await request('/settings/creation-logs')).status).toBe(401);
    expect(
      (await request('/settings/creation-logs', 'GET', undefined, 'better-auth.session_token=user'))
        .status,
    ).toBe(401);
    const login = await request('/auth/login', 'POST', {
      username: 'policy-admin',
      password: 'fixture-password-123',
    });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ');
    const current = await (
      await request('/settings/creation-logs', 'GET', undefined, cookie)
    ).json();
    for (const retentionDays of [null, 0, -1, 1.5, '14'])
      expect(
        (
          await request(
            '/settings/creation-logs',
            'PATCH',
            { expectedRevision: current.revision, retentionDays },
            cookie,
          )
        ).status,
      ).toBe(400);
    expect(
      (
        await request(
          '/settings/creation-logs',
          'PATCH',
          { expectedRevision: current.revision, retentionDays: 14 },
          cookie,
          'https://wrong.invalid',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          '/settings/creation-logs',
          'PATCH',
          { expectedRevision: current.revision, retentionDays: 14 },
          cookie,
          '',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          '/settings/global',
          'PATCH',
          {
            expectedRevision: 0,
            auth: { emailPasswordEnabled: true, smsMode: 'live', smsBypassCode: null },
            retentionDays: 14,
          },
          cookie,
        )
      ).status,
    ).toBe(400);
    const saved = await request(
      '/settings/creation-logs',
      'PATCH',
      { expectedRevision: current.revision, retentionDays: 14 },
      cookie,
    );
    expect(saved.status).toBe(200);
    expect(admin.getCreationLogRetentionDays()).toBe(14);
    expect(
      (
        await request(
          '/settings/creation-logs',
          'PATCH',
          { expectedRevision: current.revision, retentionDays: 7 },
          cookie,
        )
      ).status,
    ).toBe(409);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
    await admin.close();
    await providers.close();
  }
});

it('keeps an immediately saved policy when an older in-flight refresh finishes later', async () => {
  const pending = Promise.withResolvers<{ revision: number; retentionDays: number | null }>();
  const snapshot = createCreationRetentionSnapshot({
    initialCreationLogSettings: { revision: 0, retentionDays: null },
    readCreationLogSettings: () => pending.promise,
  });
  const refresh = snapshot.refresh();
  snapshot.save({ revision: 1, retentionDays: 7 });
  pending.resolve({ revision: 0, retentionDays: null });
  expect(await refresh).toEqual({ revision: 1, retentionDays: 7 });
  expect(snapshot.get()).toBe(7);
  await snapshot.close();
});
