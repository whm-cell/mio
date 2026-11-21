import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { authOptions, readAuthConfig } from '../../src/auth/config.ts';
import { createAuthHandler } from '../../src/auth/http.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import type { Authentication } from '../../src/auth/service.ts';
import { pollWechatQR } from '../../src/auth/wechat-qr-store.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { ProviderStore } from '../../src/providers/store.ts';
import { authDatabase } from '../support/auth-database.ts';

const secret = randomBytes(40).toString('hex');
const password = 'correct-horse-wechat-test-19';
const appId = 'fixture-app';
const originalFetch = globalThis.fetch;
const origins: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const auths: Awaited<ReturnType<typeof createAuthentication>>[] = [];
let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let fixtures = new Map<string, { openid: string; unionid?: string }>();
let exchanges = 0;
let holdExchange: Promise<void> | undefined;
let exchangeStarted: (() => void) | undefined;

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .join('; ');

function call(
  path: string,
  options: {
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
    instance?: number;
    origin?: boolean;
  } = {},
) {
  return originalFetch(`${origins[options.instance ?? 0]}${path}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    redirect: 'manual',
    headers: {
      ...(options.origin === false ? {} : { origin: origins[0]! }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function emailUser() {
  const response = await call('/api/auth/sign-up/email', {
    body: { name: 'Owner', email: `${randomUUID()}@example.test`, password },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return cookies(response);
}

async function identity(cookie: string) {
  const response = await call('/api/v1/me', { cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as { userId: string; sessionId: string };
}

async function start(
  path: '/sign-in/social' | '/link-social',
  cookie?: string,
  body: { provider: 'wechat'; callbackURL?: string } = { provider: 'wechat', callbackURL: '/done' },
) {
  const response = await call(`/api/auth${path}`, {
    body,
    ...(cookie ? { cookie } : {}),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const result = (await response.json()) as { url: string };
  const state = new URL(result.url).searchParams.get('state');
  expect(state).toBeTruthy();
  return { state: state!, cookie: cookies(response) };
}

function callback(
  flow: { state: string; cookie: string },
  code: string,
  session?: string,
  instance = 0,
) {
  const query = new URLSearchParams({ state: flow.state, code });
  return call(`/api/auth/callback/wechat?${query}`, {
    cookie: [flow.cookie, session].filter(Boolean).join('; '),
    instance,
    origin: false,
  });
}

beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  for (let index = 0; index < 2; index++) {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    origins.push(`http://127.0.0.1:${address.port}`);
    servers.push(server);
  }
  const config = readAuthConfig({
    MIO_AUTH_BASE_URL: origins[0],
    MIO_AUTH_SECRET: secret,
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_AUTH_WECHAT_ENABLED: 'true',
    MIO_AUTH_WECHAT_APP_ID: appId,
    MIO_AUTH_WECHAT_APP_SECRET: 'fixture-secret',
  })!;
  await (await getMigrations(authOptions(config, pool))).runMigrations();
  await pool.query(providerSchemaSQL);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://api.weixin.qq.com') throw new Error('unexpected outbound request');
    if (url.pathname === '/sns/oauth2/access_token') {
      exchanges++;
      exchangeStarted?.();
      if (holdExchange) await holdExchange;
      const code = url.searchParams.get('code') ?? '';
      const fixture = fixtures.get(code);
      if (!fixture) return Response.json({ errcode: 40029, errmsg: 'private fixture details' });
      return Response.json({
        access_token: `access-${code}`,
        refresh_token: `refresh-${code}`,
        openid: fixture.openid,
        expires_in: 7200,
        scope: 'snsapi_login',
      });
    }
    if (url.pathname === '/sns/userinfo') {
      const code = url.searchParams.get('access_token')?.replace(/^access-/, '') ?? '';
      const fixture = fixtures.get(code);
      if (!fixture) return Response.json({ errcode: 40001 });
      return Response.json({
        ...fixture,
        nickname: '微信用户',
        headimgurl: 'https://image.example.test/avatar',
      });
    }
    throw new Error('unexpected provider path');
  });
  for (const server of servers) {
    const auth = await createAuthentication(config);
    auths.push(auth);
    server.on('request', createAuthHandler(config, auth));
  }
}, 45000);

beforeEach(async () => {
  fixtures = new Map();
  exchanges = 0;
  holdExchange = undefined;
  exchangeStarted = undefined;
  await pool.query(
    'TRUNCATE "account", "session", "user", "verification", "rateLimit", "mioWechatQR" CASCADE',
  );
});

afterAll(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(auths.map((auth) => auth.close()));
  if (pool) await pool.end();
  if (database) await database.close();
}, 30000);

it('rejects incomplete or malformed enabled WeChat configuration', () => {
  expect(() => readAuthConfig({ MIO_AUTH_WECHAT_ENABLED: 'true' })).toThrow('AUTH_CONFIG');
  const base = {
    MIO_AUTH_BASE_URL: origins[0],
    MIO_AUTH_SECRET: secret,
    MIO_AUTH_DATABASE_URL: database.url,
  };
  expect(() => readAuthConfig({ ...base, MIO_AUTH_WECHAT_ENABLED: 'true' })).toThrow('AUTH_CONFIG');
  expect(() => readAuthConfig({ ...base, MIO_AUTH_WECHAT_ENABLED: 'invalid' })).toThrow(
    'AUTH_CONFIG',
  );
  expect(() =>
    readAuthConfig({
      ...base,
      MIO_AUTH_WECHAT_ENABLED: 'true',
      MIO_AUTH_WECHAT_APP_ID: 'bad/app',
      MIO_AUTH_WECHAT_APP_SECRET: 'fixture',
    }),
  ).toThrow('AUTH_CONFIG');
});

it('registers and signs in with a stable AppID/openid despite unionid changes and encrypts tokens', async () => {
  fixtures.set('first', { openid: 'wechat-one' });
  const first = await callback(await start('/sign-in/social'), 'first');
  expect(first.status).toBe(302);
  expect(first.headers.get('location')).toBe(`${origins[0]}/done`);
  const firstIdentity = await identity(cookies(first));
  fixtures.set('second', { openid: 'wechat-one', unionid: 'later-union' });
  const second = await callback(await start('/sign-in/social'), 'second');
  expect(second.status).toBe(302);
  expect((await identity(cookies(second))).userId).toBe(firstIdentity.userId);
  const accounts = await pool.query<{
    accountId: string;
    accessToken: string;
    refreshToken: string;
  }>(
    `SELECT "accountId", "accessToken", "refreshToken" FROM "account" WHERE "providerId" = 'wechat'`,
  );
  expect(accounts.rows).toHaveLength(1);
  expect(accounts.rows[0]!.accountId).toBe(JSON.stringify([appId, 'wechat-one']));
  expect(accounts.rows[0]!.accessToken).not.toContain('access-second');
  expect(accounts.rows[0]!.refreshToken).not.toContain('refresh-second');
  const user = await pool.query<{ email: string; emailVerified: boolean }>(
    'SELECT email, "emailVerified" FROM "user" WHERE id=$1',
    [firstIdentity.userId],
  );
  expect(user.rows[0]!.email).toMatch(/^wechat-[a-f0-9]{56}@auth\.mio\.invalid$/);
  expect(user.rows[0]!.emailVerified).toBe(false);
});

it('binds only the initiating user, retaining real provider resource ownership and rejecting occupation', async () => {
  const owner = await emailUser();
  const other = await emailUser();
  const ownerId = (await identity(owner)).userId;
  const otherId = (await identity(other)).userId;
  const store = new ProviderStore(pool, {
    databaseURL: database.url,
    masterKey: randomBytes(32),
    masterKeyId: 'fixture',
  });
  await store.save(ownerId, 0, 'fixture-provider-key');
  fixtures.set('bind', { openid: 'bound-wechat' });
  const bound = await callback(await start('/link-social', owner), 'bind', owner);
  expect(bound.status).toBe(302);
  expect(bound.headers.get('location')).toBe(`${origins[0]}/done`);
  expect((await identity(owner)).userId).toBe(ownerId);
  expect(await store.get(ownerId)).not.toBeNull();
  expect(await store.get(otherId)).toBeNull();
  fixtures.set('occupied', { openid: 'bound-wechat' });
  const conflict = await callback(await start('/link-social', other), 'occupied', other);
  expect(conflict.headers.get('location')).toContain('account_already_linked_to_different_user');
  const again = await call('/api/auth/link-social', {
    body: { provider: 'wechat' },
    cookie: owner,
  });
  expect(again.status).toBe(400);
  fixtures.set('bound-login', { openid: 'bound-wechat' });
  const login = await callback(await start('/sign-in/social'), 'bound-login');
  expect((await identity(cookies(login))).userId).toBe(ownerId);
});

it('requires the state cookie and reserves state before one concurrent code exchange', async () => {
  fixtures.set('once', { openid: 'once-wechat' });
  const flow = await start('/sign-in/social');
  const path = `/api/auth/callback/wechat?${new URLSearchParams({ state: flow.state, code: 'once' })}`;
  expect((await call(path, { origin: false })).status).toBe(400);
  expect((await callback({ ...flow, state: `${flow.state}bad` }, 'once')).status).toBe(400);
  let release!: () => void;
  holdExchange = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    exchangeStarted = resolve;
  });
  const first = callback(flow, 'once');
  await started;
  const replay = await callback(flow, 'once', undefined, 1);
  release();
  expect(replay.status).toBe(400);
  expect((await first).status).toBe(302);
  expect(exchanges).toBe(1);
  expect((await callback(flow, 'once')).status).toBe(400);
});

it('rejects switched, revoked and stale initiating sessions', async () => {
  const owner = await emailUser();
  const other = await emailUser();
  fixtures.set('switch', { openid: 'switch-wechat' });
  const switched = await callback(await start('/link-social', owner), 'switch', other);
  expect(switched.headers.get('location')).toContain('SESSION_REQUIRED');
  fixtures.set('revoked', { openid: 'revoked-wechat' });
  const flow = await start('/link-social', owner);
  expect((await call('/api/auth/sign-out', { body: {}, cookie: owner })).status).toBe(200);
  const revoked = await callback(flow, 'revoked', owner);
  expect(revoked.headers.get('location')).toContain('unable_to_link_account');
  const session = await identity(other);
  fixtures.set('expired-session', { openid: 'expired-session-wechat' });
  const expiring = await start('/link-social', other);
  await pool.query(
    'UPDATE "session" SET "createdAt" = now() - interval \'11 minutes\' WHERE id=$1',
    [session.sessionId],
  );
  expect((await callback(expiring, 'expired-session', other)).headers.get('location')).toContain(
    'SESSION_REQUIRED',
  );
  const stale = await call('/api/auth/link-social', {
    body: { provider: 'wechat' },
    cookie: other,
  });
  expect(stale.status).toBe(400);
  expect(
    (await pool.query(`SELECT id FROM "account" WHERE "providerId"='wechat'`)).rows,
  ).toHaveLength(0);
});

it('rejects expired state and provider errors without exchanging identity or leaking details', async () => {
  const expired = await start('/sign-in/social');
  await pool.query(
    `UPDATE "verification" SET value = jsonb_set(value::jsonb, '{expiresAt}', '0'::jsonb)::text WHERE identifier=$1`,
    [`auth-state:${expired.state}`],
  );
  const expiredResponse = await callback(expired, 'unused');
  expect(expiredResponse.headers.get('location')).toContain('state_mismatch');
  expect(exchanges).toBe(0);
  const failure = await callback(await start('/sign-in/social'), 'provider-rejected');
  expect(failure.headers.get('location')).toContain('invalid_code');
  expect(await failure.text()).not.toContain('private fixture details');
  expect((await pool.query('SELECT id FROM "user"')).rows).toHaveLength(0);
});

it('never links an anonymous WeChat login to an existing matching email', async () => {
  const owner = await emailUser();
  const ownerId = (await identity(owner)).userId;
  const hash = createHash('sha256')
    .update(JSON.stringify([appId, 'email-collision']))
    .digest('hex')
    .slice(0, 56);
  await pool.query('UPDATE "user" SET email=$1, "emailVerified"=true WHERE id=$2', [
    `wechat-${hash}@auth.mio.invalid`,
    ownerId,
  ]);
  fixtures.set('collision', { openid: 'email-collision' });
  const response = await callback(await start('/sign-in/social'), 'collision');
  expect(response.headers.get('location')).toContain('account_not_linked');
  expect(
    (await pool.query(`SELECT id FROM "account" WHERE "providerId"='wechat'`)).rows,
  ).toHaveLength(0);
});

it('enforces first binding and provider identity uniqueness under concurrency', async () => {
  const owner = await emailUser();
  const other = await emailUser();
  fixtures.set('one', { openid: 'same-wechat' });
  fixtures.set('two', { openid: 'same-wechat' });
  const [one, two] = await Promise.all([
    start('/link-social', owner),
    start('/link-social', other),
  ]);
  await Promise.all([callback(one, 'one', owner), callback(two, 'two', other, 1)]);
  const rows = await pool.query(
    `SELECT "userId" FROM "account" WHERE "providerId"='wechat' AND "accountId"=$1`,
    [JSON.stringify([appId, 'same-wechat'])],
  );
  expect(rows.rows).toHaveLength(1);
  const fresh = await emailUser();
  fixtures.set('three', { openid: 'another-one' });
  fixtures.set('four', { openid: 'another-two' });
  const [three, four] = await Promise.all([
    start('/link-social', fresh),
    start('/link-social', fresh),
  ]);
  await Promise.all([callback(three, 'three', fresh), callback(four, 'four', fresh, 1)]);
  const freshId = (await identity(fresh)).userId;
  expect(
    (
      await pool.query(`SELECT id FROM "account" WHERE "providerId"='wechat' AND "userId"=$1`, [
        freshId,
      ])
    ).rows,
  ).toHaveLength(1);
});

it('rejects arbitrary providers, direct tokens, unsafe return paths and missing POST Origin', async () => {
  for (const body of [
    { provider: 'google' },
    { provider: 'wechat', idToken: { token: 'untrusted' } },
    { provider: 'wechat', callbackURL: 'https://evil.example/' },
    { provider: 'wechat', callbackURL: '//evil.example/' },
    { provider: 'wechat', callbackURL: '/\\evil.example/' },
  ])
    expect((await call('/api/auth/sign-in/social', { body })).status).toBe(400);
  expect(
    (await call('/api/auth/sign-in/social', { body: { provider: 'wechat' }, origin: false }))
      .status,
  ).toBe(403);
  expect((await call('/api/auth/callback/wechat', { body: {}, origin: false })).status).toBe(405);
  expect((await call('/api/auth/callback/google', { origin: false })).status).toBe(404);
});

it.each(['/sign-in/social', '/link-social'] as const)(
  'rejects a null return path without creating OAuth state and defaults an omitted path for %s',
  async (path) => {
    const session = path === '/link-social' ? await emailUser() : undefined;
    const invalid = await call(`/api/auth${path}`, {
      body: { provider: 'wechat', callbackURL: null },
      ...(session ? { cookie: session } : {}),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(invalid.headers.getSetCookie()).toEqual([]);
    expect(
      (await pool.query(`SELECT id FROM "verification" WHERE identifier LIKE 'auth-state:%'`)).rows,
    ).toHaveLength(0);
    expect(exchanges).toBe(0);

    fixtures.set('default-return', { openid: 'default-return-wechat' });
    const flow = await start(path, session, { provider: 'wechat' });
    const completed = await callback(flow, 'default-return', session);
    expect(completed.status).toBe(302);
    expect(completed.headers.get('location')).toBe(`${origins[0]}/`);
    expect(exchanges).toBe(1);
  },
);

it('rejects a configured AppID change when existing WeChat accounts use another namespace', async () => {
  fixtures.set('existing', { openid: 'existing-wechat' });
  await callback(await start('/sign-in/social'), 'existing');
  const changed = readAuthConfig({
    MIO_AUTH_BASE_URL: origins[0],
    MIO_AUTH_SECRET: secret,
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_AUTH_WECHAT_ENABLED: 'true',
    MIO_AUTH_WECHAT_APP_ID: 'another-app',
    MIO_AUTH_WECHAT_APP_SECRET: 'fixture-secret',
  })!;
  await expect(createAuthentication(changed)).rejects.toThrow('AUTH_WECHAT_APP_CHANGED');
  await pool.query(`UPDATE "account" SET "accountId"='legacy-openid' WHERE "providerId"='wechat'`);
  const unchanged = { ...changed, wechat: { ...changed.wechat!, appId } };
  await expect(createAuthentication(unchanged)).rejects.toThrow('AUTH_WECHAT_APP_CHANGED');
});

it('adds both unique indexes idempotently and refuses existing conflicting accounts', async () => {
  const schema = `mio_wechat_old_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const scoped = new URL(database.url);
  scoped.searchParams.set('options', `-csearch_path=${schema}`);
  const oldPool = new Pool({ connectionString: scoped.toString() });
  try {
    const config = readAuthConfig({
      MIO_AUTH_BASE_URL: origins[0],
      MIO_AUTH_SECRET: secret,
      MIO_AUTH_DATABASE_URL: scoped.toString(),
    })!;
    const oldOptions = authOptions(config, oldPool);
    oldOptions.plugins = oldOptions.plugins?.filter((plugin) => plugin.id !== 'mio-wechat');
    await (await getMigrations(oldOptions)).runMigrations();
    const oldAuth = betterAuth(oldOptions);
    const users: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await oldAuth.handler(
        new Request(`${origins[0]}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { origin: origins[0]!, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Old', email: `${randomUUID()}@example.test`, password }),
        }),
      );
      expect(response.status).toBe(200);
      users.push(((await response.json()) as { user: { id: string } }).user.id);
    }
    await oldPool.query(
      `INSERT INTO "account" (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES ('wx1','duplicate','wechat',$1,now(),now()),('wx2','duplicate','wechat',$2,now(),now())`,
      users,
    );
    const plan = await getMigrations(authOptions(config, oldPool));
    expect(plan.toBeAddedIndexes.length).toBeGreaterThanOrEqual(2);
    await expect(plan.runMigrations()).rejects.toThrow();
    expect(
      (await oldPool.query(`SELECT id FROM "account" WHERE "providerId"='wechat'`)).rows,
    ).toHaveLength(2);
    await oldPool.query(`DELETE FROM "account" WHERE id='wx2'`);
    await oldPool.query(
      `INSERT INTO "account" (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES ('credential-duplicate','other-credential','credential',$1,now(),now())`,
      [users[0]],
    );
    await expect(
      (await getMigrations(authOptions(config, oldPool))).runMigrations(),
    ).rejects.toThrow();
    expect(
      (
        await oldPool.query(
          `SELECT id FROM "account" WHERE "providerId"='credential' AND "userId"=$1`,
          [users[0]],
        )
      ).rows,
    ).toHaveLength(2);
    await oldPool.query(`DELETE FROM "account" WHERE id='credential-duplicate'`);
    await (await getMigrations(authOptions(config, oldPool))).runMigrations();
    expect((await getMigrations(authOptions(config, oldPool))).toBeAddedIndexes).toHaveLength(0);
  } finally {
    await oldPool.end();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
});

async function startQR(cookie?: string) {
  const response = await call('/api/auth/wechat/qr-session', {
    body: {},
    ...(cookie ? { cookie } : {}),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const body = (await response.json()) as {
    qrcode_id: string;
    authorization_url: string;
    expire_seconds: number;
  };
  expect(body.expire_seconds).toBe(300);
  const authorization = new URL(body.authorization_url);
  expect(authorization.origin).toBe('https://open.weixin.qq.com');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const qrCookie = response.headers.getSetCookie().find((value) => value.includes('wechat_qr='));
  expect(qrCookie).toContain('HttpOnly');
  expect(qrCookie).toMatch(/SameSite=Lax/i);
  expect(qrCookie).toContain(`/api/auth/wechat/qr-session/${body.qrcode_id}/poll`);
  expect(cookies(response)).not.toContain('session_token=');
  return {
    id: body.qrcode_id,
    state: authorization.searchParams.get('state')!,
    cookie: cookies(response),
  };
}

function pollQR(flow: { id: string; cookie: string }, session?: string, instance = 0) {
  return call(`/api/auth/wechat/qr-session/${flow.id}/poll`, {
    cookie: [flow.cookie, session].filter(Boolean).join('; '),
    instance,
  });
}

it('reads a pending QR over HTTP while another transaction holds its row lock', async () => {
  const session = await emailUser();
  const qr = await startQR();
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    const held = await blocker.query(
      'SELECT xmin::text FROM "mioWechatQR" WHERE id=$1 FOR UPDATE',
      [qr.id],
    );
    const response = await pollQR(qr, session, 1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'pending' });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(
      (await blocker.query('SELECT xmin::text FROM "mioWechatQR" WHERE id=$1', [qr.id])).rows,
    ).toEqual(held.rows);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
});

it('completes QR registration through the OAuth session and consumes the result once across instances', async () => {
  const qr = await startQR();
  expect(await (await pollQR(qr)).json()).toEqual({ status: 'pending' });
  fixtures.set('qr-new', { openid: 'qr-user' });
  const completed = await callback(qr, 'qr-new');
  expect(completed.status).toBe(302);
  expect(completed.headers.get('location')).toBe(`${origins[0]}/auth/wechat/qr-complete`);
  const session = cookies(completed);
  const user = await identity(session);
  const stored = (await pool.query('SELECT * FROM "mioWechatQR" WHERE id=$1', [qr.id])).rows[0];
  expect(stored.status).toBe('confirmed');
  expect(stored.userId).toBe(user.userId);
  expect(stored.stateHash).not.toBe(qr.state);
  expect(stored.cookieHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(stored)).not.toContain('session_token');
  const claims = await Promise.all([pollQR(qr, session), pollQR(qr, session, 1)]);
  expect(
    (await Promise.all(claims.map((response) => response.json()))).sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
  ).toEqual([{ status: 'confirmed' }, { status: 'consumed' }]);
  for (const response of claims) {
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect((await identity(session)).userId).toBe(user.userId);
  expect(await (await pollQR(qr, session)).json()).toEqual({ status: 'consumed' });
});

it('requires the confirmed user session and does not consume QR for another or revoked session', async () => {
  const other = await emailUser();
  const qr = await startQR();
  fixtures.set('qr-owner', { openid: 'qr-owner' });
  const completed = await callback(qr, 'qr-owner');
  const owner = cookies(completed);
  expect((await pollQR(qr)).status).toBe(401);
  expect((await pollQR(qr, other)).status).toBe(401);
  expect(
    (await pool.query('SELECT status FROM "mioWechatQR" WHERE id=$1', [qr.id])).rows[0].status,
  ).toBe('confirmed');
  expect((await call('/api/auth/sign-out', { body: {}, cookie: owner })).status).toBe(200);
  expect((await pollQR(qr, owner)).status).toBe(401);
  expect(
    (await pool.query('SELECT status FROM "mioWechatQR" WHERE id=$1', [qr.id])).rows[0].status,
  ).toBe('confirmed');
});

it('uses one transaction connection to check the current session before consuming a confirmed QR', async () => {
  const owner = await identity(await emailUser());
  const id = randomUUID();
  const digest = 'fixture-confirmed-qr';
  await pool.query(
    `INSERT INTO "mioWechatQR" (id,"cookieHash",status,"userId","confirmedAt","expiresAt")
     VALUES ($1,$2,'confirmed',$3,now(),now()+interval '5 minutes')`,
    [id, digest, owner.userId],
  );
  const claimPool = new Pool({
    connectionString: database.url,
    max: 1,
    connectionTimeoutMillis: 2000,
  });
  try {
    const client = await claimPool.connect();
    const trace = vi.spyOn(client, 'query');
    client.release();
    await expect(pollWechatQR(claimPool, id, digest, async () => owner)).resolves.toEqual({
      status: 'confirmed',
    });
    const statements = trace.mock.calls.map(([query]) =>
      typeof query === 'string' ? query : (query as { text?: string }).text,
    );
    expect(statements.slice(statements.indexOf('BEGIN'))).toEqual([
      'BEGIN',
      expect.stringContaining('SET LOCAL lock_timeout'),
      expect.stringContaining('SET LOCAL statement_timeout'),
      expect.stringContaining('FROM "session" WHERE id=$1 AND "userId"=$2 FOR SHARE'),
      expect.stringContaining('FROM "mioWechatQR"'),
      expect.stringContaining('"expiresAt">statement_timestamp()'),
      'COMMIT',
    ]);
    expect(
      (await pool.query('SELECT status FROM "mioWechatQR" WHERE id=$1', [id])).rows[0],
    ).toEqual({ status: 'consumed' });
  } finally {
    await claimPool.end();
  }
});

it('expires a confirmed QR when its competing row lock is released after the deadline', async () => {
  const qr = await startQR();
  fixtures.set('qr-deadline', { openid: 'qr-deadline-owner' });
  const completed = await callback(qr, 'qr-deadline');
  expect(completed.status).toBe(302);
  await pool.query(
    `UPDATE "mioWechatQR" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`,
    [qr.id],
  );
  const blocker = await pool.connect();
  let polling: Promise<Response> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM "mioWechatQR" WHERE id=$1 FOR UPDATE', [qr.id]);
    polling = pollQR(qr, cookies(completed), 1);
    await expect
      .poll(
        async () => {
          const observed = await blocker.query<{ blocked: boolean }>(
            `SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND pg_backend_pid()=ANY(pg_blocking_pids(pid))
        ) AS blocked`,
          );
          return observed.rows[0]?.blocked;
        },
        { timeout: 1500 },
      )
      .toBe(true);
    await blocker.query(
      `SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM "expiresAt"-clock_timestamp()))+0.01)
       FROM "mioWechatQR" WHERE id=$1`,
      [qr.id],
    );
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await polling;
  }
  expect(await (await polling!).json()).toEqual({ status: 'expired' });
  expect(await (await pollQR(qr)).json()).toEqual({ status: 'expired' });
});

it('does not mistake an old session or failed callback for a successful QR login', async () => {
  const oldSession = await emailUser();
  const qr = await startQR(oldSession);
  const response = await callback(qr, 'invalid-provider-code', oldSession);
  expect(response.headers.get('location')).toContain('invalid_code');
  expect(await (await pollQR(qr, oldSession)).json()).toEqual({ status: 'failed' });
  const row = (await pool.query('SELECT * FROM "mioWechatQR" WHERE id=$1', [qr.id])).rows[0];
  expect(row.userId).toBeNull();
  expect(row.failureCode).toBe('OAUTH_FAILED');
  expect(JSON.stringify(row)).not.toContain('private fixture details');
  expect((await pool.query('SELECT id FROM "session"')).rowCount).toBe(1);
});

it('rejects a forged callback without burning QR and rejects missing or cross-browser QR cookies', async () => {
  const qr = await startQR();
  const another = await startQR();
  const forged = await call(`/api/auth/callback/wechat?state=${qr.state}&code=forged`, {
    origin: false,
    cookie: another.cookie,
  });
  expect(forged.status).toBe(400);
  expect(exchanges).toBe(0);
  expect(await (await pollQR(qr)).json()).toEqual({ status: 'pending' });
  expect((await call(`/api/auth/wechat/qr-session/${qr.id}/poll`)).status).toBe(400);
  expect((await pollQR({ id: qr.id, cookie: another.cookie })).status).toBe(400);
  expect((await pollQR({ id: randomUUID(), cookie: qr.cookie })).status).toBe(404);
  expect((await call(`/api/auth/wechat/qr-session/${randomUUID()}/poll`)).status).toBe(404);
  fixtures.set('valid-after-forgery', { openid: 'forgery-survivor' });
  const success = await callback(qr, 'valid-after-forgery');
  expect(await (await pollQR(qr, cookies(success))).json()).toEqual({ status: 'confirmed' });
});

it('serializes QR callback replay without replacing the confirmed or consumed result', async () => {
  const qr = await startQR();
  fixtures.set('qr-once', { openid: 'once-qr-user' });
  let release!: () => void;
  holdExchange = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    exchangeStarted = resolve;
  });
  const first = callback(qr, 'qr-once');
  await started;
  let replay: Response;
  try {
    replay = await callback(qr, 'qr-once', undefined, 1);
    expect(await (await pollQR(qr)).json()).toEqual({ status: 'pending' });
  } finally {
    release();
  }
  expect(replay!.status).toBe(400);
  const finished = await first;
  const session = cookies(finished);
  expect(finished.status).toBe(302);
  expect(exchanges).toBe(1);
  expect(await (await pollQR(qr, session)).json()).toEqual({ status: 'confirmed' });
  expect((await callback(qr, 'qr-once')).status).toBe(400);
  expect(await (await pollQR(qr, session)).json()).toEqual({ status: 'consumed' });
  expect((await pool.query('SELECT id FROM "session"')).rowCount).toBe(1);
});

it('expires QR before code exchange and preserves an observable expiry grace before bounded cleanup', async () => {
  const qr = await startQR();
  await pool.query(
    'UPDATE "mioWechatQR" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
    [qr.id],
  );
  expect(await (await pollQR(qr)).json()).toEqual({ status: 'expired' });
  const expired = await callback(qr, 'too-late');
  expect(expired.status).toBe(400);
  expect(exchanges).toBe(0);
  expect((await pool.query('SELECT id FROM "session"')).rowCount).toBe(0);
  await pool.query(`INSERT INTO "mioWechatQR" (id, "cookieHash", status, "expiresAt")
    SELECT gen_random_uuid()::text, 'fixture-digest', 'pending', clock_timestamp()-interval '11 minutes'
    FROM generate_series(1,101)`);
  await startQR();
  const count = (
    await pool.query(`SELECT count(*)::int AS count FROM "mioWechatQR"
    WHERE "expiresAt" <= clock_timestamp()-interval '10 minutes'`)
  ).rows[0].count;
  expect(count).toBe(1);
  expect(await (await pollQR(qr)).json()).toEqual({ status: 'expired' });
});

it('enforces QR creation 20/60s and concrete QR polling 300/60s without the ordinary login limit', async () => {
  const first = await startQR();
  const second = await startQR();
  for (let index = 2; index < 20; index++) await startQR();
  expect((await call('/api/auth/wechat/qr-session', { body: {} })).status).toBe(429);
  expect((await pool.query('SELECT id FROM "mioWechatQR"')).rowCount).toBe(20);
  for (let index = 0; index < 300; index++) expect((await pollQR(first)).status).toBe(200);
  expect((await pollQR(first)).status).toBe(429);
  expect((await pollQR(second)).status).toBe(200);
}, 30000);

it('keeps the QR HTTP boundary precise and validates input before creating OAuth state', async () => {
  for (const body of [
    [],
    null,
    { provider: 'wechat' },
    { callbackURL: null },
    { callbackURL: 'https://evil.test/' },
    { callbackURL: '//evil.test/' },
    { callbackURL: '/\\evil.test/' },
    { callbackURL: '/bad\npath' },
  ])
    expect((await call('/api/auth/wechat/qr-session', { body })).status).toBe(400);
  expect((await pool.query('SELECT id FROM "mioWechatQR"')).rowCount).toBe(0);
  expect((await call('/api/auth/wechat/qr-session', { body: {}, origin: false })).status).toBe(403);
  expect((await call('/api/auth/wechat/qr-session')).status).toBe(405);
  expect((await call('/api/auth/wechat/qr-session/not-an-id/poll')).status).toBe(404);
  expect((await call('/api/auth/wechat/qr-session/extra/path/poll')).status).toBe(404);
  const qr = await startQR();
  expect((await call(`/api/auth/wechat/qr-session/${qr.id}/poll`, { body: {} })).status).toBe(405);
  const denied = await originalFetch(`${origins[0]}/api/auth/wechat/qr-session`, {
    method: 'POST',
    headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
    body: '{}',
  });
  expect(denied.status).toBe(403);
  const nonJSON = await originalFetch(`${origins[0]}/api/auth/wechat/qr-session`, {
    method: 'POST',
    headers: { origin: origins[0]! },
    body: '{}',
  });
  expect(nonJSON.status).toBe(415);
  expect((await call('/api/auth/wechat/qr-session', { body: 'x'.repeat(16384) })).status).toBe(413);
});

it('requires explicit QR schema migration and includes its indexes idempotently', async () => {
  const schema = `mio_qr_old_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const scoped = new URL(database.url);
  scoped.searchParams.set('options', `-csearch_path=${schema}`);
  const oldPool = new Pool({ connectionString: scoped.toString() });
  try {
    const config = readAuthConfig({
      MIO_AUTH_BASE_URL: origins[0],
      MIO_AUTH_SECRET: secret,
      MIO_AUTH_DATABASE_URL: scoped.toString(),
    })!;
    const old = authOptions(config, oldPool);
    old.plugins = old.plugins?.filter((plugin) => plugin.id !== 'mio-wechat-qr');
    await (await getMigrations(old)).runMigrations();
    await expect(createAuthentication(config)).rejects.toThrow('AUTH_SCHEMA');
    const pending = await getMigrations(authOptions(config, oldPool));
    expect(pending.toBeCreated.some((entry) => entry.table === 'mioWechatQR')).toBe(true);
    await pending.runMigrations();
    const current = await getMigrations(authOptions(config, oldPool));
    expect(current.toBeCreated).toHaveLength(0);
    expect(current.toBeAddedIndexes).toHaveLength(0);
    const enabled = await createAuthentication(config);
    await enabled.close();
    const indexes = await oldPool.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename='mioWechatQR'`,
      [schema],
    );
    expect(
      indexes.rows.some(
        (row) => row.indexdef.includes('stateHash') && row.indexdef.includes('UNIQUE'),
      ),
    ).toBe(true);
    expect(indexes.rows.some((row) => row.indexdef.includes('expiresAt'))).toBe(true);
    expect(indexes.rows.some((row) => row.indexdef.includes('status'))).toBe(true);
  } finally {
    await oldPool.end();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
});

it('signs in an existing WeChat user through QR without changing identity or merging a matching email', async () => {
  fixtures.set('first-qr-account', { openid: 'existing-qr-openid' });
  const first = await callback(await start('/sign-in/social'), 'first-qr-account');
  const ownerId = (await identity(cookies(first))).userId;
  const qr = await startQR();
  fixtures.set('same-qr-account', { openid: 'existing-qr-openid', unionid: 'later-unionid' });
  const second = await callback(qr, 'same-qr-account');
  expect((await identity(cookies(second))).userId).toBe(ownerId);
  expect(await (await pollQR(qr, cookies(second))).json()).toEqual({ status: 'confirmed' });
  expect((await pool.query('SELECT id FROM "user"')).rowCount).toBe(1);
  const emailOwner = await emailUser();
  const emailOwnerId = (await identity(emailOwner)).userId;
  const digest = createHash('sha256')
    .update(JSON.stringify([appId, 'qr-email-collision']))
    .digest('hex')
    .slice(0, 56);
  await pool.query('UPDATE "user" SET email=$1, "emailVerified"=true WHERE id=$2', [
    `wechat-${digest}@auth.mio.invalid`,
    emailOwnerId,
  ]);
  fixtures.set('qr-collision', { openid: 'qr-email-collision' });
  const collision = await startQR();
  const rejected = await callback(collision, 'qr-collision');
  expect(rejected.headers.get('location')).toContain('account_not_linked');
  expect(await (await pollQR(collision, emailOwner)).json()).toEqual({ status: 'failed' });
  expect(
    (await pool.query('SELECT id FROM "account" WHERE "providerId"=\'wechat\'')).rowCount,
  ).toBe(1);
});

it('redacts QR authorization refusal while leaving ordinary OAuth redirects unchanged', async () => {
  const qr = await startQR();
  const rejected = await call(
    `/api/auth/callback/wechat?${new URLSearchParams({
      state: qr.state,
      error: 'untrusted-provider-detail',
      error_description: 'private-fixture-message',
    })}`,
    { cookie: qr.cookie, origin: false },
  );
  expect(rejected.headers.get('location')).toBe(
    `${origins[0]}/auth/wechat/qr-complete?error=WECHAT_AUTH_FAILED`,
  );
  expect(await (await pollQR(qr)).json()).toEqual({ status: 'failed' });
  expect(exchanges).toBe(0);
});

it('rolls back an unsuccessful QR claim and permits the first successful claim after DB recovery', async () => {
  const qr = await startQR();
  fixtures.set('qr-rollback', { openid: 'qr-rollback-owner' });
  const completed = await callback(qr, 'qr-rollback');
  const session = cookies(completed);
  await pool.query(`CREATE FUNCTION reject_qr_claim() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status='consumed' THEN RAISE EXCEPTION 'private-fixture-database-detail'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER reject_qr_claim BEFORE UPDATE ON "mioWechatQR"
    FOR EACH ROW EXECUTE FUNCTION reject_qr_claim()`);
  try {
    const failed = await pollQR(qr, session);
    expect(failed.status).toBe(503);
    const error = await failed.text();
    expect(error).toContain('AUTH_UNAVAILABLE');
    expect(error).not.toContain('private-fixture-database-detail');
    expect(
      (await pool.query('SELECT status FROM "mioWechatQR" WHERE id=$1', [qr.id])).rows[0].status,
    ).toBe('confirmed');
  } finally {
    await pool.query('DROP TRIGGER reject_qr_claim ON "mioWechatQR"');
    await pool.query('DROP FUNCTION reject_qr_claim()');
  }
  expect(await (await pollQR(qr, session)).json()).toEqual({ status: 'confirmed' });
  expect(await (await pollQR(qr, session)).json()).toEqual({ status: 'consumed' });
});

it('uses Secure QR cookies under HTTPS and rejects both QR routes while WeChat is disabled', async () => {
  for (const enabled of [true, false]) {
    const config = readAuthConfig({
      MIO_AUTH_BASE_URL: enabled ? 'https://mio-qr.example.test' : origins[0],
      MIO_AUTH_SECRET: secret,
      MIO_AUTH_DATABASE_URL: database.url,
      ...(enabled
        ? {
            MIO_AUTH_WECHAT_ENABLED: 'true',
            MIO_AUTH_WECHAT_APP_ID: appId,
            MIO_AUTH_WECHAT_APP_SECRET: 'fixture-secret',
          }
        : {}),
    })!;
    const auth = await createAuthentication(config);
    const server = createServer(createAuthHandler(config, auth));
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing address');
      const origin = `http://127.0.0.1:${address.port}`;
      const response = await originalFetch(`${origin}/api/auth/wechat/qr-session`, {
        method: 'POST',
        headers: { origin: config.baseURL, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status, await response.clone().text()).toBe(enabled ? 201 : 503);
      if (enabled) {
        const cookie = response.headers
          .getSetCookie()
          .find((value) => value.includes('wechat_qr='));
        expect(cookie).toMatch(/^__Secure-mio\.wechat_qr=/);
        expect(cookie).toContain('; Secure');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toMatch(/SameSite=Lax/i);
      } else {
        expect(
          (await originalFetch(`${origin}/api/auth/wechat/qr-session/${randomUUID()}/poll`)).status,
        ).toBe(503);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await auth.close();
    }
  }
});

it('bridges cross-site embedded WxLogin iframe callbacks into a same-origin hop and completes QR polling', async () => {
  const qr = await startQR();
  fixtures.set('iframe-qr', { openid: 'iframe-qr-user' });
  const query = new URLSearchParams({ state: qr.state, code: 'iframe-qr' });
  const hop1 = await call(`/api/auth/callback/wechat?${query}`, {
    origin: false,
    headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' },
  });
  expect(hop1.status).toBe(200);
  expect(hop1.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(hop1.headers.get('cache-control')).toBe('no-store');
  expect(hop1.headers.get('x-content-type-options')).toBe('nosniff');
  expect(hop1.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  expect(hop1.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  expect(hop1.headers.get('referrer-policy')).toBe('no-referrer');
  const html = await hop1.text();
  const match = /^<!doctype html><meta charset="utf-8"><script>([^<]+)<\/script>$/.exec(html);
  expect(match).not.toBeNull();
  const expectedHash = createHash('sha256').update(match![1]!).digest('base64');
  expect(hop1.headers.get('content-security-policy')).toBe(
    `default-src 'none'; script-src 'sha256-${expectedHash}'; frame-ancestors 'self'`,
  );
  expect(html).not.toContain(qr.state);
  expect(html).not.toContain('iframe-qr');
  expect(exchanges).toBe(0);
  expect(
    (await pool.query('SELECT key FROM "rateLimit" WHERE key LIKE $1', ['%/callback/wechat%']))
      .rowCount,
  ).toBe(0);
  expect(await (await pollQR(qr)).json()).toEqual({ status: 'pending' });
  query.set('mio_bridge', '1');
  const hop2 = await call(`/api/auth/callback/wechat?${query}`, {
    origin: false,
    cookie: qr.cookie,
    headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' },
  });
  expect(hop2.status).toBe(302);
  expect(hop2.headers.get('location')).toBe(`${origins[0]}/auth/wechat/qr-complete`);
  expect(exchanges).toBe(1);
  const session = cookies(hop2);
  expect(session).toContain('mio.session_token=');
  const user = await identity(session);
  expect(await (await pollQR(qr, session)).json()).toEqual({ status: 'confirmed' });
  expect(await (await pollQR(qr, session)).json()).toEqual({ status: 'consumed' });
  expect((await identity(session)).userId).toBe(user.userId);
});

it('bridges iframe authorization refusal and redacts QR error without code exchange', async () => {
  const qr = await startQR();
  const query = new URLSearchParams({
    state: qr.state,
    error: 'access_denied',
    error_description: 'private-iframe-refusal',
  });
  const hop1 = await call(`/api/auth/callback/wechat?${query}`, {
    origin: false,
    headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' },
  });
  expect(hop1.status).toBe(200);
  expect(hop1.headers.get('content-type')).toContain('text/html');
  expect(await (await pollQR(qr)).json()).toEqual({ status: 'pending' });
  query.set('mio_bridge', '1');
  const hop2 = await call(`/api/auth/callback/wechat?${query}`, {
    origin: false,
    cookie: qr.cookie,
    headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' },
  });
  expect(hop2.status).toBe(302);
  expect(hop2.headers.get('location')).toBe(
    `${origins[0]}/auth/wechat/qr-complete?error=WECHAT_AUTH_FAILED`,
  );
  expect(await (await pollQR(qr)).json()).toEqual({ status: 'failed' });
  expect(exchanges).toBe(0);
});

it('prevents iframe bridge loops, enforces non-iframe and cookie guards, and strips mio_bridge', async () => {
  const qr = await startQR();
  const other = await startQR();
  fixtures.set('guard-ok', { openid: 'guard-ok-user' });
  const hop2NoCookie = await call(
    `/api/auth/callback/wechat?${new URLSearchParams({ state: qr.state, code: 'guard-ok', mio_bridge: '1' })}`,
    {
      origin: false,
      headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' },
    },
  );
  expect(hop2NoCookie.status).toBe(400);
  expect(await hop2NoCookie.text()).toContain('STATE_MISMATCH');
  const hop2WrongCookie = await call(
    `/api/auth/callback/wechat?${new URLSearchParams({ state: qr.state, code: 'guard-ok', mio_bridge: '1' })}`,
    {
      origin: false,
      cookie: other.cookie,
      headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' },
    },
  );
  expect(hop2WrongCookie.status).toBe(400);
  expect(await hop2WrongCookie.text()).toContain('STATE_MISMATCH');
  const nonIframe = await call(
    `/api/auth/callback/wechat?${new URLSearchParams({ state: qr.state, code: 'guard-ok' })}`,
    { origin: false },
  );
  expect(nonIframe.status).toBe(400);
  expect(await nonIframe.text()).toContain('STATE_MISMATCH');
  for (const query of ['', 'state=', `state=${'a'.repeat(513)}`]) {
    const invalidState = await call(`/api/auth/callback/wechat${query ? `?${query}` : ''}`, {
      origin: false,
      headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' },
    });
    expect(invalidState.status).toBe(400);
  }
  for (const cookie of ['mio.state=', '__Secure-mio.state=wrong-scheme']) {
    const bridged = await call(
      `/api/auth/callback/wechat?${new URLSearchParams({ state: qr.state, code: 'guard-ok' })}`,
      {
        origin: false,
        cookie,
        headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' },
      },
    );
    expect(bridged.status).toBe(200);
    expect(bridged.headers.get('content-type')).toContain('text/html');
  }
  expect(exchanges).toBe(0);
  expect(await (await pollQR(qr)).json()).toEqual({ status: 'pending' });
  const direct = await call(
    `/api/auth/callback/wechat?${new URLSearchParams({ state: qr.state, code: 'guard-ok' })}`,
    {
      origin: false,
      cookie: qr.cookie,
      headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' },
    },
  );
  expect(direct.status).toBe(302);
  expect(direct.headers.get('location')).toBe(`${origins[0]}/auth/wechat/qr-complete`);
  expect(exchanges).toBe(1);
  expect(await (await pollQR(qr, cookies(direct))).json()).toEqual({ status: 'confirmed' });
  const seenUrls: string[] = [];
  const spyHandler = vi.fn(async (input: Request) => {
    seenUrls.push(input.url);
    return new Response(null, { status: 204 });
  });
  const spyServer = createServer(
    createAuthHandler(
      {
        baseURL: 'http://localhost',
        secret,
        databaseURL: database.url,
        origins: ['http://localhost'],
        smsLimits: { phoneHour: 5, phoneDay: 10, ipHour: 20, ipDay: 100, globalDay: 1000 },
        wechat: { appId, appSecret: 'fixture-secret' },
      },
      { handler: spyHandler } as unknown as Authentication,
    ),
  );
  try {
    spyServer.listen(0, '127.0.0.1');
    await once(spyServer, 'listening');
    const address = spyServer.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const spyOrigin = `http://127.0.0.1:${address.port}`;
    const spyHop1 = await originalFetch(
      `${spyOrigin}/api/auth/callback/wechat?state=xyz&code=abc`,
      { headers: { 'sec-fetch-dest': 'iframe' } },
    );
    expect(spyHop1.status).toBe(200);
    expect(spyHandler).toHaveBeenCalledTimes(0);
    const spyHop2 = await originalFetch(
      `${spyOrigin}/api/auth/callback/wechat?state=xyz&code=abc&mio_bridge=1`,
      { headers: { 'sec-fetch-dest': 'iframe' } },
    );
    expect(spyHop2.status).toBe(204);
    expect(spyHandler).toHaveBeenCalledTimes(1);
    const forwarded = new URL(seenUrls[0]!);
    expect(forwarded.pathname).toBe('/api/auth/callback/wechat');
    expect(forwarded.searchParams.get('state')).toBe('xyz');
    expect(forwarded.searchParams.get('code')).toBe('abc');
    expect(forwarded.searchParams.has('mio_bridge')).toBe(false);
  } finally {
    await new Promise<void>((resolve) => spyServer.close(() => resolve()));
  }
});

it('distinguishes __Secure-mio.state under HTTPS iframe bridge and rejects disabled WeChat with 503', async () => {
  for (const enabled of [true, false]) {
    const config = readAuthConfig({
      MIO_AUTH_BASE_URL: enabled ? 'https://mio-qr.example.test' : origins[0],
      MIO_AUTH_SECRET: secret,
      MIO_AUTH_DATABASE_URL: database.url,
      ...(enabled
        ? {
            MIO_AUTH_WECHAT_ENABLED: 'true',
            MIO_AUTH_WECHAT_APP_ID: appId,
            MIO_AUTH_WECHAT_APP_SECRET: 'fixture-secret',
          }
        : {}),
    })!;
    const auth = await createAuthentication(config);
    const server = createServer(createAuthHandler(config, auth));
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing address');
      const origin = `http://127.0.0.1:${address.port}`;
      if (enabled) {
        const created = await originalFetch(`${origin}/api/auth/wechat/qr-session`, {
          method: 'POST',
          headers: { origin: config.baseURL, 'content-type': 'application/json' },
          body: '{}',
        });
        expect(created.status).toBe(201);
        const httpsCookies = cookies(created);
        expect(httpsCookies).toContain('__Secure-mio.state=');
        const body = (await created.json()) as { authorization_url: string };
        const state = new URL(body.authorization_url).searchParams.get('state')!;
        const wrongCookieName = await originalFetch(
          `${origin}/api/auth/callback/wechat?${new URLSearchParams({ state, code: 'https-iframe' })}`,
          {
            redirect: 'manual',
            headers: {
              'sec-fetch-dest': 'iframe',
              'sec-fetch-site': 'cross-site',
              cookie: 'mio.state=wrong-prefix',
            },
          },
        );
        expect(wrongCookieName.status).toBe(200);
        expect(wrongCookieName.headers.get('content-type')).toContain('text/html');
        expect(exchanges).toBe(0);
        fixtures.set('https-iframe', { openid: 'https-iframe-user' });
        const direct = await originalFetch(
          `${origin}/api/auth/callback/wechat?${new URLSearchParams({ state, code: 'https-iframe' })}`,
          {
            redirect: 'manual',
            headers: {
              'sec-fetch-dest': 'iframe',
              'sec-fetch-site': 'same-origin',
              cookie: httpsCookies,
            },
          },
        );
        expect(direct.status).toBe(302);
        expect(direct.headers.get('location')).toBe(
          'https://mio-qr.example.test/auth/wechat/qr-complete',
        );
        expect(exchanges).toBe(1);
      } else {
        const disabled = await originalFetch(
          `${origin}/api/auth/callback/wechat?state=disabled-state&code=disabled-code`,
          {
            redirect: 'manual',
            headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' },
          },
        );
        expect(disabled.status).toBe(503);
        expect(await disabled.text()).toContain('WECHAT_UNAVAILABLE');
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await auth.close();
    }
  }
});
