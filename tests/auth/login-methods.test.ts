import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readAuthConfig } from '../../src/auth/config.ts';
import type { AuthRuntimePolicy, OneLinkSsoRuntimePolicy } from '../../src/auth/config.ts';
import { createAuthHandler } from '../../src/auth/http.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import type { Authentication } from '../../src/auth/service.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { ProviderStore } from '../../src/providers/store.ts';
import { authDatabase } from '../support/auth-database.ts';

const secret = randomBytes(40).toString('hex');
const password = 'login-methods-synthetic-password-23';
const nativeFetch = globalThis.fetch;
let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let server: ReturnType<typeof createServer>;
let origin: string;
let auth: Authentication;
let policy: AuthRuntimePolicy;
let oneLinkPolicy: OneLinkSsoRuntimePolicy;
let delivered = new Map<string, string>();
let fixtures = new Map<string, { openid: string; nickname: string }>();
const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; ');
const join = (...values: string[]) => values.filter(Boolean).join('; ');
function call(
  path: string,
  options: { body?: unknown; cookie?: string; method?: string; origin?: string | false } = {},
) {
  return nativeFetch(`${origin}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    redirect: 'manual',
    headers: {
      ...(options.origin === false ? {} : { origin: options.origin ?? origin }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}
async function checked(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
  return response;
}
async function me(session: string) {
  return (await (await checked(await call('/api/v1/me', { cookie: session }))).json()) as {
    userId: string;
    sessionId: string;
  };
}
async function emailUser() {
  const email = `${randomUUID()}@example.test`;
  const created = await checked(
    await call('/api/auth/sign-up/email', { body: { email, password, name: 'Owner' } }),
  );
  const session = cookie(created);
  return { ...(await me(session)), email, cookie: session };
}
async function emailLogin(email: string) {
  return cookie(
    await checked(await call('/api/auth/sign-in/email', { body: { email, password } })),
  );
}
async function phoneBind(owner: string, phone: string) {
  await checked(
    await call('/api/auth/phone-binding/send-otp', { body: { phoneNumber: phone }, cookie: owner }),
  );
  await checked(
    await call('/api/auth/phone-binding/confirm', {
      body: { phoneNumber: phone, code: delivered.get(`+86${phone}`) },
      cookie: owner,
    }),
  );
}
async function startWechat(owner?: string, qr = false) {
  const response = await checked(
    await call(
      qr ? '/api/auth/wechat/qr-session' : `/api/auth/${owner ? 'link-social' : 'sign-in/social'}`,
      {
        body: qr ? {} : { provider: 'wechat', callbackURL: '/done' },
        ...(owner ? { cookie: owner } : {}),
      },
    ),
    qr ? 201 : 200,
  );
  const result = (await response.json()) as {
    url?: string;
    authorization_url?: string;
    qrcode_id?: string;
  };
  return {
    state: new URL(result.url ?? result.authorization_url!).searchParams.get('state')!,
    cookie: cookie(response),
    id: result.qrcode_id,
  };
}
async function wxCallback(
  flow: { state: string; cookie: string },
  openid: string,
  owner = '',
  nickname = '可信微信名',
) {
  const code = randomUUID();
  fixtures.set(code, { openid, nickname });
  return call(`/api/auth/callback/wechat?${new URLSearchParams({ state: flow.state, code })}`, {
    cookie: join(flow.cookie, owner),
    origin: false,
  });
}
async function wxPending(openid: string, qr = false) {
  const flow = await startWechat(undefined, qr);
  const before = await counts();
  const response = await checked(await wxCallback(flow, openid), 302);
  expect(response.headers.get('location')).toContain('wechat_result=choose_account');
  expect(cookie(response)).not.toContain('session_token=');
  expect(await counts()).toEqual(before);
  const pendingCookie = cookie(response);
  const pending = await checked(await call('/api/auth/wechat/pending', { cookie: pendingCookie }));
  const body = (await pending.json()) as { candidateToken: string; expiresAt: string };
  return { ...flow, pendingCookie, candidateToken: body.candidateToken, response };
}
async function wxCreate(openid: string) {
  const pending = await wxPending(openid);
  const response = await checked(
    await call('/api/auth/wechat/pending/confirm', {
      body: { action: 'create', candidateToken: pending.candidateToken },
      cookie: pending.pendingCookie,
    }),
  );
  return { ...(await me(cookie(response))), cookie: cookie(response) };
}
async function bindWechat(owner: string, openid: string) {
  const response = await checked(await wxCallback(await startWechat(owner), openid, owner), 302);
  expect(response.headers.get('location')).toBe(`${origin}/done`);
}
function token(sub: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ sub, client_id: 'fixture', exp: Math.floor(Date.now() / 1000) + 3600 })}.synthetic`;
}
async function startOneLink(intent: 'bind' | 'login', owner = '') {
  return cookie(
    await checked(await call('/api/auth/onelink/start', { body: { intent }, cookie: owner })),
  );
}
async function olCallback(pendingCookie: string, sub: string, owner = '') {
  return call(`/api/auth/callback/onelink?access_token=${encodeURIComponent(token(sub))}`, {
    cookie: join(pendingCookie, owner),
    origin: false,
  });
}
async function olPending(sub: string) {
  const pendingCookie = await startOneLink('login');
  await checked(await olCallback(pendingCookie, sub), 303);
  const response = await checked(
    await call('/api/auth/onelink/pending', { cookie: pendingCookie }),
  );
  const body = (await response.json()) as { candidateToken: string };
  return { pendingCookie, candidateToken: body.candidateToken };
}
async function bindOneLink(owner: string, sub: string) {
  const pendingCookie = await startOneLink('bind', owner);
  await checked(await olCallback(pendingCookie, sub, owner), 303);
  const pending = (await (
    await checked(await call('/api/auth/onelink/pending', { cookie: join(pendingCookie, owner) }))
  ).json()) as { candidateToken: string };
  await checked(
    await call('/api/auth/onelink/complete', {
      body: { action: 'bind_current', candidateToken: pending.candidateToken },
      cookie: join(pendingCookie, owner),
    }),
  );
}
async function counts() {
  return (
    await pool.query<{ users: string; sessions: string; accounts: string }>(
      'SELECT (SELECT count(*) FROM "user")::text AS users,(SELECT count(*) FROM "session")::text AS sessions,(SELECT count(*) FROM "account")::text AS accounts',
    )
  ).rows[0]!;
}

beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server missing');
  origin = `http://127.0.0.1:${address.port}`;
  const config = readAuthConfig({
    MIO_AUTH_BASE_URL: origin,
    MIO_AUTH_SECRET: secret,
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_AUTH_WECHAT_ENABLED: 'true',
    MIO_AUTH_WECHAT_APP_ID: 'fixture-app',
    MIO_AUTH_WECHAT_APP_SECRET: 'fixture-secret',
  })!;
  const migration = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
    env: {
      MIO_AUTH_BASE_URL: origin,
      MIO_AUTH_SECRET: secret,
      MIO_AUTH_DATABASE_URL: database.url,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(migration.status, migration.stderr).toBe(0);
  await pool.query(providerSchemaSQL);
  auth = await createAuthentication(
    config,
    undefined,
    async (phone, code) => {
      delivered.set(phone, code);
    },
    () => policy,
    {
      config: {
        environment: 'test',
        encryptionKey: 'synthetic-test-only-enc-key-32ch',
        authorizeUrl: 'https://scenic.wanlian.cloud/authorize',
        registerUrl: 'https://api-test.wanlian.cloud/sso/client/register',
        clientName: 'fixture',
        appName: 'Mio',
      },
      getPolicy: () => oneLinkPolicy,
    },
  );
  server.on(
    'request',
    createAuthHandler(config, auth, undefined, () => policy),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://api.weixin.qq.com') throw new Error('unexpected external request');
    if (url.pathname === '/sns/oauth2/access_token') {
      const code = url.searchParams.get('code')!;
      return Response.json({
        access_token: `access-${code}`,
        refresh_token: `refresh-${code}`,
        openid: fixtures.get(code)?.openid,
        expires_in: 7200,
        scope: 'snsapi_login',
      });
    }
    const fixture = fixtures.get(url.searchParams.get('access_token')?.slice(7) ?? '');
    return Response.json({ ...fixture, headimgurl: 'https://avatar.example.test/test' });
  });
}, 45_000);
beforeEach(async () => {
  policy = { emailPasswordEnabled: true, smsMode: 'live', smsBypassCode: null };
  oneLinkPolicy = { enabled: true, clientName: 'fixture', allowedClientIds: ['fixture'] };
  delivered = new Map();
  fixtures = new Map();
  await pool.query(
    'TRUNCATE "user","account","session","verification","rateLimit","mioPhoneChallenge","mioSmsBudget","mioWechatQR","mioWechatPending","mioOneLinkPending" CASCADE',
  );
});
afterAll(async () => {
  vi.restoreAllMocks();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await auth?.close();
  await pool?.end();
  await database?.close();
});

it('rebinds the normalized verified phone atomically and retains both original device sessions', async () => {
  const owner = await emailUser();
  const second = await emailLogin(owner.email),
    secondIdentity = await me(second);
  await phoneBind(owner.cookie, '13800138601');
  const sent = await checked(
    await call('/api/auth/phone-rebind/send-otp', {
      body: { phoneNumber: '13800138602' },
      cookie: owner.cookie,
    }),
  );
  expect(await sent.json()).toEqual({ status: true, expiresIn: 300 });
  const code = delivered.get('+8613800138602')!;
  await checked(
    await call('/api/auth/phone-rebind/confirm', {
      body: { phoneNumber: '+8613800138602', code },
      cookie: second,
    }),
    400,
  );
  await checked(
    await call('/api/auth/phone-rebind/confirm', {
      body: { phoneNumber: '+8613800138602', code },
      cookie: owner.cookie,
    }),
  );
  expect(await me(owner.cookie)).toEqual({ userId: owner.userId, sessionId: owner.sessionId });
  expect(await me(second)).toEqual(secondIdentity);
  const profile = (await (
    await checked(await call('/api/v1/me/profile', { cookie: second }))
  ).json()) as { phoneNumber: string };
  expect(profile.phoneNumber).toBe('+8613800138602');
  await pool.query('DELETE FROM "mioSmsBudget"');
  for (const [phoneNumber, isOriginal] of [
    ['13800138601', false],
    ['13800138602', true],
  ] as const) {
    await checked(await call('/api/auth/phone-number/send-otp', { body: { phoneNumber } }));
    const response = await checked(
      await call('/api/auth/phone-number/verify', {
        body: { phoneNumber, code: delivered.get(`+86${phoneNumber}`) },
      }),
    );
    expect((await me(cookie(response))).userId === owner.userId).toBe(isOriginal);
  }
});

it('requires a recent original session and original verified phone, rejects current and occupied numbers', async () => {
  const owner = await emailUser(),
    other = await emailUser();
  await checked(
    await call('/api/auth/phone-rebind/send-otp', {
      body: { phoneNumber: '13800138603' },
      cookie: owner.cookie,
    }),
    409,
  );
  await phoneBind(owner.cookie, '13800138603');
  await phoneBind(other.cookie, '13800138604');
  for (const phoneNumber of ['13800138603', '13800138604'])
    await checked(
      await call('/api/auth/phone-rebind/send-otp', {
        body: { phoneNumber },
        cookie: owner.cookie,
      }),
      409,
    );
  await pool.query(
    'UPDATE "session" SET "createdAt"=clock_timestamp()-interval \'11 minutes\' WHERE id=$1',
    [owner.sessionId],
  );
  await checked(
    await call('/api/auth/phone-rebind/send-otp', {
      body: { phoneNumber: '13800138605' },
      cookie: owner.cookie,
    }),
    401,
  );
});

it('rejects expired, cross-purpose and stale-original-phone rebind challenges and serializes phone claims', async () => {
  const one = await emailUser(),
    two = await emailUser();
  await phoneBind(one.cookie, '13800138606');
  await phoneBind(two.cookie, '13800138607');
  const next = '13800138608';
  await checked(await call('/api/auth/phone-number/send-otp', { body: { phoneNumber: next } }));
  await checked(
    await call('/api/auth/phone-rebind/confirm', {
      body: { phoneNumber: next, code: delivered.get(`+86${next}`) },
      cookie: one.cookie,
    }),
    400,
  );
  await pool.query('DELETE FROM "mioSmsBudget"');
  await checked(
    await call('/api/auth/phone-rebind/send-otp', {
      body: { phoneNumber: next },
      cookie: one.cookie,
    }),
  );
  const firstCode = delivered.get(`+86${next}`)!;
  await pool.query(
    'UPDATE "mioPhoneChallenge" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE purpose=\'phone_rebind\'',
  );
  await checked(
    await call('/api/auth/phone-rebind/confirm', {
      body: { phoneNumber: next, code: firstCode },
      cookie: one.cookie,
    }),
    400,
  );
  await pool.query('DELETE FROM "mioSmsBudget"');
  await checked(
    await call('/api/auth/phone-rebind/send-otp', {
      body: { phoneNumber: next },
      cookie: one.cookie,
    }),
  );
  const codeOne = delivered.get(`+86${next}`)!;
  await pool.query('DELETE FROM "mioSmsBudget"');
  await checked(
    await call('/api/auth/phone-rebind/send-otp', {
      body: { phoneNumber: next },
      cookie: two.cookie,
    }),
  );
  const codeTwo = delivered.get(`+86${next}`)!;
  const results = await Promise.all([
    call('/api/auth/phone-rebind/confirm', {
      body: { phoneNumber: next, code: codeOne },
      cookie: one.cookie,
    }),
    call('/api/auth/phone-rebind/confirm', {
      body: { phoneNumber: next, code: codeTwo },
      cookie: two.cookie,
    }),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  const original = results[0]!.status === 200 ? one : two;
  await pool.query('DELETE FROM "mioSmsBudget"');
  await checked(
    await call('/api/auth/phone-rebind/send-otp', {
      body: { phoneNumber: '13800138609' },
      cookie: original.cookie,
    }),
  );
  const stale = delivered.get('+8613800138609')!;
  await pool.query('UPDATE "user" SET "phoneNumber"=$2 WHERE id=$1', [
    original.userId,
    '+8613800138699',
  ]);
  await checked(
    await call('/api/auth/phone-rebind/confirm', {
      body: { phoneNumber: '13800138609', code: stale },
      cookie: original.cookie,
    }),
    409,
  );
});

it('requires a stored send-otp challenge in bypass mode for rebind and both provider confirmations', async () => {
  const owner = await emailUser();
  await phoneBind(owner.cookie, '13800138610');
  policy = { ...policy, smsMode: 'bypass', smsBypassCode: '654321' };
  const next = '13800138611';
  await checked(
    await call('/api/auth/phone-rebind/confirm', {
      body: { phoneNumber: next, code: '654321' },
      cookie: owner.cookie,
    }),
    400,
  );
  await checked(
    await call('/api/auth/phone-rebind/send-otp', {
      body: { phoneNumber: next },
      cookie: owner.cookie,
    }),
  );
  await checked(
    await call('/api/auth/phone-rebind/confirm', {
      body: { phoneNumber: next, code: '654321' },
      cookie: owner.cookie,
    }),
  );
  for (const provider of ['wechat', 'onelink'] as const) {
    const pending =
      provider === 'wechat'
        ? await wxPending(`bypass-${provider}`)
        : await olPending(`bypass-${provider}`);
    const root = provider === 'wechat' ? '/api/auth/wechat/pending' : '/api/auth/onelink';
    const complete = provider === 'wechat' ? `${root}/confirm` : `${root}/complete`;
    const body = {
      action: 'link_existing',
      candidateToken: pending.candidateToken,
      phoneNumber: next,
      code: '654321',
    };
    await checked(await call(complete, { body, cookie: pending.pendingCookie }), 400);
    await checked(
      await call(provider === 'wechat' ? `${root}/send-otp` : `${root}/existing/send-otp`, {
        body: { phoneNumber: next },
        cookie: pending.pendingCookie,
      }),
    );
    const other =
      provider === 'wechat'
        ? await wxPending(`other-${provider}`)
        : await olPending(`other-${provider}`);
    await checked(
      await call(complete, {
        body: { ...body, candidateToken: other.candidateToken },
        cookie: other.pendingCookie,
      }),
      400,
    );
    const response = await checked(await call(complete, { body, cookie: pending.pendingCookie }));
    expect((await me(cookie(response))).userId).toBe(owner.userId);
    await checked(await call(complete, { body, cookie: pending.pendingCookie }), 409);
  }
});

it('stages social and QR WeChat logins without provisioning; original browser ownership gates pending_confirm and explicit create', async () => {
  const first = await wxPending('new-social');
  const attributes = first.response.headers
    .getSetCookie()
    .find((entry) => entry.startsWith('mio.wechat_pending='))!;
  expect(attributes).toMatch(/Path=\/api\/auth/);
  expect(attributes).toContain('HttpOnly');
  expect(attributes).toMatch(/SameSite=Lax/i);
  await checked(await call('/api/auth/wechat/pending'), 404);
  const qr = await wxPending('new-qr', true),
    path = `/api/auth/wechat/qr-session/${qr.id}/poll`;
  expect(
    await (await checked(await call(path, { cookie: join(qr.cookie, qr.pendingCookie) }))).json(),
  ).toEqual({ status: 'pending_confirm' });
  await checked(await call(path, { cookie: join(qr.cookie, first.pendingCookie) }), 401);
  await checked(
    await call('/api/auth/wechat/pending/confirm', {
      body: { action: 'create', candidateToken: first.candidateToken },
      cookie: qr.pendingCookie,
    }),
    400,
  );
  const confirmed = await checked(
    await call('/api/auth/wechat/pending/confirm', {
      body: { action: 'create', candidateToken: qr.candidateToken },
      cookie: qr.pendingCookie,
    }),
  );
  expect((await counts()).users).toBe('1');
  expect(
    await (await checked(await call(path, { cookie: join(qr.cookie, cookie(confirmed)) }))).json(),
  ).toEqual({ status: 'confirmed' });
});

it.each(['wechat', 'onelink'] as const)(
  'links a no-phone target from the same login flow with SMS disabled for %s; rejects an earlier session',
  async (provider) => {
    const owner = await emailUser();
    const pending =
      provider === 'wechat'
        ? await wxPending(`no-phone-${provider}`)
        : await olPending(`no-phone-${provider}`);
    policy = { ...policy, smsMode: 'disabled' };
    const path =
      provider === 'wechat' ? '/api/auth/wechat/pending/confirm' : '/api/auth/onelink/complete';
    const body = { action: 'link_existing', candidateToken: pending.candidateToken };
    await checked(
      await call(path, { body, cookie: join(pending.pendingCookie, owner.cookie) }),
      401,
    );
    const recent = await emailLogin(owner.email);
    const response = await checked(
      await call(path, { body, cookie: join(pending.pendingCookie, recent) }),
    );
    expect((await me(cookie(response))).userId).toBe(owner.userId);
    expect((await me(owner.cookie)).sessionId).toBe(owner.sessionId);
  },
);

it('counts only actually usable remaining methods and serializes simultaneous provider unbinds while retaining devices and credentials', async () => {
  const owner = await emailUser(),
    second = await emailLogin(owner.email);
  await bindWechat(owner.cookie, 'unlink-wx');
  await bindOneLink(owner.cookie, 'unlink-ol');
  const store = new ProviderStore(pool, {
    databaseURL: database.url,
    masterKey: randomBytes(32),
    masterKeyId: 'fixture',
  });
  await store.save(owner.userId, 0, 'synthetic-independent-key');
  for (const options of [{ origin: false as const }, { origin: 'https://evil.example.test' }])
    await checked(
      await call('/api/v1/me/wechat', { method: 'DELETE', cookie: owner.cookie, ...options }),
      403,
    );
  policy = { ...policy, emailPasswordEnabled: false, smsMode: 'disabled' };
  const results = await Promise.all(
    ['wechat', 'onelink'].map((provider) =>
      call(`/api/v1/me/${provider}`, { method: 'DELETE', cookie: owner.cookie }),
    ),
  );
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  expect((await me(owner.cookie)).sessionId).toBe(owner.sessionId);
  expect((await me(second)).userId).toBe(owner.userId);
  expect(await store.get(owner.userId)).not.toBeNull();
  const remaining = (
    await pool.query<{ providerId: string }>(
      'SELECT "providerId" FROM "account" WHERE "userId"=$1 AND "providerId" IN (\'wechat\',\'onelink\')',
      [owner.userId],
    )
  ).rows[0]!.providerId;
  policy = { ...policy, emailPasswordEnabled: true };
  await pool.query('UPDATE "user" SET email=$2 WHERE id=$1', [
    owner.userId,
    'phone-placeholder@auth.mio.invalid',
  ]);
  await checked(
    await call(`/api/v1/me/${remaining}`, { method: 'DELETE', cookie: owner.cookie }),
    409,
  );
  await pool.query('UPDATE "user" SET email=$2 WHERE id=$1', [owner.userId, owner.email]);
  await checked(await call(`/api/v1/me/${remaining}`, { method: 'DELETE', cookie: owner.cookie }));
  const profile = (await (
    await checked(await call('/api/v1/me/profile?view=display', { cookie: owner.cookie }))
  ).json()) as { wechatNickname: string | null };
  expect(profile.wechatNickname).toBeNull();
});

it.each(['wechat', 'onelink'] as const)(
  'rejects a pre-unbind callback for %s but permits explicit create on a fresh unbound flow',
  async (provider) => {
    const owner = await emailUser();
    const subject = `unlink-recreate-${provider}`;
    if (provider === 'wechat') await bindWechat(owner.cookie, subject);
    else await bindOneLink(owner.cookie, subject);
    const old = provider === 'wechat' ? await startWechat() : await startOneLink('login');
    await checked(await call(`/api/v1/me/${provider}`, { method: 'DELETE', cookie: owner.cookie }));
    const response =
      provider === 'wechat'
        ? await wxCallback(old as Awaited<ReturnType<typeof startWechat>>, subject)
        : await olCallback(old as string, subject);
    expect(response.headers.get('location')).toContain(
      provider === 'wechat' ? 'STATE_REPLAY' : 'invalid_state',
    );
    expect(cookie(response)).not.toContain('session_token=');
    const fresh = provider === 'wechat' ? await wxPending(subject) : await olPending(subject);
    const created = await checked(
      await call(
        provider === 'wechat' ? '/api/auth/wechat/pending/confirm' : '/api/auth/onelink/complete',
        {
          body: { action: 'create', candidateToken: fresh.candidateToken },
          cookie: fresh.pendingCookie,
        },
      ),
    );
    expect((await me(cookie(created))).userId).not.toBe(owner.userId);
    expect((await me(owner.cookie)).sessionId).toBe(owner.sessionId);
  },
);

it.each([
  'wechat_callback',
  'onelink_callback',
  'wechat_confirm',
  'onelink_confirm',
  'wechat_confirm_expiry',
] as const)(
  'rejects a new session when authorization changes after the final account transaction and before session insert: %s',
  async (variant) => {
    const owner = await emailUser(),
      subject = `final-gap-${variant}`,
      provider = variant.startsWith('wechat') ? 'wechat' : 'onelink';
    let startRequest: () => Promise<Response>;
    let expiresAt: Date | undefined;
    if (variant.endsWith('callback')) {
      if (provider === 'wechat') {
        await bindWechat(owner.cookie, subject);
        const flow = await startWechat();
        startRequest = () => wxCallback(flow, subject);
      } else {
        await bindOneLink(owner.cookie, subject);
        const pending = await startOneLink('login');
        startRequest = () => olCallback(pending, subject);
      }
    } else {
      const pending = provider === 'wechat' ? await wxPending(subject) : await olPending(subject);
      const recent = await emailLogin(owner.email);
      if (variant.endsWith('expiry')) {
        expiresAt = (
          await pool.query<{ expiresAt: Date }>(
            'UPDATE "mioWechatPending" SET "expiresAt"=clock_timestamp()+interval \'1 second\' RETURNING "expiresAt"',
          )
        ).rows[0]!.expiresAt;
      }
      startRequest = () =>
        call(
          provider === 'wechat' ? '/api/auth/wechat/pending/confirm' : '/api/auth/onelink/complete',
          {
            body: { action: 'link_existing', candidateToken: pending.candidateToken },
            cookie: join(pending.pendingCookie, recent),
          },
        );
    }
    const lockId = 948372,
      blocker = await pool.connect();
    await pool.query(`CREATE FUNCTION u2_session_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW."userId"='${owner.userId}' THEN PERFORM pg_advisory_xact_lock(${lockId}); END IF; RETURN NEW; END $$;
    CREATE TRIGGER u2_session_gate BEFORE INSERT ON "session" FOR EACH ROW EXECUTE FUNCTION u2_session_gate()`);
    let pendingRequest: Promise<Response> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1)', [lockId]);
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]!.pid;
      pendingRequest = startRequest();
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                `SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))`,
                [blockerPid],
              )
            ).rowCount,
        )
        .toBe(1);
      expect(
        (
          await pool.query('SELECT 1 FROM "account" WHERE "userId"=$1 AND "providerId"=$2', [
            owner.userId,
            provider,
          ])
        ).rowCount,
      ).toBe(1);
      if (expiresAt) {
        await expect
          .poll(
            async () =>
              (
                await pool.query<{ expired: boolean }>('SELECT clock_timestamp()>=$1 AS expired', [
                  expiresAt,
                ])
              ).rows[0]!.expired,
          )
          .toBe(true);
      } else {
        await checked(
          await call(`/api/v1/me/${provider}`, { method: 'DELETE', cookie: owner.cookie }),
        );
      }
      await blocker.query('COMMIT');
      const rejected = await pendingRequest;
      expect(cookie(rejected)).not.toContain('session_token=');
      expect(rejected.headers.get('location') ?? (await rejected.text())).toMatch(
        /STATE_REPLAY|invalid_state|PENDING_INVALID/,
      );
      expect(
        (
          await pool.query('SELECT count(*)::int AS count FROM "session" WHERE "userId"=$1', [
            owner.userId,
          ])
        ).rows[0]!.count,
      ).toBe(variant.endsWith('callback') ? 1 : 2);
      expect((await me(owner.cookie)).sessionId).toBe(owner.sessionId);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pendingRequest?.catch(() => undefined);
      await pool.query(
        'DROP TRIGGER u2_session_gate ON "session"; DROP FUNCTION u2_session_gate()',
      );
    }
  },
);

it('isolates every account-operation global budget without migrating rows and retains shared phone limits', async () => {
  const { reserveSmsBudget } = await import('../../src/auth/phone-budget.ts');
  const { readSmsBudgetSchema } = await import('../../src/auth/phone-budget-schema.ts');
  const { withAuthTransaction } = await import('../../src/auth/transaction.ts');
  const base = {
    MIO_AUTH_BASE_URL: origin,
    MIO_AUTH_SECRET: secret,
    MIO_AUTH_DATABASE_URL: database.url,
  };
  const config = readAuthConfig(base)!;
  expect(config.smsLimits.accountOpsDay).toBe(300);
  expect(
    readAuthConfig({ ...base, MIO_AUTH_SMS_ACCOUNT_OPS_DAY_LIMIT: '20' })!.smsLimits.accountOpsDay,
  ).toBe(20);
  for (const value of ['301', '0', '-1', 'bad'])
    expect(() => readAuthConfig({ ...base, MIO_AUTH_SMS_ACCOUNT_OPS_DAY_LIMIT: value })).toThrow(
      'AUTH_CONFIG',
    );
  const { tables } = await readSmsBudgetSchema(pool);
  const purposes = [
    'phone_rebind',
    'wechat_existing',
    'onelink_existing',
    'account_deletion',
  ] as const;
  for (const [index, purpose] of purposes.entries()) {
    await withAuthTransaction(pool, (client) =>
      reserveSmsBudget(
        client,
        tables,
        { ...config.smsLimits, accountOpsDay: 4 },
        `+86138001387${index.toString().padStart(2, '0')}`,
        '127.0.0.1',
        purpose,
      ),
    );
  }
  const usage = await pool.query<{ budgetId: string; count: number }>(
    'SELECT "budgetId",count(*)::int AS count FROM "mioSmsBudgetEvent" WHERE "budgetId" LIKE \'global%\' GROUP BY "budgetId"',
  );
  expect(usage.rows).toEqual([{ budgetId: 'global:account_ops', count: 4 }]);
  await expect(
    withAuthTransaction(pool, (client) =>
      reserveSmsBudget(
        client,
        tables,
        { ...config.smsLimits, accountOpsDay: 4 },
        '+8613800138790',
        '127.0.0.1',
        'account_deletion',
      ),
    ),
  ).rejects.toThrow('SMS_RATE_LIMITED');
  await checked(
    await call('/api/auth/phone-number/send-otp', { body: { phoneNumber: '13800138791' } }),
  );
  await checked(
    await call('/api/auth/phone-number/send-otp', { body: { phoneNumber: '13800138700' } }),
    429,
  );
  expect(
    (
      await pool.query(
        'SELECT count(*)::int AS count FROM "mioSmsBudgetEvent" WHERE "budgetId"=\'global\'',
      )
    ).rows[0]!.count,
  ).toBe(1);
  await pool.query('DELETE FROM "mioSmsBudget" WHERE id=\'global\'');
  await pool.query(
    'INSERT INTO "mioSmsBudget" (id,events,"updatedAt") VALUES (\'global\',\'[]\',clock_timestamp())',
  );
  await pool.query(
    'INSERT INTO "mioSmsBudgetEvent" ("budgetId","occurredAtMs") SELECT \'global\',(extract(epoch FROM clock_timestamp())*1000)::bigint FROM generate_series(1,1000)',
  );
  await withAuthTransaction(pool, (client) =>
    reserveSmsBudget(
      client,
      tables,
      config.smsLimits,
      '+8613800138792',
      '127.0.0.1',
      'phone_rebind',
    ),
  );
  expect(
    (
      await pool.query(
        'SELECT count(*)::int AS count FROM "mioSmsBudgetEvent" WHERE "budgetId"=\'global\'',
      )
    ).rows[0]!.count,
  ).toBe(1000);
});

it('adds U2 schema only by explicit idempotent migration, preserves populated baseline data and keeps startup read-only', async () => {
  const isolated = await authDatabase(),
    oldPool = new Pool({ connectionString: isolated.url });
  const env = {
    MIO_AUTH_BASE_URL: origin,
    MIO_AUTH_SECRET: secret,
    MIO_AUTH_DATABASE_URL: isolated.url,
  };
  const migrate = (apply = false) =>
    spawnSync(
      process.execPath,
      ['scripts/service/migrate-auth.ts', ...(apply ? ['--apply'] : [])],
      { env, encoding: 'utf8', timeout: 30_000 },
    );
  try {
    expect(migrate(true).status).toBe(0);
    await oldPool.query(
      'DROP TABLE "mioWechatPending"; ALTER TABLE "mioWechatQR" DROP COLUMN "pendingId"; ALTER TABLE "mioPhoneChallenge" DROP COLUMN "originalPhone"',
    );
    await oldPool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt",disabled) VALUES ('legacy-owner','Legacy','legacy@example.test',true,clock_timestamp(),clock_timestamp(),false);
      INSERT INTO "session" (id,token,"userId","expiresAt","createdAt","updatedAt") VALUES ('legacy-session','synthetic-legacy-token','legacy-owner',clock_timestamp()+interval '1 day',clock_timestamp(),clock_timestamp());
      INSERT INTO "account" (id,"providerId","accountId","userId","createdAt","updatedAt") VALUES ('legacy-account','onelink','legacy-sub','legacy-owner',clock_timestamp(),clock_timestamp());
      INSERT INTO "mioSmsBudget" (id,events,"updatedAt") VALUES ('global','[]',clock_timestamp());
      INSERT INTO "mioSmsBudgetEvent" ("budgetId","occurredAtMs") VALUES ('global',123456789);
      INSERT INTO "mioPhoneChallenge" (id,"challengeKey","codeHash",purpose,status,attempts,"expiresAt") VALUES ('legacy-challenge','legacy-key','legacy-hash','login','active',0,clock_timestamp()+interval '5 minutes')`);
    const snapshot = async () =>
      (
        await oldPool.query(`SELECT (SELECT row_to_json(u) FROM "user" u WHERE id='legacy-owner') AS "user",
      (SELECT row_to_json(s) FROM "session" s WHERE id='legacy-session') AS "session",
      (SELECT row_to_json(a) FROM "account" a WHERE id='legacy-account') AS "account",
      (SELECT json_agg(b) FROM "mioSmsBudget" b) AS budget,(SELECT json_agg(e) FROM "mioSmsBudgetEvent" e) AS events`)
      ).rows[0];
    const before = await snapshot(),
      preview = migrate();
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('mioWechatPending');
    expect(
      (await oldPool.query('SELECT to_regclass(\'"mioWechatPending"\') AS name')).rows[0]!.name,
    ).toBeNull();
    await expect(createAuthentication(readAuthConfig(env)!)).rejects.toThrow('AUTH_SCHEMA');
    expect(await snapshot()).toEqual(before);
    const applied = migrate(true);
    expect(applied.status, applied.stderr).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await oldPool.query(
          'SELECT "originalPhone" FROM "mioPhoneChallenge" WHERE id=\'legacy-challenge\'',
        )
      ).rows[0],
    ).toEqual({ originalPhone: null });
    const indexes = await oldPool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename='mioWechatPending'",
    );
    expect(
      indexes.rows.some(
        (row) => row.indexdef.includes('UNIQUE') && row.indexdef.includes('tokenDigest'),
      ),
    ).toBe(true);
    const repeated = migrate(true);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(migrate().stdout).toContain('Authentication schema is current.');
    const started = await createAuthentication(readAuthConfig(env)!);
    await started.close();
  } finally {
    await oldPool.end();
    await isolated.close();
  }
}, 30_000);

it('requires available SMS for a verified phone alternative and an enabled provider alternative', async () => {
  const owner = await wxCreate('only-wx');
  await checked(await call('/api/v1/me/wechat', { method: 'DELETE', cookie: owner.cookie }), 409);
  await bindOneLink(owner.cookie, 'other-provider');
  oneLinkPolicy = { ...oneLinkPolicy, enabled: false };
  await checked(await call('/api/v1/me/wechat', { method: 'DELETE', cookie: owner.cookie }), 409);
  await phoneBind(owner.cookie, '13800138793');
  policy = { ...policy, smsMode: 'disabled' };
  await checked(await call('/api/v1/me/wechat', { method: 'DELETE', cookie: owner.cookie }), 409);
  policy = { ...policy, smsMode: 'live' };
  await checked(await call('/api/v1/me/wechat', { method: 'DELETE', cookie: owner.cookie }));
  expect((await me(owner.cookie)).sessionId).toBe(owner.sessionId);
});

it.each(['success', 'session_failure', 'proof_failure'] as const)(
  'publishes QR confirmation only after its new login session succeeds; old target session cannot publish early: %s',
  async (outcome) => {
    const owner = await emailUser(),
      phoneNumber = '13800138794';
    await phoneBind(owner.cookie, phoneNumber);
    // The existing-phone fixture predates this QR flow and its shared 60-second SMS cooldown.
    await pool.query('UPDATE "mioSmsBudgetEvent" SET "occurredAtMs"="occurredAtMs"-61000');
    const qr = await wxPending(`qr-publish-${outcome}`, true);
    const pollPath = `/api/auth/wechat/qr-session/${qr.id}/poll`;
    const browser = join(qr.cookie, qr.pendingCookie, owner.cookie);
    await checked(
      await call('/api/auth/wechat/pending/send-otp', {
        body: { phoneNumber },
        cookie: qr.pendingCookie,
      }),
    );
    const code = delivered.get(`+86${phoneNumber}`)!;
    const blocker = await pool.connect(),
      lockId = 948373;
    await pool.query(`CREATE FUNCTION u2_qr_session_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."userId"='${owner.userId}' THEN
        PERFORM pg_advisory_xact_lock(${lockId});
        ${outcome === 'session_failure' ? "RAISE EXCEPTION 'synthetic session creation failure';" : ''}
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER u2_qr_session_gate BEFORE INSERT ON "session" FOR EACH ROW EXECUTE FUNCTION u2_qr_session_gate()`);
    let confirmation: Promise<Response> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1)', [lockId]);
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid;
      confirmation = call('/api/auth/wechat/pending/confirm', {
        body: { action: 'link_existing', candidateToken: qr.candidateToken, phoneNumber, code },
        cookie: qr.pendingCookie,
      });
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                `SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))`,
                [pid],
              )
            ).rowCount,
        )
        .toBe(1);
      expect((await pool.query('SELECT status FROM "mioWechatPending"')).rows[0]!.status).toBe(
        'completed',
      );
      expect(
        (await pool.query('SELECT status FROM "mioWechatQR" WHERE id=$1', [qr.id])).rows[0]!.status,
      ).toBe('pending_confirm');
      expect(await (await checked(await call(pollPath, { cookie: browser }))).json()).toEqual({
        status: 'pending_confirm',
      });
      expect((await me(owner.cookie)).sessionId).toBe(owner.sessionId);
      if (outcome === 'proof_failure')
        await checked(await call('/api/v1/me/wechat', { method: 'DELETE', cookie: owner.cookie }));
      await blocker.query('COMMIT');
      const finished = await confirmation;
      if (outcome === 'success') {
        await checked(finished);
        expect((await me(cookie(finished))).userId).toBe(owner.userId);
        expect(
          await (
            await checked(await call(pollPath, { cookie: join(qr.cookie, cookie(finished)) }))
          ).json(),
        ).toEqual({ status: 'confirmed' });
      } else {
        await checked(finished, outcome === 'session_failure' ? 503 : 400);
        expect(cookie(finished)).not.toContain('session_token=');
        expect(await (await checked(await call(pollPath, { cookie: browser }))).json()).toEqual({
          status: 'failed',
        });
        expect(
          (await pool.query('SELECT status FROM "mioWechatQR" WHERE id=$1', [qr.id])).rows[0]!
            .status,
        ).toBe('failed');
      }
      expect(
        (
          await pool.query('SELECT count(*)::int AS count FROM "session" WHERE "userId"=$1', [
            owner.userId,
          ])
        ).rows[0]!.count,
      ).toBe(outcome === 'success' ? 2 : 1);
      expect((await me(owner.cookie)).sessionId).toBe(owner.sessionId);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await confirmation?.catch(() => undefined);
      await pool.query(
        'DROP TRIGGER u2_qr_session_gate ON "session"; DROP FUNCTION u2_qr_session_gate()',
      );
    }
  },
);
