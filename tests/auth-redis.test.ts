import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as Mio from '../src/plugin.ts';
import * as AuthenticationService from '../src/auth/service.ts';
import * as RateLimit from '../src/auth/rate-limit.ts';
import { readAuthConfig } from '../src/auth/config.ts';
import { createAuthHandler } from '../src/auth/http.ts';
import { createRedisResource } from '../src/integrations/redis.ts';
import { authDatabase } from './auth-database.ts';
import { redisServer } from './redis-server.ts';
import { redisProxy } from './redis-proxy.ts';
import { packedAuthRuntime } from './auth-runtime.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let server: Awaited<ReturnType<typeof redisServer>>;
let pool: Pool;
let ctx: Context;
let plugin: ReturnType<Context['plugin']>;
let origin: string;
const namespace = `auth-${randomUUID()}`;
const prefix = `mio:${namespace}:auth:rate-limit:v1:`;
const password = 'correct-horse-redis-mio-91';
const secret = randomBytes(40).toString('hex');
const envKeys = [
  'MIO_AUTH_DATABASE_URL',
  'MIO_AUTH_BASE_URL',
  'MIO_AUTH_SECRET',
  'MIO_AUTH_ALLOWED_ORIGINS',
  'MIO_AUTH_RATE_LIMIT_BACKEND',
  'MIO_REDIS_URL',
  'MIO_REDIS_NAMESPACE',
  'MIO_REDIS_TEST_TOKEN',
] as const;
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
function call(
  path: string,
  body?: unknown,
  cookie?: string,
  extra: Record<string, string> = {},
  base = origin,
) {
  return fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin: base,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function reload(backend: string, url = server.url, selectedNamespace = namespace) {
  if (plugin) await plugin.dispose();
  Object.assign(process.env, {
    MIO_AUTH_RATE_LIMIT_BACKEND: backend,
    MIO_REDIS_URL: url,
    MIO_REDIS_NAMESPACE: selectedNamespace,
  });
  plugin = ctx.plugin(Mio, { tokenEnv: 'MIO_REDIS_TEST_TOKEN', allowedOrigins: [] });
  await plugin.await();
}
async function resetLimits() {
  await pool.query('DELETE FROM "rateLimit"');
  const keys = await server.client.keys(`${prefix}*`);
  if (keys.length) await server.client.del(keys);
}
async function account(email: string) {
  const response = await call('/api/auth/sign-up/email', { name: 'Redis owner', email, password });
  expect(response.status, await response.clone().text()).toBe(200);
  return cookies(response);
}
async function login(email: string, base = origin) {
  const response = await call('/api/auth/sign-in/email', { email, password }, undefined, {}, base);
  expect(response.status, await response.clone().text()).toBe(200);
  return cookies(response);
}
beforeAll(async () => {
  database = await authDatabase();
  server = await redisServer();
  pool = new Pool({ connectionString: database.observerURL });
  ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  origin = ctx.webServer.getOrigin();
  Object.assign(process.env, {
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_AUTH_BASE_URL: origin,
    MIO_AUTH_SECRET: secret,
    MIO_AUTH_ALLOWED_ORIGINS: '[]',
    MIO_AUTH_RATE_LIMIT_BACKEND: 'database',
    MIO_REDIS_TEST_TOKEN: secret,
  });
  const migration = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(migration.status, migration.stdout + migration.stderr).toBe(0);
  await reload('database');
}, 45000);
afterAll(async () => {
  try {
    if (ctx) await ctx.fiber.dispose();
  } finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    if (pool) await pool.end();
    if (database) await database.close();
    if (server) await server.close();
  }
}, 30000);

it('compares all nine actual HTTP rules, database and Redis responses, trusted IP and namespace isolation', async () => {
  const rules = [
    ['/sign-in/email', 60, 10, { email: 'missing@example.test', password }],
    ['/sign-up/email', 60, 5, { name: 'Invalid', email: 'invalid', password }],
    ['/change-password', 10, 3, { currentPassword: password, newPassword: password + 'new' }],
    ['/sign-out', 60, 100, {}],
    ['/get-session', 60, 100, undefined],
    ['/list-sessions', 60, 100, undefined],
    ['/revoke-session', 60, 100, { token: 'missing' }],
    ['/revoke-sessions', 60, 100, {}],
    ['/revoke-other-sessions', 60, 100, {}],
  ] as const;
  const baseline = new Map<string, number[]>();
  const observed: { key: string; rule: { window: number; max: number } }[] = [];
  const create = RateLimit.createRedisRateLimit;
  const capture = vi
    .spyOn(RateLimit, 'createRedisRateLimit')
    .mockImplementation(async (...args) => {
      const storage = await create(...args);
      return {
        ...storage,
        async consume(key, rule) {
          observed.push({ key, rule });
          return storage.consume!(key, rule);
        },
      };
    });
  try {
    for (const backend of ['database', 'redis']) {
      // This is backend comparison on freshly reset owned fixtures, not the deployment rehearsal below.
      await resetLimits();
      await reload(backend);
      const before = await pool.query('SELECT * FROM "rateLimit" ORDER BY key');
      for (const [path, window, max, body] of rules) {
        const statuses: number[] = [];
        const start = observed.length;
        for (let count = 0; count <= max; count++) {
          const response = await call(`/api/auth${path}`, body);
          statuses.push(response.status);
          expect(response.headers.get('cache-control')).toBe('no-store');
          expect(response.headers.get('x-content-type-options')).toBe('nosniff');
          if (count < max) expect(response.status, path).not.toBe(429);
          else {
            expect(response.status, path).toBe(429);
            expect(await response.json()).toEqual({
              message: 'Too many requests. Please try again later.',
            });
            expect(Number(response.headers.get('x-retry-after'))).toBeGreaterThan(0);
            expect(Number(response.headers.get('x-retry-after'))).toBeLessThanOrEqual(window);
            expect(response.headers.getSetCookie()).toEqual([]);
          }
        }
        if (backend === 'database') baseline.set(path, statuses);
        else {
          expect(statuses, path).toEqual(baseline.get(path));
          expect(observed.slice(start)).toHaveLength(max + 1);
          expect(
            observed
              .slice(start)
              .every((entry) => entry.rule.window === window && entry.rule.max === max),
          ).toBe(true);
          expect(new Set(observed.slice(start).map((entry) => entry.key)).size).toBe(1);
        }
      }
      if (backend === 'redis')
        expect((await pool.query('SELECT * FROM "rateLimit" ORDER BY key')).rows).toEqual(
          before.rows,
        );
    }
    const variants = await Promise.all(
      [1, 2].map((n) =>
        call(
          `/api/auth/sign-in/email?nonce=${n}`,
          { email: 'missing@example.test', password },
          undefined,
          {
            'x-forwarded-for': `203.0.113.${n}`,
            'x-real-ip': `198.51.100.${n}`,
            'x-mio-client-ip': `192.0.2.${n}`,
          },
        ),
      ),
    );
    expect(variants.map((response) => response.status)).toEqual([429, 429]);
    // macOS does not provide 127.0.0.2 by default. Exercise a second real loopback
    // address via IPv6 with the same HTTP adapter, storage namespace and library.
    const redis = await createRedisResource({ url: server.url, namespace });
    const auth = await AuthenticationService.createAuthentication(
      readAuthConfig()!,
      await create(redis, namespace),
    );
    const ipv6 = createHttpServer(createAuthHandler(readAuthConfig()!, auth));
    try {
      await new Promise<void>((resolve, reject) => {
        ipv6.once('error', reject);
        ipv6.listen(0, '::1', resolve);
      });
      const address = ipv6.address();
      if (!address || typeof address === 'string') throw new Error('IPv6 port missing');
      expect(
        (
          await call(
            '/api/auth/sign-in/email',
            { email: 'missing@example.test', password },
            undefined,
            { origin },
            `http://[::1]:${address.port}`,
          )
        ).status,
      ).toBe(401);
    } finally {
      await new Promise<void>((resolve) => ipv6.close(() => resolve()));
      await auth.close();
      await redis.close();
    }
    await reload('redis');
    expect(
      (await call('/api/auth/sign-in/email', { email: 'missing@example.test', password })).status,
    ).toBe(429);
    await reload('redis', server.url, namespace + '-other');
    expect(
      (await call('/api/auth/sign-in/email', { email: 'missing@example.test', password })).status,
    ).toBe(401);
    await reload('redis');
    expect(
      (await call('/api/auth/sign-in/email', { email: 'missing@example.test', password })).status,
    ).toBe(429);
    console.log(
      'Nine DB/Redis HTTP rules matched; forged headers/query did not reopen quota; different connection IP and namespace isolated; reload retained quota.',
    );
  } finally {
    capture.mockRestore();
  }
}, 60000);

it('compares the same controlled time sequence through real PostgreSQL storage and the Redis script', async () => {
  await resetLimits();
  const auth = await AuthenticationService.createAuthentication(readAuthConfig()!);
  const redis = await createRedisResource({ url: server.url, namespace });
  const clock = `local actual = redis
local redis = {error_reply = actual.error_reply, call = function(command, ...)
if command == 'TIME' then return {ARGV[3], ARGV[4]} end
return actual.call(command, ...) end}
`;
  const script = RateLimit.AUTH_RATE_LIMIT_SCRIPT.replace('#!lua\n', '#!lua\n' + clock);
  const key = prefix + 'controlled-database-comparison';
  const base = Date.now();
  const now = vi.spyOn(Date, 'now');
  try {
    for (const offset of [
      ...Array.from({ length: 10 }, (_, i) => i * 100),
      999,
      60899,
      60900,
      61000,
    ]) {
      const time = base + offset;
      now.mockReturnValue(time);
      const response = await auth.handler(
        new Request(`${origin}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json', 'x-mio-client-ip': '127.0.0.31' },
          body: JSON.stringify({ email: 'sequence@example.test', password }),
        }),
      );
      const reply = await redis.evaluate(script, key, [
        '60000',
        '10',
        String(Math.floor(time / 1000)),
        String((time % 1000) * 1000),
      ]);
      expect(reply).toEqual([
        response.status === 429 ? 0 : 1,
        response.status === 429 ? Number(response.headers.get('x-retry-after')) : 0,
      ]);
      const row = (await pool.query('SELECT count,"lastRequest" FROM "rateLimit"')).rows[0];
      expect(await server.client.get(key)).toBe(`${row.count}:${row.lastRequest}`);
    }
  } finally {
    now.mockRestore();
    await auth.close();
    await redis.close();
    await server.client.del(key);
  }
});

it('keeps real accounts/sessions in PG, refresh/revocation ownership and HTTP guards under Redis', async () => {
  await resetLimits();
  await reload('redis');
  const owner = `owner-${randomUUID()}@example.test`;
  const cookie = await account(owner);
  const second = await login(owner);
  const foreignEmail = `other-${randomUUID()}@example.test`;
  const foreign = await account(foreignEmail);
  await reload('redis');
  const identity = (await (await call('/api/v1/me', undefined, cookie)).json()) as {
    userId: string;
    sessionId: string;
  };
  await pool.query(
    'UPDATE session SET "updatedAt"=NOW()-INTERVAL \'2 days\', "expiresAt"=NOW()+INTERVAL \'5 days\' WHERE id=$1',
    [identity.sessionId],
  );
  const before = (
    await pool.query('SELECT "updatedAt","expiresAt" FROM session WHERE id=$1', [
      identity.sessionId,
    ])
  ).rows[0];
  const me = await call('/api/v1/me', undefined, cookie);
  expect(me.status).toBe(200);
  expect(me.headers.getSetCookie()).toEqual([]);
  expect(
    (
      await pool.query('SELECT "updatedAt","expiresAt" FROM session WHERE id=$1', [
        identity.sessionId,
      ])
    ).rows[0],
  ).toEqual(before);
  const refreshed = await call('/api/auth/get-session', undefined, cookie);
  expect(refreshed.status).toBe(200);
  expect(refreshed.headers.getSetCookie().length).toBeGreaterThan(0);
  const otherSession = (
    await pool.query(
      'SELECT token FROM session WHERE "userId"=(SELECT id FROM "user" WHERE email=$1) LIMIT 1',
      [foreignEmail],
    )
  ).rows[0].token;
  expect((await call('/api/auth/revoke-session', { token: otherSession }, cookie)).status).toBe(
    200,
  );
  expect((await call('/api/v1/me', undefined, foreign)).status).toBe(200);
  const changed = await call(
    '/api/auth/change-password',
    {
      currentPassword: password,
      newPassword: password + '-changed',
      revokeOtherSessions: true,
    },
    cookie,
  );
  expect(changed.status).toBe(200);
  const valid = cookies(changed);
  expect(valid).not.toBe('');
  expect((await call('/api/v1/me', undefined, cookie)).status).toBe(401);
  expect((await call('/api/v1/me', undefined, second)).status).toBe(401);
  expect((await call('/api/v1/me', undefined, valid)).status).toBe(200);
  const changedLogin = await call('/api/auth/sign-in/email', {
    email: owner,
    password: password + '-changed',
  });
  expect(changedLogin.status).toBe(200);
  const relogged = cookies(changedLogin);
  expect((await call('/api/v1/me', undefined, relogged)).status).toBe(200);
  expect((await call('/api/auth/revoke-other-sessions', {}, valid)).status).toBe(200);
  expect((await call('/api/v1/me', undefined, relogged)).status).toBe(401);
  expect((await call('/api/auth/revoke-sessions', {}, valid)).status).toBe(200);
  expect((await call('/api/v1/me', undefined, valid)).status).toBe(401);
  expect((await call('/api/auth/sign-out', {}, foreign)).status).toBe(200);
  expect((await call('/api/v1/me', undefined, foreign)).status).toBe(401);
  const keys = await server.client.keys(`${prefix}*`);
  const snapshot = await Promise.all(keys.map(async (key) => [key, await server.client.get(key)]));
  for (const [path, options, status] of [
    ['/api/auth/sign-in/email', { method: 'OPTIONS', headers: { origin } }, 204],
    [
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: '{}',
      },
      403,
    ],
    [
      '/api/auth/missing',
      { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' },
      404,
    ],
    ['/api/auth/sign-in/email', { method: 'GET', headers: { origin } }, 405],
    [
      '/api/auth/sign-in/email',
      { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: '{}' },
      415,
    ],
    [
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: 'x'.repeat(17000),
      },
      413,
    ],
  ] as const)
    expect((await fetch(`${origin}${path}`, options)).status).toBe(status);
  expect(await Promise.all(keys.map(async (key) => [key, await server.client.get(key)]))).toEqual(
    snapshot,
  );
  expect((await server.client.keys(`${prefix}*`)).sort()).toEqual([...keys].sort());
});

it('observes actual PostgreSQL Client queries with a database positive control and Redis account/session traffic', async () => {
  await resetLimits();
  await reload('redis');
  const email = `sql-${randomUUID()}@example.test`;
  await account(email);
  for (const backend of ['database', 'redis']) {
    await resetLimits();
    await reload(backend);
    // Kysely acquires a PoolClient and calls Client.query, not Pool.query.
    const query = vi.spyOn(Client.prototype, 'query');
    try {
      const cookie = await login(email);
      expect((await call('/api/v1/me', undefined, cookie)).status).toBe(200);
      const statements = query.mock.calls.map((args) =>
        String(typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text),
      );
      const counts = {
        backend,
        rateLimitStatements: statements.filter((sql) => sql.includes('"rateLimit"')).length,
        accountSessionStatements: statements.filter((sql) => /"(?:user|account|session)"/.test(sql))
          .length,
      };
      expect(counts.accountSessionStatements).toBeGreaterThan(0);
      if (backend === 'database') expect(counts.rateLimitStatements).toBeGreaterThan(0);
      else expect(counts.rateLimitStatements).toBe(0);
      process.stdout.write('R1_SQL ' + JSON.stringify(counts) + '\n');
    } finally {
      query.mockRestore();
    }
  }
});

it('admits one effective HTTP registration at the quota edge and blocks valid auth side effects after exhaustion', async () => {
  await resetLimits();
  await reload('redis');
  const email = `effects-${randomUUID()}@example.test`;
  const cookie = await account(email);
  await resetLimits();
  const counts = async () =>
    (
      await pool.query(
        'SELECT (SELECT count(*)::int FROM "user") users, (SELECT count(*)::int FROM account) accounts, (SELECT count(*)::int FROM session) sessions',
      )
    ).rows[0] as { users: number; accounts: number; sessions: number };
  for (let i = 0; i < 4; i++)
    expect(
      (await call('/api/auth/sign-up/email', { name: 'Invalid', email: 'invalid', password }))
        .status,
    ).toBe(400);
  const before = await counts();
  const responses = await Promise.all(
    Array.from({ length: 3 }, () =>
      call('/api/auth/sign-up/email', {
        name: 'Concurrent',
        email: `edge-${randomUUID()}@example.test`,
        password,
      }),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([200, 429, 429]);
  expect(await counts()).toEqual({
    users: before.users + 1,
    accounts: before.accounts + 1,
    sessions: before.sessions + 1,
  });
  const exhausted = await counts();
  expect(
    (
      await call('/api/auth/sign-up/email', {
        name: 'Blocked',
        email: `blocked-${randomUUID()}@example.test`,
        password,
      })
    ).status,
  ).toBe(429);
  expect(await counts()).toEqual(exhausted);
  for (let i = 0; i < 10; i++)
    expect((await call('/api/auth/sign-in/email', { email, password: 'wrong' })).status).toBe(401);
  const deniedLogin = await call('/api/auth/sign-in/email', { email, password });
  expect(deniedLogin.status).toBe(429);
  expect(deniedLogin.headers.getSetCookie()).toEqual([]);
  expect(await counts()).toEqual(exhausted);
  const credential = async () =>
    (
      await pool.query(
        'SELECT password FROM account WHERE "userId"=(SELECT id FROM "user" WHERE email=$1)',
        [email],
      )
    ).rows[0].password as string;
  const oldHash = await credential();
  for (let i = 0; i < 3; i++)
    expect(
      (
        await call(
          '/api/auth/change-password',
          {
            currentPassword: 'incorrect-current',
            newPassword: password + '-blocked',
            revokeOtherSessions: true,
          },
          cookie,
        )
      ).status,
    ).toBe(400);
  const deniedChange = await call(
    '/api/auth/change-password',
    { currentPassword: password, newPassword: password + '-blocked', revokeOtherSessions: true },
    cookie,
  );
  expect(deniedChange.status).toBe(429);
  expect(deniedChange.headers.getSetCookie()).toEqual([]);
  expect((await credential()) === oldHash).toBe(true);
  expect(await counts()).toEqual(exhausted);
  expect((await call('/api/v1/me', undefined, cookie)).status).toBe(200);
});

it('keeps Redis optional, rejects broken explicit configuration and closes a startup-unloaded plugin', async () => {
  await reload('database', 'not-a-url', 'Invalid');
  expect((await fetch(`${origin}/readyz`)).status).toBe(200);
  const protectedServer = await redisServer(randomBytes(24).toString('hex'));
  const wrongPassword = new URL(protectedServer.url);
  wrongPassword.password = 'fixture-wrong-password';
  try {
    for (const [backend, url, ns, code] of [
      ['invalid', server.url, namespace, 'AUTH_CONFIG'],
      ['redis', server.url, '', 'REDIS_CONFIG'],
      ['redis', 'redis://127.0.0.1:1', namespace, 'REDIS_STARTUP'],
      ['redis', wrongPassword.toString(), namespace, 'REDIS_STARTUP'],
    ]) {
      let failure: unknown;
      try {
        await reload(backend!, url!, ns!);
      } catch (error) {
        failure = error;
      }
      expect(failure, `${backend}: expected ${code}`).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(code);
      expect((await fetch(`${origin}/readyz`)).status).toBe(404);
      await plugin.dispose();
    }
  } finally {
    await protectedServer.close();
  }
  const authConfig = readAuthConfig()!;
  for (const key of ['MIO_AUTH_BASE_URL', 'MIO_AUTH_SECRET', 'MIO_AUTH_DATABASE_URL'])
    delete process.env[key];
  try {
    await expect(reload('redis')).rejects.toThrow('AUTH_CONFIG');
    expect((await fetch(`${origin}/readyz`)).status).toBe(404);
    await plugin.dispose();
  } finally {
    Object.assign(process.env, {
      MIO_AUTH_BASE_URL: authConfig.baseURL,
      MIO_AUTH_SECRET: authConfig.secret,
      MIO_AUTH_DATABASE_URL: authConfig.databaseURL,
    });
  }
  await reload('redis');
  await plugin.dispose();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const create = AuthenticationService.createAuthentication;
  const factory = vi
    .spyOn(AuthenticationService, 'createAuthentication')
    .mockImplementation(async (...args) => {
      const auth = await create(...args);
      entered.resolve();
      await resume.promise;
      return auth;
    });
  try {
    plugin = ctx.plugin(Mio, { tokenEnv: 'MIO_REDIS_TEST_TOKEN', allowedOrigins: [] });
    await entered.promise;
    const disposing = plugin.dispose();
    resume.resolve();
    await disposing;
    expect((await fetch(`${origin}/readyz`)).status).toBe(404);
    expect((await server.client.clientList()).length).toBe(1);
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1', [
          database.applicationName,
        ])
      ).rows[0].n,
    ).toBe(0);
  } finally {
    resume.resolve();
    factory.mockRestore();
  }
  Object.assign(process.env, {
    MIO_AUTH_RATE_LIMIT_BACKEND: 'redis',
    MIO_REDIS_URL: 'not-a-url',
    MIO_REDIS_NAMESPACE: '',
  });
  const migration = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(migration.status, migration.stdout + migration.stderr).toBe(0);
  expect(migration.stdout).toContain('schema is current');
});

it('maps real OOM to 503 only for that request and prevents business writes after a lost response', async () => {
  await resetLimits();
  await reload('redis');
  const email = `failure-${randomUUID()}@example.test`;
  const cookie = await account(email);
  try {
    await server.client.configSet('maxmemory', '1');
    expect((await call('/api/auth/sign-in/email', { email, password })).status).toBe(503);
    expect((await call('/api/v1/me', undefined, cookie)).status).toBe(200);
  } finally {
    await server.client.configSet('maxmemory', '128mb');
  }
  expect((await call('/api/auth/sign-in/email', { email, password: 'wrong' })).status).toBe(401);
  const relay = await redisProxy(server.port);
  try {
    await resetLimits();
    await reload('redis', relay.url);
    const sessions = (await pool.query('SELECT count(*)::int n FROM session')).rows[0].n;
    relay.hold();
    const start = performance.now();
    const pending = call('/api/auth/sign-in/email', { email, password });
    await vi.waitFor(() => expect(relay.heldBytes).toBeGreaterThan(0));
    const response = await pending;
    expect(response.status).toBe(503);
    expect(performance.now() - start).toBeLessThan(1500);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'AUTH_UNAVAILABLE',
        message: 'AUTH_UNAVAILABLE',
        requestId: response.headers.get('x-request-id'),
      },
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    const sent = relay.received;
    relay.release();
    expect((await call('/api/v1/me', undefined, cookie)).status).toBe(200);
    expect((await call('/api/auth/sign-in/email', { email, password })).status).toBe(503);
    await delay(100);
    expect(relay.received).toBe(sent);
    expect((await pool.query('SELECT count(*)::int n FROM session')).rows[0].n).toBe(sessions);
    const [key] = await server.client.keys(`${prefix}*`);
    expect(await server.client.get(key!)).toMatch(/^1:/);
    const stopped = performance.now();
    await plugin.dispose();
    expect(performance.now() - stopped).toBeLessThan(1300);
    await vi.waitFor(() => expect(relay.connections).toBe(0));
  } finally {
    await relay.close();
  }
});

it('rehearses controlled Profile cutover, lost-state recovery and rollback with existing counts and cookies', async () => {
  await plugin.dispose();
  const ns = `rollout-${randomUUID()}`;
  const runtime = await packedAuthRuntime(database.url, server.url, ns);
  const email = `rollout-${randomUUID()}@example.test`;
  const events: Record<string, unknown>[] = [];
  const event = (phase: string, values: Record<string, unknown> = {}) => {
    const record = { phase, monotonicMs: Number(performance.now().toFixed(1)), ...values };
    events.push(record);
    process.stdout.write('R1_REHEARSAL ' + JSON.stringify(record) + '\n');
  };
  const verifyIdentity = async (active: string, revoked: string) => {
    expect((await call('/api/v1/me', undefined, active, {}, runtime.origin)).status).toBe(200);
    expect((await call('/api/v1/me', undefined, revoked, {}, runtime.origin)).status).toBe(401);
  };
  const pauseAndWait = async (phase: string) => {
    const started = performance.now();
    await runtime.stop();
    const drained = performance.now();
    expect(drained - started).toBeLessThan(30000);
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1', [
          database.applicationName,
        ])
      ).rows[0].n,
    ).toBe(0);
    await vi.waitFor(async () => expect((await server.client.clientList()).length).toBe(1));
    for (const path of ['/readyz', '/api/v1/me', '/api/auth/get-session'])
      await expect(
        fetch(`${runtime.origin}${path}`, { signal: AbortSignal.timeout(500) }),
      ).rejects.toThrow();
    if (phase === 'cutover') {
      // Operator preflight failure is exercised with the whole Profile still stopped.
      await server.client.configSet('maxmemory-policy', 'allkeys-lru');
      expect(await server.client.configGet('maxmemory-policy')).toEqual({
        'maxmemory-policy': 'allkeys-lru',
      });
      await expect(
        fetch(`${runtime.origin}/readyz`, { signal: AbortSignal.timeout(500) }),
      ).rejects.toThrow();
      event('cutover:preflight-failed-remains-paused', {
        policy: 'allkeys-lru',
        profileStarted: false,
      });
      await server.client.configSet('maxmemory-policy', 'noeviction');
    }
    const time = (await server.client.sendCommand(['TIME'])) as string[];
    expect(Math.abs(Number(time[0]) * 1000 + Number(time[1]) / 1000 - Date.now())).toBeLessThan(
      2000,
    );
    expect(await server.client.configGet('maxmemory-policy')).toEqual({
      'maxmemory-policy': 'noeviction',
    });
    expect(await server.client.configGet('save')).toEqual({ save: '' });
    expect(await server.client.configGet('appendonly')).toEqual({ appendonly: 'no' });
    event(phase + ':drained-paused', { drainMs: drained - started, waitingSeconds: 65 });
    await delay(65000);
    expect(performance.now() - drained).toBeGreaterThanOrEqual(65000);
    event(phase + ':wait-complete');
    return started;
  };
  try {
    await runtime.start('database');
    const signup = await call(
      '/api/auth/sign-up/email',
      { name: 'Existing account', email, password },
      undefined,
      {},
      runtime.origin,
    );
    expect(signup.status).toBe(200);
    const active = cookies(signup);
    const revoked = await login(email, runtime.origin);
    expect((await call('/api/auth/sign-out', {}, revoked, {}, runtime.origin)).status).toBe(200);
    for (let i = 1; i < 10; i++)
      expect(
        (
          await call(
            '/api/auth/sign-in/email',
            { email, password: 'wrong' },
            undefined,
            {},
            runtime.origin,
          )
        ).status,
      ).toBe(401);
    expect(
      (await call('/api/auth/sign-in/email', { email, password }, undefined, {}, runtime.origin))
        .status,
    ).toBe(429);
    const rows = await pool.query('SELECT count,"lastRequest" FROM "rateLimit" WHERE key LIKE $1', [
      '%sign-in/email%',
    ]);
    expect(rows.rows.some((row) => row.count === 10)).toBe(true);
    await verifyIdentity(active, revoked);
    event('database:existing-state', { activeCount: 10, revokedCookieRejected: true });
    let start = await pauseAndWait('cutover');
    await runtime.start('redis');
    await verifyIdentity(active, revoked);
    await login(email, runtime.origin);
    expect(performance.now() - start).toBeLessThan(300000);
    event('cutover:redis-restored', { interruptionMs: performance.now() - start });
    for (let i = 1; i < 10; i++)
      expect(
        (
          await call(
            '/api/auth/sign-in/email',
            { email, password: 'wrong' },
            undefined,
            {},
            runtime.origin,
          )
        ).status,
      ).toBe(401);
    expect(
      (await call('/api/auth/sign-in/email', { email, password }, undefined, {}, runtime.origin))
        .status,
    ).toBe(429);
    await runtime.stop();
    await runtime.start('redis');
    expect(
      (await call('/api/auth/sign-in/email', { email, password }, undefined, {}, runtime.origin))
        .status,
    ).toBe(429);
    event('redis:normal-reload-retained-count', { activeCount: 10 });
    await server.stop();
    expect(
      (await call('/api/auth/sign-in/email', { email, password }, undefined, {}, runtime.origin))
        .status,
    ).toBe(503);
    await verifyIdentity(active, revoked);
    await server.start();
    expect(
      (await call('/api/auth/sign-in/email', { email, password }, undefined, {}, runtime.origin))
        .status,
    ).toBe(503);
    expect(await server.client.keys(`mio:${ns}:*`)).toEqual([]);
    event('redis:lost-state-stays-stopped', { meAvailable: true, automaticRecovery: false });
    event('redis:resource-restored-validation-failed-pause-profile', { observedAuthStatus: 503 });
    start = await pauseAndWait('fault-recovery');
    await runtime.start('redis');
    await verifyIdentity(active, revoked);
    await login(email, runtime.origin);
    expect(performance.now() - start).toBeLessThan(300000);
    event('fault-recovery:redis-restored', { interruptionMs: performance.now() - start });
    expect((await server.client.keys(`mio:${ns}:auth:rate-limit:v1:*`)).length).toBeGreaterThan(0);
    start = await pauseAndWait('rollback');
    await runtime.start('database');
    await verifyIdentity(active, revoked);
    await login(email, runtime.origin);
    expect(performance.now() - start).toBeLessThan(300000);
    event('rollback:database-restored', {
      interruptionMs: performance.now() - start,
      oldRevocationPreserved: true,
    });
    expect((await server.client.clientList()).length).toBe(1);
    expect(events.filter((entry) => String(entry.phase).endsWith('wait-complete'))).toHaveLength(3);
  } finally {
    await runtime.close();
  }
}, 270000);
