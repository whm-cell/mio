import type { Pool } from 'pg';

export const accountClosureTables: readonly (readonly [string, string, string?])[] = [
  ['mio_assets', 'owner_id'],
  ['mio_asset_derivative_intents', 'owner_id'],
  ['mio_asset_holders', 'owner_id'],
  ['mio_storage_usage', 'owner_id'],
  ['mio_storage_objects', 'owner_id'],
  ['mio_image_jobs', 'owner_id'],
  ['mio_image_executions', 'mio_image_jobs', 'job_id'],
  ['mio_image_outputs', 'mio_image_jobs', 'job_id'],
  ['mio_video_jobs', 'owner_id'],
  ['mio_video_executions', 'mio_video_jobs', 'job_id'],
  ['mio_video_outputs', 'mio_video_jobs', 'job_id'],
  ['mio_compute_jobs', 'owner_id'],
  ['mio_compute_outbox', 'mio_compute_jobs', 'job_id'],
  ['mio_media_jobs', 'owner_id'],
  ['mio_media_outbox', 'mio_media_jobs', 'job_id'],
  ['mio_media_retries', 'owner_id'],
  ['mio_media_files', 'mio_media_jobs', 'job_id'],
  ['mio_media_controls', 'mio_media_jobs', 'job_id'],
  ['mio_material_groups', 'owner_id'],
  ['mio_materials', 'owner_id'],
  ['mio_material_operations', 'owner_id'],
  ['mio_material_auth_sessions', 'owner_id'],
  ['mio_creation_logs', 'owner_id'],
  ['mio_announcement_reads', 'user_id'],
  ['mio_conversations', 'owner_id'],
  ['mio_conversation_requests', 'mio_conversations', 'conversation_id'],
  ['mio_provider_configs', 'owner_id'],
  ['mio_provider_models', 'mio_provider_configs', 'provider_id'],
  ['mio_provider_model_preferences', 'mio_provider_configs', 'provider_id'],
  ['mio_provider_model_verifications', 'mio_provider_configs', 'provider_id'],
  ['mio_provider_voice_catalogs', 'mio_provider_configs', 'provider_id'],
  ['mio_provider_voices', 'mio_provider_configs', 'provider_id'],
  ['mio_audio_jobs', 'owner_id'],
  ['mio_audio_records', 'owner_id'],
  ['mio_audio_creation_outbox', 'owner_id'],
];

export function accountDeletionDomainNames(
  configured: readonly string[],
  mediaTables: ReadonlySet<string>,
) {
  const media = [
    ['mio_assets', 'assets'],
    ['mio_image_jobs', 'generations'],
    ['mio_video_jobs', 'generations'],
    ['mio_media_jobs', 'compute'],
    ['mio_compute_jobs', 'compute'],
    ['mio_creation_logs', 'creation-logs'],
    ['mio_material_groups', 'materials'],
  ] as const;
  return [
    ...new Set([
      'auth',
      'archive',
      ...configured,
      ...media.filter(([table]) => mediaTables.has(table)).map(([, domain]) => domain),
    ]),
  ];
}

/** Database-local fences serialize closure with every owned final write, including async children. */
export function accountClosureSchemaSQL(tables: readonly (readonly [string, string, string?])[]) {
  const triggers = tables
    .map(
      ([table, ownerOrParent, childColumn]) => `
    DROP TRIGGER IF EXISTS mio_closed_account_write ON ${table};
    CREATE TRIGGER mio_closed_account_write BEFORE INSERT OR UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION mio_guard_closed_account('${ownerOrParent}'${childColumn ? `,'owner_id','${childColumn}'` : ''});`,
    )
    .join('\n');
  return `
CREATE TABLE IF NOT EXISTS mio_closed_accounts (
  user_id text PRIMARY KEY, finalized_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS mio_account_cleanup_receipts (
  user_id text NOT NULL, domain text NOT NULL, completed_at timestamptz,
  remaining integer NOT NULL DEFAULT 0 CHECK(remaining>=0), PRIMARY KEY(user_id,domain)
);
CREATE INDEX IF NOT EXISTS mio_account_cleanup_receipts_pending ON mio_account_cleanup_receipts(user_id)
  WHERE completed_at IS NULL OR remaining<>0;
CREATE OR REPLACE FUNCTION mio_guard_closed_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner text;
BEGIN
  IF TG_NARGS=1 THEN owner:=to_jsonb(NEW)->>TG_ARGV[0];
  ELSE EXECUTE format('SELECT %I FROM %I WHERE id=$1::uuid',TG_ARGV[1],TG_ARGV[0])
    INTO owner USING to_jsonb(NEW)->>TG_ARGV[2]; END IF;
  IF owner IS NULL OR current_setting('mio.cleanup_owner',true)=owner THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mio:closed-account:'||owner,0));
  IF EXISTS(SELECT 1 FROM mio_closed_accounts WHERE user_id=owner) THEN
    IF TG_TABLE_NAME='mio_assets' AND TG_OP='UPDATE'
      AND (to_jsonb(NEW)-ARRAY['state','staging_deleted_at'])=(to_jsonb(OLD)-ARRAY['state','staging_deleted_at'])
      AND ((to_jsonb(NEW)->>'state')='expired' OR (to_jsonb(NEW)->>'state')=(to_jsonb(OLD)->>'state')) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ACCOUNT_DELETED' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
${triggers}`;
}

/** Startup is read-only; installing a fence belongs to explicit domain migrations. */
export async function checkAccountClosureSchema(pool: Pick<Pool, 'query'>) {
  await pool.query('SELECT user_id,finalized_at FROM mio_closed_accounts LIMIT 0');
  await pool.query(
    'SELECT user_id,domain,completed_at,remaining FROM mio_account_cleanup_receipts LIMIT 0',
  );
  const result = await pool.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY(current_schemas(false)) AND c.relname=ANY($1::text[])
    AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='mio_closed_account_write' AND t.tgenabled='O')`,
    [accountClosureTables.map(([table]) => table)],
  );
  if (result.rows.length)
    throw new Error('ACCOUNT_CLOSURE_SCHEMA: run account-deletion:migrate --apply');
}
