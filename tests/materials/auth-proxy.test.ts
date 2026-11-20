import { createServer } from 'node:http';
import { expect, it, onTestFinished } from 'vitest';
import { createMaterialAuthProxy } from '../../scripts/service/material-auth-proxy.ts';
const uuid = '11111111-1111-4111-8111-111111111111';
it('forwards only exact public GET UUID launch/complete and strips desktop credentials before the tunnel target', async () => {
  const seen: {
    url: string;
    cookie: string | undefined;
    authorization: string | undefined;
    origin: string | undefined;
  }[] = [];
  const upstream = createServer((req, res) => {
    seen.push({
      url: req.url ?? '',
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
      origin: req.headers.origin,
    });
    res
      .writeHead(200, {
        'content-type': 'text/plain',
        'cache-control': 'no-store',
        'set-cookie': 'should-not-forward=secret',
      })
      .end('PUBLIC_CALLBACK');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error();
  const proxy = createServer(createMaterialAuthProxy(`http://127.0.0.1:${address.port}`));
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  const local = proxy.address();
  if (!local || typeof local === 'string') throw new Error();
  const base = `http://127.0.0.1:${local.port}`;
  for (const suffix of ['launch', 'complete?bytedToken=synthetic-token&resultCode=10000']) {
    const response = await fetch(`${base}/api/v1/materials/auth-sessions/${uuid}/${suffix}`, {
      headers: {
        cookie: 'desktop=private',
        authorization: 'Bearer private',
        origin: 'https://desktop.example',
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
  }
  expect(seen).toHaveLength(2);
  expect(seen.every((row) => !row.cookie && !row.authorization && !row.origin)).toBe(true);
  for (const path of [
    '/healthz',
    '/readyz',
    '/api/auth/sign-in/email',
    '/api/v1/materials/groups',
    `/api/v1/materials/auth-sessions/${uuid}`,
    `/api/v1/materials/auth-sessions/${uuid}/launch/extra`,
    `/api/v1/materials/auth-sessions/%31${uuid.slice(1)}/launch`,
  ])
    expect((await fetch(base + path)).status).toBe(404);
  expect(
    (
      await fetch(`${base}/api/v1/materials/auth-sessions/${uuid}/complete`, {
        method: 'POST',
        body: 'private',
      })
    ).status,
  ).toBe(404);
  expect(seen).toHaveLength(2);
});
it('requires a fixed loopback origin instead of request-selected proxy targets', () => {
  for (const target of [
    'https://example.com',
    'http://localhost:4310',
    'http://127.0.0.1:4310/path',
    'http://u:p@127.0.0.1:4310',
  ])
    expect(() => createMaterialAuthProxy(target)).toThrow('MATERIAL_AUTH_PROXY_TARGET');
});
