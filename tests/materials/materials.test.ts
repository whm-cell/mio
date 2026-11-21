import { randomUUID } from 'node:crypto';
import { sha256Utf8 } from '@mio/foundation/hash';
import { afterEach, expect, it, vi } from 'vitest';
import { materialFixture, envelope } from './fixture.ts';
import type { MaterialFixture } from './fixture.ts';
import { createMaterialStore } from '../../src/materials/store.ts';
import { createMaterialService } from '../../src/materials/service.ts';
import { createMaterialUpstream } from '../../src/integrations/onelink/materials.ts';

const fixtures: MaterialFixture[] = [];
async function fixture() {
  const f = await materialFixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});

it('creates with account credentials without catalog/model admission, rotates without changing ownership and reads locally offline', async () => {
  const f = await fixture();
  const snapshot = await f.provider.snapshotAccount(f.actor.userId);
  expect(f.provider.openAccountSnapshot(f.actor.userId, snapshot)).toBe(
    'synthetic-material-private-key',
  );
  expect(() => f.provider.openAccountSnapshot('other-owner', snapshot)).toThrow();
  const group = await f.create();
  const open = vi.spyOn(f.provider, 'openAccountSnapshot');
  const before = f.transport.mock.calls.length;
  expect(await f.service.group(f.actor, group.groupId)).toMatchObject({
    groupId: group.groupId,
    state: 'ready',
  });
  expect(await f.service.groups(f.actor, undefined, 20)).toMatchObject({
    items: [{ groupId: group.groupId }],
    nextCursor: null,
  });
  expect(open).not.toHaveBeenCalled();
  expect(f.transport).toHaveBeenCalledTimes(before);
  await f.provider.save(f.actor, (await f.provider.get(f.actor))!.revision, 'rotated-material-key');
  await f.service.sync(f.actor, group.groupId);
  expect(f.transport.mock.calls.at(-1)![1]?.headers).toMatchObject({
    authorization: 'Bearer rotated-material-key',
  });
  expect((await f.store.ownedGroup(f.actor.userId, group.groupId)).provider_config_id).toBe(
    snapshot.providerConfigId,
  );
  await f.pool.query(
    "UPDATE mio_provider_configs SET credential_auth_state='rejected' WHERE id=$1",
    [snapshot.providerConfigId],
  );
  await expect(f.service.sync(f.actor, group.groupId)).rejects.toMatchObject({
    code: 'PROVIDER_UNAVAILABLE',
  });
  expect(await f.service.group(f.actor, group.groupId)).toHaveProperty('state', 'ready');
});

it('deduplicates same request and input, rejects different input and never discovers or rebinds a globally colliding group', async () => {
  const f = await fixture();
  const request = randomUUID();
  const [a, b] = await Promise.all([
    f.service.createGroup(f.actor, request, 'Same'),
    f.service.createGroup(f.actor, request, 'Same'),
  ]);
  expect(a.operation.operationId).toBe(b.operation.operationId);
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=CreateAssetGroup')),
  ).toHaveLength(1);
  await expect(f.service.createGroup(f.actor, request, 'Different')).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  const existing = (await f.service.groups(f.actor, undefined, 20)).items[0] as { groupId: string };
  const upstream = (await f.store.ownedGroup(f.actor.userId, existing.groupId)).upstream_group_id;
  const other = { userId: randomUUID(), sessionId: 'other' };
  await f.provider.save(other, 0, 'other-synthetic-key');
  f.override(async (action) =>
    action === 'CreateAssetGroup' ? envelope(action, { Id: upstream }) : undefined,
  );
  const collision = await f.service.createGroup(other, randomUUID(), 'Private');
  expect(collision.operation).toMatchObject({
    state: 'unknown',
    errorCode: 'UPSTREAM_RESOURCE_COLLISION',
  });
  expect(collision).not.toHaveProperty('group');
  await expect(f.service.group(other, existing.groupId)).rejects.toMatchObject({
    code: 'MATERIAL_NOT_FOUND',
  });
  expect(
    (
      await f.pool.query('SELECT owner_id FROM mio_material_groups WHERE upstream_group_id=$1', [
        upstream,
      ])
    ).rows,
  ).toEqual([{ owner_id: f.actor.userId }]);
});

it('persists creation intention, blocks local removal in flight, and leaves post-response database failure unknown without replay', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.override(async (action) => {
    if (action === 'CreateAssetGroup') {
      entered.resolve();
      await release.promise;
    }
    return;
  });
  const request = randomUUID();
  const creating = f.service.createGroup(f.actor, request, 'In flight');
  await entered.promise;
  const row = (
    await f.pool.query('SELECT * FROM mio_material_groups WHERE owner_id=$1', [f.actor.userId])
  ).rows[0];
  await expect(
    f.service.remove(f.actor, 'group', row.id, randomUUID(), row.revision, 'local'),
  ).rejects.toMatchObject({ code: 'MATERIAL_BUSY' });
  vi.spyOn(f.store, 'finishCreate').mockRejectedValueOnce(new Error('PG_COMMIT_LOST'));
  release.resolve();
  const result = await creating;
  expect(result.operation.state).toBe('unknown');
  const count = f.transport.mock.calls.length;
  expect((await f.service.createGroup(f.actor, request, 'In flight')).operation.state).toBe(
    'unknown',
  );
  expect(await f.service.operation(f.actor, result.operation.operationId)).toHaveProperty(
    'state',
    'succeeded',
  );
  expect(f.transport).toHaveBeenCalledTimes(count + 1);
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=CreateAssetGroup')),
  ).toHaveLength(1);
});

it('keeps lost-ID create unknown over restart and does not auto-submit when its lease expires', async () => {
  const f = await fixture();
  const credential = await f.provider.snapshotAccount(f.actor.userId);
  const { operation } = await f.store.beginCreate(
    f.actor.userId,
    randomUUID(),
    'a'.repeat(64),
    'Crash',
    credential,
  );
  await f.pool.query(
    "UPDATE mio_material_operations SET lease_until=now()-interval '1 second' WHERE id=$1",
    [operation.id],
  );
  const before = f.transport.mock.calls.length;
  const restarted = createMaterialService(
    await createMaterialStore(f.database.url),
    f.provider,
    createMaterialUpstream(f.transport),
  );
  try {
    expect(await restarted.operation(f.actor, operation.id)).toMatchObject({
      state: 'unknown',
      errorCode: 'UPSTREAM_RESULT_UNKNOWN',
    });
  } finally {
    await restarted.close();
  }
  expect(f.transport).toHaveBeenCalledTimes(before);
  expect((await f.store.ownedGroup(f.actor.userId, operation.target_group_id!)).state).toBe(
    'unknown',
  );
});

it('syncs only one owned group and one bounded page, preserves missing-page records and local tombstones', async () => {
  const f = await fixture();
  const group = await f.create();
  for (let i = 1; i <= 101; i++) f.add(group.upstreamId, i);
  const first = await f.service.sync(f.actor, group.groupId);
  expect(first).toMatchObject({ syncedCount: 100, nextCursor: '2' });
  const list = f.transport.mock.calls.find(([url]) => String(url).includes('Action=ListAssets'))!;
  expect(JSON.parse(String(list[1]?.body))).toEqual({
    Filter: { GroupIds: [group.upstreamId] },
    PageNumber: 1,
    PageSize: 100,
  });
  await f.service.sync(f.actor, group.groupId, '2');
  const all = (await f.service.materials(f.actor, group.groupId, 100)).items as {
    materialId: string;
    revision: number;
  }[];
  expect(all).toHaveLength(100);
  await f.service.remove(
    f.actor,
    'material',
    all[0]!.materialId,
    randomUUID(),
    all[0]!.revision,
    'local',
  );
  await f.service.sync(f.actor, group.groupId);
  expect(
    Number(
      (
        await f.pool.query(
          "SELECT count(*) FROM mio_materials WHERE group_id=$1 AND state<>'deleted'",
          [group.groupId],
        )
      ).rows[0].count,
    ),
  ).toBe(100);
  await expect(f.service.material(f.actor, all[0]!.materialId)).rejects.toMatchObject({
    code: 'MATERIAL_NOT_FOUND',
  });
  await f.service.sync(f.actor, group.groupId, '2');
  expect(
    (await f.pool.query('SELECT state FROM mio_materials WHERE id=$1', [all[0]!.materialId]))
      .rows[0].state,
  ).toBe('deleted');
  const other = { userId: 'other', sessionId: 'other' };
  const before = f.transport.mock.calls.length;
  await expect(f.service.sync(other, group.groupId)).rejects.toMatchObject({
    code: 'MATERIAL_NOT_FOUND',
  });
  expect(f.transport).toHaveBeenCalledTimes(before);
});

it('rejects cross-group items atomically and protects a globally colliding material owned by another user', async () => {
  const f = await fixture();
  const one = await f.create();
  const two = await f.create();
  const upstream = f.add(one.upstreamId);
  await f.service.sync(f.actor, one.groupId);
  f.override(async (action) =>
    action === 'ListAssets'
      ? envelope(action, {
          Items: [
            {
              Id: upstream,
              GroupId: one.upstreamId,
              Name: 'Wrong',
              AssetType: 'Image',
              Status: 'Active',
            },
          ],
          PageNumber: 1,
          PageSize: 100,
          TotalCount: 1,
        })
      : undefined,
  );
  await expect(f.service.sync(f.actor, two.groupId)).rejects.toMatchObject({
    code: 'UPSTREAM_RESPONSE_INVALID',
  });
  f.override(async (action) =>
    action === 'ListAssets'
      ? envelope(action, {
          Items: [
            {
              Id: upstream,
              GroupId: two.upstreamId,
              Name: 'Collision',
              AssetType: 'Image',
              Status: 'Active',
            },
          ],
          PageNumber: 1,
          PageSize: 100,
          TotalCount: 1,
        })
      : undefined,
  );
  await expect(f.service.sync(f.actor, two.groupId)).rejects.toMatchObject({
    code: 'UPSTREAM_RESOURCE_COLLISION',
  });
  expect((await f.service.materials(f.actor, two.groupId, 20)).items).toEqual([]);
  expect((await f.service.materials(f.actor, one.groupId, 20)).items).toHaveLength(1);
});

it('validates a late sync lease in the same transaction as all writes and does not resurrect local removal', async () => {
  const f = await fixture();
  const group = await f.create();
  f.add(group.upstreamId);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.override(async (action) => {
    if (action === 'ListAssets') {
      entered.resolve();
      await release.promise;
    }
    return;
  });
  const syncing = f.service.sync(f.actor, group.groupId);
  await entered.promise;
  await expect(
    f.service.rename(f.actor, group.groupId, group.revision, 'Race'),
  ).rejects.toMatchObject({ code: 'MATERIAL_BUSY' });
  await f.pool.query(
    "UPDATE mio_material_groups SET sync_lease_until=now()-interval '1 second' WHERE id=$1",
    [group.groupId],
  );
  expect(
    await f.service.remove(f.actor, 'group', group.groupId, randomUUID(), group.revision, 'local'),
  ).toMatchObject({
    group: {
      state: 'deleted',
      lastSyncStatus: 'failed',
      lastSyncErrorCode: 'MATERIAL_SYNC_LEASE_EXPIRED',
    },
  });
  release.resolve();
  await expect(syncing).rejects.toMatchObject({ code: 'MATERIAL_OPERATION_SUPERSEDED' });
  expect(
    (await f.pool.query('SELECT count(*) FROM mio_materials WHERE group_id=$1', [group.groupId]))
      .rows[0].count,
  ).toBe('0');
  expect(
    (
      await f.pool.query('SELECT state,last_sync_status FROM mio_material_groups WHERE id=$1', [
        group.groupId,
      ])
    ).rows[0],
  ).toMatchObject({ state: 'deleted' });
});

it('reports expired sync locally and fences its response from the next rename lease', async () => {
  const f = await fixture();
  const group = await f.create();
  const prior = (await f.service.sync(f.actor, group.groupId)).group;
  expect(prior.lastSyncedAt).toEqual(expect.any(String));
  f.add(group.upstreamId);
  const listStarted = Promise.withResolvers<void>();
  const finishList = Promise.withResolvers<void>();
  const renameStarted = Promise.withResolvers<void>();
  const finishRename = Promise.withResolvers<void>();
  f.override(async (action) => {
    if (action === 'ListAssets') {
      listStarted.resolve();
      await finishList.promise;
    }
    if (action === 'UpdateAssetGroup') {
      renameStarted.resolve();
      await finishRename.promise;
    }
  });
  const syncing = f.service.sync(f.actor, group.groupId);
  let renaming: Promise<unknown> | undefined;
  try {
    await listStarted.promise;
    expect(await f.service.group(f.actor, group.groupId)).toMatchObject({
      lastSyncStatus: 'running',
      lastSyncedAt: prior.lastSyncedAt,
    });
    await f.pool.query(
      "UPDATE mio_material_groups SET sync_lease_until=now()-interval '1 second' WHERE id=$1",
      [group.groupId],
    );
    const expired = {
      lastSyncStatus: 'failed',
      lastSyncErrorCode: 'MATERIAL_SYNC_LEASE_EXPIRED',
      lastSyncedAt: prior.lastSyncedAt,
    };
    const calls = f.transport.mock.calls.length;
    expect(await f.service.group(f.actor, group.groupId)).toMatchObject(expired);
    expect((await f.service.groups(f.actor, undefined, 20)).items).toMatchObject([expired]);
    expect(f.transport).toHaveBeenCalledTimes(calls);

    renaming = f.service.rename(f.actor, group.groupId, group.revision, 'New lease');
    await renameStarted.promise;
    expect(await f.service.group(f.actor, group.groupId)).toMatchObject(expired);
    finishList.resolve();
    await expect(syncing).rejects.toMatchObject({ code: 'MATERIAL_OPERATION_SUPERSEDED' });
    await expect(f.service.sync(f.actor, group.groupId)).rejects.toMatchObject({
      code: 'MATERIAL_BUSY',
    });
    finishRename.resolve();
    expect(await renaming).toMatchObject({ ...expired, name: 'New lease' });
    expect(await f.service.materials(f.actor, group.groupId, 20)).toMatchObject({ items: [] });
  } finally {
    finishList.resolve();
    finishRename.resolve();
    await Promise.allSettled([syncing, renaming]);
  }
});

it('claims revision before remote rename and refuses stale revision without remote side effects', async () => {
  const f = await fixture();
  const group = await f.create();
  const beforeSync = await f.store.ownedGroup(f.actor.userId, group.groupId);
  const renamed = await f.service.rename(f.actor, group.groupId, group.revision, 'Renamed');
  expect(renamed).toMatchObject({ name: 'Renamed', revision: 2, lastSyncStatus: null });
  expect(f.groups.get(group.upstreamId)).toBe('Renamed');
  const before = f.transport.mock.calls.length;
  await expect(f.service.rename(f.actor, group.groupId, 1, 'Old')).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
  expect(f.transport).toHaveBeenCalledTimes(before);
  f.override(async (action) => {
    if (action === 'UpdateAssetGroup') throw new Error('SOCKET_LOST');
    return;
  });
  await expect(f.service.rename(f.actor, group.groupId, 2, 'Unknown')).rejects.toMatchObject({
    code: 'UPSTREAM_RESULT_UNKNOWN',
  });
  expect(await f.service.group(f.actor, group.groupId)).toMatchObject({
    name: 'Renamed',
    revision: 2,
    lastSyncStatus: null,
    lastSyncErrorCode: null,
    lastSyncedAt: null,
  });
  expect(await f.store.ownedGroup(f.actor.userId, group.groupId)).toMatchObject({
    last_sync_attempt_at: beforeSync.last_sync_attempt_at,
    sync_cursor: beforeSync.sync_cursor,
    sync_lease_id: null,
  });
});

it('preserves a real sync failure summary through successful and failed rename and refresh attempts', async () => {
  const f = await fixture();
  const group = await f.create();
  f.add(group.upstreamId);
  const first = (await f.service.sync(f.actor, group.groupId)).group;
  const row = (await f.store.materials(f.actor.userId, group.groupId, 20))[0]!;
  f.override(async (action) =>
    action === 'ListAssets' ? envelope(action, {}, 429, 'RateLimit') : undefined,
  );
  await expect(f.service.sync(f.actor, group.groupId, '2')).rejects.toMatchObject({
    code: 'UPSTREAM_RATE_LIMITED',
  });
  const failed = await f.store.ownedGroup(f.actor.userId, group.groupId);
  const summary = {
    lastSyncStatus: 'failed',
    lastSyncErrorCode: 'UPSTREAM_RATE_LIMITED',
    lastSyncedAt: first.lastSyncedAt,
  };
  f.override(undefined);
  const renamed = await f.service.rename(f.actor, group.groupId, group.revision, 'After failure');
  expect(renamed).toMatchObject(summary);
  expect(await f.service.refresh(f.actor, row.id)).toMatchObject({ state: 'active' });
  await f.pool.query('UPDATE mio_materials SET next_query_at=NULL WHERE id=$1', [row.id]);
  f.override(async (action) =>
    ['GetAsset', 'UpdateAssetGroup'].includes(action)
      ? envelope(action, {}, 403, 'AccessDenied')
      : undefined,
  );
  await expect(
    f.service.rename(f.actor, group.groupId, renamed.revision, 'Denied'),
  ).rejects.toMatchObject({
    code: 'PROVIDER_RESOURCE_FORBIDDEN',
  });
  await expect(f.service.refresh(f.actor, row.id)).rejects.toMatchObject({
    code: 'PROVIDER_RESOURCE_FORBIDDEN',
  });
  expect(await f.service.group(f.actor, group.groupId)).toMatchObject(summary);
  expect(await f.store.ownedGroup(f.actor.userId, group.groupId)).toMatchObject({
    sync_cursor: '2',
    last_sync_attempt_at: failed.last_sync_attempt_at,
    sync_lease_id: null,
    sync_lease_until: null,
  });
});

it('stores exact supplier failure and projects only historically observed Failed rows from unknown', async () => {
  const f = await fixture();
  const group = await f.create();
  const failed = f.add(group.upstreamId, 1, 'Failed');
  const unknown = f.add(group.upstreamId, 2, 'FutureStatus');
  const rejected = f.add(group.upstreamId, 3, 'Rejected');
  await f.service.sync(f.actor, group.groupId);
  const rows = await f.store.materials(f.actor.userId, group.groupId, 20);
  const failedRow = rows.find((item) => item.upstream_asset_id === failed)!;
  const unknownRow = rows.find((item) => item.upstream_asset_id === unknown)!;
  const rejectedRow = rows.find((item) => item.upstream_asset_id === rejected)!;
  expect(failedRow).toMatchObject({ state: 'failed', error_code: 'UPSTREAM_MATERIAL_FAILED' });
  expect(unknownRow).toMatchObject({ state: 'unknown', error_code: null });
  expect(rejectedRow).toMatchObject({ state: 'rejected', error_code: null });
  for (const id of [failedRow.id, unknownRow.id]) {
    await f.pool.query(
      "UPDATE mio_materials SET state='unknown',upstream_status='Failed',error_code=$2 WHERE id=$1",
      [id, id === unknownRow.id ? 'UPSTREAM_RESULT_UNKNOWN' : null],
    );
  }
  const expected = { state: 'failed', errorCode: 'UPSTREAM_MATERIAL_FAILED' };
  expect(await f.service.material(f.actor, failedRow.id)).toMatchObject(expected);
  expect((await f.service.materials(f.actor, group.groupId, 20)).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ materialId: failedRow.id, ...expected }),
      expect.objectContaining({
        materialId: unknownRow.id,
        state: 'unknown',
        errorCode: 'UPSTREAM_RESULT_UNKNOWN',
      }),
    ]),
  );
  // A later observation also replaces the old classification and clears its local error.
  f.items.get(failed)!.Status = 'Active';
  f.items.get(unknown)!.Status = 'Failed';
  await f.service.sync(f.actor, group.groupId);
  expect(await f.service.material(f.actor, failedRow.id)).toMatchObject({
    state: 'active',
    errorCode: null,
  });
  expect(await f.store.ownedMaterial(f.actor.userId, unknownRow.id)).toMatchObject({
    state: 'failed',
    error_code: expected.errorCode,
  });
});

it('refreshes under persistent cooldown, preserves 403 resources and only marks exact 404 after group access', async () => {
  const f = await fixture();
  const group = await f.create();
  const upstream = f.add(group.upstreamId);
  await f.service.sync(f.actor, group.groupId);
  const row = (await f.store.materials(f.actor.userId, group.groupId, 20))[0]!;
  f.override(async (action) =>
    action === 'GetAsset' ? envelope(action, {}, 403, 'AccessDenied') : undefined,
  );
  await expect(f.service.refresh(f.actor, row.id)).rejects.toMatchObject({
    status: 403,
    code: 'PROVIDER_RESOURCE_FORBIDDEN',
  });
  const calls = f.transport.mock.calls.length;
  await expect(f.service.refresh(f.actor, row.id)).rejects.toMatchObject({
    status: 429,
    code: 'MATERIAL_QUERY_LIMITED',
  });
  expect(f.transport).toHaveBeenCalledTimes(calls);
  expect(await f.service.material(f.actor, row.id)).toHaveProperty('state', 'active');
  expect((await f.provider.snapshotAccount(f.actor.userId)).credentialVersion).toBe(1);
  const restarted = createMaterialService(
    await createMaterialStore(f.database.url),
    f.provider,
    createMaterialUpstream(f.transport),
  );
  try {
    await expect(restarted.refresh(f.actor, row.id)).rejects.toMatchObject({ status: 429 });
  } finally {
    await restarted.close();
  }
  await f.pool.query('UPDATE mio_materials SET next_query_at=NULL WHERE id=$1', [row.id]);
  f.override(undefined);
  f.items.delete(upstream);
  expect(await f.service.refresh(f.actor, row.id)).toMatchObject({
    state: 'deleted',
    errorCode: 'UPSTREAM_RESOURCE_NOT_FOUND',
  });
});

it('keeps local deletion offline and rejects nonempty group deletion without implicit cascade', async () => {
  const f = await fixture();
  const group = await f.create();
  f.add(group.upstreamId);
  await f.service.sync(f.actor, group.groupId);
  const before = f.transport.mock.calls.length;
  await expect(
    f.service.remove(f.actor, 'group', group.groupId, randomUUID(), group.revision, 'local'),
  ).rejects.toMatchObject({ code: 'RESOURCE_IN_USE' });
  const row = (await f.store.materials(f.actor.userId, group.groupId, 20))[0]!;
  await f.service.remove(f.actor, 'material', row.id, randomUUID(), row.revision, 'local');
  await f.service.remove(f.actor, 'group', group.groupId, randomUUID(), group.revision, 'local');
  expect(f.transport).toHaveBeenCalledTimes(before);
  expect(f.items.size).toBe(1);
  expect(f.groups.size).toBe(1);
});

it.each([
  ['sync lease', false],
  ['sync lease', true],
  ['unsettled operation', false],
  ['unsettled operation', true],
] as const)(
  'rejects remote group deletion with an active %s (confirmCascade=%s) before credentials or upstream access',
  async (scenario, confirmCascade) => {
    const f = await fixture();
    const group = await f.create();
    if (scenario === 'sync lease') {
      await f.store.claimGroup(f.actor.userId, group.groupId, undefined, '1');
    } else {
      f.add(group.upstreamId);
      await f.service.sync(f.actor, group.groupId);
      const material = (await f.store.materials(f.actor.userId, group.groupId, 20))[0]!;
      await f.store.beginDelete(
        f.actor.userId,
        randomUUID(),
        sha256Utf8(
          JSON.stringify({ id: material.id, revision: material.revision, scope: 'upstream' }),
        ),
        'material',
        material.id,
        material.revision,
        await f.provider.snapshotAccount(f.actor.userId),
      );
    }

    const snapshot = vi.spyOn(f.provider, 'snapshotAccount');
    const decrypt = vi.spyOn(f.provider, 'openAccountSnapshot');
    const before = f.transport.mock.calls.length;
    await expect(
      f.service.remove(
        f.actor,
        'group',
        group.groupId,
        randomUUID(),
        group.revision,
        'upstream',
        confirmCascade,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'MATERIAL_BUSY' });
    expect(snapshot).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(f.transport).toHaveBeenCalledTimes(before);
    expect(await f.service.group(f.actor, group.groupId)).toMatchObject({
      state: 'ready',
      revision: group.revision,
    });
    expect(
      (
        await f.pool.query(
          "SELECT id FROM mio_material_operations WHERE owner_id=$1 AND kind='delete_group_upstream'",
          [f.actor.userId],
        )
      ).rowCount,
    ).toBe(0);
  },
);

it.each([403, 503] as const)(
  'keeps a nonempty local group rejection ahead of a preset upstream %i response',
  async (status) => {
    const f = await fixture();
    const group = await f.create();
    f.add(group.upstreamId);
    await f.service.sync(f.actor, group.groupId);
    f.override(async (action) =>
      action === 'GetAssetGroup'
        ? envelope(action, {}, status, status === 403 ? 'Forbidden' : 'ServiceUnavailable')
        : undefined,
    );

    const snapshot = vi.spyOn(f.provider, 'snapshotAccount');
    const decrypt = vi.spyOn(f.provider, 'openAccountSnapshot');
    const before = f.transport.mock.calls.length;
    await expect(
      f.service.remove(f.actor, 'group', group.groupId, randomUUID(), group.revision, 'upstream'),
    ).rejects.toMatchObject({ status: 409, code: 'RESOURCE_IN_USE' });
    expect(snapshot).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(f.transport).toHaveBeenCalledTimes(before);
    expect(await f.service.group(f.actor, group.groupId)).toMatchObject({
      state: 'ready',
      revision: group.revision,
    });
    expect(
      f.transport.mock.calls.filter(([url]) => String(url).includes('Action=DeleteAssetGroup')),
    ).toHaveLength(0);
  },
);

it.each(['sync lease', 'nonempty material', 'group revision'] as const)(
  'rechecks %s changes after the remote group 404 before deleting locally',
  async (scenario) => {
    const f = await fixture();
    const group = await f.create();
    f.override(async (action) => {
      if (action !== 'GetAssetGroup') return;
      if (scenario === 'sync lease')
        await f.pool.query(
          "UPDATE mio_material_groups SET sync_lease_id=$2,sync_lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1",
          [group.groupId, randomUUID()],
        );
      else if (scenario === 'nonempty material')
        await f.pool.query(
          `INSERT INTO mio_materials(id,owner_id,provider_type,group_id,upstream_asset_id,asset_type,name,state,registration_credential_version)
           VALUES($1,$2,'onelink',$3,'asset-20261120009999-abcde','image','Concurrent','active',1)`,
          [randomUUID(), f.actor.userId, group.groupId],
        );
      else
        await f.pool.query('UPDATE mio_material_groups SET revision=revision+1 WHERE id=$1', [
          group.groupId,
        ]);
      return envelope(action, {}, 404, 'ResourceNotFound');
    });

    await expect(
      f.service.remove(f.actor, 'group', group.groupId, randomUUID(), group.revision, 'upstream'),
    ).rejects.toMatchObject(
      scenario === 'group revision'
        ? { status: 409, code: 'REVISION_CONFLICT' }
        : {
            status: 409,
            code: scenario === 'sync lease' ? 'MATERIAL_BUSY' : 'RESOURCE_IN_USE',
          },
    );
    expect(
      f.transport.mock.calls.filter(([url]) => String(url).includes('Action=GetAssetGroup')),
    ).toHaveLength(1);
    expect(
      f.transport.mock.calls.filter(([url]) => String(url).includes('Action=DeleteAssetGroup')),
    ).toHaveLength(0);
    expect(
      (await f.pool.query('SELECT state FROM mio_material_groups WHERE id=$1', [group.groupId]))
        .rows[0].state,
    ).toBe('ready');
    expect(
      (
        await f.pool.query(
          "SELECT id FROM mio_material_operations WHERE owner_id=$1 AND kind='delete_group_upstream'",
          [f.actor.userId],
        )
      ).rowCount,
    ).toBe(0);
  },
);

it.each(['local tombstone', 'unsynchronized material', 'external insertion'] as const)(
  'rejects remote group deletion with %s before creating a deletion operation',
  async (scenario) => {
    const f = await fixture();
    const group = await f.create();
    let upstream: string;
    if (scenario === 'local tombstone') {
      upstream = f.add(group.upstreamId);
      await f.service.sync(f.actor, group.groupId);
      const row = (await f.store.materials(f.actor.userId, group.groupId, 20))[0]!;
      await f.service.remove(f.actor, 'material', row.id, randomUUID(), row.revision, 'local');
    } else if (scenario === 'unsynchronized material') {
      upstream = f.add(group.upstreamId);
    } else {
      upstream = '';
      f.override(async (action) => {
        if (action === 'GetAssetGroup') upstream = f.add(group.upstreamId);
        return;
      });
    }
    const requestId = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(
        f.service.remove(f.actor, 'group', group.groupId, requestId, group.revision, 'upstream'),
      ).rejects.toMatchObject({ status: 409, code: 'RESOURCE_IN_USE' });
    expect(f.items.has(upstream)).toBe(true);
    expect(f.groups.has(group.upstreamId)).toBe(true);
    expect(await f.service.group(f.actor, group.groupId)).toMatchObject({
      state: 'ready',
      revision: group.revision,
    });
    expect(
      f.transport.mock.calls.filter(([url]) => String(url).includes('Action=DeleteAssetGroup')),
    ).toHaveLength(0);
    expect(
      (
        await f.pool.query(
          "SELECT id FROM mio_material_operations WHERE kind='delete_group_upstream'",
        )
      ).rowCount,
    ).toBe(0);
  },
);

it('persists unknown remote deletion and recovers by exact resource query without repeating delete', async () => {
  const f = await fixture();
  const group = await f.create();
  const upstream = f.add(group.upstreamId);
  await f.service.sync(f.actor, group.groupId);
  const row = (await f.store.materials(f.actor.userId, group.groupId, 20))[0]!;
  const request = randomUUID();
  f.override(async (action) => {
    if (action === 'DeleteAsset') {
      f.items.delete(upstream);
      throw new Error('RESPONSE_LOST');
    }
    return;
  });
  const deleting = await f.service.remove(
    f.actor,
    'material',
    row.id,
    request,
    row.revision,
    'upstream',
  );
  expect(deleting).toMatchObject({ operation: { state: 'unknown' } });
  if (!('operation' in deleting)) throw new Error();
  f.override(undefined);
  const recovered = await f.service.operation(f.actor, deleting.operation.operationId);
  expect(recovered.state).toBe('succeeded');
  expect(
    (await f.pool.query('SELECT state FROM mio_materials WHERE id=$1', [row.id])).rows[0].state,
  ).toBe('deleted');
  expect(
    await f.service.remove(f.actor, 'material', row.id, request, row.revision, 'upstream'),
  ).toMatchObject({ operation: { state: 'succeeded' } });
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=DeleteAsset&')),
  ).toHaveLength(1);
});

it('keeps historical unknown group deletion idempotent and holds recovery to one lease and cooldown', async () => {
  const f = await fixture();
  const group = await f.create();
  const requestId = randomUUID();
  const { operation } = await f.store.beginDelete(
    f.actor.userId,
    requestId,
    sha256Utf8(JSON.stringify({ id: group.groupId, revision: group.revision, scope: 'upstream' })),
    'group',
    group.groupId,
    group.revision,
    await f.provider.snapshotAccount(f.actor.userId),
  );
  await f.store.failOperation(f.actor.userId, operation, true, 'UPSTREAM_RESULT_UNKNOWN');
  const beforeReplay = f.transport.mock.calls.length;
  const deleting = await f.service.remove(
    f.actor,
    'group',
    group.groupId,
    requestId,
    group.revision,
    'upstream',
  );
  if (!('operation' in deleting)) throw new Error();
  expect(deleting.operation).toMatchObject({ operationId: operation.id, state: 'unknown' });
  await expect(
    f.service.remove(f.actor, 'group', group.groupId, requestId, group.revision, 'upstream', true),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(
    await f.service.remove(
      f.actor,
      'group',
      group.groupId,
      requestId,
      group.revision,
      'upstream',
      false,
    ),
  ).toEqual(deleting);
  expect(f.transport).toHaveBeenCalledTimes(beforeReplay);
  f.override(async (action) =>
    action === 'GetAssetGroup' ? envelope(action, {}, 403, 'Forbidden') : undefined,
  );
  expect(await f.service.operation(f.actor, deleting.operation.operationId)).toMatchObject({
    state: 'unknown',
    errorCode: 'PROVIDER_RESOURCE_FORBIDDEN',
  });
  const before = f.transport.mock.calls.length;
  await Promise.all(
    Array.from({ length: 5 }, () => f.service.operation(f.actor, deleting.operation.operationId)),
  );
  expect(f.transport).toHaveBeenCalledTimes(before);
  expect(
    (await f.pool.query('SELECT state FROM mio_material_groups WHERE id=$1', [group.groupId]))
      .rows[0].state,
  ).toBe('unknown');
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=DeleteAssetGroup')),
  ).toHaveLength(0);
});

it('recovers a historical unknown group deletion by original identity on exact 404', async () => {
  const f = await fixture();
  const group = await f.create();
  const requestId = randomUUID();
  const { operation } = await f.store.beginDelete(
    f.actor.userId,
    requestId,
    sha256Utf8(JSON.stringify({ id: group.groupId, revision: group.revision, scope: 'upstream' })),
    'group',
    group.groupId,
    group.revision,
    await f.provider.snapshotAccount(f.actor.userId),
  );
  await f.store.failOperation(f.actor.userId, operation, true, 'UPSTREAM_RESULT_UNKNOWN');
  f.override(async (action) =>
    action === 'GetAssetGroup' ? envelope(action, {}, 404, 'ResourceNotFound') : undefined,
  );

  expect(await f.service.operation(f.actor, operation.id)).toMatchObject({
    operationId: operation.id,
    state: 'succeeded',
    resultLocalId: group.groupId,
  });
  const gets = f.transport.mock.calls.filter(([url]) =>
    String(url).includes('Action=GetAssetGroup'),
  );
  expect(gets).toHaveLength(1);
  expect(JSON.parse(String(gets[0]![1]?.body))).toMatchObject({ Id: group.upstreamId });
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=DeleteAssetGroup')),
  ).toHaveLength(0);
  expect(
    (
      await f.pool.query(
        'SELECT id,request_id,kind,state,result_local_id,protocol_snapshot FROM mio_material_operations WHERE id=$1',
        [operation.id],
      )
    ).rows[0],
  ).toMatchObject({
    id: operation.id,
    request_id: requestId,
    kind: 'delete_group_upstream',
    state: 'succeeded',
    result_local_id: group.groupId,
    protocol_snapshot: { version: 1, upstreamId: group.upstreamId },
  });
  expect(
    (await f.pool.query('SELECT state FROM mio_material_groups WHERE id=$1', [group.groupId]))
      .rows[0].state,
  ).toBe('deleted');
});

it('records deterministic pre-send decryption failure as failed with no upstream call, leaving deletion resource usable', async () => {
  const f = await fixture();
  const group = await f.create();
  f.add(group.upstreamId);
  await f.service.sync(f.actor, group.groupId);
  const row = (await f.store.materials(f.actor.userId, group.groupId, 20))[0]!;
  const { ProviderError } = await import('../../src/providers/contracts.ts');
  const decrypt = vi.spyOn(f.provider, 'openAccountSnapshot').mockImplementation(() => {
    throw new ProviderError(503, 'PROVIDER_CREDENTIAL_INVALID');
  });
  const calls = f.transport.mock.calls.length;
  expect(await f.service.createGroup(f.actor, randomUUID(), 'Cannot decrypt')).toMatchObject({
    operation: { state: 'failed', errorCode: 'PROVIDER_CREDENTIAL_INVALID' },
  });
  expect(
    await f.service.remove(f.actor, 'material', row.id, randomUUID(), row.revision, 'upstream'),
  ).toMatchObject({ operation: { state: 'failed', errorCode: 'PROVIDER_CREDENTIAL_INVALID' } });
  expect(f.transport).toHaveBeenCalledTimes(calls);
  expect(await f.service.material(f.actor, row.id)).toHaveProperty('state', 'active');
  decrypt.mockRestore();
  const current = await f.store.ownedMaterial(f.actor.userId, row.id);
  expect(
    await f.service.remove(f.actor, 'material', row.id, randomUUID(), current.revision, 'upstream'),
  ).toMatchObject({ operation: { state: 'succeeded' } });
});

it('treats a verified exact absent resource as already deleted without a second remote mutation', async () => {
  const f = await fixture();
  const group = await f.create();
  f.groups.delete(group.upstreamId);
  const result = await f.service.remove(
    f.actor,
    'group',
    group.groupId,
    randomUUID(),
    group.revision,
    'upstream',
  );
  expect(result).toMatchObject({ operation: { state: 'succeeded' } });
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=DeleteAssetGroup')),
  ).toHaveLength(0);
});

it('rejects a forbidden group delete preflight before any deletion state and allows later management', async () => {
  const f = await fixture();
  const group = await f.create();
  f.override(async (action) =>
    action === 'GetAssetGroup' ? envelope(action, {}, 403, 'Forbidden') : undefined,
  );
  await expect(
    f.service.remove(f.actor, 'group', group.groupId, randomUUID(), group.revision, 'upstream'),
  ).rejects.toMatchObject({ status: 403, code: 'PROVIDER_RESOURCE_FORBIDDEN' });
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=DeleteAssetGroup')),
  ).toHaveLength(0);
  const kept = await f.service.group(f.actor, group.groupId);
  expect(kept.state).toBe('ready');
  f.override(undefined);
  expect(
    await f.service.rename(f.actor, group.groupId, kept.revision, 'Access restored'),
  ).toMatchObject({ state: 'ready', name: 'Access restored' });
});

it('rolls back the entire sync if a lease expires during entity writes, including its summary', async () => {
  const f = await fixture();
  const group = await f.create();
  const { group: claim, lease } = await f.store.claimGroup(
    f.actor.userId,
    group.groupId,
    undefined,
    '1',
  );
  await f.pool.query(
    'CREATE FUNCTION delay_material_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$',
  );
  await f.pool.query(
    'CREATE TRIGGER delay_material BEFORE INSERT ON mio_materials FOR EACH ROW EXECUTE FUNCTION delay_material_insert()',
  );
  await f.pool.query(
    "UPDATE mio_material_groups SET sync_lease_until=clock_timestamp()+interval '50 milliseconds' WHERE id=$1",
    [group.groupId],
  );
  await expect(
    f.store.applySync(
      f.actor.userId,
      claim,
      lease,
      [
        {
          id: 'asset-20261120000000-abcde',
          groupId: group.upstreamId,
          name: 'Late',
          status: 'Active',
        },
      ],
      null,
      1,
    ),
  ).rejects.toMatchObject({ code: 'MATERIAL_OPERATION_SUPERSEDED' });
  expect(
    (await f.pool.query('SELECT count(*) FROM mio_materials WHERE group_id=$1', [group.groupId]))
      .rows[0].count,
  ).toBe('0');
  expect((await f.store.ownedGroup(f.actor.userId, group.groupId)).last_sync_status).toBe(
    'running',
  );
});

it('retains a confirmed create identity after PG failure and recovers across restart using one exact Get without a second Create', async () => {
  const f = await fixture();
  const request = randomUUID();
  vi.spyOn(f.store, 'finishCreate').mockRejectedValueOnce(new Error('PG_COMMIT_LOST'));
  const result = await f.service.createGroup(f.actor, request, 'Known after response');
  expect(result.operation.state).toBe('unknown');
  const op = await f.store.operation(f.actor.userId, result.operation.operationId);
  expect(op.protocol_snapshot.upstreamId).toMatch(/^group-/);
  expect(op.upstream_request_id).toMatch(/^[0-9a-f-]{36}$/);
  await f.service.close();
  const restarted = createMaterialService(
    await createMaterialStore(f.database.url),
    f.provider,
    createMaterialUpstream(f.transport),
  );
  try {
    await expect(
      restarted.operation({ userId: 'other', sessionId: 'other' }, op.id),
    ).rejects.toMatchObject({ code: 'MATERIAL_NOT_FOUND' });
    expect(await restarted.operation(f.actor, op.id)).toMatchObject({
      state: 'succeeded',
      resultLocalId: op.target_group_id,
    });
    expect(await restarted.group(f.actor, op.target_group_id!)).toMatchObject({
      state: 'ready',
      name: 'Known after response',
    });
    expect(
      (await restarted.createGroup(f.actor, request, 'Known after response')).operation.state,
    ).toBe('succeeded');
  } finally {
    await restarted.close();
  }
  const calls = f.transport.mock.calls.map(([url]) =>
    new URL(String(url)).searchParams.get('Action'),
  );
  expect(calls.filter((action) => action === 'CreateAssetGroup')).toHaveLength(1);
  expect(calls.filter((action) => action === 'GetAssetGroup')).toHaveLength(1);
  const get = f.transport.mock.calls.find(([url]) => String(url).includes('Action=GetAssetGroup'))!;
  expect(JSON.parse(String(get[1]?.body))).toEqual({ Id: op.protocol_snapshot.upstreamId });
});

it.each([403, 404])(
  'keeps known-create recovery unknown for exact resource %s and does not claim or repeat',
  async (status) => {
    const f = await fixture();
    vi.spyOn(f.store, 'finishCreate').mockRejectedValueOnce(new Error('PG_COMMIT_LOST'));
    const result = await f.service.createGroup(f.actor, randomUUID(), 'Cannot verify');
    f.override(async (action) =>
      action === 'GetAssetGroup'
        ? envelope(action, {}, status, status === 404 ? 'ResourceNotFound' : 'Forbidden')
        : undefined,
    );
    expect(await f.service.operation(f.actor, result.operation.operationId)).toMatchObject({
      state: 'unknown',
      errorCode: status === 404 ? 'UPSTREAM_RESOURCE_NOT_FOUND' : 'PROVIDER_RESOURCE_FORBIDDEN',
    });
    const calls = f.transport.mock.calls.length;
    await Promise.all(
      Array.from({ length: 4 }, () => f.service.operation(f.actor, result.operation.operationId)),
    );
    expect(f.transport).toHaveBeenCalledTimes(calls);
    const op = await f.store.operation(f.actor.userId, result.operation.operationId);
    const group = await f.store.ownedGroup(f.actor.userId, op.target_group_id!);
    expect(group).toMatchObject({ state: 'unknown', upstream_group_id: null });
    expect(
      f.transport.mock.calls.filter(([url]) => String(url).includes('Action=CreateAssetGroup')),
    ).toHaveLength(1);
  },
);

it('does not bind a known-create recovery ID already owned by another user and serializes concurrent recovery', async () => {
  const f = await fixture();
  const existing = await f.create();
  const other = { userId: randomUUID(), sessionId: 'other' };
  await f.provider.save(other, 0, 'synthetic-other-key');
  f.override(async (action) =>
    action === 'CreateAssetGroup' ? envelope(action, { Id: existing.upstreamId }) : undefined,
  );
  const collision = await f.service.createGroup(other, randomUUID(), 'Collision');
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.override(async (action) => {
    if (action === 'GetAssetGroup') {
      entered.resolve();
      await release.promise;
    }
    return;
  });
  const first = f.service.operation(other, collision.operation.operationId);
  await entered.promise;
  const before = f.transport.mock.calls.length;
  const rest = await Promise.all(
    Array.from({ length: 5 }, () => f.service.operation(other, collision.operation.operationId)),
  );
  expect(rest.every((op) => op.state === 'unknown')).toBe(true);
  expect(f.transport).toHaveBeenCalledTimes(before);
  release.resolve();
  expect(await first).toMatchObject({ state: 'unknown', errorCode: 'UPSTREAM_RESOURCE_COLLISION' });
  expect(
    (
      await f.pool.query('SELECT owner_id FROM mio_material_groups WHERE upstream_group_id=$1', [
        existing.upstreamId,
      ])
    ).rows,
  ).toEqual([{ owner_id: f.actor.userId }]);
});

it('preserves a late known create response even after an expired operation was made unknown', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.override(async (action) => {
    if (action === 'CreateAssetGroup') {
      entered.resolve();
      await release.promise;
    }
    return;
  });
  const pending = f.service.createGroup(f.actor, randomUUID(), 'Late known');
  await entered.promise;
  const row = (
    await f.pool.query('SELECT id FROM mio_material_operations WHERE owner_id=$1', [f.actor.userId])
  ).rows[0];
  await f.pool.query(
    "UPDATE mio_material_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [row.id],
  );
  expect((await f.store.operation(f.actor.userId, row.id)).state).toBe('unknown');
  release.resolve();
  expect((await pending).operation.state).toBe('unknown');
  const op = await f.store.operation(f.actor.userId, row.id);
  expect(op.protocol_snapshot.upstreamId).toMatch(/^group-/);
  expect(await f.service.operation(f.actor, row.id)).toMatchObject({ state: 'succeeded' });
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=CreateAssetGroup')),
  ).toHaveLength(1);
});
