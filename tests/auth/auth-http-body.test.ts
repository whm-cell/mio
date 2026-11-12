import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createAuthHandler } from '../../src/auth/http.ts';
import type { Authentication } from '../../src/auth/service.ts';

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

it('preserves raw UTF-8 authentication input and does not forward an aborted body', async () => {
  const forwarded = vi.fn(async (input: Request) => {
    const body = await input.text();
    const headers = new Headers({
      'content-type': 'application/json',
      'cache-control': 'public',
      'x-request-id': 'upstream-request-id',
      'x-content-type-options': 'upstream-option',
      'retry-after': '13',
    });
    headers.append('set-cookie', 'one=1; Path=/');
    headers.append('set-cookie', 'two=2; Path=/');
    return new Response(body, { status: 429, headers });
  });
  let observed!: () => void;
  const received = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const auth = { handler: forwarded } as unknown as Authentication;
  const handler = createAuthHandler(
    {
      baseURL: 'http://localhost',
      secret: 'unused',
      databaseURL: 'unused',
      origins: ['http://client.test'],
    },
    auth,
  );
  let requests = 0;
  server = createServer((incoming, response) => {
    if (++requests === 2) incoming.once('data', () => observed());
    void handler(incoming, response);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}/api/auth/sign-in/email`;
  const headers = { origin: 'http://client.test', 'content-type': 'application/json' };
  const raw = '{ "second": "中文",\n "first": 1 }';
  const response = await fetch(url, { method: 'POST', headers, body: raw });
  expect(response.status).toBe(429);
  expect(await response.text()).toBe(raw);
  expect(response.headers.getSetCookie()).toEqual(['one=1; Path=/', 'two=2; Path=/']);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-request-id')).toBe('upstream-request-id');
  expect(response.headers.get('x-content-type-options')).toBe('upstream-option');
  expect(response.headers.get('retry-after')).toBe('13');
  expect(forwarded).toHaveBeenCalledTimes(1);
  const aborted = request(url, { method: 'POST', headers });
  aborted.on('error', () => {});
  aborted.write('{');
  await received;
  aborted.destroy();
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  expect(forwarded).toHaveBeenCalledTimes(1);
});

it('does not copy upstream headers when the upstream response body fails', async () => {
  const auth = {
    handler: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('upstream body failure'));
          },
        }),
        {
          headers: {
            'x-request-id': 'upstream-request-id',
            'x-content-type-options': 'upstream-option',
            'set-cookie': 'upstream=secret; Path=/',
            'content-length': '9999',
            'retry-after': '13',
          },
        },
      ),
  } as unknown as Authentication;
  const handler = createAuthHandler(
    {
      baseURL: 'http://localhost',
      secret: 'unused',
      databaseURL: 'unused',
      origins: ['http://client.test'],
    },
    auth,
  );
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: 'http://client.test', 'content-type': 'application/json' },
    body: '{}',
  });
  const body = (await response.json()) as { error: { code: string; requestId: string } };
  expect(response.status).toBe(503);
  expect(body.error.code).toBe('AUTH_UNAVAILABLE');
  expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
  expect(response.headers.get('x-request-id')).not.toBe('upstream-request-id');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(response.headers.get('content-length')).not.toBe('9999');
  expect(response.headers.get('retry-after')).toBeNull();
});
