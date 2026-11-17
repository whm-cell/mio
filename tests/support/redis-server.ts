import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@redis/client';

function resolveRedisBinary() {
  if (process.env.MIO_TEST_REDIS_SERVER) return process.env.MIO_TEST_REDIS_SERVER;
  const pathCheck = spawnSync('redis-server', ['--version'], { encoding: 'utf8' });
  if (pathCheck.status === 0 && /\bv=8\.2\.11\b/.test(pathCheck.stdout)) return 'redis-server';
  const localBuild = resolve('.runtime/redis-build/redis-8.2.11/src/redis-server');
  if (existsSync(localBuild)) return localBuild;
  return 'redis-server';
}

/** Every fault test owns a version-checked process, port and directory; never a shared Redis URL. */
export async function redisServer(password?: string) {
  const binary = resolveRedisBinary();
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0 || !/\bv=8\.2\.11\b/.test(version.stdout))
    throw new Error('Redis tests require redis-server 8.2.11 (PATH or MIO_TEST_REDIS_SERVER)');
  const directory = await mkdtemp(join(tmpdir(), 'mio-redis-'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Redis test port missing');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const url = `redis://${password ? `:${password}@` : ''}127.0.0.1:${address.port}`;
  let child: ChildProcess | undefined;
  let client: ReturnType<typeof createClient>;
  let output = '';
  const stop = async () => {
    if (client?.isOpen) client.destroy();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    if (!(await Promise.race([exited.then(() => true), delay(3000, false, { ref: false })]))) {
      child.kill('SIGKILL');
      await exited;
    }
  };
  const start = async () => {
    child = spawn(
      binary,
      [
        '--bind',
        '127.0.0.1',
        '--port',
        String(address.port),
        '--protected-mode',
        'yes',
        '--save',
        '',
        '--appendonly',
        'no',
        '--maxmemory',
        '128mb',
        '--maxmemory-policy',
        'noeviction',
        '--dir',
        directory,
        '--loglevel',
        'warning',
        ...(password ? ['--requirepass', password] : []),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout!.on('data', (data: Buffer) => {
      output = (output + data).slice(-4000);
    });
    child.stderr!.on('data', (data: Buffer) => {
      output = (output + data).slice(-4000);
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      client = createClient({ url, socket: { reconnectStrategy: false, connectTimeout: 100 } });
      client.on('error', () => {});
      try {
        await client.connect();
        return;
      } catch {
        if (client.isOpen) client.destroy();
        if (child.exitCode !== null) throw new Error(`Redis fixture failed: ${output}`);
        await delay(25);
      }
    }
    throw new Error(`Redis fixture did not start: ${output}`);
  };
  try {
    await start();
  } catch (error) {
    await stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    url,
    port: address.port,
    version: version.stdout.trim(),
    get client() {
      return client!;
    },
    stop,
    start,
    async close() {
      await stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function scanPattern(
  client: { sendCommand(args: readonly string[]): Promise<unknown> },
  pattern: string,
) {
  const found = new Set<string>();
  let cursor = '0';
  do {
    const reply = (await client.sendCommand([
      'SCAN',
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      '200',
    ])) as [string, string[]];
    cursor = reply[0];
    for (const key of reply[1]) found.add(key);
  } while (cursor !== '0');
  return [...found];
}

/** Reuses the running local Redis container via ~mio:regtest-*:* ACL, falling back to an isolated process in CI. */
export async function sharedTestRedis(namespacePrefix: string) {
  if (!/^regtest-[a-z0-9-]+$/.test(namespacePrefix))
    throw new Error('SHARED_REDIS_NAMESPACE: prefix must start with regtest-');
  const sharedUrl = process.env.MIO_TEST_REDIS_URL;
  if (sharedUrl) {
    const parsed = new URL(sharedUrl);
    if (parsed.username !== 'mio_regression')
      throw new Error('SHARED_REDIS_TARGET: MIO_TEST_REDIS_URL must use mio_regression');
    const client = createClient({
      url: sharedUrl,
      socket: { reconnectStrategy: false, connectTimeout: 3_000 },
    });
    client.on('error', () => {});
    try {
      await client.connect();
    } catch (error) {
      if (client.isOpen) client.destroy();
      const message = error instanceof Error ? error.message : String(error);
      if (/WRONGPASS|NOAUTH|NOPERM/i.test(message)) {
        throw new Error(
          `LOCAL_REDIS_ACL_UNINITIALIZED: recreate the local Redis container with pnpm infra:up:dev so mio_regression ACL is loaded (${message})`,
          { cause: error },
        );
      }
      throw error;
    }
    const keys = (pattern: string) => scanPattern(client, pattern);
    const clear = async (pattern: string) => {
      const matched = await keys(pattern);
      if (matched.length) await client.del(matched);
    };
    return {
      url: sharedUrl,
      shared: true,
      client,
      keys,
      clear,
      async activeClientCount() {
        const list = await client.clientList();
        return list.filter((entry) => entry.user === 'mio_regression').length;
      },
      async close() {
        try {
          if (client.isOpen) await clear(`mio:${namespacePrefix}*`);
        } finally {
          if (client.isOpen) client.destroy();
        }
      },
    };
  }
  const isolated = await redisServer();
  const keys = (pattern: string) => scanPattern(isolated.client, pattern);
  const clear = async (pattern: string) => {
    const matched = await keys(pattern);
    if (matched.length) await isolated.client.del(matched);
  };
  return {
    url: isolated.url,
    shared: false,
    get client() {
      return isolated.client;
    },
    keys,
    clear,
    async activeClientCount() {
      return (await isolated.client.clientList()).length;
    },
    close: () => isolated.close(),
  };
}
