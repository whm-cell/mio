import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { HttpError } from '@mio/foundation/errors';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readAuthConfig } from '../../src/auth/config.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import { createAuthHandler } from '../../src/auth/http.ts';
import type { AvatarAssetStatus } from '../../src/auth/http.ts';
import { authDatabase } from '../support/auth-database.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let auth: Awaited<ReturnType<typeof createAuthentication>>;
const server = createServer();
let origin: string;
const secret = randomBytes(40).toString('hex');
const password = 'profile-regression-password-42';
const verify = vi.fn<() => Promise<AvatarAssetStatus>>(async () => 'ok');
const sign = vi.fn(async () => 'https://avatar.invalid/private?expires=300');
const normalize = vi.fn<
  (
    identity: { userId: string; sessionId: string },
    sourceAssetId: string,
  ) => Promise<{ avatarAssetId: string }>
>(async () => ({ avatarAssetId: randomUUID() }));
const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
const call = (
  path: string,
  session?: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'PATCH',
) =>
  fetch(`${origin}${path}`, {
    method,
    headers: {
      origin,
      ...(session ? { cookie: session } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function signup() {
  const email = `${randomUUID()}@example.test`;
  const response = await call(
    '/api/auth/sign-up/email',
    undefined,
    { name: '原昵称', email, password },
    'POST',
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const session = cookie(response);
  const me = (await (await call('/api/v1/me', session)).json()) as {
    userId: string;
    sessionId: string;
  };
  return { ...me, cookie: session, email };
}
function migrate(url: string, apply: boolean) {
  return spawnSync(
    process.execPath,
    ['scripts/service/migrate-auth.ts', ...(apply ? ['--apply'] : [])],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: { MIO_AUTH_BASE_URL: origin, MIO_AUTH_DATABASE_URL: url, MIO_AUTH_SECRET: secret },
    },
  );
}
beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('address');
  origin = `http://127.0.0.1:${address.port}`;
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  const result = migrate(database.url, true);
  expect(result.status, result.stderr).toBe(0);
  auth = await createAuthentication(
    readAuthConfig({
      MIO_AUTH_BASE_URL: origin,
      MIO_AUTH_DATABASE_URL: database.url,
      MIO_AUTH_SECRET: secret,
    })!,
  );
  server.on(
    'request',
    createAuthHandler(
      readAuthConfig({
        MIO_AUTH_BASE_URL: origin,
        MIO_AUTH_DATABASE_URL: database.url,
        MIO_AUTH_SECRET: secret,
      })!,
      auth,
      verify,
      undefined,
      { avatarUrl: sign, normalizeAvatar: normalize },
    ),
  );
}, 30_000);
beforeEach(async () => {
  await pool.query('TRUNCATE "account","session","user","verification","rateLimit" CASCADE');
  vi.clearAllMocks();
  verify.mockResolvedValue('ok');
  sign.mockResolvedValue('https://avatar.invalid/private?expires=300');
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await auth?.close();
  await pool?.end();
  await database?.close();
});

it('keeps the exact default contract and masks display profiles, including legacy fallbacks', async () => {
  const user = await signup();
  await pool.query(
    'UPDATE "user" SET "displayId"=NULL,"phoneNumber"=$2,"phoneNumberVerified"=true WHERE id=$1',
    [user.userId, '+8613800138000'],
  );
  await pool.query(
    `INSERT INTO "account"(id,"providerId","accountId","userId","createdAt","updatedAt") VALUES($1,'wechat','legacy-wechat',$2,now(),now())`,
    [randomUUID(), user.userId],
  );
  const legacy = await (await call('/api/v1/me/profile', user.cookie)).json();
  expect(Object.keys(legacy).sort()).toEqual(
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
  expect(legacy.phoneNumber).toBe('+8613800138000');
  const display = await (await call('/api/v1/me/profile?view=display', user.cookie)).json();
  expect(display).toEqual({
    userId: user.userId,
    displayId: user.userId,
    name: '原昵称',
    avatarAssetId: null,
    avatarUrl: null,
    maskedPhoneNumber: '+86138****8000',
    phoneNumberVerified: true,
    wechatBound: true,
    wechatNickname: '已绑定',
    onelinkBound: false,
  });
  expect(JSON.stringify(display)).not.toContain('+8613800138000');
  const updated = await call('/api/v1/me/profile?view=display', user.cookie, {
    name: '🦊'.repeat(50),
  });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({
    name: '🦊'.repeat(50),
    maskedPhoneNumber: '+86138****8000',
  });
  const avatar = randomUUID();
  expect((await call('/api/v1/me/profile', user.cookie, { avatarAssetId: avatar })).status).toBe(
    200,
  );
  expect(await (await call('/api/v1/me/profile', user.cookie)).json()).toMatchObject({
    name: '🦊'.repeat(50),
    avatarAssetId: avatar,
  });
  const login = await call(
    '/api/auth/sign-in/email',
    undefined,
    { email: user.email, password },
    'POST',
  );
  expect(login.status).toBe(200);
  expect(await (await call('/api/v1/me/profile?view=display', cookie(login))).json()).toMatchObject(
    { name: '🦊'.repeat(50), avatarAssetId: avatar },
  );
});

it('isolates avatar read/sign failures from GET, name-only, null PATCH and post-write signing', async () => {
  const user = await signup(),
    avatar = randomUUID();
  await pool.query('UPDATE "user" SET "avatarAssetId"=$2 WHERE id=$1', [user.userId, avatar]);
  sign.mockRejectedValue(new Error('asset database/signing down'));
  verify.mockRejectedValue(new Error('asset database down'));
  const get = await call('/api/v1/me/profile?view=display', user.cookie);
  expect(get.status).toBe(200);
  expect(await get.json()).toMatchObject({ avatarAssetId: avatar, avatarUrl: null });
  const rename = await call('/api/v1/me/profile?view=display', user.cookie, { name: '改名' });
  expect(rename.status).toBe(200);
  expect(await rename.json()).toMatchObject({
    name: '改名',
    avatarAssetId: avatar,
    avatarUrl: null,
  });
  expect(verify).not.toHaveBeenCalled();
  const denied = await call('/api/v1/me/profile?view=display', user.cookie, {
    avatarAssetId: randomUUID(),
  });
  expect(denied.status).toBe(503);
  expect((await denied.json()).error.code).toBe('ASSET_UNAVAILABLE');
  verify.mockResolvedValue('ok');
  const next = randomUUID();
  const saved = await call('/api/v1/me/profile?view=display', user.cookie, { avatarAssetId: next });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ avatarAssetId: next, avatarUrl: null });
  const cleared = await call('/api/v1/me/profile?view=display', user.cookie, {
    avatarAssetId: null,
  });
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toMatchObject({ avatarAssetId: null, avatarUrl: null });
  expect(
    (await pool.query('SELECT "avatarAssetId",image FROM "user" WHERE id=$1', [user.userId]))
      .rows[0],
  ).toEqual({ avatarAssetId: null, image: null });
});

it('protects normalize with cookie identity, Origin, bounded JSON and exact UUID input', async () => {
  const user = await signup(),
    id = randomUUID(),
    path = '/api/v1/me/profile/avatar/normalize';
  expect((await call(path, undefined, { sourceAssetId: id }, 'POST')).status).toBe(401);
  const token = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { origin, authorization: 'Bearer service-token', 'content-type': 'application/json' },
    body: JSON.stringify({ sourceAssetId: id }),
  });
  expect(token.status).toBe(401);
  for (const body of [
    {},
    { sourceAssetId: 'invalid' },
    { sourceAssetId: id, userId: user.userId },
    { sourceAssetId: null },
  ])
    expect((await call(path, user.cookie, body, 'POST')).status).toBe(400);
  for (const headers of [
    { cookie: user.cookie, 'content-type': 'application/json' },
    { cookie: user.cookie, origin: 'https://foreign.invalid', 'content-type': 'application/json' },
  ])
    expect(
      (
        await fetch(`${origin}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ sourceAssetId: id }),
        })
      ).status,
    ).toBe(403);
  expect((await call(path, user.cookie)).status).toBe(405);
  expect(
    (
      await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { cookie: user.cookie, origin, 'content-type': 'text/plain' },
        body: '{}',
      })
    ).status,
  ).toBe(415);
  expect(
    (await call(path, user.cookie, { sourceAssetId: 'a'.repeat(17 * 1024) }, 'POST')).status,
  ).toBe(413);
  expect(normalize).not.toHaveBeenCalled();
  const response = await call(path, user.cookie, { sourceAssetId: id }, 'POST');
  expect(response.status).toBe(200);
  expect(normalize).toHaveBeenCalledWith({ userId: user.userId, sessionId: user.sessionId }, id);
  for (const status of [400, 404, 409, 503]) {
    normalize.mockRejectedValueOnce(new HttpError(status, 'ASSET_TEST_ERROR'));
    const failure = await call(path, user.cookie, { sourceAssetId: id }, 'POST');
    expect(failure.status).toBe(status);
    expect((await failure.json()).error.code).toBe('ASSET_TEST_ERROR');
  }
});

it('previews and applies nullable WeChat nickname incrementally without startup DDL or backfill', async () => {
  const fixture = await authDatabase(),
    observer = new Pool({ connectionString: fixture.url });
  try {
    expect(migrate(fixture.url, true).status).toBe(0);
    await observer.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('legacy','旧昵称','legacy@example.test',false,now(),now());
      INSERT INTO "account"(id,"providerId","accountId","userId","createdAt","updatedAt") VALUES('legacy-wx','wechat','legacy-subject','legacy',now(),now());
      INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES('legacy-session','legacy','legacy-session-token',now()+interval '1 day',now(),now());
      ALTER TABLE "account" DROP COLUMN "wechatNickname"`);
    const config = readAuthConfig({
      MIO_AUTH_BASE_URL: origin,
      MIO_AUTH_DATABASE_URL: fixture.url,
      MIO_AUTH_SECRET: secret,
    })!;
    const savedRows = () =>
      Promise.all(
        ['user', 'account', 'session'].map(
          async (table) =>
            (
              await observer.query(
                `SELECT to_jsonb(t)-'wechatNickname' AS data FROM "${table}" t ORDER BY id`,
              )
            ).rows,
        ),
      );
    const before = await savedRows();
    expect(before.map((rows) => rows.length)).toEqual([1, 1, 1]);
    await expect(createAuthentication(config)).rejects.toThrow('AUTH_SCHEMA');
    expect(await savedRows()).toEqual(before);
    const preview = migrate(fixture.url, false);
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('wechatNickname');
    expect(await savedRows()).toEqual(before);
    expect(
      (
        await observer.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='account' AND column_name='wechatNickname'`,
        )
      ).rows,
    ).toEqual([]);
    expect(migrate(fixture.url, true).status).toBe(0);
    expect(migrate(fixture.url, true).status).toBe(0);
    expect(await savedRows()).toEqual(before);
    const runtime = await createAuthentication(config);
    try {
      expect(await runtime.profile('legacy')).toMatchObject({
        name: '旧昵称',
        wechatBound: true,
        wechatNickname: null,
      });
    } finally {
      await runtime.close();
    }
    expect(await savedRows()).toEqual(before);
    expect(
      (await observer.query('SELECT "wechatNickname","accountId" FROM "account"')).rows,
    ).toEqual([{ wechatNickname: null, accountId: 'legacy-subject' }]);
  } finally {
    await observer.end();
    await fixture.close();
  }
}, 30_000);
