import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import {
  probeRabbitmqMetrics,
  readRabbitmqMonitorConfig,
} from '../../src/integrations/rabbitmq-monitor.ts';
import { probeRedisMetrics, readRedisMonitorConfig } from '../../src/integrations/redis.ts';
import type { LocalEnvironment } from './local-environment.ts';
import { readLocalEnvironment } from './local-environment.ts';

async function runDockerRedisUp(
  name: LocalEnvironment,
  envFile: string,
  hostEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const child = spawn(
    'docker',
    [
      'compose',
      '--env-file',
      envFile,
      '-p',
      `mio-${name}`,
      '-f',
      'deploy/local/compose.yaml',
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '60',
      'redis',
    ],
    { env: hostEnv, stdio: 'inherit' },
  );
  await new Promise<void>((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`MONITOR_REDIS_COMPOSE_FAILED: ${code ?? signal}`));
    });
  });
}

async function appendEnvLines(file: string, lines: readonly string[]): Promise<void> {
  const stat = await lstat(file);
  const current = await readFile(file, 'utf8');
  const prefix = current.endsWith('\n') ? '' : '\n';
  const block = `${prefix}\n# Dedicated read-only admin monitoring identities (RabbitMQ monitoring tag + Redis zero-key ACL).\n${lines.join('\n')}\n`;
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, current + block, { flag: 'wx', mode: 0o600 });
    await chmod(temp, stat.mode & 0o777);
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function prepareAdminMonitors(name: LocalEnvironment): Promise<void> {
  let env = await readLocalEnvironment(name);
  const mqMgmtPort = env.values.MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT;
  const redisPort = env.values.MIO_LOCAL_REDIS_PORT;
  if (!mqMgmtPort || !redisPort || !env.values.MIO_LOCAL_RABBITMQ_PASSWORD) {
    throw new Error('MONITOR_INIT_PREREQUISITE: run pnpm env:init first');
  }

  const mqMonitorPassword =
    env.values.MIO_LOCAL_RABBITMQ_MONITOR_PASSWORD ?? randomBytes(32).toString('hex');
  const redisMonitorPassword =
    env.values.MIO_LOCAL_REDIS_MONITOR_PASSWORD ?? randomBytes(32).toString('hex');
  const expectedMqUrl = `http://mio-${name}-monitor:${mqMonitorPassword}@127.0.0.1:${mqMgmtPort}/mio-${name}`;
  const expectedRedisUrl = `redis://mio_monitor:${redisMonitorPassword}@127.0.0.1:${redisPort}`;

  const missingLines: string[] = [];
  if (!env.values.MIO_LOCAL_RABBITMQ_MONITOR_PASSWORD) {
    missingLines.push(`MIO_LOCAL_RABBITMQ_MONITOR_PASSWORD=${mqMonitorPassword}`);
  }
  if (!env.values.MIO_LOCAL_REDIS_MONITOR_PASSWORD) {
    missingLines.push(`MIO_LOCAL_REDIS_MONITOR_PASSWORD=${redisMonitorPassword}`);
  }
  if (!env.values.MIO_ADMIN_RABBITMQ_MONITOR_URL) {
    missingLines.push(`MIO_ADMIN_RABBITMQ_MONITOR_URL=${expectedMqUrl}`);
  }
  if (!env.values.MIO_ADMIN_REDIS_MONITOR_URL) {
    missingLines.push(`MIO_ADMIN_REDIS_MONITOR_URL=${expectedRedisUrl}`);
  }
  if (missingLines.length > 0) {
    await appendEnvLines(env.file, missingLines);
    env = await readLocalEnvironment(name);
  }

  const base = `http://127.0.0.1:${mqMgmtPort}/api/`;
  const adminAuth = Buffer.from(
    `mio-${name}-admin:${env.values.MIO_LOCAL_RABBITMQ_PASSWORD}`,
    'utf8',
  ).toString('base64');

  const mqAdminRequest = async (method: string, path: string, body?: Record<string, unknown>) => {
    const response = await fetch(new URL(path, base), {
      method,
      headers: {
        authorization: `Basic ${adminAuth}`,
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (method === 'GET' && response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`MONITOR_RABBITMQ_PROVISION_FAILED: ${response.status} ${method} ${path}`);
    }
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : null;
  };

  const vhost = `mio-${name}`;
  const monitorUser = `mio-${name}-monitor`;
  if ((await mqAdminRequest('GET', `vhosts/${encodeURIComponent(vhost)}`)) === null) {
    await mqAdminRequest('PUT', `vhosts/${encodeURIComponent(vhost)}`, {});
  }
  await mqAdminRequest('PUT', `users/${encodeURIComponent(monitorUser)}`, {
    password: env.values.MIO_LOCAL_RABBITMQ_MONITOR_PASSWORD!,
    tags: 'monitoring',
  });
  await mqAdminRequest(
    'PUT',
    `permissions/${encodeURIComponent(vhost)}/${encodeURIComponent(monitorUser)}`,
    {
      configure: '^$',
      write: '^$',
      read: '^$',
    },
  );

  await runDockerRedisUp(name, env.file, env.host);

  const mqConfig = readRabbitmqMonitorConfig(env.runtime);
  const redisConfig = readRedisMonitorConfig(env.runtime);
  const [mqSnapshot, redisSnapshot] = await Promise.all([
    probeRabbitmqMetrics(mqConfig),
    probeRedisMetrics(redisConfig),
  ]);
  if (mqSnapshot.status !== 'up') {
    throw new Error(`MONITOR_RABBITMQ_VERIFY_FAILED: ${mqSnapshot.errorCode ?? 'UNKNOWN'}`);
  }
  if (redisSnapshot.status !== 'up') {
    throw new Error(`MONITOR_REDIS_VERIFY_FAILED: ${redisSnapshot.errorCode ?? 'UNKNOWN'}`);
  }
  console.log(
    `${name}: RabbitMQ monitor (${monitorUser}, vhost=${vhost}) and Redis monitor (mio_monitor, dbsize=${redisSnapshot.dbsize}) verified`,
  );
}
