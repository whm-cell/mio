import type { Pool } from 'pg';
import { audioSchemaSQL, checkAudioSchema } from '../audio/jobs/schema.ts';
import { voiceSchemaSQL, checkVoiceSchema } from '../audio/voices/schema.ts';
import {
  checkProviderOperations,
  providerOperationCheck,
  upgradeProviderOperationSQL,
} from './operation-schema.ts';
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
  supplier_metadata jsonb NOT NULL DEFAULT '{}',
  metadata_source text, credential_version integer, catalog_version integer,
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
ALTER TABLE mio_provider_models
  DROP COLUMN IF EXISTS classification,
  DROP COLUMN IF EXISTS classification_source;
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
CREATE TABLE IF NOT EXISTS mio_provider_model_routes (
  provider_type text NOT NULL DEFAULT 'onelink'
    CHECK (provider_type = 'onelink'),
  raw_model_id text COLLATE "C" NOT NULL
    CHECK (octet_length(raw_model_id) BETWEEN 1 AND 256 AND raw_model_id !~ '[[:cntrl:]]'),
  operation text NOT NULL
    CHECK (${providerOperationCheck}),
  vendor text NOT NULL
    CHECK (char_length(vendor) BETWEEN 1 AND 64 AND vendor ~ '^[a-z0-9-]+$'),
  driver text NOT NULL
    CHECK (char_length(driver) BETWEEN 1 AND 64 AND driver ~ '^[a-z0-9-]+$'),
  classification text NOT NULL
    CHECK (classification IN ('chat', 'image', 'video', 'voice', 'music')),
  submit_path text NOT NULL
    CHECK (
      char_length(submit_path) BETWEEN 2 AND 256
      AND submit_path ~ '^/[A-Za-z0-9._/{}-]+$'
      AND position('..' in submit_path) = 0
      AND position('//' in submit_path) = 0
    ),
  edit_path text
    CHECK (
      edit_path IS NULL OR (
        char_length(edit_path) BETWEEN 2 AND 256
        AND edit_path ~ '^/[A-Za-z0-9._/{}-]+$'
        AND position('..' in edit_path) = 0
        AND position('//' in edit_path) = 0
      )
    ),
  query_path_template text
    CHECK (
      query_path_template IS NULL OR (
        char_length(query_path_template) BETWEEN 2 AND 256
        AND query_path_template ~ '^/[A-Za-z0-9._/{}-]+$'
        AND position('..' in query_path_template) = 0
        AND position('//' in query_path_template) = 0
        AND position('{task_id}' in query_path_template) > 0
      )
    ),
  param_spec jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(param_spec) = 'object'),
  request_defaults jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(request_defaults) = 'object'),
  output_spec jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(output_spec) = 'object'),
  capability_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(capability_metadata) = 'object'),
  source_kind text NOT NULL
    CHECK (source_kind IN ('protocol-reference', 'runtime-observation')),
  source text NOT NULL
    CHECK (char_length(btrim(source)) BETWEEN 1 AND 500),
  source_version text NOT NULL
    CHECK (char_length(btrim(source_version)) BETWEEN 1 AND 200),
  declaration_version integer NOT NULL DEFAULT 1
    CHECK (declaration_version >= 1),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_type, raw_model_id, operation)
);
DO $$
DECLARE
  target_table regclass;
  rec record;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['mio_provider_model_routes'::regclass] LOOP
    FOR rec IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = target_table AND contype = 'c'
        AND position('operation' in pg_get_constraintdef(oid)) > 0
        AND position('image.generate' in pg_get_constraintdef(oid)) > 0
        AND position('video.generate' in pg_get_constraintdef(oid)) = 0
    LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', target_table, rec.conname);
    END LOOP;
  END LOOP;
  FOR rec IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='mio_provider_model_routes'::regclass AND contype='c'
      AND conname IN (
        'mio_provider_model_routes_submit_path_check'
      )
  LOOP
    EXECUTE format('ALTER TABLE mio_provider_model_routes DROP CONSTRAINT %I', rec.conname);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='mio_provider_model_routes'::regclass
      AND conname='mio_provider_model_routes_submit_path_safe_check'
  ) THEN
    ALTER TABLE mio_provider_model_routes ADD CONSTRAINT mio_provider_model_routes_submit_path_safe_check
      CHECK (
        char_length(submit_path) BETWEEN 2 AND 256
        AND submit_path ~ '^/[A-Za-z0-9._:/{}-]+$'
        AND position('..' in submit_path) = 0
        AND position('//' in submit_path) = 0
        AND (position(':' in submit_path) = 0 OR submit_path = '/v1beta/models/{model}:predictLongRunning')
      ) NOT VALID;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='mio_provider_model_routes'::regclass
      AND conname='mio_provider_model_routes_video_route_check'
      AND position('parameters' in pg_get_constraintdef(oid))=0
  ) THEN
    ALTER TABLE mio_provider_model_routes DROP CONSTRAINT mio_provider_model_routes_video_route_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='mio_provider_model_routes'::regclass
      AND conname='mio_provider_model_routes_video_route_check'
  ) THEN
    ALTER TABLE mio_provider_model_routes ADD CONSTRAINT mio_provider_model_routes_video_route_check
      CHECK (
        operation <> 'video.generate' OR (
          classification = 'video'
          AND driver IN ('volcengine-ark-videos','kling-videos','vidu-videos','veo-videos','happyhorse-videos')
          AND edit_path IS NULL
          AND CASE driver
            WHEN 'volcengine-ark-videos' THEN
              submit_path = '/volc/api/v3/contents/generations/tasks'
              AND query_path_template = '/volc/api/v3/contents/generations/tasks/{task_id}'
            WHEN 'kling-videos' THEN
              submit_path IN (
                '/kling/v1/videos/text2video','/kling/v1/videos/image2video',
                '/kling/v1/videos/multi-image2video','/kling/v1/videos/omni-video'
              )
              AND query_path_template = submit_path || '/{task_id}'
            WHEN 'vidu-videos' THEN
              submit_path IN (
                '/vidu/ent/v2/text2video','/vidu/ent/v2/img2video',
                '/vidu/ent/v2/start-end2video','/vidu/ent/v2/reference2video'
              )
              AND query_path_template = '/vidu/ent/v2/tasks/{task_id}/creations'
            WHEN 'veo-videos' THEN
              submit_path = '/v1beta/models/{model}:predictLongRunning'
              AND query_path_template = '/v1beta/operations/{task_id}'
            WHEN 'happyhorse-videos' THEN
              submit_path = '/happyhorse/v1/services/aigc/video-generation/video-synthesis'
              AND query_path_template = '/happyhorse/v1/tasks/{task_id}'
            ELSE false
          END
          AND jsonb_typeof(param_spec) = 'object'
          AND param_spec - 'parameters' = jsonb_build_object('supportedModes', param_spec->'supportedModes')
          AND (NOT (param_spec ? 'parameters') OR jsonb_typeof(param_spec->'parameters')='object')
          AND jsonb_typeof(param_spec->'supportedModes') = 'array'
          AND jsonb_array_length(param_spec->'supportedModes') BETWEEN 1 AND 8
          AND param_spec->'supportedModes' <@
            '["text_to_video","first_frame","last_frame","start_end","reference_subjects","full","video_ref","video_edit"]'::jsonb
          AND request_defaults = '{}'::jsonb
          AND output_spec = '{}'::jsonb
          AND capability_metadata = jsonb_build_object(
            'video', jsonb_build_object(
              'modes', param_spec->'supportedModes',
              'cancellation', jsonb_build_object('supported', false)
            )
          )
        )
      ) NOT VALID;
  END IF;
  FOR rec IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='mio_provider_model_routes'::regclass AND contype='c'
      AND NOT convalidated AND conname IN (
        'mio_provider_model_routes_submit_path_safe_check',
        'mio_provider_model_routes_video_route_check'
      )
  LOOP
    EXECUTE format('ALTER TABLE mio_provider_model_routes VALIDATE CONSTRAINT %I', rec.conname);
  END LOOP;
END $$;
CREATE TABLE IF NOT EXISTS mio_provider_model_verifications (
  provider_id uuid NOT NULL,
  model_key uuid NOT NULL,
  operation text NOT NULL
    CHECK (${providerOperationCheck}),
  declaration_version integer NOT NULL
    CHECK (declaration_version > 0),
  driver text NOT NULL
    CHECK (char_length(driver) BETWEEN 1 AND 64 AND driver ~ '^[a-z0-9-]+$'),
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'verified')),
  verified_at timestamptz,
  verification_evidence text,
  tested_tuple jsonb,
  PRIMARY KEY (provider_id, model_key, operation),
  FOREIGN KEY (provider_id, model_key) REFERENCES mio_provider_models(provider_id, model_key)
);
${upgradeProviderOperationSQL('mio_provider_model_routes')}
${upgradeProviderOperationSQL('mio_provider_model_verifications')}
ALTER TABLE mio_provider_model_verifications DROP COLUMN IF EXISTS adaptation_origin;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'mio_provider_model_routes'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE mio_provider_model_routes ADD PRIMARY KEY (provider_type, raw_model_id, operation);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'mio_provider_model_verifications'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE mio_provider_model_verifications ADD PRIMARY KEY (provider_id, model_key, operation);
  END IF;
  IF to_regclass('mio_provider_model_adaptations') IS NOT NULL THEN
    INSERT INTO mio_provider_model_verifications (
      provider_id, model_key, operation, declaration_version, driver,
      verification_status, verified_at, verification_evidence, tested_tuple
    )
    SELECT
      a.provider_id, a.model_key, a.operation, a.declaration_version, a.profile,
      'verified', a.verified_at, a.verification_evidence,
      CASE
        WHEN jsonb_typeof(a.tested_tuple) = 'object'
        THEN a.tested_tuple - 'adaptationOrigin'
        ELSE a.tested_tuple
      END
    FROM mio_provider_model_adaptations a
    JOIN mio_provider_models m
      ON m.provider_id = a.provider_id AND m.model_key = a.model_key
    JOIN mio_provider_configs c
      ON c.id = a.provider_id
    JOIN mio_provider_model_routes r
      ON r.provider_type = c.provider_type
     AND r.raw_model_id = m.raw_model_id COLLATE "C"
     AND r.operation = a.operation
     AND r.driver = a.profile
     AND r.enabled = true
    WHERE a.verification_status = 'verified'
    ON CONFLICT (provider_id, model_key, operation) DO NOTHING;
    DROP TABLE mio_provider_model_adaptations;
  END IF;
END $$;
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
CREATE TABLE IF NOT EXISTS mio_provider_catalog_models (
  provider_type text NOT NULL DEFAULT 'onelink'
    CHECK (provider_type = 'onelink'),
  raw_model_id text COLLATE "C" NOT NULL
    CHECK (octet_length(raw_model_id) BETWEEN 1 AND 256 AND raw_model_id !~ '[[:cntrl:]]'),
  display_label text
    CHECK (display_label IS NULL OR char_length(display_label) <= 100),
  vendor_label text
    CHECK (vendor_label IS NULL OR char_length(vendor_label) <= 64),
  category text
    CHECK (category IS NULL OR category IN ('chat', 'image', 'video', 'voice', 'music')),
  description text
    CHECK (description IS NULL OR char_length(description) <= 1000),
  supplier_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(supplier_metadata) = 'object'),
  user_visible boolean NOT NULL DEFAULT true,
  allow_undiscovered boolean NOT NULL DEFAULT false,
  call_notes text
    CHECK (call_notes IS NULL OR char_length(call_notes) <= 2000),
  origin_source text NOT NULL DEFAULT 'admin-manual'
    CHECK (origin_source IN ('onelink-import', 'admin-manual', 'route-import')),
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_type, raw_model_id)
);
CREATE TABLE IF NOT EXISTS mio_provider_model_route_revisions (
  id uuid PRIMARY KEY,
  provider_type text NOT NULL DEFAULT 'onelink'
    CHECK (provider_type = 'onelink'),
  raw_model_id text COLLATE "C" NOT NULL
    CHECK (octet_length(raw_model_id) BETWEEN 1 AND 256 AND raw_model_id !~ '[[:cntrl:]]'),
  operation text NOT NULL
    CHECK (${providerOperationCheck}),
  declaration_version integer NOT NULL
    CHECK (declaration_version >= 1),
  action text NOT NULL
    CHECK (action IN ('create', 'update', 'enable', 'disable', 'delete', 'rollback', 'cli-import')),
  actor_type text NOT NULL
    CHECK (actor_type IN ('admin', 'cli')),
  actor_id text,
  actor_name text NOT NULL
    CHECK (char_length(btrim(actor_name)) BETWEEN 1 AND 128),
  summary text
    CHECK (summary IS NULL OR char_length(summary) <= 500),
  before_route jsonb
    CHECK (before_route IS NULL OR jsonb_typeof(before_route) = 'object'),
  after_route jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mio_provider_model_route_revisions_after_route_check CHECK (
    (action = 'delete' AND after_route IS NULL)
    OR (action <> 'delete' AND after_route IS NOT NULL AND jsonb_typeof(after_route) = 'object')
  )
);
${upgradeProviderOperationSQL('mio_provider_model_route_revisions')}
ALTER TABLE mio_provider_model_route_revisions ALTER COLUMN after_route DROP NOT NULL;
DO $$
DECLARE
  target_table regclass;
  rec record;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'mio_provider_model_verifications'::regclass,
    'mio_provider_model_route_revisions'::regclass
  ] LOOP
    FOR rec IN
      SELECT conname FROM pg_constraint
      WHERE conrelid=target_table AND contype='c'
        AND position('operation' in pg_get_constraintdef(oid)) > 0
        AND position('image.generate' in pg_get_constraintdef(oid)) > 0
        AND position('video.generate' in pg_get_constraintdef(oid)) = 0
    LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', target_table, rec.conname);
    END LOOP;
  END LOOP;
  FOR rec IN
    SELECT conrelid, conname FROM pg_constraint
    WHERE conrelid IN (
      'mio_provider_model_routes'::regclass,
      'mio_provider_model_verifications'::regclass,
      'mio_provider_model_route_revisions'::regclass
    ) AND contype='c'
      AND conname IN (
        'mio_provider_model_routes_operation_v1_check',
        'mio_provider_model_verifications_operation_v1_check',
        'mio_provider_model_route_revisions_operation_v1_check'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', rec.conrelid::regclass, rec.conname);
  END LOOP;
  FOR rec IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'mio_provider_model_route_revisions'::regclass
      AND contype = 'c'
      AND (
        pg_get_constraintdef(oid) LIKE '%cli-import%'
        OR conname = 'mio_provider_model_route_revisions_after_route_check'
      )
  LOOP
    EXECUTE format('ALTER TABLE mio_provider_model_route_revisions DROP CONSTRAINT %I', rec.conname);
  END LOOP;
  ALTER TABLE mio_provider_model_route_revisions
    ADD CONSTRAINT mio_provider_model_route_revisions_action_check
      CHECK (action IN ('create', 'update', 'enable', 'disable', 'delete', 'rollback', 'cli-import')),
    ADD CONSTRAINT mio_provider_model_route_revisions_after_route_check
      CHECK (
        (action = 'delete' AND after_route IS NULL)
        OR (action <> 'delete' AND after_route IS NOT NULL AND jsonb_typeof(after_route) = 'object')
      );
  IF to_regclass('mio_provider_model_policies') IS NOT NULL THEN
    INSERT INTO mio_provider_catalog_models (
      provider_type, raw_model_id, display_label, user_visible, allow_undiscovered, call_notes, origin_source, updated_by, created_at, updated_at
    )
    SELECT
      provider_type, raw_model_id, display_label, user_visible, allow_undiscovered, call_notes, 'admin-manual', updated_by, created_at, updated_at
    FROM mio_provider_model_policies
    ON CONFLICT (provider_type, raw_model_id) DO NOTHING;
    DROP TABLE mio_provider_model_policies;
  END IF;
  INSERT INTO mio_provider_catalog_models (
    provider_type, raw_model_id, vendor_label, category, origin_source, created_at, updated_at
  )
  SELECT DISTINCT ON (provider_type, raw_model_id)
    provider_type, raw_model_id, vendor, classification, 'route-import', created_at, updated_at
  FROM mio_provider_model_routes
  ORDER BY provider_type, raw_model_id, updated_at DESC
  ON CONFLICT (provider_type, raw_model_id) DO NOTHING;
END $$;
CREATE INDEX IF NOT EXISTS mio_provider_model_route_revisions_lookup
  ON mio_provider_model_route_revisions (provider_type, raw_model_id, operation, created_at DESC);
${voiceSchemaSQL}
${audioSchemaSQL}
`;

export async function checkProviderSchema(
  pool: Pick<Pool, 'query'>,
  _images = false,
): Promise<void> {
  void _images;
  await checkProviderOperations(pool, [
    'mio_provider_model_routes',
    'mio_provider_model_verifications',
    'mio_provider_model_route_revisions',
  ]);
  await checkVoiceSchema(pool);
  await checkAudioSchema(pool);
  for (const [sql, types] of [
    [
      'SELECT id,credential_version,catalog_version,catalog_credential_version,catalog_succeeded_at,latest_refresh_seq,last_attempt_seq,last_attempt_credential_version,last_attempt_started_at,last_attempt_finished_at,last_attempt_status,last_attempt_error_code,credential_auth_state FROM mio_provider_configs LIMIT 0',
      [2950, 23, 23, 23, 1184, 23, 23, 23, 1184, 1184, 25, 25, 25],
    ],
    [
      'SELECT model_key,provider_id,raw_model_id,supplier_metadata,metadata_source,credential_version,catalog_version,first_seen_at,last_seen_at,membership_state,display_name,description_override FROM mio_provider_models LIMIT 0',
      [2950, 2950, 25, 3802, 25, 23, 23, 1184, 1184, 25, 25, 25],
    ],
    [
      'SELECT provider_type,raw_model_id,operation,vendor,driver,classification,submit_path,edit_path,query_path_template,param_spec,request_defaults,output_spec,capability_metadata,source_kind,source,source_version,declaration_version,enabled,created_at,updated_at FROM mio_provider_model_routes LIMIT 0',
      [25, 25, 25, 25, 25, 25, 25, 25, 25, 3802, 3802, 3802, 3802, 25, 25, 25, 23, 16, 1184, 1184],
    ],
    [
      'SELECT provider_id,model_key,operation,declaration_version,driver,verification_status,verified_at,verification_evidence,tested_tuple FROM mio_provider_model_verifications LIMIT 0',
      [2950, 2950, 25, 23, 25, 25, 1184, 25, 3802],
    ],
    [
      'SELECT provider_id,model_key,usage,enabled,is_default,updated_at FROM mio_provider_model_preferences LIMIT 0',
      [2950, 2950, 25, 16, 16, 1184],
    ],
    [
      'SELECT provider_type,raw_model_id,display_label,vendor_label,category,description,supplier_metadata,user_visible,allow_undiscovered,call_notes,origin_source,updated_by,created_at,updated_at FROM mio_provider_catalog_models LIMIT 0',
      [25, 25, 25, 25, 25, 25, 3802, 16, 16, 25, 25, 25, 1184, 1184],
    ],
    [
      'SELECT id,provider_type,raw_model_id,operation,declaration_version,action,actor_type,actor_id,actor_name,summary,before_route,after_route,created_at FROM mio_provider_model_route_revisions LIMIT 0',
      [2950, 25, 25, 25, 23, 25, 25, 25, 25, 25, 3802, 3802, 1184],
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
  const routeConstraints = await pool.query<{
    table_name: string;
    name: string;
    definition: string;
    valid: boolean;
  }>(`
    SELECT c.relname AS table_name,con.conname AS name,
      pg_get_constraintdef(con.oid) AS definition,con.convalidated AS valid
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
    WHERE con.conrelid IN ('mio_provider_model_routes'::regclass, 'mio_provider_model_verifications'::regclass, 'mio_provider_model_route_revisions'::regclass)
    AND con.conname IN (
      'mio_provider_model_routes_submit_path_safe_check',
      'mio_provider_model_routes_video_route_check'
    )`);
  for (const [table, name, marker] of [
    [
      'mio_provider_model_routes',
      'mio_provider_model_routes_submit_path_safe_check',
      'predictLongRunning',
    ],
    ['mio_provider_model_routes', 'mio_provider_model_routes_video_route_check', 'kling-videos'],
  ] as const) {
    const constraint = routeConstraints.rows.find((item) => item.name === name);
    if (
      !constraint?.valid ||
      constraint.table_name !== table ||
      !constraint.definition.includes(marker)
    )
      throw new Error('PROVIDER_SCHEMA: video route constraints required');
  }
  for (const [table, pkColumns] of [
    ['mio_provider_model_routes', ['provider_type', 'raw_model_id', 'operation']],
    ['mio_provider_model_verifications', ['provider_id', 'model_key', 'operation']],
    ['mio_provider_catalog_models', ['provider_type', 'raw_model_id']],
    ['mio_provider_model_route_revisions', ['id']],
    ['mio_provider_voice_catalogs', ['provider_id']],
    ['mio_provider_voices', ['id']],
    ['mio_audio_jobs', ['id']],
    ['mio_audio_records', ['id']],
  ] as const) {
    const pk = await pool.query<{
      unique: boolean;
      valid: boolean;
      ready: boolean;
      columns: string[];
    }>(
      `SELECT i.indisunique AS unique,i.indisvalid AS valid,i.indisready AS ready,
         ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,position)
           JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num ORDER BY k.position) AS columns
       FROM pg_index i WHERE i.indrelid=$1::regclass AND i.indisprimary`,
      [table],
    );
    const pkRow = pk.rows[0];
    if (
      !pkRow?.unique ||
      !pkRow.valid ||
      !pkRow.ready ||
      JSON.stringify(pkRow.columns) !== JSON.stringify(pkColumns)
    )
      throw new Error(`PROVIDER_SCHEMA: primary key required on ${table}`);
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
