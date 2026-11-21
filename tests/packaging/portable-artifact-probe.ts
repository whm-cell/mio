import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { portableComponent, portableRoot } from './portable-root.ts';

const root = portableRoot(process.argv[2]);
const a = portableComponent(root, 'a');
const b = portableComponent(root, 'b');
const host = portableComponent(root, 'host');
for (const artifact of [a, b]) {
  const script = `for (const entry of ['logging','errors','http-status','time','identifiers','hash']) {
    const loaded = await import('@mio/foundation/' + entry);
    if (!Object.keys(loaded).length) throw new Error('EMPTY_FOUNDATION_ENTRY');
  }`;
  const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: artifact,
    encoding: 'utf8',
    timeout: 30000,
  });
  if (loaded.status !== 0) throw new Error('PORTABLE_FOUNDATION_LOAD_FAILED');
}
console.log('PORTABLE_FOUNDATION_ENTRIES_OK');
const hostPackage = JSON.parse(
  await readFile(join(host, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'),
) as { version: string };
assert.equal(hostPackage.version, '0.2.2-rc.1');
const state = join(root, 'smoke-state');
await mkdir(state, { mode: 0o700 });
const home = join(state, 'home');
const profileTool = join(a, 'dist/tools/scripts/service/prepare-profile.js');
for (let i = 0; i < 2; i++) {
  const prepared = spawnSync(process.execPath, [profileTool, home, a], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
  });
  if (prepared.status !== 0) throw new Error('PORTABLE_PROFILE_PREPARE_FAILED');
}
const server = createServer();
await new Promise<void>((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('PORTABLE_PORT_MISSING');
const port = address.port;
await new Promise<void>((resolveClose, reject) =>
  server.close((error) => (error ? reject(error) : resolveClose())),
);
const common = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  LANG: process.env.LANG ?? 'C',
};
const workerDirectory = join(state, 'worker');
await mkdir(workerDirectory, { mode: 0o700 });
const initialized = spawnSync(process.execPath, [join(b, 'dist/main.js'), 'init'], {
  cwd: root,
  env: { ...common, MIO_COMPUTE_DIRECTORY: workerDirectory, MIO_COMPUTE_INSTANCE_ID: randomUUID() },
  encoding: 'utf8',
  timeout: 30000,
});
if (initialized.status !== 0) throw new Error('PORTABLE_WORKER_INIT_FAILED');
const token = randomBytes(32).toString('hex');
const log = openSync(join(state, 'dsh.log'), 'a', 0o600);
let child;
try {
  child = spawn(
    process.execPath,
    [join(host, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'mio'],
    {
      cwd: root,
      env: {
        ...common,
        HOME: state,
        DSH_HOME: home,
        DSH_AGENTS_HOME: join(state, 'agents'),
        DSH_TELEMETRY_DISABLED: '1',
        MIO_API_TOKEN: token,
        MIO_HOST: '127.0.0.1',
        MIO_PORT: String(port),
      },
      stdio: ['ignore', log, log],
    },
  );
} finally {
  closeSync(log);
}
const exited = new Promise<void>((resolveExit) => child.once('close', () => resolveExit()));
let childError: Error | undefined;
child.on('error', (error) => {
  childError ??= error;
});
let probeError: unknown;
let shutdownTimedOut = false;
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (childError) throw childError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('PORTABLE_DSH_EXITED');
    try {
      if (
        (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) })).ok
      ) {
        ready = true;
        break;
      }
    } catch {
      /* Waiting for the isolated listener. */
    }
    await delay(100);
  }
  if (!ready) throw new Error('PORTABLE_DSH_NOT_READY');
  const capabilities = await fetch(`http://127.0.0.1:${port}/api/v1/capabilities`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(capabilities.status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/capabilities`)).status, 401);
} catch (error) {
  probeError = error;
} finally {
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const deadline = new AbortController();
    try {
      const stopped = await Promise.race([
        exited.then(() => true),
        delay(10000, false, { signal: deadline.signal }),
      ]);
      if (!stopped) {
        shutdownTimedOut = true;
        child.kill('SIGKILL');
      }
    } finally {
      deadline.abort();
    }
  }
  await exited;
}
if (shutdownTimedOut) throw new Error('PORTABLE_DSH_STILL_STOPPING', { cause: probeError });
if (probeError !== undefined) throw probeError;
if (childError) throw childError;
console.log('PORTABLE_DSH_PLUGIN_AND_WORKER_INIT_OK');
