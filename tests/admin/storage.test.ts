import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { adminSchemaSQL } from '../../src/admin/schema.ts';
import { createAdminStore } from '../../src/admin/store.ts';
import { createAdminService } from '../../src/admin/service.ts';
import { createAdminHandler } from '../../src/admin/http.ts';
import type { AdminPrincipal } from '../../src/admin/contracts.ts';
import type { StorageSettings } from '../../src/admin/storage.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { hashAdminPassword } from '../../src/auth/admin-password.ts';

let db: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let providers: ReturnType<typeof createProviderService>;
let config: { databaseURL: string; masterKey: Buffer; masterKeyId: string };
const defaults = { revision: 0, quotaBytes: 5_368_709_120, warningAvailableBytes: 1_073_741_824 };
const principal: AdminPrincipal = {
  admin: {
    id: 'bbbbbbbb-1111-4111-8111-111111111111',
    username: 'storage-admin',
    isSuperAdmin: true,
    createdAt: '',
    updatedAt: '',
  },
  sessionId: 'fixture',
  tokenDigest: 'fixture',
};

beforeAll(async () => {
  db = await authDatabase();
  pool = new Pool({ connectionString: db.url });
  await pool.query(providerSchemaSQL);
  await pool.query(adminSchemaSQL);
  config = { databaseURL: db.url, masterKey: randomBytes(32), masterKeyId: 'storage-fixture' };
  providers = createProviderService(await createProviderStore(config), config);
  const store = await createAdminStore({ databaseURL: db.url, allowedOrigins: [] });
  try {
    await store.bootstrapSuperAdmin(
      'storage-admin',
      await hashAdminPassword('fixture-password-123'),
    );
  } finally {
    await store.close();
  }
});

beforeEach(async () => {
  await pool.query("DELETE FROM mio_admin_global_settings WHERE setting_key='storage'");
  await pool.query("DELETE FROM mio_admin_audit_logs WHERE action='settings.storage.update'");
});

afterAll(async () => {
  await providers?.close();
  await pool?.end();
  await db?.close();
});

async function openService() {
  const store = await createAdminStore({ databaseURL: db.url, allowedOrigins: [] });
  return { store, service: createAdminService(store, providers, config) };
}

async function storageRows() {
  return (await pool.query("SELECT * FROM mio_admin_global_settings WHERE setting_key='storage'"))
    .rows;
}

async function audits() {
  return (
    await pool.query(
      "SELECT * FROM mio_admin_audit_logs WHERE action='settings.storage.update' ORDER BY created_at,id",
    )
  ).rows;
}

it('reads defaults without writes alongside pre-storage auth/retention rows', async () => {
  await pool.query(`INSERT INTO mio_admin_global_settings(setting_key,value,revision,updated_by)
    VALUES('auth','{"emailPasswordEnabled":false,"smsMode":"disabled","smsBypassCode":null}',7,'old-admin'),
          ('creation_logs','{"retentionDays":14}',3,'old-admin')`);
  const previous = (
    await pool.query('SELECT * FROM mio_admin_global_settings ORDER BY setting_key')
  ).rows;
  const { store, service } = await openService();
  try {
    expect(store.initialStorageSettings).toEqual(defaults);
    expect(service.getStoragePolicy()).toEqual(defaults);
    expect(await service.getStorageSettings()).toEqual(defaults);
    expect(await storageRows()).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(
      (await pool.query('SELECT * FROM mio_admin_global_settings ORDER BY setting_key')).rows,
    ).toEqual(previous);
  } finally {
    await service.close();
    await pool.query(
      "DELETE FROM mio_admin_global_settings WHERE setting_key IN ('auth','creation_logs')",
    );
  }
});

it('merges either field, validates the merged pair, persists bytes, and refreshes locally and after restart', async () => {
  const { service } = await openService();
  try {
    expect(
      await service.updateStorageSettings(principal, {
        expectedRevision: 0,
        quotaBytes: 8_589_934_592,
      }),
    ).toEqual({ ...defaults, revision: 1, quotaBytes: 8_589_934_592 });
    expect(service.getStoragePolicy()).toEqual({
      ...defaults,
      revision: 1,
      quotaBytes: 8_589_934_592,
    });
    expect(
      await service.updateStorageSettings(principal, {
        expectedRevision: 1,
        warningAvailableBytes: 2_147_483_648,
      }),
    ).toEqual({ revision: 2, quotaBytes: 8_589_934_592, warningAvailableBytes: 2_147_483_648 });
    await expect(
      service.updateStorageSettings(principal, { expectedRevision: 2, quotaBytes: 2_147_483_648 }),
    ).rejects.toMatchObject({ status: 400, code: 'ADMIN_INPUT_INVALID' });
    await expect(
      service.updateStorageSettings(principal, {
        expectedRevision: 2,
        warningAvailableBytes: 8_589_934_592,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'ADMIN_INPUT_INVALID' });
    expect(
      await service.updateStorageSettings(principal, {
        expectedRevision: 2,
        quotaBytes: 2,
        warningAvailableBytes: 1,
      }),
    ).toEqual({ revision: 3, quotaBytes: 2, warningAvailableBytes: 1 });
    expect(await storageRows()).toMatchObject([
      {
        value: { quotaBytes: 2, warningAvailableBytes: 1 },
        revision: 3,
        updated_by: principal.admin.username,
      },
    ]);
    const restarted = await openService();
    try {
      expect(restarted.service.getStoragePolicy()).toEqual({
        revision: 3,
        quotaBytes: 2,
        warningAvailableBytes: 1,
      });
      expect(await restarted.service.getStorageSettings()).toEqual({
        revision: 3,
        quotaBytes: 2,
        warningAvailableBytes: 1,
      });
    } finally {
      await restarted.service.close();
    }
    expect(await audits()).toMatchObject([
      {
        actor_id: principal.admin.id,
        actor_name: principal.admin.username,
        target_id: 'storage',
        before_state: defaults,
        after_state: { ...defaults, revision: 1, quotaBytes: 8_589_934_592 },
      },
      {
        before_state: { ...defaults, revision: 1, quotaBytes: 8_589_934_592 },
        after_state: {
          revision: 2,
          quotaBytes: 8_589_934_592,
          warningAvailableBytes: 2_147_483_648,
        },
      },
      {
        before_state: {
          revision: 2,
          quotaBytes: 8_589_934_592,
          warningAvailableBytes: 2_147_483_648,
        },
        after_state: { revision: 3, quotaBytes: 2, warningAvailableBytes: 1 },
      },
    ]);
  } finally {
    await service.close();
  }
});

it('keeps defaults and saved same-value requests unchanged while rejecting stale no-ops', async () => {
  const { service } = await openService();
  try {
    expect(
      await service.updateStorageSettings(principal, {
        expectedRevision: 0,
        quotaBytes: defaults.quotaBytes,
      }),
    ).toEqual(defaults);
    expect(await storageRows()).toEqual([]);
    expect(await audits()).toEqual([]);
    const saved = await service.updateStorageSettings(principal, {
      expectedRevision: 0,
      quotaBytes: 8_589_934_592,
    });
    const rows = await storageRows();
    for (const fields of [
      { quotaBytes: 8_589_934_592 },
      { warningAvailableBytes: defaults.warningAvailableBytes },
      { quotaBytes: 8_589_934_592, warningAvailableBytes: defaults.warningAvailableBytes },
    ])
      expect(
        await service.updateStorageSettings(principal, { expectedRevision: 1, ...fields }),
      ).toEqual(saved);
    expect(await storageRows()).toEqual(rows);
    expect(await audits()).toHaveLength(1);
    await expect(
      service.updateStorageSettings(principal, { expectedRevision: 0, quotaBytes: 8_589_934_592 }),
    ).rejects.toMatchObject({ status: 409, code: 'SETTINGS_CONFLICT' });
  } finally {
    await service.close();
  }
});

it('starts the saved-policy freshness window after a delayed transaction completes and rejects older refreshes', async () => {
  const { store, service } = await openService();
  const locker = await pool.connect();
  const previous = { ...defaults, revision: 1, quotaBytes: 8_589_934_592 };
  const delayedRead = Promise.withResolvers<StorageSettings>();
  const read = vi.spyOn(store, 'readStorageSettings').mockImplementation(() => delayedRead.promise);
  let locked = false;
  let refresh: Promise<StorageSettings> | undefined;
  let saving: Promise<StorageSettings> | undefined;
  try {
    expect(
      await service.updateStorageSettings(principal, {
        expectedRevision: 0,
        quotaBytes: previous.quotaBytes,
      }),
    ).toEqual(previous);
    await locker.query('BEGIN');
    locked = true;
    await locker.query(
      "SELECT 1 FROM mio_admin_global_settings WHERE setting_key='storage' FOR UPDATE",
    );
    const pid = (await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    // Advance policy time without changing the real PostgreSQL/query timeout clocks.
    vi.useFakeTimers({ toFake: ['Date'] });
    refresh = service.getStorageSettings();
    saving = service.updateStorageSettings(principal, {
      expectedRevision: 1,
      quotaBytes: 9_663_676_416,
    });
    let waiting = false;
    for (let attempt = 0; attempt < 20 && !waiting; attempt++) {
      waiting = (
        await pool.query<{ waiting: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting',
          [pid],
        )
      ).rows[0]!.waiting;
    }
    expect(waiting).toBe(true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(() => service.getStoragePolicy()).toThrow('STORAGE_POLICY_UNAVAILABLE');
    await locker.query('COMMIT');
    locked = false;
    const saved = { ...defaults, revision: 2, quotaBytes: 9_663_676_416 };
    expect(await saving).toEqual(saved);
    expect(service.getStoragePolicy()).toEqual(saved);
    expect(await storageRows()).toMatchObject([
      {
        revision: 2,
        value: { quotaBytes: saved.quotaBytes, warningAvailableBytes: saved.warningAvailableBytes },
      },
    ]);
    await vi.advanceTimersByTimeAsync(4000);
    delayedRead.resolve(previous);
    expect(await refresh).toEqual(saved);
    expect(service.getStoragePolicy()).toEqual(saved);
    read.mockRejectedValue(new Error('admin offline'));
    await expect(service.getStorageSettings()).rejects.toThrow('admin offline');
    await vi.advanceTimersByTimeAsync(999);
    expect(service.getStoragePolicy()).toEqual(saved);
    await vi.advanceTimersByTimeAsync(1);
    expect(() => service.getStoragePolicy()).toThrow('STORAGE_POLICY_UNAVAILABLE');
  } finally {
    if (locked) await locker.query('ROLLBACK');
    locker.release();
    delayedRead.resolve(previous);
    await Promise.allSettled([...(saving ? [saving] : []), ...(refresh ? [refresh] : [])]);
    read.mockRestore();
    vi.useRealTimers();
    await service.close();
  }
});

it('serializes first inserts and row updates: only one writer of a revision succeeds and is audited', async () => {
  const { service } = await openService();
  const other = await openService();
  try {
    for (const revision of [0, 1]) {
      const results = await Promise.allSettled([
        service.updateStorageSettings(principal, {
          expectedRevision: revision,
          quotaBytes: (8 + revision) * 1_073_741_824,
        }),
        other.service.updateStorageSettings(principal, {
          expectedRevision: revision,
          quotaBytes: (10 + revision) * 1_073_741_824,
        }),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((x) => x.status === 'rejected')).toMatchObject({
        reason: { status: 409, code: 'SETTINGS_CONFLICT' },
      });
      const winner = results.find((x) => x.status === 'fulfilled');
      if (winner?.status !== 'fulfilled') throw new Error('missing winning result');
      expect(await service.getStorageSettings()).toEqual(winner.value);
      expect(await audits()).toHaveLength(revision + 1);
    }
  } finally {
    await service.close();
    await other.service.close();
  }
});

it('rolls back config on audit failure for both insert and update and never publishes a failed save', async () => {
  const { service } = await openService();
  const failAudit = () =>
    pool.query(`CREATE FUNCTION fail_storage_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='settings.storage.update' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_storage_audit BEFORE INSERT ON mio_admin_audit_logs FOR EACH ROW EXECUTE FUNCTION fail_storage_audit()`);
  const restoreAudit = () =>
    pool.query(
      'DROP TRIGGER IF EXISTS fail_storage_audit ON mio_admin_audit_logs; DROP FUNCTION IF EXISTS fail_storage_audit()',
    );
  try {
    await failAudit();
    await expect(
      service.updateStorageSettings(principal, { expectedRevision: 0, quotaBytes: 8_589_934_592 }),
    ).rejects.toMatchObject({ status: 503, code: 'ADMIN_UNAVAILABLE' });
    expect(await storageRows()).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(service.getStoragePolicy()).toEqual(defaults);
    await restoreAudit();
    const saved = await service.updateStorageSettings(principal, {
      expectedRevision: 0,
      quotaBytes: 8_589_934_592,
    });
    const rows = await storageRows();
    await failAudit();
    await expect(
      service.updateStorageSettings(principal, { expectedRevision: 1, warningAvailableBytes: 2 }),
    ).rejects.toMatchObject({ status: 503, code: 'ADMIN_UNAVAILABLE' });
    expect(await storageRows()).toEqual(rows);
    expect(await audits()).toHaveLength(1);
    expect(service.getStoragePolicy()).toEqual(saved);
  } finally {
    await restoreAudit();
    await service.close();
  }
});

it('fails startup on malformed persisted storage instead of resetting to defaults', async () => {
  await pool.query(
    "INSERT INTO mio_admin_global_settings(setting_key,value) VALUES('storage','{\"quotaBytes\":5}')",
  );
  await expect(openService()).rejects.toThrow('ADMIN_SCHEMA: invalid storage settings');
  expect(await storageRows()).toMatchObject([{ value: { quotaBytes: 5 }, revision: 1 }]);
});

async function openHttp() {
  const { service } = await openService();
  const origin = 'https://admin.storage.test';
  const handler = createAdminHandler(service, [origin]);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test listener');
  const base = `http://127.0.0.1:${address.port}/api/v1/admin`;
  const request = (
    path: string,
    method = 'GET',
    body?: unknown,
    cookie = '',
    requestOrigin: string | null = origin,
    extraHeaders: Record<string, string> = {},
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(requestOrigin ? { origin: requestOrigin } : {}),
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = await request('/auth/login', 'POST', {
    username: 'storage-admin',
    password: 'fixture-password-123',
  });
  expect(login.status).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  return {
    service,
    request,
    base,
    origin,
    cookie,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.close();
    },
  };
}

it('exposes exact JSON under admin-only auth, CORS/Origin, query, body and optimistic-version guards', async () => {
  const http = await openHttp();
  const patch = { expectedRevision: 0, quotaBytes: 8_589_934_592 };
  try {
    for (const cookie of ['', 'better-auth.session_token=ordinary-user']) {
      expect((await http.request('/settings/storage', 'GET', undefined, cookie)).status).toBe(401);
      expect((await http.request('/settings/storage', 'PATCH', patch, cookie)).status).toBe(401);
    }
    expect(
      (
        await http.request('/settings/storage', 'GET', undefined, '', http.origin, {
          authorization: 'Bearer fixture-service-token',
        })
      ).status,
    ).toBe(401);
    const initial = await http.request('/settings/storage', 'GET', undefined, http.cookie, null);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual(defaults);
    expect(initial.headers.get('cache-control')).toBe('no-store');
    expect(initial.headers.get('x-content-type-options')).toBe('nosniff');
    expect(initial.headers.get('x-request-id')).toBeTruthy();
    for (const origin of [null, `${http.origin}/`, 'https://other.invalid'])
      expect(
        (await http.request('/settings/storage', 'PATCH', patch, http.cookie, origin)).status,
      ).toBe(403);
    expect(
      (
        await http.request(
          '/settings/storage',
          'GET',
          undefined,
          http.cookie,
          'https://other.invalid',
        )
      ).status,
    ).toBe(403);
    const preflight = await http.request('/settings/storage', 'OPTIONS');
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, PATCH, OPTIONS');
    expect(preflight.headers.get('access-control-allow-origin')).toBe(http.origin);
    expect((await http.request('/settings/storage', 'PUT', patch, http.cookie)).status).toBe(405);
    expect(
      (await http.request('/settings/storage?extra=1', 'GET', undefined, http.cookie)).status,
    ).toBe(400);
    expect(
      (await http.request('/settings/storage?extra=1', 'PATCH', patch, http.cookie)).status,
    ).toBe(400);
    expect(
      (
        await http.request('/settings/storage', 'PATCH', patch, http.cookie, http.origin, {
          'content-type': 'text/plain',
        })
      ).status,
    ).toBe(415);
    const invalid = [
      {},
      { expectedRevision: 0 },
      { quotaBytes: 8_589_934_592 },
      ...[null, -1, 0.5, '0', 2_147_483_648, Number.MAX_SAFE_INTEGER + 1].map(
        (expectedRevision) => ({ ...patch, expectedRevision }),
      ),
      ...[null, 0, -1, 1.5, '8', Number.MAX_SAFE_INTEGER + 1].flatMap((value) => [
        { expectedRevision: 0, quotaBytes: value },
        { expectedRevision: 0, warningAvailableBytes: value },
      ]),
      { expectedRevision: 0, warningAvailableBytes: defaults.quotaBytes },
      { expectedRevision: 0, quotaBytes: defaults.warningAvailableBytes },
      { ...patch, extra: true },
      { ...patch, reservedBytes: 0 },
      { ...patch, writeBlocked: false },
    ];
    for (const input of invalid) {
      const response = await http.request('/settings/storage', 'PATCH', input, http.cookie);
      expect(response.status, JSON.stringify(input)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'ADMIN_INPUT_INVALID' } });
    }
    expect(await storageRows()).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(
      (
        await http.request(
          '/settings/global',
          'PATCH',
          { ...patch, auth: { emailPasswordEnabled: true, smsMode: 'live', smsBypassCode: null } },
          http.cookie,
        )
      ).status,
    ).toBe(400);
    const saved = await http.request('/settings/storage', 'PATCH', patch, http.cookie);
    expect(saved.status).toBe(200);
    const settings = { ...defaults, revision: 1, quotaBytes: 8_589_934_592 };
    expect(await saved.json()).toEqual(settings);
    expect(http.service.getStoragePolicy()).toEqual(settings);
    expect(
      await (await http.request('/settings/storage', 'GET', undefined, http.cookie)).json(),
    ).toEqual(settings);
    const noOp = await http.request(
      '/settings/storage',
      'PATCH',
      { expectedRevision: 1, warningAvailableBytes: defaults.warningAvailableBytes },
      http.cookie,
    );
    expect(noOp.status).toBe(200);
    expect(await noOp.json()).toEqual(settings);
    const conflict = await http.request('/settings/storage', 'PATCH', patch, http.cookie);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'SETTINGS_CONFLICT' } });
    const identity = await (await http.request('/auth/me', 'GET', undefined, http.cookie)).json();
    expect(await audits()).toMatchObject([
      {
        actor_id: identity.admin.id,
        actor_name: 'storage-admin',
        before_state: defaults,
        after_state: settings,
      },
    ]);
  } finally {
    await http.close();
  }
});

it('rechecks the real administrator session after the request body finishes', async () => {
  const http = await openHttp();
  const authenticated = Promise.withResolvers<void>();
  const authenticate = http.service.authenticate;
  const spy = vi.spyOn(http.service, 'authenticate').mockImplementation(async (token) => {
    const result = await authenticate(token);
    authenticated.resolve();
    return result;
  });
  try {
    const body = JSON.stringify({ expectedRevision: 0, quotaBytes: 8_589_934_592 });
    const response = Promise.withResolvers<{ status: number; body: string }>();
    const request = httpRequest(
      `${http.base}/settings/storage`,
      {
        method: 'PATCH',
        headers: {
          origin: http.origin,
          cookie: http.cookie,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => response.resolve({ status: res.statusCode!, body: text }));
      },
    );
    request.on('error', response.reject);
    request.write(body.slice(0, 10));
    await authenticated.promise;
    await pool.query('DELETE FROM mio_admin_sessions');
    request.end(body.slice(10));
    const result = await response.promise;
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body)).toMatchObject({ error: { code: 'ADMIN_UNAUTHORIZED' } });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await storageRows()).toEqual([]);
    expect(await audits()).toEqual([]);
  } finally {
    spy.mockRestore();
    await http.close();
  }
});
