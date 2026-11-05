import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launcher, prepareProfile } from './profile.ts';

const project = resolve('.');
const scratch = await mkdtemp(join(tmpdir(), 'mio-packed-'));

function command(bin: string, args: string[]): void {
  const result = spawnSync(bin, args, { cwd: project, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, `${bin}: ${result.stderr}\n${result.stdout}`);
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
  command('npm', ['pack', '--ignore-scripts', '--pack-destination', scratch]);
  const archives = (await readdir(scratch)).filter((name) => name.endsWith('.tgz'));
  assert.equal(archives.length, 1);
  command('tar', ['-xzf', join(scratch, archives[0]!), '-C', scratch]);
  const packed = join(scratch, 'package');
  await assert.rejects(access(join(packed, 'src')));
  await assert.rejects(access(join(packed, '.work')));
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
  };
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
        const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* The listener may still be starting. */
      }
      await delay(100);
    }
    assert(ready, `Plugin did not become ready: ${output}`);
    const response = await fetch(`${origin}/api/v1/capabilities`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      apiVersion: 'v1',
      stage: 'foundation',
      tools: [],
      sessions: false,
    });
    assert.equal((await fetch(`${origin}/api/v1/capabilities`)).status, 401);
    child.kill('SIGTERM');
    const stopped = await Promise.race([exit.then(() => true), delay(5000).then(() => false)]);
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
      child.kill('SIGKILL');
      await exit;
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
