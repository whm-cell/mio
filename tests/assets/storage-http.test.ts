import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createStorageUsageHandler } from '../../src/assets/storage-http.ts';

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});
const origin = 'http://127.0.0.1:4173';
const version = 'storage:v1:warning:1:0';
const headers = { origin, cookie: 'session=example', 'content-type': 'application/json' };
async function listen(
  identity = vi.fn<(headers: Headers) => Promise<{ userId: string } | null>>(async () => ({
    userId: 'owner',
  })),
) {
  const usage = vi.fn(async () => ({ usedBytes: 900, reminderVersion: version }));
  const acknowledge = vi.fn<(owner: string, version: string) => Promise<void>>(async () => {});
  let available = true;
  server = createServer(
    createStorageUsageHandler(
      () => (available ? { usage: usage as never, acknowledge } : undefined),
      identity,
      [origin],
    ),
  );
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server');
  const url = `http://127.0.0.1:${address.port}/api/v1/me/storage-usage`;
  const ack = (
    body: unknown = { reminderVersion: version },
    override: Record<string, string> = headers,
  ) =>
    fetch(`${url}/reminders/ack`, {
      method: 'POST',
      headers: override,
      body: JSON.stringify(body),
    });
  return {
    url,
    usage,
    acknowledge,
    identity,
    ack,
    unavailable: () => {
      available = false;
    },
  };
}
it('uses cookie identity for readonly usage and returns no-store standard errors for unavailable storage', async () => {
  const f = await listen();
  const get = await fetch(f.url, { headers });
  expect(get.status).toBe(200);
  expect(get.headers.get('cache-control')).toContain('no-store');
  expect(f.usage).toHaveBeenCalledWith('owner');
  expect(f.acknowledge).not.toHaveBeenCalled();
  f.unavailable();
  const missing = await fetch(f.url, { headers });
  expect(missing.status).toBe(503);
  expect(await missing.json()).toMatchObject({
    error: { code: 'STORAGE_UNAVAILABLE', requestId: expect.any(String) },
  });
});
it('requires session and exact Origin for ack, rechecks session after the body, and acknowledges stale/repeated versions with empty 204', async () => {
  const identity = vi.fn(async (): Promise<{ userId: string } | null> => ({ userId: 'owner' }));
  const f = await listen(identity);
  for (const requestHeaders of [
    { cookie: 'session=example', 'content-type': 'application/json' },
    { ...headers, origin: 'https://foreign.invalid' },
  ])
    expect((await f.ack(undefined, requestHeaders)).status).toBe(403);
  identity.mockResolvedValueOnce(null);
  expect((await f.ack()).status).toBe(401);
  identity.mockResolvedValueOnce({ userId: 'owner' }).mockResolvedValueOnce(null);
  expect((await f.ack()).status).toBe(401);
  expect(f.acknowledge).not.toHaveBeenCalled();
  for (const v of [version, version, 'storage:v1:full:0:0']) {
    const response = await f.ack({ reminderVersion: v });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  }
  expect(f.acknowledge).toHaveBeenLastCalledWith('owner', 'storage:v1:full:0:0');
});
it('rejects extra identity fields, invalid/missing versions, oversized and malformed JSON, query parameters and unsupported methods', async () => {
  const f = await listen();
  for (const body of [
    {},
    { reminderVersion: null },
    { reminderVersion: 'x' },
    { reminderVersion: version, owner: 'other' },
  ])
    expect((await f.ack(body)).status).toBe(400);
  const path = `${f.url}/reminders/ack`;
  expect((await fetch(path, { method: 'POST', headers, body: '{' })).status).toBe(400);
  expect(
    (
      await fetch(path, {
        method: 'POST',
        headers,
        body: JSON.stringify({ reminderVersion: 'x'.repeat(9000) }),
      })
    ).status,
  ).toBe(413);
  expect(
    (
      await fetch(path, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'text/plain' },
        body: '{}',
      })
    ).status,
  ).toBe(415);
  expect((await fetch(`${f.url}?owner=other`, { headers })).status).toBe(400);
  expect((await fetch(f.url, { method: 'POST', headers, body: '{}' })).status).toBe(405);
  expect((await fetch(`${path}/extra`, { method: 'POST', headers, body: '{}' })).status).toBe(404);
  expect(f.acknowledge).not.toHaveBeenCalled();
});
it('denies reads with a foreign Origin, permits credentialed preflight and hides database/policy details behind 503', async () => {
  const f = await listen();
  expect((await fetch(f.url, { headers: { origin: 'https://foreign.invalid' } })).status).toBe(403);
  const options = await fetch(`${f.url}/reminders/ack`, { method: 'OPTIONS', headers: { origin } });
  expect(options.status).toBe(204);
  expect(options.headers.get('access-control-allow-origin')).toBe(origin);
  f.usage.mockRejectedValueOnce(new Error('postgres secret details'));
  const response = await fetch(f.url, { headers });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('postgres');
  f.acknowledge.mockRejectedValueOnce(new Error('database unavailable'));
  expect((await f.ack()).status).toBe(503);
});
