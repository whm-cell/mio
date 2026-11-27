import { randomUUID } from 'node:crypto';
import { expect, it, onTestFinished } from 'vitest';
import { blockedBy, materialFixture, peer } from './fixture.ts';
import type { MaterialStore } from '../../src/materials/store.ts';
import { materialSchemaSQL } from '../../src/materials/schema.ts';

async function fixture() {
  const f = await materialFixture();
  onTestFinished(() => f.close());
  return f;
}

it.each(['creating', 'deleting', 'unknown'])(
  'blocks local and remote member deletion for a %s group operation with a NULL material target',
  async (state) => {
    const f = await fixture(),
      group = await f.create();
    f.add(group.upstreamId);
    await f.service.sync(f.actor, group.groupId);
    const material = (await f.store.materials(f.actor.userId, group.groupId, 10))[0]!;
    await f.pool.query(
      "UPDATE mio_material_operations SET state=$2,kind='delete_group_upstream',target_material_id=NULL WHERE target_group_id=$1",
      [group.groupId, state],
    );
    const before = f.transport.mock.calls.length;
    await expect(
      f.store.removeLocal(f.actor.userId, 'material', material.id, material.revision),
    ).rejects.toMatchObject({ code: 'MATERIAL_BUSY' });
    await expect(
      f.store.beginDelete(
        f.actor.userId,
        randomUUID(),
        'a'.repeat(64),
        'material',
        material.id,
        material.revision,
        await f.provider.snapshotAccount(f.actor.userId),
      ),
    ).rejects.toMatchObject({ code: 'MATERIAL_BUSY' });
    expect(await f.store.ownedMaterial(f.actor.userId, material.id)).toMatchObject({
      state: 'active',
      revision: material.revision,
    });
    expect((await f.pool.query('SELECT id FROM mio_material_operations')).rows).toHaveLength(1);
    expect(f.transport).toHaveBeenCalledTimes(before);
  },
);

it('blocks local removal while the group is deleting even without an active operation or lease', async () => {
  const f = await fixture(),
    group = await f.create();
  f.add(group.upstreamId);
  await f.service.sync(f.actor, group.groupId);
  const material = (await f.store.materials(f.actor.userId, group.groupId, 10))[0]!;
  await f.pool.query(
    "UPDATE mio_material_groups SET state='deleting',sync_lease_id=NULL,sync_lease_until=NULL WHERE id=$1",
    [group.groupId],
  );
  await expect(
    f.store.removeLocal(f.actor.userId, 'material', material.id, material.revision),
  ).rejects.toMatchObject({ code: 'MATERIAL_BUSY' });
  expect(await f.store.ownedMaterial(f.actor.userId, material.id)).toMatchObject({
    state: 'active',
    revision: material.revision,
  });
});

it('allows an unrelated member tombstone while another material in its group has an unknown operation', async () => {
  const f = await fixture(),
    group = await f.create();
  f.add(group.upstreamId, 1);
  f.add(group.upstreamId, 2);
  await f.service.sync(f.actor, group.groupId);
  const [busy, idle] = await f.store.materials(f.actor.userId, group.groupId, 10);
  await f.pool.query(
    "UPDATE mio_material_operations SET kind='delete_material_upstream',state='unknown',target_material_id=$2 WHERE target_group_id=$1",
    [group.groupId, busy!.id],
  );
  expect(
    await f.store.removeLocal(f.actor.userId, 'material', idle!.id, idle!.revision),
  ).toMatchObject({ state: 'deleted' });
  await expect(
    f.store.removeLocal(f.actor.userId, 'material', busy!.id, busy!.revision),
  ).rejects.toMatchObject({ code: 'MATERIAL_BUSY' });
});

it('preserves typed/untyped cursor pages, counts, ownership and microseconds while omitting only list source snapshots', async () => {
  const f = await fixture();
  const groups: { id: string; type: 'real' | 'aigc' }[] = [];
  for (let n = 0; n < 7; n++) {
    const group = await f.create(`Group ${n}`);
    const type = n % 2 ? 'real' : 'aigc';
    await f.pool.query(
      "UPDATE mio_material_groups SET group_type=$2,auth_status=$3,created_at='2026-01-01T00:00:00.123456Z' WHERE id=$1",
      [group.groupId, type, type === 'real' ? 'verified' : 'not_applicable'],
    );
    groups.push({ id: group.groupId, type });
  }
  const deleted = groups.pop()!;
  await f.store.removeLocal(f.actor.userId, 'group', deleted.id, 1);
  const other = { userId: randomUUID(), sessionId: 'other' };
  await f.provider.save(other, 0, 'synthetic-other-key');
  await f.service.createGroup(other, randomUUID(), 'Other');
  const source = { snapshot: 'x'.repeat(2000) };
  const expectedMaterials: string[] = [];
  const group = groups[0]!;
  for (let n = 0; n < 6; n++) {
    const id = randomUUID();
    const state = n === 0 ? 'deleted' : n === 1 ? 'unknown' : 'active';
    await f.pool.query(
      "INSERT INTO mio_materials(id,owner_id,provider_type,group_id,asset_type,name,state,raw_snapshot,registration_credential_version,created_at) VALUES($1,$2,'onelink',$3,'image','Item',$4,$5,1,'2026-01-01T00:00:00.123456Z')",
      [id, f.actor.userId, group.id, state, source],
    );
    if (state !== 'deleted') expectedMaterials.push(id);
  }
  for (const type of [undefined, 'aigc', 'real']) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await f.service.groups(f.actor, type, 2, cursor);
      for (const item of result.items) {
        ids.push(item.groupId);
        expect(item.materialCount).toBe(item.groupId === group.id ? 5 : 0);
      }
      if (result.nextCursor)
        expect(JSON.parse(Buffer.from(result.nextCursor, 'base64url').toString()).createdAt).toBe(
          '2026-01-01T00:00:00.123456Z',
        );
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(
      groups
        .filter((g) => type === undefined || g.type === type)
        .map((g) => g.id)
        .sort()
        .reverse(),
    );
  }
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await f.service.materials(f.actor, group.id, 2, cursor);
    ids.push(...result.items.map((item) => item.materialId));
    expect(result.items.every((item) => !('raw_snapshot' in item))).toBe(true);
    if (result.nextCursor)
      expect(JSON.parse(Buffer.from(result.nextCursor, 'base64url').toString()).createdAt).toBe(
        '2026-01-01T00:00:00.123456Z',
      );
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  expect(ids).toEqual(expectedMaterials.sort().reverse());
  const rows = await f.store.materials(f.actor.userId, group.id, 10);
  expect(rows).toHaveLength(5);
  expect(rows.every((row) => !('raw_snapshot' in row))).toBe(true);
  expect((await f.store.ownedMaterial(f.actor.userId, rows[0]!.id)).raw_snapshot).toEqual(source);
  expect(await f.service.groups(f.actor, "aigc' OR true --", 10)).toEqual({
    items: [],
    nextCursor: null,
  });
  await expect(f.service.materials(other, group.id, 10)).rejects.toMatchObject({
    code: 'MATERIAL_NOT_FOUND',
  });
});

it('counts the selected group page in the same snapshot when a material commits during the count', async () => {
  const f = await fixture(),
    group = await f.create();
  f.add(group.upstreamId);
  await f.service.sync(f.actor, group.groupId);
  const { name, store: reader } = peer(f, 'snapshot');
  // Pause the count after PostgreSQL establishes its snapshot. A fixture-only view applies
  // to both CI superusers and local regression roles, unlike row-level policies.
  await f.pool.query(
    'CREATE FUNCTION pause_snapshot() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtext(current_schema()),5); RETURN true; END $$',
  );
  await f.pool.query('ALTER TABLE mio_materials RENAME TO mio_materials_snapshot_source');
  await f.pool.query(
    'CREATE VIEW mio_materials WITH (security_barrier=true) AS SELECT * FROM mio_materials_snapshot_source WHERE pause_snapshot()',
  );
  const gate = await f.pool.connect();
  let pending: ReturnType<MaterialStore['groups']> | undefined;
  try {
    const pid = (
      await gate.query<{ pid: number }>(
        'SELECT pg_advisory_lock(hashtext(current_schema()),5),pg_backend_pid() AS pid',
      )
    ).rows[0]!.pid;
    pending = reader.groups(f.actor.userId, undefined, 10);
    await blockedBy(f, name, pid);
    await f.pool.query(
      "INSERT INTO mio_materials(id,owner_id,provider_type,group_id,asset_type,name,state,registration_credential_version) VALUES($1,$2,'onelink',$3,'image','Concurrent','active',1)",
      [randomUUID(), f.actor.userId, group.groupId],
    );
  } finally {
    await gate.query('SELECT pg_advisory_unlock(hashtext(current_schema()),5)');
    gate.release();
  }
  expect((await pending)![0]!.material_count).toBe(1);
  expect((await reader.groups(f.actor.userId, undefined, 10))[0]!.material_count).toBe(2);
});

it('adds five access-path indexes idempotently to existing tables without changing stored rows or uniqueness', async () => {
  const f = await fixture(),
    group = await f.create();
  f.add(group.upstreamId);
  await f.service.sync(f.actor, group.groupId);
  const indexes = [
    'mio_material_groups_live_page',
    'mio_material_groups_live_type_page',
    'mio_materials_live_group_page',
    'mio_material_operations_active_group',
    'mio_material_operations_active_material',
  ];
  for (const index of indexes) await f.pool.query(`DROP INDEX ${index}`);
  await f.pool.query(
    'CREATE INDEX mio_material_groups_owner_page ON mio_material_groups(owner_id,group_type,created_at DESC,id DESC)',
  );
  await f.pool.query(
    'CREATE INDEX mio_materials_group_page ON mio_materials(owner_id,group_id,created_at DESC,id DESC)',
  );
  const stored = async () =>
    Promise.all(
      ['mio_material_groups', 'mio_materials', 'mio_material_operations'].map(
        async (table) => (await f.pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows,
      ),
    );
  const before = await stored();
  await f.pool.query(materialSchemaSQL);
  await f.pool.query(materialSchemaSQL);
  expect(await stored()).toEqual(before);
  expect(
    (
      await f.pool.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('mio_material_groups_owner_page','mio_materials_group_page')",
      )
    ).rows,
  ).toEqual([]);
  const definitions = (
    await f.pool.query<{ name: string; valid: boolean; predicate: string }>(
      "SELECT ix.relname AS name,i.indisvalid AS valid,pg_get_expr(i.indpred,i.indrelid) AS predicate FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid WHERE i.indrelid IN ('mio_material_groups'::regclass,'mio_materials'::regclass,'mio_material_operations'::regclass) AND ix.relname=ANY($1::text[])",
      [indexes],
    )
  ).rows;
  expect(definitions).toHaveLength(5);
  expect(definitions.every((index) => index.valid)).toBe(true);
  expect(
    definitions
      .filter((index) => index.name.includes('live_'))
      .every((index) => index.predicate === "(state <> 'deleted'::text)"),
  ).toBe(true);
  expect(
    definitions
      .filter((index) => index.name.includes('active_'))
      .every((index) => index.predicate.includes("'unknown'")),
  ).toBe(true);
  const unique = (
    await f.pool.query(
      "SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('mio_materials_upstream_unique','mio_material_groups_upstream_unique') ORDER BY indexname",
    )
  ).rows;
  expect(unique).toHaveLength(2);
  expect(
    unique.every(
      (index) =>
        index.indexdef.startsWith('CREATE UNIQUE INDEX') && !index.indexdef.includes('owner_id'),
    ),
  ).toBe(true);
});
