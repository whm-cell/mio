import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  createLocalEnvironment,
  readLocalEnvironment,
} from '../../scripts/service/local-environment.ts';
import {
  localComputeKeys,
  localWorkerEnvironment,
} from '../../scripts/service/local-compute-environment.ts';
import { readAssetConfig } from '../../src/assets/config.ts';

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

it('only appends missing groups or the generation directory and preserves partial files', async () => {
  const root = await fixture();
  const file = join(root, '.env');
  const current = await readFile(file, 'utf8');
  const generationDirectory = 'MIO_GENERATIONS_DATA_DIR';
  const regressionKeys = ['MIO_LOCAL_REGRESSION_PASSWORD', 'MIO_TEST_DATABASE_URL'];
  const omitKeys = (contents: string, keys: readonly string[]) =>
    contents
      .split('\n')
      .filter((line) => !keys.includes(line.split('=', 1)[0]!))
      .join('\n');

  async function checkUpgrade(before: Buffer, keys: readonly string[]) {
    expect(await createLocalEnvironment('dev', root)).toBe('upgraded');
    const after = await readFile(file);
    expect(after.subarray(0, before.length).equals(before), 'original bytes').toBe(true);
    expect(Object.keys(parseEnv(after.subarray(before.length).toString('utf8'))).sort()).toEqual(
      [...keys].sort(),
    );
    expect(await createLocalEnvironment('dev', root)).toBe('preserved');
    expect((await readFile(file)).equals(after), 'bytes after repeated init').toBe(true);
    return after.toString('utf8');
  }

  async function checkPartial(contents: string, error: string) {
    const before = Buffer.from(contents);
    await writeFile(file, before);
    await expect(createLocalEnvironment('dev', root)).rejects.toThrow(error);
    expect((await readFile(file)).equals(before), 'bytes after rejected init').toBe(true);
  }

  const retainedDirectory = '.runtime/dev/custom-generations';
  const legacy = Buffer.from(
    [
      omitKeys(current, localComputeKeys)
        .replace(
          /^MIO_AUTH_SECRET=.*$/m,
          'MIO_AUTH_SECRET="fixture-legacy-signing-secret-kept-on-upgrade"',
        )
        .replace(/^MIO_GENERATIONS_DATA_DIR=.*$/m, `${generationDirectory}=${retainedDirectory}`),
      '# Keep this custom value and its formatting',
      'MIO_CUSTOM_NOTE = "first line\nsecond line with café # inside the value"',
    ].join('\n'),
  );
  await writeFile(file, legacy);
  const withCompute = await checkUpgrade(legacy, localComputeKeys);
  const config = await readLocalEnvironment('dev', root, {});
  expect(
    config.runtime.MIO_GENERATIONS_DATA_DIR === join(root, retainedDirectory),
    generationDirectory,
  ).toBe(true);

  const missingDirectory = Buffer.from(omitKeys(withCompute, [generationDirectory]));
  await writeFile(file, missingDirectory);
  const withDirectory = await checkUpgrade(missingDirectory, [generationDirectory]);
  const directoryConfig = await readLocalEnvironment('dev', root, {});
  expect(
    directoryConfig.runtime.MIO_GENERATIONS_DATA_DIR === join(root, '.runtime/dev/generations'),
    generationDirectory,
  ).toBe(true);
  expect(
    directoryConfig.runtime.MIO_GENERATIONS_ENABLED === undefined,
    'MIO_GENERATIONS_ENABLED',
  ).toBe(true);
  expect(directoryConfig.runtime.MIO_COMPUTE_ENABLED === undefined, 'MIO_COMPUTE_ENABLED').toBe(
    true,
  );

  await checkPartial(
    omitKeys(withDirectory, ['MIO_LOCAL_RABBITMQ_B_PASSWORD', generationDirectory]),
    'LOCAL_COMPUTE_PARTIAL',
  );

  const preRegression = Buffer.from(omitKeys(withDirectory, regressionKeys));
  await writeFile(file, preRegression);
  const preConfig = await readLocalEnvironment('dev', root, {});
  expect(preConfig.values.MIO_TEST_DATABASE_URL).toBeUndefined();
  const regUpgraded = await checkUpgrade(preRegression, regressionKeys);
  const afterReg = await readLocalEnvironment('dev', root, {});
  expect(
    afterReg.values.MIO_TEST_DATABASE_URL ===
      `postgresql://mio_regression:${afterReg.values.MIO_LOCAL_REGRESSION_PASSWORD}@127.0.0.1:55432/mio_regression_test`,
    'MIO_TEST_DATABASE_URL',
  ).toBe(true);
  expect(afterReg.runtime.MIO_TEST_DATABASE_URL).toBeUndefined();
  expect(afterReg.runtime.MIO_LOCAL_REGRESSION_PASSWORD).toBeUndefined();
  await checkPartial(
    omitKeys(regUpgraded, ['MIO_TEST_DATABASE_URL', ...localComputeKeys, generationDirectory]),
    'LOCAL_REGRESSION_PARTIAL',
  );
});

function startInitializer(root: string, pauseAt: 'read' | 'publish' | null) {
  const entry = pathToFileURL(resolve('scripts/service/local.ts')).href;
  const script = `
    import fs from 'node:fs';
    import { createHash } from 'node:crypto';
    import { once } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    import { resolve } from 'node:path';
    const { link, mkdir, readFile } = fs.promises;
    const target = resolve('.env');
    const lock = resolve('.env.init.lock');
    const pauseAt = ${JSON.stringify(pauseAt)};
    async function notify(point) {
      const proceed = pauseAt === point ? once(process, 'message') : undefined;
      process.send(point);
      await proceed;
    }
    let reportedWait = false;
    fs.promises.mkdir = async (path, ...args) => {
      try { return await mkdir(path, ...args); }
      catch (error) {
        if (!reportedWait && path === lock && error.code === 'EEXIST') {
          reportedWait = true;
          process.send('waiting');
        }
        throw error;
      }
    };
    fs.promises.readFile = async (path, ...args) => {
      const bytes = await readFile(path, ...args);
      if (path === target) await notify('read');
      return bytes;
    };
    fs.promises.link = async (before, after) => {
      if (after === target) await notify('publish');
      return link(before, after);
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(entry)}, 'dev', 'init'];
    await import(${JSON.stringify(entry)});
    process.send({ digest: createHash('sha256').update(await readFile(target)).digest('hex') });
    process.disconnect();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  let observedDigest: unknown;
  child.on('message', (message) => {
    if (typeof message === 'object' && message && 'digest' in message)
      observedDigest = message.digest;
  });
  child.stdout!.on('data', (chunk) => (output += String(chunk)));
  child.stderr!.on('data', (chunk) => (output += String(chunk)));
  const outcome = once(child, 'close').then(([code]) => ({ code, output, observedDigest }));
  return {
    child,
    firstMessage: Promise.race([
      once(child, 'message').then(([message]) => message),
      outcome.then(({ code, output }) => {
        throw new Error(`Initializer exited before handshake (${code}): ${output}`);
      }),
    ]),
    outcome,
  };
}

it.each(['legacy', 'fresh'] as const)(
  'serializes two env init processes for a %s file',
  async (mode) => {
    const root = await fixture();
    const path = join(root, '.env');
    const added = [
      ...localComputeKeys,
      'MIO_GENERATIONS_DATA_DIR',
      'MIO_LOCAL_REGRESSION_PASSWORD',
      'MIO_TEST_DATABASE_URL',
    ];
    const original = await readFile(path, 'utf8');
    const legacy = Buffer.from(
      [
        ...original.split('\n').filter((line) => !added.includes(line.split('=', 1)[0]!)),
        '# Private legacy comment with café\r\n',
      ].join('\n'),
    );
    if (mode === 'legacy') {
      await writeFile(path, legacy);
      await chmod(path, 0o700);
    } else {
      await rm(path);
    }
    const pauseAt = mode === 'legacy' ? 'read' : 'publish';
    const owner = startInitializer(root, pauseAt);
    const children = [owner];
    let digests: unknown[];
    try {
      expect(await owner.firstMessage).toBe(pauseAt);
      const waiter = startInitializer(root, null);
      children.push(waiter);
      expect(await waiter.firstMessage).toBe('waiting');
      if (mode === 'legacy') expect((await readFile(path)).equals(legacy)).toBe(true);
      else await expect(readFile(path)).rejects.toHaveProperty('code', 'ENOENT');
      owner.child.send('continue');
      const [first, second] = await Promise.all([owner.outcome, waiter.outcome]);
      expect(first).toMatchObject({
        code: 0,
        output: `dev: private configuration ${mode === 'legacy' ? 'upgraded' : 'created'}\n`,
      });
      expect(second).toMatchObject({
        code: 0,
        output: 'dev: private configuration preserved\n',
      });
      digests = [first.observedDigest, second.observedDigest];
    } finally {
      for (const { child } of children) child.kill();
      await Promise.allSettled(children.map(({ outcome }) => outcome));
    }

    const bytes = await readFile(path);
    const expectedDigest = createHash('sha256').update(bytes).digest('hex');
    expect(digests).toEqual([expectedDigest, expectedDigest]);
    const contents = bytes.toString('utf8');
    const keys = mode === 'legacy' ? added : Object.keys(parseEnv(contents));
    for (const key of keys)
      expect(contents.split('\n').filter((line) => line.startsWith(`${key}=`))).toHaveLength(1);
    const parsed = await readLocalEnvironment('dev', root, {});
    expect(parsed.values.MIO_AUTH_SECRET).toMatch(/^[a-f0-9]{64}$/);
    if (mode === 'legacy') {
      expect(bytes.subarray(0, legacy.length).equals(legacy)).toBe(true);
      expect(parsed.values.MIO_AUTH_SECRET).toEqual(parseEnv(original).MIO_AUTH_SECRET);
    }
    expect((await stat(path)).mode & 0o777).toBe(mode === 'legacy' ? 0o700 : 0o600);
  },
);

it('shares local COS settings while keeping B broker, journal and other credentials scoped', async () => {
  const root = await fixture();
  const file = join(root, '.env.test');
  const providerMasterKey = Buffer.alloc(32, 7).toString('base64');
  await writeFile(
    file,
    [
      await readFile(file, 'utf8'),
      'MIO_IMAGE_KEY_ID=test-key',
      'MIO_IMAGE_PUBLIC_KEY=public-test',
      'MIO_IMAGE_PRIVATE_KEY=private-test',
      'MIO_COS_BUCKET=test-bucket-1234',
      'MIO_COS_REGION=ap-beijing',
      'MIO_COS_SECRET_ID=shared-id',
      'MIO_COS_SECRET_KEY=shared-key',
      'MIO_COS_SESSION_TOKEN=shared-token',
      'MIO_LOCAL_COMPUTE_COS_SECRET_ID=legacy-worker-id',
      'MIO_LOCAL_COMPUTE_COS_SECRET_KEY=legacy-worker-key',
      'MIO_LOCAL_COMPUTE_COS_SESSION_TOKEN=legacy-worker-token',
      `MIO_PROVIDERS_MASTER_KEY=${providerMasterKey}`,
      'MIO_PROVIDERS_MASTER_KEY_ID=fixture-key',
      'MIO_PROVIDERS_DATABASE_URL=postgresql://local/providers',
      'MIO_ASSETS_DATABASE_URL=postgresql://local/assets',
      '',
    ].join('\n'),
  );
  const dev = await readLocalEnvironment('dev', root, {});
  const test = await readLocalEnvironment('test', root, {
    MIO_COS_SECRET_ID: 'inherited-id',
    MIO_COS_SECRET_KEY: 'inherited-key',
    MIO_COS_SESSION_TOKEN: 'inherited-token',
  });
  const worker = localWorkerEnvironment('test', test.values, test.host, root);
  expect(worker.MIO_COMPUTE_BROKER_USER).toBe('mio-test-b');
  expect(worker.MIO_COMPUTE_EXPECTED_COMMAND_USER).toBe('mio-test-a');
  expect(worker.MIO_COMPUTE_DIRECTORY).toBe(join(root, '.runtime/test/compute'));
  expect(worker.RABBITMQ_URL).toContain(`mio-test-b:${test.values.MIO_LOCAL_RABBITMQ_B_PASSWORD}@`);
  expect(test.runtime.MIO_IMAGE_KEY_ID).toBeUndefined();
  expect(test.runtime.MIO_IMAGE_PUBLIC_KEY).toBeUndefined();
  expect(test.runtime.MIO_IMAGE_PRIVATE_KEY).toBeUndefined();
  expect(worker.MIO_IMAGE_KEY_ID).toBeUndefined();
  expect(worker.MIO_IMAGE_PRIVATE_KEY).toBeUndefined();
  expect(worker.MIO_IMAGE_PUBLIC_KEY).toBeUndefined();
  const shared = {
    MIO_COS_BUCKET: 'test-bucket-1234',
    MIO_COS_REGION: 'ap-beijing',
    MIO_COS_SECRET_ID: 'shared-id',
    MIO_COS_SECRET_KEY: 'shared-key',
    MIO_COS_SESSION_TOKEN: 'shared-token',
  };
  expect(test.runtime).toMatchObject(shared);
  expect(worker).toMatchObject(shared);
  expect(test.runtime.MIO_PROVIDERS_MASTER_KEY).toBe(providerMasterKey);
  expect(test.runtime.MIO_PROVIDERS_MASTER_KEY_ID).toBe('fixture-key');
  expect(test.runtime.MIO_PROVIDERS_DATABASE_URL).toBe('postgresql://local/providers');
  for (const part of ['SECRET_ID', 'SECRET_KEY', 'SESSION_TOKEN']) {
    expect(test.runtime[`MIO_LOCAL_COMPUTE_COS_${part}`]).toBeUndefined();
    expect(worker[`MIO_LOCAL_COMPUTE_COS_${part}`]).toBeUndefined();
  }
  const missing = localWorkerEnvironment(
    'test',
    {
      ...test.values,
      MIO_COS_SECRET_ID: undefined,
      MIO_COS_SECRET_KEY: undefined,
      MIO_COS_SESSION_TOKEN: undefined,
      MIO_LOCAL_COMPUTE_COS_SECRET_ID: 'shared-id',
    },
    test.host,
    root,
  );
  expect(missing.MIO_COS_SECRET_ID).toBeUndefined();
  expect(missing.MIO_COS_SECRET_KEY).toBeUndefined();
  expect(missing.MIO_COS_SESSION_TOKEN).toBeUndefined();
  for (const key of [
    'MIO_AUTH_SECRET',
    'MIO_AUTH_DATABASE_URL',
    'MIO_ASSETS_DATABASE_URL',
    'MIO_PROVIDERS_DATABASE_URL',
    'MIO_PROVIDERS_MASTER_KEY',
    'MIO_PROVIDERS_MASTER_KEY_ID',
    'MIO_REDIS_URL',
    'MIO_LOCAL_RABBITMQ_PASSWORD',
    'MIO_LOCAL_RABBITMQ_A_PASSWORD',
    'MIO_COMPUTE_EXPECTED_RESULT_USER',
  ])
    expect(worker[key]).toBeUndefined();
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

it.each(['empty', 'omitted'] as const)(
  'honors an %s COS session token in A and B',
  async (mode) => {
    const root = await fixture();
    const file = join(root, '.env.test');
    const hasEmptyToken = mode === 'empty';
    await writeFile(
      file,
      [
        await readFile(file, 'utf8'),
        'MIO_ASSETS_DATABASE_URL=postgresql://local/assets',
        'MIO_COS_BUCKET=test-bucket-1234',
        'MIO_COS_REGION=ap-beijing',
        'MIO_COS_SECRET_ID=fixture-id',
        'MIO_COS_SECRET_KEY=fixture-key',
        ...(hasEmptyToken ? ['MIO_COS_SESSION_TOKEN='] : []),
        '',
      ].join('\n'),
    );
    const environment = await readLocalEnvironment('test', root, { PATH: process.env.PATH });
    if (hasEmptyToken) expect(() => readAssetConfig(environment.runtime)).toThrow('ASSET_CONFIG');
    else expect(readAssetConfig(environment.runtime)).toMatchObject({ secretId: 'fixture-id' });

    // Stop at the actual Worker storage constructor before opening its journal or RabbitMQ.
    const storage = `export default class {
  constructor(options) {
    process.stdout.write(Object.hasOwn(options, 'SecurityToken') ? 'COS_WITH_TOKEN' : 'COS_WITHOUT_TOKEN');
    throw new Error('fixture: stop before networking');
  }
}`;
    const trap = `import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cos-nodejs-sdk-v5')
      return { url: 'data:text/javascript;base64,${Buffer.from(storage).toString('base64')}', shortCircuit: true };
    return next(specifier, context);
  }
});`;
    const worker = localWorkerEnvironment('test', environment.values, environment.host, root);
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        `data:text/javascript;base64,${Buffer.from(trap).toString('base64')}`,
        'compute/src/main.ts',
        'start',
      ],
      { env: worker, encoding: 'utf8', timeout: 5000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stdout).toBe(hasEmptyToken ? '' : 'COS_WITHOUT_TOKEN');
    expect(worker.MIO_COS_SESSION_TOKEN).toBe(hasEmptyToken ? '' : undefined);
  },
);

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
    MIO_TEST_REDIS_URL: 'redis://inherited/development',
    MIO_TEST_LOCAL_ENVIRONMENT: 'test',
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
  await mkdir(join(root, 'scripts/service'), { recursive: true });
  await symlink(local, join(root, 'scripts/service/local.ts'));
  const capture = `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.TARGET, JSON.stringify({ args: process.argv.slice(2), environment: process.env.MIO_TEST_LOCAL_ENVIRONMENT, db: process.env.MIO_TEST_DATABASE_URL, redisUrl: process.env.MIO_TEST_REDIS_URL, redis: process.env.MIO_TEST_REDIS_SERVER, auth: process.env.MIO_AUTH_DATABASE_URL, nodeEnv: process.env.NODE_ENV }));\n`;
  await writeFile(join(root, 'pnpm'), capture, { mode: 0o700 });
  const result = await command(entry, ['local', 'tests/auth', '--reporter', 'dot']);
  expect(result.code, result.output).toBe(0);
  const captured = JSON.parse(await readFile(env.TARGET, 'utf8'));
  expect(captured).toEqual({
    args: ['test', 'tests/auth', '--reporter', 'dot'],
    environment: 'auto',
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
  await createLocalEnvironment('test', root);
  const path = join(root, '.env.test');
  const contents = await readFile(path, 'utf8');
  await writeFile(
    path,
    contents.replace(/^(MIO_TEST_DATABASE_URL=.*\/)mio_regression_test$/m, '$1mio_dev'),
  );
  const rejected = await command(local, ['test', 'check', 'tests/auth']);
  expect(rejected.code).not.toBe(0);
  expect(rejected.output).toContain('LOCAL_REGRESSION_TARGET');
  await expect(readFile(env.TARGET)).rejects.toThrow();

  await writeFile(path, contents);
  const explicit = await command(local, ['test', 'check', 'tests/auth']);
  expect(explicit.code, explicit.output).toBe(0);
  expect(JSON.parse(await readFile(env.TARGET, 'utf8'))).toEqual({
    args: ['test', 'tests/auth'],
    environment: 'test',
    redis: '/isolated/redis-server',
  });
}, 30000);

it('uses reachable PostgreSQL and Redis channels independently in the local validation entry', async () => {
  const root = await fixture();
  const entry = 'scripts/harness/validation-entry.ts';
  const local = 'scripts/service/local.ts';
  const scope = 'tests/probe/environment.test.ts';
  const marker = join(root, 'target.json');
  for (const directory of ['scripts/harness', 'scripts/service', 'tests/probe', 'compute/tests'])
    await mkdir(join(root, directory), { recursive: true });
  for (const file of [entry, local, 'node_modules']) await symlink(resolve(file), join(root, file));
  await writeFile(
    join(root, 'pnpm'),
    `#!${process.execPath}\nconst { spawnSync } = require('node:child_process');\nconst result = spawnSync(process.execPath, [${JSON.stringify(entry)}, ...process.argv.slice(2)], { stdio: 'inherit' });\nprocess.exitCode = result.status ?? 1;\n`,
    { mode: 0o700 },
  );
  await writeFile(
    join(root, scope),
    `import { writeFileSync } from 'node:fs';\nimport { it } from 'vitest';\nit('records test targets', () => writeFileSync(process.env.MARKER, JSON.stringify({ pg: process.env.MIO_TEST_DATABASE_URL ?? null, redis: process.env.MIO_TEST_REDIS_URL ?? null, auth: process.env.MIO_AUTH_DATABASE_URL, selection: process.env.MIO_TEST_LOCAL_ENVIRONMENT, nodeEnv: process.env.NODE_ENV })));\n`,
  );
  const listeners = Array.from({ length: 4 }, () => createServer());
  const close = (server: (typeof listeners)[number]) =>
    new Promise<void>((done) => server.close(() => done()));
  const base = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    GITHUB_ACTIONS: '',
    MARKER: marker,
  };
  const inherited = {
    ...base,
    MIO_TEST_DATABASE_URL: 'postgresql://inherited.example.invalid/mio_dev',
    MIO_TEST_REDIS_URL: 'redis://inherited.example.invalid',
    MIO_AUTH_DATABASE_URL: 'postgresql://inherited.example.invalid/mio_dev',
    MIO_TEST_LOCAL_ENVIRONMENT: 'test',
    NODE_ENV: 'development',
  };
  async function runProbe(script: string, args: string[], env: NodeJS.ProcessEnv = inherited) {
    await rm(marker, { force: true });
    const child = spawn(process.execPath, [script, ...args, scope], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    return { code: (await once(child, 'close'))[0], output };
  }
  async function probe(script: string, args: string[], env?: NodeJS.ProcessEnv) {
    const result = await runProbe(script, args, env);
    expect(result.code, result.output).toBe(0);
    return JSON.parse(await readFile(marker, 'utf8'));
  }
  try {
    const ports = await Promise.all(
      listeners.map(async (listener) => {
        listener.listen(0, '127.0.0.1');
        await once(listener, 'listening');
        const address = listener.address();
        if (!address || typeof address === 'string') throw new Error('missing fixture port');
        return address.port;
      }),
    );
    for (const [file, pg, redis, oldPg, oldRedis] of [
      ['.env', ports[0]!, ports[1]!, 55432, 56379],
      ['.env.test', ports[2]!, ports[3]!, 55433, 56380],
    ] as const) {
      const path = join(root, file);
      const contents = await readFile(path, 'utf8');
      await writeFile(
        path,
        contents
          .replace(`MIO_LOCAL_POSTGRES_PORT=${oldPg}\n`, `MIO_LOCAL_POSTGRES_PORT=${pg}\n`)
          .replaceAll(`@127.0.0.1:${oldPg}/`, `@127.0.0.1:${pg}/`)
          .replace(`MIO_LOCAL_REDIS_PORT=${oldRedis}\n`, `MIO_LOCAL_REDIS_PORT=${redis}\n`)
          .replaceAll(`@127.0.0.1:${oldRedis}\n`, `@127.0.0.1:${redis}\n`),
      );
    }
    const dev = (await readLocalEnvironment('dev', root, {})).values;
    const test = (await readLocalEnvironment('test', root, {})).values;
    const devRedis = `redis://mio_regression:${dev.MIO_LOCAL_REGRESSION_PASSWORD}@127.0.0.1:${ports[1]}`;
    const testRedis = `redis://mio_regression:${test.MIO_LOCAL_REGRESSION_PASSWORD}@127.0.0.1:${ports[3]}`;
    const available = { pg: dev.MIO_TEST_DATABASE_URL, redis: devRedis, nodeEnv: 'test' };
    expect(await probe(entry, ['local'])).toEqual(available);

    await close(listeners[1]!);
    await close(listeners[2]!);
    const mixed = { ...available, redis: testRedis };
    expect(await probe(entry, ['local'])).toEqual(mixed);
    expect(
      await probe(entry, ['test'], {
        ...base,
        MIO_TEST_DATABASE_URL: '',
        MIO_TEST_REDIS_URL: '',
        MIO_TEST_LOCAL_ENVIRONMENT: undefined,
        MIO_AUTH_DATABASE_URL: undefined,
        NODE_ENV: 'test',
      }),
    ).toMatchObject(mixed);
    expect(await probe(local, ['dev', 'check'])).toEqual({ ...mixed, redis: null });
    expect(await probe(local, ['test', 'check'])).toEqual({ ...mixed, pg: null });

    const testFile = join(root, '.env.test');
    const configuration = await readFile(testFile, 'utf8');
    await writeFile(
      testFile,
      configuration.replace(/^MIO_AUTH_DATABASE_URL=.*$/m, 'MIO_AUTH_DATABASE_URL=invalid'),
    );
    expect(await probe(entry, ['local'])).toEqual(mixed);
    const badApplicationConfig = await runProbe(local, ['test', 'check']);
    expect(badApplicationConfig.code).not.toBe(0);
    expect(badApplicationConfig.output).toContain('LOCAL_ENV_TARGET');

    await close(listeners[0]!);
    expect(await probe(entry, ['local'])).toEqual({ ...mixed, pg: null });
    await close(listeners[3]!);
    expect(await probe(entry, ['local'])).toEqual({ ...mixed, pg: null, redis: null });

    await writeFile(
      testFile,
      configuration.replace(/^(MIO_TEST_DATABASE_URL=.*\/)mio_regression_test$/m, '$1mio_dev'),
    );
    const badRegressionTarget = await runProbe(entry, ['local']);
    expect(badRegressionTarget.code).not.toBe(0);
    expect(badRegressionTarget.output).toContain('LOCAL_REGRESSION_TARGET');
    await expect(readFile(marker)).rejects.toThrow();

    await writeFile(testFile, configuration);
    await chmod(testFile, 0o644);
    const publicConfig = await runProbe(entry, ['local']);
    expect(publicConfig.code).not.toBe(0);
    expect(publicConfig.output).toContain('LOCAL_ENV_FILE');
    await expect(readFile(marker)).rejects.toThrow();
  } finally {
    await Promise.all(listeners.map(close));
  }
}, 30000);

it('runs a generation-only environment without B or RabbitMQ and preserves the recovery directory', async () => {
  const root = await fixture();
  const file = join(root, '.env');
  const current = await readFile(file, 'utf8');
  const independent = current
    .split('\n')
    .filter((line) => !/^(RABBITMQ_|MIO_(LOCAL_RABBITMQ|LOCAL_COMPUTE|COMPUTE)_)/.test(line))
    .join('\n');
  await writeFile(
    file,
    `${independent}\nMIO_GENERATIONS_ENABLED=true\nMIO_PROVIDERS_MASTER_KEY=provider-master\n`,
  );
  const config = await readLocalEnvironment('dev', root, {});
  expect(config.runtime.MIO_GENERATIONS_ENABLED).toBe('true');
  expect(config.runtime.MIO_GENERATIONS_DATA_DIR).toBe(join(root, '.runtime/dev/generations'));
  expect(config.runtime.MIO_PROVIDERS_MASTER_KEY).toBe('provider-master');
  expect(config.runtime.RABBITMQ_URL).toBeUndefined();
  expect(config.runtime.MIO_COMPUTE_ENABLED).toBeUndefined();
  expect(() => localWorkerEnvironment('dev', config.values, config.host, root)).toThrow(
    'LOCAL_BROKER_SECRET',
  );
  await writeFile(file, `${independent}\nMIO_COMPUTE_ENABLED=true\n`);
  await expect(readLocalEnvironment('dev', root, {})).rejects.toThrow('LOCAL_BROKER_SECRET');
});
