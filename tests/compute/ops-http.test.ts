import type { WorkerLimits } from '@mio/compute-contracts';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { createComputeOpsHandler } from '../../src/compute/ops-http.ts';
import { createComputeOpsWebHandler } from '../../src/compute/ops-web.ts';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
) {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const identity = async (headers: Headers) => {
  const cookie = headers.get('cookie');
  if (!cookie) return null;
  return {
    userId: cookie === 'session=operator' ? 'operator' : 'other',
    sessionId: 'synthetic-session',
  };
};
const operator = { cookie: 'session=operator' };
const origin = 'http://127.0.0.1:4173';
const prefix = '/api/v1/ops/compute';
const unavailable = async (): Promise<never> => {
  throw new Error('Unexpected read');
};
const body = { expectedRevision: 2, total: 2, encode: 1, probe: 0 };
function service() {
  const workers = vi.fn(async () => ({ workers: [], total: 0, offset: 0 }));
  const request = vi.fn(
    async (_target: string, _actor: string, revision: number, limits: WorkerLimits) => ({
      commandId: 'fixture-command',
      revision: revision + 1,
      limits,
      requestedAt: new Date(),
      status: 'pending',
    }),
  );
  const wake = vi.fn();
  const reads = {
    workers,
    summary: unavailable,
    worker: unavailable,
    executions: unavailable,
    execution: unavailable,
    history: unavailable,
    limits: unavailable,
  };
  return {
    reads,
    request,
    wake,
  };
}
const put = (url: string, headers: Record<string, string>, data: unknown = body) =>
  fetch(url + prefix + '/workers/worker-a/limits', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });

it('authenticates reads and requires exact allowed Origin and operator for durable updates', async () => {
  const control = service();
  const url = await listen(
    createComputeOpsHandler(
      control.reads,
      { request: control.request },
      identity,
      [origin],
      ['operator'],
      control.wake,
    ),
  );
  expect((await fetch(url + prefix + '/workers')).status).toBe(401);
  expect(
    (await fetch(url + prefix + '/workers', { headers: { cookie: 'session=other' } })).status,
  ).toBe(403);
  const response = await fetch(url + prefix + '/workers?limit=64', { headers: operator });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ workers: [], total: 0, offset: 0 });
  expect((await put(url, operator)).status).toBe(403);
  expect((await put(url, { ...operator, origin: origin + '.example' })).status).toBe(403);
  expect((await put(url, { cookie: 'session=other', origin })).status).toBe(403);
  expect((await put(url, { ...operator, origin }, { ...body, probe: -1 })).status).toBe(400);
  expect((await put(url, { ...operator, origin }, { ...body, undefinedLimit: 3 })).status).toBe(
    400,
  );
  expect((await put(url, { ...operator, origin, 'content-type': 'text/plain' })).status).toBe(415);
  expect(control.request).not.toHaveBeenCalled();

  const saved = await put(url, { ...operator, origin });
  expect(saved.status).toBe(202);
  expect(await saved.json()).toMatchObject({ status: 'pending', revision: 3 });
  expect(control.request).toHaveBeenCalledOnce();
  expect(control.request).toHaveBeenCalledWith('worker-a', 'operator', 2, {
    total: 2,
    encode: 1,
    probe: 0,
  });
  expect(control.wake).toHaveBeenCalledOnce();
});

it('rechecks session after reading JSON and rejects ambiguous or excessive queries', async () => {
  const control = service();
  const revoked = vi
    .fn(identity)
    .mockResolvedValueOnce({ userId: 'operator', sessionId: 'old' })
    .mockResolvedValueOnce(null);
  const url = await listen(
    createComputeOpsHandler(
      control.reads,
      { request: control.request },
      revoked,
      [origin],
      ['operator'],
      control.wake,
    ),
  );
  expect((await put(url, { ...operator, origin })).status).toBe(401);
  expect(revoked).toHaveBeenCalledTimes(2);
  expect(control.request).not.toHaveBeenCalled();
  for (const route of [
    '/workers?limit=2&limit=4',
    '/workers?offset=-1',
    '/workers?limit=65',
    '/summary?jobId=x',
    '/history?since=2026-11-15T00:00:00Z&until=2026-11-24T00:00:00Z',
    '/history?since=2026-02-30T00:00:00Z',
    '/executions?state=bad',
  ]) {
    expect((await fetch(url + prefix + route, { headers: operator })).status).toBe(400);
  }
  expect(control.reads.workers).not.toHaveBeenCalled();
});

it('serves the same-origin page and assets with Cookie authorization and no caching', async () => {
  const url = await listen(createComputeOpsWebHandler(identity, ['operator']));
  expect((await fetch(url + '/ops/compute/')).status).toBe(401);
  const denied = await fetch(url + '/ops/compute/', { headers: { cookie: 'session=other' } });
  expect(denied.status).toBe(403);
  expect(await denied.text()).toContain('无权访问计算运维控制台');
  const page = await fetch(url + '/ops/compute/', { headers: operator });
  expect(page.status).toBe(200);
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(page.headers.get('cache-control')).toBe('no-store');
  expect(await page.text()).toContain('/ops/compute/app.js');
  expect((await fetch(url + '/ops/compute/app.js')).status).toBe(401);
  const script = await fetch(url + '/ops/compute/app.js', { headers: operator });
  expect(script.status).toBe(200);
  expect(script.headers.get('content-type')).toContain('text/javascript');
  expect((await fetch(url + '/ops/compute/other', { headers: operator })).status).toBe(404);
});
