import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as Mio from '../src/plugin.ts';
import * as AssetServices from '../src/assets/service.ts';
import { authDatabase } from './auth-database.ts';

const cloud = vi.hoisted(() => ({
  origin: '',
  bytes: new Map<string, Buffer>(),
  sizes: new Map<string, number>(),
  copies: [] as string[],
  failNext: false,
  failAfterCopy: false,
  gate: undefined as undefined | { entered: () => void; release: Promise<void> },
  deleteGate: undefined as undefined | { entered: () => void; release: Promise<void> },
}));

vi.mock('../src/integrations/cos.ts', () => ({
  createCosStorage: () => ({
    uploadUrl(key: string, size: number) {
      cloud.sizes.set(key, size);
      return `${cloud.origin}/${key}`;
    },
    downloadUrl: (key: string) => `${cloud.origin}/${key}`,
    async head(key: string) {
      const value = cloud.bytes.get(key);
      if (!value) throw { statusCode: 404 };
      return { size: value.length, etag: createHash('sha256').update(value).digest('hex') };
    },
    async copy(source: string, target: string, etag: string) {
      if (cloud.failNext) {
        cloud.failNext = false;
        throw { statusCode: 503 };
      }
      if (cloud.gate) {
        const gate = cloud.gate;
        cloud.gate = undefined;
        gate.entered();
        await gate.release;
      }
      const value = cloud.bytes.get(source);
      if (!value || createHash('sha256').update(value).digest('hex') !== etag)
        throw { statusCode: 412 };
      if (cloud.bytes.has(target)) throw { statusCode: 409 };
      cloud.copies.push(target);
      cloud.bytes.set(target, Buffer.from(value));
      if (cloud.failAfterCopy) {
        cloud.failAfterCopy = false;
        throw { statusCode: 503 };
      }
    },
    async delete(key: string) {
      if (cloud.deleteGate) {
        const gate = cloud.deleteGate;
        cloud.deleteGate = undefined;
        gate.entered();
        await gate.release;
      }
      cloud.bytes.delete(key);
    },
  }),
}));

let database: Awaited<ReturnType<typeof authDatabase>>;
let observer: Pool;
let ctx: Context;
let plugin: ReturnType<Context['plugin']>;
let service: ReturnType<typeof AssetServices.createAssetService>;
let server: Server;
let origin: string;
let ownerCookie: string;
let otherCookie: string;
const secret = randomBytes(40).toString('hex');
const password = 'assets-test-password-strong-2026';

const call = (
  path: string,
  value?: unknown,
  cookie = ownerCookie,
  extra: Record<string, string> = {},
) =>
  fetch(`${origin}${path}`, {
    method: value === undefined ? 'GET' : 'POST',
    headers: {
      origin,
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .join('; ');
async function create(bytes = Buffer.from('example video')) {
  const response = await call('/api/v1/assets/uploads', {
    filename: 'video.mp4',
    contentType: 'video/mp4',
    size: bytes.length,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const value = (await response.json()) as { assetId: string; uploadUrl: string };
  expect((await fetch(value.uploadUrl, { method: 'PUT', body: bytes })).status).toBe(200);
  return value;
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const key = decodeURIComponent((request.url ?? '').slice(1));
    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks);
      if (cloud.sizes.get(key) !== data.length) {
        response.writeHead(400).end();
        return;
      }
      cloud.bytes.set(key, data);
      response.writeHead(200).end();
      return;
    }
    const data = cloud.bytes.get(key);
    if (!data) response.writeHead(404).end();
    else response.writeHead(200).end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake cloud address missing');
  cloud.origin = `http://127.0.0.1:${address.port}`;
  database = await authDatabase();
  observer = new Pool({ connectionString: database.observerURL });
  ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(NativeExecutor);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  origin = ctx.webServer.getOrigin();
  vi.stubEnv('MIO_API_TOKEN', secret);
  vi.stubEnv('MIO_AUTH_DATABASE_URL', database.url);
  vi.stubEnv('MIO_AUTH_BASE_URL', origin);
  vi.stubEnv('MIO_AUTH_SECRET', secret);
  vi.stubEnv('MIO_AUTH_RATE_LIMIT_BACKEND', 'database');
  vi.stubEnv('MIO_AUTH_ALLOWED_ORIGINS', '[]');
  vi.stubEnv('MIO_ASSETS_DATABASE_URL', database.url);
  vi.stubEnv('MIO_COS_BUCKET', 'mio-test-1234567890');
  vi.stubEnv('MIO_COS_REGION', 'ap-shanghai');
  vi.stubEnv('MIO_COS_SECRET_ID', 'test-secret-id');
  vi.stubEnv('MIO_COS_SECRET_KEY', 'test-secret-key');
  for (const file of ['scripts/service/migrate-auth.ts', 'scripts/service/migrate-assets.ts']) {
    const result = spawnSync(process.execPath, [file, '--apply'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  const original = AssetServices.createAssetService;
  vi.spyOn(AssetServices, 'createAssetService').mockImplementation((...args) => {
    service = original(...args);
    return service;
  });
  plugin = ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
  await plugin;
  const owner = await call(
    '/api/auth/sign-up/email',
    { name: 'Owner', email: 'assets-owner@example.test', password },
    '',
  );
  expect(owner.status, await owner.clone().text()).toBe(200);
  ownerCookie = cookies(owner);
  const other = await call(
    '/api/auth/sign-up/email',
    { name: 'Other', email: 'assets-other@example.test', password },
    '',
  );
  expect(other.status, await other.clone().text()).toBe(200);
  otherCookie = cookies(other);
}, 45000);

afterAll(async () => {
  try {
    if (ctx) await ctx.fiber.dispose();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (observer) await observer.end();
    if (database) await database.close();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
}, 30000);

it('enforces cookie, Origin, ownership and input boundaries through the registered plugin', async () => {
  const value = { filename: 'video.mp4', contentType: 'video/mp4', size: 4 };
  expect((await call('/api/v1/assets/uploads', value, '')).status).toBe(401);
  expect(
    (await call('/api/v1/assets/uploads', value, '', { authorization: `Bearer ${secret}` })).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${origin}/api/v1/assets/uploads`, {
        method: 'POST',
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        body: JSON.stringify(value),
      })
    ).status,
  ).toBe(403);
  expect(
    (await call('/api/v1/assets/uploads', value, ownerCookie, { origin: 'https://other.invalid' }))
      .status,
  ).toBe(403);
  expect((await call('/api/v1/assets/uploads', { ...value, owner: 'forged' })).status).toBe(400);
  expect((await call('/api/v1/assets/uploads', { ...value, size: 1024 ** 3 + 1 })).status).toBe(
    400,
  );
  const asset = await create();
  expect((await call(`/api/v1/assets/${asset.assetId}`, undefined, otherCookie)).status).toBe(404);
  expect((await call(`/api/v1/assets/${asset.assetId}/complete`, {}, otherCookie)).status).toBe(
    404,
  );
  const done = await call(`/api/v1/assets/${asset.assetId}/complete`, {});
  expect(done.status, await done.clone().text()).toBe(200);
  const result = (await done.json()) as { status: string; downloadUrl: string };
  expect(result.status).toBe('ready');
  expect(await (await fetch(result.downloadUrl)).text()).toBe('example video');
  const repeated = await call(`/api/v1/assets/${asset.assetId}/complete`, {});
  expect((await repeated.json()) as object).toEqual(result);
  expect((await call(`/api/v1/assets/${asset.assetId}`)).status).toBe(200);
});

it('freezes source and recovers after a failed copy, rejecting changed source and wrong size', async () => {
  const asset = await create(Buffer.from('first'));
  cloud.failNext = true;
  expect((await call(`/api/v1/assets/${asset.assetId}/complete`, {})).status).toBe(503);
  const key = `mio/staging/${asset.assetId}`;
  cloud.bytes.set(key, Buffer.from('other'));
  const changed = await call(`/api/v1/assets/${asset.assetId}/complete`, {});
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ error: { code: 'ASSET_SOURCE_CHANGED' } });
  cloud.bytes.set(key, Buffer.from('first'));
  expect((await call(`/api/v1/assets/${asset.assetId}/complete`, {})).status).toBe(200);
  const oversized = await create(Buffer.from('small'));
  cloud.bytes.set(`mio/staging/${oversized.assetId}`, Buffer.from('larger'));
  expect(
    await (await call(`/api/v1/assets/${oversized.assetId}/complete`, {})).json(),
  ).toMatchObject({ error: { code: 'ASSET_SIZE_MISMATCH' } });
});

it('rejects a source overwritten between HEAD and conditional copy and retries unknown copy results safely', async () => {
  const asset = await create(Buffer.from('first'));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  cloud.gate = { entered: entered.resolve, release: release.promise };
  const completing = call(`/api/v1/assets/${asset.assetId}/complete`, {});
  await entered.promise;
  cloud.bytes.set(`mio/staging/${asset.assetId}`, Buffer.from('other'));
  release.resolve();
  expect(await (await completing).json()).toMatchObject({
    error: { code: 'ASSET_SOURCE_CHANGED' },
  });
  cloud.bytes.set(`mio/staging/${asset.assetId}`, Buffer.from('first'));
  cloud.failAfterCopy = true;
  expect((await call(`/api/v1/assets/${asset.assetId}/complete`, {})).status).toBe(503);
  const recovered = await call(`/api/v1/assets/${asset.assetId}/complete`, {});
  expect(recovered.status).toBe(200);
  const targets = cloud.copies.filter((key) => key.startsWith(`mio/raw/${asset.assetId}/`));
  expect(targets).toHaveLength(2);
  expect(new Set(targets).size).toBe(2);
  const result = (await recovered.json()) as { downloadUrl: string };
  expect(await (await fetch(result.downloadUrl)).text()).toBe('first');
});

it('does not let a delayed expired lease overwrite a newer successful completion', async () => {
  const asset = await create();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  cloud.gate = { entered: entered.resolve, release: release.promise };
  const first = call(`/api/v1/assets/${asset.assetId}/complete`, {});
  await entered.promise;
  await observer.query("UPDATE mio_assets SET lease_until=now()-interval '1 second' WHERE id=$1", [
    asset.assetId,
  ]);
  const second = await call(`/api/v1/assets/${asset.assetId}/complete`, {});
  expect(second.status, await second.clone().text()).toBe(200);
  const winner = (await second.json()) as { downloadUrl: string };
  release.resolve();
  const old = await first;
  expect(old.status).toBe(200);
  expect(await old.json()).toEqual(winner);
  const targets = cloud.copies.filter((key) => key.startsWith(`mio/raw/${asset.assetId}/`));
  expect(targets).toHaveLength(2);
  expect(new Set(targets).size).toBe(2);
  expect(await (await fetch(winner.downloadUrl)).text()).toBe('example video');
});

it('does not publish a copy after its lease expires even without a replacement claimant', async () => {
  const asset = await create();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  cloud.gate = { entered: entered.resolve, release: release.promise };
  const first = call(`/api/v1/assets/${asset.assetId}/complete`, {});
  await entered.promise;
  await observer.query("UPDATE mio_assets SET lease_until=now()-interval '1 second' WHERE id=$1", [
    asset.assetId,
  ]);
  release.resolve();
  expect(await (await first).json()).toMatchObject({
    error: { code: 'ASSET_FINALIZE_SUPERSEDED' },
  });
  expect((await call(`/api/v1/assets/${asset.assetId}/complete`, {})).status).toBe(200);
});

it('retains registered raw data across plugin restart and deletes only expired owned staging', async () => {
  const ready = await create();
  const response = await call(`/api/v1/assets/${ready.assetId}/complete`, {});
  const result = (await response.json()) as { downloadUrl: string };
  const pending = await create();
  cloud.bytes.set('mio/staging/not-owned', Buffer.from('foreign'));
  const damaged = await create();
  await plugin.dispose();
  plugin = ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
  await plugin;
  expect((await call(`/api/v1/assets/${ready.assetId}`)).status).toBe(200);
  await observer.query(
    "UPDATE mio_assets SET expires_at=now()-interval '1 second' WHERE id=ANY($1::uuid[])",
    [[ready.assetId, pending.assetId, damaged.assetId]],
  );
  await observer.query('UPDATE mio_assets SET staging_key=$2 WHERE id=$1', [
    damaged.assetId,
    'mio/staging/not-owned',
  ]);
  expect(await (await call(`/api/v1/assets/${pending.assetId}`)).json()).toMatchObject({
    status: 'expired',
  });
  await service.clean();
  expect(cloud.bytes.has(`mio/staging/${ready.assetId}`)).toBe(false);
  expect(cloud.bytes.has(`mio/staging/${pending.assetId}`)).toBe(false);
  expect(cloud.bytes.has('mio/staging/not-owned')).toBe(true);
  expect(await (await fetch(result.downloadUrl)).text()).toBe('example video');
  expect(await (await call(`/api/v1/assets/${pending.assetId}`)).json()).toMatchObject({
    status: 'expired',
  });
});

it('stops starting additional cleanup deletes when the service closes', async () => {
  const first = await create();
  const second = await create();
  await observer.query(
    "UPDATE mio_assets SET expires_at=now()-interval '1 second' WHERE id=ANY($1::uuid[])",
    [[first.assetId, second.assetId]],
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  cloud.deleteGate = { entered: entered.resolve, release: release.promise };
  const cleaning = service.clean();
  await entered.promise;
  const closing = service.close();
  release.resolve();
  await Promise.all([cleaning, closing]);
  const remaining = [first, second].filter((asset) =>
    cloud.bytes.has(`mio/staging/${asset.assetId}`),
  );
  expect(remaining).toHaveLength(1);
  await plugin.dispose();
  plugin = ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
  await plugin;
});

it('bounds shutdown of a stalled copy without publishing a late result', async () => {
  const asset = await create();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  cloud.gate = { entered: entered.resolve, release: release.promise };
  const completing = call(`/api/v1/assets/${asset.assetId}/complete`, {});
  await entered.promise;
  const closing = plugin.dispose();
  expect((await completing).status).toBe(503);
  await closing;
  release.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const row = await observer.query<{ state: string; raw_key: string | null }>(
    'SELECT state,raw_key FROM mio_assets WHERE id=$1',
    [asset.assetId],
  );
  expect(row.rows[0]).toMatchObject({ state: 'finalizing', raw_key: null });
  plugin = ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
  await plugin;
  expect((await call(`/api/v1/assets/${asset.assetId}/complete`, {})).status).toBe(200);
}, 12000);

it('drains an in-flight copy before closing the plugin and its metadata pool', async () => {
  const asset = await create();
  const owner = await observer.query<{ owner_id: string }>(
    'SELECT owner_id FROM mio_assets WHERE id=$1',
    [asset.assetId],
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  cloud.gate = { entered: entered.resolve, release: release.promise };
  const completing = call(`/api/v1/assets/${asset.assetId}/complete`, {});
  await entered.promise;
  let closed = false;
  const closing = plugin.dispose().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  let denial: unknown;
  try {
    await service.get({ userId: owner.rows[0]!.owner_id, sessionId: 'test' }, asset.assetId);
  } catch (error) {
    denial = error;
  }
  expect(denial).toMatchObject({ status: 503, code: 'ASSET_UNAVAILABLE' });
  const closedWhileCopying = closed;
  release.resolve();
  const response = await completing;
  await closing;
  expect(closedWhileCopying).toBe(false);
  expect(response.status).toBe(200);
});
