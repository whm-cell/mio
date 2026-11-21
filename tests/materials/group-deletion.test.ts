import { randomUUID } from 'node:crypto';
import { sha256Utf8 } from '@mio/foundation/hash';
import { expect, it, onTestFinished } from 'vitest';
import { createMaterialStore } from '../../src/materials/store.ts';
import { createMaterialService } from '../../src/materials/service.ts';
import { createMaterialUpstream } from '../../src/integrations/onelink/materials.ts';
import type { GroupView, OperationView } from '../../src/materials/contracts.ts';
import { envelope, materialFixture } from './fixture.ts';
import type { MaterialFixture } from './fixture.ts';

async function fixture() {
  const f = await materialFixture();
  onTestFinished(() => f.close());
  return f;
}

async function cascade(f: MaterialFixture, group: GroupView, requestId = randomUUID()) {
  const result = await f.service.remove(
    f.actor,
    'group',
    group.groupId,
    requestId,
    group.revision,
    'upstream',
    true,
  );
  return (result as { operation: OperationView }).operation;
}

function calls(f: MaterialFixture, index: number) {
  return f.transport.mock.calls.slice(index).map(([url, init]) => ({
    action: new URL(String(url)).searchParams.get('Action'),
    body: JSON.parse(String(init?.body)) as unknown,
  }));
}

function groupResponse(action: string, status: number, result: unknown, metadata: object = {}) {
  return Response.json(
    {
      ResponseMetadata: { Action: action, Version: '2024-01-01', Service: 'ark', ...metadata },
      Result: result,
    },
    { status },
  );
}

it('confirms the exact mapped group and cascades known, locally deleted, unseen and concurrently added upstream members', async () => {
  const f = await fixture();
  const target = await f.create('Target');
  const other = await f.create('Other');
  const known = f.add(target.upstreamId, 1);
  const hidden = f.add(target.upstreamId, 2);
  const unrelated = f.add(other.upstreamId, 3);
  await f.service.sync(f.actor, target.groupId);
  await f.service.sync(f.actor, other.groupId);
  const members = await f.store.materials(f.actor.userId, target.groupId, 20);
  const member = members.find((row) => row.upstream_asset_id === known)!;
  const tombstone = members.find((row) => row.upstream_asset_id === hidden)!;
  await f.service.remove(
    f.actor,
    'material',
    tombstone.id,
    randomUUID(),
    tombstone.revision,
    'local',
  );
  const unseen = f.add(target.upstreamId, 4);
  const requestId = randomUUID();
  const before = f.transport.mock.calls.length;
  let concurrent: string | undefined;
  f.override(async (action) => {
    if (action !== 'DeleteAssetGroup') return;
    const intent = (
      await f.pool.query(
        'SELECT * FROM mio_material_operations WHERE owner_id=$1 AND request_id=$2',
        [f.actor.userId, requestId],
      )
    ).rows[0];
    expect(intent).toMatchObject({
      kind: 'delete_group_upstream',
      state: 'deleting',
      target_group_id: target.groupId,
      target_material_id: null,
      provider_config_id: (await f.store.ownedGroup(f.actor.userId, target.groupId))
        .provider_config_id,
      credential_version: 1,
      protocol_snapshot: { version: 1, upstreamId: target.upstreamId, confirmCascade: true },
      input_hash: sha256Utf8(
        JSON.stringify({
          id: target.groupId,
          revision: target.revision,
          scope: 'upstream',
          confirmCascade: true,
        }),
      ),
      attempt: 1,
    });
    concurrent = f.add(target.upstreamId, 5);
  });

  const operation = await cascade(f, target, requestId);
  expect(operation).toMatchObject({ state: 'succeeded', resultLocalId: target.groupId });
  expect(calls(f, before)).toEqual([
    { action: 'GetAssetGroup', body: { Id: target.upstreamId } },
    { action: 'DeleteAssetGroup', body: { Id: target.upstreamId } },
  ]);
  expect([...f.groups.keys()]).toEqual([other.upstreamId]);
  expect(concurrent).toBeDefined();
  for (const id of [known, hidden, unseen, concurrent!]) expect(f.items.has(id)).toBe(false);
  expect([...f.items.keys()]).toEqual([unrelated]);
  expect(
    (
      await f.pool.query(
        'SELECT id,upstream_asset_id,state,revision,deleted_at FROM mio_materials WHERE owner_id=$1 AND group_id=$2 ORDER BY upstream_asset_id',
        [f.actor.userId, target.groupId],
      )
    ).rows,
  ).toEqual([
    {
      id: member.id,
      upstream_asset_id: known,
      state: 'deleted',
      revision: member.revision + 1,
      deleted_at: expect.any(Date),
    },
    {
      id: tombstone.id,
      upstream_asset_id: hidden,
      state: 'deleted',
      revision: tombstone.revision + 1,
      deleted_at: expect.any(Date),
    },
  ]);
  expect(
    (
      await f.pool.query(
        'SELECT state,upstream_group_id,deleted_at FROM mio_material_groups WHERE id=$1',
        [target.groupId],
      )
    ).rows[0],
  ).toEqual({
    state: 'deleted',
    upstream_group_id: target.upstreamId,
    deleted_at: expect.any(Date),
  });
  expect((await f.store.materials(f.actor.userId, other.groupId, 20))[0]).toMatchObject({
    state: 'active',
    upstream_asset_id: unrelated,
  });
  expect(await cascade(f, target, requestId)).toEqual(operation);
  expect(calls(f, before)).toHaveLength(2);
});

it('returns the accepted request before current revision or permissions and persists one claim across service instances', async () => {
  const f = await fixture();
  const group = await f.create();
  const other = await f.create('Other');
  const joined = createMaterialService(
    await createMaterialStore(f.database.url),
    f.provider,
    createMaterialUpstream(f.transport),
  );
  onTestFinished(() => joined.close());
  const peer = { ...f, service: joined };
  const remote = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const request = randomUUID();
  const before = f.transport.mock.calls.length;
  f.override(async (action) => {
    if (action === 'DeleteAssetGroup') {
      remote.resolve();
      await release.promise;
    }
  });
  const deleting = cascade(f, group, request);
  try {
    await remote.promise;
    const replay = await cascade(peer, group, request);
    expect(replay).toMatchObject({ state: 'deleting', kind: 'delete_group_upstream' });
    await expect(cascade(peer, other, request)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(
      cascade(peer, { ...group, revision: group.revision + 1 }, request),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      joined.remove(f.actor, 'group', group.groupId, request, group.revision, 'upstream'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(cascade(peer, group)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(cascade(peer, { ...group, revision: group.revision + 1 })).rejects.toMatchObject({
      code: 'MATERIAL_GROUP_NOT_READY',
    });
    release.resolve();
    expect(await deleting).toMatchObject({ state: 'succeeded', operationId: replay.operationId });
    expect(calls(f, before).map(({ action }) => action)).toEqual([
      'GetAssetGroup',
      'DeleteAssetGroup',
    ]);
  } finally {
    release.resolve();
    await deleting;
  }
});

it('blocks confirmed deletion during live sync and never imports its late page after cascade', async () => {
  const f = await fixture();
  const group = await f.create();
  f.add(group.upstreamId, 1);
  f.add(group.upstreamId, 2);
  await f.service.sync(f.actor, group.groupId);
  const [localTombstone] = await f.store.materials(f.actor.userId, group.groupId, 20);
  await f.service.remove(
    f.actor,
    'material',
    localTombstone!.id,
    randomUUID(),
    localTombstone!.revision,
    'local',
  );
  f.add(group.upstreamId, 3);
  const listStarted = Promise.withResolvers<void>();
  const returnList = Promise.withResolvers<void>();
  f.override(async (action) => {
    if (action !== 'ListAssets') return;
    const items = [...f.items.values()];
    listStarted.resolve();
    await returnList.promise;
    return envelope(action, {
      Items: items,
      PageNumber: 1,
      PageSize: 100,
      TotalCount: items.length,
    });
  });
  const syncing = f.service.sync(f.actor, group.groupId);
  try {
    await listStarted.promise;
    const before = f.transport.mock.calls.length;
    await expect(cascade(f, group)).rejects.toMatchObject({ status: 409, code: 'MATERIAL_BUSY' });
    expect(calls(f, before)).toEqual([]);
    await f.pool.query(
      "UPDATE mio_material_groups SET sync_lease_until=now()-interval '1 second' WHERE id=$1",
      [group.groupId],
    );
    expect(await cascade(f, group)).toMatchObject({ state: 'succeeded' });
    expect(calls(f, before)).toEqual([
      { action: 'GetAssetGroup', body: { Id: group.upstreamId } },
      { action: 'DeleteAssetGroup', body: { Id: group.upstreamId } },
    ]);
    const members = () =>
      f.pool.query(
        'SELECT id,owner_id,upstream_asset_id,state,deleted_at,revision FROM mio_materials WHERE group_id=$1 ORDER BY id',
        [group.groupId],
      );
    const storedGroup = () =>
      f.pool.query('SELECT * FROM mio_material_groups WHERE id=$1', [group.groupId]);
    const afterDeletion = (await members()).rows;
    const deletedGroup = (await storedGroup()).rows[0];
    expect(deletedGroup).toMatchObject({
      state: 'deleted',
      owner_id: f.actor.userId,
      upstream_group_id: group.upstreamId,
      deleted_at: expect.any(Date),
    });
    expect(afterDeletion).toHaveLength(2);
    for (const member of afterDeletion)
      expect(member).toMatchObject({
        state: 'deleted',
        owner_id: f.actor.userId,
        deleted_at: expect.any(Date),
      });
    returnList.resolve();
    await expect(syncing).rejects.toMatchObject({ code: 'MATERIAL_OPERATION_SUPERSEDED' });
    expect((await members()).rows).toEqual(afterDeletion);
    expect((await storedGroup()).rows[0]).toEqual(deletedGroup);
    await expect(f.service.group(f.actor, group.groupId)).rejects.toMatchObject({ status: 404 });
  } finally {
    returnList.resolve();
    await Promise.allSettled([syncing]);
  }
});

it('returns the concurrently accepted operation when an overlapping preflight is rejected', async () => {
  const f = await fixture();
  const group = await f.create();
  const request = randomUUID();
  const firstLookup = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const before = f.transport.mock.calls.length;
  let first = true;
  f.override(async (action) => {
    if (action !== 'GetAssetGroup' || !first) return;
    first = false;
    firstLookup.resolve();
    await release.promise;
    return envelope(action, {}, 403, 'Forbidden');
  });
  const overlapping = cascade(f, group, request);
  try {
    await firstLookup.promise;
    const accepted = await cascade(f, group, request);
    expect(accepted).toMatchObject({ state: 'succeeded' });
    release.resolve();
    expect(await overlapping).toEqual(accepted);
    expect(calls(f, before).map(({ action }) => action)).toEqual([
      'GetAssetGroup',
      'GetAssetGroup',
      'DeleteAssetGroup',
    ]);
  } finally {
    release.resolve();
    await overlapping;
  }
});

it.each([
  [403, 'ResourceNotFound', 'PROVIDER_RESOURCE_FORBIDDEN'],
  [404, 'NotFound', 'UPSTREAM_REJECTED'],
] as const)(
  'preserves the confirmed target when its first lookup returns %s/%s',
  async (status, code, errorCode) => {
    const f = await fixture();
    const group = await f.create();
    f.add(group.upstreamId);
    await f.service.sync(f.actor, group.groupId);
    const before = f.transport.mock.calls.length;
    f.override(async (action) => envelope(action, {}, status, code));
    await expect(cascade(f, group)).rejects.toMatchObject({ code: errorCode });
    expect(calls(f, before)).toEqual([{ action: 'GetAssetGroup', body: { Id: group.upstreamId } }]);
    expect(await f.service.group(f.actor, group.groupId)).toMatchObject({
      state: 'ready',
      revision: group.revision,
      materialCount: 1,
    });
    expect(
      (
        await f.pool.query(
          "SELECT id FROM mio_material_operations WHERE kind='delete_group_upstream'",
        )
      ).rowCount,
    ).toBe(0);
  },
);

it('uses a precise preflight absence to settle locally and leaves no remote delete to replay', async () => {
  const f = await fixture();
  const group = await f.create();
  f.add(group.upstreamId);
  await f.service.sync(f.actor, group.groupId);
  const member = (await f.store.materials(f.actor.userId, group.groupId, 20))[0]!;
  f.deleteRemoteGroup(group.upstreamId);
  const before = f.transport.mock.calls.length;
  expect(await cascade(f, group)).toMatchObject({
    state: 'succeeded',
    resultLocalId: group.groupId,
  });
  expect(calls(f, before)).toEqual([{ action: 'GetAssetGroup', body: { Id: group.upstreamId } }]);
  await expect(f.service.material(f.actor, member.id)).rejects.toMatchObject({
    code: 'MATERIAL_NOT_FOUND',
  });
});

it.each([false, true])(
  'refuses a contradictory 404 before accepting group deletion (confirmCascade=%s)',
  async (confirmCascade) => {
    const f = await fixture();
    const group = await f.create();
    const before = f.transport.mock.calls.length;
    f.override(async (action) =>
      groupResponse(
        action,
        404,
        {
          Id: confirmCascade ? 'group-20261121011111-abcde' : group.upstreamId,
        },
        { Error: { Code: 'ResourceNotFound' } },
      ),
    );
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
    ).rejects.toMatchObject({ code: 'UPSTREAM_RESPONSE_INVALID' });
    expect(calls(f, before)).toEqual([{ action: 'GetAssetGroup', body: { Id: group.upstreamId } }]);
    expect(await f.service.group(f.actor, group.groupId)).toMatchObject({ state: 'ready' });
    expect(
      (
        await f.pool.query(
          "SELECT id FROM mio_material_operations WHERE kind='delete_group_upstream'",
        )
      ).rowCount,
    ).toBe(0);
  },
);

it.each([
  ['absent', 'succeeded', null],
  ['absent with empty result', 'succeeded', null],
  ['present', 'unknown', 'UPSTREAM_RESULT_UNKNOWN'],
  ['forbidden', 'unknown', 'PROVIDER_RESOURCE_FORBIDDEN'],
  ['ordinary 404', 'unknown', 'UPSTREAM_REJECTED'],
  ['contradictory 404', 'unknown', 'UPSTREAM_RESPONSE_INVALID'],
] as const)(
  'checks an empty delete receipt using only an exact lookup (%s)',
  async (scenario, state, errorCode) => {
    const f = await fixture();
    const group = await f.create();
    const before = f.transport.mock.calls.length;
    let returnedEmptyReceipt = false;
    f.override(async (action) => {
      if (action === 'DeleteAssetGroup') {
        returnedEmptyReceipt = true;
        if (scenario === 'absent' || scenario === 'absent with empty result')
          f.deleteRemoteGroup(group.upstreamId);
        return envelope(action);
      }
      if (action !== 'GetAssetGroup' || !returnedEmptyReceipt) return;
      if (scenario === 'forbidden') return envelope(action, {}, 403, 'ResourceNotFound');
      if (scenario === 'ordinary 404') return envelope(action, {}, 404, 'NotFound');
      if (scenario === 'contradictory 404')
        return groupResponse(
          action,
          404,
          { Id: group.upstreamId },
          { Error: { Code: 'ResourceNotFound' } },
        );
      if (scenario === 'absent with empty result')
        return groupResponse(action, 404, {}, { Error: { Code: 'ResourceNotFound' } });
    });
    expect(await cascade(f, group)).toMatchObject({ state, errorCode });
    expect(calls(f, before)).toEqual(
      ['GetAssetGroup', 'DeleteAssetGroup', 'GetAssetGroup'].map((action) => ({
        action,
        body: { Id: group.upstreamId },
      })),
    );
    expect(
      (await f.pool.query('SELECT state FROM mio_material_groups WHERE id=$1', [group.groupId]))
        .rows[0],
    ).toEqual({
      state: state === 'succeeded' ? 'deleted' : 'unknown',
    });
  },
);

it.each([
  ['wrong ID', 'unknown', 'UPSTREAM_RESPONSE_INVALID'],
  ['invalid receipt', 'unknown', 'UPSTREAM_RESPONSE_INVALID'],
  ['success with Error: null', 'unknown', 'UPSTREAM_RESPONSE_INVALID'],
  ['failure without Error', 'unknown', 'UPSTREAM_RESPONSE_INVALID'],
  ['failure with malformed Error', 'unknown', 'UPSTREAM_RESPONSE_INVALID'],
  ['failure with contradictory result', 'unknown', 'UPSTREAM_RESPONSE_INVALID'],
  ['timeout', 'unknown', 'UPSTREAM_RESULT_UNKNOWN'],
  ['forbidden', 'failed', 'PROVIDER_RESOURCE_FORBIDDEN'],
] as const)(
  'retains local members after an unproven group deletion (%s)',
  async (scenario, state, errorCode) => {
    const f = await fixture();
    const group = await f.create();
    const asset = f.add(group.upstreamId);
    await f.service.sync(f.actor, group.groupId);
    const before = f.transport.mock.calls.length;
    f.override(async (action) => {
      if (action !== 'DeleteAssetGroup') return;
      switch (scenario) {
        case 'wrong ID':
          return envelope(action, { Id: 'group-20261121011111-abcde' });
        case 'invalid receipt':
          return envelope(action, { Id: null });
        case 'success with Error: null':
          return groupResponse(action, 200, { Id: group.upstreamId }, { Error: null });
        case 'failure without Error':
          return groupResponse(action, 403, {});
        case 'failure with malformed Error':
          return groupResponse(action, 403, {}, { Error: {} });
        case 'failure with contradictory result':
          return groupResponse(
            action,
            403,
            { Id: group.upstreamId },
            { Error: { Code: 'Forbidden' } },
          );
        case 'timeout':
          return envelope(action, {}, 408, 'Timeout');
        case 'forbidden':
          return envelope(action, {}, 403, 'Forbidden');
      }
    });
    const request = randomUUID();
    const result = await cascade(f, group, request);
    expect(result).toMatchObject({ state, errorCode });
    expect(await cascade(f, group, request)).toEqual(result);
    expect(calls(f, before).map(({ action }) => action)).toEqual([
      'GetAssetGroup',
      'DeleteAssetGroup',
    ]);
    expect((await f.store.materials(f.actor.userId, group.groupId, 20))[0]).toMatchObject({
      state: 'active',
      upstream_asset_id: asset,
    });
    expect(await f.service.group(f.actor, group.groupId)).toMatchObject({
      state: state === 'failed' ? 'ready' : 'unknown',
    });
  },
);

it('rolls back the member and group tombstones on a PG failure and recovers both after restart without replay', async () => {
  const f = await fixture();
  const group = await f.create();
  f.add(group.upstreamId);
  await f.service.sync(f.actor, group.groupId);
  const member = (await f.store.materials(f.actor.userId, group.groupId, 20))[0]!;
  await f.pool
    .query(`CREATE FUNCTION fail_group_delete_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic terminal update failure'; END; $$;
    CREATE TRIGGER fail_group_delete_commit BEFORE UPDATE ON mio_material_operations
    FOR EACH ROW WHEN (NEW.kind='delete_group_upstream' AND NEW.state='succeeded') EXECUTE FUNCTION fail_group_delete_commit();`);
  const before = f.transport.mock.calls.length;
  const request = randomUUID();
  const result = await cascade(f, group, request);
  expect(result).toMatchObject({ state: 'unknown', errorCode: 'MATERIAL_UNAVAILABLE' });
  expect(f.groups.has(group.upstreamId)).toBe(false);
  expect(await f.service.group(f.actor, group.groupId)).toMatchObject({
    state: 'unknown',
    materialCount: 1,
  });
  expect(await f.service.material(f.actor, member.id)).toMatchObject({
    state: 'active',
    revision: member.revision,
  });
  await f.service.close();
  await f.pool.query('DROP TRIGGER fail_group_delete_commit ON mio_material_operations');
  await f.provider.save(
    f.actor,
    (await f.provider.get(f.actor))!.revision,
    'rotated-cascade-test-key',
  );
  const restarted = createMaterialService(
    await createMaterialStore(f.database.url),
    f.provider,
    createMaterialUpstream(f.transport),
  );
  onTestFinished(() => restarted.close());
  expect(await cascade({ ...f, service: restarted }, group, request)).toEqual(result);
  f.override(async (action) =>
    groupResponse(action, 404, { Id: group.upstreamId }, { Error: { Code: 'ResourceNotFound' } }),
  );
  expect(await restarted.operation(f.actor, result.operationId)).toMatchObject({
    state: 'unknown',
    errorCode: 'UPSTREAM_RESPONSE_INVALID',
  });
  expect(await restarted.material(f.actor, member.id)).toMatchObject({
    state: 'active',
    revision: member.revision,
  });
  f.override(undefined);
  await f.pool.query('UPDATE mio_material_operations SET next_query_at=now() WHERE id=$1', [
    result.operationId,
  ]);
  expect(await restarted.operation(f.actor, result.operationId)).toMatchObject({
    state: 'succeeded',
    resultLocalId: group.groupId,
    errorCode: null,
  });
  expect(calls(f, before)).toEqual(
    ['GetAssetGroup', 'DeleteAssetGroup', 'GetAssetGroup', 'GetAssetGroup'].map((action) => ({
      action,
      body: { Id: group.upstreamId },
    })),
  );
  expect(
    (await f.pool.query('SELECT state,revision FROM mio_materials WHERE id=$1', [member.id]))
      .rows[0],
  ).toEqual({ state: 'deleted', revision: member.revision + 1 });
  await expect(restarted.group(f.actor, group.groupId)).rejects.toMatchObject({
    code: 'MATERIAL_NOT_FOUND',
  });
});
