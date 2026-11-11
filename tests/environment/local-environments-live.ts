import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@redis/client';
import type { RedisClientType } from '@redis/client';
import { Pool } from 'pg';
import { readLocalEnvironment } from '../../scripts/service/local-environment.ts';
import type { LocalEnvironment } from '../../scripts/service/local-environment.ts';

// Explicit operator probe: creates retained accounts and restarts only mio-dev/mio-test.
assert.deepEqual(process.argv.slice(2), ['--restart-local-environments']);
const runId = Date.now().toString();
const email = `local-${runId}@example.test`;
const directory = resolve('.runtime/local-acceptance', runId);
await mkdir(directory, { recursive: true, mode: 0o700 });
const cancellation = new AbortController();
const cancel = () => cancellation.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);

async function command(argv: string[], env: NodeJS.ProcessEnv) {
  cancellation.signal.throwIfAborted();
  const child = spawn(argv[0]!, argv.slice(1), { env, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGTERM');
  cancellation.signal.addEventListener('abort', interrupt, { once: true });
  try {
    const [code, signal] = await once(child, 'close');
    cancellation.signal.throwIfAborted();
    assert(code === 0 && signal === null, 'Local infrastructure command failed');
  } finally {
    cancellation.signal.removeEventListener('abort', interrupt);
  }
}

async function environment(name: LocalEnvironment) {
  const config = await readLocalEnvironment(name);
  const origin = config.values.MIO_AUTH_BASE_URL!;
  const password = randomBytes(24).toString('hex');
  const marker = `mio:${name}:local-acceptance:${runId}`;
  let child: ChildProcess | undefined;
  const call = (path: string, body?: unknown, cookie?: string) =>
    fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(path === '/readyz' ? {} : { origin }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(5000)]),
    });
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'close');
    child.kill('SIGTERM');
    const graceful = await Promise.race([
      exited.then(() => true),
      delay(30000, false, { ref: false }),
    ]);
    assert(graceful, `${name}: Profile did not drain; do not restart middleware`);
  };
  return {
    name,
    config,
    origin,
    password,
    marker,
    call,
    stop,
    async start() {
      cancellation.signal.throwIfAborted();
      const existing = await call('/readyz').catch(() => null);
      cancellation.signal.throwIfAborted();
      assert(existing === null, `${name}: stop the existing application before this probe`);
      const log = await open(resolve(directory, `${name}.log`), 'a', 0o600);
      try {
        child = spawn(process.execPath, ['scripts/service/local.ts', name, 'start'], {
          env: config.host,
          stdio: ['ignore', log.fd, log.fd],
        });
      } finally {
        await log.close();
      }
      for (let attempt = 0; attempt < 200; attempt++) {
        assert(
          child.exitCode === null && child.signalCode === null,
          `${name}: startup failed; inspect private log`,
        );
        if ((await call('/readyz').catch(() => null))?.status === 200) return;
        await delay(100, undefined, { signal: cancellation.signal });
      }
      throw new Error(`${name}: startup deadline exceeded`);
    },
    async database<T>(action: (pool: Pool) => Promise<T>) {
      const pool = new Pool({
        connectionString: config.values.MIO_AUTH_DATABASE_URL,
        connectionTimeoutMillis: 5000,
      });
      try {
        return await action(pool);
      } finally {
        await pool.end();
      }
    },
    async redis<T>(action: (client: RedisClientType) => Promise<T>) {
      const client = createClient({
        url: config.values.MIO_REDIS_URL!,
        socket: { reconnectStrategy: false, connectTimeout: 5000 },
      });
      client.on('error', () => {});
      try {
        await client.connect();
        return await action(client);
      } finally {
        if (client.isOpen) client.destroy();
      }
    },
  };
}

type Environment = Awaited<ReturnType<typeof environment>>;
const dev = await environment('dev');
const test = await environment('test');
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');

async function identity(env: Environment, cookie: string) {
  const response = await env.call('/api/v1/me', undefined, cookie);
  assert.equal(response.status, 200, `${env.name}: authenticated identity`);
  return (await response.json()) as { userId: string; sessionId: string };
}

async function account(env: Environment) {
  const response = await env.call('/api/auth/sign-up/email', {
    email,
    password: env.password,
    name: `Local ${env.name}`,
  });
  assert.equal(response.status, 200, `${env.name}: registration`);
  const login = await env.call('/api/auth/sign-in/email', { email, password: env.password });
  assert.equal(login.status, 200, `${env.name}: login`);
  const cookie = cookies(login);
  assert(cookie, `${env.name}: session cookie missing`);
  return { cookie, ...(await identity(env, cookie)) };
}

async function resources(env: Environment) {
  await env.database(async (pool) => {
    const version = (await pool.query('SHOW server_version')).rows[0].server_version as string;
    assert(version.startsWith('18.'), `${env.name}: PostgreSQL 18 required`);
    const roles = await pool.query(
      'SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user',
    );
    assert.deepEqual(roles.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    console.log(
      `${env.name}: PostgreSQL ${version}; application role has no administrator privileges`,
    );
  });
  await env.redis(async (client) => {
    assert.equal(await client.set(env.marker, runId), 'OK');
    await assert.rejects(
      client.get(`mio:${env.name === 'dev' ? 'test' : 'dev'}:forbidden`),
      /NOPERM/,
    );
    await assert.rejects(client.sendCommand(['CONFIG', 'GET', 'appendonly']), /NOPERM/);
  });
  if (env.name === 'test') {
    const wrong = new URL(env.config.values.MIO_TEST_DATABASE_URL!);
    wrong.pathname = '/mio_test';
    const pool = new Pool({ connectionString: wrong.toString(), connectionTimeoutMillis: 5000 });
    try {
      await assert.rejects(pool.query('SELECT 1'), { code: '42501' });
    } finally {
      await pool.end();
    }
  }
}

async function restart(
  env: Environment,
  other: Environment,
  session: Awaited<ReturnType<typeof account>>,
  otherCookie: string,
) {
  cancellation.signal.throwIfAborted();
  await env.stop();
  await env.database(async (pool) => {
    const active = await pool.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'mio-auth'",
    );
    assert.equal(active.rows[0].count, 0, `${env.name}: old application connections must drain`);
  });
  const drained = performance.now();
  const compose = [
    'docker',
    'compose',
    '--env-file',
    env.config.file,
    '-p',
    `mio-${env.name}`,
    '-f',
    'deploy/local/compose.yaml',
  ];
  await command([...compose, 'restart'], env.config.host);
  await command([...compose, 'up', '-d', '--wait', '--wait-timeout', '120'], env.config.host);
  await identity(other, otherCookie);
  assert.equal(
    (await other.call('/api/auth/sign-in/email', { email, password: other.password })).status,
    200,
    'Other environment remains usable',
  );
  await env.redis(async (client) =>
    assert.equal(await client.get(env.marker), runId, `${env.name}: Redis AOF retained marker`),
  );
  console.log(
    `${env.name}: middleware restarted, Redis marker retained, other environment still works; completing real 65-second recovery wait`,
  );
  await delay(Math.max(0, 65000 - (performance.now() - drained)), undefined, {
    signal: cancellation.signal,
  });
  assert(performance.now() - drained >= 65000, 'Recovery wait must use elapsed monotonic time');
  await env.start();
  assert.deepEqual(await identity(env, session.cookie), {
    userId: session.userId,
    sessionId: session.sessionId,
  });
  const login = await env.call('/api/auth/sign-in/email', { email, password: env.password });
  assert.equal(login.status, 200, `${env.name}: login after restart`);
  assert.equal((await identity(env, cookies(login))).userId, session.userId);
  console.log(`${env.name}: original account, session cookie and user ID survived restart`);
}

try {
  await dev.start();
  await test.start();
  const devSession = await account(dev);
  assert.equal(
    (await test.call('/api/auth/sign-in/email', { email, password: dev.password })).status,
    401,
    'Development account absent from test',
  );
  const testSession = await account(test);
  assert.notEqual(devSession.userId, testSession.userId);
  for (const [own, other, cookie] of [
    [dev, test, testSession.cookie],
    [test, dev, devSession.cookie],
  ] as const) {
    assert.equal(
      (await own.call('/api/auth/sign-in/email', { email, password: other.password })).status,
      401,
      'Cross-environment password rejected',
    );
    assert.equal(
      (await own.call('/api/v1/me', undefined, cookie)).status,
      401,
      'Cross-environment cookie rejected',
    );
    await resources(own);
  }
  console.log(
    'Both environments registered the same email with independent passwords, identities and sessions',
  );
  await restart(dev, test, devSession, testSession.cookie);
  await restart(test, dev, testSession, devSession.cookie);
  cancellation.signal.throwIfAborted();
  await writeFile(
    resolve(directory, 'accounts.json'),
    JSON.stringify(
      {
        email,
        dev: { origin: dev.origin, password: dev.password, userId: devSession.userId },
        test: { origin: test.origin, password: test.password, userId: testSession.userId },
      },
      null,
      2,
    ),
    { mode: 0o600, flag: 'wx' },
  );
} finally {
  await Promise.all([dev.stop(), test.stop()]);
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
cancellation.signal.throwIfAborted();
console.log(
  `PASS: retained account credentials in ${directory}/accounts.json; applications stopped, middleware stays running`,
);
