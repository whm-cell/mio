import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, it, onTestFinished, vi } from 'vitest';
import { materialAuthFixture } from './auth-fixture.ts';
import { materialAuthSchemaSQL } from '../../src/materials/auth-schema.ts';
import { createMaterialAuthService } from '../../src/materials/auth-service.ts';
import { createMaterialHandler } from '../../src/materials/http.ts';
import { createMaterialService } from '../../src/materials/service.ts';
import { createMaterialStore } from '../../src/materials/store.ts';
import {
  createMaterialAuthUpstream,
  createMaterialUpstream,
} from '../../src/integrations/onelink/materials.ts';
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
  return { ...f, base, desktopOrigin: origin, request };
}
it('exposes the exact launch publicly while authenticated routes preserve Cookie/Origin/strict input', async () => {
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
  const refresh = `${f.base}/api/v1/materials/auth-sessions/${id}/refresh`;
  const preflight = await fetch(refresh, {
    method: 'OPTIONS',
    headers: { origin: f.desktopOrigin },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
  const getRefresh = await fetch(refresh);
  expect(getRefresh.status).toBe(405);
  expect(getRefresh.headers.get('allow')).toBe('POST, OPTIONS');
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
});

it('accepts supplier extras while binding public completion to the original session, owner and verified group', async () => {
  const f = await fixture();
  const created = await f.request('/api/v1/materials/auth-sessions', {
    requestId: randomUUID(),
    source: 'materials',
    returnTarget: 'materials',
  });
  expect(created.status).toBe(201);
  const { sessionId } = (await created.json()) as { sessionId: string };
  const [token, upstream] = [...f.tokens.entries()][0]!;
  const sessionPath = `/api/v1/materials/auth-sessions/${sessionId}`;
  const endpoint = `${f.base}${sessionPath}/complete`;
  const proof = `bytedToken=${encodeURIComponent(token)}`;
  const extras = new URLSearchParams({
    ownerId: 'ignored-owner',
    GroupId: 'ignored-group',
    state: 'failed',
    returnTarget: 'https://ignored-target.example.test/',
  });
  extras.append('supplier', 'ignored-value');
  extras.append('supplier', '');

  const failures = [
    ['', 'AUTH_PROOF_INVALID'],
    ['bytedToken=another-synthetic-token', 'AUTH_PROOF_INVALID'],
    [`${proof}&%62ytedToken=`, 'AUTH_QUERY_INVALID'],
    [`${proof}&resultCode=10000&result%43ode=`, 'AUTH_QUERY_INVALID'],
    [`${proof}&resultCode=`, 'AUTH_QUERY_INVALID'],
    [`${proof}&resultCode=10001`, 'AUTH_RESULT_UNCONFIRMED'],
    [`${proof}&padding=${'a'.repeat(8192)}`, 'AUTH_QUERY_INVALID'],
  ];
  for (const [query, code] of failures) {
    const invalid = await fetch(`${endpoint}?${query}&${extras}`);
    expect(invalid.status).toBe(400);
    const html = await invalid.text();
    expect(html).toContain(code);
    expect(html).not.toContain(token);
  }
  expect((await fetch(`${endpoint}?${proof}&${extras}`, { method: 'POST' })).status).toBe(405);
  expect((await fetch(`${endpoint}/extra?${proof}&${extras}`)).status).toBe(404);
  expect(f.authTransport).toHaveBeenCalledTimes(1);
  expect(await f.store.authentication.get(sessionId, f.actor.userId)).toMatchObject({
    state: 'pending',
    query_count: 0,
  });

  const success = await fetch(`${endpoint}?${proof}&resultCode=10000&${extras}`);
  expect(success.status).toBe(200);
  const html = await success.text();
  expect(html).toContain('AUTH_COMPLETED');
  expect(html).toContain('请返回电脑查看真人素材组');
  expect(html).toContain('href="/materials"');
  expect(html).not.toContain(token);
  expect(html).not.toMatch(/group-|BytedToken|H5Link|ignored-/);
  expect(f.authTransport).toHaveBeenCalledTimes(3);
  const ownerSession = await f.request(sessionPath);
  expect(ownerSession.status).toBe(200);
  const view = (await ownerSession.json()) as { groupId: string };
  expect(view).toMatchObject({ sessionId, state: 'completed', groupId: expect.any(String) });
  const groups = await f.request('/api/v1/materials/groups?type=real');
  expect(groups.status).toBe(200);
  expect(await groups.json()).toMatchObject({
    items: [{ groupId: view.groupId, type: 'real', authStatus: 'verified' }],
  });
  expect(await f.store.ownedGroup(f.actor.userId, view.groupId)).toMatchObject({
    upstream_group_id: upstream.group,
    source_session_id: sessionId,
  });
  expect(await f.store.authentication.get(sessionId, f.actor.userId)).toMatchObject({
    cipher_format: null,
    master_key_id: null,
    nonce: null,
    ciphertext: null,
    auth_tag: null,
  });
  const refreshed = await f.request(`${sessionPath}/refresh`, {});
  expect(refreshed.status).toBe(200);
  expect(await refreshed.json()).toEqual(view);
  const replay = await fetch(`${endpoint}?${proof}&${extras}`);
  expect(replay.status).toBe(200);
  expect(await replay.text()).toBe(html);
  expect(f.authTransport).toHaveBeenCalledTimes(3);

  await f.authentication.close();
  const reopenedStore = await createMaterialStore(f.database.url, true);
  try {
    const restarted = createMaterialAuthService(
      reopenedStore.authentication,
      f.provider,
      createMaterialAuthUpstream(f.authTransport),
      f.origin,
    );
    try {
      expect(await restarted.get(f.actor, sessionId)).toEqual(view);
      expect(await restarted.refresh(f.actor, sessionId)).toEqual(view);
      expect(await reopenedStore.ownedGroup(f.actor.userId, view.groupId)).toMatchObject({
        group_type: 'real',
        auth_status: 'verified',
      });
      expect(f.authTransport).toHaveBeenCalledTimes(3);
    } finally {
      await restarted.close();
    }
  } finally {
    await reopenedStore.close();
  }
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

it('cleans existing auth sessions at startup and on the timer without public routes or new audit columns', async () => {
  const f = await fixture();
  const first = await f.authentication.create(f.actor, randomUUID(), 'materials', 'materials');
  const second = await f.authentication.create(f.actor, randomUUID(), 'materials', 'materials');
  await f.authentication.close();
  await f.pool.query(
    `ALTER TABLE mio_material_auth_sessions
      DROP COLUMN upstream_create_request_id,
      DROP COLUMN upstream_result_request_id,
      DROP COLUMN upstream_group_request_id`,
  );
  await expect(createMaterialStore(f.database.url, true)).rejects.toThrow('MATERIAL_SCHEMA');
  const expireFixture = (id: string) =>
    f.pool.query(
      "UPDATE mio_material_auth_sessions SET created_at=created_at-interval '21 minutes',expires_at=expires_at-interval '21 minutes' WHERE id=$1",
      [id],
    );
  const storedRow = async (id: string) =>
    (await f.pool.query('SELECT * FROM mio_material_auth_sessions WHERE id=$1', [id])).rows[0];
  await expireFixture(first.sessionId);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    const storeWithoutPublicAuth = await createMaterialStore(f.database.url);
    try {
      expect(await storedRow(first.sessionId)).toMatchObject({
        state: 'expired',
        ciphertext: null,
      });
      expect(await storedRow(second.sessionId)).toMatchObject({
        state: 'pending',
        ciphertext: expect.any(Buffer),
      });
      await expireFixture(second.sessionId);
      const expire = vi.spyOn(storeWithoutPublicAuth.authentication, 'expire');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(expire).toHaveBeenCalledTimes(1);
      await expire.mock.results[0]!.value;
      expect(await storedRow(second.sessionId)).toMatchObject({
        state: 'expired',
        ciphertext: null,
        token_digest: expect.any(String),
      });
    } finally {
      await storeWithoutPublicAuth.close();
    }
  } finally {
    vi.useRealTimers();
  }
  const beforeMigration = await storedRow(second.sessionId);
  await f.pool.query(materialAuthSchemaSQL);
  const upgraded = await createMaterialStore(f.database.url, true);
  try {
    expect(await storedRow(second.sessionId)).toEqual({
      ...beforeMigration,
      upstream_create_request_id: null,
      upstream_result_request_id: null,
      upstream_group_request_id: null,
    });
    expect(f.authTransport).toHaveBeenCalledTimes(2);
  } finally {
    await upgraded.close();
  }
});

it('keeps the owner recovery endpoint private with strict empty JSON and no public tunnel bypass', async () => {
  const f = await fixture();
  const view = await f.authentication.create(f.actor, randomUUID(), 'materials', 'materials');
  const path = `/api/v1/materials/auth-sessions/${view.sessionId}/refresh`;
  expect((await f.request(path, {}, { cookie: '' })).status).toBe(401);
  expect((await f.request(path, { token: 'forged' })).status).toBe(400);
  expect((await fetch(f.base + path)).status).toBe(405);

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.authOverride(async (action) => {
    if (action === 'GetVisualValidateResult') {
      entered.resolve();
      await release.promise;
    }
    return undefined;
  });
  const inFlight = f.request(path, {});
  try {
    await Promise.race([entered.promise, inFlight]);
    const limited = await f.request(path, {});
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('3');
    expect(await limited.json()).toMatchObject({ error: { code: 'AUTH_QUERY_LIMITED' } });
  } finally {
    release.resolve();
  }
  const result = await inFlight;
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ state: 'completed', sessionId: view.sessionId });
});

it.each(['callback', 'owner refresh'] as const)(
  'reports expiry through %s when the deadline passes before claiming verification',
  async (entry) => {
    const f = await fixture();
    const view = await f.authentication.create(f.actor, randomUUID(), 'materials', 'materials');
    const store = f.store.authentication;
    const claim = store.claim.bind(store);
    const beforeClaim = vi.spyOn(store, 'claim').mockImplementationOnce(async (row) => {
      expect(row.state).toBe('pending');
      await f.pool.query(
        "UPDATE mio_material_auth_sessions SET created_at=created_at-interval '21 minutes',expires_at=expires_at-interval '21 minutes' WHERE id=$1",
        [row.id],
      );
      return claim(row);
    });
    const path = `/api/v1/materials/auth-sessions/${view.sessionId}`;
    const proof = new URLSearchParams({
      bytedToken: [...f.tokens.keys()][0]!,
      resultCode: '10000',
    });
    const response =
      entry === 'callback'
        ? await fetch(`${f.base}${path}/complete?${proof}`)
        : await f.request(`${path}/refresh`, {});

    expect(response.status).toBe(410);
    expect(response.headers.get('retry-after')).toBeNull();
    if (entry === 'callback') expect(await response.text()).toContain('AUTH_EXPIRED');
    else expect(await response.json()).toMatchObject({ error: { code: 'AUTH_EXPIRED' } });
    expect(beforeClaim).toHaveBeenCalledTimes(1);
    expect(f.authTransport).toHaveBeenCalledTimes(1);
    const stored = (
      await f.pool.query('SELECT * FROM mio_material_auth_sessions WHERE id=$1', [view.sessionId])
    ).rows[0];
    expect(stored).toMatchObject({
      state: 'expired',
      error_code: 'AUTH_EXPIRED',
      lease_id: null,
      query_count: 0,
      ciphertext: null,
      token_digest: expect.any(String),
    });
  },
);
