import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@redis/client';

/** Every test owns a version-checked process, port and directory; never a shared Redis URL. */
export async function redisServer(password?: string) {
  const binary = process.env.MIO_TEST_REDIS_SERVER ?? 'redis-server';
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
