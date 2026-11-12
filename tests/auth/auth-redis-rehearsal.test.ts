import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { redisServer } from '../support/redis-server.ts';
import { packedAuthRuntime } from '../support/auth-runtime.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let server: Awaited<ReturnType<typeof redisServer>>;
let pool: Pool;
const password = 'correct-horse-redis-mio-91';
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
function call(
  path: string,
  body: unknown,
  cookie: string | undefined,
  extra: Record<string, string>,
  base: string,
) {
  return fetch(base + path, {
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
async function login(email: string, base: string) {
  const response = await call('/api/auth/sign-in/email', { email, password }, undefined, {}, base);
  expect(response.status, await response.clone().text()).toBe(200);
  return cookies(response);
}
beforeAll(async () => {
  database = await authDatabase();
  server = await redisServer();
  pool = new Pool({ connectionString: database.observerURL });
  const migration = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      PATH: process.env.PATH ?? '',
      MIO_AUTH_DATABASE_URL: database.url,
      MIO_AUTH_BASE_URL: 'http://127.0.0.1',
      MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
      MIO_AUTH_ALLOWED_ORIGINS: '[]',
    },
  });
  expect(migration.status, migration.stdout + migration.stderr).toBe(0);
}, 45000);
afterAll(async () => {
  if (pool) await pool.end();
  if (database) await database.close();
  if (server) await server.close();
}, 30000);

it('rehearses controlled Profile cutover, lost-state recovery and rollback with existing counts and cookies', async () => {
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
