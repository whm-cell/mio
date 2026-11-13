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
  options: { body?: unknown; cookie?: string; instance?: number; origin?: boolean } = {},
) {
  return originalFetch(`${origins[options.instance ?? 0]}${path}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    redirect: 'manual',
    headers: {
      ...(options.origin === false ? {} : { origin: origins[0]! }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
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

async function start(path: '/sign-in/social' | '/link-social', cookie?: string) {
  const response = await call(`/api/auth${path}`, {
    body: { provider: 'wechat', callbackURL: '/done' },
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
  await pool.query('TRUNCATE "account", "session", "user", "verification", "rateLimit" CASCADE');
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
