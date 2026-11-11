import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { readAuthConfig } from '../../src/auth/config.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import { createAuthHandler } from '../../src/auth/http.ts';
import { readProviderConfig } from '../../src/providers/config.ts';
import type { ProviderConfig } from '../../src/providers/config.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { createProviderHandler } from '../../src/providers/http.ts';
import { encryptCredential, decryptCredential } from '../../src/providers/credentials.ts';
import { discoverModels, ONELINK_ORIGIN } from '../../src/integrations/onelink/models.ts';
import type { ProviderView } from '../../src/providers/contracts.ts';
import { isolateProviderEnvironment, inheritedProviderVariableCount } from '../providers-setup.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let store: Awaited<ReturnType<typeof createProviderStore>>;
let auth: Awaited<ReturnType<typeof createAuthentication>>;
let server: Server;
let origin = '';
let config: ProviderConfig;
const cookies: string[] = [];
const keys = ['owner-one-private-test-key-123', 'owner-two-private-test-key-789'];
const outbound: { url: string; authorization: string | null }[] = [];
let upstream: (options: RequestInit) => Promise<Response> = async () =>
  Response.json({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'unmapped-exact-Q' }] });
const base = '/api/v1/providers/onelink';
function call(
  path: string,
  method = 'GET',
  value?: unknown,
  index = 0,
  headers: Record<string, string> = {},
) {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      origin,
      cookie: cookies[index] ?? '',
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}
async function current(index = 0): Promise<ProviderView> {
  return (await (await call(base, 'GET', undefined, index)).json()) as ProviderView;
}
async function save(apiKey: string, index = 0, expectedRevision?: number) {
  const old = await current(index);
  return call(
    `${base}/credential`,
    'PUT',
    { apiKey, expectedRevision: expectedRevision ?? old?.revision ?? 0 },
    index,
  );
}
async function declareModel(id: string, index = 0) {
  const provider = await current(index);
  const owner = (
    await pool.query('SELECT owner_id FROM mio_provider_configs WHERE id=$1', [provider.id])
  ).rows[0].owner_id as string;
  await store.declare(owner, provider.revision, {
    modelRef: `onelink:chat:${id}`,
    operation: 'chat',
    profile: 'openai-chat',
    classification: 'chat',
    source: 'deterministic protocol fixture',
    sourceVersion: 'v1',
  });
}

beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.observerURL });
  server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  origin = `http://127.0.0.1:${address.port}`;
  const authEnv = {
    PATH: process.env.PATH ?? '',
    MIO_AUTH_BASE_URL: origin,
    MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
    MIO_AUTH_DATABASE_URL: database.url,
  };
  const migrated = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
    env: authEnv,
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(migrated.status, migrated.stderr).toBe(0);
  await pool.query(providerSchemaSQL);
  await pool.query(providerSchemaSQL);
  config = {
    databaseURL: database.url,
    masterKey: randomBytes(32),
    masterKeyId: 'provider-test-v1',
  };
  store = await createProviderStore(config);
  auth = await createAuthentication(readAuthConfig(authEnv)!);
  const authHandler = createAuthHandler(readAuthConfig(authEnv)!, auth);
  const service = createProviderService(store, config, async (url, options) => {
    outbound.push({ url, authorization: new Headers(options.headers).get('authorization') });
    expect(options.redirect).toBe('error');
    return upstream(options);
  });
  const handler = createProviderHandler(service, auth.identity, [origin]);
  server.on('request', (request, response) => {
    void (request.url?.startsWith('/api/auth') ? authHandler : handler)(request, response);
  });
  for (let index = 0; index < 2; index++) {
    const response = await call('/api/auth/sign-up/email', 'POST', {
      name: `Owner ${index}`,
      email: `provider-${index}@example.test`,
      password: 'provider-test-password-3921',
    });
    expect(response.status).toBe(200);
    cookies.push(
      response.headers
        .getSetCookie()
        .map((v) => v.split(';')[0])
        .join('; '),
    );
  }
}, 45000);
afterAll(async () => {
  try {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  } finally {
    await store?.close();
    await auth?.close();
    await pool?.end();
    await database?.close();
  }
}, 30000);

it('requires explicit independent master key configuration with no fallback', () => {
  for (const key of [
    'MIO_PROVIDERS_DATABASE_URL',
    'MIO_PROVIDERS_MASTER_KEY',
    'MIO_PROVIDERS_MASTER_KEY_ID',
  ])
    expect(process.env[key]).toBeUndefined();
  console.log(
    'PROVIDER_ENV_ISOLATION',
    JSON.stringify({ presentBeforeSetup: inheritedProviderVariableCount, presentAfterSetup: 0 }),
  );
  expect(readProviderConfig({})).toBeUndefined();
  for (const env of [
    { MIO_PROVIDERS_DATABASE_URL: 'postgres://localhost/test' },
    {
      MIO_PROVIDERS_DATABASE_URL: 'postgres://localhost/test',
      MIO_PROVIDERS_MASTER_KEY: 'bad',
      MIO_PROVIDERS_MASTER_KEY_ID: 'v1',
    },
    { MIO_AUTH_SECRET: 'x'.repeat(40), MIO_PROVIDERS_DATABASE_URL: 'postgres://localhost/test' },
  ])
    expect(() => readProviderConfig(env)).toThrow('PROVIDER_CONFIG');
  expect(
    readProviderConfig({
      MIO_PROVIDERS_DATABASE_URL: config.databaseURL,
      MIO_PROVIDERS_MASTER_KEY: config.masterKey.toString('base64'),
      MIO_PROVIDERS_MASTER_KEY_ID: 'v1',
    })?.masterKey.length,
  ).toBe(32);
});

it('removes and restores only provider host configuration before application fixtures can choose a database', () => {
  const polluted = {
    MIO_PROVIDERS_DATABASE_URL: 'invalid-database-connection-sentinel',
    MIO_PROVIDERS_MASTER_KEY: 'invalid-master-key-sentinel',
    MIO_PROVIDERS_MASTER_KEY_ID: 'sentinel',
    MIO_AUTH_SECRET: 'untouched-test-value',
  };
  const original = { ...polluted };
  const restore = isolateProviderEnvironment(polluted);
  expect(readProviderConfig(polluted)).toBeUndefined();
  expect(polluted.MIO_AUTH_SECRET).toBe(original.MIO_AUTH_SECRET);
  restore();
  expect(polluted).toEqual(original);
});

it('stores only ciphertext, keeps both real users isolated and rejects body identity/service tokens', async () => {
  expect(await (await call(base)).json()).toBeNull();
  for (let index = 0; index < 2; index++) {
    const response = await save(keys[index]!, index);
    expect(response.status).toBe(200);
    const value = await response.text();
    expect(value).not.toContain(keys[index]!);
    expect(JSON.parse(value)).toMatchObject({
      credentialVersion: 1,
      masked: '********',
      discovery: null,
    });
  }
  expect((await current()).id).not.toBe((await current(1)).id);
  const rows = (await pool.query('SELECT * FROM mio_provider_configs')).rows;
  expect(JSON.stringify(rows)).not.toContain(keys[0]);
  expect(JSON.stringify(rows)).not.toContain(keys[1]);
  expect(
    (
      await call(base, 'GET', undefined, 0, {
        cookie: '',
        authorization: 'Bearer service-test-only',
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await call(`${base}/credential`, 'PUT', {
        apiKey: keys[0],
        expectedRevision: 1,
        ownerId: rows[1].owner_id,
      })
    ).status,
  ).toBe(400);
  expect((await call(`${base}/${rows[1].id}`)).status).toBe(404);
  expect((await save('********')).status).toBe(400);
  expect(
    (
      await call(`${base}/credential`, 'PUT', {
        apiKey: keys[0],
        expectedRevision: 1,
        url: 'http://attacker.test',
      })
    ).status,
  ).toBe(400);
  expect(outbound).toHaveLength(0);
});

it('encrypts with fresh nonce and rejects wrong key/ID, owner/provider/version and shortened tags', () => {
  const binding = { ownerId: 'one', providerId: 'provider-a', credentialVersion: 1 };
  const envelope = encryptCredential(keys[0]!, binding, config);
  expect(decryptCredential(envelope, binding, config)).toBe(keys[0]);
  expect(encryptCredential(keys[0]!, binding, config).nonce.equals(envelope.nonce)).toBe(false);
  for (const [changedBinding, changedConfig, changedEnvelope] of [
    [{ ...binding, ownerId: 'two' }, config, envelope],
    [{ ...binding, providerId: 'provider-b' }, config, envelope],
    [{ ...binding, credentialVersion: 2 }, config, envelope],
    [binding, { ...config, masterKey: randomBytes(32) }, envelope],
    [binding, { ...config, masterKeyId: 'other' }, envelope],
    [binding, config, { ...envelope, auth_tag: envelope.auth_tag.subarray(0, 12) }],
    [binding, config, { ...envelope, nonce: randomBytes(12) }],
  ] as const)
    expect(() => decryptCredential(changedEnvelope, changedBinding, changedConfig)).toThrow(
      'PROVIDER_CREDENTIAL_UNAVAILABLE',
    );
});

it('persists precise discovery separately from capability permission and never automatically discovers on read', async () => {
  for (let index = 0; index < 2; index++) {
    const response = await call(`${base}/test`, 'POST', {}, index);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'connected',
      scope: 'models-only',
      credentialVersion: 1,
      ids: ['deepseek-v4.1-flash', 'unmapped-exact-Q'],
    });
    expect(outbound[index]).toEqual({
      url: `${ONELINK_ORIGIN}/v1/models`,
      authorization: `Bearer ${keys[index]}`,
    });
  }
  const list = (await (await call(`${base}/models`)).json()) as {
    items: { modelId: string; discovered: boolean | null; runnable: boolean }[];
  };
  expect(list.items).toHaveLength(2);
  expect(list.items.find((m) => m.modelId === 'deepseek-v4.1-flash')).toMatchObject({
    discovered: true,
    runnable: false,
  });
  expect(list.items.find((m) => m.modelId === 'unmapped-exact-Q')).toMatchObject({
    discovered: true,
    runnable: false,
  });
  expect((await (await call(`${base}/models?category=chat`)).json()).items).toEqual([]);
  expect(outbound).toHaveLength(2);
});

it('serializes rotations and defaults, preserves disabled state and clears superseded discovery', async () => {
  const old = await current();
  const attempts = await Promise.all([
    save('rotated-key-one-private', 0, old.revision),
    save('rotated-key-two-private', 0, old.revision),
  ]);
  expect(attempts.map((r) => r.status).sort()).toEqual([200, 409]);
  const rotated = await current();
  expect(rotated.credentialVersion).toBe(2);
  expect(rotated.discovery).toBeNull();
  const selected = await call(`${base}/models`, 'PATCH', {
    modelRef: 'onelink:chat:deepseek-v4.1-flash',
    isDefault: true,
    expectedRevision: rotated.revision,
  });
  expect(selected.status).toBe(409);
  expect((await selected.json()).error.code).toBe('MODEL_CATALOG_NOT_DISCOVERED');
  await call(`${base}/test`, 'POST', {});
  await declareModel('deepseek-v4.1-flash');
  await declareModel('unmapped-exact-Q');
  const rev = (await current()).revision;
  const defaults = await Promise.all(
    ['deepseek-v4.1-flash', 'unmapped-exact-Q'].map((id) =>
      call(`${base}/models`, 'PATCH', {
        modelRef: `onelink:chat:${id}`,
        isDefault: true,
        expectedRevision: rev,
      }),
    ),
  );
  expect(defaults.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    (await pool.query('SELECT * FROM mio_provider_model_preferences WHERE is_default')).rows,
  ).toHaveLength(1);
  const before = await current();
  expect(
    (
      await call(base, 'PATCH', {
        enabled: false,
        defaultImageWatermark: true,
        expectedRevision: before.revision,
      })
    ).status,
  ).toBe(200);
  expect((await save('rotated-while-disabled-private')).status).toBe(200);
  expect(await current()).toMatchObject({
    enabled: false,
    defaultImageWatermark: true,
    credentialVersion: 3,
  });
  const list = (await (await call(`${base}/models?category=chat`)).json()) as {
    items: { modelRef: string; isDefault: boolean }[];
  };
  const chosen = list.items.find((m) => m.isDefault)!;
  expect(
    (
      await call(`${base}/models`, 'PATCH', {
        modelRef: chosen.modelRef,
        usage: 'chat',
        enabled: false,
        expectedRevision: (await current()).revision,
      })
    ).status,
  ).toBe(409);
  expect(
    (await pool.query('SELECT * FROM mio_provider_model_preferences WHERE is_default')).rows,
  ).toHaveLength(1);
  expect(
    (
      await call(`${base}/models`, 'PATCH', {
        modelRef: 'onelink:chat:unmapped-exact-Q',
        isDefault: true,
        expectedRevision: (await current()).revision,
      })
    ).status,
  ).toBe(409);
  // Subsequent refresh tests explicitly re-enable; rotation itself did not change this preference.
  await call(base, 'PATCH', { enabled: true, expectedRevision: (await current()).revision });
});

it('does not let a late discovery for an old key overwrite a replacement', async () => {
  let release!: () => void;
  let started!: () => void;
  const arrived = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  upstream = async () => {
    started();
    await held;
    return Response.json({ data: [{ id: 'stale-model' }] });
  };
  const pending = call(`${base}/test`, 'POST', {});
  await arrived;
  const rotated = await save('replacement-after-discovery-start');
  expect(rotated.status).toBe(200);
  release();
  expect((await pending).status).toBe(409);
  expect((await current()).discovery).toBeNull();
  upstream = async () => Response.json({ data: [{ id: 'deepseek-v4.1-flash' }] });
});

it('reports failed upstream results without exposing upstream body, key or false connectivity', async () => {
  upstream = async () => new Response(`secret echo ${keys[1]}`, { status: 401 });
  const response = await call(`${base}/test`, 'POST', {}, 1);
  const value = await response.text();
  expect(value).not.toContain(keys[1]!);
  expect(JSON.parse(value)).toMatchObject({
    status: 'failed',
    ids: [],
    error: 'UPSTREAM_AUTH_REJECTED',
  });
  expect((await current(1)).discovery?.status).toBe('failed');
});

it('fails closed on database ciphertext tampering without decrypting metadata reads', async () => {
  const old = (
    await pool.query('SELECT owner_id,ciphertext FROM mio_provider_configs WHERE id=$1', [
      (await current(1)).id,
    ])
  ).rows[0];
  await pool.query('UPDATE mio_provider_configs SET ciphertext=$1 WHERE owner_id=$2', [
    randomBytes(24),
    old.owner_id,
  ]);
  expect((await call(base, 'GET', undefined, 1)).status).toBe(200);
  const response = await call(`${base}/test`, 'POST', {}, 1);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: 'PROVIDER_CREDENTIAL_UNAVAILABLE' },
  });
  await pool.query('UPDATE mio_provider_configs SET ciphertext=$1 WHERE owner_id=$2', [
    old.ciphertext,
    old.owner_id,
  ]);
});

it('rejects invalid/oversized/credential-echo discovery, classifies timeout and preserves fixed redirect policy', async () => {
  const key = 'test-transport-secret-key';
  for (const response of [
    Response.json({ data: [{ id: 12 }] }),
    Response.json({ data: [{ id: key }] }),
    new Response('{"data":[{"id":"\\u0074est-transport-secret-key"}]}'),
    new Response('{"data":[{"id":"normal","description":"\\u0074est-transport-secret-key"}]}'),
    new Response('{"data":[{"id":"normal","owned_by":"\\u0074est-transport-secret-key"}]}'),
    Response.json({ data: Array.from({ length: 5001 }, () => ({ id: 'x' })) }),
    new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    new Response(null, { status: 302, headers: { location: 'https://attacker.test' } }),
  ]) {
    await expect(
      discoverModels(key, async (url, options) => {
        expect(url).toBe(`${ONELINK_ORIGIN}/v1/models`);
        expect(options.redirect).toBe('error');
        return response;
      }),
    ).rejects.toThrow('UPSTREAM_');
  }
  await expect(
    discoverModels(
      key,
      async (_url, options) =>
        new Promise((_resolve, reject) =>
          options.signal!.addEventListener('abort', () => reject(new Error('timeout')), {
            once: true,
          }),
        ),
      10,
    ),
  ).rejects.toThrow('UPSTREAM_TIMEOUT');
});

it('applies browser, bounded input, strict method and query rules at the provider HTTP entry', async () => {
  expect((await call(base, 'GET', undefined, 0, { origin: 'https://evil.test' })).status).toBe(403);
  expect(
    (await call(base, 'PATCH', { expectedRevision: 1, enabled: true }, 0, { origin: '' })).status,
  ).toBe(403);
  expect((await call(base, 'POST', {})).status).toBe(405);
  expect(
    (await call(`${base}/credential`, 'PUT', { apiKey: 'x'.repeat(9000), expectedRevision: 1 }))
      .status,
  ).toBe(413);
  expect((await call(`${base}/models?category=wrong`)).status).toBe(400);
  expect((await call(`${base}/models?category=chat&category=image`)).status).toBe(400);
  expect((await call(`${base}?ownerId=other`)).status).toBe(400);
  const response = await call(base);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);
});

it('decrypts persisted current credentials in a fresh store and rejects a wrong injected master key', async () => {
  const reopened = await createProviderStore({
    ...config,
    masterKey: Buffer.from(config.masterKey.toString('base64'), 'base64'),
  });
  try {
    const row = await reopened.current(
      (
        await pool.query('SELECT owner_id FROM mio_provider_configs WHERE id=$1', [
          (await current()).id,
        ])
      ).rows[0].owner_id,
    );
    expect(row).not.toBeNull();
    expect(
      decryptCredential(
        row!,
        { ownerId: row!.owner_id, providerId: row!.id, credentialVersion: row!.credential_version },
        config,
      ),
    ).toBe('replacement-after-discovery-start');
    const wrong = createProviderService(reopened, { ...config, masterKey: randomBytes(32) });
    const actor = { userId: row!.owner_id, sessionId: 'local-restart-observation' };
    expect(await wrong.get(actor)).toMatchObject({ hasKey: true });
    await expect(wrong.discover(actor)).rejects.toThrow('PROVIDER_CREDENTIAL_UNAVAILABLE');
    await wrong.close();
  } finally {
    await reopened.close();
  }
});

it('aborts its in-flight discovery during shutdown, waits for settlement and releases its own pool', async () => {
  const isolated = await createProviderStore(config);
  let started!: () => void;
  const arrived = new Promise<void>((resolve) => {
    started = resolve;
  });
  const service = createProviderService(isolated, config, async (_url, options) => {
    started();
    return new Promise((_resolve, reject) =>
      options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
  });
  const row = (
    await pool.query('SELECT owner_id FROM mio_provider_configs WHERE id=$1', [
      (await current()).id,
    ])
  ).rows[0];
  const actor = { userId: row.owner_id, sessionId: 'shutdown-observation' };
  const pending = service.discover(actor);
  await arrived;
  await service.close();
  expect(await pending).toMatchObject({ status: 'failed', error: 'UPSTREAM_CANCELLED' });
  expect(() => service.get(actor)).toThrow('PROVIDER_UNAVAILABLE');
  await service.close();
});

it('rejects same-name malformed default indexes and missing schema without leaking startup pools', async () => {
  // The scoped URL supplies application_name; compare the actual isolated consumer group.
  const connectionCount = async () =>
    (
      await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND datname=current_database()',
        [database.applicationName],
      )
    ).rows[0]!.count;
  const before = await connectionCount();
  for (const definition of [
    'CREATE UNIQUE INDEX mio_provider_usage_default ON mio_provider_model_preferences(provider_id,model_key) WHERE is_default',
    'CREATE UNIQUE INDEX mio_provider_usage_default ON mio_provider_model_preferences(provider_id,usage) WHERE is_default AND false',
  ]) {
    await pool.query('DROP INDEX mio_provider_usage_default');
    await pool.query(definition);
    try {
      await expect(createProviderStore(config)).rejects.toThrow('PROVIDER_SCHEMA');
    } finally {
      await pool.query('DROP INDEX mio_provider_usage_default');
      await pool.query(providerSchemaSQL);
    }
  }
  await pool.query('CREATE SCHEMA provider_missing');
  const missing = new URL(config.databaseURL);
  missing.searchParams.set('options', '-csearch_path=provider_missing');
  try {
    await expect(
      createProviderStore({ ...config, databaseURL: missing.toString() }),
    ).rejects.toThrow('PROVIDER_SCHEMA');
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='provider_missing'",
        )
      ).rows[0].count,
    ).toBe(0);
  } finally {
    await pool.query('DROP SCHEMA provider_missing');
  }
  expect(await connectionCount()).toBe(before);
});
