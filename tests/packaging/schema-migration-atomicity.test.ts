import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { authDatabase } from '../support/auth-database.ts';

const assetId = 'aaaaaaaa-0000-4000-8000-000000000001';
const jobId = 'aaaaaaaa-0000-4000-8000-000000000002';
const requestId = 'aaaaaaaa-0000-4000-8000-000000000003';
const originalAsset = `
  INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,source_etag,expires_at)
  VALUES('${assetId}','history','source.mp4','video/mp4',42,'old/staging','old/raw','ready','"old-etag"',now()+interval '1 day');`;

async function schema(database: Pick<Pool, 'query'>) {
  const { rows } = await database.query(`
    SELECT table_name AS relation, column_name AS entry, data_type || ':' || is_nullable AS definition
      FROM information_schema.columns WHERE table_schema = current_schema()
    UNION ALL
    SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()
    UNION ALL
    SELECT relname, conname, pg_get_constraintdef(pg_constraint.oid)
      FROM pg_constraint JOIN pg_class ON pg_class.oid = conrelid
      JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE nspname = current_schema()
    ORDER BY 1,2,3`);
  return rows;
}

const migrations = [
  {
    name: 'assets',
    ddl: assetSchemaSQL,
    legacy: `${assetSchemaSQL}
      DROP INDEX mio_assets_cleanup;
      ${originalAsset}`,
    damage: 'ALTER TABLE mio_assets ALTER COLUMN source_etag TYPE varchar(128)',
    repair: 'ALTER TABLE mio_assets ALTER COLUMN source_etag TYPE text',
    error: 'ASSET_SCHEMA: incompatible metadata columns',
    history: 'SELECT * FROM mio_assets',
  },
  {
    name: 'compute',
    ddl: computeSchemaSQL,
    legacy: `${assetSchemaSQL}
      ${computeSchemaSQL}
      ALTER TABLE mio_assets DROP COLUMN asset_kind, ALTER COLUMN staging_key SET NOT NULL;
      ${originalAsset}
      INSERT INTO mio_compute_jobs(id,owner_id,request_id,input_asset_id,input_key,input_size,input_etag,state,attempt,attempt_id,command_id)
      VALUES('${jobId}','history','${requestId}','${assetId}','old/raw',42,'"old-etag"','failed',1,'${jobId}','${requestId}');`,
    damage: 'ALTER TABLE mio_compute_jobs DROP COLUMN error_code',
    repair: 'ALTER TABLE mio_compute_jobs ADD COLUMN error_code text',
    error: 'column "error_code" does not exist',
    history: `SELECT to_jsonb(job) AS job, to_jsonb(asset) - 'asset_kind' AS asset
      FROM mio_compute_jobs job JOIN mio_assets asset ON asset.id = job.input_asset_id`,
  },
  {
    name: 'conversations',
    ddl: conversationSchemaSQL,
    legacy: `${conversationSchemaSQL}
      ALTER TABLE mio_conversations DROP COLUMN model_binding;
      ALTER TABLE mio_conversation_requests DROP COLUMN model_binding, DROP COLUMN model_observations;
      INSERT INTO mio_conversations(id,owner_id,dsh_session_id,state)
        VALUES('${jobId}','history','old-dsh-session','ready');
      INSERT INTO mio_conversation_requests(conversation_id,request_id,digest,status)
        VALUES('${jobId}','old-request','old-digest','completed');`,
    damage: 'ALTER TABLE mio_conversations ALTER COLUMN owner_id TYPE varchar(128)',
    repair: 'ALTER TABLE mio_conversations ALTER COLUMN owner_id TYPE text',
    error: 'CONVERSATION_SCHEMA: incompatible metadata columns',
    history: `SELECT to_jsonb(c) - 'model_binding' AS conversation,
        to_jsonb(r) - ARRAY['model_binding','model_observations'] AS request
      FROM mio_conversations c JOIN mio_conversation_requests r ON r.conversation_id = c.id`,
  },
  {
    name: 'generations',
    ddl: generationSchemaSQL,
    legacy: `${assetSchemaSQL}
      ${generationSchemaSQL}
      ALTER TABLE mio_assets DROP COLUMN asset_kind, ALTER COLUMN staging_key SET NOT NULL;
      ALTER TABLE mio_image_jobs DROP COLUMN route_snapshot, DROP CONSTRAINT mio_image_jobs_state_check,
        ADD CONSTRAINT mio_image_jobs_state_check CHECK (state IN ('accepted','completed'));
      DROP TABLE mio_image_executions;
      ${originalAsset}
      INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,state)
        VALUES('${jobId}','history','${requestId}','old-hash','{"old":"command"}','completed');
      INSERT INTO mio_image_outputs(job_id,output_index,asset_id) VALUES('${jobId}',0,'${assetId}');`,
    damage: 'ALTER TABLE mio_image_jobs DROP COLUMN admitted',
    repair: "ALTER TABLE mio_image_jobs ADD COLUMN admitted jsonb NOT NULL DEFAULT '{}'",
    error: 'column "admitted" does not exist',
    history: `SELECT to_jsonb(job) - 'route_snapshot' AS job, to_jsonb(output) AS output,
        to_jsonb(asset) - 'asset_kind' AS asset
      FROM mio_image_jobs job JOIN mio_image_outputs output ON output.job_id = job.id
      JOIN mio_assets asset ON asset.id = output.asset_id`,
  },
];

it.each(migrations)(
  '$name migration previews, rolls back failed checks, and upgrades legacy rows',
  async (migration) => {
    const database = await authDatabase();
    const pool = new Pool({ connectionString: database.observerURL });
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [`scripts/service/migrate-${migration.name}.ts`, ...args], {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          MIO_ASSETS_DATABASE_URL: database.url,
          MIO_CONVERSATIONS_DATABASE_URL: database.url,
        },
        encoding: 'utf8',
        timeout: 10000,
      });
    const readHistory = async () => (await pool.query(migration.history)).rows;

    try {
      const preview = run();
      expect(preview.status, preview.stderr).toBe(0);
      expect(preview.stdout.trim()).toBe(migration.ddl.trim());
      expect(await schema(pool)).toEqual([]);

      await pool.query(migration.legacy);
      const legacyHistory = await readHistory();
      expect(legacyHistory).toHaveLength(1);
      await pool.query(migration.damage);
      const damagedSchema = await schema(pool);
      const damagedHistory = await readHistory();

      // Prove DDL can succeed and change this fixture before the final check rejects it.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration.ddl);
        expect(await schema(client)).not.toEqual(damagedSchema);
      } finally {
        try {
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }
      const failed = run('--apply');
      expect(failed.status, failed.stderr).toBe(1);
      expect(failed.stderr).toContain(migration.error);
      expect(await schema(pool)).toEqual(damagedSchema);
      expect(await readHistory()).toEqual(damagedHistory);

      await pool.query(migration.repair);
      const first = run('--apply');
      expect(first.status, first.stderr).toBe(0);
      const migrated = await schema(pool);
      expect(migrated).not.toEqual(damagedSchema);
      expect(await readHistory()).toEqual(legacyHistory);

      const repeated = run('--apply');
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(await schema(pool)).toEqual(migrated);
      expect(await readHistory()).toEqual(legacyHistory);
    } finally {
      await pool.end();
      await database.close();
    }
  },
);
