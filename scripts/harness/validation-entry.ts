import { spawn } from 'node:child_process';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const [action, ...args] = process.argv.slice(2);
const allowedOptions = new Set([
  '--',
  'run',
  'color',
  'testNamePattern',
  't',
  'reporter',
  'outputFile',
  'silent',
  'hideSkippedTests',
  'maxWorkers',
  'maxConcurrency',
  'fileParallelism',
  'testTimeout',
  'hookTimeout',
  'bail',
  'retry',
]);

async function run(binary: string, argv: string[]) {
  const child = spawn(binary, argv, { stdio: 'inherit' });
  let cancelled = false;
  const interrupt = () => {
    cancelled = true;
    child.kill('SIGINT');
  };
  const terminate = () => {
    cancelled = true;
    child.kill('SIGTERM');
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    const code = await new Promise<number | null>((ok, fail) => {
      child.once('error', fail);
      child.once('exit', ok);
    });
    if (cancelled || code !== 0) process.exitCode = code || 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

function within(path: string, root: string) {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function existingCanonicalPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function runCiGroup(groupArgs: string[]) {
  if (process.env.GITHUB_ACTIONS !== 'true')
    throw new Error('CHECK_CI_ONLY: ci-group runs in GitHub Actions');
  const [group, ...extra] = groupArgs;
  if (extra.length > 0 || (group !== 'harness' && group !== 'service'))
    throw new Error('CI_GROUP: expected exactly one group: harness or service');
  if (!process.env.MIO_TEST_DATABASE_URL) delete process.env.MIO_TEST_DATABASE_URL;
  if (!process.env.MIO_TEST_REDIS_URL) delete process.env.MIO_TEST_REDIS_URL;
  process.env.TEST = 'true';
  process.env.VITEST = 'true';
  process.env.NODE_ENV ??= 'test';
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', { watch: false });
  try {
    const specifications = await vitest.globTestSpecifications();
    const harnessRoots = (
      await Promise.all(
        ['tests/harness', 'tests/environment'].map((dir) => existingCanonicalPath(resolve(dir))),
      )
    ).filter((dir): dir is string => dir !== null);
    const entries = await Promise.all(
      specifications.map(async (specification) => ({
        specification,
        canonical: await realpath(specification.moduleId),
      })),
    );
    entries.sort((left, right) => left.canonical.localeCompare(right.canonical));
    const seen = new Set<string>();
    const harness: typeof specifications = [];
    const service: typeof specifications = [];
    for (const { specification, canonical } of entries) {
      const key = `${specification.project.name}:${canonical}`;
      if (seen.has(key)) throw new Error(`CI_GROUP: duplicate test specification: ${canonical}`);
      seen.add(key);
      if (harnessRoots.some((root) => within(canonical, root))) harness.push(specification);
      else service.push(specification);
    }
    if (harness.length + service.length !== specifications.length)
      throw new Error('CI_GROUP: partition size mismatch');
    const selected = group === 'harness' ? harness : service;
    const complement = group === 'harness' ? service : harness;
    if (!selected.length) throw new Error(`CI_GROUP: no tests found for group ${group}`);
    console.log(
      JSON.stringify({
        group,
        selected: selected.length,
        complement: complement.length,
        total: specifications.length,
      }),
    );
    await vitest.standalone();
    await vitest.runTestSpecifications(selected);
  } finally {
    await vitest.close();
  }
}

type LocalRegressionCandidate = {
  file: string;
  hasRegressionKeys: boolean;
  validUrl: string | null;
  port: number | null;
  redisUrl: string | null;
  redisPort: number | null;
};

async function inspectLocalRegression(
  name: 'dev' | 'test',
  strictConfig: boolean,
): Promise<LocalRegressionCandidate | undefined> {
  const file = name === 'dev' ? '.env' : '.env.test';
  const path = resolve(file);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    if (strictConfig)
      throw new Error(`LOCAL_ENV_FILE: ${file} must be a private regular file (chmod 600)`);
    return;
  }
  const values = parseEnv(await readFile(path, 'utf8'));
  const port = Number(values.MIO_LOCAL_POSTGRES_PORT);
  const validPort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
  const rawRedisPort = Number(values.MIO_LOCAL_REDIS_PORT);
  const validRedisPort =
    Number.isInteger(rawRedisPort) && rawRedisPort >= 1024 && rawRedisPort <= 65535
      ? rawRedisPort
      : null;
  const hasRegressionKeys =
    values.MIO_LOCAL_REGRESSION_PASSWORD !== undefined ||
    values.MIO_TEST_DATABASE_URL !== undefined;
  if (
    strictConfig &&
    hasRegressionKeys &&
    values.MIO_LOCAL_REDIS_PORT !== undefined &&
    validRedisPort === null
  )
    throw new Error(`LOCAL_REGRESSION_TARGET: invalid regression Redis port in ${file}`);
  const password = values.MIO_LOCAL_REGRESSION_PASSWORD;
  const validPassword = values.MIO_ENVIRONMENT === name && /^[a-f0-9]{64}$/.test(password ?? '');
  const expected =
    validPassword && validPort !== null
      ? `postgresql://mio_regression:${password}@127.0.0.1:${validPort}/mio_regression_test`
      : null;
  const validUrl = expected !== null && values.MIO_TEST_DATABASE_URL === expected ? expected : null;
  const redisUrl =
    validUrl !== null && validRedisPort !== null
      ? `redis://mio_regression:${password}@127.0.0.1:${validRedisPort}`
      : null;
  return {
    file,
    hasRegressionKeys,
    validUrl,
    port: validPort,
    redisUrl,
    redisPort: validRedisPort,
  };
}

function canConnectLoopback(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function resolveAutoRegressionTargets(
  names: readonly ('dev' | 'test')[],
  strictConfig: boolean,
): Promise<{
  databaseUrl: string | null;
  redisUrl: string | null;
}> {
  let databaseUrl: string | null = null;
  let redisUrl: string | null = null;
  for (const name of names) {
    const candidate = await inspectLocalRegression(name, strictConfig);
    if (!candidate) continue;
    if (candidate.hasRegressionKeys && !candidate.validUrl) {
      throw new Error(
        `LOCAL_REGRESSION_TARGET: invalid regression database setting in ${candidate.file}`,
      );
    }
    if (
      !databaseUrl &&
      candidate.validUrl &&
      candidate.port !== null &&
      (await canConnectLoopback(candidate.port))
    ) {
      databaseUrl = candidate.validUrl;
    }
    if (
      !redisUrl &&
      candidate.redisUrl &&
      candidate.redisPort !== null &&
      (await canConnectLoopback(candidate.redisPort))
    ) {
      redisUrl = candidate.redisUrl;
    }
  }
  return { databaseUrl, redisUrl };
}

async function main() {
  if (action === 'check') {
    if (process.env.GITHUB_ACTIONS !== 'true')
      throw new Error('CHECK_CI_ONLY: full pnpm check runs in GitHub Actions');
    return;
  }
  if (action === 'ci-group') {
    await runCiGroup(args);
    return;
  }
  if (action !== 'test' && action !== 'local') throw new Error('VALIDATION_ACTION');
  if (action === 'test' && args.length === 0 && process.env.GITHUB_ACTIONS === 'true') {
    const vitest = fileURLToPath(
      new URL('./vitest.mjs', import.meta.resolve('vitest/package.json')),
    );
    await run(process.execPath, [vitest, 'run']);
    return;
  }
  if (!args.length) throw new Error('TEST_SCOPE: provide a test file or directory');

  const { createVitest, parseCLI } = await import('vitest/node');
  const { filter, options } = parseCLI(['vitest', 'run', ...args]);
  if (!filter.length) throw new Error('TEST_SCOPE: provide a test file or directory');
  const trailing = (options as { '--'?: string[] })['--'];
  if (Object.keys(options).some((key) => !allowedOptions.has(key)) || trailing?.length)
    throw new Error('TEST_OPTION: option changes discovery or is not supported by this entry');

  if (action === 'local') {
    await run(process.execPath, ['scripts/service/local.ts', 'auto', 'check', ...args]);
    return;
  }

  const testsRoot = resolve('tests');
  const computeRoot = resolve('compute/tests');
  const scopes = await Promise.all(
    filter.map(async (scope) => {
      const path = resolve(scope);
      const root = within(path, testsRoot) && path !== testsRoot ? testsRoot : computeRoot;
      if (!within(path, root)) throw new Error(`TEST_SCOPE: outside test directories: ${scope}`);
      const [target, canonicalRoot] = await Promise.all([realpath(path), realpath(root)]);
      if (!within(target, canonicalRoot) || (root === testsRoot && target === canonicalRoot))
        throw new Error(`TEST_SCOPE: outside test directories: ${scope}`);
      const metadata = await stat(target);
      if (!metadata.isDirectory() && !metadata.isFile())
        throw new Error(`TEST_SCOPE: expected a file or directory: ${scope}`);
      return { scope, path, target, directory: metadata.isDirectory() };
    }),
  );
  if (!process.env.MIO_TEST_DATABASE_URL) delete process.env.MIO_TEST_DATABASE_URL;
  if (!process.env.MIO_TEST_REDIS_URL) delete process.env.MIO_TEST_REDIS_URL;
  // The local wrapper strips inherited service settings and passes an environment selection.
  const localEnvironment = process.env.MIO_TEST_LOCAL_ENVIRONMENT;
  delete process.env.MIO_TEST_LOCAL_ENVIRONMENT;
  if (
    localEnvironment !== undefined &&
    localEnvironment !== 'dev' &&
    localEnvironment !== 'test' &&
    localEnvironment !== 'auto'
  )
    throw new Error('LOCAL_REGRESSION_TARGET: invalid local environment selection');
  if (
    (localEnvironment !== undefined || process.env.GITHUB_ACTIONS !== 'true') &&
    (!process.env.MIO_TEST_DATABASE_URL || !process.env.MIO_TEST_REDIS_URL)
  ) {
    const detected = await resolveAutoRegressionTargets(
      localEnvironment === 'dev' || localEnvironment === 'test'
        ? [localEnvironment]
        : ['dev', 'test'],
      localEnvironment !== undefined,
    );
    if (!process.env.MIO_TEST_DATABASE_URL && detected.databaseUrl)
      process.env.MIO_TEST_DATABASE_URL = detected.databaseUrl;
    if (!process.env.MIO_TEST_REDIS_URL && detected.redisUrl)
      process.env.MIO_TEST_REDIS_URL = detected.redisUrl;
  }
  process.env.TEST = 'true';
  process.env.VITEST = 'true';
  process.env.NODE_ENV ??= 'test';
  const vitest = await createVitest('test', { ...options, watch: false });
  try {
    const specifications = await vitest.globTestSpecifications();
    const discovered = await Promise.all(
      specifications
        .filter((specification) =>
          scopes.some((scope) =>
            scope.directory
              ? within(resolve(specification.moduleId), scope.path)
              : resolve(specification.moduleId) === scope.path,
          ),
        )
        .map(async (specification) => ({
          specification,
          path: await realpath(specification.moduleId),
        })),
    );
    const selected = new Set<(typeof specifications)[number]>();
    for (const scope of scopes) {
      const matches = discovered.filter(({ specification, path }) => {
        const declared = resolve(specification.moduleId);
        return scope.directory
          ? within(declared, scope.path) && within(path, scope.target)
          : declared === scope.path && path === scope.target;
      });
      if (!matches.length) throw new Error(`TEST_SCOPE: no tests found for ${scope.scope}`);
      for (const match of matches) selected.add(match.specification);
    }
    await vitest.standalone();
    await vitest.runTestSpecifications([...selected]);
  } finally {
    await vitest.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
