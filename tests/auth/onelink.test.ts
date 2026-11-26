import { spawnSync } from 'node:child_process';
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
import type { AuthRuntimePolicy, OneLinkSsoRuntimePolicy } from '../../src/auth/config.ts';
import { createAuthHandler } from '../../src/auth/http.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import type { Authentication } from '../../src/auth/service.ts';
import type { OneLinkSsoConfig } from '../../src/integrations/onelink/sso.ts';
import { authDatabase, authTableIndexes } from '../support/auth-database.ts';

const SYNTHETIC_ENC_KEY = 'synthetic-test-only-enc-key-32ch';
const PASSWORD = 'correct-horse-onelink-test-42';
const AUTH_SECRET = randomBytes(40).toString('hex');

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let origin: string;
let server: ReturnType<typeof createServer>;
let auth: Authentication;
let policy: OneLinkSsoRuntimePolicy;
let authPolicy: AuthRuntimePolicy;
let delivered = new Map<string, string>();
let smsSendCount = 0;
let failSmsSend = false;

const smsSender = async (phone: string, code: string) => {
  smsSendCount += 1;
  delivered.set(phone, code);
  if (failSmsSend) throw new Error('synthetic sms provider outage');
};

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

async function waitForTransactionLock(xid: string) {
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
}

async function createPhoneUser(phoneNumber: string) {
  const sendRes = await call('/api/auth/phone-number/send-otp', { body: { phoneNumber } });
  expect(sendRes.status, await sendRes.clone().text()).toBe(200);
  const normalized = phoneNumber.startsWith('+86') ? phoneNumber : `+86${phoneNumber}`;
  const code = delivered.get(normalized)!;
  const verifyRes = await call('/api/auth/phone-number/verify', {
    body: { phoneNumber, code },
  });
  expect(verifyRes.status, await verifyRes.clone().text()).toBe(200);
  const sessionCookie = cookieHeader(verifyRes);
  const me = (await (await call('/api/v1/me', { cookie: sessionCookie })).json()) as {
    userId: string;
    sessionId: string;
  };
  return { ...me, phone: normalized, cookie: sessionCookie };
}

async function stageLoginCandidate(sub: string, returnPath = '/?nav=onelink-sandbox') {
  const startRes = await call('/api/auth/onelink/start', {
    body: { intent: 'login', returnPath },
  });
  expect(startRes.status).toBe(200);
  const pendingCookie = cookieHeader(startRes);
  const cbRes = await call(
    `/api/auth/callback/onelink?access_token=${encodeURIComponent(
      makeJwt({ sub, client_id: 'miiooClientId', exp: futureExp() }),
    )}`,
    { cookie: pendingCookie, origin: false },
  );
  expect(cbRes.status).toBe(303);
  expect(cbRes.headers.get('location')).toBe(`${returnPath}&onelink_result=choose_account`);
  const pendingRes = await call('/api/auth/onelink/pending', {
    cookie: pendingCookie,
    origin: false,
  });
  expect(pendingRes.status).toBe(200);
  const candidate = (await pendingRes.json()) as {
    candidateToken: string;
    onelinkSub: string;
  };
  return { pendingCookie, candidateToken: candidate.candidateToken, sub };
}

async function stageBindCandidate(
  sessionCookie: string,
  sub: string,
  returnPath = '/?nav=onelink-sandbox',
) {
  const startRes = await call('/api/auth/onelink/start', {
    body: { intent: 'bind', returnPath },
    cookie: sessionCookie,
  });
  expect(startRes.status, await startRes.clone().text()).toBe(200);
  const pendingCookie = cookieHeader(startRes);
  const cbRes = await call(
    `/api/auth/callback/onelink?access_token=${encodeURIComponent(
      makeJwt({ sub, client_id: 'miioo', exp: futureExp() }),
    )}`,
    { cookie: joinCookies(pendingCookie, sessionCookie), origin: false },
  );
  expect(cbRes.status).toBe(303);
  expect(cbRes.headers.get('location')).toBe(`${returnPath}&onelink_result=confirm_bind`);
  const pendingRes = await call('/api/auth/onelink/pending', {
    cookie: joinCookies(pendingCookie, sessionCookie),
    origin: false,
  });
  expect(pendingRes.status).toBe(200);
  const candidate = (await pendingRes.json()) as {
    candidateToken: string;
    onelinkSub: string;
  };
  return { pendingCookie, candidateToken: candidate.candidateToken, sub };
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
  authPolicy = {
    emailPasswordEnabled: true,
    smsMode: 'live',
    smsBypassCode: null,
  };

  const config = readAuthConfig({
    MIO_AUTH_BASE_URL: origin,
    MIO_AUTH_SECRET: AUTH_SECRET,
    MIO_AUTH_DATABASE_URL: database.url,
  })!;
  const migrated = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      MIO_AUTH_BASE_URL: origin,
      MIO_AUTH_SECRET: AUTH_SECRET,
      MIO_AUTH_DATABASE_URL: database.url,
    },
  });
  expect(migrated.status, migrated.stderr).toBe(0);
  auth = await createAuthentication(config, undefined, smsSender, () => authPolicy, {
    config: oneLinkConfig,
    getPolicy: () => policy,
  });
  server.on(
    'request',
    createAuthHandler(config, auth, undefined, () => authPolicy),
  );
}, 45_000);

beforeEach(async () => {
  policy = {
    enabled: true,
    clientName: 'miioo',
    allowedClientIds: resolveAllowedOneLinkClientIds('miioo', 'miiooClientId', null),
  };
  authPolicy = {
    emailPasswordEnabled: true,
    smsMode: 'live',
    smsBypassCode: null,
  };
  delivered = new Map();
  smsSendCount = 0;
  failSmsSend = false;
  await pool.query('DELETE FROM "rateLimit"');
  await pool.query('DELETE FROM "mioOneLinkPending"');
  await pool.query('DELETE FROM "mioPhoneChallenge"');
  await pool.query('DELETE FROM "mioSmsBudget"');
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

        const sendOtpRes = await fetch(`${base}/api/auth/onelink/existing/send-otp`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ phoneNumber: '13800138000' }),
        });
        expect(sendOtpRes.status).toBe(503);
        expect(await sendOtpRes.json()).toMatchObject({ code: 'ONELINK_UNAVAILABLE' });

        const completeRes = await fetch(`${base}/api/auth/onelink/complete`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'create', candidateToken: 'tok' }),
        });
        expect(completeRes.status).toBe(503);
        expect(await completeRes.json()).toMatchObject({ code: 'ONELINK_UNAVAILABLE' });
      } finally {
        unconfiguredServer.closeAllConnections();
        await new Promise<void>((resolve) => unconfiguredServer.close(() => resolve()));
        await unconfiguredAuth.close();
      }

      const indexes = await authTableIndexes(oldPool, schema, 'mioOneLinkPending');
      expect(indexes.unique('tokenDigest')).toBe(true);
      expect(indexes.has('status')).toBe(true);
      expect(indexes.has('expiresAt')).toBe(true);
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

    const sendOtpRes = await call('/api/auth/onelink/existing/send-otp', {
      body: { phoneNumber: '13800138000' },
    });
    expect(sendOtpRes.status).toBe(503);
    expect(await sendOtpRes.json()).toMatchObject({ code: 'ONELINK_UNAVAILABLE' });

    const completeRes = await call('/api/auth/onelink/complete', {
      body: { action: 'create', candidateToken: 'tok' },
    });
    expect(completeRes.status).toBe(503);
    expect(await completeRes.json()).toMatchObject({ code: 'ONELINK_UNAVAILABLE' });

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

    const profileRes = await call('/api/v1/me/profile', {
      cookie: sessionSetCookie!.split(';')[0]!,
      origin: false,
    });
    expect(profileRes.status).toBe(200);
    expect(await profileRes.json()).toMatchObject({
      userId: activeUser.userId,
      onelinkBound: true,
    });

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

        await waitForTransactionLock(xid);

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

describe('Unit 3: POST /api/auth/onelink/existing/send-otp & POST /api/auth/onelink/complete', () => {
  it('Path 2 (action=create): creates user+account atomically, supports optional phone-binding and blocks replay', async () => {
    const occupiedOwner = await createPhoneUser('13800138101');
    const sub = `ol-path2-${randomUUID()}`;
    const staged = await stageLoginCandidate(sub);

    const createRes = await call('/api/auth/onelink/complete', {
      body: { action: 'create', candidateToken: staged.candidateToken },
      cookie: staged.pendingCookie,
    });
    expect(createRes.status, await createRes.clone().text()).toBe(200);
    const created = (await createRes.json()) as {
      status: boolean;
      action: string;
      userId: string;
    };
    expect(created.status).toBe(true);
    expect(created.action).toBe('create');
    expect(created.userId).toBeTruthy();

    const sessionCookie = findSetCookie(createRes, 'mio.session_token');
    expect(sessionCookie).toBeDefined();
    expect(findSetCookie(createRes, 'mio.onelink_pending')).toMatch(/Max-Age=0/i);
    const userCookie = sessionCookie!.split(';')[0]!;

    const me = (await (await call('/api/v1/me', { cookie: userCookie })).json()) as {
      userId: string;
      sessionId: string;
    };
    expect(me.userId).toBe(created.userId);

    const profileRes = await call('/api/v1/me/profile', { cookie: userCookie });
    expect(profileRes.status).toBe(200);
    const profile = (await profileRes.json()) as {
      userId: string;
      displayId: string;
      name: string;
      avatarAssetId: string | null;
      phoneNumber: string | null;
      phoneNumberVerified: boolean;
      wechatBound: boolean;
      onelinkBound: boolean;
    };
    expect(profile).toMatchObject({
      userId: created.userId,
      name: '万联用户',
      avatarAssetId: null,
      phoneNumber: null,
      phoneNumberVerified: false,
      wechatBound: false,
      onelinkBound: true,
    });
    expect(profile.displayId).toMatch(/^miioo_\d{6}$/);

    // Verify placeholder email and no persisted upstream tokens in DB.
    const dbUser = (
      await pool.query<{ email: string; emailVerified: boolean }>(
        'SELECT email, "emailVerified" FROM "user" WHERE id = $1',
        [created.userId],
      )
    ).rows[0]!;
    expect(dbUser.email).toMatch(/^onelink-.+@auth\.mio\.invalid$/);
    expect(dbUser.emailVerified).toBe(false);
    const dbAccount = (
      await pool.query<{ accessToken: string | null; refreshToken: string | null }>(
        `SELECT "accessToken", "refreshToken" FROM "account" WHERE "userId" = $1 AND "providerId" = 'onelink'`,
        [created.userId],
      )
    ).rows[0]!;
    expect(dbAccount).toEqual({ accessToken: null, refreshToken: null });

    // PATCH /api/v1/me/profile returns onelinkBound: true.
    const patched = await call('/api/v1/me/profile', {
      method: 'PATCH',
      body: { name: '万联新用户' },
      cookie: userCookie,
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      userId: created.userId,
      name: '万联新用户',
      onelinkBound: true,
    });

    // Optional phone binding: occupied phone returns 409 PHONE_CONFLICT and preserves original owner.
    await pool.query('DELETE FROM "mioSmsBudget"');
    const occupiedSend = await call('/api/auth/phone-binding/send-otp', {
      body: { phoneNumber: '13800138101' },
      cookie: userCookie,
    });
    expect(occupiedSend.status).toBe(200);
    const occupiedConfirm = await call('/api/auth/phone-binding/confirm', {
      body: { phoneNumber: '13800138101', code: delivered.get('+8613800138101')! },
      cookie: userCookie,
    });
    expect(occupiedConfirm.status).toBe(409);
    expect(await occupiedConfirm.json()).toMatchObject({ code: 'PHONE_CONFLICT' });
    const ownerPhoneRow = (
      await pool.query<{ id: string }>('SELECT id FROM "user" WHERE "phoneNumber" = $1', [
        '+8613800138101',
      ])
    ).rows[0]!;
    expect(ownerPhoneRow.id).toBe(occupiedOwner.userId);

    // Optional phone binding: idle phone succeeds -> both phone login and OneLink login return identical userId.
    const idleSend = await call('/api/auth/phone-binding/send-otp', {
      body: { phoneNumber: '13800138102' },
      cookie: userCookie,
    });
    expect(idleSend.status).toBe(200);
    const idleConfirm = await call('/api/auth/phone-binding/confirm', {
      body: { phoneNumber: '13800138102', code: delivered.get('+8613800138102')! },
      cookie: userCookie,
    });
    expect(idleConfirm.status).toBe(200);

    await pool.query('DELETE FROM "mioSmsBudget"');
    const phoneSend = await call('/api/auth/phone-number/send-otp', {
      body: { phoneNumber: '13800138102' },
    });
    expect(phoneSend.status).toBe(200);
    const phoneLogin = await call('/api/auth/phone-number/verify', {
      body: { phoneNumber: '13800138102', code: delivered.get('+8613800138102')! },
    });
    expect(phoneLogin.status).toBe(200);
    const phoneMe = (await (
      await call('/api/v1/me', { cookie: cookieHeader(phoneLogin) })
    ).json()) as { userId: string };
    expect(phoneMe.userId).toBe(created.userId);

    // Subsequent OneLink login directly lands on the exact same userId (Path 1).
    const startAgain = await call('/api/auth/onelink/start', { body: { intent: 'login' } });
    const cbAgain = await call(
      `/api/auth/callback/onelink?access_token=${encodeURIComponent(
        makeJwt({ sub, client_id: 'miiooClientId', exp: futureExp() }),
      )}`,
      { cookie: cookieHeader(startAgain), origin: false },
    );
    expect(cbAgain.status).toBe(303);
    expect(cbAgain.headers.get('location')).toBe('/?onelink_result=logged_in');
    const olMe = (await (
      await call('/api/v1/me', {
        cookie: findSetCookie(cbAgain, 'mio.session_token')!.split(';')[0]!,
      })
    ).json()) as { userId: string };
    expect(olMe.userId).toBe(created.userId);

    // Replay of completed create using the preserved old pending cookie -> 409 with zero new rows or sessions.
    const countsBeforeReplay = await countUsersAndAccounts();
    const sessionsBeforeReplay = Number(
      (await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM "session"'))
        .rows[0]!.count,
    );
    const replayRes = await call('/api/auth/onelink/complete', {
      body: { action: 'create', candidateToken: staged.candidateToken },
      cookie: staged.pendingCookie,
    });
    expect(replayRes.status).toBe(409);
    expect(await replayRes.json()).toMatchObject({ code: 'ONELINK_PENDING_ALREADY_COMPLETED' });
    expect(findSetCookie(replayRes, 'mio.session_token')).toBeUndefined();
    expect(await countUsersAndAccounts()).toEqual(countsBeforeReplay);
    const sessionsAfterReplay = Number(
      (await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM "session"'))
        .rows[0]!.count,
    );
    expect(sessionsAfterReplay).toBe(sessionsBeforeReplay);
  });

  it('Path 3 (link_existing): supports live/bypass/disabled smsMode, prevents enumeration/auto-create, and links existing phone user', async () => {
    const existingPhone = '13800138201';
    const unregisteredPhone = '13800138202';
    const bypassOnlyPhone = '13800138209';
    const existingUser = await createPhoneUser(existingPhone);
    const bypassExistingUser = await createPhoneUser(bypassOnlyPhone);
    const preProfile = (await (
      await call('/api/v1/me/profile', { cookie: existingUser.cookie })
    ).json()) as { onelinkBound: boolean };
    expect(preProfile.onelinkBound).toBe(false);

    // 1. Without real SMS configured: smsMode='live' returns 503, smsMode='bypass' with null code fails closed 503,
    //    and smsMode='bypass' with valid 6-digit code skips real SMS, prevents auto-create, and links existing phone user.
    const noSmsConfig = readAuthConfig({
      MIO_AUTH_BASE_URL: origin,
      MIO_AUTH_SECRET: AUTH_SECRET,
      MIO_AUTH_DATABASE_URL: database.url,
    })!;
    let noSmsPolicy: AuthRuntimePolicy = {
      emailPasswordEnabled: true,
      smsMode: 'live',
      smsBypassCode: '654321',
    };
    const noSmsAuth = await createAuthentication(
      noSmsConfig,
      undefined,
      undefined,
      () => noSmsPolicy,
      { config: oneLinkConfig, getPolicy: () => policy },
    );
    const noSmsServer = createServer(
      createAuthHandler(noSmsConfig, noSmsAuth, undefined, () => noSmsPolicy),
    );
    noSmsServer.listen(0, '127.0.0.1');
    await once(noSmsServer, 'listening');
    const noSmsAddr = noSmsServer.address();
    if (!noSmsAddr || typeof noSmsAddr === 'string') throw new Error('missing addr');
    const noSmsBase = `http://127.0.0.1:${noSmsAddr.port}`;
    try {
      const stagedForNoSms = await stageLoginCandidate(`ol-nosms-${randomUUID()}`);
      const completeWithoutSms = (code: string, phoneNumber = bypassOnlyPhone) =>
        fetch(`${noSmsBase}/api/auth/onelink/complete`, {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            cookie: stagedForNoSms.pendingCookie,
          },
          body: JSON.stringify({
            action: 'link_existing',
            candidateToken: stagedForNoSms.candidateToken,
            phoneNumber,
            code,
          }),
        });
      const noSmsLiveSend = await fetch(`${noSmsBase}/api/auth/onelink/existing/send-otp`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          cookie: stagedForNoSms.pendingCookie,
        },
        body: JSON.stringify({ phoneNumber: bypassOnlyPhone }),
      });
      expect(noSmsLiveSend.status).toBe(503);
      expect(await noSmsLiveSend.json()).toMatchObject({ code: 'SMS_UNAVAILABLE' });

      noSmsPolicy = { emailPasswordEnabled: true, smsMode: 'bypass', smsBypassCode: null };
      const noSmsMalformedSend = await fetch(`${noSmsBase}/api/auth/onelink/existing/send-otp`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          cookie: stagedForNoSms.pendingCookie,
        },
        body: JSON.stringify({ phoneNumber: bypassOnlyPhone }),
      });
      expect(noSmsMalformedSend.status).toBe(503);
      expect(await noSmsMalformedSend.json()).toMatchObject({ code: 'SMS_UNAVAILABLE' });

      const noSmsMalformedComplete = await completeWithoutSms('654321');
      expect(noSmsMalformedComplete.status).toBe(503);
      expect(await noSmsMalformedComplete.json()).toMatchObject({ code: 'SMS_UNAVAILABLE' });

      noSmsPolicy = { emailPasswordEnabled: true, smsMode: 'bypass', smsBypassCode: '654321' };
      const noSmsBypassSend = await fetch(`${noSmsBase}/api/auth/onelink/existing/send-otp`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          cookie: stagedForNoSms.pendingCookie,
        },
        body: JSON.stringify({ phoneNumber: bypassOnlyPhone }),
      });
      expect(noSmsBypassSend.status).toBe(200);
      expect(await noSmsBypassSend.json()).toEqual({ status: true });

      const noSmsWrongCode = await completeWithoutSms('000000');
      expect(noSmsWrongCode.status).toBe(400);
      expect(await noSmsWrongCode.json()).toMatchObject({ code: 'INVALID_OTP' });

      // A bypass code without a pending-and-phone-scoped send cannot prove any target account.
      const beforeNoSmsUnreg = await countUsersAndAccounts();
      const noSmsUnreg = await completeWithoutSms('654321', unregisteredPhone);
      expect(noSmsUnreg.status).toBe(400);
      expect(await noSmsUnreg.json()).toMatchObject({ code: 'INVALID_OTP' });
      expect(await countUsersAndAccounts()).toEqual(beforeNoSmsUnreg);

      const noSmsBypassOk = await completeWithoutSms('654321');
      expect(noSmsBypassOk.status).toBe(200);
      expect(await noSmsBypassOk.json()).toEqual({
        status: true,
        action: 'link_existing',
        userId: bypassExistingUser.userId,
      });
    } finally {
      noSmsServer.closeAllConnections();
      await new Promise<void>((resolve) => noSmsServer.close(() => resolve()));
      await noSmsAuth.close();
    }

    // 2. With real SMS configured + smsMode='disabled': returns 503 SMS_UNAVAILABLE and never invokes sender.
    await pool.query('DELETE FROM "mioSmsBudget"');
    await pool.query('DELETE FROM "rateLimit"');
    smsSendCount = 0;
    const sub = `ol-path3-${randomUUID()}`;
    const staged = await stageLoginCandidate(sub);

    authPolicy = { emailPasswordEnabled: true, smsMode: 'disabled', smsBypassCode: '654321' };
    const disabledSend = await call('/api/auth/onelink/existing/send-otp', {
      body: { phoneNumber: existingPhone },
      cookie: staged.pendingCookie,
    });
    expect(disabledSend.status).toBe(503);
    expect(await disabledSend.json()).toMatchObject({ code: 'SMS_UNAVAILABLE' });
    const disabledComplete = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: staged.candidateToken,
        phoneNumber: existingPhone,
        code: '654321',
      },
      cookie: staged.pendingCookie,
    });
    expect(disabledComplete.status).toBe(503);
    expect(await disabledComplete.json()).toMatchObject({ code: 'SMS_UNAVAILABLE' });
    expect(smsSendCount).toBe(0);

    // 2b. With real SMS configured + smsMode='bypass': skips real SMS sender & persistent budget completely.
    authPolicy = { emailPasswordEnabled: true, smsMode: 'bypass', smsBypassCode: '654321' };
    const bypassSendWithSms = await call('/api/auth/onelink/existing/send-otp', {
      body: { phoneNumber: existingPhone },
      cookie: staged.pendingCookie,
    });
    expect(bypassSendWithSms.status).toBe(200);
    expect(await bypassSendWithSms.json()).toEqual({ status: true });
    expect(smsSendCount).toBe(0);
    expect(
      Number(
        (await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM "mioSmsBudget"'))
          .rows[0]!.count,
      ),
    ).toBe(0);

    // 3. With real SMS configured + smsMode='live': sends real SMS, debits persistent budget and rejects fixed code!
    authPolicy = { emailPasswordEnabled: true, smsMode: 'live', smsBypassCode: '654321' };
    const unregSend = await call('/api/auth/onelink/existing/send-otp', {
      body: { phoneNumber: unregisteredPhone },
      cookie: staged.pendingCookie,
    });
    expect(unregSend.status).toBe(200);
    expect(await unregSend.json()).toEqual({ status: true });
    expect(smsSendCount).toBe(1);
    const budgetCount = Number(
      (await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM "mioSmsBudget"'))
        .rows[0]!.count,
    );
    expect(budgetCount).toBeGreaterThan(0);

    // Unregistered phone returns 404 EXISTING_PHONE_NOT_FOUND with ZERO users/accounts created and pending stays reusable!
    const beforeUnreg = await countUsersAndAccounts();
    const unregCode = delivered.get(`+86${unregisteredPhone}`)!;
    const unregComplete = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: staged.candidateToken,
        phoneNumber: unregisteredPhone,
        code: unregCode,
      },
      cookie: staged.pendingCookie,
    });
    expect(unregComplete.status).toBe(404);
    expect(await unregComplete.json()).toMatchObject({ code: 'EXISTING_PHONE_NOT_FOUND' });
    expect(findSetCookie(unregComplete, 'mio.onelink_pending')).toBeUndefined();
    expect(await countUsersAndAccounts()).toEqual(beforeUnreg);

    // Unverified phone user in DB is also rejected as 404 EXISTING_PHONE_NOT_FOUND with zero writes.
    const unverifiedPhone = '13800138203';
    await pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "phoneNumber", "phoneNumberVerified", "createdAt", "updatedAt")
       VALUES ($1, 'Unverified', $2, false, $3, false, now(), now())`,
      [randomUUID(), `unverified-${randomUUID()}@example.test`, `+86${unverifiedPhone}`],
    );
    const unverifiedSend = await call('/api/auth/onelink/existing/send-otp', {
      body: { phoneNumber: unverifiedPhone },
      cookie: staged.pendingCookie,
    });
    expect(unverifiedSend.status).toBe(200);
    const beforeUnverified = await countUsersAndAccounts();
    const unverifiedComplete = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: staged.candidateToken,
        phoneNumber: unverifiedPhone,
        code: delivered.get(`+86${unverifiedPhone}`)!,
      },
      cookie: staged.pendingCookie,
    });
    expect(unverifiedComplete.status).toBe(404);
    expect(await unverifiedComplete.json()).toMatchObject({ code: 'EXISTING_PHONE_NOT_FOUND' });
    expect(findSetCookie(unverifiedComplete, 'mio.onelink_pending')).toBeUndefined();
    expect(await countUsersAndAccounts()).toEqual(beforeUnverified);

    // Now reuse the SAME pending row for the verified existing phone in live mode!
    const realSend = await call('/api/auth/onelink/existing/send-otp', {
      body: { phoneNumber: existingPhone },
      cookie: staged.pendingCookie,
    });
    expect(realSend.status).toBe(200);
    const realCode = delivered.get(`+86${existingPhone}`)!;
    const bypassProbeCode = realCode === '654321' ? '000000' : '654321';

    // Fixed bypass code is rejected in live mode and preserves pending cookie for retry!
    const bypassAttempt = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: staged.candidateToken,
        phoneNumber: existingPhone,
        code: bypassProbeCode,
      },
      cookie: staged.pendingCookie,
    });
    expect(bypassAttempt.status).toBe(400);
    expect(await bypassAttempt.json()).toMatchObject({ code: 'INVALID_OTP' });
    expect(findSetCookie(bypassAttempt, 'mio.onelink_pending')).toBeUndefined();

    // Pre-check candidateToken BEFORE consuming OTP: wrong candidateToken returns 400 ONELINK_PENDING_INVALID without consuming the OTP!
    const badTokenAttempt = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: 'wrong-candidate-token',
        phoneNumber: existingPhone,
        code: realCode,
      },
      cookie: staged.pendingCookie,
    });
    expect(badTokenAttempt.status).toBe(400);
    expect(await badTokenAttempt.json()).toMatchObject({ code: 'ONELINK_PENDING_INVALID' });

    // Right candidateToken + realCode succeeds and logs into exact existingUser.userId!
    const usersBeforeLink = (await countUsersAndAccounts()).users;
    const okLink = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: staged.candidateToken,
        phoneNumber: existingPhone,
        code: realCode,
      },
      cookie: staged.pendingCookie,
    });
    expect(okLink.status, await okLink.clone().text()).toBe(200);
    expect(await okLink.json()).toEqual({
      status: true,
      action: 'link_existing',
      userId: existingUser.userId,
    });
    expect(findSetCookie(okLink, 'mio.onelink_pending')).toMatch(/Max-Age=0/i);
    const linkedSessionCookie = findSetCookie(okLink, 'mio.session_token')!.split(';')[0]!;
    expect((await countUsersAndAccounts()).users).toBe(usersBeforeLink);

    const linkedProfile = (await (
      await call('/api/v1/me/profile', { cookie: linkedSessionCookie })
    ).json()) as { userId: string; phoneNumber: string; onelinkBound: boolean };
    expect(linkedProfile).toMatchObject({
      userId: existingUser.userId,
      phoneNumber: `+86${existingPhone}`,
      onelinkBound: true,
    });

    // Replay of completed link_existing returns 409 ONELINK_PENDING_ALREADY_COMPLETED.
    const replayLink = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: staged.candidateToken,
        phoneNumber: existingPhone,
        code: realCode,
      },
      cookie: staged.pendingCookie,
    });
    expect(replayLink.status).toBe(409);
    expect(await replayLink.json()).toMatchObject({ code: 'ONELINK_PENDING_ALREADY_COMPLETED' });
    expect(findSetCookie(replayLink, 'mio.session_token')).toBeUndefined();

    // 4. Disabled existing phone user -> 403 ACCOUNT_DISABLED with zero account row written.
    authPolicy = { emailPasswordEnabled: true, smsMode: 'live', smsBypassCode: null };
    const disabledPhone = '13800138204';
    const disabledUser = await createPhoneUser(disabledPhone);
    await auth.setUserDisabled(disabledUser.userId, true);
    await pool.query('DELETE FROM "mioSmsBudget"');
    const disabledStaged = await stageLoginCandidate(`ol-disabled-link-${randomUUID()}`);
    expect(
      (
        await call('/api/auth/onelink/existing/send-otp', {
          body: { phoneNumber: disabledPhone },
          cookie: disabledStaged.pendingCookie,
        })
      ).status,
    ).toBe(200);
    const disabledLinkRes = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: disabledStaged.candidateToken,
        phoneNumber: disabledPhone,
        code: delivered.get(`+86${disabledPhone}`)!,
      },
      cookie: disabledStaged.pendingCookie,
    });
    expect(disabledLinkRes.status).toBe(403);
    expect(await disabledLinkRes.json()).toMatchObject({ code: 'ACCOUNT_DISABLED' });
    expect(findSetCookie(disabledLinkRes, 'mio.session_token')).toBeUndefined();
    const disabledAccounts = await pool.query(
      `SELECT id FROM "account" WHERE "userId" = $1 AND "providerId" = 'onelink'`,
      [disabledUser.userId],
    );
    expect(disabledAccounts.rowCount).toBe(0);

    // 5. Conflict when target phone user ALREADY has another OneLink sub -> 409 ONELINK_ALREADY_BOUND preserving original sub.
    await pool.query('DELETE FROM "mioSmsBudget"');
    const secondSubStaged = await stageLoginCandidate(`ol-second-sub-${randomUUID()}`);
    expect(
      (
        await call('/api/auth/onelink/existing/send-otp', {
          body: { phoneNumber: existingPhone },
          cookie: secondSubStaged.pendingCookie,
        })
      ).status,
    ).toBe(200);
    const alreadyBoundUserRes = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: secondSubStaged.candidateToken,
        phoneNumber: existingPhone,
        code: delivered.get(`+86${existingPhone}`)!,
      },
      cookie: secondSubStaged.pendingCookie,
    });
    expect(alreadyBoundUserRes.status).toBe(409);
    expect(await alreadyBoundUserRes.json()).toMatchObject({ code: 'ONELINK_ALREADY_BOUND' });
    const preservedSub = (
      await pool.query<{ accountId: string }>(
        `SELECT "accountId" FROM "account" WHERE "userId" = $1 AND "providerId" = 'onelink'`,
        [existingUser.userId],
      )
    ).rows[0]!;
    expect(preservedSub.accountId).toBe(sub);

    // 6. Conflict when candidate sub ALREADY belongs to another user -> 409 ONELINK_ALREADY_BOUND preserving original owner.
    await pool.query('DELETE FROM "rateLimit"');
    await pool.query('DELETE FROM "mioSmsBudget"');
    const unboundTargetPhone = '13800138205';
    const unboundTarget = await createPhoneUser(unboundTargetPhone);
    const claimedSub = `ol-claimed-by-other-${randomUUID()}`;
    const stagedBeforeClaim = await stageLoginCandidate(claimedSub);
    const originalOwner = await createEmailUser();
    await pool.query(
      `INSERT INTO "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
       VALUES ($1, $2, 'onelink', $3, now(), now())`,
      [randomUUID(), claimedSub, originalOwner.userId],
    );
    await pool.query('DELETE FROM "mioSmsBudget"');
    expect(
      (
        await call('/api/auth/onelink/existing/send-otp', {
          body: { phoneNumber: unboundTargetPhone },
          cookie: stagedBeforeClaim.pendingCookie,
        })
      ).status,
    ).toBe(200);
    const subClaimConflictRes = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: stagedBeforeClaim.candidateToken,
        phoneNumber: unboundTargetPhone,
        code: delivered.get(`+86${unboundTargetPhone}`)!,
      },
      cookie: stagedBeforeClaim.pendingCookie,
    });
    expect(subClaimConflictRes.status).toBe(409);
    expect(await subClaimConflictRes.json()).toMatchObject({ code: 'ONELINK_ALREADY_BOUND' });
    const preservedOwnerRow = (
      await pool.query<{ userId: string }>(
        `SELECT "userId" FROM "account" WHERE "providerId" = 'onelink' AND "accountId" = $1`,
        [claimedSub],
      )
    ).rows[0]!;
    expect(preservedOwnerRow.userId).toBe(originalOwner.userId);
    const unboundTargetProfile = (await (
      await call('/api/v1/me/profile', { cookie: unboundTarget.cookie })
    ).json()) as { onelinkBound: boolean };
    expect(unboundTargetProfile.onelinkBound).toBe(false);
  });

  it('enforces onelink_existing OTP 3-attempt lock, cross-purpose/cross-pending isolation, rate limits and send validation', async () => {
    const phone = '13800138301';
    const existing = await createPhoneUser(phone);
    await pool.query('DELETE FROM "mioSmsBudget"');

    const pendingA = await stageLoginCandidate(`ol-iso-a-${randomUUID()}`);
    const pendingB = await stageLoginCandidate(`ol-iso-b-${randomUUID()}`);

    // Validation on existing/send-otp: extra keys, missing cookie, bind pending.
    const extraKeyRes = await call('/api/auth/onelink/existing/send-otp', {
      body: { phoneNumber: phone, userId: existing.userId },
      cookie: pendingA.pendingCookie,
    });
    expect(extraKeyRes.status).toBe(400);
    expect(await extraKeyRes.json()).toMatchObject({ code: 'INVALID_INPUT' });

    const missingCookieSend = await call('/api/auth/onelink/existing/send-otp', {
      body: { phoneNumber: phone },
    });
    expect(missingCookieSend.status).toBe(404);
    expect(await missingCookieSend.json()).toMatchObject({ code: 'ONELINK_PENDING_NOT_FOUND' });

    const bindOwner = await createEmailUser();
    const bindPending = await stageBindCandidate(bindOwner.cookie, `ol-bind-send-${randomUUID()}`);
    const bindSendAttempt = await call('/api/auth/onelink/existing/send-otp', {
      body: { phoneNumber: phone },
      cookie: bindPending.pendingCookie,
    });
    expect(bindSendAttempt.status).toBe(400);
    expect(await bindSendAttempt.json()).toMatchObject({ code: 'ONELINK_PENDING_INVALID' });

    // Cross-purpose: login OTP cannot be used for link_existing.
    expect(
      (await call('/api/auth/phone-number/send-otp', { body: { phoneNumber: phone } })).status,
    ).toBe(200);
    const loginOtp = delivered.get(`+86${phone}`)!;
    const loginReplay = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: pendingA.candidateToken,
        phoneNumber: phone,
        code: loginOtp,
      },
      cookie: pendingA.pendingCookie,
    });
    expect(loginReplay.status).toBe(400);
    expect(await loginReplay.json()).toMatchObject({ code: 'INVALID_OTP' });

    // Cross-purpose: bind OTP cannot be used for link_existing.
    await pool.query('DELETE FROM "mioSmsBudget"');
    expect(
      (
        await call('/api/auth/phone-binding/send-otp', {
          body: { phoneNumber: phone },
          cookie: bindOwner.cookie,
        })
      ).status,
    ).toBe(200);
    const bindOtp = delivered.get(`+86${phone}`)!;
    const bindReplay = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: pendingA.candidateToken,
        phoneNumber: phone,
        code: bindOtp,
      },
      cookie: pendingA.pendingCookie,
    });
    expect(bindReplay.status).toBe(400);
    expect(await bindReplay.json()).toMatchObject({ code: 'INVALID_OTP' });

    // Send onelink_existing OTP for Pending A -> immediate resend hits 429 SMS_RATE_LIMITED (60s cooldown).
    await pool.query('DELETE FROM "mioSmsBudget"');
    expect(
      (
        await call('/api/auth/onelink/existing/send-otp', {
          body: { phoneNumber: phone },
          cookie: pendingA.pendingCookie,
        })
      ).status,
    ).toBe(200);
    const otpA = delivered.get(`+86${phone}`)!;

    const cooldownRes = await call('/api/auth/onelink/existing/send-otp', {
      body: { phoneNumber: phone },
      cookie: pendingA.pendingCookie,
    });
    expect(cooldownRes.status).toBe(429);
    expect(await cooldownRes.json()).toMatchObject({ code: 'SMS_RATE_LIMITED' });

    // Cross-purpose reverse: onelink_existing OTP cannot be used on /phone-number/verify.
    const reverseReplay = await call('/api/auth/phone-number/verify', {
      body: { phoneNumber: phone, code: otpA },
    });
    expect(reverseReplay.status).toBe(400);
    expect(await reverseReplay.json()).toMatchObject({ code: 'INVALID_OTP' });

    // Cross-pending isolation: Pending A's OTP rejected on Pending B, and Pending B's send does NOT overwrite Pending A's challenge!
    const crossPendingReplay = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: pendingB.candidateToken,
        phoneNumber: phone,
        code: otpA,
      },
      cookie: pendingB.pendingCookie,
    });
    expect(crossPendingReplay.status).toBe(400);
    expect(await crossPendingReplay.json()).toMatchObject({ code: 'INVALID_OTP' });

    await pool.query('DELETE FROM "mioSmsBudget"');
    expect(
      (
        await call('/api/auth/onelink/existing/send-otp', {
          body: { phoneNumber: phone },
          cookie: pendingB.pendingCookie,
        })
      ).status,
    ).toBe(200);
    const otpB = delivered.get(`+86${phone}`)!;

    // 3 wrong attempts on Pending B lock/delete ONLY Pending B's challenge; 4th try with right otpB fails.
    const wrongCodeB = otpB === '999999' ? '888888' : '999999';
    for (let i = 0; i < 3; i += 1) {
      const badTry = await call('/api/auth/onelink/complete', {
        body: {
          action: 'link_existing',
          candidateToken: pendingB.candidateToken,
          phoneNumber: phone,
          code: wrongCodeB,
        },
        cookie: pendingB.pendingCookie,
      });
      expect(badTry.status).toBe(400);
      expect(await badTry.json()).toMatchObject({ code: 'INVALID_OTP' });
    }
    const lockedOutTry = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: pendingB.candidateToken,
        phoneNumber: phone,
        code: otpB,
      },
      cookie: pendingB.pendingCookie,
    });
    expect(lockedOutTry.status).toBe(400);
    expect(await lockedOutTry.json()).toMatchObject({ code: 'INVALID_OTP' });

    // Pending A's challenge remained completely intact despite Pending B's send & 3-attempt deletion!
    const okPendingA = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: pendingA.candidateToken,
        phoneNumber: phone,
        code: otpA,
      },
      cookie: pendingA.pendingCookie,
    });
    expect(okPendingA.status, await okPendingA.clone().text()).toBe(200);
    expect(await okPendingA.json()).toEqual({
      status: true,
      action: 'link_existing',
      userId: existing.userId,
    });

    // Calling existing/send-otp on an already-completed pending returns 409 ONELINK_PENDING_ALREADY_COMPLETED.
    const sendOnCompleted = await call('/api/auth/onelink/existing/send-otp', {
      body: { phoneNumber: phone },
      cookie: pendingA.pendingCookie,
    });
    expect(sendOnCompleted.status).toBe(409);
    expect(await sendOnCompleted.json()).toMatchObject({
      code: 'ONELINK_PENDING_ALREADY_COMPLETED',
    });

    // Sender outage returns 503 SMS_UNAVAILABLE and leaves challenge unactivated (cannot be consumed).
    await pool.query('DELETE FROM "mioSmsBudget"');
    const outagePending = await stageLoginCandidate(`ol-outage-${randomUUID()}`);
    failSmsSend = true;
    const outageSend = await call('/api/auth/onelink/existing/send-otp', {
      body: { phoneNumber: '13800138309' },
      cookie: outagePending.pendingCookie,
    });
    failSmsSend = false;
    expect(outageSend.status).toBe(503);
    expect(await outageSend.json()).toMatchObject({ code: 'SMS_UNAVAILABLE' });
    const unactivatedCode = delivered.get('+8613800138309')!;
    const unactivatedTry = await call('/api/auth/onelink/complete', {
      body: {
        action: 'link_existing',
        candidateToken: outagePending.candidateToken,
        phoneNumber: '13800138309',
        code: unactivatedCode,
      },
      cookie: outagePending.pendingCookie,
    });
    expect(unactivatedTry.status).toBe(400);
    expect(await unactivatedTry.json()).toMatchObject({ code: 'INVALID_OTP' });
  });

  it('Path 4 (bind_current): preserves sessionId, supports same-user idempotency and enforces strict session/input/token checks', async () => {
    const owner = await createEmailUser();
    const otherUser = await createEmailUser();
    const sub = `ol-path4-${randomUUID()}`;

    const initialProfile = (await (
      await call('/api/v1/me/profile', { cookie: owner.cookie })
    ).json()) as { onelinkBound: boolean };
    expect(initialProfile.onelinkBound).toBe(false);

    // Stage TWO bind pendings for the same user + same sub, plus one for a different sub (to test conflict).
    const staged1 = await stageBindCandidate(owner.cookie, sub);
    const staged2 = await stageBindCandidate(owner.cookie, sub);
    const stagedDifferentSub = await stageBindCandidate(
      owner.cookie,
      `ol-path4-diff-${randomUUID()}`,
    );
    const loginStaged = await stageLoginCandidate(`ol-path4-login-wrong-intent-${randomUUID()}`);
    const before = await countUsersAndAccounts();

    // Strict input rejection: client can NEVER supply userId, sub, or unexpected fields.
    for (const badBody of [
      {},
      { action: 'bind_current' },
      { action: 'bind_current', candidateToken: '' },
      { action: 'bind_current', candidateToken: staged1.candidateToken, userId: owner.userId },
      { action: 'bind_current', candidateToken: staged1.candidateToken, sub },
      { action: 'create', candidateToken: staged1.candidateToken, sub },
      {
        action: 'link_existing',
        candidateToken: staged1.candidateToken,
        phoneNumber: '13800138000',
        code: '123456',
        userId: owner.userId,
      },
      { action: 'unknown', candidateToken: staged1.candidateToken },
    ]) {
      const res = await call('/api/auth/onelink/complete', {
        body: badBody,
        cookie: joinCookies(staged1.pendingCookie, owner.cookie),
      });
      expect(res.status, JSON.stringify(badBody)).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT' });
    }

    // Missing pending cookie -> 404 ONELINK_PENDING_NOT_FOUND.
    const noPendingCookie = await call('/api/auth/onelink/complete', {
      body: { action: 'bind_current', candidateToken: staged1.candidateToken },
      cookie: owner.cookie,
    });
    expect(noPendingCookie.status).toBe(404);
    expect(await noPendingCookie.json()).toMatchObject({ code: 'ONELINK_PENDING_NOT_FOUND' });

    // Wrong candidateToken -> 400 ONELINK_PENDING_INVALID (10th request in window).
    const badToken = await call('/api/auth/onelink/complete', {
      body: { action: 'bind_current', candidateToken: 'wrong-token' },
      cookie: joinCookies(staged1.pendingCookie, owner.cookie),
    });
    expect(badToken.status).toBe(400);
    expect(await badToken.json()).toMatchObject({ code: 'ONELINK_PENDING_INVALID' });

    // 11th request in 60s window hits the configured /onelink/complete rate limit (max: 10).
    const rateLimited = await call('/api/auth/onelink/complete', {
      body: { action: 'bind_current', candidateToken: 'wrong-token' },
      cookie: joinCookies(staged1.pendingCookie, owner.cookie),
    });
    expect(rateLimited.status).toBe(429);
    await pool.query('DELETE FROM "rateLimit"');

    // Wrong action for intent='bind' -> 400 ONELINK_PENDING_INVALID, and login pending for bind_current -> 400 ONELINK_PENDING_INVALID.
    const wrongAction = await call('/api/auth/onelink/complete', {
      body: { action: 'create', candidateToken: staged1.candidateToken },
      cookie: joinCookies(staged1.pendingCookie, owner.cookie),
    });
    expect(wrongAction.status).toBe(400);
    expect(await wrongAction.json()).toMatchObject({ code: 'ONELINK_PENDING_INVALID' });

    const loginToBindCurrent = await call('/api/auth/onelink/complete', {
      body: { action: 'bind_current', candidateToken: loginStaged.candidateToken },
      cookie: joinCookies(loginStaged.pendingCookie, owner.cookie),
    });
    expect(loginToBindCurrent.status).toBe(400);
    expect(await loginToBindCurrent.json()).toMatchObject({ code: 'ONELINK_PENDING_INVALID' });

    // Cancelled pending -> 400 ONELINK_PENDING_INVALID.
    expect(
      (await call('/api/auth/onelink/cancel', { body: {}, cookie: loginStaged.pendingCookie }))
        .status,
    ).toBe(200);
    const cancelledComplete = await call('/api/auth/onelink/complete', {
      body: { action: 'create', candidateToken: loginStaged.candidateToken },
      cookie: loginStaged.pendingCookie,
    });
    expect(cancelledComplete.status).toBe(400);
    expect(await cancelledComplete.json()).toMatchObject({ code: 'ONELINK_PENDING_INVALID' });

    // Session guards: anonymous, switched user, same-user different session, expired session (>10m, non-refreshing).
    const anonBind = await call('/api/auth/onelink/complete', {
      body: { action: 'bind_current', candidateToken: staged1.candidateToken },
      cookie: staged1.pendingCookie,
    });
    expect(anonBind.status).toBe(401);
    expect(await anonBind.json()).toMatchObject({ code: 'SESSION_REQUIRED' });

    const switchedBind = await call('/api/auth/onelink/complete', {
      body: { action: 'bind_current', candidateToken: staged1.candidateToken },
      cookie: joinCookies(staged1.pendingCookie, otherUser.cookie),
    });
    expect(switchedBind.status).toBe(401);
    expect(await switchedBind.json()).toMatchObject({ code: 'SESSION_REQUIRED' });

    const secondSessionRes = await call('/api/auth/sign-in/email', {
      body: { email: owner.email, password: PASSWORD },
    });
    const secondSessionCookie = cookieHeader(secondSessionRes);
    const diffSessionBind = await call('/api/auth/onelink/complete', {
      body: { action: 'bind_current', candidateToken: staged1.candidateToken },
      cookie: joinCookies(staged1.pendingCookie, secondSessionCookie),
    });
    expect(diffSessionBind.status).toBe(401);
    expect(await diffSessionBind.json()).toMatchObject({ code: 'SESSION_REQUIRED' });

    // Age session to 2 days old -> rejected with 401 SESSION_REQUIRED and expiresAt is NOT refreshed!
    await pool.query(
      `UPDATE "session" SET "createdAt" = now() - interval '2 days', "expiresAt" = now() + interval '5 days' WHERE id = $1`,
      [owner.sessionId],
    );
    const beforeExp = (
      await pool.query<{ expiresAt: Date }>('SELECT "expiresAt" FROM "session" WHERE id = $1', [
        owner.sessionId,
      ])
    ).rows[0]!.expiresAt.getTime();
    const expiredSessionBind = await call('/api/auth/onelink/complete', {
      body: { action: 'bind_current', candidateToken: staged1.candidateToken },
      cookie: joinCookies(staged1.pendingCookie, owner.cookie),
    });
    expect(expiredSessionBind.status).toBe(401);
    expect(await expiredSessionBind.json()).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(findSetCookie(expiredSessionBind, 'mio.session_token')).toBeUndefined();
    const afterExp = (
      await pool.query<{ expiresAt: Date }>('SELECT "expiresAt" FROM "session" WHERE id = $1', [
        owner.sessionId,
      ])
    ).rows[0]!.expiresAt.getTime();
    expect(afterExp).toBe(beforeExp);
    expect(await countUsersAndAccounts()).toEqual(before);

    // Restore fresh session and execute bind_current -> 200, writes 1 account row, preserves original sessionId!
    await pool.query('DELETE FROM "rateLimit"');
    await pool.query('UPDATE "session" SET "createdAt" = now() WHERE id = $1', [owner.sessionId]);
    const bindOk = await call('/api/auth/onelink/complete', {
      body: { action: 'bind_current', candidateToken: staged1.candidateToken },
      cookie: joinCookies(staged1.pendingCookie, owner.cookie),
    });
    expect(bindOk.status, await bindOk.clone().text()).toBe(200);
    expect(await bindOk.json()).toEqual({
      status: true,
      action: 'bind_current',
      userId: owner.userId,
    });
    expect(findSetCookie(bindOk, 'mio.onelink_pending')).toMatch(/Max-Age=0/i);
    expect(findSetCookie(bindOk, 'mio.session_token')).toBeUndefined();

    const meAfterBind = (await (await call('/api/v1/me', { cookie: owner.cookie })).json()) as {
      userId: string;
      sessionId: string;
    };
    expect(meAfterBind).toEqual({ userId: owner.userId, sessionId: owner.sessionId });
    const profileAfterBind = (await (
      await call('/api/v1/me/profile', { cookie: owner.cookie })
    ).json()) as { onelinkBound: boolean };
    expect(profileAfterBind.onelinkBound).toBe(true);

    // Replay of completed staged1 -> 409 ONELINK_PENDING_ALREADY_COMPLETED.
    const replayBind = await call('/api/auth/onelink/complete', {
      body: { action: 'bind_current', candidateToken: staged1.candidateToken },
      cookie: joinCookies(staged1.pendingCookie, owner.cookie),
    });
    expect(replayBind.status).toBe(409);
    expect(await replayBind.json()).toMatchObject({ code: 'ONELINK_PENDING_ALREADY_COMPLETED' });

    // Same-user + same-sub idempotency on staged2 -> 200 with alreadyBound: true and still strictly 1 account row!
    const idempotentBind = await call('/api/auth/onelink/complete', {
      body: { action: 'bind_current', candidateToken: staged2.candidateToken },
      cookie: joinCookies(staged2.pendingCookie, owner.cookie),
    });
    expect(idempotentBind.status, await idempotentBind.clone().text()).toBe(200);
    expect(await idempotentBind.json()).toEqual({
      status: true,
      action: 'bind_current',
      userId: owner.userId,
      alreadyBound: true,
    });
    const accountRows = await pool.query(
      `SELECT "accountId" FROM "account" WHERE "userId" = $1 AND "providerId" = 'onelink'`,
      [owner.userId],
    );
    expect(accountRows.rowCount).toBe(1);
    expect(accountRows.rows[0]!.accountId).toBe(sub);

    // Same user trying to bind a DIFFERENT sub -> 409 ONELINK_ALREADY_BOUND preserving original sub.
    const diffSubConflict = await call('/api/auth/onelink/complete', {
      body: { action: 'bind_current', candidateToken: stagedDifferentSub.candidateToken },
      cookie: joinCookies(stagedDifferentSub.pendingCookie, owner.cookie),
    });
    expect(diffSubConflict.status).toBe(409);
    expect(await diffSubConflict.json()).toMatchObject({ code: 'ONELINK_ALREADY_BOUND' });
    const afterDiffConflict = await pool.query<{ accountId: string }>(
      `SELECT "accountId" FROM "account" WHERE "userId" = $1 AND "providerId" = 'onelink'`,
      [owner.userId],
    );
    expect(afterDiffConflict.rowCount).toBe(1);
    expect(afterDiffConflict.rows[0]!.accountId).toBe(sub);

    // Disabled user with lingering session row -> 401 SESSION_REQUIRED, session deleted, zero writes.
    const disableable = await createEmailUser();
    const disableStaged = await stageBindCandidate(
      disableable.cookie,
      `ol-disabled-bind-${randomUUID()}`,
    );
    await pool.query('UPDATE "user" SET disabled = true, "disabledAt" = now() WHERE id = $1', [
      disableable.userId,
    ]);
    const disabledBindRes = await call('/api/auth/onelink/complete', {
      body: { action: 'bind_current', candidateToken: disableStaged.candidateToken },
      cookie: joinCookies(disableStaged.pendingCookie, disableable.cookie),
    });
    expect(disabledBindRes.status).toBe(401);
    expect(await disabledBindRes.json()).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(
      (await pool.query('SELECT id FROM "session" WHERE id = $1', [disableable.sessionId]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          `SELECT id FROM "account" WHERE "userId" = $1 AND "providerId" = 'onelink'`,
          [disableable.userId],
        )
      ).rowCount,
    ).toBe(0);

    // Revoked session cannot complete a staged bind_current -> 401 SESSION_REQUIRED with zero writes.
    const revokable = await createEmailUser();
    const revStaged = await stageBindCandidate(revokable.cookie, `ol-revoked-${randomUUID()}`);
    expect((await call('/api/auth/sign-out', { body: {}, cookie: revokable.cookie })).status).toBe(
      200,
    );
    const revokedRes = await call('/api/auth/onelink/complete', {
      body: { action: 'bind_current', candidateToken: revStaged.candidateToken },
      cookie: joinCookies(revStaged.pendingCookie, revokable.cookie),
    });
    expect(revokedRes.status).toBe(401);
    expect(await revokedRes.json()).toMatchObject({ code: 'SESSION_REQUIRED' });
    const revAccounts = await pool.query(
      `SELECT id FROM "account" WHERE "userId" = $1 AND "providerId" = 'onelink'`,
      [revokable.userId],
    );
    expect(revAccounts.rowCount).toBe(0);
  });

  it('handles concurrent create and concurrent bind_current for the same sub with zero orphan users and preserved ownership', async () => {
    // 1. Two concurrent action=create for the SAME sub from two independent pending logins.
    const raceCreateSub = `ol-race-create-${randomUUID()}`;
    const createA = await stageLoginCandidate(raceCreateSub);
    const createB = await stageLoginCandidate(raceCreateSub);
    const beforeCreate = await countUsersAndAccounts();

    const [resA, resB] = await Promise.all([
      call('/api/auth/onelink/complete', {
        body: { action: 'create', candidateToken: createA.candidateToken },
        cookie: createA.pendingCookie,
      }),
      call('/api/auth/onelink/complete', {
        body: { action: 'create', candidateToken: createB.candidateToken },
        cookie: createB.pendingCookie,
      }),
    ]);

    const createStatuses = [resA.status, resB.status].sort((a, b) => a - b);
    expect(createStatuses).toEqual([200, 409]);
    const createLoser = resA.status === 409 ? resA : resB;
    const createWinner = resA.status === 200 ? resA : resB;
    expect(await createLoser.json()).toMatchObject({ code: 'ONELINK_ALREADY_BOUND' });
    const winnerBody = (await createWinner.json()) as { userId: string };

    // CRITICAL: strictly +1 user and +1 account (ZERO orphan user from rolled-back loser transaction!).
    const afterCreate = await countUsersAndAccounts();
    expect(afterCreate.users).toBe(beforeCreate.users + 1);
    expect(afterCreate.accounts).toBe(beforeCreate.accounts + 1);
    const createdAcc = await pool.query<{ userId: string }>(
      `SELECT "userId" FROM "account" WHERE "providerId" = 'onelink' AND "accountId" = $1`,
      [raceCreateSub],
    );
    expect(createdAcc.rowCount).toBe(1);
    expect(createdAcc.rows[0]!.userId).toBe(winnerBody.userId);

    // 2. Two users racing action=bind_current for the SAME sub.
    const user1 = await createEmailUser();
    const user2 = await createEmailUser();
    const raceBindSub = `ol-race-bind-${randomUUID()}`;
    const bind1 = await stageBindCandidate(user1.cookie, raceBindSub);
    const bind2 = await stageBindCandidate(user2.cookie, raceBindSub);

    const [bindRes1, bindRes2] = await Promise.all([
      call('/api/auth/onelink/complete', {
        body: { action: 'bind_current', candidateToken: bind1.candidateToken },
        cookie: joinCookies(bind1.pendingCookie, user1.cookie),
      }),
      call('/api/auth/onelink/complete', {
        body: { action: 'bind_current', candidateToken: bind2.candidateToken },
        cookie: joinCookies(bind2.pendingCookie, user2.cookie),
      }),
    ]);

    const bindStatuses = [bindRes1.status, bindRes2.status].sort((a, b) => a - b);
    expect(bindStatuses).toEqual([200, 409]);
    const bindWinnerUser = bindRes1.status === 200 ? user1 : user2;
    const bindLoserUser = bindRes1.status === 200 ? user2 : user1;
    const bindLoserRes = bindRes1.status === 409 ? bindRes1 : bindRes2;
    expect(await bindLoserRes.json()).toMatchObject({ code: 'ONELINK_ALREADY_BOUND' });

    const boundOwner = await pool.query<{ userId: string }>(
      `SELECT "userId" FROM "account" WHERE "providerId" = 'onelink' AND "accountId" = $1`,
      [raceBindSub],
    );
    expect(boundOwner.rowCount).toBe(1);
    expect(boundOwner.rows[0]!.userId).toBe(bindWinnerUser.userId);

    const winnerProfile = (await (
      await call('/api/v1/me/profile', { cookie: bindWinnerUser.cookie })
    ).json()) as { onelinkBound: boolean };
    const loserProfile = (await (
      await call('/api/v1/me/profile', { cookie: bindLoserUser.cookie })
    ).json()) as { onelinkBound: boolean };
    expect(winnerProfile.onelinkBound).toBe(true);
    expect(loserProfile.onelinkBound).toBe(false);
  });

  it('enforces post-lock expiry, deadlock-free concurrent bind_current + phone-binding/confirm, and clears pending cookie on post-commit session error', async () => {
    // 1. Post-lock expiry in lockOneLinkPendingByDigest: a waiting complete sees expiry AFTER acquiring FOR UPDATE.
    const expStaged = await stageLoginCandidate(`ol-post-lock-exp-${randomUUID()}`);
    const expRow = (
      await pool.query<{ id: string }>(
        `SELECT id FROM "mioOneLinkPending" ORDER BY "createdAt" DESC LIMIT 1`,
      )
    ).rows[0]!;
    await pool.query(
      `UPDATE "mioOneLinkPending" SET "expiresAt" = clock_timestamp() + interval '250 milliseconds' WHERE id = $1`,
      [expRow.id],
    );
    const beforeExp = await countUsersAndAccounts();
    const locker = await pool.connect();
    let completeAfterLock: Promise<Response>;
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM "mioOneLinkPending" WHERE id = $1 FOR UPDATE', [
        expRow.id,
      ]);
      const xid = (await locker.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid'))
        .rows[0]!.xid;

      completeAfterLock = call('/api/auth/onelink/complete', {
        body: { action: 'create', candidateToken: expStaged.candidateToken },
        cookie: expStaged.pendingCookie,
      });

      await waitForTransactionLock(xid);

      // Hold the lock until PostgreSQL's own clock_timestamp() passes expiresAt, then release with ROLLBACK.
      await vi.waitFor(
        async () => {
          const check = (
            await pool.query<{ expired: boolean }>(
              `SELECT ("expiresAt" <= clock_timestamp()) AS expired FROM "mioOneLinkPending" WHERE id = $1`,
              [expRow.id],
            )
          ).rows[0]!;
          expect(check.expired).toBe(true);
        },
        { timeout: 5000, interval: 20 },
      );
      await locker.query('ROLLBACK');
    } catch (error) {
      await locker.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      locker.release();
    }

    const expRes = await completeAfterLock!;
    expect(expRes.status).toBe(400);
    expect(await expRes.json()).toMatchObject({ code: 'ONELINK_PENDING_INVALID' });
    expect(findSetCookie(expRes, 'mio.session_token')).toBeUndefined();
    expect(await countUsersAndAccounts()).toEqual(beforeExp);

    // 2. Concurrent bind_current + phone-binding/confirm on the same user/session completes without 40P01 deadlock.
    for (let idx = 0; idx < 3; idx += 1) {
      await pool.query('DELETE FROM "rateLimit"');
      await pool.query('DELETE FROM "mioSmsBudget"');
      const user = await createEmailUser();
      const phone = `1380013840${idx}`;
      const sub = `ol-deadlock-free-${idx}-${randomUUID()}`;
      const bindStaged = await stageBindCandidate(user.cookie, sub);
      expect(
        (
          await call('/api/auth/phone-binding/send-otp', {
            body: { phoneNumber: phone },
            cookie: user.cookie,
          })
        ).status,
      ).toBe(200);
      const otp = delivered.get(`+86${phone}`)!;

      const [oneLinkBindRes, phoneBindRes] = await Promise.all([
        call('/api/auth/onelink/complete', {
          body: { action: 'bind_current', candidateToken: bindStaged.candidateToken },
          cookie: joinCookies(bindStaged.pendingCookie, user.cookie),
        }),
        call('/api/auth/phone-binding/confirm', {
          body: { phoneNumber: phone, code: otp },
          cookie: user.cookie,
        }),
      ]);
      expect(oneLinkBindRes.status, await oneLinkBindRes.clone().text()).toBe(200);
      expect(phoneBindRes.status, await phoneBindRes.clone().text()).toBe(200);
      const profile = (await (
        await call('/api/v1/me/profile', { cookie: user.cookie })
      ).json()) as {
        phoneNumber: string | null;
        phoneNumberVerified: boolean;
        onelinkBound: boolean;
      };
      expect(profile).toMatchObject({
        phoneNumber: `+86${phone}`,
        phoneNumberVerified: true,
        onelinkBound: true,
      });
    }

    // 3. Post-commit "session" insert failure returns sanitized 503 AUTH_UNAVAILABLE and clears onelink_pending cookie.
    await pool.query('DELETE FROM "rateLimit"');
    const failSessionStaged = await stageLoginCandidate(`ol-session-fail-${randomUUID()}`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION mio_test_reject_session_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'private_session_trigger_failure_secret';
      END;
      $$;
    `);
    await pool.query(`
      CREATE TRIGGER mio_test_reject_session_insert_trg
      BEFORE INSERT ON "session"
      FOR EACH ROW EXECUTE FUNCTION mio_test_reject_session_insert();
    `);
    try {
      const failRes = await call('/api/auth/onelink/complete', {
        body: { action: 'create', candidateToken: failSessionStaged.candidateToken },
        cookie: failSessionStaged.pendingCookie,
      });
      expect(failRes.status).toBe(503);
      const bodyText = await failRes.text();
      expect(bodyText).toContain('AUTH_UNAVAILABLE');
      expect(bodyText).not.toContain('private_session_trigger_failure_secret');
      expect(findSetCookie(failRes, 'mio.onelink_pending')).toMatch(/Max-Age=0/i);
      expect(findSetCookie(failRes, 'mio.session_token')).toBeUndefined();
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS mio_test_reject_session_insert_trg ON "session"');
      await pool.query('DROP FUNCTION IF EXISTS mio_test_reject_session_insert()');
    }
  });
});
