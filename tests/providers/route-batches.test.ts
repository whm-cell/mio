import { expect, it } from 'vitest';
import { makeAudioRouteFixture } from './fixtures/onelink-audio-route.ts';
import { providerSqlFixture } from './fixtures/provider-sql-fixture.ts';

it('locks reversed existing route imports in C order while retaining caller revision order and actions', async () => {
  const ids = ['z-lock', 'A-lock', 'é-lock', '\uE000-lock', '\u{10000}-lock'];
  const f = await providerSqlFixture(ids);
  let arrive = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const peers = [0, 1].map(() => {
    let first = true;
    return f.peer(async (sql, args, result) => {
      // Old scalar loops deterministically deadlock here; set locks return every row before this hook.
      if (
        first &&
        sql.includes('FOR UPDATE') &&
        result.rows.length === 1 &&
        typeof args?.[0] === 'string'
      ) {
        first = false;
        if (++arrive === 2) release();
        await gate;
      }
    });
  });
  const actor = {
    actorType: 'admin' as const,
    actorId: f.account.id,
    actorName: f.account.username,
    summary: 'ordered batch',
  };
  const orders = [ids, [...ids].reverse()];
  const results = await Promise.all(
    peers.map((peer, i) =>
      peer.store.importRoutes(
        orders[i]!.map((id) => ({ ...f.route(id), sourceVersion: 'worker-' + i })),
        actor,
      ),
    ),
  );
  for (let i = 0; i < results.length; i++) {
    expect(results[i]).toMatchObject({
      total: ids.length,
      updated: ids.length,
      inserted: 0,
      unchanged: 0,
    });
    expect(results[i]!.revisions.map((r) => r.rawModelId)).toEqual(orders[i]);
    expect(results[i]!.revisions.every((r) => r.action === 'update')).toBe(true);
  }
  const version = Math.max(
    ...results.flatMap((result) => result.revisions.map((r) => r.declarationVersion)),
  );
  const source = (
    await f.pool.query(
      'SELECT source_version FROM mio_provider_model_routes WHERE raw_model_id=$1',
      [ids[0]],
    )
  ).rows[0].source_version as string;
  const toggled = await f.store.importRoutes(
    orders[1]!.map((id) => ({ ...f.route(id), sourceVersion: source, enabled: false })),
    actor,
  );
  expect(
    toggled.revisions.every((r) => r.action === 'disable' && r.declarationVersion === version + 1),
  ).toBe(true);
  expect(
    await f.store.importRoutes(
      orders[1]!.map((id) => ({ ...f.route(id), sourceVersion: source, enabled: false })),
      actor,
    ),
  ).toMatchObject({ unchanged: ids.length, revisions: [] });
});

it('uses four body queries for both one and 500 route writes and two for unchanged imports', async () => {
  const f = await providerSqlFixture();
  const peer = f.peer();
  for (const n of [1, 500]) {
    const entries = Array.from({ length: n }, (_, i) => f.route(`constant-${n}-${i}`));
    peer.trace.length = 0;
    const result = await peer.store.importRoutes(entries);
    expect(result.inserted).toBe(n);
    expect(peer.trace).toHaveLength(6);
    peer.trace.length = 0;
    expect(await peer.store.importRoutes(entries)).toMatchObject({ unchanged: n, revisions: [] });
    expect(peer.trace).toHaveLength(4);
  }
});

it('keeps first catalog metadata for distinct operations of the same model and rejects duplicate route keys', async () => {
  const f = await providerSqlFixture();
  const id = 'same-model';
  const first = f.route(id);
  const second = makeAudioRouteFixture(id);
  const result = await f.store.importRoutes([first, second]);
  expect(result.inserted).toBe(2);
  expect(
    (
      await f.pool.query(
        'SELECT vendor_label,category FROM mio_provider_catalog_models WHERE raw_model_id=$1',
        [id],
      )
    ).rows[0],
  ).toEqual({ vendor_label: 'openai', category: 'chat' });
  await expect(f.store.importRoutes([first, first])).rejects.toMatchObject({
    code: 'ROUTE_INVALID',
  });
});

it('rolls back catalog registration and every route write when revision insertion fails', async () => {
  const f = await providerSqlFixture();
  await f.pool
    .query(`CREATE FUNCTION fail_revision() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture revision failure'; END$$;
    CREATE TRIGGER fail_revision BEFORE INSERT ON mio_provider_model_route_revisions FOR EACH ROW EXECUTE FUNCTION fail_revision()`);
  await expect(
    f.store.importRoutes([f.route('rollback-a'), f.route('rollback-b')]),
  ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM mio_provider_catalog_models WHERE raw_model_id LIKE 'rollback-%'",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM mio_provider_model_routes WHERE raw_model_id LIKE 'rollback-%'",
      )
    ).rows[0].n,
  ).toBe(0);
});
