import { randomBytes } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { localComputeSettings, validateLocalComputeSettings } from './local-compute-environment.ts';

export type LocalEnvironment = 'dev' | 'test';

function fileName(name: LocalEnvironment): string {
  return name === 'dev' ? '.env' : '.env.test';
}

/** One-time creation only: existing database passwords and signing secrets must survive. */
export async function createLocalEnvironment(name: LocalEnvironment, root = resolve('.')) {
  const file = resolve(root, fileName(name));
  const secret = () => randomBytes(32).toString('hex');
  const databasePassword = secret();
  const redisPassword = secret();
  const regressionPassword = secret();
  const appPort = name === 'dev' ? '4310' : '4311';
  const postgresPort = name === 'dev' ? '55432' : '55433';
  const redisPort = name === 'dev' ? '56379' : '56380';
  const values = {
    MIO_ENVIRONMENT: name,
    NODE_ENV: name === 'dev' ? 'development' : 'production',
    MIO_HOST: '127.0.0.1',
    MIO_PORT: appPort,
    MIO_API_TOKEN: secret(),
    MIO_AUTH_BASE_URL: `http://${name === 'dev' ? 'localhost' : '127.0.0.1'}:${appPort}`,
    MIO_AUTH_SECRET: secret(),
    MIO_AUTH_DATABASE_URL: `postgresql://mio:${databasePassword}@127.0.0.1:${postgresPort}/mio_${name}`,
    MIO_AUTH_RATE_LIMIT_BACKEND: 'redis',
    MIO_AUTH_ALLOWED_ORIGINS: '[]',
    MIO_ALLOWED_ORIGINS: '[]',
    MIO_REDIS_URL: `redis://mio:${redisPassword}@127.0.0.1:${redisPort}`,
    MIO_REDIS_NAMESPACE: name,
    DSH_HOME: `.runtime/${name}/dsh`,
    MIO_LOCAL_POSTGRES_PORT: postgresPort,
    MIO_LOCAL_REDIS_PORT: redisPort,
    MIO_LOCAL_POSTGRES_PASSWORD: secret(),
    MIO_LOCAL_DATABASE_PASSWORD: databasePassword,
    MIO_LOCAL_REDIS_PASSWORD: redisPassword,
    ...localComputeSettings(name),
    ...(name === 'test'
      ? {
          MIO_LOCAL_REGRESSION_PASSWORD: regressionPassword,
          MIO_TEST_DATABASE_URL: `postgresql://mio_regression:${regressionPassword}@127.0.0.1:${postgresPort}/mio_regression_test`,
        }
      : {}),
  };
  try {
    await writeFile(
      file,
      `# Private ${name} environment. Keep secrets and Docker volumes together.\n${Object.entries(
        values,
      )
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    return 'created';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error('LOCAL_ENV_FILE: existing configuration must be a private regular file');
    const contents = await readFile(file, 'utf8');
    const existing = parseEnv(contents);
    if (existing.MIO_ENVIRONMENT !== name) throw new Error('LOCAL_ENV_IDENTITY');
    const additions = localComputeSettings(name);
    const keys = Object.keys(additions);
    const present = keys.filter((key) => existing[key] !== undefined);
    if (present.length === 0) {
      // Upgrade only pre-MQ files. Never invent a replacement password/instance for a partial config.
      await writeFile(
        file,
        `\n# Persistent RabbitMQ and Worker identity.\n${Object.entries(additions)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n')}\n`,
        { flag: 'a' },
      );
      return 'upgraded';
    }
    if (present.length !== keys.length)
      throw new Error(
        'LOCAL_COMPUTE_PARTIAL: restore missing MQ/Worker settings from the original configuration',
      );
    return 'preserved';
  }
}

/** Explicit environment selection prevents a shell's development credentials reaching test. */
export async function readLocalEnvironment(
  name: LocalEnvironment,
  root = resolve('.'),
  inherited: NodeJS.ProcessEnv = process.env,
) {
  const file = resolve(root, fileName(name));
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error(`LOCAL_ENV_FILE: ${fileName(name)} must be a private regular file (chmod 600)`);
  const values = parseEnv(await readFile(file, 'utf8'));
  if (
    values.MIO_ENVIRONMENT !== name ||
    values.MIO_REDIS_NAMESPACE !== name ||
    !values.DSH_HOME ||
    resolve(root, values.DSH_HOME) !== resolve(root, `.runtime/${name}/dsh`)
  )
    throw new Error(
      'LOCAL_ENV_IDENTITY: environment, Redis namespace and DSH directory must match',
    );
  for (const key of [
    'MIO_LOCAL_POSTGRES_PASSWORD',
    'MIO_LOCAL_DATABASE_PASSWORD',
    'MIO_LOCAL_REDIS_PASSWORD',
    ...(name === 'test' ? ['MIO_LOCAL_REGRESSION_PASSWORD'] : []),
  ]) {
    // These values enter Redis ACL configuration as well as URL credentials.
    if (!/^[a-f0-9]{64}$/.test(values[key] ?? ''))
      throw new Error(`LOCAL_ENV_SECRET: ${key} must contain 64 hexadecimal characters`);
  }
  for (const key of ['MIO_PORT', 'MIO_LOCAL_POSTGRES_PORT', 'MIO_LOCAL_REDIS_PORT']) {
    const port = Number(values[key]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error(`LOCAL_ENV_PORT: invalid ${key}`);
  }
  if (
    values.MIO_AUTH_DATABASE_URL !==
      `postgresql://mio:${values.MIO_LOCAL_DATABASE_PASSWORD}@127.0.0.1:${values.MIO_LOCAL_POSTGRES_PORT}/mio_${name}` ||
    values.MIO_REDIS_URL !==
      `redis://mio:${values.MIO_LOCAL_REDIS_PASSWORD}@127.0.0.1:${values.MIO_LOCAL_REDIS_PORT}`
  )
    throw new Error('LOCAL_ENV_TARGET: application URLs must match this environment middleware');
  validateLocalComputeSettings(name, values, root);
  const ports = [
    'MIO_PORT',
    'MIO_LOCAL_POSTGRES_PORT',
    'MIO_LOCAL_REDIS_PORT',
    'MIO_LOCAL_RABBITMQ_PORT',
    'MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT',
  ].map((key) => Number(values[key]));
  if (new Set(ports).size !== ports.length)
    throw new Error('LOCAL_ENV_PORT: service ports must differ');
  const host = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key]) => !/^(MIO_|DSH_|RABBITMQ_|POSTGRES_|REDIS|PG|COMPOSE_|NODE_ENV$)/.test(key),
    ),
  );
  const runtime: NodeJS.ProcessEnv & { DSH_HOME: string; DSH_AGENTS_HOME: string } = {
    ...host,
    ...Object.fromEntries(
      Object.entries(values).filter(
        ([key]) =>
          (key.startsWith('MIO_') &&
            !/^MIO_(LOCAL_|TEST_)/.test(key) &&
            ![
              'MIO_COMPUTE_DIRECTORY',
              'MIO_COMPUTE_INSTANCE_ID',
              'MIO_COMPUTE_EXPECTED_COMMAND_USER',
            ].includes(key)) ||
          key === 'NODE_ENV' ||
          key === 'RABBITMQ_URL',
      ),
    ),
    DSH_HOME: resolve(root, values.DSH_HOME),
    DSH_AGENTS_HOME: resolve(root, values.DSH_HOME, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
  };
  return { file, values, host, runtime };
}
