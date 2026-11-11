import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { authDatabase } from './auth-database.ts';
import { packedAuthRuntime } from './auth-runtime.ts';
let database: Awaited<ReturnType<typeof authDatabase>>;
let runtime: Awaited<ReturnType<typeof packedAuthRuntime>>;
let cookie = '';
const base = '/api/v1/providers/onelink';
const master = randomBytes(32).toString('base64');
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
  database = await authDatabase();
  const env = {
    PATH: process.env.PATH ?? '',
    MIO_AUTH_BASE_URL: 'http://127.0.0.1:4311',
    MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_PROVIDERS_DATABASE_URL: database.url,
    MIO_PROVIDERS_MASTER_KEY: master,
    MIO_PROVIDERS_MASTER_KEY_ID: 'profile-test-key',
  };
  for (const file of ['scripts/service/migrate-auth.ts', 'scripts/service/migrate-providers.ts']) {
    const preview = spawnSync(process.execPath, [file], { env, encoding: 'utf8', timeout: 30000 });
    expect(preview.status, preview.stderr).toBe(0);
    const result = spawnSync(process.execPath, [file, '--apply'], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.status, result.stderr).toBe(0);
  }
  runtime = await packedAuthRuntime(database.url, '', 'unused', { providerMasterKey: master });
  await runtime.start('database');
  const signup = await call('/api/auth/sign-up/email', 'POST', {
    name: 'Packed providers',
    email: 'packed-provider@example.test',
    password: 'packed-provider-password-8342',
  });
  expect(signup.status).toBe(200);
  cookie = signup.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
}, 45000);
afterAll(async () => {
  try {
    await runtime?.close();
  } finally {
    await database?.close();
  }
}, 30000);
it('saves and reads configuration through packed production routes and persists it across restart without network probes', async () => {
  const saved = await call(`${base}/credential`, 'PUT', {
    apiKey: 'packed-only-synthetic-provider-key',
    expectedRevision: 0,
  });
  expect(saved.status).toBe(200);
  const first = await saved.json();
  expect(first).toMatchObject({
    credentialVersion: 1,
    revision: 1,
    discovery: null,
    masked: '********',
  });
  expect(
    (
      await call(`${base}/models`, 'PATCH', {
        modelRef: 'onelink:chat:deepseek-v4.1-flash',
        isDefault: true,
        expectedRevision: 1,
      })
    ).status,
  ).toBe(409);
  await runtime.stop();
  await runtime.start('database');
  expect(await (await call(base)).json()).toMatchObject({
    id: first.id,
    credentialVersion: 1,
    revision: 1,
    discovery: null,
  });
  const models = (await (await call(`${base}/models?category=chat`)).json()) as {
    items: { modelId: string; isDefault: boolean }[];
  };
  expect(models.items).toEqual([]);
});
