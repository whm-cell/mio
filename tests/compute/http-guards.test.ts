import { once } from 'node:events';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createComputeHandler } from '../../src/compute/transcode/http.ts';
import { createMediaHandler } from '../../src/compute/media/http.ts';
import { createComputeOpsHandler } from '../../src/compute/observability/http.ts';
import { createVideoGenerationHandler } from '../../src/generations/video/http.ts';

const origin = 'http://127.0.0.1:4400';
const requestId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-000000000002';
const actor = { userId: 'owner', id: 'owner', username: 'admin', sessionId: 'session' };
const cookie = 'mio_session=fixture';
type Identity = (headers: Headers) => Promise<typeof actor | null>;
type Reply = () => Promise<{ created: boolean; job: { accepted: boolean } }>;
type Endpoint = {
  name: string;
  path: string;
  method: 'POST' | 'PUT';
  preflightMethods: string;
  allow: string;
  authorizationError: string;
  body: Record<string, unknown>;
  handler(identity: Identity, submit: Reply): RequestListener;
};

const routes: Endpoint[] = [
  {
    name: 'transcode',
    path: '/api/v1/compute/jobs',
    method: 'POST',
    preflightMethods: 'POST, OPTIONS',
    allow: 'POST, OPTIONS',
    authorizationError: 'UNAUTHORIZED',
    body: { requestId, assetId },
    handler: (identity, submit) =>
      createComputeHandler(
        { create: submit } as unknown as Parameters<typeof createComputeHandler>[0],
        identity,
        [origin],
      ),
  },
  {
    name: 'media',
    path: '/api/v1/compute/media',
    method: 'POST',
    preflightMethods: 'GET, POST, OPTIONS',
    allow: 'GET, POST, OPTIONS',
    authorizationError: 'UNAUTHORIZED',
    body: { requestId, operation: 'media.probe', inputs: [{ assetId }], parameters: {} },
    handler: (identity, submit) =>
      createMediaHandler(
        { create: submit } as unknown as Parameters<typeof createMediaHandler>[0],
        identity,
        [origin],
      ),
  },
  {
    name: 'operator limits',
    path: '/api/v1/admin/compute/workers/worker-a/limits',
    method: 'PUT',
    preflightMethods: 'GET, PUT, OPTIONS',
    allow: 'PUT, OPTIONS',
    authorizationError: 'ADMIN_UNAUTHORIZED',
    body: { expectedRevision: 0, total: 1, encode: 0, probe: 1 },
    handler: (identity, submit) =>
      createComputeOpsHandler(
        {} as Parameters<typeof createComputeOpsHandler>[0],
        { request: submit } as unknown as Parameters<typeof createComputeOpsHandler>[1],
        identity,
        [origin],
        () => {},
      ),
  },
  {
    name: 'video generation',
    path: '/api/v1/compute/videos',
    method: 'POST',
    preflightMethods: 'GET, POST, OPTIONS',
    allow: 'GET, POST, OPTIONS',
    authorizationError: 'UNAUTHORIZED',
    body: {
      requestId,
      modelRef: 'onelink:model:vega',
      expectedCapabilitiesVersion: 'known',
      parameters: { mode: 'text_to_video', prompt: 'A landscape.' },
    },
    handler: (identity, submit) =>
      createVideoGenerationHandler(
        { create: submit } as unknown as Parameters<typeof createVideoGenerationHandler>[0],
        identity,
        [origin],
      ),
  },
];

async function onLoopback(listener: RequestListener, exercise: (base: string) => Promise<void>) {
  const server = createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP_FIXTURE_ADDRESS');
  try {
    await exercise(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

it.each(routes)('keeps the $name Origin and method policy', async (route) => {
  const identity = vi.fn<Identity>().mockResolvedValue(actor);
  const submit = vi.fn<Reply>().mockResolvedValue({ created: true, job: { accepted: true } });
  await onLoopback(route.handler(identity, submit), async (base) => {
    const url = base + route.path;
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { origin } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe(route.preflightMethods);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
    expect(preflight.headers.get('vary')).toBe('Origin');
    expect(identity).not.toHaveBeenCalled();

    const foreign = await fetch(url, { method: 'OPTIONS', headers: { origin: origin + '1' } });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    expect(await foreign.json()).toMatchObject({ error: { code: 'ORIGIN_DENIED' } });
    expect(identity).not.toHaveBeenCalled();

    const wrongMethod = await fetch(url, { method: 'DELETE', headers: { origin, cookie } });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe(route.allow);
    expect(identity).toHaveBeenCalledTimes(route.method === 'PUT' ? 1 : 0);
    expect(submit).not.toHaveBeenCalled();
  });
});

it('serves private HLS with its playlist MIME and cache policy', async () => {
  const identity = vi.fn<Identity>().mockResolvedValue(actor);
  const playlist = '#EXTM3U\n#EXT-X-ENDLIST\n';
  const hls = vi.fn(async () => playlist);
  const handler = createMediaHandler(
    { hls } as unknown as Parameters<typeof createMediaHandler>[0],
    identity,
    [origin],
  );
  await onLoopback(handler, async (base) => {
    const path = `/api/v1/compute/media/${requestId}/hls/${assetId}`;
    const response = await fetch(base + path, { headers: { origin, cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe(playlist);
    expect(hls).toHaveBeenCalledExactlyOnceWith(actor, requestId, assetId);
    expect(identity).toHaveBeenCalledOnce();
  });
});

it.each(routes)(
  'accepts JSON media type casing and rejects an expired $name session',
  async (route) => {
    const identity = vi
      .fn<Identity>()
      .mockResolvedValueOnce(actor)
      .mockResolvedValueOnce(actor)
      .mockResolvedValueOnce(actor)
      .mockResolvedValueOnce(null);
    const submit = vi.fn<Reply>().mockResolvedValue({ created: true, job: { accepted: true } });
    await onLoopback(route.handler(identity, submit), async (base) => {
      const url = base + route.path;
      const input = {
        method: route.method,
        headers: { origin, cookie, 'content-type': 'Application/JSON; Charset=UTF-8' },
        body: JSON.stringify(route.body),
      };
      const accepted = await fetch(url, input);
      expect(accepted.status).toBe(202);
      await accepted.json();

      const expired = await fetch(url, input);
      expect(expired.status).toBe(401);
      expect(await expired.json()).toMatchObject({ error: { code: route.authorizationError } });
      expect(identity.mock.calls.map(([headers]) => headers.get('cookie'))).toEqual(
        Array(4).fill(cookie),
      );
      expect(submit).toHaveBeenCalledOnce();
    });
  },
);
