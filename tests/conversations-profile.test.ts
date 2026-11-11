import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { authDatabase } from './auth-database.ts';
import { packedAuthRuntime } from './auth-runtime.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let runtime: Awaited<ReturnType<typeof packedAuthRuntime>>;
let cookie = '';
const call = (path: string, value?: unknown) =>
  fetch(`${runtime.origin}${path}`, {
    method: value === undefined ? 'GET' : 'POST',
    headers: {
      origin: runtime.origin,
      cookie,
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
const message = (id: string, key: string, text: string) =>
  call(`/api/v1/conversations/${id}/messages`, { requestId: key, text });
async function status(id: string, key: string) {
  return (await (await call(`/api/v1/conversations/${id}/requests/${key}`)).json()) as {
    status: string;
  };
}
async function waitStatus(id: string, key: string, wanted: string) {
  await expect.poll(async () => (await status(id, key)).status, { timeout: 5000 }).toBe(wanted);
}

beforeAll(async () => {
  database = await authDatabase();
  const env = {
    ...process.env,
    MIO_AUTH_BASE_URL: 'http://127.0.0.1:4311',
    MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_CONVERSATIONS_DATABASE_URL: database.url,
  };
  for (const file of [
    'scripts/service/migrate-auth.ts',
    'scripts/service/migrate-conversations.ts',
  ]) {
    const result = spawnSync(process.execPath, [file, '--apply'], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  runtime = await packedAuthRuntime(database.url, '', 'unused', {
    conversations: true,
    modelFixture: true,
  });
  await runtime.start('database');
  await vi.waitFor(
    async () => expect((await fetch(`${runtime.origin}/__test/model`)).status).toBe(200),
    { timeout: 5000 },
  );
  const signup = await call('/api/auth/sign-up/email', {
    name: 'Packed',
    email: 'packed-conversation@example.test',
    password: 'mio-profile-test-password-49',
  });
  expect(signup.status, await signup.clone().text()).toBe(200);
  cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}, 45000);
afterAll(async () => {
  try {
    if (runtime) await runtime.close();
  } finally {
    if (database) await database.close();
  }
}, 30000);

it('runs packed public multi-round requests and preserves settled content across normal restart', async () => {
  const created = await call('/api/v1/conversations', {});
  expect(created.status, await created.clone().text()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  expect((await message(id, 'one', 'remember packed context')).status).toBe(202);
  await waitStatus(id, 'one', 'completed');
  expect((await message(id, 'two', 'use prior context')).status).toBe(202);
  await waitStatus(id, 'two', 'completed');
  const observed = (await (await fetch(`${runtime.origin}/__test/model`)).json()) as {
    count: number;
    messages: unknown;
  };
  expect(observed.count).toBe(2);
  expect(JSON.stringify(observed.messages)).toContain('remember packed context');
  await runtime.stop();
  await runtime.start('database');
  const history = await (await call(`/api/v1/conversations/${id}/history`)).json();
  expect(JSON.stringify(history)).toContain('reply 2');
  expect((await message(id, 'two', 'use prior context')).status).toBe(202);
  const fresh = (await (await fetch(`${runtime.origin}/__test/model`)).json()) as { count: number };
  expect(fresh.count).toBe(0);
});

it('marks a hard-killed accepted request unknown and preserves the old interrupted turn after a new one', async () => {
  const created = await call('/api/v1/conversations', {});
  const { id } = (await created.json()) as { id: string };
  await message(id, 'killed', 'HOLD');
  await expect
    .poll(
      async () =>
        ((await (await fetch(`${runtime.origin}/__test/model`)).json()) as { count: number }).count,
    )
    .toBe(1);
  await waitStatus(id, 'killed', 'input-persisted');
  await runtime.crash();
  await runtime.start('database');
  await waitStatus(id, 'killed', 'unknown');
  expect((await message(id, 'killed', 'HOLD')).status).toBe(202);
  expect(
    ((await (await fetch(`${runtime.origin}/__test/model`)).json()) as { count: number }).count,
  ).toBe(0);
  expect((await message(id, 'new', 'fresh explicit input')).status).toBe(202);
  await waitStatus(id, 'new', 'completed');
  const history = await (await call(`/api/v1/conversations/${id}/history`)).json();
  expect(JSON.stringify(history)).toContain('interrupted');
});

it('uses the packed production composition without a mock provider and returns explicit model unavailability', async () => {
  await runtime.close();
  runtime = await packedAuthRuntime(database.url, '', 'unused', { conversations: true });
  await runtime.start('database');
  cookie = '';
  const signup = await call('/api/auth/sign-up/email', {
    name: 'No model',
    email: 'no-model@example.test',
    password: 'mio-profile-without-model-87',
  });
  expect(signup.status).toBe(200);
  cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const created = await call('/api/v1/conversations', {});
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const response = await message(id, 'no-model', 'cannot dispatch');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'MODEL_UNAVAILABLE' } });
  expect((await call(`/api/v1/conversations/${id}/requests/no-model`)).status).toBe(404);
  expect((await fetch(`${runtime.origin}/__test/model`)).status).toBe(404);
});
