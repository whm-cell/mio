import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readAuthConfig } from '../../src/auth/config.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import { createAuthHandler } from '../../src/auth/http.ts';
import { hashAdminPassword } from '../../src/auth/admin-password.ts';
import { readAdminConfig } from '../../src/admin/config.ts';
import { createAdminHandler } from '../../src/admin/http.ts';
import { createAdminService } from '../../src/admin/service.ts';
import { createAdminStore } from '../../src/admin/store.ts';
import { adminSchemaSQL } from '../../src/admin/schema.ts';
import { readProviderConfig } from '../../src/providers/config.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { createNotificationHandler } from '../../src/notifications/http.ts';
import { createNotificationService } from '../../src/notifications/service.ts';
import type { Announcement } from '../../src/notifications/contracts.ts';
import { notificationSchemaSQL } from '../../src/notifications/schema.ts';
import { NotificationStore } from '../../src/notifications/store.ts';
import { authDatabase } from '../support/auth-database.ts';

let authDB: Awaited<ReturnType<typeof authDatabase>>;
let noticesDB: Awaited<ReturnType<typeof authDatabase>>;
let adminPool: Pool;
let pool: Pool;
let server: Server;
let origin: string;
let auth: Awaited<ReturnType<typeof createAuthentication>>;
let admin: ReturnType<typeof createAdminService>;
let providers: ReturnType<typeof createProviderService>;
let store: NotificationStore;
let service: ReturnType<typeof createNotificationService>;
let adminCookie: string;
let aCookie: string;
let bCookie: string;
let aId: string;
let bId: string;
const password = 'announcements-password-2468';
const actor = { id: 'bbbbbbbb-1111-4111-8111-111111111111', username: 'fixture-admin' };
const cookie = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');

function call(
  path: string,
  method = 'GET',
  body?: unknown,
  session = '',
  extra: Record<string, string> = {},
  sendOrigin = true,
) {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(sendOrigin ? { origin } : {}),
      ...(session ? { cookie: session } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  authDB = await authDatabase();
  noticesDB = await authDatabase();
  adminPool = new Pool({ connectionString: authDB.observerURL });
  pool = new Pool({
    connectionString: noticesDB.observerURL,
    application_name: 'u4-notifications-test',
  });
  await adminPool.query(providerSchemaSQL);
  await adminPool.query(adminSchemaSQL);
  await pool.query(notificationSchemaSQL);
  server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  origin = `http://127.0.0.1:${address.port}`;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    MIO_AUTH_DATABASE_URL: authDB.url,
    MIO_AUTH_BASE_URL: origin,
    MIO_AUTH_SECRET: randomBytes(32).toString('hex'),
    MIO_PROVIDERS_DATABASE_URL: authDB.url,
    MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
    MIO_PROVIDERS_MASTER_KEY_ID: 'u4-test',
    MIO_ADMIN_ENABLED: 'true',
  };
  const migration = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(migration.status, migration.stderr).toBe(0);
  const config = readAuthConfig(env)!;
  auth = await createAuthentication(config);
  const providerConfig = readProviderConfig(env)!;
  providers = createProviderService(await createProviderStore(providerConfig), providerConfig);
  const adminConfig = readAdminConfig(env, config.origins)!;
  const adminStore = await createAdminStore(adminConfig);
  await adminStore.bootstrapSuperAdmin('announcer', await hashAdminPassword(password));
  admin = createAdminService(adminStore, providers, providerConfig);
  const authHttp = createAuthHandler(config, auth);
  server.on('request', (req, res) => {
    if (req.url?.startsWith('/api/auth')) void authHttp(req, res);
    else if (req.url?.startsWith('/api/v1/admin'))
      void createAdminHandler(admin, config.origins, undefined, service)(req, res);
    else void createNotificationHandler(service, auth.identity, config.origins)(req, res);
  });
  for (const who of ['a', 'b']) {
    const signup = await call('/api/auth/sign-up/email', 'POST', {
      email: `${who}@announcements.test`,
      password,
      name: who,
    });
    expect(signup.status).toBe(200);
    const view = await signup.json();
    if (who === 'a') {
      aCookie = cookie(signup);
      aId = view.user.id;
    } else {
      bCookie = cookie(signup);
      bId = view.user.id;
    }
  }
  const login = await call('/api/v1/admin/auth/login', 'POST', { username: 'announcer', password });
  expect(login.status).toBe(200);
  adminCookie = cookie(login);
}, 30000);

beforeEach(async () => {
  vi.restoreAllMocks();
  await pool.query('TRUNCATE mio_announcements CASCADE');
  await adminPool.query("DELETE FROM mio_admin_audit_logs WHERE action LIKE 'announcement.%'");
  store = new NotificationStore(pool);
  service = createNotificationService(store, (who, action, id) =>
    admin.recordAnnouncementOperation(who, action, id),
  );
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections();
    });
  await service?.close();
  await admin?.close();
  await providers?.close();
  await auth?.close();
  await adminPool?.end();
  await noticesDB?.close();
  await authDB?.close();
});

async function draft(title = 'Notice', extra: Record<string, unknown> = {}) {
  const response = await call(
    '/api/v1/admin/announcements',
    'POST',
    { title, body: `Body: ${title}`, popup: true, ...extra },
    adminCookie,
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()).announcement as Announcement;
}

async function publish(title = 'Notice', extra: Record<string, unknown> = {}) {
  const row = await draft(title, extra);
  const response = await call(
    `/api/v1/admin/announcements/${row.id}/publish`,
    'POST',
    {},
    adminCookie,
  );
  expect(response.status).toBe(200);
  return (await response.json()).announcement as Announcement;
}

it('hides drafts, future, disabled and unpublished notices; lists non-popup notices', async () => {
  const hidden = await draft('Draft');
  await publish('Future', { effectiveAt: '2099-01-01T00:00:00.000Z' });
  await publish('Disabled', { enabled: false });
  const withdrawn = await publish('Withdrawn');
  expect(
    (await call(`/api/v1/admin/announcements/${withdrawn.id}/unpublish`, 'POST', {}, adminCookie))
      .status,
  ).toBe(200);
  const visible = await publish('Visible', { popup: false });
  for (const session of [aCookie, bCookie]) {
    const result = await (await call('/api/v1/announcements', 'GET', undefined, session)).json();
    expect(result).toEqual({
      items: [
        {
          id: visible.id,
          title: 'Visible',
          body: 'Body: Visible',
          publishedAt: visible.publishedAt,
          isRead: false,
        },
      ],
      page: 1,
      pageSize: 10,
      hasMore: false,
    });
    expect(
      await (await call('/api/v1/announcements/latest-popup', 'GET', undefined, session)).json(),
    ).toEqual({ announcement: null });
    expect(
      (await call(`/api/v1/announcements/${hidden.id}/read`, 'POST', {}, session)).status,
    ).toBe(404);
  }
  const list = await (
    await call('/api/v1/admin/announcements', 'GET', undefined, adminCookie)
  ).json();
  expect(list.items).toHaveLength(5);
  expect(
    (
      await (
        await call(`/api/v1/admin/announcements/${hidden.id}`, 'GET', undefined, adminCookie)
      ).json()
    ).announcement.status,
  ).toBe('draft');
});

it('keeps A/B receipts separate and persistent after signout, login and service recreation; never falls back to older unread', async () => {
  const older = await publish('Older');
  const newest = await publish('Newest');
  for (const session of [aCookie, bCookie])
    expect(
      (await (await call('/api/v1/announcements/latest-popup', 'GET', undefined, session)).json())
        .announcement.id,
    ).toBe(newest.id);
  for (let i = 0; i < 2; i++)
    expect(
      (await call(`/api/v1/announcements/${newest.id}/read`, 'POST', {}, aCookie)).status,
    ).toBe(200);
  expect(
    (await pool.query('SELECT user_id,announcement_id FROM mio_announcement_reads')).rows,
  ).toEqual([{ user_id: aId, announcement_id: newest.id }]);
  expect((await call('/api/auth/sign-out', 'POST', {}, aCookie)).status).toBe(200);
  expect((await call('/api/v1/announcements', 'GET', undefined, aCookie)).status).toBe(401);
  const login = await call('/api/auth/sign-in/email', 'POST', {
    email: 'a@announcements.test',
    password,
  });
  expect(login.status).toBe(200);
  aCookie = cookie(login);
  service = createNotificationService(new NotificationStore(pool), (who, action, id) =>
    admin.recordAnnouncementOperation(who, action, id),
  );
  expect(
    await (await call('/api/v1/announcements/latest-popup', 'GET', undefined, aCookie)).json(),
  ).toEqual({ announcement: null });
  expect(
    (await (await call('/api/v1/announcements/latest-popup', 'GET', undefined, bCookie)).json())
      .announcement.id,
  ).toBe(newest.id);
  expect((await service.list(aId, 1, 10)).items.map((x) => [x.id, x.isRead])).toEqual([
    [newest.id, true],
    [older.id, false],
  ]);
  expect(
    (await call(`/api/v1/announcements/${older.id}/read`, 'POST', { userId: bId }, aCookie)).status,
  ).toBe(400);
});

it('orders timestamp ties by descending ID and paginates without exposing drafts or internal fields', async () => {
  const rows = await Promise.all(['One', 'Two', 'Three'].map((title) => publish(title)));
  await pool.query("UPDATE mio_announcements SET published_at='2026-01-01T00:00:00Z'");
  const sorted = rows
    .map((x) => x.id)
    .sort()
    .reverse();
  for (const [page, ids, hasMore] of [
    [1, sorted.slice(0, 2), true],
    [2, sorted.slice(2), false],
  ] as const) {
    const response = await call(
      `/api/v1/announcements?page=${page}&pageSize=2`,
      'GET',
      undefined,
      aCookie,
    );
    const result = await response.json();
    expect(result.items.map((x: { id: string }) => x.id)).toEqual(ids);
    expect(result).toMatchObject({ page, pageSize: 2, hasMore });
    expect(Object.keys(result.items[0]).sort()).toEqual([
      'body',
      'id',
      'isRead',
      'publishedAt',
      'title',
    ]);
  }
  for (const query of ['page=0', 'pageSize=101', 'page=1&page=2', 'page=1.5', 'userId=other'])
    expect((await call(`/api/v1/announcements?${query}`, 'GET', undefined, aCookie)).status).toBe(
      400,
    );
});

it('requires actual isolated admin/user sessions and exact Origin on every mutation including DELETE', async () => {
  const item = await publish();
  for (const session of ['', aCookie, 'mio.admin_session=invalid', 'mio.session_token=invalid']) {
    expect(
      (
        await call('/api/v1/admin/announcements', 'GET', undefined, session, {
          authorization: 'Bearer deployment-token',
        })
      ).status,
    ).toBe(401);
    expect(
      (await call('/api/v1/admin/announcements', 'POST', { title: 'Attempt', body: 'No' }, session))
        .status,
    ).toBe(401);
  }
  for (const session of ['', adminCookie])
    expect(
      (
        await call('/api/v1/announcements', 'GET', undefined, session, {
          authorization: 'Bearer deployment-token',
        })
      ).status,
    ).toBe(401);
  for (const [path, method, body] of [
    ['/api/v1/admin/announcements', 'POST', { title: 'Attempt', body: 'No' }],
    [`/api/v1/admin/announcements/${item.id}`, 'PATCH', { enabled: false }],
    [`/api/v1/admin/announcements/${item.id}/publish`, 'POST', {}],
    [`/api/v1/admin/announcements/${item.id}/unpublish`, 'POST', {}],
    [`/api/v1/admin/announcements/${item.id}`, 'DELETE', undefined],
    [`/api/v1/announcements/${item.id}/read`, 'POST', {}],
  ] as const) {
    const session = path.includes('/admin/') ? adminCookie : aCookie;
    expect((await call(path, method, body, session, {}, false)).status).toBe(403);
    expect((await call(path, method, body, session, { origin: `${origin}/` })).status).toBe(403);
  }
  const preflight = await call(`/api/v1/admin/announcements/${item.id}`, 'OPTIONS');
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-methods')).toContain('DELETE');
  expect(
    (await call(`/api/v1/admin/announcements/${item.id}`, 'DELETE', undefined, adminCookie)).status,
  ).toBe(200);
});

it('audits real actor and each operation; audit failure prevents writes without changing global auth settings', async () => {
  const row = await draft();
  expect(
    (await call(`/api/v1/admin/announcements/${row.id}`, 'PATCH', { title: 'Edited' }, adminCookie))
      .status,
  ).toBe(200);
  for (const action of ['publish', 'unpublish'])
    expect(
      (await call(`/api/v1/admin/announcements/${row.id}/${action}`, 'POST', {}, adminCookie))
        .status,
    ).toBe(200);
  expect(
    (await call(`/api/v1/admin/announcements/${row.id}`, 'DELETE', undefined, adminCookie)).status,
  ).toBe(200);
  const records = (
    await adminPool.query(
      'SELECT actor_id,actor_name,action,target_id,summary FROM mio_admin_audit_logs WHERE target_id=$1 ORDER BY created_at,id',
      [row.id],
    )
  ).rows;
  expect(records.map((x) => x.action).sort()).toEqual(
    [
      'announcement.create',
      'announcement.update',
      'announcement.publish',
      'announcement.unpublish',
      'announcement.delete',
    ].sort(),
  );
  const account = (
    await adminPool.query("SELECT id FROM mio_admin_accounts WHERE username='announcer'")
  ).rows[0]!;
  for (const record of records)
    expect(record).toMatchObject({
      actor_id: account.id,
      actor_name: 'announcer',
      target_id: row.id,
    });
  const audit = vi
    .spyOn(admin, 'recordAnnouncementOperation')
    .mockRejectedValueOnce(new Error('audit unavailable'));
  expect(
    (
      await call(
        '/api/v1/admin/announcements',
        'POST',
        { title: 'Rejected', body: 'Body' },
        adminCookie,
      )
    ).status,
  ).toBe(503);
  expect(
    (await pool.query('SELECT count(*)::int AS count FROM mio_announcements')).rows[0]?.count,
  ).toBe(0);
  audit.mockRestore();
  expect(
    (await adminPool.query('SELECT setting_key FROM mio_admin_global_settings')).rows.every(
      (x) => x.setting_key === 'auth',
    ),
  ).toBe(true);
});

it('does zero warm-negative queries and exactly one warm-positive receipt PK query; coalesces cold fills', async () => {
  const query = vi.spyOn(pool, 'query');
  await service.latestPopup(aId);
  query.mockClear();
  await Promise.all(Array.from({ length: 12 }, () => service.latestPopup(aId)));
  expect(query).not.toHaveBeenCalled();
  const item = await publish();
  query.mockClear();
  await Promise.all(Array.from({ length: 12 }, () => service.latestPopup(aId)));
  expect(
    query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('LEFT JOIN LATERAL'),
    ),
  ).toHaveLength(1);
  query.mockClear();
  await service.latestPopup(aId);
  expect(query).toHaveBeenCalledExactlyOnceWith(
    'SELECT 1 FROM mio_announcement_reads WHERE user_id=$1 AND announcement_id=$2',
    [aId, item.id],
  );
  expect(
    (await call(`/api/v1/admin/announcements/${item.id}`, 'PATCH', { enabled: false }, adminCookie))
      .status,
  ).toBe(200);
  expect(await service.latestPopup(bId)).toBeNull();
  query.mockClear();
  expect(await service.latestPopup(aId)).toBeNull();
  expect(query).not.toHaveBeenCalled();
});

it('never installs an older in-flight cache fill after publish and rechecks reads when delete races a receipt lookup', async () => {
  const loaded = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const original = store.latestPopupMetadata.bind(store);
  vi.spyOn(store, 'latestPopupMetadata').mockImplementationOnce(async () => {
    const snapshot = await original();
    loaded.resolve();
    await release.promise;
    return snapshot;
  });
  const pending = service.latestPopup(aId);
  await loaded.promise;
  const row = await publish('After fill');
  release.resolve();
  expect((await pending)?.id).toBe(row.id);
  const looked = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const receipt = store.isRead.bind(store);
  vi.spyOn(store, 'isRead').mockImplementationOnce(async (user, id) => {
    const found = await receipt(user, id);
    looked.resolve();
    await resume.promise;
    return found;
  });
  const reading = service.latestPopup(aId);
  await looked.promise;
  await service.change(actor, row.id, 'delete');
  resume.resolve();
  expect(await reading).toBeNull();
});

it('expires the cache at future effectivity and converges other instances within the four second TTL', async () => {
  let now = Date.now();
  const other = createNotificationService(
    new NotificationStore(pool),
    async () => {},
    () => now,
  );
  expect(await other.latestPopup(aId)).toBeNull();
  const visible = await publish('Published elsewhere');
  expect(await other.latestPopup(aId)).toBeNull();
  now += 4001;
  expect((await other.latestPopup(aId))?.id).toBe(visible.id);
  const next = await publish('Scheduled', {
    effectiveAt: new Date(Date.now() + 150).toISOString(),
  });
  let clock = Date.now();
  const timed = createNotificationService(
    new NotificationStore(pool),
    async () => {},
    () => clock,
  );
  expect((await timed.latestPopup(aId))?.id).toBe(visible.id);
  await vi.waitFor(
    async () => {
      clock = Date.now();
      expect((await timed.latestPopup(aId))?.id).toBe(next.id);
    },
    { timeout: 2000 },
  );
});

it('rechecks visible targets under concurrent disable and cascades receipts on delete', async () => {
  const row = await publish();
  const blocker = await pool.connect();
  const applicationName = (await pool.query('SHOW application_name')).rows[0]!
    .application_name as string;
  await blocker.query('BEGIN');
  await blocker.query('UPDATE mio_announcements SET enabled=false WHERE id=$1', [row.id]);
  const reading = service.markRead(aId, row.id).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await vi.waitFor(async () => {
      const waiting = await pool.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%FOR SHARE%'",
        [applicationName],
      );
      expect(waiting.rows[0]?.count).toBe(1);
    });
    await blocker.query('COMMIT');
    expect(await reading).toMatchObject({ code: 'ANNOUNCEMENT_NOT_FOUND' });
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  await service.change(actor, row.id, 'update', { enabled: true });
  await service.markRead(bId, row.id);
  await service.change(actor, row.id, 'delete');
  expect(
    (await pool.query('SELECT count(*)::int AS count FROM mio_announcement_reads')).rows[0]?.count,
  ).toBe(0);
  await expect(service.markRead(aId, row.id)).rejects.toMatchObject({
    code: 'ANNOUNCEMENT_NOT_FOUND',
  });
});
