import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import sharp from 'sharp';
import { imageOutputKey } from '../../src/generations/contracts.ts';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  makeChatRouteFixture,
  importRoutesViaCli,
} from '../providers/fixtures/onelink-routes-fixture.ts';
import { authDatabase } from '../support/auth-database.ts';
import { packedAuthRuntime } from '../support/auth-runtime.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let runtime: Awaited<ReturnType<typeof packedAuthRuntime>>;
let observer: Pool;
let server: ReturnType<typeof createServer>;
let cookie = '';
let ownerId = '';
const objects = new Map<string, { data: Buffer; etag: string }>();
const gets = new Map<string, number>();
const driftAfter = new Map<string, number>();
const reassignDuringRead = new Map<string, string>();
const call = (path: string, method = 'GET', value?: unknown) =>
  fetch(`${runtime.origin}${path}`, {
    method,
    headers: {
      origin: runtime.origin,
      cookie,
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });

beforeAll(async () => {
  server = createServer((request, response) => {
    const key = decodeURIComponent(new URL(request.url!, 'http://127.0.0.1').pathname.slice(1));
    const object = objects.get(key);
    if (!object) return void response.writeHead(404).end();
    if (request.method === 'GET') {
      const count = (gets.get(key) ?? 0) + 1;
      gets.set(key, count);
      if (count > (driftAfter.get(key) ?? Infinity)) return void response.writeHead(412).end();
      const reassign = reassignDuringRead.get(key);
      if (count === 1 && reassign) {
        void observer
          .query('UPDATE mio_assets SET owner_id=$2 WHERE id=$1', [reassign, 'other-owner'])
          .then(() =>
            response
              .writeHead(200, { etag: object.etag, 'content-length': String(object.data.length) })
              .end(object.data),
          )
          .catch(() => response.writeHead(500).end());
        return;
      }
    }
    if (request.headers['if-match'] && request.headers['if-match'] !== object.etag)
      return void response.writeHead(412).end();
    response.writeHead(200, { etag: object.etag, 'content-length': String(object.data.length) });
    response.end(request.method === 'HEAD' ? undefined : object.data);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
  database = await authDatabase();
  observer = new Pool({ connectionString: database.observerURL });
  const masterKey = randomBytes(32).toString('base64');
  const env = {
    PATH: process.env.PATH ?? '',
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_AUTH_BASE_URL: 'http://127.0.0.1:4311',
    MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
    MIO_ASSETS_DATABASE_URL: database.url,
    MIO_PROVIDERS_DATABASE_URL: database.url,
    MIO_PROVIDERS_MASTER_KEY: masterKey,
    MIO_PROVIDERS_MASTER_KEY_ID: 'vision-fixture',
    MIO_CONVERSATIONS_DATABASE_URL: database.url,
  };
  for (const domain of ['auth', 'assets', 'providers', 'conversations']) {
    const result = spawnSync(
      process.execPath,
      [`scripts/service/migrate-${domain}.ts`, '--apply'],
      {
        env,
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  const route = makeChatRouteFixture('deepseek-v4.1-flash', 'deepseek');
  await importRoutesViaCli(env, {
    ...route,
    capabilityMetadata: {
      ...route.capabilityMetadata,
      inputModalities: ['text', 'image'],
      maxRequestImages: 1,
    },
  });
  runtime = await packedAuthRuntime(database.url, '', 'unused', {
    conversations: true,
    visionCosOrigin: `http://127.0.0.1:${address.port}`,
    providerMasterKey: masterKey,
    providerKeyId: 'vision-fixture',
  });
  await runtime.start('database');
  const signup = await call('/api/auth/sign-up/email', 'POST', {
    name: 'Vision',
    email: 'vision-profile@example.test',
    password: 'vision-profile-pass-325',
  });
  expect(signup.status, await signup.clone().text()).toBe(200);
  cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  ownerId = ((await signup.json()) as { user: { id: string } }).user.id;
  expect(
    (
      await call('/api/v1/providers/onelink/credential', 'PUT', {
        apiKey: 'synthetic-profile-key',
        expectedRevision: 0,
      })
    ).status,
  ).toBe(200);
  expect((await call('/api/v1/providers/onelink/test', 'POST', {})).status).toBe(200);
  const provider = (await (await call('/api/v1/providers/onelink')).json()) as { revision: number };
  expect(
    (
      await call('/api/v1/providers/onelink/models', 'PATCH', {
        modelRef: 'onelink:chat:deepseek-v4.1-flash',
        isDefault: true,
        expectedRevision: provider.revision,
      })
    ).status,
  ).toBe(200);
  for (const color of ['#ff0000', '#00ff00']) {
    const id = randomUUID(),
      key = `mio/raw/${id}/${randomUUID()}`;
    const data = await sharp({ create: { width: 4, height: 3, channels: 3, background: color } })
      .png()
      .toBuffer();
    objects.set(key, { data, etag: `"raw-${id}"` });
    await observer.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at)
       VALUES($1,$2,'fixture.png','image/png',$3,$4,$5,'ready',now()+interval '1 day')`,
      [id, ownerId, data.length, `mio/staging/${id}`, key],
    );
  }
}, 60000);

afterAll(async () => {
  try {
    if (runtime) await runtime.close();
  } finally {
    if (observer) await observer.end();
    if (database) await database.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}, 30000);

it('accepts owned original and derived sources and rejects unauthorized, unready, forged and drifting sources before transport', async () => {
  async function asset(options: {
    owner?: string;
    state?: 'ready' | 'pending';
    derived?: boolean;
    forged?: boolean;
    wrongKey?: boolean;
    mismatch?: boolean;
    oversized?: boolean;
  }) {
    const id = randomUUID();
    const key = options.derived
      ? imageOutputKey(randomUUID(), 0, randomUUID(), 'png')
      : `mio/raw/${options.wrongKey ? randomUUID() : id}/${randomUUID()}`;
    const raster = sharp({ create: { width: 3, height: 2, channels: 3, background: '#4488ff' } });
    const data = options.forged
      ? Buffer.from('not a png')
      : await (options.mismatch ? raster.jpeg() : raster.png()).toBuffer();
    objects.set(key, { data, etag: `"raw-${id}"` });
    await observer.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,source_etag,expires_at)
       VALUES($1,$2,'fixture.png','image/png',$3,$4,$5,$6,'"different-staging-etag"',now()+interval '1 day')`,
      [
        id,
        options.owner ?? ownerId,
        options.oversized ? 10 * 1024 * 1024 + 1 : data.length,
        `mio/staging/${id}`,
        key,
        options.state ?? 'ready',
      ],
    );
    return { id, key };
  }
  async function send(assetId: string) {
    const created = await call('/api/v1/conversations', 'POST', {});
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const response = await call(`/api/v1/conversations/${id}/messages`, 'POST', {
      requestId: 'source',
      text: 'inspect source',
      imageAssetIds: [assetId],
    });
    return { id, response };
  }
  for (const source of [await asset({}), await asset({ derived: true })]) {
    const { id, response } = await send(source.id);
    expect(response.status, await response.clone().text()).toBe(202);
    await expect
      .poll(
        async () =>
          (
            (await (await call(`/api/v1/conversations/${id}/requests/source`)).json()) as {
              status: string;
            }
          ).status,
      )
      .toBe('completed');
    expect(gets.get(source.key)).toBeGreaterThan(1);
  }
  const baseline = (await runtime.onelinkRequests()).length;
  for (const [source, status, code] of [
    [await asset({ owner: 'other-owner' }), 404, 'ASSET_NOT_FOUND'],
    [await asset({ state: 'pending' }), 404, 'ASSET_NOT_FOUND'],
    [await asset({ wrongKey: true }), 404, 'ASSET_NOT_FOUND'],
    [await asset({ forged: true }), 400, 'IMAGE_INPUT_INVALID'],
    [await asset({ mismatch: true }), 400, 'IMAGE_INPUT_INVALID'],
    [await asset({ oversized: true }), 400, 'ASSET_INPUT_INVALID'],
  ] as const) {
    const { response } = await send(source.id);
    expect(response.status, await response.clone().text()).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  }
  const changing = await asset({});
  driftAfter.set(changing.key, 0);
  const { response } = await send(changing.id);
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'ASSET_SOURCE_CHANGED' } });
  const reassigned = await asset({});
  reassignDuringRead.set(reassigned.key, reassigned.id);
  const noLongerOwned = await send(reassigned.id);
  expect(noLongerOwned.response.status).toBe(404);
  expect(await noLongerOwned.response.json()).toMatchObject({ error: { code: 'ASSET_NOT_FOUND' } });
  const lateChanging = await asset({});
  driftAfter.set(lateChanging.key, 1);
  const late = await send(lateChanging.id);
  expect(late.response.status, await late.response.clone().text()).toBe(202);
  await expect
    .poll(
      async () =>
        (
          (await (await call(`/api/v1/conversations/${late.id}/requests/source`)).json()) as {
            status: string;
          }
        ).status,
    )
    .toBe('failed');
  expect(gets.get(lateChanging.key)).toBe(2);
  expect((await runtime.onelinkRequests()).length).toBe(baseline);
}, 30000);

it('drains an offloaded turn, cancels blocked cold history on shutdown and reads it after restart', async () => {
  const ids = [...objects.keys()].map((key) => key.split('/')[2]!);
  const baseline = (await runtime.onelinkRequests()).length;
  const created = await call('/api/v1/conversations', 'POST', {});
  expect(created.status, await created.clone().text()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const send = (requestId: string, text: string, asset: string) =>
    call(`/api/v1/conversations/${id}/messages`, 'POST', {
      requestId,
      text,
      imageAssetIds: [asset],
    });
  expect((await send('first', 'first image', ids[0]!)).status).toBe(202);
  await expect
    .poll(
      async () =>
        (
          (await (await call(`/api/v1/conversations/${id}/requests/first`)).json()) as {
            status: string;
          }
        ).status,
    )
    .toBe('completed');
  expect((await send('held', 'VISION_HOLD', ids[1]!)).status).toBe(202);
  await expect.poll(async () => (await runtime.onelinkRequests()).length).toBe(baseline + 2);
  const requests = await runtime.onelinkRequests();
  expect(JSON.stringify(requests.at(-1)!.body)).toContain(ids[0]);
  expect(JSON.stringify(requests.at(-1)!.body)).toContain('inspect_image_asset');
  await runtime.stop();
  await runtime.start('database');
  const receipt = (await (await call(`/api/v1/conversations/${id}/requests/held`)).json()) as {
    status: string;
  };
  const debugHistory = await (await call(`/api/v1/conversations/${id}/history?limit=100`)).json();
  const files = await readdir(runtime.nativeLogRoot, { recursive: true, withFileTypes: true });
  const logs = await Promise.all(
    files
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
  );
  const persisted = logs.join('\n');
  expect(persisted).toContain('"type":"image/offload"');
  expect(persisted).not.toContain('synthetic-profile-key');
  for (const [key, object] of objects) {
    expect(persisted).not.toContain(key);
    expect(persisted).not.toContain(object.data.toString('base64'));
  }
  const turnEnds = logs.flatMap((log) =>
    log
      .split('\n')
      .filter((line) => line.includes('turn/end'))
      .map((line) => JSON.parse(line)),
  );
  expect(receipt.status, JSON.stringify({ receipt, debugHistory, turnEnds })).toBe('unknown');
  await runtime.blockVisionHistory();
  const history = call(`/api/v1/conversations/${id}/history?limit=100`);
  await expect.poll(() => runtime.visionHistoryMarker('entered')).toBe(true);
  let stopped = false;
  const stopping = runtime.stop().then(() => {
    stopped = true;
  });
  await delay(150);
  expect(stopped).toBe(false);
  await runtime.releaseVisionHistory();
  const response = await history;
  expect(
    response.status,
    JSON.stringify({
      response: await response.clone().text(),
      error: await runtime.visionHistoryError(),
      state: await runtime.visionHistoryState(),
      logs: runtime.logs(),
    }),
  ).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'CONVERSATION_UNAVAILABLE' } });
  await stopping;
  expect(await runtime.visionHistoryMarker('completed')).toBe(false);
  expect(await runtime.visionHistoryError()).toContain('AbortError');
  await runtime.start('database');
  const replay = await call(`/api/v1/conversations/${id}/history?limit=100`);
  expect(replay.status).toBe(200);
  const replayed = JSON.stringify(await replay.json());
  expect(replayed).toContain(ids[0]);
  expect(replayed).toContain(ids[1]);
}, 30000);
