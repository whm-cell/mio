import { expect, it, vi } from 'vitest';
import { providerSqlFixture } from '../providers/fixtures/provider-sql-fixture.ts';

const item = (rawModelId: string) => ({
  rawModelId,
  displayLabel: 'first label',
  vendorLabel: 'openai',
  category: 'chat' as const,
  description: 'first description',
  supplierMetadata: { fixture: 'first' },
  userVisible: true,
  allowUndiscovered: false,
  callNotes: 'initial notes',
});

it('preserves sequential direct duplicates, null overwrite, policy flags, first curated metadata and audit order', async () => {
  const f = await providerSqlFixture();
  const old = 'existing-hidden',
    fresh = 'new-curated';
  await f.pool.query(
    `INSERT INTO mio_provider_catalog_models(provider_type,raw_model_id,display_label,vendor_label,category,
    description,user_visible,allow_undiscovered,call_notes) VALUES('onelink',$1,'old label','openai','chat','old description',true,true,'old notes')`,
    [old],
  );
  await f.pool.query(
    "INSERT INTO mio_admin_ignored_models(provider_type,raw_model_id) SELECT 'onelink',unnest($1::text[])",
    [[old, fresh]],
  );
  const entries = [
    { ...item(fresh), allowUndiscovered: true },
    {
      ...item(old),
      displayLabel: null,
      vendorLabel: null,
      category: null,
      description: null,
      userVisible: false,
      callNotes: 'replace ignored',
    },
    {
      ...item(fresh),
      displayLabel: 'last label',
      allowUndiscovered: false,
      userVisible: false,
      supplierMetadata: { fixture: 'last' },
    },
  ];
  const peer = f.peer();
  expect(await peer.admin.importCatalogModels(f.account, entries, true)).toEqual({
    imported: 1,
    updated: 2,
    skipped: 0,
  });
  expect(peer.trace).toHaveLength(7);
  expect(peer.trace.filter((sql) => sql.includes('FROM mio_provider_configs'))).toHaveLength(1);
  const records = (
    await f.pool.query(
      'SELECT * FROM mio_provider_catalog_models WHERE raw_model_id=ANY($1::text[])',
      [[old, fresh]],
    )
  ).rows;
  expect(records.find((row) => row.raw_model_id === old)).toMatchObject({
    display_label: 'old label',
    vendor_label: 'openai',
    category: 'chat',
    description: 'old description',
    user_visible: true,
    allow_undiscovered: true,
    call_notes: 'old notes',
  });
  expect(records.find((row) => row.raw_model_id === fresh)).toMatchObject({
    display_label: 'last label',
    supplier_metadata: { fixture: 'last' },
    user_visible: true,
    allow_undiscovered: true,
    call_notes: 'initial notes',
  });
  const materialized = (
    await f.pool.query(
      'SELECT raw_model_id,supplier_metadata FROM mio_provider_models WHERE raw_model_id=ANY($1::text[])',
      [[old, fresh]],
    )
  ).rows;
  expect(materialized).toEqual([
    {
      raw_model_id: fresh,
      supplier_metadata: { object: 'model', curated: true, description: 'first label' },
    },
  ]);
  expect(
    (await f.pool.query('SELECT count(*)::int AS n FROM mio_admin_ignored_models')).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT after_state FROM mio_admin_audit_logs WHERE action='models.import'",
      )
    ).rows[0].after_state.modelIds,
  ).toEqual(entries.map((row) => row.rawModelId));
  expect(await f.admin.importCatalogModels(f.account, [item(fresh), item(fresh)], false)).toEqual({
    imported: 0,
    updated: 0,
    skipped: 2,
  });
  await expect(
    f.adminService.importModels(f.principal, { items: [item(fresh), item(fresh)] }),
  ).rejects.toMatchObject({ code: 'ADMIN_INPUT_INVALID' });
});

it('uses three body queries at one and 500 models, and locks reversed existing imports without deadlock', async () => {
  const f = await providerSqlFixture();
  const peer = f.peer();
  for (const n of [1, 500]) {
    peer.trace.length = 0;
    expect(
      await peer.admin.importCatalogModels(
        f.account,
        Array.from({ length: n }, (_, i) => item(`constant-${n}-${i}`)),
        false,
      ),
    ).toEqual({ imported: n, updated: 0, skipped: 0 });
    expect(peer.trace).toHaveLength(5);
  }
  const ids = ['Z', 'a', 'é', '\uE000', '\u{10000}'];
  await f.admin.importCatalogModels(f.account, ids.map(item), false);
  let arrived = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const peers = [0, 1].map(() => {
    let first = true;
    return f.peer(async (sql, args, result) => {
      if (
        first &&
        sql.includes('FOR UPDATE') &&
        result.rows.length === 1 &&
        typeof args?.[0] === 'string'
      ) {
        first = false;
        if (++arrived === 2) release();
        await gate;
      }
    });
  });
  const results = await Promise.all(
    peers.map((p, i) =>
      p.admin.importCatalogModels(f.account, (i ? [...ids].reverse() : ids).map(item), true),
    ),
  );
  expect(results).toEqual(
    Array.from({ length: 2 }, () => ({ imported: 0, updated: ids.length, skipped: 0 })),
  );
});

it('rolls back imported catalog, materialized models and ignored removal when the audit fails', async () => {
  const f = await providerSqlFixture();
  await f.pool.query(
    "INSERT INTO mio_admin_ignored_models(provider_type,raw_model_id) VALUES('onelink','audit-rollback')",
  );
  await f.pool
    .query(`CREATE FUNCTION fail_import_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='models.import' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END$$;
    CREATE TRIGGER fail_import_audit BEFORE INSERT ON mio_admin_audit_logs FOR EACH ROW EXECUTE FUNCTION fail_import_audit()`);
  await expect(
    f.admin.importCatalogModels(
      f.account,
      [{ ...item('audit-rollback'), allowUndiscovered: true }],
      false,
    ),
  ).rejects.toMatchObject({ code: 'ADMIN_UNAVAILABLE' });
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM mio_provider_catalog_models WHERE raw_model_id='audit-rollback'",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM mio_provider_models WHERE raw_model_id='audit-rollback'",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM mio_admin_ignored_models WHERE raw_model_id='audit-rollback'",
      )
    ).rows[0].n,
  ).toBe(1);
});

it('rolls back routes, catalog, ignored state and revisions together when delete audit fails', async () => {
  const f = await providerSqlFixture();
  const id = f.models[0]!.raw_model_id;
  await f.pool
    .query(`CREATE FUNCTION fail_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='model.delete' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END$$;
    CREATE TRIGGER fail_delete_audit BEFORE INSERT ON mio_admin_audit_logs FOR EACH ROW EXECUTE FUNCTION fail_delete_audit()`);
  await expect(
    f.adminService.deleteModel(f.principal, { rawModelId: id, ignoreFutureImports: true }),
  ).rejects.toMatchObject({ code: 'ADMIN_UNAVAILABLE' });
  expect(
    (
      await f.pool.query(
        'SELECT count(*)::int AS n FROM mio_provider_catalog_models WHERE raw_model_id=$1',
        [id],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await f.pool.query(
        'SELECT count(*)::int AS n FROM mio_provider_model_routes WHERE raw_model_id=$1',
        [id],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM mio_provider_model_route_revisions WHERE raw_model_id=$1 AND action='delete'",
        [id],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.pool.query(
        'SELECT count(*)::int AS n FROM mio_admin_ignored_models WHERE raw_model_id=$1',
        [id],
      )
    ).rows[0].n,
  ).toBe(0);
});

it.each(['delete-first', 'import-first'] as const)(
  'coordinates the catalog lock for %s without leaving an orphan',
  async (order) => {
    const f = await providerSqlFixture();
    const id = f.models[0]!.raw_model_id;
    let unlock!: () => void, locked!: () => void;
    const gate = new Promise<void>((r) => (unlock = r)),
      ready = new Promise<void>((r) => (locked = r));
    let first = true;
    const holder = f.peer(async (sql) => {
      if (
        first &&
        sql.includes('mio_provider_catalog_models') &&
        (sql.includes('FOR UPDATE') || sql.startsWith('INSERT INTO mio_provider_catalog_models'))
      ) {
        first = false;
        locked();
        await gate;
      }
    });
    const follower = f.peer();
    const importing = (peer: ReturnType<typeof f.peer>) =>
      peer.store.importRoutes([{ ...f.route(id), sourceVersion: 'v2' }]);
    const deleting = (peer: ReturnType<typeof f.peer>) =>
      peer.adminService.deleteModel(f.principal, { rawModelId: id, ignoreFutureImports: true });
    const observe = (p: Promise<unknown>) =>
      p.then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      );
    const firstWork = observe(order === 'delete-first' ? deleting(holder) : importing(holder));
    await ready;
    const secondWork = observe(order === 'delete-first' ? importing(follower) : deleting(follower));
    try {
      await vi.waitFor(async () =>
        expect(
          (
            await f.pool.query(
              'SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid))>0',
              [follower.name],
            )
          ).rows,
        ).toHaveLength(1),
      );
    } finally {
      unlock();
    }
    const [one, two] = await Promise.all([firstWork, secondWork]);
    expect(one.ok).toBe(true);
    if (order === 'delete-first') {
      if (!two.ok) expect(two.error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    } else expect(two.ok).toBe(true);
    expect(
      (
        await f.pool.query(
          'SELECT count(*)::int AS n FROM mio_provider_catalog_models WHERE raw_model_id=$1',
          [id],
        )
      ).rows[0].n,
    ).toBe(order === 'delete-first' && two.ok ? 1 : 0);
    expect(
      (
        await f.pool.query(
          'SELECT count(*)::int AS n FROM mio_provider_model_routes WHERE raw_model_id=$1',
          [id],
        )
      ).rows[0].n,
    ).toBe(order === 'delete-first' && two.ok ? 1 : 0);
    expect(
      (
        await f.pool.query(
          "SELECT actor_type,actor_id,action FROM mio_provider_model_route_revisions WHERE raw_model_id=$1 AND action='delete'",
          [id],
        )
      ).rows,
    ).toEqual([{ actor_type: 'admin', actor_id: f.account.id, action: 'delete' }]);
    if (order === 'delete-first' && two.ok)
      await f.adminService.deleteModel(f.principal, { rawModelId: id });
    expect(await f.store.importRoutes([f.route(id)])).toMatchObject({ inserted: 1 });
    expect(
      (
        await f.pool.query(
          'SELECT count(*)::int AS n FROM mio_provider_catalog_models WHERE raw_model_id=$1',
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
  },
);

it('orders mixed missing/existing catalog locks the same way across catalog and route imports', async () => {
  const f = await providerSqlFixture(['mixed-z']);
  const ids = ['mixed-z', 'mixed-a'];
  let release!: () => void, held!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (held = r));
  let first = true;
  const admin = f.peer(async (sql) => {
    if (
      first &&
      sql.includes('mio_provider_catalog_models') &&
      (sql.includes('RETURNING raw_model_id') || sql.includes('FOR UPDATE'))
    ) {
      first = false;
      held();
      await gate;
    }
  });
  const route = f.peer();
  const a = admin.admin.importCatalogModels(f.account, ids.map(item), true);
  await ready;
  const b = route.store.importRoutes(
    [...ids].reverse().map((id) => ({ ...f.route(id), sourceVersion: 'mixed update' })),
  );
  const outcomes = Promise.all([a, b]);
  try {
    await vi.waitFor(async () =>
      expect(
        (
          await f.pool.query(
            'SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid))>0',
            [route.name],
          )
        ).rows,
      ).toHaveLength(1),
    );
  } finally {
    release();
  }
  const [catalog, routes] = await outcomes;
  expect(catalog).toEqual({ imported: 1, updated: 1, skipped: 0 });
  expect(routes).toMatchObject({ inserted: 1, updated: 1 });
});

it('serializes concurrently introduced catalog keys using existing metadata policy', async () => {
  const f = await providerSqlFixture();
  let release!: () => void, held!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (held = r));
  let first = true;
  const one = f.peer(async (sql) => {
      if (first && sql.includes('RETURNING raw_model_id')) {
        first = false;
        held();
        await gate;
      }
    }),
    two = f.peer();
  const a = one.admin.importCatalogModels(f.account, [item('absent-shared')], false);
  await ready;
  const b = two.admin
    .importCatalogModels(
      f.account,
      [
        item('absent-other'),
        {
          ...item('absent-shared'),
          displayLabel: 'later metadata',
          userVisible: false,
          allowUndiscovered: true,
          callNotes: 'late notes',
        },
      ],
      true,
    )
    .then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
  try {
    await vi.waitFor(async () =>
      expect(
        (
          await f.pool.query(
            'SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid))>0',
            [two.name],
          )
        ).rows,
      ).toHaveLength(1),
    );
  } finally {
    release();
  }
  expect(await a).toEqual({ imported: 1, updated: 0, skipped: 0 });
  const result = await b;
  expect(result).toMatchObject({ ok: true, value: { imported: 1, updated: 1, skipped: 0 } });
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM mio_provider_catalog_models WHERE raw_model_id='absent-other'",
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await f.pool.query(
        "SELECT display_label,user_visible,allow_undiscovered,call_notes FROM mio_provider_catalog_models WHERE raw_model_id='absent-shared'",
      )
    ).rows[0],
  ).toEqual({
    display_label: 'later metadata',
    user_visible: true,
    allow_undiscovered: false,
    call_notes: 'initial notes',
  });
});

it.each(['manual-first', 'import-first'] as const)(
  'serializes manual creation and import of an ignored absent model with %s',
  async (order) => {
    const f = await providerSqlFixture();
    const id = 'ignored-recreation';
    await f.pool.query(
      "INSERT INTO mio_admin_ignored_models(provider_type,raw_model_id,reason,ignored_by) VALUES('onelink',$1,'prior deletion',$2)",
      [id, f.account.username],
    );
    let release!: () => void, held!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      ready = new Promise<void>((resolve) => (held = resolve));
    let first = true;
    const holder = f.peer(async (sql) => {
        // The old manual path reaches ignored deletion first; the fixed path owns the catalog key first.
        if (
          first &&
          (sql.startsWith('INSERT INTO mio_provider_catalog_models') ||
            sql.startsWith('DELETE FROM mio_admin_ignored_models'))
        ) {
          first = false;
          held();
          await gate;
        }
      }),
      follower = f.peer();
    const manual = (peer: ReturnType<typeof f.peer>) =>
      peer.admin.createCatalogModel(f.account, {
        ...item(id),
        displayLabel: 'manual label',
        allowUndiscovered: true,
        callNotes: 'manual notes',
      });
    const importing = (peer: ReturnType<typeof f.peer>) =>
      peer.admin.importCatalogModels(
        f.account,
        [
          {
            ...item(id),
            displayLabel: 'batch label',
            supplierMetadata: { fixture: 'batch' },
            userVisible: false,
            callNotes: 'batch notes',
          },
        ],
        true,
      );
    const observed = (work: Promise<unknown>) =>
      work.then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      );
    const a = observed(order === 'manual-first' ? manual(holder) : importing(holder));
    let b: ReturnType<typeof observed> | undefined;
    try {
      await ready;
      b = observed(order === 'manual-first' ? importing(follower) : manual(follower));
      await vi.waitFor(async () =>
        expect(
          (
            await f.pool.query(
              'SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid))>0',
              [follower.name],
            )
          ).rows,
        ).toHaveLength(1),
      );
    } finally {
      release();
    }
    const [one, two] = await Promise.all([a, b!]);
    expect(one.ok).toBe(true);
    if (order === 'manual-first')
      expect(two).toMatchObject({ ok: true, value: { imported: 0, updated: 1, skipped: 0 } });
    else {
      expect(one).toMatchObject({ ok: true, value: { imported: 1, updated: 0, skipped: 0 } });
      expect(two).toMatchObject({
        ok: false,
        error: { code: 'MODEL_ALREADY_EXISTS', status: 409 },
      });
    }
    expect(
      (
        await f.pool.query(
          'SELECT count(*)::int AS n FROM mio_admin_ignored_models WHERE raw_model_id=$1',
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    const rows = (
      await f.pool.query(
        'SELECT display_label,supplier_metadata,user_visible,allow_undiscovered,call_notes,origin_source FROM mio_provider_catalog_models WHERE raw_model_id=$1',
        [id],
      )
    ).rows;
    expect(rows).toEqual([
      {
        display_label: 'batch label',
        supplier_metadata: { fixture: 'batch' },
        user_visible: order === 'manual-first',
        allow_undiscovered: order === 'manual-first',
        call_notes: order === 'manual-first' ? 'manual notes' : 'batch notes',
        origin_source: order === 'manual-first' ? 'admin-manual' : 'onelink-import',
      },
    ]);
    const materialized = (
      await f.pool.query(
        'SELECT supplier_metadata FROM mio_provider_models WHERE raw_model_id=$1',
        [id],
      )
    ).rows;
    expect(materialized).toEqual(
      order === 'manual-first'
        ? [{ supplier_metadata: { object: 'model', curated: true, description: 'manual label' } }]
        : [],
    );
    const audit = (
      await f.pool.query(
        "SELECT action FROM mio_admin_audit_logs WHERE action='models.import' OR (action='model.create' AND target_id=$1) ORDER BY action",
        [id],
      )
    ).rows;
    expect(audit).toEqual(
      order === 'manual-first'
        ? [{ action: 'model.create' }, { action: 'models.import' }]
        : [{ action: 'models.import' }],
    );
    await expect(manual(follower)).rejects.toMatchObject({
      code: 'MODEL_ALREADY_EXISTS',
      status: 409,
    });
  },
);
