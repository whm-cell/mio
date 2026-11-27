import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { AdminPrincipal } from '../../src/admin/contracts.ts';
import { createAdminHandler } from '../../src/admin/http.ts';
import type { AdminService } from '../../src/admin/service.ts';

const id = 'bbbbbbbb-1111-4111-8111-111111111111';
const principal: AdminPrincipal = {
  admin: {
    id,
    username: 'stub-admin',
    isSuperAdmin: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  },
  sessionId: 'stub-session',
  tokenDigest: 'stub-token-digest',
};
const authenticate = vi.fn<AdminService['authenticate']>(async (token) =>
  token === 'admin-sentinel' ? principal : null,
);
// Disabled-domain routes only use authentication; other service methods are intentionally absent.
const service = { authenticate } as unknown as AdminService;
const adminCookie = 'mio.admin_session=admin-sentinel';
const base = '/api/v1/admin/announcements';
const routes = [
  { method: 'GET', path: base },
  { method: 'GET', path: `${base}/${id}` },
  { method: 'POST', path: base },
  { method: 'PATCH', path: `${base}/${id}` },
  { method: 'POST', path: `${base}/${id}/publish` },
  { method: 'POST', path: `${base}/${id}/unpublish` },
  { method: 'DELETE', path: `${base}/${id}` },
];
let server: Server;
let origin: string;
let handler: ReturnType<typeof createAdminHandler>;

function request(route: (typeof routes)[number], headers: Record<string, string>) {
  return fetch(`${origin}${route.path}`, { method: route.method, headers });
}

beforeAll(async () => {
  server = createServer((req, res) => void handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  authenticate.mockClear();
  // Existing callers do not supply the new optional fourth argument.
  handler = createAdminHandler(service, [origin]);
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error ? reject(error) : resolve())),
  );
});

it('preserves existing two-argument admin reads and the third-argument compute delegate', async () => {
  const me = await request(
    { method: 'GET', path: '/api/v1/admin/auth/me' },
    {
      cookie: adminCookie,
    },
  );
  expect(me.status).toBe(200);
  expect(await me.json()).toEqual({ admin: principal.admin });
  const compute = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 204;
    res.end();
  });
  handler = createAdminHandler(service, [origin], compute);
  expect((await request({ method: 'GET', path: '/api/v1/admin/compute' }, {})).status).toBe(204);
  expect(compute).toHaveBeenCalledTimes(1);
});

it.each(routes)('requires admin identity before disclosure: $method $path', async (route) => {
  const rejectedHeaders: Record<string, string>[] = [
    {},
    { cookie: 'mio.session_token=user-sentinel' },
    { authorization: 'Bearer service-sentinel' },
    { cookie: 'mio.admin_session=invalid-sentinel' },
  ];
  for (const headers of rejectedHeaders) {
    const response = await request(route, { origin, ...headers });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('ADMIN_UNAUTHORIZED');
    expect(authenticate).toHaveBeenLastCalledWith(
      headers.cookie === 'mio.admin_session=invalid-sentinel' ? 'invalid-sentinel' : null,
    );
  }
});

it.each(routes)(
  'discloses unavailable config only to a real principal: $method $path',
  async (route) => {
    const response = await request(route, { origin, cookie: adminCookie });
    expect(authenticate).toHaveBeenLastCalledWith('admin-sentinel');
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('NOTIFICATIONS_UNAVAILABLE');
  },
);

it.each(routes.filter(({ method }) => method !== 'GET'))(
  'requires an exact Origin for mutations including DELETE: $method $path',
  async (route) => {
    for (const supplied of [
      undefined,
      `${origin}/`,
      'https://untrusted-sentinel.invalid',
      'null',
    ]) {
      const response = await request(route, {
        cookie: adminCookie,
        ...(supplied === undefined ? {} : { origin: supplied }),
      });
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe(
        supplied === undefined ? 'ORIGIN_REQUIRED' : 'ORIGIN_DENIED',
      );
    }
    expect(authenticate).not.toHaveBeenCalled();
  },
);
