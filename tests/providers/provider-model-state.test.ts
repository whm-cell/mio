import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { findModel, modelReference } from '../../src/providers/catalog.ts';
import { providerSqlFixture } from './fixtures/provider-sql-fixture.ts';

it('returns only exact-model state, omits full discovery and keeps the public provider/list projection intact', async () => {
  const f = await providerSqlFixture();
  const ref = modelReference(f.models[0]!.model_key);
  const ids = Array.from({ length: 2000 }, (_, i) => 'discovered-' + i);
  await f.pool.query(
    'UPDATE mio_provider_configs SET discovery=jsonb_set(discovery,$2,$3::jsonb) WHERE id=$1',
    [f.providerId, ['ids'], JSON.stringify(ids)],
  );
  const query = vi.spyOn(f.pool, 'query');
  const point = await f.store.modelState(f.actor.userId, ref);
  expect(query).toHaveBeenCalledTimes(1);
  query.mockRestore();
  expect(point!.models.map((m) => m.model_key)).toEqual([f.models[0]!.model_key]);
  expect(point!.discovery).toBeNull();
  expect(point).not.toHaveProperty('verifications');
  expect((await f.store.state(f.actor.userId))!.discovery!.ids).toEqual(ids);
  expect((await f.service.get(f.actor))!.discovery!.ids).toEqual(ids);
  const snapshot = await f.service.resolveChat(f.actor, await f.service.selectChat(f.actor, ref));
  expect(snapshot.apiKey).toBe('synthetic-sql-key');
  const view = await f.store.preference(
    f.actor.userId,
    (await f.store.current(f.actor.userId))!.revision,
    ref,
    undefined,
    { name: 'display' },
  );
  expect(view.discovery!.ids).toEqual(ids);
});

it('matches canonical, legacy and alias collisions in existing C order without unsafe UUID casts', async () => {
  const f = await providerSqlFixture(['a-model', 'z-model']);
  const key = f.models.find((m) => m.raw_model_id === 'z-model')!.model_key;
  await f.pool.query(
    'UPDATE mio_provider_models SET legacy_ref=$2 WHERE provider_id=$1 AND raw_model_id=$3',
    [f.providerId, modelReference(key), 'a-model'],
  );
  const historical = randomUUID();
  await f.pool.query(
    "INSERT INTO mio_provider_models(provider_id,model_key,legacy_ref,membership_state) VALUES($1,$2,'pre-dynamic','historical')",
    [f.providerId, historical],
  );
  const nonV4 = '123e4567-e89b-12d3-a456-426614174000';
  await f.pool.query(
    "INSERT INTO mio_provider_models(provider_id,model_key,raw_model_id,membership_state) VALUES($1,$2,'non-v4','historical')",
    [f.providerId, nonV4],
  );
  const full = (await f.store.state(f.actor.userId, false))!;
  for (const ref of [
    modelReference(key),
    'onelink:chat:z-model',
    'onelink:image:a-model',
    'pre-dynamic',
    modelReference(nonV4),
    modelReference(key).toUpperCase(),
    'onelink:model:invalid',
    "x'); DROP TABLE ignored; --",
  ]) {
    const expected = findModel(full.models, ref);
    const point = (await f.store.modelState(f.actor.userId, ref))!;
    expect(point.id).toBe(f.providerId);
    expect(point.models).toEqual(expected ? [expected] : []);
    expect(point.routes).toEqual(
      full.routes!.filter((r) => expected?.raw_model_id === r.raw_model_id),
    );
    expect(point.catalog_models).toEqual(
      full.catalog_models!.filter((r) => expected?.raw_model_id === r.raw_model_id),
    );
    expect(point.preferences).toEqual(
      full.preferences.filter((r) => expected?.model_key === r.model_key),
    );
  }
  expect(await f.store.modelState('missing-owner', modelReference(key))).toBeNull();
});

it('keeps provider/currentness errors ahead of missing-model errors and retains public default selection', async () => {
  const f = await providerSqlFixture();
  const ref = modelReference(f.models[0]!.model_key);
  await f.store.preference(
    f.actor.userId,
    (await f.store.current(f.actor.userId))!.revision,
    ref,
    'chat',
    { isDefault: true },
  );
  expect((await f.service.selectChat(f.actor)).modelKey).toBe(f.models[0]!.model_key);
  await f.store.settings(f.actor.userId, (await f.store.current(f.actor.userId))!.revision, {
    enabled: false,
  });
  await expect(f.service.selectChat(f.actor, 'missing')).rejects.toMatchObject({
    code: 'PROVIDER_DISABLED',
  });
  await f.store.settings(f.actor.userId, (await f.store.current(f.actor.userId))!.revision, {
    enabled: true,
  });
  await f.store.save(
    f.actor.userId,
    (await f.store.current(f.actor.userId))!.revision,
    'rotated-key',
  );
  await expect(f.service.selectChat(f.actor, 'missing')).rejects.toMatchObject({
    code: 'MODEL_CATALOG_NOT_DISCOVERED',
  });
});

it.each(['rotation', 'settings', 'refresh'] as const)(
  'serializes verification while %s waits and late tuples stay guarded',
  async (writerKind) => {
    const f = await providerSqlFixture();
    const refreshing = writerKind === 'refresh' ? await f.store.beginRefresh(f.actor.userId) : null;
    const snapshots = await Promise.all(
      f.models.map(async (m) =>
        f.service.resolveChat(
          f.actor,
          await f.service.selectChat(f.actor, modelReference(m.model_key)),
        ),
      ),
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let readers = 0;
    const peer = f.peer(async (sql) => {
      if (sql.startsWith('WITH config AS MATERIALIZED')) {
        readers += 1;
        await gate;
      }
    });
    const work = snapshots.map((snapshot) =>
      peer.store.recordVerification(f.actor.userId, snapshot, 'isolated success'),
    );
    let writer: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(readers).toBe(1));
      await vi.waitFor(async () =>
        expect(
          (
            await f.pool.query(
              'SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid))>0',
              [peer.name],
            )
          ).rows,
        ).toHaveLength(1),
      );
      expect(peer.trace.filter((sql) => sql.includes('FOR UPDATE'))).toHaveLength(2);
      expect(
        peer.trace
          .filter((sql) => sql.includes('FOR UPDATE'))
          .every((sql) => !sql.includes('*') && !sql.includes('discovery')),
      ).toBe(true);
      const current = (await f.store.current(f.actor.userId))!;
      writer =
        writerKind === 'rotation'
          ? f.store.save(f.actor.userId, current.revision, 'rotated-after-read')
          : writerKind === 'settings'
            ? f.store.settings(f.actor.userId, current.revision, { enabled: false })
            : f.store.finishRefresh(
                f.actor.userId,
                refreshing!,
                {
                  credentialVersion: 1,
                  refreshSeq: refreshing!.latest_refresh_seq,
                  checkedAt: new Date().toISOString(),
                  scope: 'models-only',
                  status: 'connected',
                  ids: f.models.map((m) => m.raw_model_id),
                  error: null,
                },
                f.models.map((m) => ({
                  id: m.raw_model_id,
                  metadata: { id: m.raw_model_id, object: 'model' },
                })),
              );
      await vi.waitFor(async () =>
        expect(
          (
            await f.pool.query(
              'SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid))>0',
              [f.database.applicationName],
            )
          ).rows,
        ).toHaveLength(1),
      );
    } finally {
      release();
      await Promise.all(work);
      await writer;
    }
    if (writerKind !== 'settings') {
      await f.store.recordVerification(f.actor.userId, snapshots[0]!, 'late old tuple');
      expect(
        (
          await f.pool.query(
            'SELECT verification_status FROM mio_provider_model_verifications WHERE provider_id=$1',
            [f.providerId],
          )
        ).rows,
      ).toEqual(snapshots.map(() => ({ verification_status: 'unverified' })));
    }
  },
);

it.each(['update', 'recreate'] as const)(
  'keeps the latest same-model verification after route %s while an old observation is paused',
  async (scenario) => {
    const f = await providerSqlFixture(['same-verification']);
    const model = f.models[0]!;
    if (scenario === 'recreate')
      await f.store.importRoutes([{ ...f.route(model.raw_model_id), sourceVersion: 'old-v2' }]);
    const snapshot = async () =>
      f.service.resolveChat(
        f.actor,
        await f.service.selectChat(f.actor, modelReference(model.model_key)),
      );
    const old = await snapshot();
    let release!: () => void, held!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (held = r));
    const first = f.peer(async (sql) => {
        if (sql.startsWith('WITH config AS MATERIALIZED')) {
          held();
          await gate;
        }
      }),
      second = f.peer();
    const a = first.store.recordVerification(f.actor.userId, old, 'paused old observation');
    let b: Promise<void> | undefined;
    let current: Awaited<ReturnType<typeof snapshot>> | undefined;
    try {
      await ready;
      if (scenario === 'recreate')
        await f.store.deleteRoutes(model.raw_model_id, {
          actorType: 'cli',
          actorName: 'fixture',
          actorId: null,
        });
      await f.store.importRoutes([
        { ...f.route(model.raw_model_id), sourceVersion: 'new current' },
      ]);
      current = await snapshot();
      expect(current.adaptationVersion).toBe(scenario === 'update' ? 2 : 1);
      b = second.store.recordVerification(f.actor.userId, current, 'new current observation');
      await vi.waitFor(async () =>
        expect(
          (
            await f.pool.query(
              'SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid))>0',
              [second.name],
            )
          ).rows,
        ).toHaveLength(1),
      );
    } finally {
      release();
      await Promise.all([a, ...(b ? [b] : [])]);
    }
    expect(
      (
        await f.pool.query(
          'SELECT declaration_version,tested_tuple FROM mio_provider_model_verifications WHERE provider_id=$1 AND model_key=$2',
          [f.providerId, model.model_key],
        )
      ).rows[0],
    ).toMatchObject({
      declaration_version: current!.adaptationVersion,
      tested_tuple: { adaptationVersion: current!.adaptationVersion },
    });
    expect(
      (await f.service.catalog(f.actor)).items.find((m) => m.modelId === model.raw_model_id)!
        .adaptation!.verification.status,
    ).toBe('verified');
  },
);
