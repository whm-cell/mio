import type { CredentialEnvelope } from './credentials.ts';
import type {
  Discovery,
  ProviderView,
  ModelRecord,
  ModelPreference,
  AdaptationRecord,
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
  adaptations: AdaptationRecord[];
}
export const providerStateSQL = `SELECT c.*,
  COALESCE((SELECT jsonb_agg(m ORDER BY m.raw_model_id COLLATE "C",m.model_key)
    FROM mio_provider_models m WHERE m.provider_id=c.id),'[]') AS models,
  COALESCE((SELECT jsonb_agg(p) FROM mio_provider_model_preferences p WHERE p.provider_id=c.id),'[]') AS preferences,
  COALESCE((SELECT jsonb_agg(a) FROM mio_provider_model_adaptations a WHERE a.provider_id=c.id),'[]') AS adaptations
  FROM mio_provider_configs c WHERE c.owner_id=$1`;

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
