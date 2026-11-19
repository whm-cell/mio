import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launcher, prepareProfile } from './profile.ts';

const project = resolve('.');
const scratch = await mkdtemp(join(tmpdir(), 'mio-packed-'));
const stop = new AbortController();
const interrupt = () => stop.abort(new Error('SMOKE_CANCELLED: SIGINT'));
const terminate = () => stop.abort(new Error('SMOKE_CANCELLED: SIGTERM'));
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
const deadline = setTimeout(() => stop.abort(new Error('SMOKE_TIMEOUT')), 20_000);
deadline.unref();

async function command(bin: string, args: string[]): Promise<void> {
  stop.signal.throwIfAborted();
  const child = spawn(bin, args, {
    cwd: project,
    signal: stop.signal,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output = (output + chunk).slice(-12000);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output = (output + chunk).slice(-12000);
  });
  let failure: Error | undefined;
  child.once('error', (error) => {
    failure = error;
  });
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  stop.signal.throwIfAborted();
  if (failure) throw failure;
  assert.equal(code, 0, `${bin}: ${output}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

try {
  const args = process.argv.slice(2);
  assert(
    args.length === 0 || (args.length === 2 && args[0] === '--archive' && args[1]),
    'SMOKE_ARGUMENTS',
  );
  let archive = args[1] && resolve(args[1]);
  if (!archive) {
    await command('npm', ['pack', '--ignore-scripts', '--pack-destination', scratch]);
    const archives = (await readdir(scratch)).filter((name) => name.endsWith('.tgz'));
    assert.equal(archives.length, 1);
    archive = join(scratch, archives[0]!);
  }
  await command('tar', ['-xzf', archive, '-C', scratch]);
  const packed = join(scratch, 'package');
  await access(join(packed, 'dist/plugin.js'));
  await assert.rejects(access(join(packed, 'src')));
  await assert.rejects(access(join(packed, '.work')));
  await assert.rejects(access(join(packed, 'tests')));
  // Reuse the frozen installed dependency tree, never the plugin source directory.
  await symlink(join(project, 'node_modules'), join(packed, 'node_modules'), 'dir');
  const home = join(scratch, 'home');
  await prepareProfile(home, packed);
  await prepareProfile(home, packed);
  const port = await freePort();
  const token = randomBytes(32).toString('hex');
  const origin = `http://127.0.0.1:${port}`;
  const runDir = join(scratch, 'run');
  await mkdir(runDir);
  const environment = {
    PATH: process.env.PATH ?? '',
    HOME: scratch,
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(scratch, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    MIO_API_TOKEN: token,
    MIO_PORT: String(port),
    MIO_HOST: '127.0.0.1',
    ...(process.env.MIO_SMOKE_AUTH_DATABASE_URL
      ? {
          MIO_AUTH_DATABASE_URL: process.env.MIO_SMOKE_AUTH_DATABASE_URL,
          MIO_AUTH_BASE_URL: origin,
          MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
        }
      : {}),
  };
  stop.signal.throwIfAborted();
  const child = spawn(process.execPath, [launcher(), '--profile', 'mio'], {
    cwd: runDir,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-12000);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-12000);
  });
  const exit = once(child, 'exit');
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`DSH exited early: ${output}`);
      try {
        const response = await fetch(`${origin}/readyz`, {
          signal: AbortSignal.any([stop.signal, AbortSignal.timeout(500)]),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* The listener may still be starting. */
      }
      await delay(100, undefined, { signal: stop.signal });
    }
    assert(ready, `Plugin did not become ready: ${output}`);
    const request = (path: string, init?: RequestInit) =>
      fetch(`${origin}${path}`, {
        ...init,
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(3000)]),
      });
    const response = await request('/api/v1/capabilities', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      apiVersion: 'v1',
      stage: 'foundation',
      tools: [],
      sessions: false,
    });
    assert.equal((await request('/api/v1/capabilities')).status, 401);
    if (process.env.MIO_SMOKE_AUTH_DATABASE_URL) {
      const signup = await request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Smoke',
          email: `smoke-${randomUUID()}@example.test`,
          password: randomBytes(24).toString('hex'),
        }),
      });
      assert.equal(signup.status, 200);
      const cookie = signup.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const me = await request('/api/v1/me', { headers: { origin, cookie } });
      assert.equal(me.status, 200);
      const signout = await request('/api/auth/sign-out', {
        method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(signout.status, 200);
      assert.equal((await request('/api/v1/me', { headers: { origin, cookie } })).status, 401);
      console.log('PASS: authentication registration, identity and logout from packed plugin.');
    }
    child.kill('SIGTERM');
    const stopped = await Promise.race([exit.then(() => true), delay(5000, false, { ref: false })]);
    stop.signal.throwIfAborted();
    assert(stopped, `DSH did not stop gracefully: ${output}`);
    const probe = createServer();
    probe.listen(port, '127.0.0.1');
    await once(probe, 'listening');
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    console.log(
      'PASS: packed plugin, official DSH profile, isolated home, API authentication, shutdown and port release.',
    );
    console.log(
      'Scope: installed dependencies reused; no real model, browser, business persistence or production deployment.',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const stopped = await Promise.race([
        exit.then(() => true),
        delay(5000, false, { ref: false }),
      ]);
      if (!stopped) child.kill('SIGKILL');
      await exit;
    }
  }
} finally {
  clearTimeout(deadline);
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  await rm(scratch, { recursive: true, force: true });
}
