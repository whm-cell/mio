import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launcher, prepareProfile } from '../../scripts/service/profile.ts';

/** Real official Profile, packed dist only, fixed port/secret/DB across controlled stops. */
export async function packedAuthRuntime(
  databaseURL: string,
  redisURL: string,
  namespace: string,
  options: {
    conversations?: boolean;
    modelFixture?: boolean;
    onelinkFixture?: boolean;
    providerMasterKey?: string;
    providerKeyId?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'mio-redis-profile-'));
  const command = (bin: string, args: string[]) => {
    const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  const stage = join(directory, 'stage');
  await mkdir(stage);
  for (const path of ['package.json', 'cordis.patch.yml', 'README.md', 'AGENTS.md', 'docs'])
    await cp(resolve(path), join(stage, path), { recursive: true });
  // Existing auth tests build their own project dist. This fixture never writes or packs it.
  command(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '-p',
    'tsconfig.build.json',
    '--outDir',
    join(stage, 'dist'),
  ]);
  command('npm', ['pack', stage, '--ignore-scripts', '--pack-destination', directory]);
  const [archive] = (await readdir(directory)).filter((file) => file.endsWith('.tgz'));
  assert(archive);
  command('tar', ['-xzf', join(directory, archive), '-C', directory]);
  const packed = join(directory, 'package');
  await symlink(resolve('node_modules'), join(packed, 'node_modules'), 'dir');
  const home = join(directory, 'home');
  await prepareProfile(home, packed);
  const observationsPath = join(directory, 'model-fixture/requests.jsonl');
  if (options.modelFixture || options.onelinkFixture) {
    const fixture = join(directory, 'model-fixture');
    await mkdir(fixture);
    await cp(
      resolve(
        options.onelinkFixture
          ? 'tests/onelink/profile-plugin.ts'
          : 'tests/conversations/conversations-model-plugin.ts',
      ),
      join(fixture, 'index.ts'),
    );
    if (options.onelinkFixture)
      await cp(resolve('tests/onelink/fixture.ts'), join(fixture, 'fixture.ts'));
    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({ name: '@mio/test-provider', type: 'module', exports: './index.ts' }),
    );
    await symlink(resolve('node_modules'), join(fixture, 'node_modules'), 'dir');
    await symlink(fixture, join(home, 'profiles/mio/node_modules/@mio/test-provider'), 'dir');
    await writeFile(
      join(home, 'profiles/mio/cordis.patch.yml'),
      JSON.stringify([{ insert: [{ id: 'test-provider', name: '@mio/test-provider' }] }]),
    );
  }
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${address.port}`;
  const secret = randomBytes(40).toString('hex');
  const run = join(directory, 'run');
  await mkdir(run);
  let child: ChildProcess | undefined;
  let output = '';
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    const graceful = await Promise.race([
      exit.then(() => true),
      delay(5000, false, { ref: false }),
    ]);
    if (!graceful) {
      child.kill('SIGKILL');
      await exit;
    }
    assert(graceful, `Profile failed to stop gracefully: ${output}`);
  };
  return {
    origin,
    nativeLogRoot: join(home, 'sessions'),
    async onelinkPaused() {
      return readFile(join(directory, 'model-fixture/paused'), 'utf8').then(
        () => true,
        () => false,
      );
    },
    async releaseOnelink() {
      await writeFile(join(directory, 'model-fixture/release'), 'release');
    },
    async setOnelinkCatalog(ids: string[]) {
      await writeFile(join(directory, 'model-fixture/catalog.json'), JSON.stringify(ids));
    },
    async onelinkRequests(): Promise<
      { authorization: string | null; path: string; body: Record<string, unknown> }[]
    > {
      const data = await readFile(observationsPath, 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        },
      );
      return data
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    async start(backend: 'database' | 'redis') {
      assert(
        !child || child.exitCode !== null || child.signalCode !== null,
        'Old Profile must stop first',
      );
      output = '';
      child = spawn(process.execPath, [launcher(), '--profile', 'mio'], {
        cwd: run,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: directory,
          DSH_HOME: home,
          DSH_AGENTS_HOME: join(directory, 'agents'),
          DSH_TELEMETRY_DISABLED: '1',
          MIO_API_TOKEN: secret,
          MIO_HOST: '127.0.0.1',
          MIO_PORT: String(address.port),
          MIO_AUTH_BASE_URL: origin,
          MIO_AUTH_SECRET: secret,
          MIO_AUTH_DATABASE_URL: databaseURL,
          MIO_AUTH_RATE_LIMIT_BACKEND: backend,
          MIO_REDIS_URL: redisURL,
          MIO_REDIS_NAMESPACE: namespace,
          ...(options.conversations ? { MIO_CONVERSATIONS_DATABASE_URL: databaseURL } : {}),
          ...(options.providerMasterKey
            ? {
                MIO_PROVIDERS_DATABASE_URL: databaseURL,
                MIO_PROVIDERS_MASTER_KEY: options.providerMasterKey,
                MIO_PROVIDERS_MASTER_KEY_ID: options.providerKeyId ?? 'profile-test-key',
              }
            : {}),
          ...(options.modelFixture
            ? { MIO_MODEL_PROVIDER: 'mio-test-only', MIO_MODEL: 'scripted' }
            : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout!.on('data', (data: Buffer) => {
        output = (output + data).slice(-12000);
      });
      child.stderr!.on('data', (data: Buffer) => {
        output = (output + data).slice(-12000);
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        assert(child.exitCode === null && child.signalCode === null, `Profile exited: ${output}`);
        try {
          if (
            (await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(200) })).status === 200
          )
            return;
        } catch {
          /* listener not ready yet */
        }
        await delay(100);
      }
      throw new Error(`Profile not ready: ${output}`);
    },
    stop,
    async crash() {
      assert(child && child.exitCode === null && child.signalCode === null);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    },
    async close() {
      try {
        await stop();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
