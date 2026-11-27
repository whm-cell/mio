import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { readAuthConfig } from '../../src/auth/config.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import { createAuthHandler } from '../../src/auth/http.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { AssetStore } from '../../src/assets/store.ts';
import { StorageAccounting } from '../../src/assets/storage-store.ts';
import { createStorageUsageHandler } from '../../src/assets/storage-http.ts';
import { createAssetService } from '../../src/assets/service.ts';
import type { StoragePolicy } from '../../src/assets/storage.ts';

let authenticationDB: Awaited<ReturnType<typeof authDatabase>>,
  mediaDB: Awaited<ReturnType<typeof authDatabase>>;
let auth: Awaited<ReturnType<typeof createAuthentication>>, pool: Pool, storage: StorageAccounting;
let assets: ReturnType<typeof createAssetService>, policy: StoragePolicy;
let origin: string,
  bridgeAvailable = true,
  usageAvailable = true;
const server = createServer();
const password = 'storage-regression-password-42';
const secret = randomBytes(40).toString('hex');
const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((x) => x.split(';')[0])
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
const avatarSource = {
  type: 'avatar',
  async read(owner: string) {
    const avatarAssetId = await auth.avatarAssetId(owner);
    return avatarAssetId ? [{ type: 'avatar', id: owner, assetIds: [avatarAssetId] }] : [];
  },
};
async function signup() {
  const response = await call(
    '/api/auth/sign-up/email',
    undefined,
    { name: 'storage user', email: `${randomUUID()}@example.test`, password },
    'POST',
  );
  expect(response.status).toBe(200);
  const session = cookie(response);
  const me = await (await call('/api/v1/me', session)).json();
  return { session, userId: me.userId as string };
}
async function publish(owner: string, size = 60) {
  const id = randomUUID(),
    lease = randomUUID();
  const store = new AssetStore(pool);
  await store.create(id, owner, 'avatar.webp', 'image/webp', size);
  await store.claim(id, owner, 'avatar-etag', lease);
  await store.commit(id, owner, lease, `mio/raw/${id}/avatar.webp`);
  return id;
}
beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('address');
  origin = `http://127.0.0.1:${address.port}`;
  authenticationDB = await authDatabase();
  mediaDB = await authDatabase();
  pool = new Pool({ connectionString: mediaDB.url });
  await pool.query(assetSchemaSQL);
  const config = readAuthConfig({
    MIO_AUTH_BASE_URL: origin,
    MIO_AUTH_DATABASE_URL: authenticationDB.url,
    MIO_AUTH_SECRET: secret,
  })!;
  const migrated = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
    env: {
      MIO_AUTH_BASE_URL: origin,
      MIO_AUTH_DATABASE_URL: authenticationDB.url,
      MIO_AUTH_SECRET: secret,
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(migrated.status, migrated.stderr).toBe(0);
  auth = await createAuthentication(config);
  assets = createAssetService(new AssetStore(pool), {
    uploadUrl: () => '',
    downloadUrl: () => '',
    avatarInlineUrl: () => 'https://private.invalid/avatar',
    head: async () => ({ size: 60, etag: 'avatar-etag', contentType: 'image/webp' }),
    copy: async () => {},
    delete: async () => {},
  });
  const handler = createAuthHandler(config, auth, assets.verifyAvatar, undefined, {
    avatarUrl: assets.avatarUrl,
    async avatarChanged(owner) {
      if (!bridgeAvailable) throw new Error('media unavailable');
      await storage.reconcileOwner(owner, [avatarSource]);
    },
  });
  const usage = createStorageUsageHandler(
    () => (usageAvailable ? storage : undefined),
    auth.identity,
    [origin],
  );
  server.on('request', (request, response) => {
    void ((request.url ?? '').startsWith('/api/v1/me/storage-usage') ? usage : handler)(
      request,
      response,
    );
  });
}, 30000);
beforeEach(async () => {
  bridgeAvailable = true;
  usageAvailable = true;
  policy = { revision: 1, quotaBytes: 100, warningAvailableBytes: 20 };
  storage = new StorageAccounting(pool, () => policy);
  await pool.query('UPDATE mio_storage_policy SET revision=0');
  await storage.updatePolicy();
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await assets?.close();
  await auth?.close();
  await authenticationDB?.close();
  await mediaDB?.close();
});

it('protects a real bound avatar across independent databases and recovers a failed clear without breaking profile invariants', async () => {
  const user = await signup(),
    id = await publish(user.userId);
  const bind = await call('/api/v1/me/profile?view=display', user.session, { avatarAssetId: id });
  expect(bind.status, await bind.clone().text()).toBe(200);
  await storage.replaceHolder(user.userId, { type: 'asset', id, assetIds: [] });
  expect((await storage.usage(user.userId)).usedBytes).toBe(60);
  bridgeAvailable = false;
  expect(
    (await call('/api/v1/me/profile?view=display', user.session, { name: 'still editable' }))
      .status,
  ).toBe(200);
  const cleared = await call('/api/v1/me/profile?view=display', user.session, {
    avatarAssetId: null,
  });
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toMatchObject({ avatarAssetId: null, avatarUrl: null });
  expect((await storage.usage(user.userId)).usedBytes).toBe(60);
  await storage.reconcileOwner(user.userId, [avatarSource]);
  expect((await storage.usage(user.userId)).usedBytes).toBe(0);
});

it('authenticates storage through actual sessions, keeps strict response fields, and never accepts service Bearer identity', async () => {
  const user = await signup();
  await publish(user.userId, 90);
  const response = await call('/api/v1/me/storage-usage', user.session);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(
    [
      'quotaBytes',
      'warningAvailableBytes',
      'usedBytes',
      'availableBytes',
      'usageRatio',
      'objectCount',
      'status',
      'reminderVersion',
      'thresholdReminderPending',
      'calculatedAt',
    ].sort(),
  );
  expect(body).toMatchObject({ usedBytes: 90, status: 'warning', thresholdReminderPending: true });
  expect((await call('/api/v1/me/storage-usage')).status).toBe(401);
  expect(
    (
      await fetch(`${origin}/api/v1/me/storage-usage`, {
        headers: { authorization: 'Bearer service-token' },
      })
    ).status,
  ).toBe(401);
  const ack = await call(
    '/api/v1/me/storage-usage/reminders/ack',
    user.session,
    { reminderVersion: body.reminderVersion },
    'POST',
  );
  expect(ack.status).toBe(204);
  expect(
    (await (await call('/api/v1/me/storage-usage', user.session)).json()).thresholdReminderPending,
  ).toBe(false);
  await auth.setUserDisabled(user.userId, true);
  expect((await call('/api/v1/me/storage-usage', user.session)).status).toBe(401);
});

it('applies policy to existing and new logged-in accounts and permits actual upload publication after lowering quota', async () => {
  const existing = await signup();
  await publish(existing.userId, 90);
  policy = { revision: 2, quotaBytes: 50, warningAvailableBytes: 10 };
  await storage.updatePolicy();
  expect(await (await call('/api/v1/me/storage-usage', existing.session)).json()).toMatchObject({
    quotaBytes: 50,
    usedBytes: 90,
    availableBytes: 0,
    status: 'full',
  });
  const fresh = await signup();
  expect(await (await call('/api/v1/me/storage-usage', fresh.session)).json()).toMatchObject({
    quotaBytes: 50,
    usedBytes: 0,
    status: 'safe',
  });
  await publish(existing.userId, 30);
  expect((await (await call('/api/v1/me/storage-usage', existing.session)).json()).usedBytes).toBe(
    120,
  );
  usageAvailable = false;
  const unavailable = await call('/api/v1/me/storage-usage', existing.session);
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({ error: { code: 'STORAGE_UNAVAILABLE' } });
});

it('preserves the avatar hold for a disabled account while public session access stays denied', async () => {
  const user = await signup(),
    id = await publish(user.userId);
  expect((await call('/api/v1/me/profile', user.session, { avatarAssetId: id })).status).toBe(200);
  await storage.replaceHolder(user.userId, { type: 'asset', id, assetIds: [] });
  await auth.setUserDisabled(user.userId, true);
  expect(await auth.profile(user.userId)).toBeNull();
  await storage.reconcileOwner(user.userId, [avatarSource]);
  expect((await storage.usage(user.userId)).usedBytes).toBe(60);
  expect((await call('/api/v1/me/storage-usage', user.session)).status).toBe(401);
});
