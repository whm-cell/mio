import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import {
  createLocalEnvironment,
  readLocalEnvironment,
} from '../../scripts/service/local-environment.ts';
import { localWorkerEnvironment } from '../../scripts/service/local-compute-environment.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mio-local-environments-'));
  directories.push(root);
  await createLocalEnvironment('dev', root);
  await createLocalEnvironment('test', root);
  return root;
}

it('keeps credentials across initialization and separates persistent environment identities', async () => {
  const root = await fixture();
  const original = await readFile(join(root, '.env'));
  expect(await createLocalEnvironment('dev', root)).toBe('preserved');
  expect(await readFile(join(root, '.env'))).toEqual(original);
  expect((await stat(join(root, '.env'))).mode & 0o777).toBe(0o600);
  const dev = await readLocalEnvironment('dev', root, {});
  const test = await readLocalEnvironment('test', root, {});
  for (const key of [
    'MIO_AUTH_SECRET',
    'MIO_API_TOKEN',
    'MIO_AUTH_DATABASE_URL',
    'MIO_REDIS_URL',
    'DSH_HOME',
    'RABBITMQ_URL',
  ])
    expect(dev.runtime[key as keyof typeof dev.runtime]).not.toBe(
      test.runtime[key as keyof typeof test.runtime],
    );
  expect(dev.runtime.DSH_HOME).toBe(join(root, '.runtime/dev/dsh'));
  expect(test.runtime.DSH_AGENTS_HOME).toBe(join(root, '.runtime/test/dsh/agents'));
});

it('does not inherit another environment or expose middleware administrator credentials to the app', async () => {
  const root = await fixture();
  const env = await readLocalEnvironment('test', root, {
    PATH: '/test/path',
    MIO_AUTH_DATABASE_URL: 'postgresql://wrong/development',
    MIO_PROVIDERS_DATABASE_URL: 'postgresql://wrong/development',
    DSH_HOME: '/wrong/development',
    RABBITMQ_URL: 'amqp://wrong',
    PGDATABASE: 'development',
    COMPOSE_PROJECT_NAME: 'mio-dev',
    NODE_ENV: 'development',
  });
  expect(env.runtime.PATH).toBe('/test/path');
  expect(env.runtime.MIO_AUTH_DATABASE_URL).toBe(env.values.MIO_AUTH_DATABASE_URL);
  expect(env.runtime.MIO_PROVIDERS_DATABASE_URL).toBeUndefined();
  expect(env.runtime.RABBITMQ_URL).toBe(env.values.RABBITMQ_URL);
  expect(env.runtime.MIO_LOCAL_RABBITMQ_PASSWORD).toBeUndefined();
  expect(env.runtime.MIO_LOCAL_RABBITMQ_B_PASSWORD).toBeUndefined();
  expect(env.runtime.MIO_LOCAL_COMPUTE_INSTANCE_ID).toBeUndefined();
  expect(env.runtime.MIO_LOCAL_POSTGRES_PASSWORD).toBeUndefined();
  expect(env.runtime.MIO_TEST_DATABASE_URL).toBeUndefined();
  expect(env.host.PGDATABASE).toBeUndefined();
  expect(env.host.COMPOSE_PROJECT_NAME).toBeUndefined();
  expect(env.runtime.NODE_ENV).toBe('production');
});

it('upgrades pre-MQ files without changing old secrets, and rejects partial identities', async () => {
  const root = await fixture();
  const file = join(root, '.env');
  const current = await readFile(file, 'utf8');
  const legacy = current
    .split('\n')
    .filter((line) => !/^(RABBITMQ_|MIO_(LOCAL_RABBITMQ|LOCAL_COMPUTE|COMPUTE)_)/.test(line))
    .join('\n');
  await writeFile(file, legacy);
  expect(await createLocalEnvironment('dev', root)).toBe('upgraded');
  const upgraded = await readFile(file, 'utf8');
  expect(upgraded.startsWith(legacy)).toBe(true);
  const config = await readLocalEnvironment('dev', root, {});
  expect(await createLocalEnvironment('dev', root)).toBe('preserved');
  expect(await readFile(file, 'utf8')).toBe(upgraded);
  await writeFile(file, upgraded.replace(/^MIO_LOCAL_RABBITMQ_B_PASSWORD=.*\n/m, ''));
  await expect(createLocalEnvironment('dev', root)).rejects.toThrow('LOCAL_COMPUTE_PARTIAL');
  expect(
    (await readFile(file, 'utf8')).includes(config.values.MIO_LOCAL_RABBITMQ_A_PASSWORD!),
  ).toBe(true);
});

it('gives B only its own environment identity and rejects a swapped broker or journal', async () => {
  const root = await fixture();
  const dev = await readLocalEnvironment('dev', root, {});
  const test = await readLocalEnvironment('test', root, {});
  const worker = localWorkerEnvironment('test', test.values, test.host, root);
  expect(worker.MIO_COMPUTE_BROKER_USER).toBe('mio-test-b');
  expect(worker.MIO_COMPUTE_EXPECTED_COMMAND_USER).toBe('mio-test-a');
  expect(worker.MIO_COMPUTE_DIRECTORY).toBe(join(root, '.runtime/test/compute'));
  expect(worker.RABBITMQ_URL).toContain(`mio-test-b:${test.values.MIO_LOCAL_RABBITMQ_B_PASSWORD}@`);
  for (const key of [
    'MIO_AUTH_SECRET',
    'MIO_AUTH_DATABASE_URL',
    'MIO_REDIS_URL',
    'MIO_LOCAL_RABBITMQ_PASSWORD',
    'MIO_LOCAL_RABBITMQ_A_PASSWORD',
    'MIO_COMPUTE_EXPECTED_RESULT_USER',
  ])
    expect(worker[key]).toBeUndefined();
  const file = join(root, '.env.test');
  const original = await readFile(file, 'utf8');
  for (const key of [
    'RABBITMQ_URL',
    'MIO_LOCAL_COMPUTE_DIRECTORY',
    'MIO_LOCAL_COMPUTE_INSTANCE_ID',
  ]) {
    await writeFile(
      file,
      original.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${dev.values[key]}`),
    );
    await expect(readLocalEnvironment('test', root, {})).rejects.toThrow('LOCAL_COMPUTE_IDENTITY');
  }
});

it('rejects a swapped file or cross-environment connection before starting a service or migration', async () => {
  const root = await fixture();
  const dev = await readFile(join(root, '.env'), 'utf8');
  const testPath = join(root, '.env.test');
  const test = await readFile(testPath, 'utf8');
  await writeFile(testPath, dev);
  await expect(readLocalEnvironment('test', root, {})).rejects.toThrow('LOCAL_ENV_IDENTITY');
  const devConfig = await readLocalEnvironment('dev', root, {});
  await writeFile(
    testPath,
    test.replace(
      /^MIO_AUTH_DATABASE_URL=.*$/m,
      `MIO_AUTH_DATABASE_URL=${devConfig.values.MIO_AUTH_DATABASE_URL}`,
    ),
  );
  await expect(readLocalEnvironment('test', root, {})).rejects.toThrow('LOCAL_ENV_TARGET');
  await rm(testPath);
  await expect(readLocalEnvironment('test', root, {})).rejects.toThrow();
});

it('returns failure when an infrastructure command is cancelled even if the child exits zero', async () => {
  const root = await fixture();
  await writeFile(
    join(root, 'docker'),
    `#!${process.execPath}\nprocess.on('SIGTERM', () => process.exit(0));\nconsole.log('ready');\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o700 },
  );
  const child = spawn(
    process.execPath,
    [resolve('scripts/service/local.ts'), 'dev', 'infra', 'up'],
    {
      cwd: root,
      env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    const result = once(child, 'close');
    await once(child.stdout, 'data');
    child.kill('SIGTERM');
    expect((await result)[0]).not.toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
});

it('can initialize environments and start middleware before compute contracts are built', async () => {
  const root = await fixture();
  const hook = join(root, 'unbuilt-contracts.mjs');
  await writeFile(
    hook,
    `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@mio/compute-contracts') throw new Error('PROTOCOL_NOT_BUILT');
  return next(specifier, context);
} });\n`,
  );
  await writeFile(join(root, 'docker'), `#!${process.execPath}\nprocess.exit(0);\n`, {
    mode: 0o700,
  });
  for (const args of [
    ['dev', 'init'],
    ['test', 'infra', 'up'],
  ]) {
    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(hook).href, resolve('scripts/service/local.ts'), ...args],
      {
        cwd: root,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    expect((await once(child, 'close'))[0], stderr).toBe(0);
  }
});

it('requires a scope before reading the test environment and preserves isolated regression settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mio-local-check-'));
  directories.push(root);
  const entry = resolve('scripts/harness/validation-entry.ts');
  const local = resolve('scripts/service/local.ts');
  const env = {
    ...process.env,
    GITHUB_ACTIONS: '',
    PATH: `${root}:${process.env.PATH}`,
    TARGET: join(root, 'captured.json'),
    MIO_AUTH_DATABASE_URL: 'postgresql://inherited/development',
    MIO_TEST_DATABASE_URL: 'postgresql://inherited/development',
    MIO_TEST_REDIS_SERVER: '/isolated/redis-server',
    NODE_ENV: 'development',
  };
  async function command(script: string, args: string[]) {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    return { code: (await once(child, 'close'))[0], output };
  }
  for (const [script, args] of [
    [entry, ['local']],
    [entry, ['local', '--reporter', 'tests/auth']],
    [local, ['test', 'check']],
  ] as const) {
    const result = await command(script, [...args]);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('SCOPE');
    expect(result.output).not.toContain('ENOENT');
  }
  await createLocalEnvironment('test', root);
  await mkdir(join(root, 'scripts/service'), { recursive: true });
  await symlink(local, join(root, 'scripts/service/local.ts'));
  const capture = `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.TARGET, JSON.stringify({ args: process.argv.slice(2), db: process.env.MIO_TEST_DATABASE_URL, redis: process.env.MIO_TEST_REDIS_SERVER, auth: process.env.MIO_AUTH_DATABASE_URL, nodeEnv: process.env.NODE_ENV }));\n`;
  await writeFile(join(root, 'pnpm'), capture, { mode: 0o700 });
  const result = await command(entry, ['local', 'tests/auth', '--reporter', 'dot']);
  expect(result.code, result.output).toBe(0);
  const captured = JSON.parse(await readFile(env.TARGET, 'utf8'));
  const values = (await readLocalEnvironment('test', root, {})).values;
  expect(captured).toEqual({
    args: ['test', 'tests/auth', '--reporter', 'dot'],
    db: values.MIO_TEST_DATABASE_URL,
    redis: '/isolated/redis-server',
  });
  await rm(env.TARGET);
  await writeFile(
    join(root, 'pnpm'),
    `#!${process.execPath}\nprocess.on('SIGTERM', () => process.exit(0));\nconsole.log('READY');\nsetInterval(() => {}, 1000);\n`,
  );
  const child = spawn(process.execPath, [entry, 'local', 'tests/auth'], {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const finished = once(child, 'close');
  try {
    await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
    const exited = once(child, 'close', { signal: AbortSignal.timeout(10000) });
    child.kill('SIGTERM');
    await exited;
    expect((await finished)[0]).not.toBe(0);
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await finished;
      await expect
        .poll(() => {
          try {
            process.kill(-child.pid!, 0);
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            return true;
          }
        })
        .toBe(true);
    }
  }
  await writeFile(join(root, 'pnpm'), capture);
  const path = join(root, '.env.test');
  const contents = await readFile(path, 'utf8');
  await writeFile(
    path,
    contents.replace(/^MIO_TEST_DATABASE_URL=.*$/m, 'MIO_TEST_DATABASE_URL=wrong'),
  );
  const rejected = await command(entry, ['local', 'tests/auth']);
  expect(rejected.code).not.toBe(0);
  expect(rejected.output).toContain('LOCAL_REGRESSION_TARGET');
  await expect(readFile(env.TARGET)).rejects.toThrow();
}, 30000);
