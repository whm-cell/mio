import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createAudioHandler } from '../../src/audio/http.ts';
import type { AudioJobService } from '../../src/audio/jobs/service.ts';
import type { ProviderPrincipal } from '../../src/providers/contracts.ts';
import type { ProviderService } from '../../src/providers/service.ts';

const origin = 'http://127.0.0.1:4173';
const actor = { userId: 'audio-owner', sessionId: 'audio-session' };
const headers = { origin, cookie: 'session=fixture', 'content-type': 'application/json' };
let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function listen(identity: (headers: Headers) => Promise<ProviderPrincipal | null>) {
  const job = { jobId: randomUUID(), status: 'queued' };
  const create = vi
    .fn()
    .mockResolvedValueOnce({ created: true, job })
    .mockResolvedValueOnce({ created: false, job });
  const services = { create } as unknown as AudioJobService;
  server = createServer(createAudioHandler({} as ProviderService, identity, [origin], services));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP_TEST_LISTENER_REQUIRED');
  return { url: `http://127.0.0.1:${address.port}/api/v1/audio/jobs`, create, job };
}

it('returns the same job for a repeated receipt and keeps both authorities tied to the logged-in actor', async () => {
  const identity = vi.fn().mockResolvedValue(actor);
  const server = await listen(identity);
  const input = { requestId: randomUUID(), mode: 'standard' };
  for (const status of [202, 200]) {
    const response = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(await response.json()).toEqual(server.job);
  }
  expect(server.create).toHaveBeenNthCalledWith(1, actor, input);
  expect(server.create).toHaveBeenNthCalledWith(2, actor, input);
  expect(identity).toHaveBeenCalledTimes(4);
});

it('rejects an Origin outside the allowlist and a cookie that changes identity during body reads', async () => {
  const identity = vi
    .fn()
    .mockResolvedValueOnce(actor)
    .mockResolvedValueOnce({ ...actor, sessionId: 'replaced' });
  const server = await listen(identity);
  const denied = await fetch(server.url, {
    method: 'POST',
    headers: { ...headers, origin: 'https://other.invalid' },
    body: '{}',
  });
  expect(denied.status).toBe(403);
  const raced = await fetch(server.url, { method: 'POST', headers, body: '{}' });
  expect(raced.status).toBe(401);
  expect(await raced.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  expect(server.create).not.toHaveBeenCalled();
});
