import type { Pool } from 'pg';
import { legacyProviderUpgradeSQL } from './schema-migration.ts';
export { providerReferencesSQL } from './schema-migration.ts';

/** Explicit migration only. Startup runs the read-only check below. */
export const providerSchemaSQL = `
CREATE TABLE IF NOT EXISTS mio_provider_configs (
  id uuid PRIMARY KEY, owner_id text NOT NULL UNIQUE,
  provider_type text NOT NULL DEFAULT 'onelink' CHECK(provider_type='onelink'),
  enabled boolean NOT NULL DEFAULT true,
  default_image_watermark boolean NOT NULL DEFAULT false,
  default_video_watermark boolean NOT NULL DEFAULT false,
  revision integer NOT NULL CHECK(revision>0), credential_version integer NOT NULL CHECK(credential_version>0),
  cipher_format smallint NOT NULL CHECK(cipher_format=1), master_key_id text NOT NULL,
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12), ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16), discovery jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mio_provider_configs
  ADD COLUMN IF NOT EXISTS catalog_version integer CHECK(catalog_version>0),
  ADD COLUMN IF NOT EXISTS catalog_credential_version integer CHECK(catalog_credential_version>0),
  ADD COLUMN IF NOT EXISTS catalog_succeeded_at timestamptz,
  ADD COLUMN IF NOT EXISTS latest_refresh_seq integer NOT NULL DEFAULT 0 CHECK(latest_refresh_seq>=0),
  ADD COLUMN IF NOT EXISTS last_attempt_seq integer,
  ADD COLUMN IF NOT EXISTS last_attempt_credential_version integer,
  ADD COLUMN IF NOT EXISTS last_attempt_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_attempt_finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_attempt_status text CHECK(last_attempt_status IN ('running','connected','failed')),
  ADD COLUMN IF NOT EXISTS last_attempt_error_code text,
  ADD COLUMN IF NOT EXISTS credential_auth_state text NOT NULL DEFAULT 'unchecked'
    CHECK(credential_auth_state IN ('unchecked','valid','rejected'));
CREATE TABLE IF NOT EXISTS mio_provider_models (
  model_key uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES mio_provider_configs(id),
  raw_model_id text COLLATE "C", legacy_ref text, unavailable_reason text,
  supplier_metadata jsonb NOT NULL DEFAULT '{}', classification text
    CHECK(classification IN ('chat','image','video','voice','music')),
  metadata_source text, classification_source text, credential_version integer, catalog_version integer,
  first_seen_at timestamptz, last_seen_at timestamptz,
  membership_state text NOT NULL DEFAULT 'historical' CHECK(membership_state IN ('current','removed','historical')),
  UNIQUE(provider_id,model_key), UNIQUE(provider_id,raw_model_id), UNIQUE(provider_id,legacy_ref),
  CHECK(raw_model_id IS NOT NULL OR (legacy_ref IS NOT NULL AND membership_state='historical')),
  CHECK(raw_model_id IS NULL OR (octet_length(raw_model_id) BETWEEN 1 AND 256 AND raw_model_id !~ '[[:cntrl:]]')),
  CHECK((credential_version IS NULL AND catalog_version IS NULL AND first_seen_at IS NULL AND last_seen_at IS NULL)
    OR (credential_version>0 AND catalog_version>0 AND first_seen_at IS NOT NULL AND last_seen_at IS NOT NULL)),
  CHECK(membership_state<>'current' OR (credential_version IS NOT NULL AND catalog_version IS NOT NULL))
);
ALTER TABLE mio_provider_models
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS description_override text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='mio_provider_models'::regclass
    AND conname='mio_provider_models_display_name_length') THEN
    ALTER TABLE mio_provider_models ADD CONSTRAINT mio_provider_models_display_name_length
      CHECK(char_length(display_name)<=100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='mio_provider_models'::regclass
    AND conname='mio_provider_models_description_override_length') THEN
    ALTER TABLE mio_provider_models ADD CONSTRAINT mio_provider_models_description_override_length
      CHECK(char_length(description_override)<=500);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS mio_provider_model_adaptations (
  provider_id uuid NOT NULL, model_key uuid NOT NULL,
  operation text NOT NULL CHECK(operation='chat'),
  profile text NOT NULL CHECK(profile IN ('openai-chat','anthropic-messages')),
  declaration_version integer NOT NULL CHECK(declaration_version>0),
  source text NOT NULL, source_version text NOT NULL, capability_metadata jsonb NOT NULL DEFAULT '{}',
  verification_status text NOT NULL DEFAULT 'unverified' CHECK(verification_status IN ('unverified','verified')),
  verified_at timestamptz, verification_evidence text, tested_tuple jsonb,
  PRIMARY KEY(provider_id,model_key,operation),
  FOREIGN KEY(provider_id,model_key) REFERENCES mio_provider_models(provider_id,model_key)
);
${legacyProviderUpgradeSQL}
CREATE TABLE IF NOT EXISTS mio_provider_model_preferences (
  provider_id uuid NOT NULL, model_key uuid NOT NULL, model_ref text,
  usage text NOT NULL CHECK(usage IN ('chat','image','video','voice','music')),
  enabled boolean NOT NULL, is_default boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider_id,model_key,usage),
  FOREIGN KEY(provider_id,model_key) REFERENCES mio_provider_models(provider_id,model_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS mio_provider_usage_default
  ON mio_provider_model_preferences(provider_id,usage) WHERE is_default;
`;

export async function checkProviderSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  for (const [sql, types] of [
    [
      'SELECT id,credential_version,catalog_version,catalog_credential_version,catalog_succeeded_at,latest_refresh_seq,last_attempt_seq,last_attempt_credential_version,last_attempt_started_at,last_attempt_finished_at,last_attempt_status,last_attempt_error_code,credential_auth_state FROM mio_provider_configs LIMIT 0',
      [2950, 23, 23, 23, 1184, 23, 23, 23, 1184, 1184, 25, 25, 25],
    ],
    [
      'SELECT model_key,provider_id,raw_model_id,supplier_metadata,classification,metadata_source,credential_version,catalog_version,first_seen_at,last_seen_at,membership_state,display_name,description_override FROM mio_provider_models LIMIT 0',
      [2950, 2950, 25, 3802, 25, 25, 23, 23, 1184, 1184, 25, 25, 25],
    ],
    [
      'SELECT provider_id,model_key,operation,profile,declaration_version,source,source_version,capability_metadata,verification_status,verified_at,verification_evidence,tested_tuple FROM mio_provider_model_adaptations LIMIT 0',
      [2950, 2950, 25, 25, 23, 25, 25, 3802, 25, 1184, 25, 3802],
    ],
    [
      'SELECT provider_id,model_key,usage,enabled,is_default,updated_at FROM mio_provider_model_preferences LIMIT 0',
      [2950, 2950, 25, 16, 16, 1184],
    ],
  ] as const) {
    const result = await pool.query(sql);
    if (result.fields.some((field, index) => field.dataTypeID !== types[index]))
      throw new Error('PROVIDER_SCHEMA: incompatible columns');
  }
  const constraints = await pool.query<{ name: string; definition: string; valid: boolean }>(`
    SELECT conname AS name,pg_get_constraintdef(oid) AS definition,convalidated AS valid
    FROM pg_constraint WHERE conrelid='mio_provider_models'::regclass AND contype='c'
      AND conname IN ('mio_provider_models_display_name_length','mio_provider_models_description_override_length')`);
  for (const [name, definition] of [
    ['mio_provider_models_display_name_length', 'CHECK ((char_length(display_name) <= 100))'],
    [
      'mio_provider_models_description_override_length',
      'CHECK ((char_length(description_override) <= 500))',
    ],
  ]) {
    const constraint = constraints.rows.find((item) => item.name === name);
    if (!constraint?.valid || constraint.definition !== definition)
      throw new Error('PROVIDER_SCHEMA: model metadata length constraints required');
  }
  const index = await pool.query<{
    unique: boolean;
    valid: boolean;
    ready: boolean;
    columns: string[];
    predicate: string;
    plain: boolean;
  }>(`
    SELECT i.indisunique AS unique,i.indisvalid AS valid,i.indisready AS ready,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,position)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num ORDER BY k.position) AS columns,
      pg_get_expr(i.indpred,i.indrelid) AS predicate,i.indexprs IS NULL AS plain
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relname='mio_provider_usage_default' AND n.nspname=current_schema()
      AND i.indrelid='mio_provider_model_preferences'::regclass`);
  const row = index.rows[0];
  if (
    !row?.unique ||
    !row.valid ||
    !row.ready ||
    !row.plain ||
    JSON.stringify(row.columns) !== JSON.stringify(['provider_id', 'usage']) ||
    row.predicate !== 'is_default'
  )
    throw new Error('PROVIDER_SCHEMA: default uniqueness index required');
}
