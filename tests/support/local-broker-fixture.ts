import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import {
  computeCapacity,
  computePermissions,
  computeTopology,
} from '../../scripts/service/compute-broker-topology.ts';

type EphemeralLocalBroker = {
  environment: 'dev' | 'test';
  vhost: string;
  appBrokerUrl: string;
  workerBrokerUrl: string;
  userA: string;
  userB: string;
  close(): Promise<void>;
};

type BrokerAdminTarget = {
  environment: 'dev' | 'test';
  mgmtBase: string;
  amqpPort: string;
  adminAuth: string;
};

async function findReachableLocalBroker(): Promise<BrokerAdminTarget> {
  let foundConfig = false;
  for (const [file, environment] of [
    ['.env', 'dev'],
    ['.env.test', 'test'],
  ] as const) {
    let info;
    try {
      info = await lstat(resolve(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) continue;
    const values = parseEnv(await readFile(resolve(file), 'utf8'));
    const mgmtPort = values.MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT;
    const amqpPort = values.MIO_LOCAL_RABBITMQ_PORT;
    const adminPass = values.MIO_LOCAL_RABBITMQ_PASSWORD;
    assert(mgmtPort && amqpPort && adminPass, 'LOCAL_RABBITMQ_ENV_REQUIRED');
    foundConfig = true;
    const mgmtBase = `http://127.0.0.1:${mgmtPort}/api/`;
    const adminAuth = Buffer.from(`mio-${environment}-admin:${adminPass}`).toString('base64');
    try {
      const probe = await fetch(new URL('health/checks/ready-to-serve-clients', mgmtBase), {
        headers: { authorization: `Basic ${adminAuth}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (probe.ok) return { environment, mgmtBase, amqpPort, adminAuth };
    } catch {
      // Try the next configured local broker before failing closed.
    }
  }
  throw new Error(
    foundConfig
      ? 'LOCAL_RABBITMQ_UNREACHABLE: start local RabbitMQ with pnpm infra:up:dev (or pnpm infra:up:test)'
      : 'LOCAL_RABBITMQ_REQUIRED: initialize local middleware with pnpm env:init && pnpm infra:up:dev',
  );
}

/** Creates an isolated ephemeral vhost and A/B users on the running local RabbitMQ (dev or test). */
export async function provisionLocalTestBroker(
  prefix: string,
): Promise<EphemeralLocalBroker | null> {
  if (process.env.GITHUB_ACTIONS === 'true') return null;
  const target = await findReachableLocalBroker();
  const token = randomBytes(6).toString('hex');
  const vhost = `${prefix}-${token}`;
  const userA = `mio-a-${token}`;
  const passA = randomBytes(24).toString('base64url');
  const userB = `mio-b-${token}`;
  const passB = randomBytes(24).toString('base64url');

  const mgmtApi = async (method: string, path: string, body?: Record<string, unknown>) => {
    const res = await fetch(new URL(path, target.mgmtBase), {
      method,
      headers: {
        authorization: `Basic ${target.adminAuth}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      throw new Error(`RABBITMQ_MGMT_${res.status}:${method}:${path}`);
    }
  };

  const encVhost = encodeURIComponent(vhost);
  await mgmtApi('PUT', `vhosts/${encVhost}`, {});
  try {
    await mgmtApi('PUT', `operator-policies/${encVhost}/mio-capacity`, {
      pattern: '.*',
      definition: computeCapacity,
      priority: 0,
      'apply-to': 'queues',
    });
    for (const item of computeTopology(vhost)) {
      await mgmtApi(item.method, item.path, item.body);
    }
    for (const [role, username, password] of [
      ['a', userA, passA],
      ['b', userB, passB],
    ] as const) {
      await mgmtApi('PUT', `users/${encodeURIComponent(username)}`, {
        password,
        tags: '',
      });
      await mgmtApi(
        'PUT',
        `permissions/${encVhost}/${encodeURIComponent(username)}`,
        computePermissions(role),
      );
    }
  } catch (error) {
    await mgmtApi('DELETE', `vhosts/${encVhost}`).catch(() => {});
    await mgmtApi('DELETE', `users/${encodeURIComponent(userA)}`).catch(() => {});
    await mgmtApi('DELETE', `users/${encodeURIComponent(userB)}`).catch(() => {});
    throw error;
  }

  return {
    environment: target.environment,
    vhost,
    appBrokerUrl: `amqp://${encodeURIComponent(userA)}:${encodeURIComponent(passA)}@127.0.0.1:${target.amqpPort}/${encVhost}`,
    workerBrokerUrl: `amqp://${encodeURIComponent(userB)}:${encodeURIComponent(passB)}@127.0.0.1:${target.amqpPort}/${encVhost}`,
    userA,
    userB,
    async close() {
      await mgmtApi('DELETE', `vhosts/${encVhost}`).catch(() => {});
      await mgmtApi('DELETE', `users/${encodeURIComponent(userA)}`).catch(() => {});
      await mgmtApi('DELETE', `users/${encodeURIComponent(userB)}`).catch(() => {});
    },
  };
}
