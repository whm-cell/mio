import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { adminSchemaSQL } from '../../src/admin/schema.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { providerSqlFixture } from '../providers/fixtures/provider-sql-fixture.ts';

const model = (id: string, revision = 1) => ({ id, metadata: { id, revision } });
const savedEnvelope = () => ({
  keyVersion: 1,
  maskedHint: 'synthetic-hint',
  envelope: {
    keyVersion: 1,
    cipher_format: 1,
    master_key_id: 'synthetic',
    nonce: randomBytes(12),
    ciphertext: randomBytes(32),
    auth_tag: randomBytes(16),
  },
});

it('preserves connected/empty/overlapping probe snapshots, sequences, saved/unsaved keys and audit state', async () => {
  const f = await providerSqlFixture(['existing']);
  await f.pool.query("INSERT INTO mio_admin_ignored_models(raw_model_id) VALUES('ignored')");
  const saved = savedEnvelope();
  const input = {
    actor: f.account,
    status: 'connected' as const,
    models: ['existing', 'ignored', 'new'].map((id) => model(id)),
    error: null,
    savedEnvelope: saved,
  };
  const result = await f.admin.recordProbeOutcome(input);
  expect(result.totalCatalogCount).toBe(1);
  expect(result.existingIds).toEqual(new Set(['existing']));
  expect(result.ignoredIds).toEqual(new Set(['ignored']));
  const before = (
    await f.pool.query(
      'SELECT raw_model_id,first_seen_at,last_seen_at,probe_seq,supplier_metadata FROM mio_admin_catalog_models ORDER BY raw_model_id',
    )
  ).rows;
  expect(before.map((r) => r.probe_seq)).toEqual([1, 1, 1]);
  const initialKey = await f.admin.readProbeRecord();
  expect(initialKey.envelope).toEqual(saved.envelope);
  expect(initialKey.view).toMatchObject({
    hasSavedKey: true,
    maskedHint: 'synthetic-hint',
    lastProbeCount: 3,
  });
  expect(await f.admin.nextProbeKeyVersion()).toBe(2);
  await f.admin.recordProbeOutcome({
    actor: f.account,
    status: 'connected',
    models: [model('new', 2), model('fresh')],
    error: null,
  });
  const after = (await f.pool.query('SELECT * FROM mio_admin_catalog_models ORDER BY raw_model_id'))
    .rows;
  expect(after.map((r) => [r.raw_model_id, r.in_latest_probe, r.probe_seq])).toEqual([
    ['existing', false, 1],
    ['fresh', true, 1],
    ['ignored', false, 1],
    ['new', true, 2],
  ]);
  expect(after.find((r) => r.raw_model_id === 'new')).toMatchObject({
    supplier_metadata: { id: 'new', revision: 2 },
    first_seen_at: before.find((r) => r.raw_model_id === 'new').first_seen_at,
  });
  expect((await f.admin.readProbeRecord()).envelope).toEqual(saved.envelope);
  await f.admin.recordProbeOutcome({
    actor: f.account,
    status: 'failed',
    models: [],
    error: 'UPSTREAM_OFFLINE',
  });
  expect(
    (await f.pool.query('SELECT * FROM mio_admin_catalog_models ORDER BY raw_model_id')).rows,
  ).toEqual(after);
  expect((await f.admin.readProbeRecord()).view).toMatchObject({
    lastProbeStatus: 'failed',
    lastProbeCount: 2,
    lastProbeError: 'UPSTREAM_OFFLINE',
    hasSavedKey: true,
  });
  await f.admin.recordProbeOutcome({
    actor: f.account,
    status: 'connected',
    models: [],
    error: null,
  });
  expect(
    (
      await f.pool.query(
        'SELECT in_latest_probe,probe_seq FROM mio_admin_catalog_models ORDER BY raw_model_id',
      )
    ).rows,
  ).toEqual([
    { in_latest_probe: false, probe_seq: 1 },
    { in_latest_probe: false, probe_seq: 1 },
    { in_latest_probe: false, probe_seq: 1 },
    { in_latest_probe: false, probe_seq: 2 },
  ]);
  const replacement = {
    ...savedEnvelope(),
    keyVersion: 2,
    envelope: { ...savedEnvelope().envelope, keyVersion: 2 },
  };
  await f.admin.recordProbeOutcome({
    actor: f.account,
    status: 'failed',
    models: [],
    error: 'UPSTREAM_REJECTED',
    savedEnvelope: replacement,
  });
  expect((await f.admin.readProbeRecord()).envelope).toEqual(replacement.envelope);
  expect((await f.admin.readProbeRecord()).view).toMatchObject({
    lastProbeStatus: 'failed',
    lastProbeCount: null,
    lastProbeError: 'UPSTREAM_REJECTED',
  });
  const audit = (
    await f.pool.query(
      "SELECT action,actor_id,after_state FROM mio_admin_audit_logs WHERE action='onelink.discover' ORDER BY created_at",
    )
  ).rows;
  expect(audit).toHaveLength(5);
  expect(audit.every((r) => r.actor_id === f.account.id)).toBe(true);
  expect(audit.map((r) => r.after_state)).toEqual([
    { status: 'connected', discoveredCount: 3, savedKey: true, error: null },
    { status: 'connected', discoveredCount: 2, savedKey: false, error: null },
    { status: 'failed', discoveredCount: 0, savedKey: false, error: 'UPSTREAM_OFFLINE' },
    { status: 'connected', discoveredCount: 0, savedKey: false, error: null },
    { status: 'failed', discoveredCount: 0, savedKey: true, error: 'UPSTREAM_REJECTED' },
  ]);
  await f.admin.clearProbeKey(f.account);
  expect((await f.admin.readProbeRecord()).envelope).toBeNull();
  expect(
    (await f.pool.query('SELECT count(*)::int n FROM mio_admin_catalog_models')).rows[0].n,
  ).toBe(4);
});

it('rolls back the config-first key, snapshot flags, metadata, sequence and audit atomically on audit failure', async () => {
  const f = await providerSqlFixture([]);
  await f.admin.recordProbeOutcome({
    actor: f.account,
    status: 'connected',
    models: [model('old')],
    error: null,
    savedEnvelope: savedEnvelope(),
  });
  const snapshot = async () => ({
    config: (await f.pool.query('SELECT * FROM mio_admin_probe_configs')).rows,
    models: (await f.pool.query('SELECT * FROM mio_admin_catalog_models ORDER BY raw_model_id'))
      .rows,
    audit: (await f.pool.query('SELECT * FROM mio_admin_audit_logs ORDER BY created_at')).rows,
  });
  const before = await snapshot();
  await f.pool
    .query(`CREATE FUNCTION fail_probe_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture audit failure'; END$$;
    CREATE TRIGGER fail_probe_audit BEFORE INSERT ON mio_admin_audit_logs FOR EACH ROW EXECUTE FUNCTION fail_probe_audit()`);
  await expect(
    f.admin.recordProbeOutcome({
      actor: f.account,
      status: 'connected',
      models: [model('old', 2), model('new')],
      error: null,
      savedEnvelope: savedEnvelope(),
    }),
  ).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});

it('does not enqueue the final ignored SELECT when the first final SELECT fails; the transaction rolls back', async () => {
  const f = await providerSqlFixture([]);
  const peer = f.peer((sql) => {
    if (
      sql === "SELECT raw_model_id FROM mio_provider_catalog_models WHERE provider_type='onelink'"
    )
      throw new Error('first final read failed');
  });
  await expect(
    peer.admin.recordProbeOutcome({
      actor: f.account,
      status: 'connected',
      models: [model('new')],
      error: null,
    }),
  ).rejects.toThrow();
  expect(
    peer.trace.some((sql) => sql.includes('SELECT raw_model_id FROM mio_admin_ignored_models')),
  ).toBe(false);
  expect(peer.trace.at(-1)).toBe('ROLLBACK');
  for (const table of [
    'mio_admin_catalog_models',
    'mio_admin_probe_configs',
    'mio_admin_audit_logs',
  ])
    expect((await f.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0);
});

it.each([false, true])(
  'serializes actual complementary discoveries before model locks, singleton preexists=%s',
  async (preexists) => {
    const f = await providerSqlFixture([]);
    await f.admin.recordProbeOutcome({
      actor: f.account,
      status: 'connected',
      models: [model('a'), model('b')],
      error: null,
    });
    await f.pool.query('TRUNCATE mio_admin_audit_logs');
    if (!preexists) await f.pool.query('DELETE FROM mio_admin_probe_configs');
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => (entered = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    const first = f.peer(async (sql) => {
        if (sql.includes('INSERT INTO mio_admin_probe_configs')) {
          entered();
          await gate;
        }
      }),
      second = f.peer();
    const one = first.admin.recordProbeOutcome({
      actor: f.account,
      status: 'connected',
      models: [model('b', 2)],
      error: null,
      savedEnvelope: savedEnvelope(),
    });
    let two: ReturnType<typeof f.admin.recordProbeOutcome> | undefined;
    try {
      await held;
      two = second.admin.recordProbeOutcome({
        actor: f.account,
        status: 'connected',
        models: [model('a', 3)],
        error: null,
      });
      await vi.waitFor(async () => {
        const activity = (
          await f.pool.query(
            "SELECT wait_event_type,query FROM pg_stat_activity WHERE application_name=$1 AND state='active'",
            [second.name],
          )
        ).rows;
        expect(activity).toHaveLength(1);
        expect(activity[0]).toMatchObject({ wait_event_type: 'Lock' });
        expect(activity[0].query).toContain('INSERT INTO mio_admin_probe_configs');
      });
      expect(second.trace.some((sql) => sql.includes('UPDATE mio_admin_catalog_models'))).toBe(
        false,
      );
    } finally {
      release();
      await Promise.allSettled([one, ...(two ? [two] : [])]);
    }
    await expect(one).resolves.toMatchObject({ totalCatalogCount: 0 });
    await expect(two!).resolves.toMatchObject({ totalCatalogCount: 0 });
    expect(
      (
        await f.pool.query(
          'SELECT raw_model_id,in_latest_probe,probe_seq,supplier_metadata FROM mio_admin_catalog_models ORDER BY raw_model_id',
        )
      ).rows,
    ).toEqual([
      {
        raw_model_id: 'a',
        in_latest_probe: true,
        probe_seq: 2,
        supplier_metadata: { id: 'a', revision: 3 },
      },
      {
        raw_model_id: 'b',
        in_latest_probe: false,
        probe_seq: 2,
        supplier_metadata: { id: 'b', revision: 2 },
      },
    ]);
    expect((await f.admin.readProbeRecord()).view).toMatchObject({
      lastProbeStatus: 'connected',
      lastProbeCount: 1,
      hasSavedKey: true,
    });
    expect((await f.pool.query('SELECT count(*)::int n FROM mio_admin_audit_logs')).rows[0].n).toBe(
      2,
    );
  },
);

it('retains global/target revision and audit ordering and limits', async () => {
  const f = await providerSqlFixture([]);
  await f.pool
    .query(`INSERT INTO mio_provider_model_route_revisions(id,actor_type,actor_name,raw_model_id,operation,declaration_version,action,after_route,created_at)
    VALUES(gen_random_uuid(),'admin','fixture','target','chat',1,'create','{}','2025-01-01'),(gen_random_uuid(),'admin','fixture','other','chat',2,'update','{}','2026-01-01'),(gen_random_uuid(),'admin','fixture','target','chat',3,'update','{}','2026-01-01')`);
  await f.pool
    .query(`INSERT INTO mio_admin_audit_logs(id,actor_name,action,target_id,summary,created_at)
    VALUES(gen_random_uuid(),'fixture','update','target','older','2025-01-01'),(gen_random_uuid(),'fixture','update','other','other','2026-01-02'),(gen_random_uuid(),'fixture','update','target','newer','2026-01-01')`);
  const global = await f.admin.listRevisions(undefined, 2),
    target = await f.admin.listRevisions('target', 1);
  expect(global.routeRevisions.map((r) => r.declaration_version)).toEqual([3, 2]);
  expect(global.auditLogs.map((r) => r.summary)).toEqual(['other', 'newer']);
  expect(target.routeRevisions.map((r) => r.declaration_version)).toEqual([3]);
  expect(target.auditLogs.map((r) => r.summary)).toEqual(['newer']);
});

it('creates all six indexes only in their owning migration and replays without replacing indexes or persisted rows', async () => {
  const f = await providerSqlFixture(['kept-model']);
  for (const sql of [assetSchemaSQL, generationSchemaSQL, conversationSchemaSQL, computeSchemaSQL])
    await f.pool.query(sql);
  await f.pool.query(
    "INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,state) VALUES(gen_random_uuid(),'fixture',gen_random_uuid(),'synthetic','{}','completed')",
  );
  await f.pool.query(
    "INSERT INTO mio_conversations(id,owner_id,dsh_session_id,state) VALUES(gen_random_uuid(),'fixture','kept-conversation','ready')",
  );
  await f.pool.query(
    "INSERT INTO mio_conversation_requests(conversation_id,request_id,digest,status) SELECT id,'kept-request','synthetic','unknown' FROM mio_conversations",
  );
  const asset = randomUUID(),
    job = randomUUID();
  await f.pool.query(
    "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,raw_key,state,expires_at) VALUES($1,'fixture','a','video/mp4',1,'synthetic','ready',now()+interval '1 day')",
    [asset],
  );
  await f.pool.query(
    "INSERT INTO mio_compute_jobs(id,owner_id,request_id,input_asset_id,input_key,input_size,input_etag,state,attempt,attempt_id,command_id) VALUES($1,'fixture',$1,$2,'synthetic',1,'synthetic','succeeded',1,$1,$1)",
    [job, asset],
  );
  await f.pool.query(
    "INSERT INTO mio_admin_audit_logs(id,actor_name,action,target_id) VALUES(gen_random_uuid(),'fixture','kept','kept-model')",
  );
  const indexes = [
    {
      name: 'mio_provider_models_metadata_sample',
      sql: providerSchemaSQL,
      table: 'mio_provider_models',
      columns: '(raw_model_id, last_seen_at DESC NULLS LAST)',
      predicate: "metadata_source = 'onelink-v1-models'::text",
    },
    {
      name: 'mio_provider_model_route_revisions_recent_idx',
      sql: providerSchemaSQL,
      table: 'mio_provider_model_route_revisions',
      columns: '(provider_type, created_at DESC, declaration_version DESC)',
    },
    {
      name: 'mio_admin_audit_logs_target_created_idx',
      sql: adminSchemaSQL,
      table: 'mio_admin_audit_logs',
      columns: '(target_id, created_at DESC)',
    },
    {
      name: 'mio_image_jobs_created_idx',
      sql: generationSchemaSQL,
      table: 'mio_image_jobs',
      columns: '(created_at DESC)',
    },
    {
      name: 'mio_conversation_requests_created_idx',
      sql: conversationSchemaSQL,
      table: 'mio_conversation_requests',
      columns: '(created_at DESC)',
    },
    {
      name: 'mio_compute_jobs_created_idx',
      sql: computeSchemaSQL,
      table: 'mio_compute_jobs',
      columns: '(created_at DESC)',
    },
  ];
  for (const { name } of indexes) await f.pool.query(`DROP INDEX ${name}`);
  const snapshot = async () => ({
    models: (await f.pool.query('SELECT * FROM mio_provider_models ORDER BY model_key')).rows,
    images: (await f.pool.query('SELECT * FROM mio_image_jobs')).rows,
    requests: (await f.pool.query('SELECT * FROM mio_conversation_requests')).rows,
    compute: (await f.pool.query('SELECT * FROM mio_compute_jobs')).rows,
    audit: (await f.pool.query('SELECT * FROM mio_admin_audit_logs ORDER BY id')).rows,
    revisions: (await f.pool.query('SELECT * FROM mio_provider_model_route_revisions ORDER BY id'))
      .rows,
  });
  const before = await snapshot();
  const created = new Set<string>();
  for (const sql of [
    providerSchemaSQL,
    adminSchemaSQL,
    generationSchemaSQL,
    conversationSchemaSQL,
    computeSchemaSQL,
  ]) {
    await f.pool.query(sql);
    for (const index of indexes) if (index.sql === sql) created.add(index.name);
    const rows = (
      await f.pool.query(
        'SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname=ANY($1::text[])',
        [indexes.map((i) => i.name)],
      )
    ).rows;
    expect(rows.map((r) => r.indexname).sort()).toEqual([...created].sort());
  }
  const definitions = await f.pool.query(
    `SELECT c.relname name,c.oid,pg_get_indexdef(c.oid) definition,pg_get_expr(i.indpred,i.indrelid) predicate,i.indisvalid,i.indisready,t.relname tablename,i.indcollation[0]=(SELECT oid FROM pg_collation WHERE collname='C' AND collnamespace='pg_catalog'::regnamespace) AS uses_c_collation
    FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid JOIN pg_class t ON t.oid=i.indrelid WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
    [indexes.map((i) => i.name)],
  );
  for (const index of indexes) {
    const row = definitions.rows.find((r) => r.name === index.name)!;
    expect(row).toMatchObject({ tablename: index.table, indisvalid: true, indisready: true });
    expect(row.definition).toContain(index.columns);
    if (index.predicate) {
      expect(row.predicate).toContain(index.predicate);
      expect(row.uses_c_collation).toBe(true);
    } else expect(row.predicate).toBeNull();
  }
  for (const sql of [
    providerSchemaSQL,
    adminSchemaSQL,
    generationSchemaSQL,
    conversationSchemaSQL,
    computeSchemaSQL,
  ])
    await f.pool.query(sql);
  const replay = (
    await f.pool.query(
      'SELECT relname name,oid FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relname=ANY($1::text[]) ORDER BY relname',
      [indexes.map((i) => i.name)],
    )
  ).rows;
  expect(replay).toEqual(definitions.rows.map(({ name, oid }) => ({ name, oid })));
  expect(await snapshot()).toEqual(before);
});
