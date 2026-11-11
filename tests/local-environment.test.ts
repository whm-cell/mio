import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import {
  createLocalEnvironment,
  readLocalEnvironment,
} from '../scripts/service/local-environment.ts';
import { localWorkerEnvironment } from '../scripts/service/local-compute-environment.ts';

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
