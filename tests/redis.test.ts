import { randomBytes, randomUUID } from 'node:crypto';
import dns from 'node:dns';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createRedisResource, readRedisConfig, RedisFailure } from '../src/integrations/redis.ts';
import { AUTH_RATE_LIMIT_SCRIPT, createRedisRateLimit } from '../src/auth/rate-limit.ts';
import { readAuthRateLimitBackend } from '../src/auth/config.ts';
import { redisServer } from './redis-server.ts';
import { redisProxy } from './redis-proxy.ts';

let server: Awaited<ReturnType<typeof redisServer>>;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
  server = await redisServer();
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
afterAll(async () => {
  await server?.close();
});
async function resource(url = server.url) {
  const namespace = `test-${randomUUID()}`;
  const redis = await createRedisResource({ url, namespace });
  cleanup.push(() => redis.close());
  return { redis, namespace, prefix: `mio:${namespace}:auth:rate-limit:v1:` };
}
async function proxy() {
  const relay = await redisProxy(server.port);
  cleanup.push(() => relay.close());
  return relay;
}

it('validates only explicit backend/resource configuration, without leaking secrets', () => {
  expect(readAuthRateLimitBackend({})).toBe('database');
  expect(readAuthRateLimitBackend({ MIO_AUTH_RATE_LIMIT_BACKEND: 'redis' })).toBe('redis');
  expect(() => readAuthRateLimitBackend({ MIO_AUTH_RATE_LIMIT_BACKEND: 'REDIS' })).toThrow(
    'AUTH_CONFIG',
  );
  for (const env of [
    {},
    { MIO_REDIS_URL: server.url },
    { MIO_REDIS_URL: server.url, MIO_REDIS_NAMESPACE: 'Invalid' },
    { MIO_REDIS_URL: 'redis://user:secret@remote.example:6379', MIO_REDIS_NAMESPACE: 'mio' },
  ])
    expect(() => readRedisConfig(env)).toThrow(/^REDIS_CONFIG:/);
  expect(
    readRedisConfig({
      MIO_REDIS_URL: 'rediss://user:secret@remote.example:6379',
      MIO_REDIS_NAMESPACE: 'prod-mio',
    }).namespace,
  ).toBe('prod-mio');
});

it('probes actual consumption and expiry, deletes only its probe and keeps bounded hashed state', async () => {
  const { redis, namespace, prefix } = await resource();
  const limits = await createRedisRateLimit(redis, namespace);
  expect(await server.client.keys(`${prefix}*`)).toEqual([]);
  expect(await limits.consume!('raw-IP/path?not-a-secret', { window: 60, max: 2 })).toEqual({
    allowed: true,
    retryAfter: null,
  });
  const keys = await server.client.keys(`${prefix}*`);
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatch(new RegExp(`^${prefix}[a-f0-9]{64}$`));
  expect(await server.client.get(keys[0]!)).toMatch(/^1:\d{13}$/);
  expect(await server.client.pTTL(keys[0]!)).toBeGreaterThan(59000);
});

it('runs with a prefix-limited account that cannot configure or flush the instance', async () => {
  const namespace = `acl-${randomUUID()}`;
  const user = `mio-${randomUUID()}`;
  const password = randomBytes(24).toString('hex');
  await server.client.sendCommand([
    'ACL',
    'SETUSER',
    user,
    'reset',
    'on',
    '>' + password,
    `~mio:${namespace}:*`,
    '+hello',
    '+client|setinfo',
    '+eval',
    '+time',
    '+get',
    '+set',
    '+pttl',
    '+del',
  ]);
  const url = new URL(server.url);
  url.username = user;
  url.password = password;
  let redis: Awaited<ReturnType<typeof createRedisResource>> | undefined;
  try {
    redis = await createRedisResource({ url: url.toString(), namespace });
    const limits = await createRedisRateLimit(redis, namespace);
    expect((await limits.consume!('owned-key', { window: 60, max: 1 })).allowed).toBe(true);
    await expect(
      redis.evaluate(
        "return redis.call('CONFIG', 'GET', 'maxmemory')",
        `mio:${namespace}:probe`,
        [],
      ),
    ).rejects.toMatchObject({ kind: 'unknown' });
    expect((await server.client.configGet('maxmemory-policy'))['maxmemory-policy']).toBe(
      'noeviction',
    );
    const acl = await server.client.aclGetUser(user);
    expect(acl.commands).not.toContain('+flushdb');
  } finally {
    await redis?.close();
    await server.client.sendCommand(['ACL', 'DELUSER', user]);
  }
});

it('makes concurrent admissions atomic and does not extend a refused window', async () => {
  const { redis, namespace, prefix } = await resource();
  const limits = await createRedisRateLimit(redis, namespace);
  const results = await Promise.all(
    Array.from({ length: 40 }, () => limits.consume!('concurrent', { window: 60, max: 10 })),
  );
  expect(results.filter((result) => result.allowed)).toHaveLength(10);
  expect(results.filter((result) => !result.allowed)).toHaveLength(30);
  const [key] = await server.client.keys(`${prefix}*`);
  const state = await server.client.get(key!);
  const ttl = await server.client.pTTL(key!);
  await delay(100);
  expect(await limits.consume!('concurrent', { window: 60, max: 10 })).toMatchObject({
    allowed: false,
    retryAfter: 60,
  });
  expect(await server.client.get(key!)).toBe(state);
  expect(await server.client.pTTL(key!)).toBeLessThan(ttl - 70);
});

it('moves the expiry on admissions and actually reclaims an expired key', async () => {
  const { redis, namespace, prefix } = await resource();
  const limits = await createRedisRateLimit(redis, namespace);
  await limits.consume!('expiry', { window: 0.25, max: 2 });
  await delay(150);
  await limits.consume!('expiry', { window: 0.25, max: 2 });
  const [key] = await server.client.keys(`${prefix}*`);
  expect(await server.client.pTTL(key!)).toBeGreaterThan(200);
  await delay(120);
  expect((await limits.consume!('expiry', { window: 0.25, max: 2 })).allowed).toBe(false);
  await delay(150);
  expect(await server.client.exists(key!)).toBe(0);
  expect((await limits.consume!('expiry', { window: 0.25, max: 2 })).allowed).toBe(true);
});

it('preserves the fixed Better Auth transition at controlled times including the exact boundary', async () => {
  const { redis, prefix } = await resource();
  // Only the clock is supplied by this test; GET/SET/PTTL remain real Redis operations.
  const clock = `local actual = redis
local redis = {error_reply = actual.error_reply, call = function(command, ...)
  if command == 'TIME' then return {ARGV[3], ARGV[4]} end
  return actual.call(command, ...)
end}
`;
  const base = Date.now();
  const key = `${prefix}controlled`;
  for (const [offset, allowed, retry, count, last] of [
    [0, 1, 0, 1, 0],
    [100, 1, 0, 2, 100],
    [300, 1, 0, 3, 300],
    [999, 0, 1, 3, 300],
    [1299, 0, 1, 3, 300],
    [1300, 1, 0, 1, 1300],
    [1400, 1, 0, 2, 1400],
  ]) {
    const now = base + offset!;
    expect(
      await redis.evaluate(AUTH_RATE_LIMIT_SCRIPT.replace('#!lua\n', '#!lua\n' + clock), key, [
        '1000',
        '3',
        String(Math.floor(now / 1000)),
        String((now % 1000) * 1000),
      ]),
    ).toEqual([allowed, retry]);
    expect(await server.client.get(key)).toBe(`${count}:${base + last!}`);
  }
});

it.each(['bad-value', 'wrong-type', 'no-expiry', 'clock-backwards'])(
  'stops permanently after %s instead of treating state corruption as an OOM rejection',
  async (kind) => {
    const { redis, namespace, prefix } = await resource();
    const limits = await createRedisRateLimit(redis, namespace);
    await limits.consume!('corrupt', { window: 60, max: 2 });
    const [key] = await server.client.keys(`${prefix}*`);
    if (kind === 'wrong-type') {
      await server.client.del(key!);
      await server.client.lPush(key!, 'bad');
    } else
      await server.client.set(
        key!,
        kind === 'bad-value' ? 'bad' : `1:${Date.now() + (kind === 'clock-backwards' ? 60000 : 0)}`,
        kind === 'no-expiry' ? {} : { PX: 60000 },
      );
    await expect(limits.consume!('corrupt', { window: 60, max: 2 })).rejects.toMatchObject({
      kind: 'unknown',
    });
    await server.client.del(key!);
    await expect(limits.consume!('corrupt', { window: 60, max: 2 })).rejects.toMatchObject({
      kind: 'unavailable',
    });
  },
);

it('rejects known pre-execution OOM only for that request, retaining the old count after capacity returns', async () => {
  const { redis, namespace, prefix } = await resource();
  const limits = await createRedisRateLimit(redis, namespace);
  await limits.consume!('capacity', { window: 60, max: 2 });
  const [key] = await server.client.keys(`${prefix}*`);
  const state = await server.client.get(key!);
  try {
    await server.client.configSet('maxmemory', '1');
    await expect(limits.consume!('capacity', { window: 60, max: 2 })).rejects.toMatchObject({
      kind: 'rejected',
    });
    expect(await server.client.get(key!)).toBe(state);
  } finally {
    await server.client.configSet('maxmemory', '128mb');
  }
  expect((await limits.consume!('capacity', { window: 60, max: 2 })).allowed).toBe(true);
  expect((await limits.consume!('capacity', { window: 60, max: 2 })).allowed).toBe(false);
});

it('bounds the real pending queue at 128 without stopping a healthy resource on an unsent rejection', async () => {
  const relay = await proxy();
  const { redis, namespace } = await resource(relay.url);
  const limits = await createRedisRateLimit(redis, namespace);
  relay.hold();
  const calls = Array.from({ length: 129 }, () =>
    limits.consume!('queue', { window: 60, max: 1000 }).then(
      (result) => result,
      (error: unknown) => error,
    ),
  );
  expect(await calls[128]).toMatchObject({ kind: 'rejected' });
  relay.release();
  const results = await Promise.all(calls);
  expect(results.filter((result) => result instanceof RedisFailure)).toHaveLength(1);
  expect((await limits.consume!('queue', { window: 60, max: 1000 })).allowed).toBe(true);
});

it('bounds already executed but unanswered consumption, ignores late replies and never replays', async () => {
  const relay = await proxy();
  const { redis, namespace, prefix } = await resource(relay.url);
  const limits = await createRedisRateLimit(redis, namespace);
  relay.hold();
  const started = performance.now();
  const result = limits.consume!('unknown', { window: 60, max: 2 }).catch(
    (error: unknown) => error,
  );
  await vi.waitFor(async () => expect(await server.client.keys(`${prefix}*`)).toHaveLength(1));
  expect(relay.heldBytes).toBeGreaterThan(0);
  expect(await result).toMatchObject({ kind: 'unknown' });
  const elapsed = performance.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(980);
  expect(elapsed).toBeLessThan(1400);
  const sent = relay.received;
  relay.release();
  await expect(limits.consume!('unknown', { window: 60, max: 2 })).rejects.toMatchObject({
    kind: 'unavailable',
  });
  await delay(100);
  expect(relay.received).toBe(sent);
  const [key] = await server.client.keys(`${prefix}*`);
  expect(await server.client.get(key!)).toMatch(/^1:/);
  console.log(
    `Redis executed/unanswered consume deadline: ${elapsed.toFixed(1)}ms; count=1; no replay`,
  );
});

it('does not send after an exhausted deadline and bounds shutdown with unanswered commands', async () => {
  const relay = await proxy();
  const { redis, prefix } = await resource(relay.url);
  const before = relay.received;
  await expect(redis.evaluate('return 1', `${prefix}expired`, [], 0)).rejects.toMatchObject({
    kind: 'unknown',
  });
  expect(relay.received).toBe(before);
  const second = await resource(relay.url);
  relay.hold();
  const result = second.redis
    .evaluate('return 1', `${prefix}close`, [], 5000)
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(relay.heldBytes).toBeGreaterThan(0));
  const started = performance.now();
  await second.redis.close();
  expect(performance.now() - started).toBeLessThan(1300);
  expect(await result).toBeInstanceOf(RedisFailure);
  await vi.waitFor(() => expect(relay.connections).toBe(0));
  await second.redis.close();
});

it('counts connection and unanswered startup probe within one five-second budget', async () => {
  const relay = await proxy();
  const started = performance.now();
  const { redis, namespace } = await resource(relay.url);
  relay.hold();
  await expect(createRedisRateLimit(redis, namespace, started + 5000)).rejects.toThrow(
    'AUTH_RATE_LIMIT_STARTUP',
  );
  const elapsed = performance.now() - started;
  expect(elapsed).toBeGreaterThan(4900);
  expect(elapsed).toBeLessThan(5400);
  await vi.waitFor(() => expect(relay.connections).toBe(0));
  console.log(`Redis connection + unanswered startup probe: ${elapsed.toFixed(1)}ms`);
});

it('cancels a socket still waiting on DNS and does not acquire a late Redis connection', async () => {
  const original = dns.lookup;
  const before = (await server.client.clientList()).length;
  const lookup = vi
    .spyOn(dns, 'lookup')
    .mockImplementation((...args: Parameters<typeof dns.lookup>) => {
      setTimeout(() => original(...args), 150);
    });
  try {
    await expect(
      createRedisResource(
        { url: server.url.replace('127.0.0.1', 'localhost'), namespace: 'delayed-dns' },
        performance.now() + 50,
      ),
    ).rejects.toThrow('REDIS_STARTUP');
    await delay(300);
    expect((await server.client.clientList()).length).toBe(before);
  } finally {
    lookup.mockRestore();
  }
});

it('cancels an actual TLS socket whose peer never completes the TLS handshake', async () => {
  const sockets = new Set<Socket>();
  const peer = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('data', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  const address = peer.address();
  if (!address || typeof address === 'string') throw new Error('TLS peer port missing');
  try {
    const started = performance.now();
    await expect(
      createRedisResource(
        { url: `rediss://127.0.0.1:${address.port}`, namespace: 'tls-handshake' },
        started + 100,
      ),
    ).rejects.toThrow('REDIS_STARTUP');
    expect(performance.now() - started).toBeLessThan(400);
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => peer.close(() => resolve()));
  }
});
