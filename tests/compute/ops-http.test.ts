import type { WorkerLimits } from '@mio/compute-contracts';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { createAdminHandler, readAdminSessionCookie } from '../../src/admin/http.ts';
import type { AdminService } from '../../src/admin/service.ts';
import { createComputeOpsHandler } from '../../src/compute/observability/http.ts';

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

const adminActor = {
  id: '00000000-0000-4000-8000-000000000010',
  username: 'miioo_admin',
  sessionId: 'admin-session-1',
};
const adminIdentity = async (headers: Headers) =>
  readAdminSessionCookie(headers.get('cookie')) === 'valid-admin-token' ? adminActor : null;
const adminHeaders = { cookie: 'mio.admin_session=valid-admin-token' };
const userHeaders = { cookie: 'better-auth.session_token=ordinary-user-token' };
const adminWebOrigin = 'http://localhost:4330';
const prefix = '/api/v1/admin/compute';
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
  return { reads, request, wake };
}

const put = (url: string, headers: Record<string, string>, data: unknown = body) =>
  fetch(url + prefix + '/workers/worker-a/limits', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });

it('requires admin session cookie, allows configured cross-port Origins, and records admin username', async () => {
  const control = service();
  const url = await listen(
    createComputeOpsHandler(
      control.reads,
      { request: control.request },
      adminIdentity,
      [adminWebOrigin],
      control.wake,
    ),
  );

  const anonymous = await fetch(url + prefix + '/workers');
  expect(anonymous.status).toBe(401);
  expect(await anonymous.json()).toMatchObject({ error: { code: 'ADMIN_UNAUTHORIZED' } });

  const ordinaryUser = await fetch(url + prefix + '/workers', { headers: userHeaders });
  expect(ordinaryUser.status).toBe(401);
  expect(await ordinaryUser.json()).toMatchObject({ error: { code: 'ADMIN_UNAUTHORIZED' } });

  // Unauthenticated probes against base / unknown compute subpaths must return 401 (no config oracle)
  for (const probePath of [prefix, prefix + '/unknown']) {
    for (const headers of [undefined, userHeaders]) {
      const probe = await fetch(url + probePath, headers ? { headers } : undefined);
      expect(probe.status).toBe(401);
      expect(await probe.json()).toMatchObject({ error: { code: 'ADMIN_UNAUTHORIZED' } });
    }
    const authedProbe = await fetch(url + probePath, { headers: adminHeaders });
    expect(authedProbe.status).toBe(404);
    expect(await authedProbe.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  }

  const preflight = await fetch(url + prefix + '/workers/worker-a/limits', {
    method: 'OPTIONS',
    headers: { origin: adminWebOrigin },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe(adminWebOrigin);
  expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
  expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, PUT, OPTIONS');

  const response = await fetch(url + prefix + '/workers?limit=64', {
    headers: { ...adminHeaders, origin: adminWebOrigin },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('access-control-allow-origin')).toBe(adminWebOrigin);
  expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  expect(await response.json()).toEqual({ workers: [], total: 0, offset: 0 });

  expect((await put(url, adminHeaders)).status).toBe(403);
  expect((await put(url, { ...adminHeaders, origin: adminWebOrigin + '.example' })).status).toBe(
    403,
  );
  const ordinaryPut = await put(url, { ...userHeaders, origin: adminWebOrigin });
  expect(ordinaryPut.status).toBe(401);
  expect(await ordinaryPut.json()).toMatchObject({ error: { code: 'ADMIN_UNAUTHORIZED' } });

  expect(
    (await put(url, { ...adminHeaders, origin: adminWebOrigin }, { ...body, probe: -1 })).status,
  ).toBe(400);
  expect(
    (await put(url, { ...adminHeaders, origin: adminWebOrigin }, { ...body, undefinedLimit: 3 }))
      .status,
  ).toBe(400);
  expect(
    (await put(url, { ...adminHeaders, origin: adminWebOrigin, 'content-type': 'text/plain' }))
      .status,
  ).toBe(415);
  expect(control.request).not.toHaveBeenCalled();

  const saved = await put(url, { ...adminHeaders, origin: adminWebOrigin });
  expect(saved.status).toBe(202);
  expect(await saved.json()).toMatchObject({ status: 'pending', revision: 3 });
  expect(control.request).toHaveBeenCalledOnce();
  expect(control.request).toHaveBeenCalledWith('worker-a', 'miioo_admin', 2, {
    total: 2,
    encode: 1,
    probe: 0,
  });
  expect(control.wake).toHaveBeenCalledOnce();

  expect((await fetch(url + '/ops/compute/', { headers: adminHeaders })).status).toBe(404);
  expect((await fetch(url + '/api/v1/ops/compute/summary', { headers: adminHeaders })).status).toBe(
    404,
  );
});

it('rechecks admin session after reading JSON and rejects ambiguous or excessive queries', async () => {
  const control = service();
  const revoked = vi
    .fn(adminIdentity)
    .mockResolvedValueOnce(adminActor)
    .mockResolvedValueOnce(null);
  const url = await listen(
    createComputeOpsHandler(
      control.reads,
      { request: control.request },
      revoked,
      [adminWebOrigin],
      control.wake,
    ),
  );
  const denied = await put(url, { ...adminHeaders, origin: adminWebOrigin });
  expect(denied.status).toBe(401);
  expect(await denied.json()).toMatchObject({ error: { code: 'ADMIN_UNAUTHORIZED' } });
  expect(revoked).toHaveBeenCalledTimes(2);
  expect(control.request).not.toHaveBeenCalled();

  const switchedControl = service();
  const switched = vi
    .fn(adminIdentity)
    .mockResolvedValueOnce(adminActor)
    .mockResolvedValueOnce({ ...adminActor, sessionId: 'admin-session-2' });
  const switchedUrl = await listen(
    createComputeOpsHandler(
      switchedControl.reads,
      { request: switchedControl.request },
      switched,
      [adminWebOrigin],
      switchedControl.wake,
    ),
  );
  const switchedRes = await put(switchedUrl, { ...adminHeaders, origin: adminWebOrigin });
  expect(switchedRes.status).toBe(401);
  expect(await switchedRes.json()).toMatchObject({ error: { code: 'ADMIN_UNAUTHORIZED' } });
  expect(switched).toHaveBeenCalledTimes(2);
  expect(switchedControl.request).not.toHaveBeenCalled();

  const emptySessionControl = service();
  const emptySessionUrl = await listen(
    createComputeOpsHandler(
      emptySessionControl.reads,
      { request: emptySessionControl.request },
      async () => ({ ...adminActor, sessionId: '' }),
      [adminWebOrigin],
      emptySessionControl.wake,
    ),
  );
  const emptySessionRes = await fetch(emptySessionUrl + prefix + '/workers', {
    headers: adminHeaders,
  });
  expect(emptySessionRes.status).toBe(401);
  expect(await emptySessionRes.json()).toMatchObject({ error: { code: 'ADMIN_UNAUTHORIZED' } });

  for (const route of [
    '/workers?limit=2&limit=4',
    '/workers?offset=-1',
    '/workers?limit=65',
    '/summary?jobId=x',
    '/history?since=2026-11-15T00:00:00Z&until=2026-11-24T00:00:00Z',
    '/history?since=2026-02-30T00:00:00Z',
    '/executions?state=bad',
  ]) {
    expect((await fetch(url + prefix + route, { headers: adminHeaders })).status).toBe(400);
  }
  expect(control.reads.workers).not.toHaveBeenCalled();
});

it('enforces admin auth before returning 503 COMPUTE_OPS_UNAVAILABLE when workers are not configured', async () => {
  const fakeAdminService = {
    authenticate: async (token: string | null) =>
      token === 'valid-admin-token'
        ? {
            admin: {
              id: adminActor.id,
              username: adminActor.username,
              isSuperAdmin: true,
              createdAt: '2026-11-25T00:00:00Z',
              updatedAt: '2026-11-25T00:00:00Z',
            },
            sessionId: adminActor.sessionId,
            tokenDigest: 'fixture-digest',
          }
        : null,
  } as unknown as AdminService;
  const url = await listen(createAdminHandler(fakeAdminService, [adminWebOrigin]));

  const preflight = await fetch(url + prefix + '/summary', {
    method: 'OPTIONS',
    headers: { origin: adminWebOrigin },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe(adminWebOrigin);

  for (const probePath of [prefix, prefix + '/unknown', prefix + '/summary']) {
    const unauthenticated = await fetch(url + probePath, {
      headers: { origin: adminWebOrigin },
    });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ error: { code: 'ADMIN_UNAUTHORIZED' } });

    const ordinaryUser = await fetch(url + probePath, {
      headers: { ...userHeaders, origin: adminWebOrigin },
    });
    expect(ordinaryUser.status).toBe(401);
    expect(await ordinaryUser.json()).toMatchObject({ error: { code: 'ADMIN_UNAUTHORIZED' } });
  }

  // Unauthenticated PUT without Origin still returns 401; authenticated PUT without Origin returns 403
  const anonPutNoOrigin = await put(url, {});
  expect(anonPutNoOrigin.status).toBe(401);
  expect(await anonPutNoOrigin.json()).toMatchObject({ error: { code: 'ADMIN_UNAUTHORIZED' } });

  const authedPutNoOrigin = await put(url, adminHeaders);
  expect(authedPutNoOrigin.status).toBe(403);
  expect(await authedPutNoOrigin.json()).toMatchObject({ error: { code: 'ORIGIN_REQUIRED' } });

  const authenticated = await fetch(url + prefix + '/summary', {
    headers: { ...adminHeaders, origin: adminWebOrigin },
  });
  expect(authenticated.status).toBe(503);
  expect(authenticated.headers.get('access-control-allow-origin')).toBe(adminWebOrigin);
  expect(await authenticated.json()).toMatchObject({ error: { code: 'COMPUTE_OPS_UNAVAILABLE' } });

  expect((await fetch(url + '/ops/compute/', { headers: adminHeaders })).status).toBe(404);
  expect((await fetch(url + '/api/v1/ops/compute/summary', { headers: adminHeaders })).status).toBe(
    404,
  );
});
