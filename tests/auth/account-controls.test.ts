import COS from 'cos-nodejs-sdk-v5';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { adminSchemaSQL } from '../../src/admin/schema.ts';
import { hashAdminPassword } from '../../src/auth/admin-password.ts';
import { authOptions, readAuthConfig } from '../../src/auth/config.ts';
import type { AuthRuntimePolicy } from '../../src/auth/config.ts';
import { createAuthHandler } from '../../src/auth/http.ts';
import type { AvatarAssetStatus } from '../../src/auth/http.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import * as Mio from '../../src/plugin.ts';
import { authDatabase } from '../support/auth-database.ts';

const secret = randomBytes(40).toString('hex');
const password = 'correct-horse-account-controls-42';
const appId = 'fixture-account-app';
const originalFetch = globalThis.fetch;

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
const servers: ReturnType<typeof createServer>[] = [];
const auths: Awaited<ReturnType<typeof createAuthentication>>[] = [];
const origins: string[] = [];
const delivered = new Map<string, string>();
const wechatFixtures = new Map<string, { openid: string }>();
const avatarRegistry = new Map<string, { ownerId: string; status: AvatarAssetStatus }>();

const sender = async (phone: string, code: string) => {
  delivered.set(phone, code);
};

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .join('; ');

function call(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
    instance?: number;
    origin?: boolean;
  } = {},
) {
  const instance = options.instance ?? 0;
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  return originalFetch(`${origins[instance]}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(options.origin === false ? {} : { origin: origins[instance]! }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function signUpEmail(name = '创作者', instance = 0) {
  const email = `${randomUUID()}@example.test`;
  const response = await call('/api/auth/sign-up/email', {
    body: { name, email, password },
    instance,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const cookie = cookies(response);
  const me = (await (await call('/api/v1/me', { cookie, instance })).json()) as {
    userId: string;
    sessionId: string;
  };
  return { email, cookie, ...me };
}

async function signInPhone(phoneNumber: string, instance = 0) {
  const sent = await call('/api/auth/phone-number/send-otp', { body: { phoneNumber }, instance });
  expect(sent.status, await sent.clone().text()).toBe(200);
  const normalized = phoneNumber.startsWith('+86') ? phoneNumber : `+86${phoneNumber}`;
  const code = delivered.get(normalized)!;
  return call('/api/auth/phone-number/verify', { body: { phoneNumber, code }, instance });
}

async function signInWechat(openid: string, instance = 0) {
  const code = randomUUID();
  wechatFixtures.set(code, { openid });
  const started = await call('/api/auth/sign-in/social', {
    body: { provider: 'wechat', callbackURL: '/done' },
    instance,
  });
  expect(started.status, await started.clone().text()).toBe(200);
  const { url } = (await started.json()) as { url: string };
  const state = new URL(url).searchParams.get('state')!;
  const callback = await call(
    `/api/auth/callback/wechat?code=${code}&state=${encodeURIComponent(state)}`,
    {
      cookie: cookies(started),
      instance,
    },
  );
  if (!callback.headers.getSetCookie().some((cookie) => cookie.startsWith('mio.wechat_pending=')))
    return callback;
  const pending = await call('/api/auth/wechat/pending', { cookie: cookies(callback), instance });
  expect(pending.status).toBe(200);
  const { candidateToken } = (await pending.json()) as { candidateToken: string };
  const confirmed = await call('/api/auth/wechat/pending/confirm', {
    body: { action: 'create', candidateToken },
    cookie: cookies(callback),
    instance,
  });
  expect(confirmed.status, await confirmed.clone().text()).toBe(200);
  const headers = new Headers(callback.headers);
  headers.delete('set-cookie');
  for (const cookie of confirmed.headers.getSetCookie()) headers.append('set-cookie', cookie);
  const location = new URL(headers.get('location')!);
  location.searchParams.delete('wechat_result');
  headers.set('location', location.href);
  return new Response(null, { status: callback.status, headers });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin === 'https://api.weixin.qq.com') {
      if (url.pathname === '/sns/oauth2/access_token') {
        const entry = wechatFixtures.get(url.searchParams.get('code') ?? '');
        if (!entry) return Response.json({ errcode: 40029, errmsg: 'invalid code' });
        return Response.json({
          access_token: `tok-${entry.openid}`,
          expires_in: 7200,
          openid: entry.openid,
          scope: 'snsapi_login',
        });
      }
      if (url.pathname === '/sns/userinfo') {
        const openid = url.searchParams.get('openid') ?? '';
        return Response.json({ openid, nickname: '微信创作者' });
      }
    }
    return originalFetch(input, init);
  });

  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  for (let index = 0; index < 2; index += 1) {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    origins.push(`http://127.0.0.1:${address.port}`);
    servers.push(server);
  }
  const migrated = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      MIO_AUTH_BASE_URL: origins[0],
      MIO_AUTH_SECRET: secret,
      MIO_AUTH_DATABASE_URL: database.url,
    },
  });
  expect(migrated.status, migrated.stderr).toBe(0);

  // Instance 0: email/password enabled + avatar verifier wired.
  // Instance 1: email/password disabled + no avatar verifier.
  for (let index = 0; index < 2; index += 1) {
    const config = readAuthConfig({
      MIO_AUTH_BASE_URL: origins[index],
      MIO_AUTH_SECRET: secret,
      MIO_AUTH_DATABASE_URL: database.url,
      MIO_AUTH_EMAIL_PASSWORD_ENABLED: index === 0 ? 'true' : 'false',
      MIO_AUTH_WECHAT_ENABLED: 'true',
      MIO_AUTH_WECHAT_APP_ID: appId,
      MIO_AUTH_WECHAT_APP_SECRET: 'fixture-secret',
    })!;
    const auth = await createAuthentication(config, undefined, sender);
    auths.push(auth);
    const verifier =
      index === 0
        ? async (
            identity: { userId: string; sessionId: string },
            assetId: string,
          ): Promise<AvatarAssetStatus> => {
            const item = avatarRegistry.get(assetId);
            if (!item || item.ownerId !== identity.userId) return 'not_found';
            return item.status;
          }
        : undefined;
    servers[index]!.on('request', createAuthHandler(config, auth, verifier));
  }
}, 30_000);

beforeEach(async () => {
  delivered.clear();
  wechatFixtures.clear();
  avatarRegistry.clear();
  await pool.query(
    'TRUNCATE "account", "session", "user", "verification", "rateLimit", "mioPhoneChallenge", "mioSmsBudget", "mioWechatQR" CASCADE',
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const auth of auths) await auth.close();
  await pool.end();
  await database.close();
});

it('validates MIO_AUTH_EMAIL_PASSWORD_ENABLED and gates email/password routes when disabled', async () => {
  const base = {
    MIO_AUTH_BASE_URL: origins[0]!,
    MIO_AUTH_SECRET: secret,
    MIO_AUTH_DATABASE_URL: database.url,
  };
  expect(readAuthConfig({})).toBeUndefined();
  expect(readAuthConfig({ MIO_AUTH_EMAIL_PASSWORD_ENABLED: 'false' })).toBeUndefined();
  expect(() => readAuthConfig({ MIO_AUTH_EMAIL_PASSWORD_ENABLED: 'true' })).toThrow('AUTH_CONFIG');
  expect(readAuthConfig(base)?.emailPasswordEnabled).toBe(true);
  expect(
    readAuthConfig({ ...base, MIO_AUTH_EMAIL_PASSWORD_ENABLED: 'false' })?.emailPasswordEnabled,
  ).toBe(false);
  expect(() => readAuthConfig({ ...base, MIO_AUTH_EMAIL_PASSWORD_ENABLED: 'yes' })).toThrow(
    'AUTH_CONFIG',
  );

  // Disabled instance blocks sign-up, sign-in, and change-password with 503 while CORS OPTIONS stays 204.
  const preflight = await call('/api/auth/sign-in/email', { method: 'OPTIONS', instance: 1 });
  expect(preflight.status).toBe(204);
  for (const path of [
    '/api/auth/sign-up/email',
    '/api/auth/sign-in/email',
    '/api/auth/change-password',
  ]) {
    const res = await call(path, { body: {}, instance: 1 });
    expect(res.status, path).toBe(503);
    const err = (await res.json()) as { error: { code: string; requestId: string } };
    expect(err.error.code).toBe('EMAIL_PASSWORD_UNAVAILABLE');
    expect(err.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  }
  // Rate limit is untouched when email/password is disabled.
  expect((await pool.query('SELECT count(*)::int AS c FROM "rateLimit"')).rows[0].c).toBe(0);

  // Phone OTP & WeChat login continue working on the email/password-disabled instance.
  const phoneLogin = await signInPhone('13800138001', 1);
  expect(phoneLogin.status, await phoneLogin.clone().text()).toBe(200);
  const phoneCookie = cookies(phoneLogin);
  expect((await call('/api/v1/me', { cookie: phoneCookie, instance: 1 })).status).toBe(200);
  expect((await call('/api/v1/me/profile', { cookie: phoneCookie, instance: 1 })).status).toBe(200);
  expect(
    (await call('/api/auth/sign-out', { body: {}, cookie: phoneCookie, instance: 1 })).status,
  ).toBe(200);

  const wechatLogin = await signInWechat('wx-disabled-email-ok', 1);
  expect(wechatLogin.status).toBe(302);
  expect(wechatLogin.headers.get('location')).toBe(`${origins[1]}/done`);
  expect((await call('/api/v1/me', { cookie: cookies(wechatLogin), instance: 1 })).status).toBe(
    200,
  );
});

it('assigns unique miioo_XXXXXX displayId across signup methods and rejects client spoofing', async () => {
  const emailUser = await signUpEmail('邮箱用户');
  const phoneRes = await signInPhone('13800138002');
  expect(phoneRes.status).toBe(200);
  const phoneCookie = cookies(phoneRes);
  const wxRes = await signInWechat('wx-display-id-user');
  expect(wxRes.status).toBe(302);
  const wxCookie = cookies(wxRes);

  const profiles = await Promise.all(
    [emailUser.cookie, phoneCookie, wxCookie].map(async (cookie) => {
      const res = await call('/api/v1/me/profile', { cookie });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        userId: string;
        displayId: string;
        name: string;
        avatarAssetId: string | null;
        phoneNumber: string | null;
        phoneNumberVerified: boolean;
        wechatBound: boolean;
        onelinkBound: boolean;
      };
    }),
  );
  const ids = profiles.map((p) => p.displayId);
  for (const displayId of ids) expect(displayId).toMatch(/^miioo_\d{6}$/);
  expect(new Set(ids).size).toBe(3);
  for (const profile of profiles) expect(profile.onelinkBound).toBe(false);
  expect(profiles[1]!.phoneNumber).toBe('+8613800138002');
  expect(profiles[1]!.phoneNumberVerified).toBe(true);
  expect(profiles[1]!.wechatBound).toBe(false);
  expect(profiles[2]!.wechatBound).toBe(true);
  expect(profiles[2]!.phoneNumber).toBeNull();

  // /api/v1/me keeps exact {userId, sessionId} shape.
  const me = (await (await call('/api/v1/me', { cookie: emailUser.cookie })).json()) as Record<
    string,
    unknown
  >;
  expect(Object.keys(me).sort()).toEqual(['sessionId', 'userId']);

  // Client cannot forge displayId, avatarAssetId, disabledAt, or disabled=true during email sign-up.
  for (const extra of [
    { displayId: 'miioo_000001' },
    { avatarAssetId: randomUUID() },
    { disabledAt: new Date().toISOString() },
  ]) {
    const spoofed = await call('/api/auth/sign-up/email', {
      body: { name: 'Spoof', email: `${randomUUID()}@example.test`, password, ...extra },
    });
    expect(spoofed.status).toBe(400);
  }
  const disabledSpoof = await call('/api/auth/sign-up/email', {
    body: { name: 'NotDisabled', email: `${randomUUID()}@example.test`, password, disabled: true },
  });
  expect(disabledSpoof.status).toBe(200);
  const spoofMe = (await (await call('/api/v1/me', { cookie: cookies(disabledSpoof) })).json()) as {
    userId: string;
  };
  const dbRow = (await pool.query('SELECT disabled FROM "user" WHERE id = $1', [spoofMe.userId]))
    .rows[0] as { disabled: boolean };
  expect(dbRow.disabled).toBe(false);
});

it('disables accounts atomically, blocks all login methods and stale sessions, and supports re-enable', async () => {
  expect(await auths[0]!.setUserDisabled(randomUUID(), true)).toBeNull();

  // Create one user with email + bound phone + bound WeChat to test every login & session path.
  const user = await signUpEmail('待禁用用户');
  const sendBind = await call('/api/auth/phone-binding/send-otp', {
    body: { phoneNumber: '13800138009' },
    cookie: user.cookie,
  });
  expect(sendBind.status).toBe(200);
  const confirmBind = await call('/api/auth/phone-binding/confirm', {
    body: { phoneNumber: '13800138009', code: delivered.get('+8613800138009')! },
    cookie: user.cookie,
  });
  expect(confirmBind.status).toBe(200);

  const linkStart = await call('/api/auth/link-social', {
    body: { provider: 'wechat', callbackURL: '/linked' },
    cookie: user.cookie,
  });
  expect(linkStart.status).toBe(200);
  const linkState = new URL(((await linkStart.json()) as { url: string }).url).searchParams.get(
    'state',
  )!;
  const linkCode = randomUUID();
  wechatFixtures.set(linkCode, { openid: 'wx-disable-target' });
  const linkDone = await call(
    `/api/auth/callback/wechat?code=${linkCode}&state=${encodeURIComponent(linkState)}`,
    { cookie: `${user.cookie}; ${cookies(linkStart)}` },
  );
  expect(linkDone.status).toBe(302);
  expect(linkDone.headers.get('location')).toBe(`${origins[0]}/linked`);

  // Create a second session for the same user before disabling.
  const secondLogin = await call('/api/auth/sign-in/email', {
    body: { email: user.email, password },
  });
  expect(secondLogin.status).toBe(200);
  const secondCookie = cookies(secondLogin);

  // Disable user: revokes both sessions atomically.
  const disabledStatus = await auths[0]!.setUserDisabled(user.userId, true);
  expect(disabledStatus).toMatchObject({
    userId: user.userId,
    disabled: true,
    revokedSessions: 2,
  });
  expect(disabledStatus!.disabledAt).toBeTruthy();

  // Existing sessions are immediately rejected.
  for (const stale of [user.cookie, secondCookie]) {
    expect((await call('/api/v1/me', { cookie: stale })).status).toBe(401);
    expect((await call('/api/v1/me/profile', { cookie: stale })).status).toBe(401);
    expect(
      (await call('/api/v1/me/profile', { method: 'PATCH', body: { name: '新名' }, cookie: stale }))
        .status,
    ).toBe(401);
    const gs = await call('/api/auth/get-session', { cookie: stale });
    expect(gs.status).toBe(200);
    expect(await gs.json()).toBeNull();
  }

  // Wrong password does not leak ACCOUNT_DISABLED; right password returns 403 ACCOUNT_DISABLED.
  const wrongPw = await call('/api/auth/sign-in/email', {
    body: { email: user.email, password: 'wrong-password-123456' },
  });
  expect(wrongPw.status).toBe(401);

  const rightPw = await call('/api/auth/sign-in/email', {
    body: { email: user.email, password },
  });
  expect(rightPw.status).toBe(403);
  expect(((await rightPw.json()) as { code: string }).code).toBe('ACCOUNT_DISABLED');
  expect(rightPw.headers.getSetCookie()).toEqual([]);

  // Phone OTP verify returns 403 ACCOUNT_DISABLED (clear 60s SMS cooldown from earlier bind).
  await pool.query('TRUNCATE "mioSmsBudget" CASCADE');
  const phoneBlocked = await signInPhone('13800138009');
  expect(phoneBlocked.status).toBe(403);
  expect(((await phoneBlocked.json()) as { code: string }).code).toBe('ACCOUNT_DISABLED');
  expect(phoneBlocked.headers.getSetCookie()).toEqual([]);

  // WeChat OAuth login fails with ACCOUNT_DISABLED redirect and issues no session cookie.
  const wxBlocked = await signInWechat('wx-disable-target');
  expect(wxBlocked.status).toBe(302);
  expect(wxBlocked.headers.get('location')).toContain('error=ACCOUNT_DISABLED');
  expect(wxBlocked.headers.getSetCookie().some((c) => c.includes('session_token='))).toBe(false);

  // WeChat QR login fails cleanly and transitions QR status to failed.
  const qrStart = await call('/api/auth/wechat/qr-session', { body: {} });
  expect(qrStart.status).toBe(201);
  const qrBody = (await qrStart.json()) as { qrcode_id: string; authorization_url: string };
  const qrState = new URL(qrBody.authorization_url).searchParams.get('state')!;
  const qrCode = randomUUID();
  wechatFixtures.set(qrCode, { openid: 'wx-disable-target' });
  const qrCookies = cookies(qrStart);
  const qrCb = await call(
    `/api/auth/callback/wechat?code=${qrCode}&state=${encodeURIComponent(qrState)}`,
    { cookie: qrCookies },
  );
  expect(qrCb.status).toBe(302);
  expect(qrCb.headers.get('location')).toContain('error=ACCOUNT_DISABLED');
  const qrPoll = await call(`/api/auth/wechat/qr-session/${qrBody.qrcode_id}/poll`, {
    cookie: qrCookies,
  });
  expect(qrPoll.status).toBe(200);
  expect(await qrPoll.json()).toEqual({ status: 'failed' });

  // Re-enable user, verify login works, then simulate a stale session left in DB after direct UPDATE disabled=true.
  const reEnabled = await auths[0]!.setUserDisabled(user.userId, false);
  expect(reEnabled).toEqual({
    userId: user.userId,
    disabled: false,
    disabledAt: null,
    revokedSessions: 0,
  });
  const reloginA = await call('/api/auth/sign-in/email', { body: { email: user.email, password } });
  expect(reloginA.status).toBe(200);
  const cookieA = cookies(reloginA);
  const reloginB = await call('/api/auth/sign-in/email', { body: { email: user.email, password } });
  expect(reloginB.status).toBe(200);
  const cookieB = cookies(reloginB);

  // Simulate out-of-band DB disable leaving session rows behind (defense-in-depth).
  await pool.query('UPDATE "user" SET disabled = true, "disabledAt" = now() WHERE id = $1', [
    user.userId,
  ]);
  expect((await call('/api/v1/me', { cookie: cookieA })).status).toBe(401);
  expect((await call('/api/v1/me/profile', { cookie: cookieA })).status).toBe(401);
  expect((await call('/api/auth/list-sessions', { cookie: cookieA })).status).toBe(401);
  const gsB = await call('/api/auth/get-session', { cookie: cookieB });
  expect(gsB.status).toBe(200);
  expect(await gsB.json()).toBeNull();
  expect(
    (
      await pool.query('SELECT count(*)::int AS c FROM "session" WHERE "userId" = $1', [
        user.userId,
      ])
    ).rows[0].c,
  ).toBe(0);
});

it('reads and updates /api/v1/me/profile with strict input and avatar asset validation', async () => {
  const alice = await signUpEmail('Alice');
  const bob = await signUpEmail('Bob');

  // CORS / method / origin / content-type checks.
  const opt = await call('/api/v1/me/profile', { method: 'OPTIONS' });
  expect(opt.status).toBe(204);
  expect(opt.headers.get('access-control-allow-methods')).toBe('GET, PATCH, OPTIONS');
  const postRejected = await call('/api/v1/me/profile', {
    method: 'POST',
    body: {},
    cookie: alice.cookie,
  });
  expect(postRejected.status).toBe(405);
  expect(postRejected.headers.get('allow')).toBe('GET, PATCH, OPTIONS');
  expect(
    (
      await call('/api/v1/me/profile', {
        method: 'PATCH',
        body: { name: 'NoOrigin' },
        cookie: alice.cookie,
        origin: false,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await originalFetch(`${origins[0]}/api/v1/me/profile`, {
        method: 'PATCH',
        headers: { origin: origins[0]!, cookie: alice.cookie, 'content-type': 'text/plain' },
        body: '{}',
      })
    ).status,
  ).toBe(415);
  expect((await call('/api/v1/me/profile')).status).toBe(401);

  // Validation errors.
  for (const invalid of [
    {},
    { name: '' },
    { name: '   ' },
    { name: 'a'.repeat(51) },
    { name: 'bad\nname' },
    { displayId: 'miioo_999999' },
    { disabled: true },
    { avatarAssetId: 'not-a-uuid' },
    { name: 'Ok', extra: 1 },
  ]) {
    const res = await call('/api/v1/me/profile', {
      method: 'PATCH',
      body: invalid,
      cookie: alice.cookie,
    });
    expect(res.status, JSON.stringify(invalid)).toBe(400);
  }

  // Name update trims whitespace and preserves immutable displayId.
  const before = (await (await call('/api/v1/me/profile', { cookie: alice.cookie })).json()) as {
    displayId: string;
  };
  const renamed = await call('/api/v1/me/profile', {
    method: 'PATCH',
    body: { name: '  阿狸创作者  ' },
    cookie: alice.cookie,
  });
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({
    userId: alice.userId,
    displayId: before.displayId,
    name: '阿狸创作者',
    avatarAssetId: null,
  });

  // Avatar asset verification on instance 0 (verifier wired).
  const aliceReady = randomUUID();
  const alicePending = randomUUID();
  const aliceVideo = randomUUID();
  const bobReady = randomUUID();
  avatarRegistry.set(aliceReady, { ownerId: alice.userId, status: 'ok' });
  avatarRegistry.set(alicePending, { ownerId: alice.userId, status: 'not_ready' });
  avatarRegistry.set(aliceVideo, { ownerId: alice.userId, status: 'invalid_type' });
  avatarRegistry.set(bobReady, { ownerId: bob.userId, status: 'ok' });

  expect(
    (
      await call('/api/v1/me/profile', {
        method: 'PATCH',
        body: { avatarAssetId: bobReady },
        cookie: alice.cookie,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call('/api/v1/me/profile', {
        method: 'PATCH',
        body: { avatarAssetId: randomUUID() },
        cookie: alice.cookie,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call('/api/v1/me/profile', {
        method: 'PATCH',
        body: { avatarAssetId: alicePending },
        cookie: alice.cookie,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('/api/v1/me/profile', {
        method: 'PATCH',
        body: { avatarAssetId: aliceVideo },
        cookie: alice.cookie,
      })
    ).status,
  ).toBe(400);

  const withAvatar = await call('/api/v1/me/profile', {
    method: 'PATCH',
    body: { avatarAssetId: aliceReady },
    cookie: alice.cookie,
  });
  expect(withAvatar.status).toBe(200);
  expect(await withAvatar.json()).toMatchObject({ avatarAssetId: aliceReady });

  // Instance 1 has no avatar verifier -> non-null UUID returns 503, null clears avatar.
  const phoneRes = await signInPhone('13800138011', 1);
  const phoneCookie = cookies(phoneRes);
  const noAssets = await call('/api/v1/me/profile', {
    method: 'PATCH',
    body: { avatarAssetId: randomUUID() },
    cookie: phoneCookie,
    instance: 1,
  });
  expect(noAssets.status).toBe(503);
  expect(((await noAssets.json()) as { error: { code: string } }).error.code).toBe(
    'ASSET_UNAVAILABLE',
  );
  const clearAvatar = await call('/api/v1/me/profile', {
    method: 'PATCH',
    body: { avatarAssetId: null },
    cookie: alice.cookie,
  });
  expect(clearAvatar.status).toBe(200);
  expect(await clearAvatar.json()).toMatchObject({ avatarAssetId: null });
});

it('migrates an existing populated auth user table cleanly and wires /api/v1/me/profile in plugin', async () => {
  const avatarHead = vi.spyOn(COS.prototype, 'headObject').mockResolvedValue({
    statusCode: 200,
    ETag: 'fixture-avatar',
    headers: { 'content-length': '1024', 'content-type': 'image/png' },
  });
  const upgradeDb = await authDatabase();
  const upgradePool = new Pool({ connectionString: upgradeDb.url });
  let ctx: Context | undefined;
  try {
    // 1. Seed a populated schema matching pre-change state (without the 4 new user columns).
    const preOrigin = 'http://127.0.0.1:19991';
    const preConfig = readAuthConfig({
      MIO_AUTH_BASE_URL: preOrigin,
      MIO_AUTH_SECRET: secret,
      MIO_AUTH_DATABASE_URL: upgradeDb.url,
    })!;
    await (await getMigrations(authOptions(preConfig, upgradePool))).runMigrations();
    const migrated = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        MIO_AUTH_BASE_URL: preOrigin,
        MIO_AUTH_SECRET: secret,
        MIO_AUTH_DATABASE_URL: upgradeDb.url,
      },
    });
    expect(migrated.status, migrated.stderr).toBe(0);
    await upgradePool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ('legacy-row-1', 'Old User', 'legacy@example.test', false, now(), now())`,
    );
    await upgradePool.query(
      `ALTER TABLE "user" DROP COLUMN disabled, DROP COLUMN "disabledAt", DROP COLUMN "displayId", DROP COLUMN "avatarAssetId"`,
    );

    // 2. Run explicit migration over the populated table.
    const upgraded = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        MIO_AUTH_BASE_URL: preOrigin,
        MIO_AUTH_SECRET: secret,
        MIO_AUTH_DATABASE_URL: upgradeDb.url,
      },
    });
    expect(upgraded.status, upgraded.stderr).toBe(0);
    const row = (
      await upgradePool.query(
        'SELECT disabled, "disabledAt", "displayId", "avatarAssetId" FROM "user" WHERE id = $1',
        ['legacy-row-1'],
      )
    ).rows[0] as {
      disabled: boolean;
      disabledAt: Date | null;
      displayId: string | null;
      avatarAssetId: string | null;
    };
    expect(row).toEqual({
      disabled: false,
      disabledAt: null,
      displayId: null,
      avatarAssetId: null,
    });

    // 3. Boot full Mio plugin (without assets) and verify /api/v1/me/profile wiring.
    ctx = new Context();
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    const pluginOrigin = ctx.webServer.getOrigin();
    vi.stubEnv('MIO_AUTH_TEST_TOKEN', randomBytes(24).toString('hex'));
    vi.stubEnv('MIO_AUTH_BASE_URL', pluginOrigin);
    vi.stubEnv('MIO_AUTH_SECRET', secret);
    vi.stubEnv('MIO_AUTH_DATABASE_URL', upgradeDb.url);
    vi.stubEnv('MIO_AUTH_ALLOWED_ORIGINS', '[]');
    vi.stubEnv('MIO_AUTH_RATE_LIMIT_BACKEND', 'database');
    vi.stubEnv('MIO_AUTH_EMAIL_PASSWORD_ENABLED', 'true');
    const mounted = ctx.plugin(Mio, { tokenEnv: 'MIO_AUTH_TEST_TOKEN', allowedOrigins: [] });
    await mounted;

    const signUp = await originalFetch(`${pluginOrigin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin: pluginOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Plugin User', email: 'plugin@example.test', password }),
    });
    expect(signUp.status).toBe(200);
    const pluginCookie = cookies(signUp);
    const profileRes = await originalFetch(`${pluginOrigin}/api/v1/me/profile`, {
      headers: { origin: pluginOrigin, cookie: pluginCookie },
    });
    expect(profileRes.status).toBe(200);
    const profile = (await profileRes.json()) as {
      userId: string;
      displayId: string;
      name: string;
    };
    expect(profile.name).toBe('Plugin User');
    expect(profile.displayId).toMatch(/^miioo_\d{6}$/);
    const avatarNoAssets = await originalFetch(`${pluginOrigin}/api/v1/me/profile`, {
      method: 'PATCH',
      headers: {
        origin: pluginOrigin,
        cookie: pluginCookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ avatarAssetId: randomUUID() }),
    });
    expect(avatarNoAssets.status).toBe(503);
    const normalizeNoAssets = await originalFetch(
      `${pluginOrigin}/api/v1/me/profile/avatar/normalize`,
      {
        method: 'POST',
        headers: { origin: pluginOrigin, cookie: pluginCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ sourceAssetId: randomUUID() }),
      },
    );
    expect(normalizeNoAssets.status).toBe(503);
    expect((await normalizeNoAssets.json()).error.code).toBe('ASSET_UNAVAILABLE');

    // 4. Reload plugin with assets enabled and exercise the real plugin verifyAvatarAsset wiring.
    await mounted.dispose();
    await upgradePool.query(assetSchemaSQL);
    const readyImg = randomUUID();
    const pendingImg = randomUUID();
    const readyVideo = randomUUID();
    const foreignImg = randomUUID();
    await upgradePool.query(
      `INSERT INTO mio_assets (id, owner_id, filename, content_type, size_bytes, state, staging_key, raw_key, expires_at)
       VALUES
         ($1, $5, 'a.png', 'image/png', 1024, 'ready', $6, $7, now() + interval '1 day'),
         ($2, $5, 'b.png', 'image/png', 1024, 'pending', $8, NULL, now() + interval '1 day'),
         ($3, $5, 'c.mp4', 'video/mp4', 2048, 'ready', $9, $10, now() + interval '1 day'),
         ($4, 'other-owner', 'd.png', 'image/png', 1024, 'ready', $11, $12, now() + interval '1 day')`,
      [
        readyImg,
        pendingImg,
        readyVideo,
        foreignImg,
        profile.userId,
        `mio/staging/${readyImg}`,
        `mio/raw/${readyImg}/${randomUUID()}`,
        `mio/staging/${pendingImg}`,
        `mio/staging/${readyVideo}`,
        `mio/raw/${readyVideo}/${randomUUID()}`,
        `mio/staging/${foreignImg}`,
        `mio/raw/${foreignImg}/${randomUUID()}`,
      ],
    );
    vi.stubEnv('MIO_ASSETS_DATABASE_URL', upgradeDb.url);
    vi.stubEnv('MIO_COS_BUCKET', 'fixture-bucket-1234');
    vi.stubEnv('MIO_COS_REGION', 'ap-guangzhou');
    vi.stubEnv('MIO_COS_SECRET_ID', 'fixture-secret-id');
    vi.stubEnv('MIO_COS_SECRET_KEY', 'fixture-secret-key');
    const mountedWithAssets = ctx.plugin(Mio, {
      tokenEnv: 'MIO_AUTH_TEST_TOKEN',
      allowedOrigins: [],
    });
    await mountedWithAssets;

    const patchAvatar = (avatarAssetId: string | null) =>
      originalFetch(`${pluginOrigin}/api/v1/me/profile`, {
        method: 'PATCH',
        headers: {
          origin: pluginOrigin,
          cookie: pluginCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ avatarAssetId }),
      });
    expect((await patchAvatar(foreignImg)).status).toBe(404);
    expect((await patchAvatar(pendingImg)).status).toBe(409);
    expect((await patchAvatar(readyVideo)).status).toBe(400);
    const savedAvatar = await patchAvatar(readyImg);
    expect(savedAvatar.status).toBe(200);
    expect(await savedAvatar.json()).toMatchObject({ avatarAssetId: readyImg });

    // The pre-U1 default binding contract accepts static assets above the GIF conversion cap.
    const largeImage = randomUUID(),
      largeSize = 21 * 1024 * 1024;
    const largeKey = `mio/raw/${largeImage}/${randomUUID()}`;
    await upgradePool.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,state,staging_key,raw_key,expires_at)
       VALUES($1,$2,'large.png','image/png',$3,'ready',$4,$5,now()+interval '1 day')`,
      [largeImage, profile.userId, largeSize, `mio/staging/${largeImage}`, largeKey],
    );
    avatarHead.mockResolvedValue({
      statusCode: 200,
      ETag: 'large-static-avatar',
      headers: { 'content-length': String(largeSize), 'content-type': 'image/png' },
    });
    const savedLarge = await patchAvatar(largeImage);
    expect(savedLarge.status).toBe(200);
    const legacyLarge = await savedLarge.json();
    expect(legacyLarge.avatarAssetId).toBe(largeImage);
    expect(Object.keys(legacyLarge).sort()).toEqual(
      [
        'userId',
        'displayId',
        'name',
        'avatarAssetId',
        'phoneNumber',
        'phoneNumberVerified',
        'wechatBound',
        'onelinkBound',
      ].sort(),
    );
    const displayedLarge = await originalFetch(`${pluginOrigin}/api/v1/me/profile?view=display`, {
      headers: { origin: pluginOrigin, cookie: pluginCookie },
    });
    expect(displayedLarge.status).toBe(200);
    const displayed = await displayedLarge.json();
    expect(displayed.avatarAssetId).toBe(largeImage);
    expect(new URL(displayed.avatarUrl).pathname).toBe('/' + largeKey);
    avatarHead.mockResolvedValueOnce({
      statusCode: 200,
      ETag: 'large-static-avatar',
      headers: { 'content-length': String(largeSize - 1), 'content-type': 'image/png' },
    });
    expect((await patchAvatar(largeImage)).status).toBe(409);
  } finally {
    vi.unstubAllEnvs();
    if (ctx) await ctx.fiber.dispose();
    await upgradePool.end();
    await upgradeDb.close();
    avatarHead.mockRestore();
  }
}, 30_000);

it('enforces runtime smsMode bypass/disabled with a real SMS sender wired while keeping phone-binding on real SMS', async () => {
  const srv = createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('missing address');
  const baseOrigin = `http://127.0.0.1:${addr.port}`;

  let policy: AuthRuntimePolicy = {
    emailPasswordEnabled: true,
    smsMode: 'disabled',
    smsBypassCode: '654321',
  };
  let smsSendCalls = 0;
  const sentCodes = new Map<string, string>();
  const fakeSender = async (phone: string, code: string) => {
    smsSendCalls += 1;
    sentCodes.set(phone, code);
  };

  const config = readAuthConfig({
    MIO_AUTH_BASE_URL: baseOrigin,
    MIO_AUTH_SECRET: secret,
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_AUTH_EMAIL_PASSWORD_ENABLED: 'false',
  })!;
  const policyAuth = await createAuthentication(config, undefined, fakeSender, () => policy);
  srv.on(
    'request',
    createAuthHandler(config, policyAuth, undefined, () => policy),
  );

  const req = (path: string, body?: unknown, cookie?: string) =>
    originalFetch(`${baseOrigin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin: baseOrigin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  try {
    // Email/password works immediately even though config.emailPasswordEnabled=false because policy overrides to true!
    const emailUp = await req('/api/auth/sign-up/email', {
      name: 'Binder',
      email: `binder-${randomUUID()}@example.test`,
      password,
    });
    expect(emailUp.status).toBe(200);
    const binderCookie = cookies(emailUp);

    // 1. smsMode === 'disabled': all 4 phone endpoints return 503 SMS_UNAVAILABLE and never invoke sender.
    for (const [path, body, cookie] of [
      ['/api/auth/phone-number/send-otp', { phoneNumber: '13800138081' }, undefined],
      ['/api/auth/phone-number/verify', { phoneNumber: '13800138081', code: '654321' }, undefined],
      ['/api/auth/phone-binding/send-otp', { phoneNumber: '13800138082' }, binderCookie],
      [
        '/api/auth/phone-binding/confirm',
        { phoneNumber: '13800138082', code: '654321' },
        binderCookie,
      ],
    ] as const) {
      const res = await req(path, body, cookie);
      expect(res.status, path).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe('SMS_UNAVAILABLE');
    }
    expect(smsSendCalls).toBe(0);

    // 2. smsMode === 'bypass': login send-otp skips sender & budget; verify accepts fixed code without send-otp.
    policy = { emailPasswordEnabled: true, smsMode: 'bypass', smsBypassCode: '654321' };
    const bypassSend = await req('/api/auth/phone-number/send-otp', { phoneNumber: '13800138083' });
    expect(bypassSend.status).toBe(200);
    expect(await bypassSend.json()).toEqual({ status: true });
    expect(smsSendCalls).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS c FROM "mioSmsBudget"')).rows[0].c).toBe(0);

    // Invalid bypass code -> 400 INVALID_OTP
    const wrongVerify = await req('/api/auth/phone-number/verify', {
      phoneNumber: '13800138084',
      code: '000000',
    });
    expect(wrongVerify.status).toBe(400);
    expect(((await wrongVerify.json()) as { code: string }).code).toBe('INVALID_OTP');

    // Valid bypass code without prior send-otp -> 200 & displayId assigned
    const okVerify = await req('/api/auth/phone-number/verify', {
      phoneNumber: '13800138084',
      code: '654321',
    });
    expect(okVerify.status).toBe(200);
    const bypassCookie = cookies(okVerify);
    const bypassProfile = (await (
      await req('/api/v1/me/profile', undefined, bypassCookie)
    ).json()) as {
      displayId: string;
      phoneNumber: string;
      phoneNumberVerified: boolean;
    };
    expect(bypassProfile.displayId).toMatch(/^miioo_\d{6}$/);
    expect(bypassProfile.phoneNumber).toBe('+8613800138084');
    expect(bypassProfile.phoneNumberVerified).toBe(true);
    expect(smsSendCalls).toBe(0);

    // Missing/malformed smsBypassCode under bypass -> fail closed 503 SMS_UNAVAILABLE on both send-otp and verify
    policy = { emailPasswordEnabled: true, smsMode: 'bypass', smsBypassCode: null };
    const missingCodeSendRes = await req('/api/auth/phone-number/send-otp', {
      phoneNumber: '13800138084',
    });
    expect(missingCodeSendRes.status).toBe(503);
    expect(((await missingCodeSendRes.json()) as { code: string }).code).toBe('SMS_UNAVAILABLE');
    const missingCodeRes = await req('/api/auth/phone-number/verify', {
      phoneNumber: '13800138084',
      code: '654321',
    });
    expect(missingCodeRes.status).toBe(503);
    expect(((await missingCodeRes.json()) as { code: string }).code).toBe('SMS_UNAVAILABLE');

    // Unverified phone user cannot sign in via bypass -> 400 INVALID_OTP
    policy = { emailPasswordEnabled: true, smsMode: 'bypass', smsBypassCode: '654321' };
    await pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "phoneNumber", "phoneNumberVerified", "createdAt", "updatedAt")
       VALUES ($1, 'Unverified', $2, false, '+8613800138085', false, now(), now())`,
      [randomUUID(), `unverified-${randomUUID()}@example.test`],
    );
    const unverifiedRes = await req('/api/auth/phone-number/verify', {
      phoneNumber: '13800138085',
      code: '654321',
    });
    expect(unverifiedRes.status).toBe(400);
    expect(((await unverifiedRes.json()) as { code: string }).code).toBe('INVALID_OTP');

    // Phone binding ALSO follows bypass: requires recent session, skips real SMS sender & budget, and verifies fixed code.
    const unauthBindSend = await req('/api/auth/phone-binding/send-otp', {
      phoneNumber: '13800138086',
    });
    expect(unauthBindSend.status).toBe(401);
    expect(((await unauthBindSend.json()) as { code: string }).code).toBe('SESSION_REQUIRED');

    const bindSend = await req(
      '/api/auth/phone-binding/send-otp',
      { phoneNumber: '13800138086' },
      binderCookie,
    );
    expect(bindSend.status).toBe(200);
    expect(await bindSend.json()).toEqual({ status: true });
    expect(smsSendCalls).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS c FROM "mioSmsBudget"')).rows[0].c).toBe(0);

    const bindWithWrongCode = await req(
      '/api/auth/phone-binding/confirm',
      { phoneNumber: '13800138086', code: '000000' },
      binderCookie,
    );
    expect(bindWithWrongCode.status).toBe(400);
    expect(((await bindWithWrongCode.json()) as { code: string }).code).toBe('INVALID_OTP');

    // Occupied phone still rejected with 409 PHONE_CONFLICT under bypass
    const bindOccupied = await req(
      '/api/auth/phone-binding/confirm',
      { phoneNumber: '13800138084', code: '654321' },
      binderCookie,
    );
    expect(bindOccupied.status).toBe(409);
    expect(((await bindOccupied.json()) as { code: string }).code).toBe('PHONE_CONFLICT');

    // Valid fixed bypass code binds free phone without calling real SMS sender
    const bindWithBypassCode = await req(
      '/api/auth/phone-binding/confirm',
      { phoneNumber: '13800138086', code: '654321' },
      binderCookie,
    );
    expect(bindWithBypassCode.status).toBe(200);
    expect(smsSendCalls).toBe(0);
    expect(sentCodes.size).toBe(0);

    // Switching back to live mode still uses real SMS sender and rejects fixed bypass code
    policy = { emailPasswordEnabled: true, smsMode: 'live', smsBypassCode: '654321' };
    const liveBinderRes = await req('/api/auth/sign-up/email', {
      name: 'Live Binder',
      email: `live-binder-${randomUUID()}@example.test`,
      password,
    });
    expect(liveBinderRes.status).toBe(200);
    const liveBinderCookie = cookies(liveBinderRes);

    const liveBindSend = await req(
      '/api/auth/phone-binding/send-otp',
      { phoneNumber: '13800138087' },
      liveBinderCookie,
    );
    expect(liveBindSend.status).toBe(200);
    expect(smsSendCalls).toBe(1);
    const realBindCode = sentCodes.get('+8613800138087')!;
    expect(realBindCode).toMatch(/^\d{6}$/);

    const liveBindWrongCode = await req(
      '/api/auth/phone-binding/confirm',
      { phoneNumber: '13800138087', code: realBindCode === '654321' ? '123456' : '654321' },
      liveBinderCookie,
    );
    expect(liveBindWrongCode.status).toBe(400);

    const liveBindWithRealCode = await req(
      '/api/auth/phone-binding/confirm',
      { phoneNumber: '13800138087', code: realBindCode },
      liveBinderCookie,
    );
    expect(liveBindWithRealCode.status).toBe(200);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    await policyAuth.close();
  }
}, 30_000);

it('hot-reloads admin global settings in full Mio plugin, hydrates on restart, and falls back when admin is disabled', async () => {
  const pluginDb = await authDatabase();
  const pluginPool = new Pool({ connectionString: pluginDb.observerURL });
  let ctx: Context | undefined;
  try {
    await pluginPool.query(providerSchemaSQL);
    await pluginPool.query(adminSchemaSQL);

    ctx = new Context();
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    const pluginOrigin = ctx.webServer.getOrigin();

    const migrated = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        MIO_AUTH_BASE_URL: pluginOrigin,
        MIO_AUTH_SECRET: secret,
        MIO_AUTH_DATABASE_URL: pluginDb.url,
      },
    });
    expect(migrated.status, migrated.stderr).toBe(0);

    // Seed super admin account directly in admin table
    const adminPassHash = await hashAdminPassword('global_admin_pass');
    await pluginPool.query(
      `INSERT INTO mio_admin_accounts (id, username, password_hash, is_super_admin)
       VALUES ($1, 'miioo_admin', $2, true)`,
      [randomUUID(), adminPassHash],
    );

    const setPluginEnv = (overrides: Record<string, string | undefined> = {}) => {
      vi.unstubAllEnvs();
      const baseEnv: Record<string, string | undefined> = {
        MIO_AUTH_TEST_TOKEN: randomBytes(24).toString('hex'),
        MIO_AUTH_BASE_URL: pluginOrigin,
        MIO_AUTH_SECRET: secret,
        MIO_AUTH_DATABASE_URL: pluginDb.url,
        MIO_AUTH_ALLOWED_ORIGINS: '[]',
        MIO_AUTH_RATE_LIMIT_BACKEND: 'database',
        MIO_AUTH_EMAIL_PASSWORD_ENABLED: 'true',
        MIO_AUTH_SMS_ENABLED: 'false',
        MIO_PROVIDERS_DATABASE_URL: pluginDb.url,
        MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
        MIO_PROVIDERS_MASTER_KEY_ID: 'global-settings-test-v1',
        MIO_ADMIN_ENABLED: 'true',
        ...overrides,
      };
      for (const [key, value] of Object.entries(baseEnv)) {
        if (value !== undefined) vi.stubEnv(key, value);
      }
    };

    const req = (path: string, method = 'GET', body?: unknown, cookie?: string) =>
      originalFetch(`${pluginOrigin}${path}`, {
        method,
        headers: {
          origin: pluginOrigin,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    // 1. Mount plugin with MIO_ADMIN_ENABLED=true, MIO_AUTH_SMS_ENABLED=false
    setPluginEnv();
    let mounted = ctx.plugin(Mio, { tokenEnv: 'MIO_AUTH_TEST_TOKEN', allowedOrigins: [] });
    await mounted;

    // No C-end /api/auth/methods endpoint exists
    expect((await req('/api/auth/methods')).status).toBe(404);

    // Admin login
    const adminLogin = await req('/api/v1/admin/auth/login', 'POST', {
      username: 'miioo_admin',
      password: 'global_admin_pass',
    });
    expect(adminLogin.status).toBe(200);
    const adminCookie = cookies(adminLogin);

    const initSettings = (await (
      await req('/api/v1/admin/settings/global', 'GET', undefined, adminCookie)
    ).json()) as {
      settings: { revision: number };
      runtime: { envEmailPasswordDefault: boolean; smsProviderConfigured: boolean };
    };
    expect(initSettings.settings.revision).toBe(0);
    expect(initSettings.runtime).toEqual({
      envEmailPasswordDefault: true,
      smsProviderConfigured: false,
    });

    // Sign up email user while email/password is enabled
    const emailAddr = 'hot-toggle@example.test';
    const signUp = await req('/api/auth/sign-up/email', 'POST', {
      name: 'Hot Toggle User',
      email: emailAddr,
      password,
    });
    expect(signUp.status).toBe(200);
    const emailUserCookie = cookies(signUp);

    // Hot-toggle email/password OFF (rev 0 -> 1) without restarting
    const toggleOff = await req(
      '/api/v1/admin/settings/global',
      'PATCH',
      {
        expectedRevision: 0,
        auth: { emailPasswordEnabled: false, smsMode: 'live', smsBypassCode: null },
      },
      adminCookie,
    );
    expect(toggleOff.status).toBe(200);

    const blockedSignIn = await req('/api/auth/sign-in/email', 'POST', {
      email: emailAddr,
      password,
    });
    expect(blockedSignIn.status).toBe(503);
    expect(((await blockedSignIn.json()) as { error: { code: string } }).error.code).toBe(
      'EMAIL_PASSWORD_UNAVAILABLE',
    );
    // Existing session still works while email/password is disabled
    expect((await req('/api/v1/me', 'GET', undefined, emailUserCookie)).status).toBe(200);

    // Hot-toggle email/password ON + SMS bypass (rev 1 -> 2) without restarting
    const toggleBypass = await req(
      '/api/v1/admin/settings/global',
      'PATCH',
      {
        expectedRevision: 1,
        auth: { emailPasswordEnabled: true, smsMode: 'bypass', smsBypassCode: '246810' },
      },
      adminCookie,
    );
    expect(toggleBypass.status).toBe(200);

    // Email sign-in works again
    expect(
      (await req('/api/auth/sign-in/email', 'POST', { email: emailAddr, password })).status,
    ).toBe(200);

    // SMS bypass works with MIO_AUTH_SMS_ENABLED=false
    const sendBypass = await req('/api/auth/phone-number/send-otp', 'POST', {
      phoneNumber: '13900139001',
    });
    expect(sendBypass.status).toBe(200);
    expect(await sendBypass.json()).toEqual({ status: true });
    expect(
      (await pluginPool.query('SELECT count(*)::int AS c FROM "mioSmsBudget"')).rows[0].c,
    ).toBe(0);

    const badBypass = await req('/api/auth/phone-number/verify', 'POST', {
      phoneNumber: '13900139002',
      code: '111111',
    });
    expect(badBypass.status).toBe(400);
    expect(((await badBypass.json()) as { code: string }).code).toBe('INVALID_OTP');

    // Verify WITHOUT calling send-otp first
    const okBypass = await req('/api/auth/phone-number/verify', 'POST', {
      phoneNumber: '13900139002',
      code: '246810',
    });
    expect(okBypass.status).toBe(200);
    expect(await okBypass.json()).toEqual({ status: true });
    const phoneCookie = cookies(okBypass);
    expect(phoneCookie).toContain('mio.session_token=');
    const phoneProfile = (await (
      await req('/api/v1/me/profile', 'GET', undefined, phoneCookie)
    ).json()) as { userId: string; displayId: string; phoneNumber: string };
    expect(phoneProfile.displayId).toMatch(/^miioo_\d{6}$/);
    expect(phoneProfile.phoneNumber).toBe('+8613900139002');

    // Disabled account trying bypass login -> 403 ACCOUNT_DISABLED
    await pluginPool.query(
      'UPDATE "user" SET disabled = true, "disabledAt" = now() WHERE id = $1',
      [phoneProfile.userId],
    );
    const disabledBypass = await req('/api/auth/phone-number/verify', 'POST', {
      phoneNumber: '13900139002',
      code: '246810',
    });
    expect(disabledBypass.status).toBe(403);
    expect(((await disabledBypass.json()) as { code: string }).code).toBe('ACCOUNT_DISABLED');
    expect(disabledBypass.headers.getSetCookie()).toEqual([]);

    // Phone binding ALSO follows bypass even without real SMS provider configured
    const bindSend = await req(
      '/api/auth/phone-binding/send-otp',
      'POST',
      { phoneNumber: '13900139003' },
      emailUserCookie,
    );
    expect(bindSend.status).toBe(200);
    expect(await bindSend.json()).toEqual({ status: true });

    const badBindConfirm = await req(
      '/api/auth/phone-binding/confirm',
      'POST',
      { phoneNumber: '13900139003', code: '000000' },
      emailUserCookie,
    );
    expect(badBindConfirm.status).toBe(400);
    expect(((await badBindConfirm.json()) as { code: string }).code).toBe('INVALID_OTP');

    const bindConfirm = await req(
      '/api/auth/phone-binding/confirm',
      'POST',
      { phoneNumber: '13900139003', code: '246810' },
      emailUserCookie,
    );
    expect(bindConfirm.status).toBe(200);
    expect(await bindConfirm.json()).toEqual({ status: true });
    const boundEmailProfile = (await (
      await req('/api/v1/me/profile', 'GET', undefined, emailUserCookie)
    ).json()) as { phoneNumber: string; phoneNumberVerified: boolean };
    expect(boundEmailProfile.phoneNumber).toBe('+8613900139003');
    expect(boundEmailProfile.phoneNumberVerified).toBe(true);

    // Hot-toggle smsMode to 'disabled' (rev 2 -> 3) -> all 4 phone endpoints return 503
    const toggleDisabled = await req(
      '/api/v1/admin/settings/global',
      'PATCH',
      {
        expectedRevision: 2,
        auth: { emailPasswordEnabled: true, smsMode: 'disabled', smsBypassCode: '246810' },
      },
      adminCookie,
    );
    expect(toggleDisabled.status).toBe(200);
    for (const [path, body, cookie] of [
      ['/api/auth/phone-number/send-otp', { phoneNumber: '13900139004' }, undefined],
      ['/api/auth/phone-number/verify', { phoneNumber: '13900139004', code: '246810' }, undefined],
      ['/api/auth/phone-binding/send-otp', { phoneNumber: '13900139004' }, emailUserCookie],
      [
        '/api/auth/phone-binding/confirm',
        { phoneNumber: '13900139004', code: '246810' },
        emailUserCookie,
      ],
    ] as const) {
      const res = await req(path, 'POST', body, cookie);
      expect(res.status, path).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe('SMS_UNAVAILABLE');
    }

    // 2. Save emailPasswordEnabled=false + bypass '135790' (rev 3 -> 4), then restart plugin to verify immediate DB hydration
    const saveBeforeRestart = await req(
      '/api/v1/admin/settings/global',
      'PATCH',
      {
        expectedRevision: 3,
        auth: { emailPasswordEnabled: false, smsMode: 'bypass', smsBypassCode: '135790' },
      },
      adminCookie,
    );
    expect(saveBeforeRestart.status).toBe(200);

    await mounted.dispose();
    setPluginEnv({ MIO_AUTH_EMAIL_PASSWORD_ENABLED: 'true', MIO_ADMIN_ENABLED: 'true' });
    mounted = ctx.plugin(Mio, { tokenEnv: 'MIO_AUTH_TEST_TOKEN', allowedOrigins: [] });
    await mounted;

    // Immediately after restart (without hitting any admin API), DB global settings are active!
    const emailAfterRestart = await req('/api/auth/sign-in/email', 'POST', {
      email: emailAddr,
      password,
    });
    expect(emailAfterRestart.status).toBe(503);
    expect(((await emailAfterRestart.json()) as { error: { code: string } }).error.code).toBe(
      'EMAIL_PASSWORD_UNAVAILABLE',
    );
    const bypassAfterRestart = await req('/api/auth/phone-number/verify', 'POST', {
      phoneNumber: '13900139005',
      code: '135790',
    });
    expect(bypassAfterRestart.status).toBe(200);

    // 3. Without MIO_ADMIN_ENABLED, auth falls back to MIO_AUTH_EMAIL_PASSWORD_ENABLED and smsMode='live'
    await mounted.dispose();
    setPluginEnv({
      MIO_ADMIN_ENABLED: 'false',
      MIO_AUTH_EMAIL_PASSWORD_ENABLED: 'false',
      MIO_PROVIDERS_DATABASE_URL: undefined,
      MIO_PROVIDERS_MASTER_KEY: undefined,
      MIO_PROVIDERS_MASTER_KEY_ID: undefined,
    });
    mounted = ctx.plugin(Mio, { tokenEnv: 'MIO_AUTH_TEST_TOKEN', allowedOrigins: [] });
    await mounted;

    expect(
      (await req('/api/auth/sign-in/email', 'POST', { email: emailAddr, password })).status,
    ).toBe(503);
    expect(
      (
        await req('/api/auth/phone-number/verify', 'POST', {
          phoneNumber: '13900139005',
          code: '135790',
        })
      ).status,
    ).toBe(503);

    await mounted.dispose();
    setPluginEnv({
      MIO_ADMIN_ENABLED: 'false',
      MIO_AUTH_EMAIL_PASSWORD_ENABLED: 'true',
      MIO_PROVIDERS_DATABASE_URL: undefined,
      MIO_PROVIDERS_MASTER_KEY: undefined,
      MIO_PROVIDERS_MASTER_KEY_ID: undefined,
    });
    mounted = ctx.plugin(Mio, { tokenEnv: 'MIO_AUTH_TEST_TOKEN', allowedOrigins: [] });
    await mounted;

    expect(
      (await req('/api/auth/sign-in/email', 'POST', { email: emailAddr, password })).status,
    ).toBe(200);
    expect(
      (
        await req('/api/auth/phone-number/send-otp', 'POST', {
          phoneNumber: '13900139005',
        })
      ).status,
    ).toBe(503);
  } finally {
    vi.unstubAllEnvs();
    if (ctx) await ctx.fiber.dispose();
    await pluginPool.end();
    await pluginDb.close();
  }
}, 45_000);
