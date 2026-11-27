import { randomUUID } from 'node:crypto';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { MaterialStore } from '../../src/materials/store.ts';
import { createMaterialService } from '../../src/materials/service.ts';
import { createMaterialUpstream } from '../../src/integrations/onelink/materials.ts';
import { blockedBy, materialFixture, peer } from './fixture.ts';
import type { MaterialFixture } from './fixture.ts';

async function fixture() {
  const f = await materialFixture();
  onTestFinished(() => f.close());
  return f;
}

function observed<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function registering(f: MaterialFixture) {
  const g = await f.create();
  const asset = randomUUID();
  await f.pool.query(
    "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at) VALUES($1,$2,'p.png','image/png',1,$3,'raw','ready',now()+interval '1 day')",
    [asset, f.actor.userId, `stage-${asset}`],
  );
  const source = {
    version: 1 as const,
    rawKey: 'raw',
    rawEtag: 'etag',
    size: 1,
    contentType: 'image/png',
    sha256: 'a'.repeat(64),
    width: 300,
    height: 300,
    pages: 1,
    totalPixels: 90000,
  };
  const { operation: op } = await f.store.beginRegister(
    f.actor.userId,
    randomUUID(),
    'a'.repeat(64),
    await f.store.ownedGroup(f.actor.userId, g.groupId),
    asset,
    '',
    source,
    await f.provider.snapshotAccount(f.actor.userId),
  );
  return { g, op };
}

it('serializes failure and registration completion at the group, preserving the returned anchor without a deadlock', async () => {
  const f = await fixture();
  const { g, op } = await registering(f);
  const failure = peer(f, 'failure'),
    completion = peer(f, 'completion');
  await f.pool.query(
    "CREATE FUNCTION pause_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='unknown' THEN PERFORM pg_advisory_xact_lock(hashtext(current_schema()),3); END IF; RETURN NEW; END $$",
  );
  await f.pool.query(
    'CREATE TRIGGER pause_failure BEFORE UPDATE ON mio_material_operations FOR EACH ROW EXECUTE FUNCTION pause_failure()',
  );
  const gate = await f.pool.connect();
  const remote = { id: 'asset-00000000000001-abcde', requestId: 'remote-receipt' };
  const pending: ReturnType<typeof observed<unknown>>[] = [];
  try {
    const pid = (
      await gate.query<{ pid: number }>(
        'SELECT pg_advisory_lock(hashtext(current_schema()),3),pg_backend_pid() AS pid',
      )
    ).rows[0]!.pid;
    pending.push(
      observed(
        failure.store.failOperation(f.actor.userId, op, true, 'UPSTREAM_RESULT_UNKNOWN', remote),
      ),
    );
    const holder = await blockedBy(f, failure.name, pid);
    pending.push(
      observed(completion.store.finishRegister(f.actor.userId, op, remote.id, remote.requestId)),
    );
    const waiter = await blockedBy(f, completion.name, holder);
    // Inspect the actual tuple wait, not SQL text or timing. Baseline waits on O here.
    expect(
      (
        await f.pool.query(
          "SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE l.pid=$1 AND l.locktype='tuple'",
          [waiter],
        )
      ).rows,
    ).toEqual([{ relname: 'mio_material_groups' }]);
  } finally {
    await gate.query('SELECT pg_advisory_unlock(hashtext(current_schema()),3)');
    gate.release();
    await Promise.all(pending);
  }
  const outcomes = await Promise.all(pending);
  expect(outcomes[0]).toMatchObject({ ok: true });
  expect(outcomes[1]).toMatchObject({
    ok: false,
    error: { code: 'MATERIAL_OPERATION_SUPERSEDED' },
  });
  expect(await f.store.operation(f.actor.userId, op.id)).toMatchObject({
    state: 'unknown',
    protocol_snapshot: { upstreamId: remote.id },
    upstream_request_id: remote.requestId,
  });
  expect(await f.store.ownedMaterial(f.actor.userId, op.target_material_id!)).toMatchObject({
    state: 'unknown',
    upstream_asset_id: null,
  });
  expect(await f.store.ownedGroup(f.actor.userId, g.groupId)).toMatchObject({
    state: 'ready',
    sync_lease_id: null,
  });
});

it.each(['finishCreate', 'failOperation', 'finishDelete'] as const)(
  '%s waits for G without holding O',
  async (method) => {
    const f = await fixture();
    const worker = peer(f, method);
    const credential = await f.provider.snapshotAccount(f.actor.userId);
    const op =
      method === 'finishDelete'
        ? await (async () => {
            const g = await f.create();
            return (
              await f.store.beginDelete(
                f.actor.userId,
                randomUUID(),
                'b'.repeat(64),
                'group',
                g.groupId,
                g.revision,
                credential,
                { upstreamId: g.upstreamId, confirmCascade: true },
              )
            ).operation;
          })()
        : (
            await f.store.beginCreate(
              f.actor.userId,
              randomUUID(),
              'b'.repeat(64),
              'Target',
              credential,
            )
          ).operation;
    const gate = await f.pool.connect();
    let pending: ReturnType<typeof observed<void>> | undefined;
    try {
      await gate.query('BEGIN');
      const pid = (await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid;
      await gate.query('SELECT id FROM mio_material_groups WHERE id=$1 FOR UPDATE', [
        op.target_group_id,
      ]);
      pending = observed(
        method === 'finishCreate'
          ? worker.store.finishCreate(f.actor.userId, op, 'group-00000000000001-abcde', null)
          : method === 'finishDelete'
            ? worker.store.finishDelete(f.actor.userId, op)
            : worker.store.failOperation(f.actor.userId, op, true, 'UPSTREAM_RESULT_UNKNOWN'),
      );
      await blockedBy(f, worker.name, pid);
      // An O-first implementation would fail NOWAIT, establishing the AB-BA edge.
      await gate.query('SELECT id FROM mio_material_operations WHERE id=$1 FOR UPDATE NOWAIT', [
        op.id,
      ]);
    } finally {
      await gate.query('ROLLBACK');
      gate.release();
      if (pending) expect(await pending).toMatchObject({ ok: true });
    }
  },
);

it('acquires G before a new delete request can wait on the unique operation identity', async () => {
  const f = await fixture(),
    g = await f.create(),
    worker = peer(f, 'delete_admit');
  const credential = await f.provider.snapshotAccount(f.actor.userId);
  const request = randomUUID(),
    inputHash = 'c'.repeat(64);
  const gate = await f.pool.connect();
  let pending:
    ReturnType<typeof observed<Awaited<ReturnType<MaterialStore['beginDelete']>>>> | undefined;
  try {
    await gate.query('BEGIN');
    await gate.query("SET LOCAL lock_timeout='750ms'");
    const pid = (await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await gate.query('SELECT id FROM mio_material_groups WHERE id=$1 FOR UPDATE', [g.groupId]);
    pending = observed(
      worker.store.beginDelete(
        f.actor.userId,
        request,
        inputHash,
        'group',
        g.groupId,
        g.revision,
        credential,
        { upstreamId: g.upstreamId, confirmCascade: true },
      ),
    );
    await blockedBy(f, worker.name, pid);
    await gate.query(
      "INSERT INTO mio_material_operations(id,owner_id,request_id,kind,input_hash,state,provider_config_id,credential_version,protocol_snapshot) VALUES($1,$2,$3,'delete_group_upstream',$4,'deleting',$5,1,'{\"version\":1}')",
      [randomUUID(), f.actor.userId, request, inputHash, credential.providerConfigId],
    );
  } finally {
    await gate.query('ROLLBACK');
    gate.release();
  }
  expect(await pending).toMatchObject({
    ok: true,
    value: { fresh: true, operation: { target_group_id: g.groupId } },
  });
});

it.each(['creating', 'deleting', 'succeeded', 'failed', 'unknown'] as const)(
  'polls a %s operation with one unlocked read',
  async (state) => {
    const f = await fixture(),
      worker = peer(f, 'poll');
    const { operation: op } = await f.store.beginCreate(
      f.actor.userId,
      randomUUID(),
      'd'.repeat(64),
      'Target',
      await f.provider.snapshotAccount(f.actor.userId),
    );
    await f.pool.query(
      "UPDATE mio_material_operations SET state=$2,lease_until=clock_timestamp()+interval '1 hour' WHERE id=$1",
      [op.id, state],
    );
    const gate = await f.pool.connect();
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM mio_material_operations WHERE id=$1 FOR UPDATE', [op.id]);
      const query = vi.spyOn(worker.pool, 'query');
      try {
        expect(await worker.store.operation(f.actor.userId, op.id)).toMatchObject({
          id: op.id,
          state,
        });
        expect(query).toHaveBeenCalledOnce();
      } finally {
        query.mockRestore();
      }
    } finally {
      await gate.query('ROLLBACK');
      gate.release();
    }
  },
);

it('rechecks expiry and completion after waiting for G instead of overwriting a committed success', async () => {
  const f = await fixture(),
    worker = peer(f, 'expiry');
  const { operation: op } = await f.store.beginCreate(
    f.actor.userId,
    randomUUID(),
    'e'.repeat(64),
    'Target',
    await f.provider.snapshotAccount(f.actor.userId),
  );
  await f.pool.query(
    "UPDATE mio_material_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [op.id],
  );
  const gate = await f.pool.connect();
  let pending:
    ReturnType<typeof observed<Awaited<ReturnType<MaterialStore['operation']>>>> | undefined;
  try {
    await gate.query('BEGIN');
    const pid = (await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await gate.query('SELECT id FROM mio_material_groups WHERE id=$1 FOR UPDATE', [
      op.target_group_id,
    ]);
    pending = observed(worker.store.operation(f.actor.userId, op.id));
    await blockedBy(f, worker.name, pid);
    await gate.query(
      "UPDATE mio_material_operations SET state='succeeded',lease_id=NULL,lease_until=NULL WHERE id=$1",
      [op.id],
    );
    await gate.query(
      "UPDATE mio_material_groups SET state='ready',upstream_group_id='group-00000000000001-abcde' WHERE id=$1",
      [op.target_group_id],
    );
    await gate.query('COMMIT');
  } finally {
    await gate.query('ROLLBACK');
    gate.release();
  }
  expect(await pending).toMatchObject({ ok: true, value: { state: 'succeeded', lease_id: null } });
  expect(await f.store.ownedGroup(f.actor.userId, op.target_group_id!)).toMatchObject({
    state: 'ready',
  });
});

it('retains a late known-create anchor through concurrent expiry, then recovers using one create POST', async () => {
  const f = await fixture(),
    expiry = peer(f, 'expiry'),
    creator = peer(f, 'creator');
  const service = createMaterialService(
    creator.store,
    f.provider,
    createMaterialUpstream(f.transport),
  );
  const entered = Promise.withResolvers<void>(),
    remote = Promise.withResolvers<void>();
  f.override(async (action) => {
    if (action === 'CreateAssetGroup') {
      entered.resolve();
      await remote.promise;
    }
    return;
  });
  const request = randomUUID();
  const creating = observed(service.createGroup(f.actor, request, 'Late'));
  await entered.promise;
  const op = (
    await f.pool.query('SELECT * FROM mio_material_operations WHERE request_id=$1', [request])
  ).rows[0];
  await f.pool.query(
    "UPDATE mio_material_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [op.id],
  );
  const gate = await f.pool.connect();
  let polling:
    ReturnType<typeof observed<Awaited<ReturnType<MaterialStore['operation']>>>> | undefined;
  try {
    await gate.query('BEGIN');
    const pid = (await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await gate.query('SELECT id FROM mio_material_groups WHERE id=$1 FOR UPDATE', [
      op.target_group_id,
    ]);
    polling = observed(expiry.store.operation(f.actor.userId, op.id));
    const waiter = await blockedBy(f, expiry.name, pid);
    remote.resolve();
    await blockedBy(f, creator.name, waiter);
  } finally {
    remote.resolve();
    await gate.query('ROLLBACK');
    gate.release();
  }
  expect(await polling).toMatchObject({ ok: true, value: { state: 'unknown' } });
  expect(await creating).toMatchObject({ ok: true, value: { operation: { state: 'unknown' } } });
  const persisted = await f.store.operation(f.actor.userId, op.id);
  expect(persisted.protocol_snapshot.upstreamId).toBe([...f.groups.keys()][0]);
  expect(persisted.upstream_request_id).toEqual(expect.any(String));
  expect(await service.operation(f.actor, op.id)).toMatchObject({ state: 'succeeded' });
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=CreateAssetGroup')),
  ).toHaveLength(1);
});

it('reports fallback database failure instead of returning a normal operation and never blindly reposts a known create', async () => {
  const f = await fixture();
  await f.pool.query(
    "CREATE FUNCTION reject_mapping() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.upstream_group_id IS NOT NULL THEN RAISE EXCEPTION 'fixture mapping failure'; END IF; RETURN NEW; END $$",
  );
  await f.pool.query(
    'CREATE TRIGGER reject_mapping BEFORE UPDATE ON mio_material_groups FOR EACH ROW EXECUTE FUNCTION reject_mapping()',
  );
  await f.pool.query(
    "CREATE FUNCTION reject_fallback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.protocol_snapshot ? 'upstreamId' THEN RAISE SQLSTATE '40P01' USING MESSAGE='fixture settlement failure'; END IF; RETURN NEW; END $$",
  );
  await f.pool.query(
    'CREATE TRIGGER reject_fallback BEFORE UPDATE ON mio_material_operations FOR EACH ROW EXECUTE FUNCTION reject_fallback()',
  );
  const request = randomUUID();
  await expect(f.service.createGroup(f.actor, request, 'Returned')).rejects.toMatchObject({
    code: 'MATERIAL_UNAVAILABLE',
  });
  expect(await f.service.createGroup(f.actor, request, 'Returned')).toMatchObject({
    operation: { state: 'creating' },
  });
  const rows = (
    await f.pool.query('SELECT protocol_snapshot,upstream_request_id FROM mio_material_operations')
  ).rows;
  // The database failure genuinely left no durable anchor; propagation is not durability.
  expect(rows).toEqual([{ protocol_snapshot: { version: 1 }, upstream_request_id: null }]);
  expect(f.groups.size).toBe(1);
  expect(
    f.transport.mock.calls.filter(([url]) => String(url).includes('Action=CreateAssetGroup')),
  ).toHaveLength(1);
});

it('admits exactly one group under concurrent identical create request identities', async () => {
  const f = await fixture(),
    one = peer(f, 'create_one'),
    two = peer(f, 'create_two');
  const gate = await f.pool.connect();
  const request = randomUUID(),
    credential = await f.provider.snapshotAccount(f.actor.userId);
  await f.pool.query(
    'CREATE FUNCTION pause_admit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtext(current_schema()),4); RETURN NEW; END $$',
  );
  await f.pool.query(
    'CREATE TRIGGER pause_admit BEFORE INSERT ON mio_material_operations FOR EACH ROW EXECUTE FUNCTION pause_admit()',
  );
  const pending: ReturnType<typeof observed<Awaited<ReturnType<MaterialStore['beginCreate']>>>>[] =
    [];
  try {
    const pid = (
      await gate.query<{ pid: number }>(
        'SELECT pg_advisory_lock(hashtext(current_schema()),4),pg_backend_pid() AS pid',
      )
    ).rows[0]!.pid;
    pending.push(
      observed(one.store.beginCreate(f.actor.userId, request, 'f'.repeat(64), 'One', credential)),
    );
    const holder = await blockedBy(f, one.name, pid);
    pending.push(
      observed(two.store.beginCreate(f.actor.userId, request, 'f'.repeat(64), 'One', credential)),
    );
    await vi.waitFor(
      async () => {
        const rows = (
          await f.pool.query(
            'SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=$1',
            [two.name],
          )
        ).rows;
        expect(rows[0]?.blockers.some((id: number) => id === pid || id === holder)).toBe(true);
      },
      { timeout: 2500, interval: 10 },
    );
  } finally {
    await gate.query('SELECT pg_advisory_unlock(hashtext(current_schema()),4)');
    gate.release();
  }
  const results = await Promise.all(pending);
  expect(results.every((result) => result.ok)).toBe(true);
  const claims = results.map((result) => {
    if (!result.ok) throw result.error;
    return result.value;
  });
  expect(claims.map((claim) => claim.fresh).sort()).toEqual([false, true]);
  expect(claims[0]!.operation.id).toBe(claims[1]!.operation.id);
  expect((await f.pool.query('SELECT id FROM mio_material_groups')).rows).toEqual([
    { id: claims[0]!.operation.target_group_id },
  ]);
});
