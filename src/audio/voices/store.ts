import { HTTP_STATUS } from '@mio/foundation/http-status';
import { VoiceError } from './contracts.ts';
import { AUDIO_ROUTES } from '../../providers/onelink/audio.ts';
import { VOICE_DRIVER, VOICE_OPERATION, VOICE_PATH } from '../../providers/onelink/voices.ts';
import type { AudioAdmission } from '../contracts.ts';
import type { VoiceFilters, VoiceRow } from './contracts.ts';

/** Narrow access to the existing provider-owned pool/transaction, without a second pool or pg adapter. */
export type VoiceQuery = <Row extends object>(
  sql: string,
  values?: unknown[],
) => Promise<{ rows: Row[] }>;
export interface VoiceCatalogState {
  status: 'running' | 'connected' | 'failed' | 'empty';
  errorCode: string | null;
  succeededAt: string | null;
  current: boolean;
  stale: boolean;
}
const currentProvider = `c.enabled AND c.credential_auth_state<>'rejected'
  AND c.catalog_credential_version=c.credential_version`;

function currentModelRoute(whitelist: boolean) {
  return `m.membership_state='current'
    AND m.catalog_version=c.catalog_version AND m.credential_version=c.credential_version
    AND m.unavailable_reason IS NULL AND r.enabled AND r.vendor='minimax'
    AND r.classification='voice' AND r.edit_path IS NULL AND r.query_path_template IS NULL
    AND r.request_defaults='{}'::jsonb AND r.output_spec='{}'::jsonb AND r.capability_metadata='{}'::jsonb
    AND COALESCE(cat.user_visible,${!whitelist})
    AND NOT EXISTS(SELECT 1 FROM mio_provider_model_preferences p WHERE p.provider_id=c.id
      AND p.model_key=m.model_key AND p.usage='voice' AND NOT p.enabled)`;
}

const routeJoin = `JOIN mio_provider_model_routes r
  ON r.raw_model_id=m.raw_model_id COLLATE "C" AND r.provider_type=c.provider_type
  LEFT JOIN mio_provider_catalog_models cat
  ON cat.provider_type=c.provider_type AND cat.raw_model_id=m.raw_model_id COLLATE "C"`;

/** Both readers bind owner at $1; owned builds any exact predicate from its local bind slots. */
function routeReadiness(whitelist: boolean, exact = '') {
  return `WITH owned_provider AS MATERIALIZED (
    SELECT id,owner_id,provider_type,enabled,credential_auth_state,catalog_credential_version,
      credential_version,catalog_version FROM mio_provider_configs WHERE owner_id=$1
  ), tts_models AS MATERIALIZED (
    SELECT m.provider_id,m.model_key FROM owned_provider c
    JOIN mio_provider_models m ON m.provider_id=c.id ${routeJoin}
    WHERE ${currentModelRoute(whitelist)} ${exact}
      AND r.operation='${AUDIO_ROUTES.tts.operation}' AND r.driver='${AUDIO_ROUTES.tts.driver}'
      AND r.submit_path='${AUDIO_ROUTES.tts.path}'
  ), dynamic_catalog_ready AS MATERIALIZED (
    SELECT s.provider_id,s.succeeded_seq FROM owned_provider c
    JOIN mio_provider_voice_catalogs s ON s.provider_id=c.id
    WHERE s.credential_version=c.credential_version AND s.catalog_version=c.catalog_version
      AND EXISTS(SELECT 1 FROM mio_provider_models m ${routeJoin}
        WHERE m.provider_id=c.id AND ${currentModelRoute(whitelist)}
          AND m.model_key=s.model_key AND m.raw_model_id=s.raw_model_id
          AND r.declaration_version=s.declaration_version
          AND r.operation='${VOICE_OPERATION}' AND r.driver='${VOICE_DRIVER}'
          AND r.submit_path='${VOICE_PATH}' AND r.param_spec='{}'::jsonb)
  )`;
}

function voiceColumns() {
  const tts = `(${currentProvider} AND EXISTS(SELECT 1 FROM tts_models m
    WHERE m.provider_id=c.id
      AND (v.registration_model_key IS NULL OR m.model_key=v.registration_model_key)))`;
  return `v.id,v.upstream_id,v.source,v.name,v.descriptions,v.favorite,v.preview_asset_id,v.registration_model_key,
    ${tts} AS generation_available,
    COALESCE(v.present AND ${currentProvider} AND (CASE WHEN v.source='system' THEN ${tts}
      ELSE EXISTS(SELECT 1 FROM mio_audio_jobs cj WHERE cj.id=v.local_clone_job_id
        AND cj.kind='clone' AND cj.owner_id=c.owner_id AND cj.upstream_voice_id=v.upstream_id
        AND cj.admission->>'providerConfigId'=c.id::text
        AND cj.admission->>'credentialVersion'=c.credential_version::text)
        OR EXISTS(SELECT 1 FROM dynamic_catalog_ready s
          WHERE s.provider_id=c.id AND v.seen_seq=s.succeeded_seq) END),false) AS available,
    to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
    to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time`;
}

export function createVoiceStore(query: VoiceQuery, whitelist = false) {
  const columns = voiceColumns();
  const readiness = routeReadiness(whitelist);
  return {
    async localCount(owner: string) {
      const row = (
        await query<{ count: number }>(
          `SELECT count(v.id)::integer AS count FROM mio_provider_configs c
           LEFT JOIN mio_provider_voices v ON v.provider_id=c.id AND v.present
           WHERE c.owner_id=$1`,
          [owner],
        )
      ).rows[0];
      return row?.count ?? 0;
    },
    async list(owner: string, filters: VoiceFilters) {
      const { search, source, favorite, limit, before } = filters;
      const escaped = search.replace(/[\\%_]/g, '\\$&');
      // Page and freshness come from one MVCC statement; no window of cross-credential readiness.
      const row = (
        await query<{ catalog: VoiceCatalogState; items: VoiceRow[]; total: number }>(
          `${readiness}
         SELECT jsonb_build_object('status',CASE WHEN tally.catalog_total>0 THEN 'connected' ELSE 'empty' END,
          'errorCode',NULL,'succeededAt',tally.updated_at,'current',tally.catalog_total>0,
          'stale',false) AS catalog,
          COALESCE(page.items,'[]'::jsonb) AS items
          ,tally.total
         FROM owned_provider c
         LEFT JOIN LATERAL (SELECT count(*)::integer AS catalog_total,max(v.updated_at) AS updated_at,
           count(*) FILTER (WHERE ($2::text='' OR v.name ILIKE '%'||$2||'%' OR v.upstream_id ILIKE '%'||$2||'%'
               OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(v.descriptions) d WHERE d ILIKE '%'||$2||'%'))
             AND ($3::text IS NULL OR v.source=$3) AND ($4::boolean IS NULL OR v.favorite=$4))::integer AS total
           FROM mio_provider_voices v WHERE v.provider_id=c.id AND v.present) tally ON true
         LEFT JOIN LATERAL (SELECT jsonb_agg(item ORDER BY item.created_at DESC,item.id DESC) AS items
           FROM (SELECT ${columns} FROM mio_provider_voices v WHERE v.provider_id=c.id
             AND v.present
             AND ($2::text='' OR v.name ILIKE '%'||$2||'%' OR v.upstream_id ILIKE '%'||$2||'%'
               OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(v.descriptions) d WHERE d ILIKE '%'||$2||'%'))
             AND ($3::text IS NULL OR v.source=$3) AND ($4::boolean IS NULL OR v.favorite=$4)
             AND ($5::timestamptz IS NULL OR (v.created_at,v.id)<($5::timestamptz,$6::uuid))
             ORDER BY v.created_at DESC,v.id DESC LIMIT $7) item) page ON true WHERE c.owner_id=$1`,
          [owner, escaped, source, favorite, before?.time ?? null, before?.id ?? null, limit + 1],
        )
      ).rows[0];
      return (
        row ?? {
          catalog: {
            status: 'empty' as const,
            errorCode: null,
            succeededAt: null,
            current: false,
            stale: false,
          },
          items: [],
          total: 0,
        }
      );
    },
    async owned(owner: string, id: string, admission?: AudioAdmission) {
      const values: unknown[] = [owner, id];
      const bind = (value: unknown) => `$${values.push(value)}`;
      const exact = admission
        ? `AND m.model_key=${bind(admission.modelKey)}::uuid
           AND r.declaration_version=${bind(admission.adaptationVersion)}::integer`
        : '';
      const provider = admission
        ? `AND c.id=${bind(admission.providerConfigId)}::uuid
           AND c.credential_version=${bind(admission.credentialVersion)}::integer
           AND c.catalog_version=${bind(admission.catalogVersion)}::integer`
        : '';
      const row = (
        await query<VoiceRow>(
          `${routeReadiness(whitelist, exact)}
         SELECT ${columns}
         FROM mio_provider_voices v JOIN owned_provider c ON c.id=v.provider_id
         WHERE c.owner_id=$1 AND v.id=$2 ${provider}`,
          values,
        )
      ).rows[0];
      if (!row || (admission && (!row.available || !row.generation_available)))
        throw new VoiceError(HTTP_STATUS.NOT_FOUND, 'VOICE_NOT_FOUND');
      return row;
    },
    async favorite(owner: string, id: string, favorite: boolean) {
      const row = (
        await query<{ id: string }>(
          `UPDATE mio_provider_voices v SET favorite=$3,updated_at=now() FROM mio_provider_configs c
         WHERE v.provider_id=c.id AND c.owner_id=$1 AND v.id=$2 RETURNING v.id`,
          [owner, id, favorite],
        )
      ).rows[0];
      if (!row) throw new VoiceError(HTTP_STATUS.NOT_FOUND, 'VOICE_NOT_FOUND');
    },
  };
}
export type VoiceStore = ReturnType<typeof createVoiceStore>;
