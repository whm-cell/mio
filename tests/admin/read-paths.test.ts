import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, onTestFinished, vi } from 'vitest';
import { AdminStore, createAdminStore } from '../../src/admin/store.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { resolveVerificationView } from '../../src/providers/onelink/router.ts';
import { providerSqlFixture } from '../providers/fixtures/provider-sql-fixture.ts';

const operations = [
  ['chat', 'verified_chat_users', 'openai-chat', 'openai', 'chat', '/v1/chat/completions', null],
  [
    'image.generate',
    'verified_image_users',
    'openai-images',
    'openai',
    'image',
    '/v1/images/generations',
    null,
  ],
  [
    'video.generate',
    'verified_video_users',
    'volcengine-ark-videos',
    'volcengine',
    'video',
    '/volc/api/v3/contents/generations/tasks',
    '/volc/api/v3/contents/generations/tasks/{task_id}',
  ],
  [
    'audio.voices.list',
    'verified_voice_users',
    'minimax-voices',
    'minimax',
    'voice',
    '/minimax/v1/get_voice',
    null,
  ],
  [
    'audio.tts',
    'verified_tts_users',
    'minimax-tts',
    'minimax',
    'voice',
    '/minimax/v1/t2a_v2',
    null,
  ],
  [
    'audio.clone',
    'verified_clone_users',
    'minimax-clone',
    'minimax',
    'voice',
    '/minimax/v1/t2a_pro/voice_clone',
    null,
  ],
] as const;

it('counts all six operations from current typed verification tuples, independently of admission and membership', async () => {
  const f = await providerSqlFixture([]);
  const kinds = [
    'valid',
    'driver',
    'tupleCredential',
    'tupleCatalog',
    'tupleAdaptation',
    'tupleOperation',
    'tupleProfile',
    'nullTuple',
    'arrayTuple',
    'numericStrings',
    'unverified',
    'declaration',
    'catalogCredential',
    'nullCatalog',
    'disabledRejected',
    'removed',
    'historical',
    'missingTuple',
    'scalarTuple',
  ];
  for (const kind of kinds) {
    await f.store.save(kind, 0, 'synthetic-key');
    await f.pool.query(
      `UPDATE mio_provider_configs SET catalog_version=$2,catalog_credential_version=$3,
      credential_auth_state=$4,enabled=$5 WHERE owner_id=$1`,
      [
        kind,
        kind === 'nullCatalog' ? null : 1,
        kind === 'catalogCredential' ? 2 : 1,
        kind === 'disabledRejected' ? 'rejected' : 'valid',
        kind !== 'disabledRejected',
      ],
    );
  }
  await f.pool.query(
    "INSERT INTO mio_provider_catalog_models(raw_model_id) VALUES('count'),('empty')",
  );
  await f.pool.query(
    `INSERT INTO mio_provider_models(provider_id,raw_model_id,supplier_metadata,metadata_source,
    credential_version,catalog_version,first_seen_at,last_seen_at,membership_state)
    SELECT id,x,'{}','onelink-v1-models',1,1,now(),now(),
    CASE WHEN owner_id='removed' THEN 'removed' WHEN owner_id='historical' THEN 'historical' ELSE 'current' END
    FROM mio_provider_configs CROSS JOIN unnest(ARRAY['count','outside']) x WHERE owner_id <> $1`,
    [f.actor.userId],
  );
  await f.pool.query(
    `INSERT INTO mio_provider_model_routes(raw_model_id,operation,driver,vendor,classification,submit_path,query_path_template,source_kind,source,source_version,param_spec,capability_metadata)
    SELECT 'count',op,driver,vendor,category,path,query,'protocol-reference','synthetic','v1',
    CASE WHEN op='video.generate' THEN '{"supportedModes":["text_to_video"]}'::jsonb ELSE '{}'::jsonb END,
    CASE WHEN op='video.generate' THEN '{"video":{"modes":["text_to_video"],"cancellation":{"supported":false}}}'::jsonb ELSE '{}'::jsonb END
    FROM jsonb_to_recordset($1::jsonb) a(op text,driver text,vendor text,category text,path text,query text)`,
    [
      JSON.stringify(
        operations.map(([op, , driver, vendor, category, path, query]) => ({
          op,
          driver,
          vendor,
          category,
          path,
          query,
        })),
      ),
    ],
  );
  const models = (
    await f.pool.query(
      `SELECT m.*,c.owner_id FROM mio_provider_models m JOIN mio_provider_configs c ON c.id=m.provider_id WHERE raw_model_id='count'`,
    )
  ).rows;
  const verifications = models.flatMap((m) =>
    operations.map(([op, , driver]) => {
      const kind = m.owner_id;
      const tuple: Record<string, unknown> = {
        credentialVersion: 1,
        catalogVersion: 1,
        adaptationVersion: 1,
        operation: op,
        profile: driver,
      };
      for (const [test, key] of [
        ['tupleCredential', 'credentialVersion'],
        ['tupleCatalog', 'catalogVersion'],
        ['tupleAdaptation', 'adaptationVersion'],
        ['tupleOperation', 'operation'],
        ['tupleProfile', 'profile'],
      ]) {
        if (kind === test) tuple[key!] = key === 'operation' || key === 'profile' ? 'wrong' : 2;
      }
      if (kind === 'numericStrings')
        Object.assign(tuple, {
          credentialVersion: '1',
          catalogVersion: '1',
          adaptationVersion: '1',
        });
      if (kind === 'missingTuple') delete tuple.catalogVersion;
      return {
        provider: m.provider_id,
        key: m.model_key,
        op,
        driver: kind === 'driver' ? 'old-driver' : driver,
        decl: kind === 'declaration' ? 2 : 1,
        status: kind === 'unverified' ? 'unverified' : 'verified',
        tuple:
          kind === 'nullTuple'
            ? null
            : kind === 'arrayTuple'
              ? [tuple]
              : kind === 'scalarTuple'
                ? true
                : tuple,
      };
    }),
  );
  await f.pool.query(
    `INSERT INTO mio_provider_model_verifications(provider_id,model_key,operation,driver,declaration_version,verification_status,tested_tuple)
    SELECT provider::uuid,key::uuid,op,driver,decl,status,tuple FROM jsonb_to_recordset($1::jsonb) a(provider text,key text,op text,driver text,decl int,status text,tuple jsonb)`,
    [JSON.stringify(verifications)],
  );
  const raw = await f.admin.readUnifiedModelSources();
  expect(raw.userStatsRows.map((r) => r.raw_model_id).sort()).toEqual(['count', 'empty']);
  const count = raw.userStatsRows.find((r) => r.raw_model_id === 'count')!;
  expect(count.discovered_users).toBe(15);
  for (const [, field] of operations) expect(count[field]).toBe(4);
  const empty = raw.userStatsRows.find((r) => r.raw_model_id === 'empty')!;
  expect(empty.discovered_users).toBe(0);
  for (const [, field] of operations) expect(empty[field]).toBe(0);
  const joined = (
    await f.pool
      .query(`SELECT c.owner_id,c.credential_version,c.catalog_version,c.catalog_credential_version,
    v.*,r.driver route_driver,r.declaration_version route_version
    FROM mio_provider_models m JOIN mio_provider_configs c ON c.id=m.provider_id
    JOIN mio_provider_model_verifications v ON v.provider_id=m.provider_id AND v.model_key=m.model_key
    JOIN mio_provider_model_routes r ON r.raw_model_id=m.raw_model_id AND r.operation=v.operation`)
  ).rows;
  for (const row of joined) {
    const current =
      row.catalog_credential_version === row.credential_version &&
      resolveVerificationView({
        verification: row,
        operation: row.operation,
        declarationVersion: row.route_version,
        profile: row.route_driver,
        credentialVersion: row.credential_version,
        catalogVersion: row.catalog_version,
      }).status === 'verified';
    expect(current, `${row.owner_id}/${row.operation}`).toBe(
      ['valid', 'disabledRejected', 'removed', 'historical'].includes(row.owner_id),
    );
  }
  // Discovery rows/preferences are admission inputs, not extra verification predicates.
  await f.pool
    .query(`INSERT INTO mio_provider_model_preferences(provider_id,model_key,usage,enabled,is_default)
    SELECT provider_id,model_key,'chat',false,false FROM mio_provider_models WHERE raw_model_id='count'`);
  await f.pool.query(
    "UPDATE mio_provider_models SET credential_version=2,membership_state='removed'",
  );
  await f.pool.query('UPDATE mio_provider_catalog_models SET user_visible=false');
  const verifiedOnly = (await f.admin.readUnifiedModelSources()).userStatsRows.find(
    (r) => r.raw_model_id === 'count',
  )!;
  expect(verifiedOnly.discovered_users).toBe(0);
  for (const [, field] of operations) expect(verifiedOnly[field]).toBe(4);
  for (const [op, field] of operations) {
    await f.pool.query('UPDATE mio_provider_model_routes SET enabled=(operation <> $1)', [op]);
    const row = (await f.admin.readUnifiedModelSources()).userStatsRows.find(
      (r) => r.raw_model_id === 'count',
    )!;
    for (const [, other] of operations) expect(row[other]).toBe(other === field ? 0 : 4);
  }
});

it('matches public verification for every tuple member with nested containers and wrong scalar types', async () => {
  const f = await providerSqlFixture([]);
  const cases = [];
  for (const [operation, , profile] of operations) {
    const expectedTuple = {
      credentialVersion: 1,
      catalogVersion: 1,
      adaptationVersion: 1,
      operation,
      profile,
    };
    for (const [member, value] of Object.entries(expectedTuple)) {
      const variants = {
        valid: value,
        array: [value],
        nestedArray: [[value]],
        arrayOfObject: [{ value }],
        object: { value },
        nestedObject: { nested: { value } },
        objectOfArray: { value: [value] },
        wrongScalar: typeof value === 'number' ? String(value) : 1,
        boolean: true,
        null: null,
      };
      for (const [variant, replacement] of Object.entries(variants)) {
        cases.push({
          label: `${operation}/${member}/${variant}`,
          operation,
          profile,
          tuple: { ...expectedTuple, [member]: replacement },
          expected: variant === 'valid',
        });
      }
    }
  }
  // Constant SELECT: the JSON values are parameters, not persisted/provider data.
  const rows = (
    await f.pool.query<{
      label: string;
      operation: (typeof operations)[number][0];
      profile: string;
      tested_tuple: Record<string, unknown>;
      expected: boolean;
      pg_verified: boolean;
    }>(
      `SELECT x.label,x.operation,x.profile,x.tuple AS tested_tuple,x.expected,
       jsonb_typeof(x.tuple)='object' AND x.tuple @> jsonb_build_object(
         'credentialVersion',1,'catalogVersion',1,'adaptationVersion',1,
         'operation',x.operation,'profile',x.profile) AS pg_verified
     FROM jsonb_to_recordset($1::jsonb) x(label text,operation text,profile text,tuple jsonb,expected boolean)`,
      [JSON.stringify(cases)],
    )
  ).rows;
  expect(rows).toHaveLength(300);
  for (const row of rows) {
    const view = resolveVerificationView({
      verification: {
        provider_id: f.providerId,
        model_key: randomUUID(),
        operation: row.operation,
        driver: row.profile,
        declaration_version: 1,
        verification_status: 'verified',
        verified_at: null,
        verification_evidence: null,
        tested_tuple: row.tested_tuple,
      },
      operation: row.operation,
      profile: row.profile,
      declarationVersion: 1,
      credentialVersion: 1,
      catalogVersion: 1,
    });
    expect(row.pg_verified, row.label).toBe(row.expected);
    expect(view.status === 'verified', row.label).toBe(row.expected);
  }
});

it('keeps catalog > benchmark including empty object > latest supplier metadata, null dates and empty sources', async () => {
  const f = await providerSqlFixture([]);
  expect((await f.admin.readUnifiedModelSources()).userStatsRows).toEqual([]);
  const ids = ['catalog', 'benchmark-empty', 'benchmark', 'sample', 'no-user'];
  await f.pool.query(
    'INSERT INTO mio_provider_catalog_models(raw_model_id) SELECT unnest($1::text[])',
    [ids],
  );
  await f.pool.query(
    `UPDATE mio_provider_catalog_models SET supplier_metadata='{"from":"catalog"}' WHERE raw_model_id='catalog'`,
  );
  await f.pool.query(
    `INSERT INTO mio_admin_catalog_models(raw_model_id,supplier_metadata) VALUES('catalog','{"from":"benchmark"}'),('benchmark-empty','{}'),('benchmark','{"from":"benchmark"}')`,
  );
  for (const owner of ['old', 'new', 'null-date']) {
    await f.store.save(owner, 0, 'synthetic-key');
    await f.pool.query(
      `INSERT INTO mio_provider_models(provider_id,raw_model_id,metadata_source,membership_state,supplier_metadata,credential_version,catalog_version,first_seen_at,last_seen_at)
      SELECT id,x,'onelink-v1-models','removed',jsonb_build_object('from',$2::text),CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE 1 END,CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE 1 END,$3::timestamptz,$3::timestamptz
      FROM mio_provider_configs CROSS JOIN unnest($4::text[]) x WHERE owner_id=$1`,
      [
        owner,
        owner,
        owner === 'null-date' ? null : owner === 'new' ? '2026-11-20' : '2020-01-01',
        ids.slice(0, 4),
      ],
    );
  }
  const sources = await f.admin.readUnifiedModelSources();
  for (const id of ids.slice(0, 3))
    expect(sources.userStatsRows.find((r) => r.raw_model_id === id)?.sample_metadata).toBeNull();
  expect(sources.userStatsRows.find((r) => r.raw_model_id === 'sample')?.sample_metadata).toEqual({
    from: 'new',
  });
  const view = await f.adminService.listModels({});
  expect(Object.fromEntries(view.items.map((r) => [r.rawModelId, r.benchmarkMetadata]))).toEqual({
    catalog: { from: 'catalog' },
    'benchmark-empty': {},
    benchmark: { from: 'benchmark' },
    sample: { from: 'new' },
    'no-user': null,
  });
  await f.pool.query(
    "UPDATE mio_provider_models SET credential_version=NULL,catalog_version=NULL,first_seen_at=NULL,last_seen_at=NULL WHERE raw_model_id='sample'",
  );
  expect(['old', 'new', 'null-date']).toContain(
    (await f.admin.readUnifiedModelSources()).userStatsRows.find((r) => r.raw_model_id === 'sample')
      ?.sample_metadata?.from,
  );
});

async function monitoringFixture(migrate = true) {
  const f = await providerSqlFixture([]);
  const admin = new AdminStore(
    f.pool,
    f.pool,
    false,
    f.pool,
    { revision: 0, retentionDays: null },
    { revision: 0, quotaBytes: 5_368_709_120, warningAvailableBytes: 1_073_741_824 },
  );
  const migrateDomains = async () => {
    for (const sql of [
      assetSchemaSQL,
      generationSchemaSQL,
      conversationSchemaSQL,
      computeSchemaSQL,
    ])
      await f.pool.query(sql);
  };
  if (migrate) await migrateDomains();
  return { ...f, admin, migrateDomains };
}

it.each(['24h', '7d', '30d', 'all'] as const)(
  'preserves exact %s windows, overlapping storage buckets, unknown totals, recent limits and output counts',
  async (window) => {
    const f = await monitoringFixture();
    const ageDays = [0.125, 2, 12, 50];
    const states = [
      'accepted',
      'submitted',
      'processing',
      'materializing',
      'completed',
      'partial',
      'materialization_failed',
      'unknown',
      'failed',
      'rejected',
    ];
    const statuses = ['accepted', 'input-persisted', 'completed', 'cancelled', 'failed', 'unknown'];
    const asset = randomUUID();
    await f.pool.query(
      "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,raw_key,state,expires_at) VALUES($1,'fixture','a','image/png',1,'synthetic','ready',now()+interval '1 day')",
      [asset],
    );
    const jobs: { id: string; state: string; storage: boolean; execution: boolean; age: number }[] =
      [];
    const requests: { id: string; status: string; age: number }[] = [];
    for (const [group, age] of ageDays.entries()) {
      const conversation = randomUUID();
      await f.pool.query(
        "INSERT INTO mio_conversations(id,owner_id,dsh_session_id,state) VALUES($1,'fixture',$2,'ready')",
        [conversation, conversation],
      );
      for (let n = 0; n < 40; n++) {
        const id = randomUUID(),
          state = states[n % states.length]!,
          storage = n % 3 === 0,
          execution = n % 4 !== 0,
          days = age + n / 86400;
        jobs.push({ id, state, storage: storage && execution, execution, age: days });
        await f.pool.query(
          `INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,state,route_snapshot,created_at)
        VALUES($1,'fixture',$1,'synthetic',$2::jsonb,$3,$4::jsonb,now()-$5::double precision*interval '1 day')`,
          [id, n % 2 ? { model: 'm' } : {}, state, n % 2 ? { driver: 'd' } : null, days],
        );
        if (execution)
          await f.pool.query(
            "INSERT INTO mio_image_executions(job_id,phase,storage_failed) VALUES($1,'done',$2)",
            [id, storage],
          );
        if (n === 0)
          await f.pool.query(
            'INSERT INTO mio_image_outputs(job_id,output_index,asset_id) VALUES($1,0,$2),($1,1,$2)',
            [id, asset],
          );
        const status = statuses[n % statuses.length]!,
          request = `${group}-${n}`;
        requests.push({ id: request, status, age: days });
        await f.pool.query(
          `INSERT INTO mio_conversation_requests(conversation_id,request_id,digest,status,model_binding,created_at)
        VALUES($1,$2,'synthetic',$3,$4::jsonb,now()-$5::double precision*interval '1 day')`,
          [conversation, request, status, n % 2 ? { modelId: 'm', protocol: 'p' } : null, days],
        );
        await f.pool.query(
          `INSERT INTO mio_compute_jobs(id,owner_id,request_id,input_asset_id,input_key,input_size,input_etag,state,attempt,attempt_id,command_id,created_at)
        VALUES($1,'fixture',$1,$2,'synthetic',1,'synthetic',$3,1,$1,$1,now()-$4::double precision*interval '1 day')`,
          [id, asset, ['accepted', 'queued', 'running', 'succeeded', 'failed'][n % 5], days],
        );
      }
    }
    await f.pool.query(
      `INSERT INTO mio_compute_outbox(id,job_id,command,created_at,sent_at,lease_until) VALUES
    (gen_random_uuid(),$1,'{}',now()-interval '90 days',now(),NULL),
    (gen_random_uuid(),$1,'{}',now()-interval '2 hours',NULL,now()+interval '1 hour'),
    (gen_random_uuid(),$1,'{}',now()-interval '1 hour',NULL,NULL),
    (gen_random_uuid(),$1,'{}',now()-interval '30 minutes',NULL,now()-interval '1 minute')`,
      [jobs[0]!.id],
    );
    await f.pool.query(
      "INSERT INTO mio_compute_inbox(id,payload,created_at) VALUES(gen_random_uuid(),'{}',now()-interval '90 days'),(gen_random_uuid(),'{}',now())",
    );
    const result = await f.admin.readMonitoring(window);
    const limit = window === 'all' ? Infinity : window === '24h' ? 1 : window === '7d' ? 7 : 30;
    const selected = jobs.filter((j) => j.age < limit),
      selectedRequests = requests.filter((r) => r.age < limit);
    const imageTotals = {
      total: selected.length,
      completed: selected.filter((j) => j.state === 'completed').length,
      inFlight: selected.filter((j) =>
        ['accepted', 'submitted', 'processing', 'materializing'].includes(j.state),
      ).length,
      rejected: selected.filter((j) => j.state === 'rejected').length,
      upstreamFailed: selected.filter((j) => ['failed', 'unknown'].includes(j.state) && !j.storage)
        .length,
      storageFailed: selected.filter(
        (j) => ['materialization_failed', 'partial'].includes(j.state) || j.storage,
      ).length,
    };
    expect(result.images.totals).toEqual(imageTotals);
    expect(
      Object.values(imageTotals)
        .slice(1)
        .reduce((sum, n) => sum + n, 0),
    ).toBeGreaterThan(imageTotals.total);
    expect(
      result.images.byModel.some((r) => r.modelId === 'unknown' && r.driver === 'unknown'),
    ).toBe(true);
    expect(result.images.recentJobs.map((j) => j.id)).toEqual(
      selected.slice(0, 30).map((j) => j.id),
    );
    expect(result.images.recentJobs[0]).toMatchObject({
      phase: null,
      storageFailed: false,
      outputCount: 2,
    });
    expect(result.images.recentJobs[1]).toMatchObject({ phase: 'done', outputCount: 0 });
    expect(result.conversations.totals).toEqual({
      total: selectedRequests.length,
      completed: selectedRequests.filter((r) => r.status === 'completed').length,
      inFlight: selectedRequests.filter((r) => ['accepted', 'input-persisted'].includes(r.status))
        .length,
      failed: selectedRequests.filter((r) => r.status === 'failed').length,
      cancelled: selectedRequests.filter((r) => r.status === 'cancelled').length,
      unknown: selectedRequests.filter((r) => r.status === 'unknown').length,
    });
    expect(result.conversations.byModel.reduce((n, r) => n + r.failed, 0)).toBe(
      result.conversations.totals.failed + result.conversations.totals.unknown,
    );
    expect(
      result.conversations.byModel.some(
        (r) => r.modelId === 'fixed-route' && r.protocol === 'default',
      ),
    ).toBe(true);
    expect(result.conversations.recentRequests.map((r) => r.requestId)).toEqual(
      selectedRequests.slice(0, 25).map((r) => r.id),
    );
    expect(result.compute.jobs).toEqual({
      total: selected.length,
      accepted: selected.length / 5,
      queued: selected.length / 5,
      running: selected.length / 5,
      succeeded: selected.length / 5,
      failed: selected.length / 5,
    });
    expect(result.compute.inboxProcessed).toBe(2);
    expect(result.compute.outbox).toMatchObject({ pending: 3, leased: 1 });
    expect(result.compute.outbox.oldestUnsentAgeSeconds).toBeGreaterThanOrEqual(7200);
    expect(result.compute.outbox.oldestUnsentAgeSeconds).toBeLessThan(7220);
    await f.pool.query('UPDATE mio_compute_outbox SET sent_at=now()');
    expect((await f.admin.readMonitoring(window)).compute.outbox).toEqual({
      pending: 0,
      leased: 0,
      oldestUnsentAgeSeconds: null,
    });
  },
);

it('retries absent schemas after migration, caches only positives per instance, and propagates lookup/data errors', async () => {
  const f = await monitoringFixture(false),
    g = await monitoringFixture(false);
  const query = vi.spyOn(f.pool, 'query');
  for (let n = 0; n < 2; n++) {
    const result = await f.admin.readMonitoring('all');
    expect([result.images.enabled, result.conversations.enabled, result.compute.enabled]).toEqual([
      false,
      false,
      false,
    ]);
  }
  expect(query.mock.calls.filter(([sql]) => String(sql).includes('to_regclass'))).toHaveLength(6);
  await f.migrateDomains();
  query.mockClear();
  const first = await f.admin.readMonitoring('all');
  expect(first.images).toMatchObject({
    enabled: true,
    totals: {
      total: 0,
      completed: 0,
      inFlight: 0,
      rejected: 0,
      upstreamFailed: 0,
      storageFailed: 0,
    },
    byModel: [],
    recentJobs: [],
  });
  expect(first.conversations).toMatchObject({
    enabled: true,
    totals: { total: 0, completed: 0, inFlight: 0, failed: 0, cancelled: 0, unknown: 0 },
    byModel: [],
    recentRequests: [],
  });
  expect(first.compute).toMatchObject({
    enabled: true,
    jobs: { total: 0 },
    outbox: { pending: 0, leased: 0, oldestUnsentAgeSeconds: null },
    inboxProcessed: 0,
  });
  await f.admin.readMonitoring('7d');
  expect(query.mock.calls.filter(([sql]) => String(sql).includes('to_regclass'))).toHaveLength(3);
  expect((await g.admin.readMonitoring('all')).images.enabled).toBe(false);
  const independent = new AdminStore(
    f.pool,
    f.pool,
    false,
    f.pool,
    { revision: 0, retentionDays: null },
    { revision: 0, quotaBytes: 5_368_709_120, warningAvailableBytes: 1_073_741_824 },
  );
  query.mockClear();
  await independent.readMonitoring('all');
  expect(query.mock.calls.filter(([sql]) => String(sql).includes('to_regclass'))).toHaveLength(3);
  const original = f.pool.query.bind(f.pool);
  query.mockImplementationOnce(() => Promise.reject(new Error('data failure')));
  await expect(f.admin.readMonitoring('all')).rejects.toThrow('data failure');
  query.mockRestore();
  const unprobed = new AdminStore(
    f.pool,
    f.pool,
    false,
    f.pool,
    { revision: 0, retentionDays: null },
    { revision: 0, quotaBytes: 5_368_709_120, warningAvailableBytes: 1_073_741_824 },
  );
  let fail = true,
    failData = false,
    lookups = 0;
  const proxy = new Proxy(f.pool, {
    get(target, key) {
      if (key === 'query')
        return async (sql: string, args?: unknown[]) => {
          if (sql.includes('to_regclass')) {
            lookups++;
            if (fail) throw new Error('lookup failure');
          }
          if (failData && sql.includes('FROM mio_image_jobs j')) {
            failData = false;
            throw new Error('image data failure');
          }
          return original(sql, args);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const retry = new AdminStore(
    proxy,
    proxy,
    false,
    proxy,
    { revision: 0, retentionDays: null },
    { revision: 0, quotaBytes: 5_368_709_120, warningAvailableBytes: 1_073_741_824 },
  );
  await expect(retry.readMonitoring('all')).rejects.toThrow('lookup failure');
  fail = false;
  await retry.readMonitoring('all');
  await retry.readMonitoring('all');
  expect(lookups).toBe(6);
  failData = true;
  await expect(retry.readMonitoring('all')).rejects.toThrow('image data failure');
  expect((await retry.readMonitoring('all')).images.enabled).toBe(true);
  expect(lookups).toBe(6);
  // Concurrent first probes may duplicate, then all later reads use positive results.
  const concurrent = vi.spyOn(f.pool, 'query');
  await Promise.all(Array.from({ length: 3 }, () => unprobed.readMonitoring('all')));
  expect(
    concurrent.mock.calls.filter(([sql]) => String(sql).includes('to_regclass')).length,
  ).toBeGreaterThanOrEqual(3);
  concurrent.mockClear();
  await unprobed.readMonitoring('all');
  expect(concurrent.mock.calls.filter(([sql]) => String(sql).includes('to_regclass'))).toHaveLength(
    0,
  );
});

it.each(['equal', 'different-options', 'different-schema'] as const)(
  'routes monitoring pools by exact configuration equality and closes each owner once: %s',
  async (kind) => {
    const f = await monitoringFixture(),
      g = await monitoringFixture();
    const alternate = new URL(f.database.url);
    alternate.searchParams.set('application_name', 'different-options');
    const mediaURL =
      kind === 'equal'
        ? f.database.url
        : kind === 'different-schema'
          ? g.database.url
          : alternate.toString();
    const store = await createAdminStore({
      databaseURL: f.database.url,
      conversationsDatabaseURL: f.database.url,
      mediaDatabaseURL: mediaURL,
      allowedOrigins: [],
    });
    onTestFinished(() => store.close());
    const main = Reflect.get(store, 'pool') as Pool,
      media = Reflect.get(store, 'mediaPool') as Pool;
    expect(media === main).toBe(kind === 'equal');
    expect(Reflect.get(store, 'conversationsPool')).toBe(main);
    const mainEnd = vi.spyOn(main, 'end'),
      mediaEnd = media === main ? mainEnd : vi.spyOn(media, 'end');
    const schema = (await media.query('SELECT current_schema() AS name')).rows[0].name;
    expect(schema).toBe(
      kind === 'different-schema'
        ? new URL(g.database.url).searchParams.get('options')!.split('=')[1]
        : new URL(f.database.url).searchParams.get('options')!.split('=')[1],
    );
    expect((await store.readMonitoring('all')).images.enabled).toBe(true);
    const closing = store.close();
    expect(store.close()).toBe(closing);
    await closing;
    expect(mainEnd).toHaveBeenCalledTimes(1);
    expect(mediaEnd).toHaveBeenCalledTimes(1);
  },
);

it('releases created pools on startup failure with shared and separately owned conversation pools', async () => {
  const f = await providerSqlFixture([]);
  for (const shared of [true, false]) {
    const alternate = new URL(f.database.url);
    alternate.searchParams.set('application_name', 'owned-conversation');
    const end = vi.spyOn(Pool.prototype, 'end');
    const config = {
      databaseURL: f.database.url,
      conversationsDatabaseURL: shared ? f.database.url : alternate.toString(),
      allowedOrigins: [],
      get mediaDatabaseURL(): string {
        throw new Error('fixture failure after conversations allocated');
      },
    };
    await expect(createAdminStore(config)).rejects.toThrow('ADMIN_STARTUP');
    expect(end).toHaveBeenCalledTimes(shared ? 1 : 2);
    end.mockRestore();
  }
});

it('does not cache a partial compute schema when jobs exist but outbox is missing', async () => {
  const f = await monitoringFixture();
  await f.pool.query('DROP TABLE mio_compute_outbox');
  for (let n = 0; n < 2; n++)
    expect((await f.admin.readMonitoring('all')).compute.enabled).toBe(false);
  await f.pool.query(computeSchemaSQL);
  expect((await f.admin.readMonitoring('all')).compute.enabled).toBe(true);
});
