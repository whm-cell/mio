import type { CredentialEnvelope } from './credentials.ts';
import type {
  Discovery,
  ProviderView,
  ModelRecord,
  ModelPreference,
  PlatformCatalogModelRecord,
  PlatformRouteRecord,
  VerificationRecord,
} from './contracts.ts';

export interface ProviderRow extends CredentialEnvelope {
  id: string;
  owner_id: string;
  enabled: boolean;
  default_image_watermark: boolean;
  default_video_watermark: boolean;
  revision: number;
  credential_version: number;
  discovery: Discovery | null;
  catalog_version: number | null;
  catalog_credential_version: number | null;
  catalog_succeeded_at: Date | null;
  latest_refresh_seq: number;
  last_attempt_seq: number | null;
  last_attempt_credential_version: number | null;
  last_attempt_started_at: Date | null;
  last_attempt_finished_at: Date | null;
  last_attempt_status: 'running' | 'connected' | 'failed' | null;
  last_attempt_error_code: string | null;
  credential_auth_state: 'unchecked' | 'valid' | 'rejected';
}
export interface ProviderState extends ProviderRow {
  models: ModelRecord[];
  preferences: ModelPreference[];
  routes?: PlatformRouteRecord[];
  catalog_models?: PlatformCatalogModelRecord[];
  verifications?: VerificationRecord[];
}
export const providerStateSQL = (includeVerifications = true) => `SELECT c.*,
  COALESCE((SELECT jsonb_agg(m ORDER BY m.raw_model_id COLLATE "C",m.model_key)
    FROM mio_provider_models m WHERE m.provider_id=c.id),'[]') AS models,
  COALESCE((SELECT jsonb_agg(p) FROM mio_provider_model_preferences p WHERE p.provider_id=c.id),'[]') AS preferences,
  COALESCE((SELECT jsonb_agg(r ORDER BY r.raw_model_id COLLATE "C",r.operation)
    FROM mio_provider_model_routes r
    WHERE r.provider_type=c.provider_type
      AND EXISTS (
        SELECT 1 FROM mio_provider_models m
        WHERE m.provider_id=c.id AND m.raw_model_id=r.raw_model_id COLLATE "C"
      )),'[]') AS routes,
  COALESCE((SELECT jsonb_agg(cat ORDER BY cat.raw_model_id COLLATE "C")
    FROM mio_provider_catalog_models cat
    WHERE cat.provider_type=c.provider_type
      AND EXISTS (
        SELECT 1 FROM mio_provider_models m
        WHERE m.provider_id=c.id AND m.raw_model_id=cat.raw_model_id COLLATE "C"
      )),'[]') AS catalog_models${
        includeVerifications
          ? `,
  COALESCE((SELECT jsonb_agg(v) FROM mio_provider_model_verifications v WHERE v.provider_id=c.id),'[]') AS verifications`
          : ''
      }
  FROM mio_provider_configs c WHERE c.owner_id=$1`;

/** Private runtime projection: discovery.ids is public, unbounded history and is not used by admission. */
export const providerModelStateSQL = `WITH config AS MATERIALIZED (
  SELECT id,owner_id,provider_type,enabled,default_image_watermark,default_video_watermark,
    revision,credential_version,cipher_format,master_key_id,nonce,ciphertext,auth_tag,
    catalog_version,catalog_credential_version,catalog_succeeded_at,latest_refresh_seq,
    last_attempt_seq,last_attempt_credential_version,last_attempt_started_at,last_attempt_finished_at,
    last_attempt_status,last_attempt_error_code,credential_auth_state,NULL::jsonb AS discovery
  FROM mio_provider_configs WHERE owner_id=$1
), target AS MATERIALIZED (
  SELECT m.* FROM mio_provider_models m WHERE m.provider_id=(SELECT id FROM config)
    AND (m.model_key=$2::uuid OR m.raw_model_id=$3 COLLATE "C" OR m.legacy_ref=$4)
  ORDER BY m.raw_model_id COLLATE "C",m.model_key LIMIT 1
)
SELECT c.*,
  COALESCE((SELECT jsonb_agg(m) FROM target m),'[]') AS models,
  COALESCE((SELECT jsonb_agg(p) FROM mio_provider_model_preferences p
    WHERE p.provider_id=c.id AND p.model_key=(SELECT model_key FROM target)),'[]') AS preferences,
  COALESCE((SELECT jsonb_agg(r ORDER BY r.raw_model_id COLLATE "C",r.operation)
    FROM mio_provider_model_routes r WHERE r.provider_type=c.provider_type
      AND r.raw_model_id=(SELECT raw_model_id FROM target) COLLATE "C"),'[]') AS routes,
  COALESCE((SELECT jsonb_agg(cat ORDER BY cat.raw_model_id COLLATE "C")
    FROM mio_provider_catalog_models cat WHERE cat.provider_type=c.provider_type
      AND cat.raw_model_id=(SELECT raw_model_id FROM target) COLLATE "C"),'[]') AS catalog_models
FROM config c`;

export function providerView(row: ProviderRow): ProviderView {
  const current =
    row.catalog_version !== null && row.catalog_credential_version === row.credential_version;
  return {
    id: row.id,
    type: 'onelink',
    enabled: row.enabled,
    hasKey: true,
    masked: '********',
    credentialVersion: row.credential_version,
    revision: row.revision,
    defaultImageWatermark: row.default_image_watermark,
    defaultVideoWatermark: row.default_video_watermark,
    discovery: row.last_attempt_seq === null ? null : row.discovery,
    catalog: {
      version: row.catalog_version,
      credentialVersion: row.catalog_credential_version,
      succeededAt: row.catalog_succeeded_at?.toISOString() ?? null,
      current,
      stale: current && row.last_attempt_status === 'failed',
    },
    credentialAuthState: row.credential_auth_state,
    lastAttempt:
      row.last_attempt_seq === null
        ? null
        : {
            seq: row.last_attempt_seq,
            credentialVersion: row.last_attempt_credential_version!,
            startedAt: row.last_attempt_started_at!.toISOString(),
            finishedAt: row.last_attempt_finished_at?.toISOString() ?? null,
            status: row.last_attempt_status!,
            error: row.last_attempt_error_code,
          },
  };
}
