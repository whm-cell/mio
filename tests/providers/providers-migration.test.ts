import { randomUUID, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { makeAudioRouteFixture } from './fixtures/onelink-audio-route.ts';
import { makeChatRouteFixture } from './fixtures/onelink-routes-fixture.ts';
import { legacyProviderSchemaSQL } from './fixtures/provider-legacy-schema.ts';
import { providerSchemaSQL, checkProviderSchema } from '../../src/providers/schema.ts';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';

async function databaseTest(action: (pool: Pool) => Promise<void>) {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    await action(pool);
  } finally {
    await pool.end();
    await database.close();
  }
}
async function seed(pool: Pool, discovery: unknown, credential = 1) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mio_provider_configs(id,owner_id,revision,credential_version,cipher_format,
    master_key_id,nonce,ciphertext,auth_tag,discovery) VALUES($1::uuid,$1::uuid::text,1,$2,1,'legacy', $3,$4,$5,$6::jsonb)`,
    [id, credential, randomBytes(12), randomBytes(32), randomBytes(16), JSON.stringify(discovery)],
  );
  return id;
}
it('upgrades all three installed operation constraints atomically without losing existing revisions', async () =>
  databaseTest(async (pool) => {
    await pool.query(providerSchemaSQL);
    const tables = [
      'mio_provider_model_routes',
      'mio_provider_model_verifications',
      'mio_provider_model_route_revisions',
    ];
    for (const table of tables)
      await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_operation_check,
        ADD CONSTRAINT ${table}_operation_check CHECK (operation IN ('chat', 'image.generate'))`);
    await expect(checkProviderSchema(pool)).rejects.toThrow('operation constraints');
    const route = makeAudioRouteFixture('exact-tts-fixture');
    const environment = {
      PATH: process.env.PATH,
      MIO_PROVIDERS_DATABASE_URL: (pool.options as { connectionString: string }).connectionString,
      MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
      MIO_PROVIDERS_MASTER_KEY_ID: 'migration-fixture',
    };
    const cli = (name: string, argument: string, input?: string) =>
      spawnSync(process.execPath, [`scripts/service/${name}.ts`, argument], {
        env: environment,
        input,
        encoding: 'utf8',
      });
    const oldRoute = makeChatRouteFixture('existing-chat-fixture', 'openai');
    const existing = await pool.query(
      `INSERT INTO mio_provider_model_route_revisions (
        id,raw_model_id,operation,declaration_version,action,actor_type,actor_name,after_route
      ) VALUES($1,'existing-chat-fixture','chat',1,'cli-import','cli','fixture',$2::jsonb) RETURNING id`,
      [randomUUID(), JSON.stringify(oldRoute)],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(providerSchemaSQL);
      await checkProviderSchema(client);
      await expect(
        client.query("UPDATE mio_provider_model_route_revisions SET operation='invalid-operation'"),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await expect(checkProviderSchema(pool)).rejects.toThrow('operation constraints');
    for (let run = 0; run < 2; run++) {
      const migration = cli('migrate-providers', '--apply');
      expect(migration.status, migration.stderr).toBe(0);
    }
    const imported = cli('import-provider-route', '--stdin', JSON.stringify(route));
    expect(imported.status, imported.stderr).toBe(0);
    expect(JSON.parse(imported.stdout)).toMatchObject({
      inserted: 1,
      verification: 'unverified',
      revisions: [{ rawModelId: route.rawModelId, operation: 'audio.tts', action: 'cli-import' }],
    });
    expect(
      (
        await pool.query('SELECT operation FROM mio_provider_model_route_revisions WHERE id=$1', [
          existing.rows[0].id,
        ])
      ).rows,
    ).toEqual([{ operation: 'chat' }]);
  }));

const success = (ids: string[], credentialVersion = 1) => ({
  ids,
  credentialVersion,
  status: 'connected',
  scope: 'models-only',
  error: null,
  checkedAt: '2026-11-09T00:00:00Z',
});

it('enforces route and verification primary keys and active schema columns unconditionally', async () =>
  databaseTest(async (pool) => {
    await pool.query(providerSchemaSQL);
    await expect(checkProviderSchema(pool)).resolves.toBeUndefined();
    await expect(checkProviderSchema(pool, true)).resolves.toBeUndefined();

    await pool.query(
      'ALTER TABLE mio_provider_model_routes DROP CONSTRAINT mio_provider_model_routes_pkey',
    );
    await expect(checkProviderSchema(pool)).rejects.toThrow('PROVIDER_SCHEMA');
    await expect(checkProviderSchema(pool, true)).rejects.toThrow('PROVIDER_SCHEMA');
    await pool.query(providerSchemaSQL);
    await expect(checkProviderSchema(pool, true)).resolves.toBeUndefined();

    await pool.query(
      'ALTER TABLE mio_provider_model_verifications DROP CONSTRAINT mio_provider_model_verifications_pkey',
    );
    await expect(checkProviderSchema(pool)).rejects.toThrow('PROVIDER_SCHEMA');
    await pool.query(providerSchemaSQL);
    await expect(checkProviderSchema(pool)).resolves.toBeUndefined();
    await expect(checkProviderSchema(pool, true)).resolves.toBeUndefined();
  }));

it('upgrades valid success/empty success, failed and rotated observations without a static seed; reruns preserve identity', async () =>
  databaseTest(async (pool) => {
    await pool.query(legacyProviderSchemaSQL);
    const valid = await seed(pool, success(['New:Route-Q', 'new:Route-Q']));
    const empty = await seed(pool, success([]));
    const failed = await seed(pool, {
      ...success([]),
      status: 'failed',
      error: 'UPSTREAM_UNAVAILABLE',
    });
    const rotated = await seed(pool, success(['old-key-only']), 2);
    const auth = await seed(pool, {
      ...success([]),
      status: 'failed',
      error: 'UPSTREAM_AUTH_REJECTED',
    });
    const invalid = await seed(pool, { ...success(['not-proven']), scope: 'unknown' });
    await pool.query(
      `INSERT INTO mio_provider_model_preferences VALUES
    ($1,'onelink:chat:New:Route-Q','chat',true,true),
    ($1,'onelink:image:New:Route-Q','image',true,true),
    ($1,'onelink:chat:history-only','chat',false,false),
    ($1,'unparseable-original-reference','video',true,true)`,
      [valid],
    );
    await pool.query('BEGIN');
    await pool.query(providerSchemaSQL);
    await checkProviderSchema(pool);
    await pool.query('COMMIT');
    const configs = (
      await pool.query(
        'SELECT id,catalog_version,catalog_succeeded_at,credential_auth_state FROM mio_provider_configs',
      )
    ).rows;
    for (const id of [valid, empty])
      expect(configs.find((row) => row.id === id)).toMatchObject({
        catalog_version: 1,
        credential_auth_state: 'valid',
      });
    for (const id of [failed, rotated, invalid])
      expect(configs.find((row) => row.id === id).catalog_version).toBeNull();
    expect(configs.find((row) => row.id === auth)).toMatchObject({
      catalog_version: null,
      credential_auth_state: 'rejected',
    });
    const models = (await pool.query('SELECT * FROM mio_provider_models ORDER BY model_key')).rows;
    expect(models).toHaveLength(4);
    expect(models.find((row) => row.raw_model_id === 'history-only')).toMatchObject({
      membership_state: 'historical',
      catalog_version: null,
      first_seen_at: null,
    });
    expect(models.find((row) => row.legacy_ref)).toMatchObject({
      legacy_ref: 'unparseable-original-reference',
      raw_model_id: null,
      unavailable_reason: 'LEGACY_MODEL_REF_INVALID',
    });
    expect((await pool.query('SELECT * FROM mio_provider_model_routes')).rows).toHaveLength(0);
    expect((await pool.query('SELECT * FROM mio_provider_model_verifications')).rows).toHaveLength(
      0,
    );
    const prefs = (await pool.query('SELECT * FROM mio_provider_model_preferences')).rows;
    expect(
      new Set(
        prefs
          .filter((row) => ['chat', 'image'].includes(row.usage) && row.is_default)
          .map((row) => row.model_key),
      ).size,
    ).toBe(1);
    await pool.query(providerSchemaSQL);
    expect((await pool.query('SELECT * FROM mio_provider_models ORDER BY model_key')).rows).toEqual(
      models,
    );
    await checkProviderSchema(pool);
  }));

it('rolls back a failed upgrade entirely and rejects cross-configuration references/default conflicts', async () =>
  databaseTest(async (pool) => {
    await pool.query(legacyProviderSchemaSQL);
    const id = await seed(pool, success(['new-id']));
    // The old key allowed two refs that collapse to one exact identity/use; do not silently discard either preference.
    await pool.query(
      `INSERT INTO mio_provider_model_preferences VALUES($1,'onelink:chat:new-id','chat',true,false),
    ($1,'onelink:image:new-id','chat',false,false)`,
      [id],
    );
    await pool.query('BEGIN');
    await expect(pool.query(providerSchemaSQL)).rejects.toThrow();
    await pool.query('ROLLBACK');
    expect(
      (await pool.query("SELECT to_regclass('mio_provider_models') AS name")).rows[0].name,
    ).toBeNull();
    expect((await pool.query('SELECT * FROM mio_provider_model_preferences')).rows).toHaveLength(2);
    await pool.query(
      "DELETE FROM mio_provider_model_preferences WHERE model_ref='onelink:image:new-id'",
    );
    await pool.query(providerSchemaSQL);
    const other = await seed(pool, null);
    const model = (await pool.query('SELECT model_key FROM mio_provider_models')).rows[0]
      .model_key as string;
    await expect(
      pool.query(
        `INSERT INTO mio_provider_model_preferences(provider_id,model_key,usage,enabled,is_default)
    VALUES($1,$2,'chat',true,true)`,
        [other, model],
      ),
    ).rejects.toThrow();
    await pool.query('UPDATE mio_provider_model_preferences SET is_default=true');
    await pool.query(
      "INSERT INTO mio_provider_models(provider_id,raw_model_id) VALUES($1,'other-history')",
      [id],
    );
    await expect(
      pool.query(`INSERT INTO mio_provider_model_preferences(provider_id,model_key,usage,enabled,is_default)
    SELECT provider_id,model_key,'chat',true,true FROM mio_provider_models WHERE raw_model_id='other-history'`),
    ).rejects.toThrow();
  }));

it('upgrades an existing catalog, retires legacy adaptations/policies tables and classification columns, and checks metadata constraints', async () =>
  databaseTest(async (pool) => {
    await pool.query(providerSchemaSQL);
    // Simulate pre-existing legacy adaptations/policies tables, adaptation_origin, and classification* columns
    await pool.query(`
      CREATE TABLE mio_provider_model_adaptations (
        provider_id uuid NOT NULL,
        model_key uuid NOT NULL,
        operation text NOT NULL,
        profile text NOT NULL,
        declaration_version integer NOT NULL DEFAULT 1,
        verification_status text NOT NULL DEFAULT 'unverified',
        verified_at timestamptz,
        verification_evidence text,
        tested_tuple jsonb,
        PRIMARY KEY(provider_id, model_key, operation)
      );
      CREATE TABLE mio_provider_model_policies (
        provider_type text NOT NULL DEFAULT 'onelink',
        raw_model_id text COLLATE "C" NOT NULL,
        user_visible boolean NOT NULL DEFAULT true,
        allow_undiscovered boolean NOT NULL DEFAULT false,
        display_label text,
        call_notes text,
        updated_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (provider_type, raw_model_id)
      );
      ALTER TABLE mio_provider_model_verifications ADD COLUMN adaptation_origin text DEFAULT 'platform';
      ALTER TABLE mio_provider_models
        ADD COLUMN classification text,
        ADD COLUMN classification_source text;
    `);
    const id = await seed(pool, null);
    await pool.query(
      `INSERT INTO mio_provider_models(provider_id,raw_model_id,supplier_metadata,classification,classification_source)
       VALUES($1,'old-exact-ID','{"description":"supplier"}','chat','manual')`,
      [id],
    );
    const modelKey = (
      await pool.query<{ model_key: string }>(
        'SELECT model_key FROM mio_provider_models WHERE provider_id=$1',
        [id],
      )
    ).rows[0]!.model_key;
    await pool.query(
      `INSERT INTO mio_provider_model_routes(
         provider_type,raw_model_id,operation,vendor,driver,classification,submit_path,source_kind,source,source_version,declaration_version,enabled
       ) VALUES('onelink','old-exact-ID','chat','openai','openai-chat','chat','/v1/chat/completions','protocol-reference','legacy-doc','v1',1,true)`,
    );
    await pool.query(
      `INSERT INTO mio_provider_model_adaptations(
         provider_id,model_key,operation,profile,declaration_version,verification_status,verified_at,verification_evidence,tested_tuple
       ) VALUES($1,$2,'chat','openai-chat',1,'verified',now(),'legacy-evidence-1','{"adaptationOrigin":"owner","modelId":"old-exact-ID"}'::jsonb)`,
      [id, modelKey],
    );
    await pool.query(
      `INSERT INTO mio_provider_catalog_models(
         provider_type,raw_model_id,display_label,user_visible,allow_undiscovered,call_notes,origin_source,updated_by
       ) VALUES('onelink','existing-catalog-model','Catalog Label',true,false,'Catalog Note','onelink-import','admin')`,
    );
    await pool.query(
      `INSERT INTO mio_provider_model_policies(
         provider_type,raw_model_id,user_visible,allow_undiscovered,display_label,call_notes,updated_by
       ) VALUES
       ('onelink','legacy-policy-only',false,true,'Legacy Policy Label','Legacy call note','ops'),
       ('onelink','existing-catalog-model',false,true,'Old Policy Label','Old note','ops')`,
    );

    await pool.query(
      'ALTER TABLE mio_provider_models DROP COLUMN display_name, DROP COLUMN description_override',
    );
    const before = (await pool.query('SELECT * FROM mio_provider_models')).rows[0] as Record<
      string,
      unknown
    >;
    await expect(checkProviderSchema(pool)).rejects.toThrow();
    await pool.query('BEGIN');
    await pool.query(providerSchemaSQL);
    await checkProviderSchema(pool);
    await pool.query('COMMIT');

    // Backfills matching verified adaptation & legacy policies, then drops retired tables & dead columns.
    expect(
      (await pool.query("SELECT to_regclass('mio_provider_model_adaptations') AS name")).rows[0]
        .name,
    ).toBeNull();
    expect(
      (await pool.query("SELECT to_regclass('mio_provider_model_policies') AS name")).rows[0].name,
    ).toBeNull();
    const deadCols = (
      await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'mio_provider_models'
           AND column_name IN ('classification', 'classification_source')`,
      )
    ).rows;
    expect(deadCols).toEqual([]);

    const migratedPolicies = (
      await pool.query(
        `SELECT raw_model_id, display_label, user_visible, allow_undiscovered, call_notes, origin_source, updated_by
         FROM mio_provider_catalog_models
         WHERE raw_model_id IN ('legacy-policy-only', 'existing-catalog-model')
         ORDER BY raw_model_id COLLATE "C"`,
      )
    ).rows;
    expect(migratedPolicies).toEqual([
      {
        raw_model_id: 'existing-catalog-model',
        display_label: 'Catalog Label',
        user_visible: true,
        allow_undiscovered: false,
        call_notes: 'Catalog Note',
        origin_source: 'onelink-import',
        updated_by: 'admin',
      },
      {
        raw_model_id: 'legacy-policy-only',
        display_label: 'Legacy Policy Label',
        user_visible: false,
        allow_undiscovered: true,
        call_notes: 'Legacy call note',
        origin_source: 'admin-manual',
        updated_by: 'ops',
      },
    ]);

    const verifications = (
      await pool.query(
        'SELECT driver, declaration_version, verification_status, verification_evidence, tested_tuple FROM mio_provider_model_verifications WHERE provider_id=$1',
        [id],
      )
    ).rows;
    expect(verifications).toEqual([
      {
        driver: 'openai-chat',
        declaration_version: 1,
        verification_status: 'verified',
        verification_evidence: 'legacy-evidence-1',
        tested_tuple: { modelId: 'old-exact-ID' },
      },
    ]);

    const {
      classification: _droppedClass,
      classification_source: _droppedSource,
      ...beforeKept
    } = before;
    void _droppedClass;
    void _droppedSource;
    const migrated = (await pool.query('SELECT * FROM mio_provider_models')).rows[0];
    expect(migrated).toEqual({ ...beforeKept, display_name: null, description_override: null });
    expect(migrated).toMatchObject({
      first_seen_at: null,
      last_seen_at: null,
      catalog_version: null,
    });
    await pool.query(
      "UPDATE mio_provider_models SET display_name='保存',description_override='保留'",
    );
    await pool.query(providerSchemaSQL);
    expect(
      (await pool.query('SELECT display_name,description_override FROM mio_provider_models'))
        .rows[0],
    ).toEqual({ display_name: '保存', description_override: '保留' });
    await expect(
      pool.query("UPDATE mio_provider_models SET display_name=repeat('x',101)"),
    ).rejects.toThrow();
    await expect(
      pool.query("UPDATE mio_provider_models SET description_override=repeat('x',501)"),
    ).rejects.toThrow();
    await pool.query(
      'ALTER TABLE mio_provider_models DROP CONSTRAINT mio_provider_models_display_name_length',
    );
    await pool.query(
      'ALTER TABLE mio_provider_models ADD CONSTRAINT mio_provider_models_display_name_length CHECK(char_length(display_name)<=101)',
    );
    await expect(checkProviderSchema(pool)).rejects.toThrow('PROVIDER_SCHEMA');
    await expect(
      pool.query('BEGIN').then(async () => {
        await pool.query(providerSchemaSQL);
        await checkProviderSchema(pool);
      }),
    ).rejects.toThrow('PROVIDER_SCHEMA');
    await pool.query('ROLLBACK');
  }));

it('imports only owner-matching legacy conversation/receipt references from a separately configured database', async () => {
  const database = await authDatabase();
  const conversations = await authDatabase();
  const providers = new Pool({ connectionString: database.url });
  const history = new Pool({ connectionString: conversations.url });
  try {
    await providers.query(legacyProviderSchemaSQL);
    const owner = await seed(providers, null);
    await history.query(conversationSchemaSQL);
    const id = randomUUID();
    const binding = {
      providerConfigId: owner,
      modelRef: 'onelink:chat:History:Route-Q',
      modelId: 'History:Route-Q',
      protocol: 'openai-chat',
    };
    await history.query(
      `INSERT INTO mio_conversations(id,owner_id,dsh_session_id,state,model_binding)
      VALUES($1,$2,'old-session','ready',$3::jsonb)`,
      [id, owner, JSON.stringify(binding)],
    );
    const requestBinding = {
      ...binding,
      modelRef: 'onelink:chat:receipt-only',
      modelId: 'receipt-only',
    };
    await history.query(
      `INSERT INTO mio_conversation_requests(conversation_id,request_id,digest,status,model_binding)
      VALUES($1,'old-receipt','unchanged-digest','completed',$2::jsonb)`,
      [id, JSON.stringify(requestBinding)],
    );
    const env = {
      PATH: process.env.PATH ?? '',
      MIO_PROVIDERS_DATABASE_URL: database.url,
      MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
      MIO_PROVIDERS_MASTER_KEY_ID: 'migration',
      MIO_CONVERSATIONS_DATABASE_URL: conversations.url,
    };
    const before = (await history.query('SELECT * FROM mio_conversation_requests')).rows;
    const run = () =>
      spawnSync(
        process.execPath,
        ['scripts/service/migrate-providers.ts', '--apply', '--with-conversations'],
        { env, encoding: 'utf8', timeout: 30000 },
      );
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    const models = (
      await providers.query('SELECT * FROM mio_provider_models ORDER BY raw_model_id')
    ).rows;
    expect(models.map((model) => model.raw_model_id)).toEqual(['History:Route-Q', 'receipt-only']);
    expect(
      models.every(
        (model) =>
          model.membership_state === 'historical' &&
          model.first_seen_at === null &&
          model.catalog_version === null,
      ),
    ).toBe(true);
    expect(run().status).toBe(0);
    expect(
      (await providers.query('SELECT * FROM mio_provider_models ORDER BY raw_model_id')).rows,
    ).toEqual(models);
    expect((await history.query('SELECT * FROM mio_conversation_requests')).rows).toEqual(before);
  } finally {
    await providers.end();
    await history.end();
    await database.close();
    await conversations.close();
  }
}, 30000);
