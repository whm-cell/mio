import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRedisResource } from '../../src/integrations/redis.ts';
import { redisServer, sharedTestRedis } from '../support/redis-server.ts';
import { redisProxy } from '../support/redis-proxy.ts';

it('observes complete commands across split UTF-8 bulk strings and pipelined TCP input', async () => {
  const upstream = createServer((socket) => socket.resume());
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port missing');
  const commands: string[][] = [];
  const relay = await redisProxy(address.port, (args) => commands.push([...args]));
  const client = createConnection(Number(new URL(relay.url).port), '127.0.0.1');
  try {
    await once(client, 'connect');
    const wire = Buffer.from(
      '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$3\r\n图\r\n*2\r\n$3\r\nGET\r\n$1\r\nk\r\n',
    );
    const split = wire.indexOf(Buffer.from('图')) + 1;
    client.write(wire.subarray(0, split));
    await vi.waitFor(() => expect(Buffer.byteLength(relay.received)).toBeGreaterThanOrEqual(split));
    expect(commands).toEqual([]);
    client.write(wire.subarray(split));
    await vi.waitFor(() =>
      expect(commands).toEqual([
        ['SET', 'k', '图'],
        ['GET', 'k'],
      ]),
    );
  } finally {
    client.destroy();
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it('tracks each run’s actual Lua keys and connections independently, including an intentionally retained connection', async () => {
  const namespaceA = `regtest-${randomUUID()}`;
  const namespaceB = `regtest-${randomUUID()}`;
  // Without a shared URL, both rounds must still observe one explicitly owned Redis process.
  const isolatedBackend = process.env.MIO_TEST_REDIS_URL ? undefined : await redisServer();
  const a = await sharedTestRedis(namespaceA, isolatedBackend);
  const b = await sharedTestRedis(namespaceB, isolatedBackend);
  const writerA = await createRedisResource({ url: a.url, namespace: namespaceA });
  const writerB = await createRedisResource({ url: b.url, namespace: namespaceB });
  const keyA = `mio:${namespaceA}:lua-only`;
  const keyB = `mio:${namespaceB}:lua-only`;
  let closedA = false;
  try {
    await Promise.all([
      writerA.evaluate("return redis.call('SET', KEYS[1], ARGV[1])", keyA, ['a']),
      writerB.evaluate("return redis.call('SET', KEYS[1], ARGV[1])", keyB, ['b']),
    ]);
    expect(await a.keys(`mio:${namespaceA}:*`)).toEqual([keyA]);
    expect(await b.keys(`mio:${namespaceB}:*`)).toEqual([keyB]);
    expect(await a.activeClientCount()).toBe(1);
    expect(await b.activeClientCount()).toBe(1);
    await writerA.close();
    await vi.waitFor(async () => expect(await a.activeClientCount()).toBe(0));
    // The second real connection stays open. A release assertion must detect it.
    expect(await b.activeClientCount()).toBe(1);
    await a.close();
    closedA = true;
    expect(await b.client.get(keyA)).toBeNull();
    expect(await b.client.get(keyB)).toBe('b');
    expect(await b.activeClientCount()).toBe(1);
    await writerB.close();
    await vi.waitFor(async () => expect(await b.activeClientCount()).toBe(0));
  } finally {
    await writerA.close();
    await writerB.close();
    if (!closedA) await a.close();
    await b.close();
    await isolatedBackend?.close();
  }
});

it('loads the deployed regression ACL and denies instance-wide key and connection enumeration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mio-regression-acl-'));
  const aclPath = join(directory, 'users.acl');
  const password = randomBytes(32).toString('hex');
  let server: Awaited<ReturnType<typeof redisServer>> | undefined;
  let fixture: Awaited<ReturnType<typeof sharedTestRedis>> | undefined;
  let writer: Awaited<ReturnType<typeof createRedisResource>> | undefined;
  const previousUrl = process.env.MIO_TEST_REDIS_URL;
  try {
    const startup = await readFile('deploy/local/redis-start.sh', 'utf8');
    const launch = startup.indexOf('exec redis-server');
    expect(launch).toBeGreaterThan(0);
    const generate = startup
      .slice(0, launch)
      .replace('> /tmp/mio-users.acl', '> "$MIO_TEST_ACL_OUTPUT"');
    const result = spawnSync('sh', ['-c', generate], {
      env: {
        PATH: process.env.PATH,
        MIO_LOCAL_REDIS_PASSWORD: randomBytes(32).toString('hex'),
        MIO_REDIS_NAMESPACE: 'regtest-deployment',
        MIO_LOCAL_REGRESSION_PASSWORD: password,
        MIO_TEST_ACL_OUTPUT: aclPath,
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    server = await redisServer(password, { file: aclPath, user: 'mio_regression' });
    const client = server.client;
    const key = `mio:regtest-${randomUUID()}:allowed`;
    expect(await client.set(key, 'owned')).toBe('OK');
    expect(await client.get(key)).toBe('owned');
    await expect(client.sendCommand(['SCAN', '0'])).rejects.toThrow(/NOPERM/);
    await expect(client.clientList()).rejects.toThrow(/NOPERM/);
    await expect(client.get('mio:dev:forbidden')).rejects.toThrow(/NOPERM/);
    process.env.MIO_TEST_REDIS_URL = server.url;
    const namespace = `regtest-${randomUUID()}`;
    fixture = await sharedTestRedis(namespace);
    writer = await createRedisResource({ url: fixture.url, namespace });
    const tracked = `mio:${namespace}:real-lua`;
    await writer.evaluate("return redis.call('SET', KEYS[1], ARGV[1])", tracked, ['tracked']);
    expect(await fixture.keys(`mio:${namespace}:*`)).toEqual([tracked]);
    expect(await fixture.activeClientCount()).toBe(1);
    await writer.close();
    await vi.waitFor(async () => expect(await fixture!.activeClientCount()).toBe(0));
    await fixture.clear(`mio:${namespace}:*`);
    expect(await client.get(tracked)).toBeNull();
  } finally {
    if (previousUrl === undefined) delete process.env.MIO_TEST_REDIS_URL;
    else process.env.MIO_TEST_REDIS_URL = previousUrl;
    await writer?.close();
    await fixture?.close();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
