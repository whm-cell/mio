import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { createServer } from 'node:http';
import { createMaterialHandler } from '../../src/materials/http.ts';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createAssetStore } from '../../src/assets/store.ts';
import { createAssetService } from '../../src/assets/service.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import { materialFixture, envelope } from './fixture.ts';
import { createMaterialService } from '../../src/materials/service.ts';
import { createMaterialStore } from '../../src/materials/store.ts';
import { createMaterialUpstream } from '../../src/integrations/onelink/materials.ts';

const png = () =>
  sharp({ create: { width: 300, height: 300, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
async function fixture() {
  const f = await materialFixture();
  const bytes = new Map<string, Buffer>();
  let gate: (() => Promise<void>) | undefined;
  const read = vi.fn(async (key: string, etag: string, size: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    await gate?.();
    const data = bytes.get(key)!;
    if (etag !== createHash('sha256').update(data).digest('hex')) throw { statusCode: 412 };
    if (data.length !== size) throw new Error('SIZE');
    return data;
  });
  const objects: AssetObjectStore = {
    uploadUrl: () => '',
    downloadUrl: () => '',
    materialUrl: (key) => `https://cos.example/${key}?sign=private`,
    head: async (key) => {
      const data = bytes.get(key);
      if (!data) throw { statusCode: 404 };
      return { size: data.length, etag: createHash('sha256').update(data).digest('hex') };
    },
    readImage: read,
    copy: async () => {},
    delete: vi.fn(async () => {}),
  };
  const assets = createAssetService(await createAssetStore(f.database.url), objects);
  const source = vi.spyOn(assets, 'readMaterialSource');
  const service = createMaterialService(
    await createMaterialStore(f.database.url),
    f.provider,
    createMaterialUpstream(f.transport),
    assets,
  );
  onTestFinished(async () => {
    await service.close();
    await assets.close();
    await f.close();
  });
  const asset = async (
    data: Buffer | undefined = undefined,
    owner: string = f.actor.userId,
    state = 'ready',
    contentType = 'image/png',
  ) => {
    data ??= await png();
    const id = randomUUID(),
      key = `mio/raw/${id}/${randomUUID()}`;
    bytes.set(key, data);
    await f.pool.query(
      "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,source_etag,expires_at) VALUES($1,$2,'image.png',$3,$4,$5,$6,$7,'staging-etag',now()+interval '1 day')",
      [id, owner, contentType, data.length, `mio/staging/${id}`, key, state],
    );
    return { id, key, data };
  };
  return {
    ...f,
    assets,
    service,
    source,
    asset,
    read,
    objects,
    bytes,
    gate(value: typeof gate) {
      gate = value;
    },
  };
}

it('registers one owned ready immutable original, persists summaries but no signed URL, then normalizes actual review states', async () => {
  const f = await fixture(),
    group = await f.create(),
    asset = await f.asset();
  const request = randomUUID();
  const result = await f.service.register(f.actor, group.groupId, request, asset.id, 'Portrait');
  expect(result).toMatchObject({
    operation: { state: 'succeeded' },
    material: { state: 'processing', sourceAssetId: asset.id, pollAfterMs: 4000 },
  });
  const id = result.material!.materialId;
  const row = await f.store.ownedMaterial(f.actor.userId, id);
  expect(row.raw_snapshot).toMatchObject({
    version: 1,
    rawKey: asset.key,
    sha256: createHash('sha256').update(asset.data).digest('hex'),
    width: 300,
    height: 300,
    pages: 1,
    totalPixels: 90_000,
  });
  expect(JSON.stringify(row.raw_snapshot)).not.toContain('private');
  expect(
    (await f.pool.query('SELECT raw_key,state,source_etag FROM mio_assets WHERE id=$1', [asset.id]))
      .rows[0],
  ).toEqual({ raw_key: asset.key, state: 'ready', source_etag: 'staging-etag' });
  const call = f.transport.mock.calls.find(([url]) => String(url).includes('Action=CreateAsset&'))!;
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({
    GroupId: group.upstreamId,
    URL: `https://cos.example/${asset.key}?sign=private`,
    AssetType: 'Image',
    Name: 'Portrait',
  });
  expect(
    (await f.service.register(f.actor, group.groupId, request, asset.id, 'Portrait')).operation
      .operationId,
  ).toBe(result.operation.operationId);
  await expect(
    f.service.register(f.actor, group.groupId, request, asset.id, 'Different'),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  for (const status of ['Active', 'Rejected', 'unexpected']) {
    f.items.get(row.upstream_asset_id!)!.Status = status;
    await f.pool.query('UPDATE mio_materials SET next_query_at=NULL WHERE id=$1', [id]);
    expect((await f.service.refresh(f.actor, id)).state).toBe(
      status === 'Active' ? 'active' : status === 'Rejected' ? 'rejected' : 'unknown',
    );
  }
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=CreateAsset&')),
  ).toHaveLength(1);
  expect(f.objects.delete).not.toHaveBeenCalled();
});

it('admits one registration before source reads, rejecting parallel requests without allocating or queueing source bytes', async () => {
  const f = await fixture(),
    group = await f.create(),
    asset = await f.asset();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.gate(async () => {
    entered.resolve();
    await release.promise;
  });
  const first = f.service.register(f.actor, group.groupId, randomUUID(), asset.id);
  await entered.promise;
  const rejected = Array.from({ length: 10 }, () => {
    try {
      return f.service.register(f.actor, group.groupId, randomUUID(), asset.id);
    } catch (error) {
      return Promise.reject(error);
    }
  });
  for (const action of rejected)
    await expect(action).rejects.toMatchObject({ code: 'MATERIAL_BUSY' });
  expect(f.source).toHaveBeenCalledTimes(1);
  expect(f.read).toHaveBeenCalledTimes(1);
  release.resolve();
  expect((await first).operation.state).toBe('succeeded');
});

it('releases the registration slot only after failed native decode settles and allows the next registration', async () => {
  const f = await fixture(),
    group = await f.create(),
    asset = await f.asset();
  const entered = Promise.withResolvers<void>(),
    native = Promise.withResolvers<Buffer>();
  const raw = vi.spyOn(sharp.prototype, 'raw').mockImplementationOnce(function () {
    this.toBuffer = (async () => {
      entered.resolve();
      return native.promise;
    }) as typeof this.toBuffer;
    return this;
  });
  try {
    const first = f.service.register(f.actor, group.groupId, randomUUID(), asset.id);
    const failure = expect(first).rejects.toMatchObject({ code: 'MATERIAL_IMAGE_INVALID' });
    await entered.promise;
    await expect(
      f.service.register(f.actor, group.groupId, randomUUID(), asset.id),
    ).rejects.toMatchObject({ code: 'MATERIAL_BUSY' });
    native.reject(new Error('fixture native timeout'));
    await failure;
    expect(
      f.transport.mock.calls.filter(([url]) => String(url).includes('Action=CreateAsset&')),
    ).toHaveLength(0);
    expect(
      (await f.service.register(f.actor, group.groupId, randomUUID(), asset.id)).operation.state,
    ).toBe('succeeded');
  } finally {
    native.reject(new Error('fixture released'));
    raw.mockRestore();
  }
});

it.each(['other-asset', 'not-ready', 'other-group', 'corrupt', 'mime-mismatch', 'too-large'])(
  'rejects invalid registration before remote mutation and preserves source: %s',
  async (kind) => {
    const f = await fixture(),
      group = await f.create();
    const data = kind === 'corrupt' ? Buffer.from('not an image') : await png();
    const asset = await f.asset(
      data,
      kind === 'other-asset' ? 'other' : f.actor.userId,
      kind === 'not-ready' ? 'pending' : 'ready',
      kind === 'mime-mismatch' ? 'image/jpeg' : 'image/png',
    );
    if (kind === 'too-large')
      await f.pool.query('UPDATE mio_assets SET size_bytes=$2 WHERE id=$1', [
        asset.id,
        20 * 1024 * 1024 + 1,
      ]);
    const before = f.transport.mock.calls.length;
    await expect(
      f.service.register(
        kind === 'other-group' ? { userId: 'other', sessionId: 'other' } : f.actor,
        group.groupId,
        randomUUID(),
        asset.id,
      ),
    ).rejects.toBeDefined();
    expect(f.transport).toHaveBeenCalledTimes(before);
    expect(f.bytes.get(asset.key)).toBe(data);
    expect(f.objects.delete).not.toHaveBeenCalled();
  },
);

it('does not squeeze material input through the vision 10MiB budget and accepts the exact material 20MiB bound', async () => {
  const f = await fixture(),
    group = await f.create();
  const data = Buffer.alloc(20 * 1024 * 1024);
  (await png()).copy(data);
  const asset = await f.asset(data);
  await expect(
    f.assets.readVisionSource(f.actor.userId, asset.id, undefined, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'ASSET_INPUT_INVALID' });
  expect(
    (await f.service.register(f.actor, group.groupId, randomUUID(), asset.id)).operation.state,
  ).toBe('succeeded');
});

it('keeps raw identity checks in the same registration-intent transaction after validation', async () => {
  const f = await fixture(),
    group = await f.create(),
    asset = await f.asset();
  f.gate(async () => {
    await f.pool.query("UPDATE mio_assets SET state='expired' WHERE id=$1", [asset.id]);
  });
  await expect(
    f.service.register(f.actor, group.groupId, randomUUID(), asset.id),
  ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=CreateAsset&')),
  ).toHaveLength(0);
});

it('recovers known registration identity across restart with exact GetAsset and preserves unknown no-ID without reposting', async () => {
  const f = await fixture(),
    group = await f.create(),
    asset = await f.asset();
  // Trigger a real commit failure on the first remote mapping update; the fallback still persists.
  await f.pool.query(
    "CREATE FUNCTION reject_material_mapping() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.upstream_asset_id IS NOT NULL THEN RAISE EXCEPTION 'fixture mapping failure'; END IF; RETURN NEW; END $$",
  );
  await f.pool.query(
    'CREATE TRIGGER reject_material BEFORE UPDATE ON mio_materials FOR EACH ROW EXECUTE FUNCTION reject_material_mapping()',
  );
  const known = await f.service.register(f.actor, group.groupId, randomUUID(), asset.id);
  expect(known.operation.state).toBe('unknown');
  const original = await f.store.operation(f.actor.userId, known.operation.operationId);
  expect(original.protocol_snapshot).toMatchObject({
    upstreamId: expect.stringMatching(/^asset-/),
    upstreamGroupId: group.upstreamId,
  });
  await f.pool.query('DROP TRIGGER reject_material ON mio_materials');
  const restarted = createMaterialService(
    await createMaterialStore(f.database.url),
    f.provider,
    createMaterialUpstream(f.transport),
    f.assets,
  );
  try {
    expect(await restarted.operation(f.actor, known.operation.operationId)).toMatchObject({
      state: 'succeeded',
    });
  } finally {
    await restarted.close();
  }
  f.override(async (action) => {
    if (action === 'CreateAsset') throw new Error('LOST_ID');
    return;
  });
  const unknown = await f.service.register(f.actor, group.groupId, randomUUID(), asset.id);
  expect(unknown.operation.state).toBe('unknown');
  const calls = f.transport.mock.calls.length;
  expect(await f.service.operation(f.actor, unknown.operation.operationId)).toHaveProperty(
    'state',
    'unknown',
  );
  expect(f.transport).toHaveBeenCalledTimes(calls);
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=CreateAsset&')),
  ).toHaveLength(2);
});

it.each([403, 404])(
  'does not publish a recovered registration when exact GetAsset returns %s',
  async (status) => {
    const f = await fixture(),
      group = await f.create(),
      asset = await f.asset();
    f.override(async (action) => {
      if (action === 'CreateAsset') throw new Error('RESPONSE_LOST');
      return;
    });
    const result = await f.service.register(f.actor, group.groupId, randomUUID(), asset.id);
    const op = await f.store.operation(f.actor.userId, result.operation.operationId);
    // Persist an actually known response identity to exercise the existing recovery claim independently.
    await f.pool.query(
      'UPDATE mio_material_operations SET protocol_snapshot=protocol_snapshot||$2::jsonb WHERE id=$1',
      [op.id, { upstreamId: 'asset-20261120000000-abcde' }],
    );
    f.override(async (action) =>
      action === 'GetAsset'
        ? envelope(action, {}, status, status === 404 ? 'ResourceNotFound' : 'Forbidden')
        : undefined,
    );
    expect(await f.service.operation(f.actor, op.id)).toMatchObject({
      state: 'unknown',
      errorCode: status === 403 ? 'PROVIDER_RESOURCE_FORBIDDEN' : 'UPSTREAM_RESOURCE_NOT_FOUND',
    });
    expect(
      (
        await f.pool.query('SELECT upstream_asset_id,state FROM mio_materials WHERE id=$1', [
          op.target_material_id,
        ])
      ).rows[0],
    ).toEqual({ upstream_asset_id: null, state: 'unknown' });
  },
);

it('rejects a global remote material collision without rebinding and allows a source in a different allowed group', async () => {
  const f = await fixture(),
    one = await f.create(),
    two = await f.create(),
    asset = await f.asset();
  const first = await f.service.register(f.actor, one.groupId, randomUUID(), asset.id);
  const material = await f.store.ownedMaterial(f.actor.userId, first.material!.materialId);
  f.override(async (action) =>
    action === 'CreateAsset' ? envelope(action, { Id: material.upstream_asset_id }) : undefined,
  );
  const collision = await f.service.register(f.actor, two.groupId, randomUUID(), asset.id);
  expect(collision.operation).toMatchObject({
    state: 'unknown',
    errorCode: 'UPSTREAM_RESOURCE_COLLISION',
  });
  expect(
    (
      await f.pool.query('SELECT group_id FROM mio_materials WHERE upstream_asset_id=$1', [
        material.upstream_asset_id,
      ])
    ).rows,
  ).toEqual([{ group_id: one.groupId }]);
  expect(f.bytes.get(asset.key)).toBe(asset.data);
});

it('fails a raw ETag or actual length change without CreateAsset and retains immutable raw storage', async () => {
  const f = await fixture(),
    group = await f.create(),
    asset = await f.asset();
  f.gate(async () => {
    f.bytes.set(asset.key, Buffer.from(asset.data).fill(0));
  });
  await expect(
    f.service.register(f.actor, group.groupId, randomUUID(), asset.id),
  ).rejects.toMatchObject({ code: 'ASSET_SOURCE_CHANGED' });
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=CreateAsset&')),
  ).toHaveLength(0);
  expect(f.objects.delete).not.toHaveBeenCalled();
});

it('registers via the actual Cookie/Origin JSON handler using only local asset identity', async () => {
  const f = await fixture(),
    group = await f.create(),
    asset = await f.asset();
  const origin = 'https://fixture.client';
  const handler = createMaterialHandler(
    f.service,
    async (headers) => (headers.get('cookie') === 'session=owner' ? f.actor : null),
    [origin],
  );
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error();
  const url = `http://127.0.0.1:${address.port}/api/v1/materials/groups/${group.groupId}/materials`;
  const call = (body: unknown, cookie = 'session=owner') =>
    fetch(url, {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const input = { requestId: randomUUID(), assetId: asset.id };
  expect((await call(input, '')).status).toBe(401);
  expect((await call({ ...input, url: 'https://untrusted.example' })).status).toBe(400);
  const response = await call(input);
  expect(response.status, await response.clone().text()).toBe(201);
  expect(await response.json()).toMatchObject({
    material: { sourceAssetId: asset.id, state: 'processing' },
    operation: { state: 'succeeded' },
  });
});

it('freezes the original raw ETag across verification and signing instead of using the staging ETag', async () => {
  const f = await fixture(),
    group = await f.create(),
    asset = await f.asset();
  const create = f.transport.mock.calls.length;
  f.override(async (action) => {
    if (action === 'GetAssetGroup') {
      f.bytes.set(asset.key, Buffer.from(asset.data).fill(0));
    }
    return;
  });
  await expect(
    f.service.register(f.actor, group.groupId, randomUUID(), asset.id),
  ).rejects.toMatchObject({ code: 'ASSET_SOURCE_CHANGED' });
  expect(
    f.transport.mock.calls
      .slice(create)
      .filter(([url]) => String(url).includes('Action=CreateAsset&')),
  ).toHaveLength(0);
});

it('returns a persisted duplicate operation during another in-flight registration while rejecting unrelated new work before source read', async () => {
  const f = await fixture(),
    group = await f.create(),
    asset = await f.asset();
  const request = randomUUID();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.override(async (action) => {
    if (action === 'CreateAsset') {
      entered.resolve();
      await release.promise;
    }
    return;
  });
  const first = f.service.register(f.actor, group.groupId, request, asset.id);
  await entered.promise;
  const op = (
    await f.pool.query(
      "SELECT id FROM mio_material_operations WHERE owner_id=$1 AND kind='register_material' AND request_id=$2",
      [f.actor.userId, request],
    )
  ).rows[0];
  const count = f.source.mock.calls.length;
  expect(await f.service.register(f.actor, group.groupId, request, asset.id)).toMatchObject({
    operation: { operationId: op.id, state: 'creating' },
  });
  await expect(
    f.service.register(f.actor, group.groupId, randomUUID(), asset.id),
  ).rejects.toMatchObject({ code: 'MATERIAL_BUSY' });
  expect(f.source).toHaveBeenCalledTimes(count);
  release.resolve();
  expect((await first).operation.state).toBe('succeeded');
});

it('checks same-request operation inside the group lock before busy/revision admission across service instances', async () => {
  const f = await fixture(),
    group = await f.create(),
    asset = await f.asset();
  const request = randomUUID();
  const otherStore = await createMaterialStore(f.database.url);
  const other = createMaterialService(
    otherStore,
    f.provider,
    createMaterialUpstream(f.transport),
    f.assets,
  );
  const enter = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.override(async (action) => {
    if (action === 'CreateAsset') {
      enter.resolve();
      await release.promise;
    }
    return;
  });
  try {
    const first = f.service.register(f.actor, group.groupId, request, asset.id);
    await enter.promise;
    const op = (
      await f.pool.query(
        'SELECT * FROM mio_material_operations WHERE owner_id=$1 AND request_id=$2',
        [f.actor.userId, request],
      )
    ).rows[0];
    const material = (
      await f.pool.query('SELECT raw_snapshot FROM mio_materials WHERE id=$1', [
        op.target_material_id,
      ])
    ).rows[0];
    const { operation, fresh } = await otherStore.beginRegister(
      f.actor.userId,
      request,
      op.input_hash,
      await f.store.ownedGroup(f.actor.userId, group.groupId),
      asset.id,
      '',
      material.raw_snapshot,
      await f.provider.snapshotAccount(f.actor.userId),
    );
    expect(fresh).toBe(false);
    expect(operation.id).toBe(op.id);
    expect(await other.register(f.actor, group.groupId, request, asset.id)).toMatchObject({
      operation: { operationId: op.id },
    });
    release.resolve();
    expect((await first).operation.state).toBe('succeeded');
    expect(
      f.transport.mock.calls.filter(([url]) => String(url).includes('Action=CreateAsset&')),
    ).toHaveLength(1);
  } finally {
    release.resolve();
    await other.close();
  }
});

it('accepts an existing registered derived image using its local identity without another browser upload', async () => {
  const f = await fixture(),
    group = await f.create(),
    asset = await f.asset();
  const key = `mio/derived/${randomUUID()}/images/0-${randomUUID()}.png`;
  f.bytes.set(key, asset.data);
  f.bytes.delete(asset.key);
  await f.pool.query('UPDATE mio_assets SET raw_key=$2 WHERE id=$1', [asset.id, key]);
  expect(await f.service.register(f.actor, group.groupId, randomUUID(), asset.id)).toMatchObject({
    operation: { state: 'succeeded' },
    material: { sourceAssetId: asset.id },
  });
});

it('does not erase a registering entity locally or publish a late remote ID after its original lease expires', async () => {
  const f = await fixture(),
    group = await f.create(),
    asset = await f.asset();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.override(async (action) => {
    if (action === 'CreateAsset') {
      entered.resolve();
      await release.promise;
    }
    return;
  });
  const pending = f.service.register(f.actor, group.groupId, randomUUID(), asset.id);
  await entered.promise;
  const row = (
    await f.pool.query("SELECT * FROM mio_materials WHERE owner_id=$1 AND state='registering'", [
      f.actor.userId,
    ])
  ).rows[0];
  await expect(
    f.service.remove(f.actor, 'material', row.id, randomUUID(), row.revision, 'local'),
  ).rejects.toMatchObject({ code: 'MATERIAL_BUSY' });
  await f.pool.query(
    "UPDATE mio_material_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE target_material_id=$1",
    [row.id],
  );
  await f.pool.query(
    "UPDATE mio_material_groups SET sync_lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [group.groupId],
  );
  release.resolve();
  const result = await pending;
  expect(result.operation.state).toBe('unknown');
  expect((await f.store.ownedMaterial(f.actor.userId, row.id)).upstream_asset_id).toBeNull();
  expect(await f.service.operation(f.actor, result.operation.operationId)).toHaveProperty(
    'state',
    'succeeded',
  );
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=CreateAsset&')),
  ).toHaveLength(1);
});

it('blocks sync from importing an unknown pending registration as a second remote-only material', async () => {
  const f = await fixture(),
    group = await f.create(),
    asset = await f.asset();
  await f.pool.query(
    "CREATE FUNCTION fail_registered_mapping() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.upstream_asset_id IS NOT NULL THEN RAISE EXCEPTION 'mapping'; END IF; RETURN NEW; END $$",
  );
  await f.pool.query(
    'CREATE TRIGGER fail_mapping BEFORE UPDATE ON mio_materials FOR EACH ROW EXECUTE FUNCTION fail_registered_mapping()',
  );
  const result = await f.service.register(f.actor, group.groupId, randomUUID(), asset.id);
  expect(result.operation.state).toBe('unknown');
  await f.pool.query('DROP TRIGGER fail_mapping ON mio_materials');
  const calls = f.transport.mock.calls.length;
  await expect(f.service.sync(f.actor, group.groupId)).rejects.toMatchObject({
    code: 'MATERIAL_BUSY',
  });
  expect(f.transport).toHaveBeenCalledTimes(calls);
  expect(await f.service.operation(f.actor, result.operation.operationId)).toHaveProperty(
    'state',
    'succeeded',
  );
  await f.service.sync(f.actor, group.groupId);
  expect(
    (await f.pool.query('SELECT count(*) FROM mio_materials WHERE group_id=$1', [group.groupId]))
      .rows[0].count,
  ).toBe('1');
});
