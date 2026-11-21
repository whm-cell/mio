import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, it, onTestFinished } from 'vitest';
import { materialFixture, envelope } from './fixture.ts';
import { createMaterialHandler } from '../../src/materials/http.ts';

it('enforces Cookie/Origin/JSON/strict fields, owner filtering, pagination and fixed public views at HTTP', async () => {
  const f = await materialFixture();
  onTestFinished(() => f.close());
  const origin = 'https://client.example';
  const handler = createMaterialHandler(
    f.service,
    async (headers) =>
      headers.get('cookie') === 'session=owner'
        ? f.actor
        : headers.get('cookie') === 'session=other'
          ? { userId: 'other', sessionId: 'other' }
          : null,
    [origin],
  );
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error();
  const base = `http://127.0.0.1:${address.port}/api/v1/materials`;
  const call = (
    path: string,
    method = 'GET',
    value?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        origin,
        cookie: 'session=owner',
        ...(value !== undefined ? { 'content-type': 'application/json' } : {}),
        ...extra,
      },
      ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
    });
  expect(
    (await call('/groups', 'GET', undefined, { cookie: '', authorization: 'Bearer service-token' }))
      .status,
  ).toBe(401);
  expect((await call('/groups', 'POST', {}, { origin: 'https://evil.example' })).status).toBe(403);
  expect(
    (await call('/groups', 'POST', { requestId: randomUUID(), type: 'real', name: 'Forged' }))
      .status,
  ).toBe(400);
  expect(
    (
      await call('/groups', 'POST', {
        requestId: randomUUID(),
        type: 'aigc',
        name: 'Forged',
        owner: 'other',
      })
    ).status,
  ).toBe(400);
  expect((await call('/groups?limit=0')).status).toBe(400);
  expect((await call('/groups?limit=2&limit=3')).status).toBe(400);
  const invalid = Buffer.from(
    JSON.stringify({ createdAt: '2026-11-20T00:00:00.000000Z', id: '-'.repeat(36) }),
  ).toString('base64url');
  expect((await call(`/groups?cursor=${invalid}`)).status).toBe(400);
  const created = await call('/groups', 'POST', {
    requestId: randomUUID(),
    type: 'aigc',
    name: 'HTTP Group',
  });
  expect(created.status).toBe(201);
  const result = (await created.json()) as {
    group: { groupId: string; revision: number };
    operation: { operationId: string };
  };
  expect(result).toMatchObject({ group: { state: 'ready' }, operation: { state: 'succeeded' } });
  expect(JSON.stringify(result)).not.toMatch(
    /upstream|apiKey|ciphertext|nonce|synthetic-material-private-key/,
  );
  const id = result.group.groupId;
  expect((await call(`/groups/${id}`, 'GET', undefined, { cookie: 'session=other' })).status).toBe(
    404,
  );
  expect((await call(`/groups/${id}`, 'DELETE')).status).toBe(405);
  const detail = await call(`/groups/${id}`);
  expect(detail.headers.get('cache-control')).toBe('no-store');
  expect(detail.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  const renamed = await call(`/groups/${id}`, 'PATCH', { revision: 1, name: 'Confirmed' });
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({ name: 'Confirmed', revision: 2 });
  const operation = await call(`/operations/${result.operation.operationId}`);
  expect(await operation.json()).toMatchObject({
    operationId: result.operation.operationId,
    state: 'succeeded',
  });
  const group = await f.store.ownedGroup(f.actor.userId, id);
  f.add(group.upstream_group_id!);
  expect((await call(`/groups/${id}/sync`, 'POST', {})).status).toBe(200);
  const row = (await f.store.materials(f.actor.userId, id, 20))[0]!;
  f.override(async (action) =>
    action === 'GetAsset' ? envelope(action, {}, 403, 'Forbidden') : undefined,
  );
  expect((await call(`/items/${row.id}/refresh`, 'POST', {})).status).toBe(403);
  const limited = await call(`/items/${row.id}/refresh`, 'POST', {});
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBe('4');
  const denied = await call(`/items/${row.id}/refresh`, 'POST', {
    url: 'https://untrusted.example',
  });
  expect(denied.status).toBe(400);
  expect(await denied.json()).toMatchObject({
    error: { code: 'BODY_INVALID', message: 'BODY_INVALID', requestId: expect.any(String) },
  });
  expect(
    (
      await call(`/items/${row.id}/delete`, 'POST', {
        requestId: randomUUID(),
        revision: row.revision,
        scope: 'local',
      })
    ).status,
  ).toBe(200);
  const blockedDelete = await call(`/groups/${id}/delete`, 'POST', {
    requestId: randomUUID(),
    revision: group.revision,
    scope: 'upstream',
  });
  expect(blockedDelete.status).toBe(409);
  expect(await blockedDelete.json()).toMatchObject({ error: { code: 'RESOURCE_IN_USE' } });
  expect(f.items.has(row.upstream_asset_id!)).toBe(true);
  expect(f.groups.has(group.upstream_group_id!)).toBe(true);
  expect((await f.store.ownedGroup(f.actor.userId, id)).state).toBe('ready');
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=DeleteAssetGroup')),
  ).toHaveLength(0);
  const deleteBody = { requestId: randomUUID(), revision: group.revision, scope: 'upstream' };
  const deletePath = `/groups/${id}/delete`;
  for (const confirmCascade of ['true', 1, null, {}])
    expect((await call(deletePath, 'POST', { ...deleteBody, confirmCascade })).status).toBe(400);
  expect((await call(deletePath, 'POST', { ...deleteBody, confirmCascade: false })).status).toBe(
    409,
  );
  expect(
    (await call(deletePath, 'POST', { ...deleteBody, scope: 'local', confirmCascade: true }))
      .status,
  ).toBe(400);
  expect(
    (await call(`/items/${row.id}/delete`, 'POST', { ...deleteBody, confirmCascade: false }))
      .status,
  ).toBe(400);
  const confirmed = { ...deleteBody, confirmCascade: true };
  expect(
    (await call(deletePath, 'POST', { ...confirmed, upstreamGroupId: 'spoofed' })).status,
  ).toBe(400);
  expect(
    (await call(deletePath, 'POST', confirmed, { origin: 'https://evil.example' })).status,
  ).toBe(403);
  expect((await call(deletePath, 'POST', confirmed, { cookie: 'session=other' })).status).toBe(404);
  expect((await call(deletePath, 'POST', confirmed, { cookie: '' })).status).toBe(401);
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=DeleteAssetGroup')),
  ).toHaveLength(0);

  f.add(group.upstream_group_id!, 2);
  expect((await call(`/groups/${id}/sync`, 'POST', {})).status).toBe(200);
  const deleted = await call(deletePath, 'POST', confirmed);
  expect(deleted.status).toBe(200);
  const deletion = (await deleted.json()) as {
    operation: { operationId: string; resultLocalId: string };
  };
  expect(deletion).toMatchObject({
    operation: { kind: 'delete_group_upstream', state: 'succeeded', resultLocalId: id },
  });
  expect(await (await call(deletePath, 'POST', confirmed)).json()).toEqual(deletion);
  expect((await call(deletePath, 'POST', deleteBody)).status).toBe(409);
  expect((await call(`/groups/${id}`)).status).toBe(404);
  expect(f.groups.has(group.upstream_group_id!)).toBe(false);
  expect(f.items.size).toBe(0);
  expect(await (await call(`/operations/${deletion.operation.operationId}`)).json()).toEqual(
    deletion.operation,
  );
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=DeleteAssetGroup')),
  ).toHaveLength(1);
});

it('pages equal-microsecond rows without dropping records or exposing database cursors', async () => {
  const f = await materialFixture();
  onTestFinished(() => f.close());
  const group = await f.create();
  for (let i = 1; i <= 5; i++) f.add(group.upstreamId, i);
  await f.service.sync(f.actor, group.groupId);
  await f.pool.query(
    "UPDATE mio_materials SET created_at='2026-11-20T00:00:00.123456Z' WHERE group_id=$1",
    [group.groupId],
  );
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const result = await f.service.materials(f.actor, group.groupId, 2, cursor);
    ids.push(...result.items.map((row) => (row as { materialId: string }).materialId));
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  expect(ids).toHaveLength(5);
  expect(new Set(ids).size).toBe(5);
  // Distinct PostgreSQL microseconds that collapse to the same JS millisecond remain ordered.
  await f.pool.query(
    "UPDATE mio_materials SET created_at='2026-11-20T00:00:00.123'::timestamptz + (substring(upstream_asset_id from 20 for 1)::int * interval '1 microsecond') WHERE group_id=$1",
    [group.groupId],
  );
  cursor = undefined;
  const distinct: string[] = [];
  do {
    const result = await f.service.materials(f.actor, group.groupId, 2, cursor);
    distinct.push(...result.items.map((row) => (row as { materialId: string }).materialId));
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  expect(distinct).toHaveLength(5);
  expect(new Set(distinct).size).toBe(5);
});
