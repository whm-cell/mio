import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, it, onTestFinished, vi } from 'vitest';
import { materialAuthFixture } from './auth-fixture.ts';
import { createMaterialHandler } from '../../src/materials/http.ts';
import { createMaterialService } from '../../src/materials/service.ts';
import { createMaterialStore } from '../../src/materials/store.ts';
import { createMaterialUpstream } from '../../src/integrations/onelink/materials.ts';
async function fixture() {
  const f = await materialAuthFixture();
  onTestFinished(() => f.close());
  const origin = 'https://desktop.example';
  const handler = createMaterialHandler(
    f.service,
    async (headers) => (headers.get('cookie') === 'owner=yes' ? f.actor : null),
    [origin],
    f.authentication,
  );
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error();
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, value?: unknown, extra: Record<string, string> = {}) =>
    fetch(base + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: {
        origin,
        cookie: 'owner=yes',
        ...(value ? { 'content-type': 'application/json' } : {}),
        ...extra,
      },
      ...(value ? { body: JSON.stringify(value) } : {}),
      redirect: 'manual',
    });
  return { ...f, base, request };
}
it('exposes only exact launch/complete publicly while all authenticated routes preserve Cookie/Origin/strict input', async () => {
  const f = await fixture();
  const input = { requestId: randomUUID(), source: 'materials', returnTarget: 'materials' };
  expect((await f.request('/api/v1/materials/auth-sessions', input, { cookie: '' })).status).toBe(
    401,
  );
  expect(
    (await f.request('/api/v1/materials/auth-sessions', { ...input, owner: 'other' })).status,
  ).toBe(400);
  expect(
    (
      await f.request('/api/v1/materials/auth-sessions', {
        ...input,
        returnTarget: 'https://evil.example',
      })
    ).status,
  ).toBe(400);
  const created = await f.request('/api/v1/materials/auth-sessions', input);
  expect(created.status).toBe(201);
  const view = (await created.json()) as { sessionId: string; launchUrl: string };
  const id = view.sessionId,
    token = [...f.tokens.keys()][0]!;
  expect(
    (await f.request(`/api/v1/materials/auth-sessions/${id}`, undefined, { cookie: '' })).status,
  ).toBe(401);
  expect(
    (
      await f.request('/api/v1/materials/groups', undefined, {
        cookie: '',
        origin: 'https://evil.example',
      })
    ).status,
  ).toBe(403);
  const publicLaunch = await fetch(`${f.base}/api/v1/materials/auth-sessions/${id}/launch`, {
    redirect: 'manual',
  });
  expect(publicLaunch.status).toBe(302);
  expect(publicLaunch.headers.get('location')).toBe(f.tokens.get(token)!.launchUrl);
  expect(publicLaunch.headers.get('referrer-policy')).toBe('no-referrer');
  expect(publicLaunch.headers.get('cache-control')).toBe('no-store');
  expect(
    (await fetch(`${f.base}/api/v1/materials/auth-sessions/${id}/launch?url=https://evil.example`))
      .status,
  ).toBe(400);
  expect(
    (await fetch(`${f.base}/api/v1/materials/auth-sessions/${id}/launch`, { method: 'POST' }))
      .status,
  ).toBe(405);
  expect((await fetch(`${f.base}/api/v1/materials/auth-sessions/${id}/launch/extra`)).status).toBe(
    404,
  );
  const endpoint = `${f.base}/api/v1/materials/auth-sessions/${id}/complete`;
  const wrong = await fetch(
    `${endpoint}?bytedToken=${encodeURIComponent('different-valid-token-' + randomUUID())}&resultCode=10000`,
  );
  expect(wrong.status).toBe(400);
  expect(await wrong.text()).not.toContain(token);
  expect(
    (
      await fetch(
        `${endpoint}?bytedToken=${encodeURIComponent(token)}&bytedToken=${encodeURIComponent(token)}`,
      )
    ).status,
  ).toBe(400);
  const success = await fetch(
    `${endpoint}?bytedToken=${encodeURIComponent(token)}&resultCode=10000`,
  );
  expect(success.status).toBe(200);
  const html = await success.text();
  expect(html).toContain('AUTH_COMPLETED');
  expect(html).toContain('请返回电脑查看真人素材组');
  expect(html).not.toContain(token);
  expect(html).not.toMatch(/group-|BytedToken|H5Link/);
  expect((await f.authentication.get(f.actor, id)).state).toBe('completed');
});
it('bounds the public pipeline before database admission and does not retain pending work after excess random sessions', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let started = 0;
  const get = f.store.authentication.get.bind(f.store.authentication);
  const probe = vi.spyOn(f.store.authentication, 'get').mockImplementation(async (...args) => {
    if (++started === 4) entered.resolve();
    await release.promise;
    return get(...args);
  });
  const running = Array.from({ length: 4 }, () =>
    fetch(`${f.base}/api/v1/materials/auth-sessions/${randomUUID()}/launch`),
  );
  await entered.promise;
  const excess = await Promise.all(
    Array.from({ length: 8 }, () =>
      fetch(`${f.base}/api/v1/materials/auth-sessions/${randomUUID()}/launch`),
    ),
  );
  expect(
    excess.every(
      (response) => response.status === 429 && response.headers.get('retry-after') === '3',
    ),
  ).toBe(true);
  expect(probe).toHaveBeenCalledTimes(4);
  release.resolve();
  expect((await Promise.all(running)).every((response) => response.status === 404)).toBe(true);
  expect(f.authTransport).not.toHaveBeenCalled();
});
it('releases material metadata pool even if its authentication consumer close rejects', async () => {
  const f = await fixture();
  const store = await createMaterialStore(f.database.url);
  const close = vi.spyOn(store, 'close');
  const service = createMaterialService(
    store,
    f.provider,
    createMaterialUpstream(f.transport),
    undefined,
    async () => {
      throw new Error('AUTH_CLOSE_FIXTURE');
    },
  );
  await expect(service.close()).rejects.toThrow('Material domain cleanup failed');
  expect(close).toHaveBeenCalledTimes(1);
});

it('cleans expired authentication during service startup and keeps old session proof across close/restart', async () => {
  const f = await fixture();
  const pending = await f.authentication.create(f.actor, randomUUID(), 'materials', 'materials');
  await f.pool.query(
    "UPDATE mio_material_auth_sessions SET created_at=created_at-interval '21 minutes',expires_at=expires_at-interval '21 minutes' WHERE id=$1",
    [pending.sessionId],
  );
  await f.authentication.close();
  const { createMaterialAuthService } = await import('../../src/materials/auth-service.ts');
  const { createMaterialAuthUpstream } =
    await import('../../src/integrations/onelink/materials.ts');
  const restarted = await createMaterialAuthService(
    f.store.authentication,
    f.provider,
    createMaterialAuthUpstream(f.authTransport),
    f.origin,
  );
  try {
    expect(await restarted.get(f.actor, pending.sessionId)).toMatchObject({ state: 'expired' });
    expect((await f.store.authentication.get(pending.sessionId)).ciphertext).toBeNull();
  } finally {
    await restarted.close();
  }
});

it('keeps the owner recovery endpoint private with strict empty JSON and no public tunnel bypass', async () => {
  const f = await fixture();
  const view = await f.authentication.create(f.actor, randomUUID(), 'materials', 'materials');
  const path = `/api/v1/materials/auth-sessions/${view.sessionId}/refresh`;
  expect((await f.request(path, {}, { cookie: '' })).status).toBe(401);
  expect((await f.request(path, { token: 'forged' })).status).toBe(400);
  expect((await fetch(f.base + path)).status).toBe(405);
  const result = await f.request(path, {});
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ state: 'completed', sessionId: view.sessionId });
});
