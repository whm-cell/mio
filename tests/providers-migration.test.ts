import { randomUUID, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { authDatabase } from './auth-database.ts';
import { legacyProviderSchemaSQL } from './fixtures/provider-legacy-schema.ts';
import { providerSchemaSQL, checkProviderSchema } from '../src/providers/schema.ts';
import { conversationSchemaSQL } from '../src/conversations/schema.ts';

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
const success = (ids: string[], credentialVersion = 1) => ({
  ids,
  credentialVersion,
  status: 'connected',
  scope: 'models-only',
  error: null,
  checkedAt: '2026-11-09T00:00:00Z',
});

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
    expect((await pool.query('SELECT * FROM mio_provider_model_adaptations')).rows).toHaveLength(0);
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
