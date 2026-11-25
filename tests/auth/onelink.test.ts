import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authOptions,
  readAuthConfig,
  resolveAllowedOneLinkClientIds,
} from '../../src/auth/config.ts';
import type { OneLinkSsoRuntimePolicy } from '../../src/auth/config.ts';
import { createAuthHandler } from '../../src/auth/http.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import type { Authentication } from '../../src/auth/service.ts';
import type { OneLinkSsoConfig } from '../../src/integrations/onelink/sso.ts';
import { authDatabase } from '../support/auth-database.ts';

const SYNTHETIC_ENC_KEY = 'synthetic-test-only-enc-key-32ch';
const PASSWORD = 'correct-horse-onelink-test-42';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let origin: string;
let server: ReturnType<typeof createServer>;
let auth: Authentication;
let policy: OneLinkSsoRuntimePolicy;

const oneLinkConfig: OneLinkSsoConfig = {
  environment: 'test',
  encryptionKey: SYNTHETIC_ENC_KEY,
  authorizeUrl: 'https://scenic.wanlian.cloud/authorize',
  registerUrl: 'https://api-test.wanlian.cloud/sso/client/register',
  clientName: 'miioo',
  appName: 'Miioo',
};

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }), 'utf8').toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${header}.${body}.synthetic-signature`;
}

function futureExp(seconds = 3600): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

function decryptEncParam(enc: string, key = SYNTHETIC_ENC_KEY): Record<string, unknown> {
  const [ivB64, authTagB64, cipherB64] = enc.split(':');
  const iv = Buffer.from(ivB64!, 'base64');
  const authTag = Buffer.from(authTagB64!, 'base64');
  const ciphertext = Buffer.from(cipherB64!, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'utf8'), iv);
  decipher.setAuthTag(authTag);
  return JSON.parse(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
  ) as Record<string, unknown>;
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0]!)
    .join('; ');
}

function findSetCookie(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((entry) => entry.startsWith(`${name}=`));
}

function joinCookies(...values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).join('; ');
}

function call(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string | undefined;
    origin?: string | false;
    headers?: Record<string, string>;
  } = {},
) {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = {
    ...(options.origin === false ? {} : { origin: options.origin ?? origin }),
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...options.headers,
  };
  return fetch(`${origin}${path}`, {
    method,
    redirect: 'manual',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function createEmailUser() {
  const email = `${randomUUID()}@example.test`;
  const response = await call('/api/auth/sign-up/email', {
    body: { name: 'OneLink Tester', email, password: PASSWORD },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const sessionCookie = cookieHeader(response);
  const me = await call('/api/v1/me', { cookie: sessionCookie });
  expect(me.status).toBe(200);
  const identity = (await me.json()) as { userId: string; sessionId: string };
  return { ...identity, email, cookie: sessionCookie };
}

async function countUsersAndAccounts() {
  const [users, accounts] = await Promise.all([
    pool.query<{ count: string }>('SELECT count(*)::text AS count FROM "user"'),
    pool.query<{ count: string }>('SELECT count(*)::text AS count FROM "account"'),
  ]);
  return {
    users: Number(users.rows[0]!.count),
    accounts: Number(accounts.rows[0]!.count),
  };
}

beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  origin = `http://127.0.0.1:${address.port}`;

  policy = {
    enabled: true,
    clientName: 'miioo',
    allowedClientIds: resolveAllowedOneLinkClientIds('miioo', 'miiooClientId', null),
  };

  const config = readAuthConfig({
    MIO_AUTH_BASE_URL: origin,
    MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
    MIO_AUTH_DATABASE_URL: database.url,
  })!;
  await (await getMigrations(authOptions(config, pool))).runMigrations();
  auth = await createAuthentication(config, undefined, undefined, undefined, {
    config: oneLinkConfig,
    getPolicy: () => policy,
  });
  server.on('request', createAuthHandler(config, auth));
}, 30_000);

beforeEach(async () => {
  policy = {
    enabled: true,
    clientName: 'miioo',
    allowedClientIds: resolveAllowedOneLinkClientIds('miioo', 'miiooClientId', null),
  };
  await pool.query('DELETE FROM "rateLimit"');
  await pool.query('DELETE FROM "mioOneLinkPending"');
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await auth?.close();
  await pool?.end();
  await database?.close();
}, 30_000);

describe('OneLink schema migration & unconfigured/disabled gating', () => {
  it('requires mioOneLinkPending schema even when OneLink env config is absent', async () => {
    const schema = `mio_onelink_mig_${randomUUID().replaceAll('-', '')}`;
    const scoped = new URL(database.url);
    scoped.searchParams.set('options', `-csearch_path=${schema}`);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const oldPool = new Pool({ connectionString: scoped.toString() });
    try {
      const config = readAuthConfig({
        MIO_AUTH_BASE_URL: origin,
        MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
        MIO_AUTH_DATABASE_URL: scoped.toString(),
      })!;
      const withoutOneLink = authOptions(config, oldPool);
      withoutOneLink.plugins = withoutOneLink.plugins?.filter(
        (plugin) => plugin.id !== 'mio-onelink',
      );
      await (await getMigrations(withoutOneLink)).runMigrations();
      await expect(createAuthentication(config)).rejects.toThrow('AUTH_SCHEMA');

      const pending = await getMigrations(authOptions(config, oldPool));
      expect(pending.toBeCreated.some((entry) => entry.table === 'mioOneLinkPending')).toBe(true);
      await pending.runMigrations();

      const current = await getMigrations(authOptions(config, oldPool));
      expect(current.toBeCreated).toHaveLength(0);
      expect(current.toBeAddedIndexes).toHaveLength(0);

      // Runtime starts cleanly without OneLink env config and returns 503 ONELINK_UNAVAILABLE.
      const unconfiguredAuth = await createAuthentication(config);
      const unconfiguredServer = createServer(createAuthHandler(config, unconfiguredAuth));
      unconfiguredServer.listen(0, '127.0.0.1');
      await once(unconfiguredServer, 'listening');
      const addr = unconfiguredServer.address();
      if (!addr || typeof addr === 'string') throw new Error('missing addr');
      const base = `http://127.0.0.1:${addr.port}`;
      try {
        const startRes = await fetch(`${base}/api/auth/onelink/start`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ intent: 'login' }),
        });
        expect(startRes.status).toBe(503);
        expect(await startRes.json()).toMatchObject({ code: 'ONELINK_UNAVAILABLE' });

        const cbRes = await fetch(`${base}/api/auth/callback/onelink?unauthorized=true`, {
          redirect: 'manual',
        });
        expect(cbRes.status).toBe(503);
        expect(cbRes.headers.get('cache-control')).toBe('no-store');
        expect(cbRes.headers.get('referrer-policy')).toBe('no-referrer');
        expect(await cbRes.json()).toMatchObject({ code: 'ONELINK_UNAVAILABLE' });

        const pendingRes = await fetch(`${base}/api/auth/onelink/pending`);
        expect(pendingRes.status).toBe(503);
        expect(await pendingRes.json()).toMatchObject({ code: 'ONELINK_UNAVAILABLE' });
      } finally {
        unconfiguredServer.closeAllConnections();
        await new Promise<void>((resolve) => unconfiguredServer.close(() => resolve()));
        await unconfiguredAuth.close();
      }

      const indexes = await oldPool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'mioOneLinkPending'`,
        [schema],
      );
      expect(
        indexes.rows.some(
          (row) => row.indexdef.includes('tokenDigest') && row.indexdef.includes('UNIQUE'),
        ),
      ).toBe(true);
      expect(indexes.rows.some((row) => row.indexdef.includes('status'))).toBe(true);
      expect(indexes.rows.some((row) => row.indexdef.includes('expiresAt'))).toBe(true);
    } finally {
      await oldPool.end();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it('returns 503 ONELINK_UNAVAILABLE on start, callback and pending when runtime switch is disabled', async () => {
    policy = { ...policy, enabled: false };

    const startRes = await call('/api/auth/onelink/start', { body: { intent: 'login' } });
    expect(startRes.status).toBe(503);
    expect(await startRes.json()).toMatchObject({ code: 'ONELINK_UNAVAILABLE' });

    const cbRes = await call('/api/auth/callback/onelink?unauthorized=true', { origin: false });
    expect(cbRes.status).toBe(503);
    expect(cbRes.headers.get('cache-control')).toBe('no-store');
    expect(cbRes.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await cbRes.json()).toMatchObject({ code: 'ONELINK_UNAVAILABLE' });

    const pendingRes = await call('/api/auth/onelink/pending', { origin: false });
    expect(pendingRes.status).toBe(503);
    expect(await pendingRes.json()).toMatchObject({ code: 'ONELINK_UNAVAILABLE' });

    // Cancel remains available to clear stale cookies even when switch is toggled off.
    const cancelRes = await call('/api/auth/onelink/cancel', { body: {} });
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toEqual({ ok: true });
  });
});

describe('POST /api/auth/onelink/start', () => {
  it('starts login flow with encrypted 6-field authorize URL, HttpOnly pending cookie and HTTPS Secure prefix', async () => {
    const startRes = await call('/api/auth/onelink/start', {
      body: { intent: 'login', returnPath: '/?nav=onelink-sandbox' },
    });
    expect(startRes.status).toBe(200);
    const body = (await startRes.json()) as { url: string };
    expect(body.url).not.toContain(SYNTHETIC_ENC_KEY);

    const pendingSetCookie = findSetCookie(startRes, 'mio.onelink_pending');
    expect(pendingSetCookie).toBeDefined();
    expect(pendingSetCookie).toMatch(/HttpOnly/i);
    expect(pendingSetCookie).toMatch(/SameSite=Lax/i);
    expect(pendingSetCookie).toMatch(/Path=\/api\/auth/i);
    expect(pendingSetCookie).toMatch(/Max-Age=900/i);

    const enc = new URL(body.url).searchParams.get('enc');
    expect(enc).toBeTruthy();
    const decrypted = decryptEncParam(enc!);
    expect(decrypted).toMatchObject({
      clientType: 'web',
      clientName: 'miioo',
      name: 'Miioo',
      url: origin,
      callback: `${origin}/api/auth/callback/onelink`,
    });
    expect(Object.keys(decrypted).sort()).toEqual([
      'callback',
      'clientName',
      'clientType',
      'name',
      'timestamp',
      'url',
    ]);

    // Raw cookie value is never stored directly in DB; only SHA-256 digest is stored.
    const rawCookieVal = pendingSetCookie!.split(';')[0]!.split('=')[1]!;
    const rows = await pool.query<{ tokenDigest: string; returnPath: string; status: string }>(
      `SELECT "tokenDigest", "returnPath", status FROM "mioOneLinkPending"`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.tokenDigest).not.toBe(rawCookieVal);
    expect(rows.rows[0]!.tokenDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.rows[0]!.returnPath).toBe('/?nav=onelink-sandbox');
    expect(rows.rows[0]!.status).toBe('started');

    // Uses live policy.clientName when it differs from static oneLinkConfig.clientName.
    policy = {
      enabled: true,
      clientName: 'miioo_live',
      allowedClientIds: resolveAllowedOneLinkClientIds('miioo_live', null, null),
    };
    const customClientRes = await call('/api/auth/onelink/start', { body: { intent: 'login' } });
    expect(customClientRes.status).toBe(200);
    const customEnc = new URL(
      ((await customClientRes.json()) as { url: string }).url,
    ).searchParams.get('enc')!;
    expect(decryptEncParam(customEnc).clientName).toBe('miioo_live');

    // Invalid policy.clientName fails BEFORE inserting a pending row (no orphan row left behind).
    const beforeBadClient = Number(
      (
        await pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "mioOneLinkPending"',
        )
      ).rows[0]!.count,
    );
    policy = { enabled: true, clientName: 'routerClientId', allowedClientIds: [] };
    const badClientRes = await call('/api/auth/onelink/start', { body: { intent: 'login' } });
    expect(badClientRes.status).toBe(503);
    expect(await badClientRes.json()).toMatchObject({ code: 'AUTH_UNAVAILABLE' });
    const afterBadClient = Number(
      (
        await pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "mioOneLinkPending"',
        )
      ).rows[0]!.count,
    );
    expect(afterBadClient).toBe(beforeBadClient);
    policy = {
      enabled: true,
      clientName: 'miioo',
      allowedClientIds: resolveAllowedOneLinkClientIds('miioo', 'miiooClientId', null),
    };

    // HTTPS baseURL emits __Secure-mio.onelink_pending with Secure attribute.
    const httpsOrigin = 'https://mio-https.example.test';
    const httpsConfig = readAuthConfig({
      MIO_AUTH_BASE_URL: httpsOrigin,
      MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
      MIO_AUTH_DATABASE_URL: database.url,
    })!;
    const httpsAuth = await createAuthentication(httpsConfig, undefined, undefined, undefined, {
      config: oneLinkConfig,
      getPolicy: () => policy,
    });
    try {
      const httpsRes = await httpsAuth.handler(
        new Request(`${httpsOrigin}/api/auth/onelink/start`, {
          method: 'POST',
          headers: {
            origin: httpsOrigin,
            'content-type': 'application/json',
            'x-mio-client-ip': '127.0.0.1',
          },
          body: JSON.stringify({ intent: 'login' }),
        }),
      );
      expect(httpsRes.status).toBe(200);
      const secureCookie = findSetCookie(httpsRes, '__Secure-mio.onelink_pending');
      expect(secureCookie).toBeDefined();
      expect(secureCookie).toMatch(/Secure/i);
      expect(secureCookie).toMatch(/HttpOnly/i);
      expect(secureCookie).toMatch(/Path=\/api\/auth/i);
    } finally {
      await httpsAuth.close();
    }
  });

  it('validates body keys, intent, returnPath and adapter Origin/JSON guards', async () => {
    const noOrigin = await call('/api/auth/onelink/start', {
      body: { intent: 'login' },
      origin: false,
    });
    expect(noOrigin.status).toBe(403);

    const badOrigin = await call('/api/auth/onelink/start', {
      body: { intent: 'login' },
      origin: 'https://evil.example.test',
    });
    expect(badOrigin.status).toBe(403);

    // Callback adapter rejections (403/405) always include Referrer-Policy: no-referrer & Cache-Control: no-store.
    const cbBadOrigin = await call('/api/auth/callback/onelink?unauthorized=true', {
      origin: 'https://evil.example.test',
    });
    expect(cbBadOrigin.status).toBe(403);
    expect(cbBadOrigin.headers.get('cache-control')).toBe('no-store');
    expect(cbBadOrigin.headers.get('referrer-policy')).toBe('no-referrer');

    const cbWrongMethod = await call('/api/auth/callback/onelink', {
      method: 'POST',
      body: {},
    });
    expect(cbWrongMethod.status).toBe(405);
    expect(cbWrongMethod.headers.get('cache-control')).toBe('no-store');
    expect(cbWrongMethod.headers.get('referrer-policy')).toBe('no-referrer');

    const invalidBodies: unknown[] = [
      {},
      { intent: 'other' },
      { intent: 'login', extra: true },
      { intent: 'login', returnPath: null },
      { intent: 'login', returnPath: '' },
      { intent: 'login', returnPath: `/${'a'.repeat(256)}` },
      { intent: 'login', returnPath: 'https://evil.example.test/' },
      { intent: 'login', returnPath: '//evil.example.test/' },
      { intent: 'login', returnPath: '/.//evil.example.test' },
      { intent: 'login', returnPath: '/a/..//evil.example.test' },
      { intent: 'login', returnPath: '/\\evil.example.test' },
      { intent: 'login', returnPath: '/bad\npath' },
      { intent: 'login', returnPath: '/bad\u0000path' },
      { intent: 'login', returnPath: 123 },
    ];
    for (const body of invalidBodies) {
      const res = await call('/api/auth/onelink/start', { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('enforces recent active session and unbound status for intent=bind', async () => {
    const anonRes = await call('/api/auth/onelink/start', { body: { intent: 'bind' } });
    expect(anonRes.status).toBe(401);
    expect(await anonRes.json()).toMatchObject({ code: 'SESSION_REQUIRED' });

    const user = await createEmailUser();
    const okRes = await call('/api/auth/onelink/start', {
      body: { intent: 'bind', returnPath: '/?nav=onelink-sandbox' },
      cookie: user.cookie,
    });
    expect(okRes.status).toBe(200);
    const { url } = (await okRes.json()) as { url: string };
    expect(new URL(url).searchParams.get('enc')).toBeTruthy();

    // Session older than 10 minutes is rejected.
    await pool.query(
      `UPDATE "session" SET "createdAt" = now() - interval '11 minutes' WHERE id = $1`,
      [user.sessionId],
    );
    const staleRes = await call('/api/auth/onelink/start', {
      body: { intent: 'bind' },
      cookie: user.cookie,
    });
    expect(staleRes.status).toBe(401);
    expect(await staleRes.json()).toMatchObject({ code: 'SESSION_REQUIRED' });

    // Restore fresh session, then bind an existing onelink account -> 409 ONELINK_ALREADY_BOUND.
    await pool.query(`UPDATE "session" SET "createdAt" = now() WHERE id = $1`, [user.sessionId]);
    await pool.query(
      `INSERT INTO "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
       VALUES ($1, $2, 'onelink', $3, now(), now())`,
      [randomUUID(), `sub-already-${randomUUID()}`, user.userId],
    );
    const boundRes = await call('/api/auth/onelink/start', {
      body: { intent: 'bind' },
      cookie: user.cookie,
    });
    expect(boundRes.status).toBe(409);
    expect(await boundRes.json()).toMatchObject({ code: 'ONELINK_ALREADY_BOUND' });

    // Disabled user with lingering session row is rejected and session revoked.
    const disabledUser = await createEmailUser();
    await pool.query(`UPDATE "user" SET disabled = true, "disabledAt" = now() WHERE id = $1`, [
      disabledUser.userId,
    ]);
    const disabledRes = await call('/api/auth/onelink/start', {
      body: { intent: 'bind' },
      cookie: disabledUser.cookie,
    });
    expect(disabledRes.status).toBe(401);
    expect(await disabledRes.json()).toMatchObject({ code: 'SESSION_REQUIRED' });
    const remainingSessions = await pool.query(`SELECT id FROM "session" WHERE id = $1`, [
      disabledUser.sessionId,
    ]);
    expect(remainingSessions.rowCount).toBe(0);
  });
});

describe('GET /api/auth/callback/onelink, GET /api/auth/onelink/pending and POST /api/auth/onelink/cancel', () => {
  it('handles missing/expired state, unauthorized=true and invalid/expired/router/mismatched tokens with zero writes', async () => {
    const before = await countUsersAndAccounts();

    // Missing cookie -> 303 invalid_state + security headers
    const noCookieRes = await call('/api/auth/callback/onelink?unauthorized=true', {
      origin: false,
    });
    expect(noCookieRes.status).toBe(303);
    expect(noCookieRes.headers.get('location')).toBe('/?onelink_result=invalid_state');
    expect(noCookieRes.headers.get('cache-control')).toBe('no-store');
    expect(noCookieRes.headers.get('referrer-policy')).toBe('no-referrer');
    expect(findSetCookie(noCookieRes, 'mio.onelink_pending')).toMatch(/Max-Age=0/i);

    // unauthorized=true -> 303 unauthorized + clears cookie + rejects row
    const s1 = await call('/api/auth/onelink/start', {
      body: { intent: 'login', returnPath: '/?nav=onelink-sandbox' },
    });
    const c1 = cookieHeader(s1);
    const deniedRes = await call('/api/auth/callback/onelink?unauthorized=true', {
      cookie: c1,
      origin: false,
    });
    expect(deniedRes.status).toBe(303);
    expect(deniedRes.headers.get('location')).toBe(
      '/?nav=onelink-sandbox&onelink_result=unauthorized',
    );
    expect(deniedRes.headers.get('cache-control')).toBe('no-store');
    expect(deniedRes.headers.get('referrer-policy')).toBe('no-referrer');
    expect(findSetCookie(deniedRes, 'mio.onelink_pending')).toMatch(/Max-Age=0/i);
    expect((await call('/api/auth/onelink/pending', { cookie: c1, origin: false })).status).toBe(
      404,
    );

    // Invalid tokens -> 303 invalid_token (including duplicate access_token query params and dynamic policy pinning)
    const badTokens = [
      'not-a-jwt',
      makeJwt({ client_id: 'miiooClientId', exp: futureExp() }), // missing sub
      makeJwt({ sub: 'ol-expired', client_id: 'miiooClientId', exp: futureExp(-60) }),
      makeJwt({ sub: 'ol-router', client_id: 'routerClientId', exp: futureExp() }),
      makeJwt({ sub: 'ol-wrong-cid', client_id: 'otherClientId', exp: futureExp() }),
    ];
    for (const token of badTokens) {
      const started = await call('/api/auth/onelink/start', { body: { intent: 'login' } });
      const pendingCookie = cookieHeader(started);
      const res = await call(
        `/api/auth/callback/onelink?access_token=${encodeURIComponent(token)}&refresh_token=secret-refresh`,
        { cookie: pendingCookie, origin: false },
      );
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/?onelink_result=invalid_token');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('location')).not.toContain(token);
      expect(res.headers.get('location')).not.toContain('secret-refresh');
      expect(findSetCookie(res, 'mio.onelink_pending')).toMatch(/Max-Age=0/i);
    }

    // Duplicate access_token query params are rejected as invalid_token.
    const dupStart = await call('/api/auth/onelink/start', { body: { intent: 'login' } });
    const dupCookie = cookieHeader(dupStart);
    const validTok = makeJwt({ sub: 'ol-dup-param', client_id: 'miiooClientId', exp: futureExp() });
    const dupRes = await call(
      `/api/auth/callback/onelink?access_token=${encodeURIComponent(validTok)}&access_token=${encodeURIComponent(validTok)}`,
      { cookie: dupCookie, origin: false },
    );
    expect(dupRes.status).toBe(303);
    expect(dupRes.headers.get('location')).toBe('/?onelink_result=invalid_token');
    expect(findSetCookie(dupRes, 'mio.onelink_pending')).toMatch(/Max-Age=0/i);

    // Dynamic allowedClientIds pinning takes effect immediately without restart.
    policy = {
      enabled: true,
      clientName: 'miioo',
      allowedClientIds: resolveAllowedOneLinkClientIds('miioo', 'miiooClientId', 'pinnedClientId'),
    };
    const pinnedStart = await call('/api/auth/onelink/start', { body: { intent: 'login' } });
    const pinnedRes = await call(
      `/api/auth/callback/onelink?access_token=${encodeURIComponent(validTok)}`,
      { cookie: cookieHeader(pinnedStart), origin: false },
    );
    expect(pinnedRes.status).toBe(303);
    expect(pinnedRes.headers.get('location')).toBe('/?onelink_result=invalid_token');
    policy = {
      enabled: true,
      clientName: 'miioo',
      allowedClientIds: resolveAllowedOneLinkClientIds('miioo', 'miiooClientId', null),
    };

    // Expired pending row -> 303 invalid_state
    const sExp = await call('/api/auth/onelink/start', { body: { intent: 'login' } });
    const cExp = cookieHeader(sExp);
    await pool.query(`UPDATE "mioOneLinkPending" SET "expiresAt" = now() - interval '1 minute'`);
    const expRes = await call(
      `/api/auth/callback/onelink?access_token=${encodeURIComponent(
        makeJwt({
          sub: 'ol-valid-but-expired-pending',
          client_id: 'miiooClientId',
          exp: futureExp(),
        }),
      )}`,
      { cookie: cExp, origin: false },
    );
    expect(expRes.status).toBe(303);
    expect(expRes.headers.get('location')).toBe('/?onelink_result=invalid_state');
    expect(findSetCookie(expRes, 'mio.onelink_pending')).toMatch(/Max-Age=0/i);

    const after = await countUsersAndAccounts();
    expect(after).toEqual(before);
  });

  it('logs in an already-bound active user with clean 303 redirect and blocks disabled bound users', async () => {
    const activeUser = await createEmailUser();
    const activeSub = `ol-active-${randomUUID()}`;
    await pool.query(
      `INSERT INTO "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
       VALUES ($1, $2, 'onelink', $3, now(), now())`,
      [randomUUID(), activeSub, activeUser.userId],
    );

    const startRes = await call('/api/auth/onelink/start', {
      body: { intent: 'login', returnPath: '/?nav=onelink-sandbox' },
    });
    const pendingCookie = cookieHeader(startRes);
    const accessToken = makeJwt({
      sub: activeSub,
      client_id: 'miiooClientId',
      exp: futureExp(),
    });
    const refreshToken = 'ephemeral-refresh-token-must-never-persist';
    const cbRes = await call(
      `/api/auth/callback/onelink?access_token=${encodeURIComponent(accessToken)}&refresh_token=${encodeURIComponent(refreshToken)}`,
      { cookie: pendingCookie, origin: false },
    );

    expect(cbRes.status).toBe(303);
    const location = cbRes.headers.get('location')!;
    expect(location).toBe('/?nav=onelink-sandbox&onelink_result=logged_in');
    expect(location).not.toContain(activeSub);
    expect(location).not.toContain(accessToken);
    expect(location).not.toContain(refreshToken);
    expect(cbRes.headers.get('cache-control')).toBe('no-store');
    expect(cbRes.headers.get('referrer-policy')).toBe('no-referrer');

    const sessionSetCookie = findSetCookie(cbRes, 'mio.session_token');
    expect(sessionSetCookie).toBeDefined();
    expect(findSetCookie(cbRes, 'mio.onelink_pending')).toMatch(/Max-Age=0/i);

    const meRes = await call('/api/v1/me', {
      cookie: sessionSetCookie!.split(';')[0]!,
      origin: false,
    });
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toMatchObject({ userId: activeUser.userId });

    // Replaying callback with completed pending cookie fails without issuing another session.
    const replayRes = await call(
      `/api/auth/callback/onelink?access_token=${encodeURIComponent(accessToken)}`,
      { cookie: pendingCookie, origin: false },
    );
    expect(replayRes.status).toBe(303);
    expect(replayRes.headers.get('location')).toBe(
      '/?nav=onelink-sandbox&onelink_result=invalid_state',
    );
    expect(findSetCookie(replayRes, 'mio.session_token')).toBeUndefined();

    // Ensure tokens are never stored in mioOneLinkPending.
    const storedRows = await pool.query('SELECT * FROM "mioOneLinkPending"');
    const serialized = JSON.stringify(storedRows.rows);
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain(refreshToken);
    expect(serialized).not.toContain(SYNTHETIC_ENC_KEY);

    // Disabled bound user -> 303 account_disabled and zero session issued.
    const disabledUser = await createEmailUser();
    const disabledSub = `ol-disabled-${randomUUID()}`;
    await pool.query(
      `INSERT INTO "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
       VALUES ($1, $2, 'onelink', $3, now(), now())`,
      [randomUUID(), disabledSub, disabledUser.userId],
    );
    await auth.setUserDisabled(disabledUser.userId, true);

    const disabledStart = await call('/api/auth/onelink/start', { body: { intent: 'login' } });
    const disabledPendingCookie = cookieHeader(disabledStart);
    const disabledCb = await call(
      `/api/auth/callback/onelink?access_token=${encodeURIComponent(
        makeJwt({ sub: disabledSub, client_id: 'miioo', exp: futureExp() }),
      )}`,
      { cookie: disabledPendingCookie, origin: false },
    );
    expect(disabledCb.status).toBe(303);
    expect(disabledCb.headers.get('location')).toBe('/?onelink_result=account_disabled');
    expect(findSetCookie(disabledCb, 'mio.session_token')).toBeUndefined();
    expect(findSetCookie(disabledCb, 'mio.onelink_pending')).toMatch(/Max-Age=0/i);
    const sessionsForDisabled = await pool.query(`SELECT id FROM "session" WHERE "userId" = $1`, [
      disabledUser.userId,
    ]);
    expect(sessionsForDisabled.rowCount).toBe(0);
  });

  it('stages unbound login candidate with zero user/account writes and protects it from late/concurrent callbacks', async () => {
    const before = await countUsersAndAccounts();
    const sub1 = `ol-unbound-${randomUUID()}`;
    const sub2 = `ol-late-hijack-${randomUUID()}`;

    const startRes = await call('/api/auth/onelink/start', {
      body: { intent: 'login', returnPath: '/?nav=onelink-sandbox' },
    });
    const pendingCookie = cookieHeader(startRes);

    // Before callback completes, GET /onelink/pending returns 404.
    const earlyPending = await call('/api/auth/onelink/pending', {
      cookie: pendingCookie,
      origin: false,
    });
    expect(earlyPending.status).toBe(404);
    expect(await earlyPending.json()).toMatchObject({ code: 'ONELINK_PENDING_NOT_FOUND' });

    const accessToken1 = makeJwt({ sub: sub1, client_id: 'miiooClientId', exp: futureExp() });
    const cbRes = await call(
      `/api/auth/callback/onelink?access_token=${encodeURIComponent(accessToken1)}`,
      { cookie: pendingCookie, origin: false },
    );
    expect(cbRes.status).toBe(303);
    expect(cbRes.headers.get('location')).toBe(
      '/?nav=onelink-sandbox&onelink_result=choose_account',
    );
    expect(cbRes.headers.get('location')).not.toContain(sub1);
    expect(cbRes.headers.get('cache-control')).toBe('no-store');
    expect(cbRes.headers.get('referrer-policy')).toBe('no-referrer');
    // Keeps pending cookie untouched (not cleared).
    expect(findSetCookie(cbRes, 'mio.onelink_pending')).toBeUndefined();

    // ZERO user or account rows written on GET callback!
    expect(await countUsersAndAccounts()).toEqual(before);

    const pendingRes = await call('/api/auth/onelink/pending', {
      cookie: pendingCookie,
      origin: false,
    });
    expect(pendingRes.status).toBe(200);
    const candidate = (await pendingRes.json()) as {
      status: string;
      intent: string;
      candidateToken: string;
      onelinkSub: string;
      onelinkSubMasked: string;
      clientId: string | null;
      expiresAt: string;
    };
    expect(candidate).toMatchObject({
      status: 'candidate_ready',
      intent: 'login',
      onelinkSub: sub1,
      onelinkSubMasked: `${sub1.slice(0, 3)}***${sub1.slice(-3)}`,
      clientId: 'miiooClientId',
    });
    expect(candidate.candidateToken).toMatch(/^[0-9a-f]{48}$/);
    expect(Number.isNaN(Date.parse(candidate.expiresAt))).toBe(false);
    expect(JSON.stringify(candidate)).not.toContain(accessToken1);
    expect(JSON.stringify(candidate)).not.toContain(SYNTHETIC_ENC_KEY);

    // Late duplicate callback with a different sub MUST NOT overwrite candidate or clear cookie!
    const lateCb = await call(
      `/api/auth/callback/onelink?access_token=${encodeURIComponent(
        makeJwt({ sub: sub2, client_id: 'miiooClientId', exp: futureExp() }),
      )}`,
      { cookie: pendingCookie, origin: false },
    );
    expect(lateCb.status).toBe(303);
    expect(lateCb.headers.get('location')).toBe(
      '/?nav=onelink-sandbox&onelink_result=invalid_state',
    );
    expect(findSetCookie(lateCb, 'mio.onelink_pending')).toBeUndefined();

    // Original candidate remains completely intact.
    const stillRes = await call('/api/auth/onelink/pending', {
      cookie: pendingCookie,
      origin: false,
    });
    expect(stillRes.status).toBe(200);
    const stillCandidate = (await stillRes.json()) as typeof candidate;
    expect(stillCandidate.onelinkSub).toBe(sub1);
    expect(stillCandidate.candidateToken).toBe(candidate.candidateToken);

    // Cancel rejects extra fields, then cancels pending and clears cookie.
    const badCancel = await call('/api/auth/onelink/cancel', {
      body: { unexpected: true },
      cookie: pendingCookie,
    });
    expect(badCancel.status).toBe(400);
    expect(await badCancel.json()).toMatchObject({ code: 'INVALID_INPUT' });

    const cancelRes = await call('/api/auth/onelink/cancel', {
      body: {},
      cookie: pendingCookie,
    });
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toEqual({ ok: true });
    expect(findSetCookie(cancelRes, 'mio.onelink_pending')).toMatch(/Max-Age=0/i);

    const afterCancel = await call('/api/auth/onelink/pending', {
      cookie: pendingCookie,
      origin: false,
    });
    expect(afterCancel.status).toBe(404);
    expect(await afterCancel.json()).toMatchObject({ code: 'ONELINK_PENDING_NOT_FOUND' });
    expect(await countUsersAndAccounts()).toEqual(before);
  });

  it('stages bind candidate without writing account row and enforces initiator session on callback and pending', async () => {
    const owner = await createEmailUser();
    const otherUser = await createEmailUser();
    const before = await countUsersAndAccounts();
    const bindSub = `ol-bind-cand-${randomUUID()}`;

    const startRes = await call('/api/auth/onelink/start', {
      body: { intent: 'bind', returnPath: '/?nav=onelink-sandbox' },
      cookie: owner.cookie,
    });
    expect(startRes.status).toBe(200);
    const pendingCookie = cookieHeader(startRes);

    const cbRes = await call(
      `/api/auth/callback/onelink?access_token=${encodeURIComponent(
        makeJwt({ sub: bindSub, client_id: 'miioo', exp: futureExp() }),
      )}`,
      { cookie: joinCookies(pendingCookie, owner.cookie), origin: false },
    );
    expect(cbRes.status).toBe(303);
    expect(cbRes.headers.get('location')).toBe('/?nav=onelink-sandbox&onelink_result=confirm_bind');
    expect(findSetCookie(cbRes, 'mio.onelink_pending')).toBeUndefined();

    // ZERO permanent account row written on GET!
    expect(await countUsersAndAccounts()).toEqual(before);
    const onelinkAccounts = await pool.query(
      `SELECT id FROM "account" WHERE "providerId" = 'onelink' AND "accountId" = $1`,
      [bindSub],
    );
    expect(onelinkAccounts.rowCount).toBe(0);

    // Same recent session reads pending candidate cleanly.
    const okPending = await call('/api/auth/onelink/pending', {
      cookie: joinCookies(pendingCookie, owner.cookie),
      origin: false,
    });
    expect(okPending.status).toBe(200);
    const candidate = (await okPending.json()) as {
      status: string;
      intent: string;
      onelinkSub: string;
      candidateToken: string;
    };
    expect(candidate).toMatchObject({
      status: 'candidate_ready',
      intent: 'bind',
      onelinkSub: bindSub,
    });

    // Anonymous or switched session cannot read bind candidate -> 401 SESSION_REQUIRED.
    const anonPending = await call('/api/auth/onelink/pending', {
      cookie: pendingCookie,
      origin: false,
    });
    expect(anonPending.status).toBe(401);
    expect(await anonPending.json()).toMatchObject({ code: 'SESSION_REQUIRED' });

    const switchedPending = await call('/api/auth/onelink/pending', {
      cookie: joinCookies(pendingCookie, otherUser.cookie),
      origin: false,
    });
    expect(switchedPending.status).toBe(401);
    expect(await switchedPending.json()).toMatchObject({ code: 'SESSION_REQUIRED' });

    // A second session of the SAME user is also rejected because initiatorSessionId must match.
    const secondLogin = await call('/api/auth/sign-in/email', {
      body: { email: owner.email, password: PASSWORD },
    });
    expect(secondLogin.status).toBe(200);
    const sameUserDifferentSession = await call('/api/auth/onelink/pending', {
      cookie: joinCookies(pendingCookie, cookieHeader(secondLogin)),
      origin: false,
    });
    expect(sameUserDifferentSession.status).toBe(401);
    expect(await sameUserDifferentSession.json()).toMatchObject({ code: 'SESSION_REQUIRED' });

    // Late callback after candidate_ready preserves candidate & cookie.
    const lateBindCb = await call(
      `/api/auth/callback/onelink?access_token=${encodeURIComponent(
        makeJwt({ sub: 'ol-other-sub-9999', client_id: 'miioo', exp: futureExp() }),
      )}`,
      { cookie: joinCookies(pendingCookie, owner.cookie), origin: false },
    );
    expect(lateBindCb.status).toBe(303);
    expect(lateBindCb.headers.get('location')).toBe(
      '/?nav=onelink-sandbox&onelink_result=invalid_state',
    );
    expect(findSetCookie(lateBindCb, 'mio.onelink_pending')).toBeUndefined();

    // Expired initiator session (> 10 min) is rejected on GET /onelink/pending -> 401 SESSION_REQUIRED.
    await pool.query(
      `UPDATE "session" SET "createdAt" = now() - interval '11 minutes' WHERE id = $1`,
      [owner.sessionId],
    );
    const expiredPending = await call('/api/auth/onelink/pending', {
      cookie: joinCookies(pendingCookie, owner.cookie),
      origin: false,
    });
    expect(expiredPending.status).toBe(401);
    expect(await expiredPending.json()).toMatchObject({ code: 'SESSION_REQUIRED' });

    // Bind callback when browser switched to another user -> 303 session_required + clears cookie.
    const start2 = await call('/api/auth/onelink/start', {
      body: { intent: 'bind' },
      cookie: otherUser.cookie,
    });
    expect(start2.status).toBe(200);
    const pendingCookie2 = cookieHeader(start2);
    const switchedCb = await call(
      `/api/auth/callback/onelink?access_token=${encodeURIComponent(
        makeJwt({ sub: 'ol-switched-cb-1', client_id: 'miioo', exp: futureExp() }),
      )}`,
      { cookie: joinCookies(pendingCookie2, owner.cookie), origin: false },
    );
    expect(switchedCb.status).toBe(303);
    expect(switchedCb.headers.get('location')).toBe('/?onelink_result=session_required');
    expect(findSetCookie(switchedCb, 'mio.onelink_pending')).toMatch(/Max-Age=0/i);
    expect(
      (
        await call('/api/auth/onelink/pending', {
          cookie: joinCookies(pendingCookie2, otherUser.cookie),
          origin: false,
        })
      ).status,
    ).toBe(404);
    expect(await countUsersAndAccounts()).toEqual(before);
  });

  it('handles concurrent callbacks on the same started pending row with at most one staged candidate', async () => {
    const startRes = await call('/api/auth/onelink/start', { body: { intent: 'login' } });
    const pendingCookie = cookieHeader(startRes);
    const subA = `ol-race-a-${randomUUID()}`;
    const subB = `ol-race-b-${randomUUID()}`;

    const [resA, resB] = await Promise.all([
      call(
        `/api/auth/callback/onelink?access_token=${encodeURIComponent(
          makeJwt({ sub: subA, client_id: 'miiooClientId', exp: futureExp() }),
        )}`,
        { cookie: pendingCookie, origin: false },
      ),
      call(
        `/api/auth/callback/onelink?access_token=${encodeURIComponent(
          makeJwt({ sub: subB, client_id: 'miiooClientId', exp: futureExp() }),
        )}`,
        { cookie: pendingCookie, origin: false },
      ),
    ]);

    const locations = [resA.headers.get('location'), resB.headers.get('location')].sort();
    expect(locations).toEqual([
      '/?onelink_result=choose_account',
      '/?onelink_result=invalid_state',
    ]);
    expect(findSetCookie(resA, 'mio.onelink_pending')).toBeUndefined();
    expect(findSetCookie(resB, 'mio.onelink_pending')).toBeUndefined();

    const pendingRes = await call('/api/auth/onelink/pending', {
      cookie: pendingCookie,
      origin: false,
    });
    expect(pendingRes.status).toBe(200);
    const candidate = (await pendingRes.json()) as { onelinkSub: string };
    expect([subA, subB]).toContain(candidate.onelinkSub);
  });

  it('never refreshes older sessions or swallows DB errors during bind start and pending reads', async () => {
    const user = await createEmailUser();
    const bindSub = `ol-no-refresh-${randomUUID()}`;

    // Stage a bind candidate while the session is fresh.
    const startRes = await call('/api/auth/onelink/start', {
      body: { intent: 'bind' },
      cookie: user.cookie,
    });
    expect(startRes.status).toBe(200);
    const pendingCookie = cookieHeader(startRes);
    const cbRes = await call(
      `/api/auth/callback/onelink?access_token=${encodeURIComponent(
        makeJwt({ sub: bindSub, client_id: 'miioo', exp: futureExp() }),
      )}`,
      { cookie: joinCookies(pendingCookie, user.cookie), origin: false },
    );
    expect(cbRes.status).toBe(303);
    expect(cbRes.headers.get('location')).toBe('/?onelink_result=confirm_bind');

    // Age session to 2 days old (> 1-day updateAge, still unexpired) so a refreshing lookup would extend expiresAt.
    await pool.query(
      `UPDATE "session"
       SET "createdAt" = now() - interval '2 days',
           "expiresAt" = now() + interval '5 days'
       WHERE id = $1`,
      [user.sessionId],
    );
    const beforeExpiresAt = (
      await pool.query<{ expiresAt: Date }>(`SELECT "expiresAt" FROM "session" WHERE id = $1`, [
        user.sessionId,
      ])
    ).rows[0]!.expiresAt.getTime();

    const startOld = await call('/api/auth/onelink/start', {
      body: { intent: 'bind' },
      cookie: user.cookie,
    });
    expect(startOld.status).toBe(401);
    expect(await startOld.json()).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(findSetCookie(startOld, 'mio.session_token')).toBeUndefined();

    const afterStartExpiresAt = (
      await pool.query<{ expiresAt: Date }>(`SELECT "expiresAt" FROM "session" WHERE id = $1`, [
        user.sessionId,
      ])
    ).rows[0]!.expiresAt.getTime();
    expect(afterStartExpiresAt).toBe(beforeExpiresAt);

    const pendingOld = await call('/api/auth/onelink/pending', {
      cookie: joinCookies(pendingCookie, user.cookie),
      origin: false,
    });
    expect(pendingOld.status).toBe(401);
    expect(await pendingOld.json()).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(findSetCookie(pendingOld, 'mio.session_token')).toBeUndefined();

    const afterPendingExpiresAt = (
      await pool.query<{ expiresAt: Date }>(`SELECT "expiresAt" FROM "session" WHERE id = $1`, [
        user.sessionId,
      ])
    ).rows[0]!.expiresAt.getTime();
    expect(afterPendingExpiresAt).toBe(beforeExpiresAt);

    // DB errors during bind start (getSession / userHasOneLinkAccount) return sanitized 503 AUTH_UNAVAILABLE.
    const isolatedConfig = readAuthConfig({
      MIO_AUTH_BASE_URL: origin,
      MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
      MIO_AUTH_DATABASE_URL: database.url,
    })!;
    const brokenAuth = await createAuthentication(isolatedConfig, undefined, undefined, undefined, {
      config: oneLinkConfig,
      getPolicy: () => policy,
    });
    await brokenAuth.close();
    const brokenServer = createServer(createAuthHandler(isolatedConfig, brokenAuth));
    brokenServer.listen(0, '127.0.0.1');
    await once(brokenServer, 'listening');
    const brokenAddr = brokenServer.address();
    if (!brokenAddr || typeof brokenAddr === 'string') throw new Error('missing addr');
    try {
      const dbErrRes = await fetch(`http://127.0.0.1:${brokenAddr.port}/api/auth/onelink/start`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          cookie: user.cookie,
        },
        body: JSON.stringify({ intent: 'bind' }),
      });
      expect(dbErrRes.status).toBe(503);
      const errBody = await dbErrRes.text();
      expect(errBody).toContain('AUTH_UNAVAILABLE');
      expect(errBody).not.toContain('Cannot use a pool after calling end');
    } finally {
      brokenServer.closeAllConnections();
      await new Promise<void>((resolve) => brokenServer.close(() => resolve()));
    }
  });

  it('preserves winning candidate_ready cookie and redirects invalid_state when concurrent callbacks lose the CAS race', async () => {
    const boundUser = await createEmailUser();
    const boundSub = `ol-race-bound-${randomUUID()}`;
    await pool.query(
      `INSERT INTO "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
       VALUES ($1, $2, 'onelink', $3, now(), now())`,
      [randomUUID(), boundSub, boundUser.userId],
    );

    const raceScenarios = [
      {
        name: 'unauthorized=true loses to candidate_ready',
        query: 'unauthorized=true',
      },
      {
        name: 'invalid_token loses to candidate_ready',
        query: 'access_token=not-a-valid-jwt',
      },
      {
        name: 'bound-user login loses to candidate_ready',
        query: `access_token=${encodeURIComponent(
          makeJwt({ sub: boundSub, client_id: 'miiooClientId', exp: futureExp() }),
        )}`,
      },
    ] as const;

    for (const scenario of raceScenarios) {
      const startRes = await call('/api/auth/onelink/start', {
        body: { intent: 'login', returnPath: '/?nav=onelink-sandbox' },
      });
      expect(startRes.status).toBe(200);
      const pendingCookie = cookieHeader(startRes);
      const row = (
        await pool.query<{ id: string }>(
          `SELECT id FROM "mioOneLinkPending" ORDER BY "createdAt" DESC LIMIT 1`,
        )
      ).rows[0]!;
      const winningSub = `ol-winner-${randomUUID()}`;
      const winningToken = randomBytes(24).toString('hex');

      // Hold a row-level FOR UPDATE lock while the losing callback reads status='started' and blocks on UPDATE.
      const locker = await pool.connect();
      let loserPromise: Promise<Response>;
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM "mioOneLinkPending" WHERE id = $1 FOR UPDATE', [row.id]);
        const xid = (
          await locker.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')
        ).rows[0]!.xid;

        loserPromise = call(`/api/auth/callback/onelink?${scenario.query}`, {
          cookie: pendingCookie,
          origin: false,
        });

        await vi.waitFor(
          async () => {
            const waiting = await pool.query(
              `SELECT 1 FROM pg_locks
               WHERE locktype = 'transactionid' AND transactionid::text = $1 AND NOT granted`,
              [xid],
            );
            expect(waiting.rowCount).toBeGreaterThanOrEqual(1);
          },
          { timeout: 5000, interval: 10 },
        );

        // Commit the winning started -> candidate_ready transition before releasing the lock.
        await locker.query(
          `UPDATE "mioOneLinkPending"
           SET status = 'candidate_ready',
               "candidateSub" = $2,
               "candidateClientId" = 'miiooClientId',
               "candidateToken" = $3,
               "updatedAt" = clock_timestamp()
           WHERE id = $1 AND status = 'started'`,
          [row.id, winningSub, winningToken],
        );
        await locker.query('COMMIT');
      } catch (error) {
        await locker.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        locker.release();
      }

      const loserRes = await loserPromise!;
      expect(loserRes.status, scenario.name).toBe(303);
      expect(loserRes.headers.get('location'), scenario.name).toBe(
        '/?nav=onelink-sandbox&onelink_result=invalid_state',
      );
      expect(findSetCookie(loserRes, 'mio.onelink_pending'), scenario.name).toBeUndefined();
      expect(findSetCookie(loserRes, 'mio.session_token'), scenario.name).toBeUndefined();

      // The winning candidate remains completely readable and untouched.
      const pendingRes = await call('/api/auth/onelink/pending', {
        cookie: pendingCookie,
        origin: false,
      });
      expect(pendingRes.status, scenario.name).toBe(200);
      expect(await pendingRes.json()).toMatchObject({
        status: 'candidate_ready',
        intent: 'login',
        onelinkSub: winningSub,
        candidateToken: winningToken,
      });
    }
  });
});
