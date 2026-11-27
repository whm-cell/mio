import type { Pool } from 'pg';
import {
  checkProviderOperations,
  providerOperationCheck,
  upgradeProviderOperationSQL,
} from '../providers/operation-schema.ts';

const initialRouteTemplatesSeedJson = JSON.stringify([
  {
    template_key: 'seedream-5',
    label: '火山 Seedream 同步多图模板',
    description: '适用于火山方舟同步出图协议，支持 2K/4K 与多参考图',
    operation: 'image.generate',
    vendor: 'volcengine',
    driver: 'volcengine-ark-images',
    sort_order: 10,
    route_template: {
      providerType: 'onelink',
      operation: 'image.generate',
      vendor: 'volcengine',
      driver: 'volcengine-ark-images',
      classification: 'image',
      submitPath: '/volc/api/v3/images/generations',
      sourceKind: 'protocol-reference',
      source: 'OneLink 火山方舟图像生成接入指南',
      sourceVersion: '2026-11',
      enabled: true,
      paramSpec: {
        supportedOperations: ['generate'],
        requiresAsync: false,
        maxN: 15,
        allowExplicitN: true,
        allowedSizes: ['1024x1024', '2K', '3K', '4K'],
        allowCustomDimensions: false,
        maxReferenceImages: 14,
        allowGenerateReferences: true,
        allowMaskPng: false,
        allowOutpaintGeometry: false,
        allowedQualities: [],
        allowedBackgrounds: [],
        allowedModerations: [],
        allowedOutputFormats: ['jpeg', 'png'],
        allowOutputCompression: false,
        allowUserField: false,
        allowedAspectRatios: [],
        allowWatermarkOverride: true,
        async: null,
      },
      requestDefaults: {
        defaultSize: '2K',
        responseFormat: 'b64_json',
        sequentialImageGeneration: 'disabled',
        stream: false,
        watermark: false,
      },
      outputSpec: {
        fixedOutputFormat: null,
      },
    },
    ui_hints: {
      recommendedSizes: [
        '1024x1024',
        '2K',
        '3K',
        '4K',
        '2048x2048',
        '2304x1728',
        '1728x2304',
        '2560x1440',
        '1440x2560',
      ],
      recommendedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'],
      recommendedOutputFormats: ['jpeg', 'png'],
    },
  },
  {
    template_key: 'kling-standard',
    label: '可灵 Kling 标准异步生图模板',
    description: '适用于 Kling 标准异步端点，支持比例与最多 4 张参考图',
    operation: 'image.generate',
    vendor: 'kling',
    driver: 'kling-images',
    sort_order: 20,
    route_template: {
      providerType: 'onelink',
      operation: 'image.generate',
      vendor: 'kling',
      driver: 'kling-images',
      classification: 'image',
      submitPath: '/kling/v1/images/generations',
      queryPathTemplate: '/kling/v1/images/generations/{task_id}',
      sourceKind: 'protocol-reference',
      source: 'OneLink Kling 系列模型接入指南',
      sourceVersion: '2026-09-08',
      enabled: true,
      paramSpec: {
        supportedOperations: ['generate'],
        requiresAsync: true,
        maxN: 4,
        allowExplicitN: true,
        allowedSizes: null,
        allowCustomDimensions: false,
        maxReferenceImages: 4,
        allowGenerateReferences: true,
        allowMaskPng: false,
        allowOutpaintGeometry: false,
        allowedQualities: [],
        allowedBackgrounds: [],
        allowedModerations: [],
        allowedOutputFormats: [],
        allowOutputCompression: false,
        allowUserField: false,
        allowedAspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
        allowWatermarkOverride: false,
        async: {
          operations: ['generate'],
          maxQueries: 8,
          maxAgeSeconds: 600,
        },
      },
      requestDefaults: {
        referenceFormat: 'image',
      },
      outputSpec: {
        fixedOutputFormat: null,
      },
    },
    ui_hints: {
      recommendedSizes: ['1K', '2K'],
      recommendedAspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
      recommendedOutputFormats: [],
    },
  },
  {
    template_key: 'kling-omni',
    label: '可灵 Kling Omni 异步模板',
    description: '适用于 Kling Omni 专属端点，单参考图 image_list 协议',
    operation: 'image.generate',
    vendor: 'kling',
    driver: 'kling-images',
    sort_order: 30,
    route_template: {
      providerType: 'onelink',
      operation: 'image.generate',
      vendor: 'kling',
      driver: 'kling-images',
      classification: 'image',
      submitPath: '/kling/v1/images/omni-image',
      queryPathTemplate: '/kling/v1/images/omni-image/{task_id}',
      sourceKind: 'protocol-reference',
      source: 'OneLink Kling Omni 模型接入指南',
      sourceVersion: '2026-09-08',
      enabled: true,
      paramSpec: {
        supportedOperations: ['generate'],
        requiresAsync: true,
        maxN: 1,
        allowExplicitN: true,
        allowedSizes: null,
        allowCustomDimensions: false,
        maxReferenceImages: 1,
        allowGenerateReferences: true,
        allowMaskPng: false,
        allowOutpaintGeometry: false,
        allowedQualities: [],
        allowedBackgrounds: [],
        allowedModerations: [],
        allowedOutputFormats: [],
        allowOutputCompression: false,
        allowUserField: false,
        allowedAspectRatios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
        allowWatermarkOverride: false,
        async: {
          operations: ['generate'],
          maxQueries: 8,
          maxAgeSeconds: 600,
        },
      },
      requestDefaults: {
        referenceFormat: 'image_list',
      },
      outputSpec: {
        fixedOutputFormat: null,
      },
    },
    ui_hints: {
      recommendedSizes: ['1K', '2K'],
      recommendedAspectRatios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
      recommendedOutputFormats: [],
    },
  },
  {
    template_key: 'vidu-async',
    label: '生数 Vidu 异步生图模板',
    description: '适用于 Vidu 异步端点，支持 1080p/2K/4K 分辨率并省略显式 n',
    operation: 'image.generate',
    vendor: 'vidu',
    driver: 'vidu-images',
    sort_order: 40,
    route_template: {
      providerType: 'onelink',
      operation: 'image.generate',
      vendor: 'vidu',
      driver: 'vidu-images',
      classification: 'image',
      submitPath: '/vidu/ent/v2/reference2image',
      queryPathTemplate: '/vidu/ent/v2/tasks/{task_id}/creations',
      sourceKind: 'protocol-reference',
      source: 'OneLink Vidu 系列模型接入指南',
      sourceVersion: '2026-11',
      enabled: true,
      paramSpec: {
        supportedOperations: ['generate'],
        requiresAsync: true,
        maxN: 1,
        allowExplicitN: false,
        allowedSizes: ['1080p', '2K', '4K'],
        allowCustomDimensions: false,
        maxReferenceImages: 7,
        allowGenerateReferences: true,
        allowMaskPng: false,
        allowOutpaintGeometry: false,
        allowedQualities: [],
        allowedBackgrounds: [],
        allowedModerations: [],
        allowedOutputFormats: [],
        allowOutputCompression: false,
        allowUserField: false,
        allowedAspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
        allowWatermarkOverride: false,
        async: {
          operations: ['generate'],
          maxQueries: 8,
          maxAgeSeconds: 600,
        },
      },
      requestDefaults: {
        defaultSize: '1080p',
      },
      outputSpec: {
        fixedOutputFormat: null,
      },
    },
    ui_hints: {
      recommendedSizes: ['1080p', '2K', '4K'],
      recommendedAspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
      recommendedOutputFormats: [],
    },
  },
  {
    template_key: 'openai-images',
    label: 'OpenAI 兼容同步生图模板',
    description: '适用于 /v1/images/generations 与 /v1/images/edits 同步兼容协议',
    operation: 'image.generate',
    vendor: 'openai',
    driver: 'openai-images',
    sort_order: 50,
    route_template: {
      providerType: 'onelink',
      operation: 'image.generate',
      vendor: 'openai',
      driver: 'openai-images',
      classification: 'image',
      submitPath: '/v1/images/generations',
      editPath: '/v1/images/edits',
      sourceKind: 'protocol-reference',
      source: 'OneLink OpenAI Images 兼容接口指南',
      sourceVersion: '2026-11',
      enabled: true,
      paramSpec: {
        supportedOperations: ['generate', 'edit'],
        requiresAsync: false,
        maxN: 4,
        allowExplicitN: true,
        allowedSizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
        allowCustomDimensions: false,
        maxReferenceImages: 4,
        allowGenerateReferences: false,
        allowMaskPng: true,
        allowOutpaintGeometry: false,
        allowedQualities: ['auto', 'high', 'medium', 'low'],
        allowedBackgrounds: ['auto', 'transparent', 'opaque'],
        allowedModerations: ['auto', 'low'],
        allowedOutputFormats: ['png', 'jpeg', 'webp'],
        allowOutputCompression: true,
        allowUserField: false,
        allowedAspectRatios: [],
        allowWatermarkOverride: false,
        async: null,
      },
      requestDefaults: {},
      outputSpec: {
        fixedOutputFormat: null,
      },
    },
    ui_hints: {
      recommendedSizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
      recommendedAspectRatios: [],
      recommendedOutputFormats: ['png', 'jpeg', 'webp'],
      recommendedQualities: ['auto', 'high', 'medium', 'low'],
      recommendedBackgrounds: ['auto', 'transparent', 'opaque'],
    },
  },
  {
    template_key: 'openai-chat',
    label: 'OpenAI 兼容文本/多模态对话模板',
    description: '适用于 /v1/chat/completions 协议，可开启视觉图片输入能力',
    operation: 'chat',
    vendor: 'openai',
    driver: 'openai-chat',
    sort_order: 60,
    route_template: {
      providerType: 'onelink',
      operation: 'chat',
      vendor: 'openai',
      driver: 'openai-chat',
      classification: 'chat',
      submitPath: '/v1/chat/completions',
      sourceKind: 'protocol-reference',
      source: 'OneLink Chat Completions 接入规范',
      sourceVersion: '2026-11',
      enabled: true,
      capabilityMetadata: {
        maxOutputTokens: 4096,
        inputModalities: ['text'],
      },
    },
    ui_hints: {
      recommendedSizes: [],
      recommendedAspectRatios: [],
      recommendedOutputFormats: [],
    },
  },
  {
    template_key: 'anthropic-messages',
    label: 'Anthropic Messages 对话模板',
    description: '适用于 /v1/messages 原生对话协议，默认支持图文多模态输入',
    operation: 'chat',
    vendor: 'anthropic',
    driver: 'anthropic-messages',
    sort_order: 70,
    route_template: {
      providerType: 'onelink',
      operation: 'chat',
      vendor: 'anthropic',
      driver: 'anthropic-messages',
      classification: 'chat',
      submitPath: '/v1/messages',
      sourceKind: 'protocol-reference',
      source: 'OneLink Anthropic Messages 接入规范',
      sourceVersion: '2026-11',
      enabled: true,
      capabilityMetadata: {
        maxOutputTokens: 4096,
        inputModalities: ['text', 'image'],
      },
    },
    ui_hints: {
      recommendedSizes: [],
      recommendedAspectRatios: [],
      recommendedOutputFormats: [],
    },
  },
]).replaceAll("'", "''");

/** Explicit migration only. Startup runs checkAdminSchema when MIO_ADMIN_ENABLED=true. */
export const adminSchemaSQL = `
CREATE TABLE IF NOT EXISTS mio_admin_accounts (
  id uuid PRIMARY KEY,
  username text COLLATE "C" NOT NULL UNIQUE
    CHECK (username ~ '^[A-Za-z0-9_.-]{3,64}$'),
  password_hash text NOT NULL
    CHECK (char_length(password_hash) BETWEEN 16 AND 1024),
  is_super_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mio_admin_sessions (
  id uuid PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES mio_admin_accounts(id) ON DELETE CASCADE,
  token_digest text NOT NULL UNIQUE
    CHECK (char_length(token_digest) = 64),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mio_admin_sessions_admin_idx ON mio_admin_sessions(admin_id);
CREATE INDEX IF NOT EXISTS mio_admin_sessions_expires_idx ON mio_admin_sessions(expires_at);
CREATE TABLE IF NOT EXISTS mio_admin_probe_configs (
  provider_type text PRIMARY KEY DEFAULT 'onelink'
    CHECK (provider_type = 'onelink'),
  masked_hint text,
  key_version integer
    CHECK (key_version IS NULL OR key_version >= 1),
  cipher_format smallint
    CHECK (cipher_format IS NULL OR cipher_format = 1),
  master_key_id text,
  nonce bytea
    CHECK (nonce IS NULL OR octet_length(nonce) = 12),
  ciphertext bytea,
  auth_tag bytea
    CHECK (auth_tag IS NULL OR octet_length(auth_tag) = 16),
  last_probed_at timestamptz,
  last_probe_status text
    CHECK (last_probe_status IS NULL OR last_probe_status IN ('connected', 'failed')),
  last_probe_count integer
    CHECK (last_probe_count IS NULL OR last_probe_count >= 0),
  last_probe_error text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (cipher_format IS NULL AND master_key_id IS NULL AND nonce IS NULL AND ciphertext IS NULL AND auth_tag IS NULL)
    OR (cipher_format = 1 AND master_key_id IS NOT NULL AND nonce IS NOT NULL AND ciphertext IS NOT NULL AND auth_tag IS NOT NULL AND key_version IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS mio_admin_catalog_models (
  provider_type text NOT NULL DEFAULT 'onelink'
    CHECK (provider_type = 'onelink'),
  raw_model_id text COLLATE "C" NOT NULL
    CHECK (octet_length(raw_model_id) BETWEEN 1 AND 256 AND raw_model_id !~ '[[:cntrl:]]'),
  supplier_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(supplier_metadata) = 'object'),
  in_latest_probe boolean NOT NULL DEFAULT true,
  probe_seq integer NOT NULL DEFAULT 1
    CHECK (probe_seq >= 1),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_type, raw_model_id)
);
CREATE TABLE IF NOT EXISTS mio_admin_ignored_models (
  provider_type text NOT NULL DEFAULT 'onelink'
    CHECK (provider_type = 'onelink'),
  raw_model_id text COLLATE "C" NOT NULL
    CHECK (octet_length(raw_model_id) BETWEEN 1 AND 256 AND raw_model_id !~ '[[:cntrl:]]'),
  reason text
    CHECK (reason IS NULL OR char_length(reason) <= 500),
  ignored_by text,
  ignored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_type, raw_model_id)
);
CREATE TABLE IF NOT EXISTS mio_admin_seed_history (
  seed_key text PRIMARY KEY
    CHECK (char_length(seed_key) BETWEEN 1 AND 128),
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mio_admin_route_templates (
  id uuid PRIMARY KEY,
  template_key text COLLATE "C" NOT NULL UNIQUE
    CHECK (template_key ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  label text NOT NULL
    CHECK (char_length(btrim(label)) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT ''
    CHECK (char_length(description) <= 500),
  operation text NOT NULL
    CHECK (${providerOperationCheck}),
  vendor text NOT NULL
    CHECK (char_length(vendor) BETWEEN 1 AND 64 AND vendor ~ '^[a-z0-9-]+$'),
  driver text NOT NULL
    CHECK (char_length(driver) BETWEEN 1 AND 64 AND driver ~ '^[a-z0-9-]+$'),
  route_template jsonb NOT NULL
    CHECK (jsonb_typeof(route_template) = 'object'),
  ui_hints jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(ui_hints) = 'object'),
  sort_order integer NOT NULL DEFAULT 100,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mio_admin_route_templates
  DROP CONSTRAINT IF EXISTS mio_admin_route_templates_operation_v1_check;
${upgradeProviderOperationSQL('mio_admin_route_templates')}
CREATE TABLE IF NOT EXISTS mio_admin_audit_logs (
  id uuid PRIMARY KEY,
  actor_id text,
  actor_name text NOT NULL
    CHECK (char_length(btrim(actor_name)) BETWEEN 1 AND 128),
  action text NOT NULL
    CHECK (char_length(btrim(action)) BETWEEN 1 AND 64),
  target_id text,
  summary text
    CHECK (summary IS NULL OR char_length(summary) <= 500),
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mio_admin_audit_logs_target_created_idx
  ON mio_admin_audit_logs(target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mio_admin_audit_logs_created_idx
  ON mio_admin_audit_logs (created_at DESC);
CREATE TABLE IF NOT EXISTS mio_admin_global_settings (
  setting_key text PRIMARY KEY
    CHECK (setting_key = 'auth'),
  value jsonb NOT NULL
    CHECK (jsonb_typeof(value) = 'object'),
  revision integer NOT NULL DEFAULT 1
    CHECK (revision >= 1),
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mio_admin_onelink_sso_config (
  environment text PRIMARY KEY
    CHECK (environment ~ '^[A-Za-z0-9_.-]{1,32}$'),
  enabled boolean NOT NULL DEFAULT false,
  client_name text NOT NULL DEFAULT 'miioo'
    CHECK (char_length(client_name) BETWEEN 1 AND 50 AND client_name !~ '[[:space:][:cntrl:]]' AND client_name <> 'routerClientId'),
  client_id text NULL
    CHECK (client_id IS NULL OR (char_length(client_id) BETWEEN 1 AND 128 AND client_id !~ '[[:space:][:cntrl:]]' AND client_id <> 'routerClientId')),
  expected_client_id text NULL
    CHECK (expected_client_id IS NULL OR (char_length(expected_client_id) BETWEEN 1 AND 128 AND expected_client_id !~ '[[:space:][:cntrl:]]' AND expected_client_id <> 'routerClientId')),
  registration_status text NOT NULL DEFAULT 'unregistered'
    CHECK (registration_status IN ('unregistered', 'registered', 'trusted_existing')),
  registration_source text NULL
    CHECK (registration_source IS NULL OR registration_source IN ('register_200', 'register_362_trusted')),
  last_register_code integer NULL,
  last_register_trace_id text NULL
    CHECK (last_register_trace_id IS NULL OR char_length(last_register_trace_id) <= 128),
  last_register_message text NULL
    CHECK (last_register_message IS NULL OR char_length(last_register_message) <= 256),
  last_registered_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1
    CHECK (revision >= 1),
  updated_by text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mio_admin_seed_history WHERE seed_key = 'route_templates_v1') THEN
    INSERT INTO mio_admin_route_templates (
      id, template_key, label, description, operation, vendor, driver, route_template, ui_hints, sort_order, updated_by
    )
    SELECT
      gen_random_uuid(),
      t.template_key,
      t.label,
      t.description,
      t.operation,
      t.vendor,
      t.driver,
      t.route_template,
      t.ui_hints,
      t.sort_order,
      'system-seed'
    FROM jsonb_to_recordset('${initialRouteTemplatesSeedJson}'::jsonb) AS t(
      template_key text,
      label text,
      description text,
      operation text,
      vendor text,
      driver text,
      sort_order integer,
      route_template jsonb,
      ui_hints jsonb
    )
    ON CONFLICT (template_key) DO NOTHING;
    INSERT INTO mio_admin_seed_history (seed_key) VALUES ('route_templates_v1');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mio_admin_seed_history WHERE seed_key = 'catalog_backfill_v1') THEN
    IF to_regclass('mio_provider_catalog_models') IS NOT NULL THEN
      INSERT INTO mio_provider_catalog_models (
        provider_type, raw_model_id, supplier_metadata, origin_source, created_at, updated_at
      )
      SELECT
        provider_type, raw_model_id, supplier_metadata, 'onelink-import', first_seen_at, last_seen_at
      FROM mio_admin_catalog_models
      ON CONFLICT (provider_type, raw_model_id) DO NOTHING;
    END IF;
    INSERT INTO mio_admin_seed_history (seed_key) VALUES ('catalog_backfill_v1');
  END IF;
END $$;
`;

export async function checkAdminSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  await checkProviderOperations(pool, ['mio_admin_route_templates']);
  for (const [sql, types] of [
    [
      'SELECT id,username,password_hash,is_super_admin,created_at,updated_at FROM mio_admin_accounts LIMIT 0',
      [2950, 25, 25, 16, 1184, 1184],
    ],
    [
      'SELECT id,admin_id,token_digest,expires_at,created_at FROM mio_admin_sessions LIMIT 0',
      [2950, 2950, 25, 1184, 1184],
    ],
    [
      'SELECT provider_type,masked_hint,key_version,cipher_format,master_key_id,nonce,ciphertext,auth_tag,last_probed_at,last_probe_status,last_probe_count,last_probe_error,updated_by,updated_at FROM mio_admin_probe_configs LIMIT 0',
      [25, 25, 23, 21, 25, 17, 17, 17, 1184, 25, 23, 25, 25, 1184],
    ],
    [
      'SELECT provider_type,raw_model_id,supplier_metadata,in_latest_probe,probe_seq,first_seen_at,last_seen_at FROM mio_admin_catalog_models LIMIT 0',
      [25, 25, 3802, 16, 23, 1184, 1184],
    ],
    [
      'SELECT provider_type,raw_model_id,reason,ignored_by,ignored_at FROM mio_admin_ignored_models LIMIT 0',
      [25, 25, 25, 25, 1184],
    ],
    ['SELECT seed_key,applied_at FROM mio_admin_seed_history LIMIT 0', [25, 1184]],
    [
      'SELECT id,template_key,label,description,operation,vendor,driver,route_template,ui_hints,sort_order,updated_by,created_at,updated_at FROM mio_admin_route_templates LIMIT 0',
      [2950, 25, 25, 25, 25, 25, 25, 3802, 3802, 23, 25, 1184, 1184],
    ],
    [
      'SELECT id,actor_id,actor_name,action,target_id,summary,before_state,after_state,created_at FROM mio_admin_audit_logs LIMIT 0',
      [2950, 25, 25, 25, 25, 25, 3802, 3802, 1184],
    ],
    [
      'SELECT setting_key,value,revision,updated_by,created_at,updated_at FROM mio_admin_global_settings LIMIT 0',
      [25, 3802, 23, 25, 1184, 1184],
    ],
    [
      'SELECT environment,enabled,client_name,client_id,expected_client_id,registration_status,registration_source,last_register_code,last_register_trace_id,last_register_message,last_registered_at,revision,updated_by,created_at,updated_at FROM mio_admin_onelink_sso_config LIMIT 0',
      [25, 16, 25, 25, 25, 25, 25, 23, 25, 25, 1184, 23, 25, 1184, 1184],
    ],
  ] as const) {
    const result = await pool.query(sql);
    if (result.fields.some((field, index) => field.dataTypeID !== types[index]))
      throw new Error('ADMIN_SCHEMA: incompatible columns');
  }
}
