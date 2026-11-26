import { AudioError } from '../audio/contracts.ts';
import { createAudioStore } from '../audio/jobs/store.ts';
import { VoiceError } from '../audio/voices/contracts.ts';
import { createVoiceStore } from '../audio/voices/store.ts';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { createId } from '@mio/foundation/identifiers';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { ProviderError } from './contracts.ts';
import type {
  Discovery,
  ProviderView,
  Category,
  PlatformRouteRecord,
  ProviderOperation,
  RouteRevisionAction,
  RouteRevisionActor,
  VerificationSnapshot,
} from './contracts.ts';
import type { ProviderConfig } from './config.ts';
import type { DiscoveredModel } from '../integrations/onelink/models.ts';
import { encryptCredential } from './credentials.ts';
import { checkProviderSchema } from './schema.ts';
import { providerModelStateSQL, providerStateSQL, providerView } from './state.ts';
import type { ProviderRow, ProviderState } from './state.ts';
import {
  findCatalogModel,
  findModel,
  legacyReference,
  membershipError,
  modelReference,
  resolveEffectiveChat,
  resolveEffectiveImage,
  resolveEffectiveVideo,
} from './catalog.ts';
import {
  canonicalRouteComparable,
  serializeRouteInputSnapshot,
  validateRouteImportPayload,
} from './onelink/router.ts';
import { videoRouteRuntimeAvailable } from './onelink/video-route.ts';
import { resolveProviderAudioRoute, selectAudioModel } from './audio-admission.ts';

const log = createLogger('app', 'provider-store');

function modelStateParameters(owner: string, ref: string) {
  const legacy = legacyReference(ref);
  const key =
    !legacy &&
    /^onelink:model:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref)
      ? ref.slice('onelink:model:'.length)
      : null;
  return [owner, key, legacy?.id ?? null, legacy ? null : ref];
}

export interface SettingsPatch {
  enabled?: boolean;
  defaultImageWatermark?: boolean;
  defaultVideoWatermark?: boolean;
}
export interface ModelPatch {
  enabled?: boolean;
  isDefault?: boolean;
  usage?: Category;
  name?: string | null;
  description?: string | null;
}
export interface RouteRevisionResult {
  id: string;
  rawModelId: string;
  operation: ProviderOperation;
  declarationVersion: number;
  action: RouteRevisionAction;
}

export interface RouteImportSummary {
  total: number;
  inserted: number;
  updated: number;
  unchanged: number;
  revisions: RouteRevisionResult[];
}
/** Owner changes and verification lock configuration; platform routes lock catalog keys. */
export class ProviderStore {
  readonly voices: ReturnType<typeof createVoiceStore>;
  readonly audio: ReturnType<typeof createAudioStore>;
  private readonly pool: Pool;
  private readonly config: ProviderConfig;
  private closing: Promise<void> | undefined;
  constructor(pool: Pool, config: ProviderConfig) {
    this.pool = pool;
    this.config = config;
    const query = <Row extends object>(sql: string, values?: unknown[]) =>
      pool.query<Row>(sql, values);
    this.voices = createVoiceStore(query, Boolean(config.catalogWhitelist));
    this.audio = createAudioStore(
      query,
      (action) =>
        this.transaction((client) =>
          action(<Row extends object>(sql: string, values?: unknown[]) =>
            client.query<Row>(sql, values),
          ),
        ),
      Boolean(config.catalogWhitelist),
    );
  }

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    const disconnected = () => {
      discard = true;
    };
    // The pool handles errors only while this client is idle.
    client.on('error', disconnected);
    try {
      await client.query('BEGIN');
      const value = await action(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      if (!discard) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discard = true;
        }
      }
      throw error instanceof ProviderError ||
        error instanceof VoiceError ||
        error instanceof AudioError
        ? error
        : new ProviderError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'PROVIDER_UNAVAILABLE');
    } finally {
      client.removeListener('error', disconnected);
      client.release(discard);
    }
  }
  private async locked(client: PoolClient, owner: string, expected?: number): Promise<ProviderRow> {
    const row = (
      await client.query<ProviderRow>(
        'SELECT * FROM mio_provider_configs WHERE owner_id=$1 FOR UPDATE',
        [owner],
      )
    ).rows[0];
    if (!row) throw new ProviderError(HTTP_STATUS.NOT_FOUND, 'PROVIDER_NOT_CONFIGURED');
    if (expected !== undefined && row.revision !== expected)
      throw new ProviderError(HTTP_STATUS.CONFLICT, 'PROVIDER_REVISION_CONFLICT');
    return row;
  }
  async current(owner: string): Promise<ProviderRow | null> {
    return (
      (
        await this.pool.query<ProviderRow>('SELECT * FROM mio_provider_configs WHERE owner_id=$1', [
          owner,
        ])
      ).rows[0] ?? null
    );
  }
  async get(owner: string): Promise<ProviderView | null> {
    const row = await this.current(owner);
    return row ? providerView(row) : null;
  }
  /** One MVCC statement; runtime consumers omit only catalog verification observations. */
  async state(owner: string, includeVerifications = true): Promise<ProviderState | null> {
    return (
      (await this.pool.query<ProviderState>(providerStateSQL(includeVerifications), [owner]))
        .rows[0] ?? null
    );
  }
  /** One MVCC statement for an exact model; public state and default selection keep full discovery. */
  async modelState(owner: string, modelRef: string): Promise<ProviderState | null> {
    return (
      (
        await this.pool.query<ProviderState>(
          providerModelStateSQL,
          modelStateParameters(owner, modelRef),
        )
      ).rows[0] ?? null
    );
  }
  async save(owner: string, expected: number, apiKey: string): Promise<ProviderView> {
    return this.transaction(async (client) => {
      const old = (
        await client.query<ProviderRow>(
          'SELECT * FROM mio_provider_configs WHERE owner_id=$1 FOR UPDATE',
          [owner],
        )
      ).rows[0];
      if ((old?.revision ?? 0) !== expected)
        throw new ProviderError(HTTP_STATUS.CONFLICT, 'PROVIDER_REVISION_CONFLICT');
      const id = old?.id ?? createId();
      const version = (old?.credential_version ?? 0) + 1;
      const envelope = encryptCredential(
        apiKey,
        { ownerId: owner, providerId: id, credentialVersion: version },
        this.config,
      );
      const args = [
        id,
        owner,
        version,
        envelope.master_key_id,
        envelope.nonce,
        envelope.ciphertext,
        envelope.auth_tag,
      ];
      const result = old
        ? await client.query<ProviderRow>(
            `UPDATE mio_provider_configs SET credential_version=$3,master_key_id=$4,nonce=$5,ciphertext=$6,auth_tag=$7,
          discovery=NULL,credential_auth_state='unchecked',revision=revision+1,updated_at=now(),
          last_attempt_seq=NULL,last_attempt_credential_version=NULL,last_attempt_started_at=NULL,
          last_attempt_finished_at=NULL,last_attempt_status=NULL,last_attempt_error_code=NULL
          WHERE id=$1 AND owner_id=$2 RETURNING *`,
            args,
          )
        : await client.query<ProviderRow>(
            `INSERT INTO mio_provider_configs(id,owner_id,revision,credential_version,cipher_format,master_key_id,nonce,ciphertext,auth_tag)
            VALUES($1,$2,1,$3,1,$4,$5,$6,$7) ON CONFLICT(owner_id) DO NOTHING RETURNING *`,
            args,
          );
      if (!result.rows[0])
        throw new ProviderError(HTTP_STATUS.CONFLICT, 'PROVIDER_REVISION_CONFLICT');
      if (old) {
        await client.query(
          "UPDATE mio_provider_models SET membership_state='historical' WHERE provider_id=$1",
          [id],
        );
        await client.query(
          "UPDATE mio_provider_model_verifications SET verification_status='unverified' WHERE provider_id=$1",
          [id],
        );
      }
      return providerView(result.rows[0]);
    });
  }
  async settings(owner: string, expected: number, patch: SettingsPatch): Promise<ProviderView> {
    return this.transaction(async (client) => {
      const row = await this.locked(client, owner, expected);
      const updated = (
        await client.query<ProviderRow>(
          `UPDATE mio_provider_configs SET enabled=$2,default_image_watermark=$3,default_video_watermark=$4,
          revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
          [
            row.id,
            patch.enabled ?? row.enabled,
            patch.defaultImageWatermark ?? row.default_image_watermark,
            patch.defaultVideoWatermark ?? row.default_video_watermark,
          ],
        )
      ).rows[0]!;
      if (
        updated.enabled &&
        updated.credential_auth_state !== 'rejected' &&
        updated.catalog_version !== null &&
        updated.catalog_credential_version === updated.credential_version
      ) {
        await client.query(
          `INSERT INTO mio_provider_models (
             provider_id, raw_model_id, supplier_metadata, metadata_source, membership_state
           )
           SELECT $1, cat.raw_model_id,
             jsonb_build_object('object', 'model', 'curated', true, 'description', COALESCE(cat.display_label, '')),
             'admin-curated-hidden', 'historical'
           FROM mio_provider_catalog_models cat
           WHERE cat.provider_type = 'onelink'
             AND cat.allow_undiscovered = true
             AND cat.user_visible = true
           ON CONFLICT (provider_id, raw_model_id) DO NOTHING`,
          [updated.id],
        );
      }
      return providerView(updated);
    });
  }
  async preference(
    owner: string,
    expected: number,
    modelRef: string,
    usage: Category | undefined,
    patch: ModelPatch,
  ): Promise<ProviderView> {
    const whitelist = Boolean(this.config.catalogWhitelist);
    return this.transaction(async (client) => {
      const row = await this.locked(client, owner, expected);
      const state = (
        await client.query<ProviderState>(
          providerModelStateSQL,
          modelStateParameters(owner, modelRef),
        )
      ).rows[0]!;
      const model = findModel(state.models, modelRef);
      if ('enabled' in patch || 'isDefault' in patch) {
        const reason = membershipError(state, model, whitelist);
        if (reason) throw new ProviderError(HTTP_STATUS.CONFLICT, reason);
        if (usage !== 'chat')
          throw new ProviderError(HTTP_STATUS.CONFLICT, 'MODEL_USAGE_UNSUPPORTED');
        if (!resolveEffectiveChat(state, model!))
          throw new ProviderError(HTTP_STATUS.CONFLICT, 'ADAPTER_PENDING');
        const old = state.preferences.find(
          (p) => p.model_key === model!.model_key && p.usage === usage,
        );
        const enabled = patch.enabled ?? old?.enabled ?? true;
        if (patch.isDefault && !enabled)
          throw new ProviderError(HTTP_STATUS.CONFLICT, 'MODEL_DISABLED');
        // Disable/remove/rotate preserves the default target, exposing its effective validity separately.
        const isDefault = patch.isDefault ?? old?.is_default ?? false;
        if (isDefault)
          await client.query(
            'UPDATE mio_provider_model_preferences SET is_default=false,updated_at=now() WHERE provider_id=$1 AND usage=$2 AND is_default',
            [row.id, usage],
          );
        await client.query(
          `INSERT INTO mio_provider_model_preferences(provider_id,model_key,usage,enabled,is_default)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider_id,model_key,usage)
            DO UPDATE SET enabled=$4,is_default=$5,updated_at=now()`,
          [row.id, model!.model_key, usage, enabled, isDefault],
        );
      }
      if (!model) throw new ProviderError(HTTP_STATUS.CONFLICT, 'MODEL_NOT_FOUND');
      const catalogModel = findCatalogModel(state.catalog_models, model.raw_model_id);
      if (whitelist) {
        if (!catalogModel || !catalogModel.user_visible)
          throw new ProviderError(HTTP_STATUS.CONFLICT, 'MODEL_HIDDEN');
      } else if (catalogModel && !catalogModel.user_visible) {
        throw new ProviderError(HTTP_STATUS.CONFLICT, 'MODEL_HIDDEN');
      }
      if ('name' in patch || 'description' in patch)
        await client.query(
          `UPDATE mio_provider_models SET display_name=CASE WHEN $3 THEN $4 ELSE display_name END,
            description_override=CASE WHEN $5 THEN $6 ELSE description_override END
            WHERE provider_id=$1 AND model_key=$2`,
          [
            row.id,
            model.model_key,
            'name' in patch,
            patch.name ?? null,
            'description' in patch,
            patch.description ?? null,
          ],
        );
      return providerView(
        (
          await client.query<ProviderRow>(
            'UPDATE mio_provider_configs SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',
            [row.id],
          )
        ).rows[0]!,
      );
    });
  }
  /** Controlled deployment or admin route import. Never creates user catalog members or sets verified. */
  async importRoutes(input: unknown, actor?: RouteRevisionActor): Promise<RouteImportSummary> {
    const entries = validateRouteImportPayload(input);
    const resolvedActor: RouteRevisionActor = actor ?? {
      actorType: 'cli',
      actorId: null,
      actorName: 'providers:route',
      summary: null,
      actionOverride: 'cli-import',
    };
    return this.transaction(async (client) => {
      const firstByModel = new Map<string, (typeof entries)[number]>();
      for (const entry of entries)
        if (!firstByModel.has(entry.rawModelId)) firstByModel.set(entry.rawModelId, entry);
      const catalogEntries = [...firstByModel.values()];
      await client.query(
        `INSERT INTO mio_provider_catalog_models (
        provider_type,raw_model_id,vendor_label,category,origin_source,updated_by
      ) SELECT 'onelink',i."rawModelId",i.vendor,i.classification,'route-import',$2
        FROM jsonb_to_recordset($1::jsonb) AS i("rawModelId" text,vendor text,classification text)
        ORDER BY i."rawModelId" COLLATE "C"
        ON CONFLICT(provider_type,raw_model_id) DO UPDATE SET raw_model_id=EXCLUDED.raw_model_id WHERE false`,
        [JSON.stringify(catalogEntries), resolvedActor.actorName],
      );
      const existingRows = (
        await client.query<PlatformRouteRecord>(
          `SELECT r.* FROM mio_provider_model_routes r
        JOIN jsonb_to_recordset($1::jsonb) AS i("rawModelId" text,operation text)
          ON r.provider_type='onelink' AND r.raw_model_id=i."rawModelId" COLLATE "C" AND r.operation=i.operation
        ORDER BY r.raw_model_id COLLATE "C",r.operation COLLATE "C" FOR UPDATE OF r`,
          [JSON.stringify(entries)],
        )
      ).rows;
      const existingByKey = new Map(
        existingRows.map((row) => [`${row.raw_model_id}\0${row.operation}`, row]),
      );
      let inserted = 0,
        updated = 0,
        unchanged = 0;
      const revisions: RouteRevisionResult[] = [];
      const writes: Record<string, unknown>[] = [];
      const history: Record<string, unknown>[] = [];
      for (const entry of entries) {
        const existing = existingByKey.get(`${entry.rawModelId}\0${entry.operation}`);
        if (existing && canonicalRouteComparable(existing) === canonicalRouteComparable(entry)) {
          unchanged += 1;
          continue;
        }
        const declarationVersion = (existing?.declaration_version ?? 0) + 1;
        const onlyEnabledToggled =
          existing &&
          existing.enabled !== entry.enabled &&
          canonicalRouteComparable({ ...existing, enabled: entry.enabled }) ===
            canonicalRouteComparable(entry);
        const action: RouteRevisionAction =
          resolvedActor.actionOverride ??
          (!existing
            ? 'create'
            : onlyEnabledToggled
              ? entry.enabled
                ? 'enable'
                : 'disable'
              : 'update');
        const revision = {
          id: createId(),
          rawModelId: entry.rawModelId,
          operation: entry.operation,
          declarationVersion,
          action,
        };
        revisions.push(revision);
        writes.push({
          ...entry,
          declarationVersion,
          isNew: !existing,
        });
        history.push({
          ...revision,
          before_route: existing ? serializeRouteInputSnapshot(existing) : null,
          after_route: serializeRouteInputSnapshot(entry),
        });
        if (existing) updated += 1;
        else inserted += 1;
      }
      if (writes.length) {
        await client.query(
          `WITH incoming AS MATERIALIZED (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(
            "providerType" text,"rawModelId" text,operation text,vendor text,driver text,classification text,
            "submitPath" text,"editPath" text,"queryPathTemplate" text,"paramSpec" jsonb,
            "requestDefaults" jsonb,"outputSpec" jsonb,"capabilityMetadata" jsonb,
            "sourceKind" text,source text,"sourceVersion" text,enabled boolean,"declarationVersion" integer,"isNew" boolean)
        ), inserted AS (
          INSERT INTO mio_provider_model_routes (
            provider_type,raw_model_id,operation,vendor,driver,classification,submit_path,edit_path,
            query_path_template,param_spec,request_defaults,output_spec,capability_metadata,
            source_kind,source,source_version,enabled,declaration_version
          ) SELECT "providerType","rawModelId",operation,vendor,driver,classification,"submitPath","editPath",
            "queryPathTemplate","paramSpec","requestDefaults","outputSpec","capabilityMetadata",
            "sourceKind",source,"sourceVersion",enabled,"declarationVersion" FROM incoming WHERE "isNew"
            ORDER BY "rawModelId" COLLATE "C",operation COLLATE "C" RETURNING raw_model_id
        ) UPDATE mio_provider_model_routes r SET vendor=i.vendor,driver=i.driver,classification=i.classification,
          submit_path=i."submitPath",edit_path=i."editPath",query_path_template=i."queryPathTemplate",
          param_spec=i."paramSpec",request_defaults=i."requestDefaults",output_spec=i."outputSpec",
          capability_metadata=i."capabilityMetadata",source_kind=i."sourceKind",source=i.source,
          source_version=i."sourceVersion",enabled=i.enabled,declaration_version=i."declarationVersion",updated_at=now()
          FROM incoming i WHERE NOT i."isNew" AND r.provider_type=i."providerType"
            AND r.raw_model_id=i."rawModelId" COLLATE "C" AND r.operation=i.operation`,
          [JSON.stringify(writes)],
        );
        await client.query(
          `INSERT INTO mio_provider_model_route_revisions (
          id,provider_type,raw_model_id,operation,declaration_version,action,actor_type,actor_id,actor_name,summary,before_route,after_route
        ) SELECT i.id,'onelink',i."rawModelId",i.operation,i."declarationVersion",i.action,$2,$3,$4,$5,i.before_route,i.after_route
          FROM jsonb_to_recordset($1::jsonb) AS i(id uuid,"rawModelId" text,operation text,"declarationVersion" integer,
            action text,before_route jsonb,after_route jsonb)`,
          [
            JSON.stringify(history),
            resolvedActor.actorType,
            resolvedActor.actorId ?? null,
            resolvedActor.actorName,
            resolvedActor.summary ?? null,
          ],
        );
      }
      return { total: entries.length, inserted, updated, unchanged, revisions };
    });
  }

  async deleteRoutes(
    rawModelId: string,
    actor: RouteRevisionActor,
    operation?: ProviderOperation,
  ): Promise<RouteRevisionResult[]> {
    return this.transaction((client) => deleteProviderRoutes(client, rawModelId, actor, operation));
  }
  async beginRefresh(owner: string): Promise<ProviderRow> {
    return this.transaction(async (client) => {
      const row = await this.locked(client, owner);
      return (
        await client.query<ProviderRow>(
          `UPDATE mio_provider_configs SET latest_refresh_seq=latest_refresh_seq+1,
          last_attempt_seq=latest_refresh_seq+1,last_attempt_credential_version=credential_version,
          last_attempt_started_at=now(),last_attempt_finished_at=NULL,last_attempt_status='running',
          last_attempt_error_code=NULL,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
          [row.id],
        )
      ).rows[0]!;
    });
  }
  async finishRefresh(
    owner: string,
    start: ProviderRow,
    discovery: Discovery,
    models: DiscoveredModel[],
  ): Promise<void> {
    await this.transaction(async (client) => {
      const row = await this.locked(client, owner);
      if (row.id !== start.id || row.credential_version !== start.credential_version)
        throw new ProviderError(HTTP_STATUS.CONFLICT, 'PROVIDER_CREDENTIAL_CHANGED');
      if (row.latest_refresh_seq !== start.latest_refresh_seq)
        throw new ProviderError(HTTP_STATUS.CONFLICT, 'PROVIDER_REFRESH_SUPERSEDED');
      if (discovery.status === 'connected') {
        const version = (row.catalog_version ?? 0) + 1;
        await client.query(
          `UPDATE mio_provider_models SET membership_state='removed'
            WHERE provider_id=$1 AND membership_state='current'
              AND NOT EXISTS (
                SELECT 1 FROM unnest($2::text[]) AS incoming(id)
                WHERE incoming.id COLLATE "C" = mio_provider_models.raw_model_id
              )`,
          [row.id, models.map((model) => model.id)],
        );
        await client.query(
          `INSERT INTO mio_provider_models(provider_id,raw_model_id,supplier_metadata,metadata_source,
            credential_version,catalog_version,first_seen_at,last_seen_at,membership_state)
            SELECT $1,m.id,m.metadata,'onelink-v1-models',$2,$3,now(),now(),'current'
            FROM jsonb_to_recordset($4::jsonb) AS m(id text,metadata jsonb)
            ON CONFLICT(provider_id,raw_model_id) DO UPDATE SET supplier_metadata=EXCLUDED.supplier_metadata,
              metadata_source=EXCLUDED.metadata_source,credential_version=$2,catalog_version=$3,
              first_seen_at=COALESCE(mio_provider_models.first_seen_at,EXCLUDED.first_seen_at),
              last_seen_at=EXCLUDED.last_seen_at,membership_state='current'`,
          [row.id, row.credential_version, version, JSON.stringify(models)],
        );
        if (row.enabled) {
          await client.query(
            `INSERT INTO mio_provider_models (
               provider_id, raw_model_id, supplier_metadata, metadata_source, membership_state
             )
             SELECT $1, cat.raw_model_id,
               jsonb_build_object('object', 'model', 'curated', true, 'description', COALESCE(cat.display_label, '')),
               'admin-curated-hidden', 'historical'
             FROM mio_provider_catalog_models cat
             WHERE cat.provider_type = 'onelink'
               AND cat.allow_undiscovered = true
               AND cat.user_visible = true
             ON CONFLICT (provider_id, raw_model_id) DO NOTHING`,
            [row.id],
          );
        }
        await client.query(
          `UPDATE mio_provider_configs SET catalog_version=$2,catalog_credential_version=credential_version,
          catalog_succeeded_at=now(),credential_auth_state='valid' WHERE id=$1`,
          [row.id, version],
        );
        await client.query(
          "UPDATE mio_provider_model_verifications SET verification_status='unverified' WHERE provider_id=$1",
          [row.id],
        );
      } else if (discovery.error === 'UPSTREAM_AUTH_REJECTED') {
        await client.query(
          "UPDATE mio_provider_configs SET credential_auth_state='rejected' WHERE id=$1",
          [row.id],
        );
      }
      await client.query(
        `UPDATE mio_provider_configs SET discovery=$2::jsonb,last_attempt_finished_at=now(),last_attempt_status=$3,
          last_attempt_error_code=$4,revision=revision+1,updated_at=now() WHERE id=$1`,
        [row.id, JSON.stringify(discovery), discovery.status, discovery.error],
      );
    });
  }
  /** Records one independently reviewed system voice for one owner and exact TTS model. */
  async registerSystemVoice(
    input: {
      ownerId: string;
      modelRef: string;
      upstreamId: string;
      name: string;
      evidence: string;
    },
    apply: boolean,
  ) {
    for (const [value, max] of [
      [input.ownerId, 256],
      [input.modelRef, 256],
      [input.upstreamId, 256],
      [input.name, 100],
      [input.evidence, 500],
    ] as const) {
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        !value.isWellFormed() ||
        Array.from(value).length > max ||
        /[\x00-\x1f\x7f]/.test(value)
      )
        throw new VoiceError(HTTP_STATUS.BAD_REQUEST, 'VOICE_REGISTRATION_INVALID');
    }
    if (Buffer.byteLength(input.upstreamId) > 256)
      throw new VoiceError(HTTP_STATUS.BAD_REQUEST, 'VOICE_REGISTRATION_INVALID');
    const register = async (client: Pick<Pool, 'query'> | PoolClient) => {
      const state = (
        await client.query<ProviderState>(
          providerModelStateSQL,
          modelStateParameters(input.ownerId, input.modelRef),
        )
      ).rows[0];
      if (!state) throw new ProviderError(HTTP_STATUS.NOT_FOUND, 'PROVIDER_NOT_CONFIGURED');
      const { model } = selectAudioModel(
        state,
        input.modelRef,
        'tts',
        Boolean(this.config.catalogWhitelist),
      );
      if (input.modelRef !== modelReference(model.model_key))
        throw new VoiceError(HTTP_STATUS.BAD_REQUEST, 'VOICE_REGISTRATION_INVALID');
      const existing = (
        await client.query<{ id: string; registration_model_key: string | null }>(
          `SELECT id,registration_model_key FROM mio_provider_voices
         WHERE provider_id=$1 AND source='system' AND upstream_id=$2`,
          [state.id, input.upstreamId],
        )
      ).rows[0];
      if (existing?.registration_model_key && existing.registration_model_key !== model.model_key)
        throw new VoiceError(HTTP_STATUS.CONFLICT, 'VOICE_REGISTRATION_MODEL_CONFLICT');
      const result = {
        modelRef: input.modelRef,
        voiceRef: existing?.id ?? null,
        exists: Boolean(existing),
      };
      if (!apply) return result;
      const saved = await client.query<{ id: string }>(
        `INSERT INTO mio_provider_voices (
           provider_id,source,upstream_id,name,descriptions,seen_seq,registration_model_key,registration_evidence
         ) VALUES ($1,'system',$2,$3,'[]'::jsonb,1,$4,$5)
         ON CONFLICT(provider_id,source,upstream_id) DO UPDATE SET name=EXCLUDED.name,present=true,
           registration_model_key=EXCLUDED.registration_model_key,
           registration_evidence=EXCLUDED.registration_evidence,updated_at=now()
         WHERE (mio_provider_voices.name,mio_provider_voices.present,
                mio_provider_voices.registration_model_key,mio_provider_voices.registration_evidence)
           IS DISTINCT FROM (EXCLUDED.name,true,EXCLUDED.registration_model_key,EXCLUDED.registration_evidence)
         RETURNING id`,
        [state.id, input.upstreamId, input.name.trim(), model.model_key, input.evidence.trim()],
      );
      return { ...result, voiceRef: saved.rows[0]?.id ?? existing!.id };
    };
    return apply
      ? this.transaction(async (client) => {
          await client.query('SELECT id FROM mio_provider_configs WHERE owner_id=$1 FOR UPDATE', [
            input.ownerId,
          ]);
          return register(client);
        })
      : register(this.pool);
  }

  /** Only an observed successful runtime call may mark the exact tested tuple; old references stay visible. */
  async recordVerification(
    owner: string,
    snapshot: VerificationSnapshot,
    evidence: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const row = (
        await client.query<Pick<ProviderRow, 'id' | 'credential_version' | 'catalog_version'>>(
          'SELECT id,credential_version,catalog_version FROM mio_provider_configs WHERE owner_id=$1 FOR UPDATE',
          [owner],
        )
      ).rows[0];
      if (!row) throw new ProviderError(HTTP_STATUS.NOT_FOUND, 'PROVIDER_NOT_CONFIGURED');
      if (row.id !== snapshot.providerConfigId)
        throw new ProviderError(HTTP_STATUS.CONFLICT, 'MODEL_NOT_FOUND');
      const current =
        row.credential_version === snapshot.credentialVersion &&
        row.catalog_version === snapshot.catalogVersion;
      // Late completion remains in its request observation and cannot overwrite a newer tuple's verification.
      if (!current) return;
      const state = (
        await client.query<ProviderState>(providerModelStateSQL, [
          owner,
          modelStateParameters(owner, modelReference(snapshot.modelKey))[1],
          null,
          null,
        ])
      ).rows[0];
      const model = state?.models.find((item) => item.model_key === snapshot.modelKey);
      if (!state || !model) return;
      const video =
        snapshot.operation === 'video.generate' ? resolveEffectiveVideo(state, model) : undefined;
      const effective =
        snapshot.operation === 'chat'
          ? resolveEffectiveChat(state, model)
          : snapshot.operation === 'image.generate'
            ? resolveEffectiveImage(state, model)
            : snapshot.operation === 'video.generate'
              ? video
              : resolveProviderAudioRoute(
                  state,
                  model,
                  snapshot.operation,
                  Boolean(this.config.catalogWhitelist),
                );
      if (
        !effective ||
        (snapshot.operation === 'video.generate' &&
          (!video?.enabled || !videoRouteRuntimeAvailable(video.route))) ||
        effective.declarationVersion !== snapshot.adaptationVersion ||
        effective.profile !== snapshot.profile
      )
        return;
      const tuple = {
        credentialVersion: snapshot.credentialVersion,
        catalogVersion: snapshot.catalogVersion,
        adaptationVersion: snapshot.adaptationVersion,
        operation: snapshot.operation,
        profile: snapshot.profile,
      };
      await client.query(
        `INSERT INTO mio_provider_model_verifications (
          provider_id, model_key, operation, declaration_version, driver,
          verification_status, verified_at, verification_evidence, tested_tuple
        ) VALUES ($1, $2, $3, $4, $5, 'verified', now(), $6, $7::jsonb)
        ON CONFLICT (provider_id, model_key, operation) DO UPDATE SET
          declaration_version=$4, driver=$5,
          verification_status='verified', verified_at=now(),
          verification_evidence=$6, tested_tuple=$7::jsonb`,
        [
          row.id,
          snapshot.modelKey,
          snapshot.operation,
          snapshot.adaptationVersion,
          snapshot.profile,
          evidence,
          JSON.stringify(tuple),
        ],
      );
    });
  }
  close(): Promise<void> {
    return (this.closing ??= this.pool.end());
  }
}
/** Caller owns the transaction; catalog deletion and route-only deletion share the same revision semantics. */
export async function deleteProviderRoutes(
  client: PoolClient,
  rawModelId: string,
  actor: RouteRevisionActor,
  operation?: ProviderOperation,
): Promise<RouteRevisionResult[]> {
  const rows = (
    await client.query<PlatformRouteRecord>(
      `SELECT * FROM mio_provider_model_routes WHERE provider_type='onelink'
      AND raw_model_id=$1 COLLATE "C" AND ($2::text IS NULL OR operation=$2)
      ORDER BY operation COLLATE "C" FOR UPDATE`,
      [rawModelId, operation ?? null],
    )
  ).rows;
  const changes = rows.map((row) => ({
    id: createId(),
    rawModelId: row.raw_model_id,
    operation: row.operation,
    declarationVersion: row.declaration_version + 1,
    action: 'delete' as const,
    before_route: serializeRouteInputSnapshot(row),
  }));
  if (changes.length) {
    await client.query(
      `DELETE FROM mio_provider_model_routes WHERE provider_type='onelink'
      AND raw_model_id=$1 COLLATE "C" AND operation=ANY($2::text[])`,
      [rawModelId, changes.map((row) => row.operation)],
    );
    await client.query(
      `INSERT INTO mio_provider_model_route_revisions (
      id,provider_type,raw_model_id,operation,declaration_version,action,
      actor_type,actor_id,actor_name,summary,before_route,after_route
    ) SELECT r.id,'onelink',$1,r.operation,r."declarationVersion",'delete',$3,$4,$5,$6,r.before_route,NULL
      FROM jsonb_to_recordset($2::jsonb) AS r(id uuid,operation text,"declarationVersion" integer,before_route jsonb)`,
      [
        rawModelId,
        JSON.stringify(changes),
        actor.actorType,
        actor.actorId ?? null,
        actor.actorName,
        actor.summary ?? null,
      ],
    );
  }
  return changes.map(({ id, rawModelId, operation, declarationVersion, action }) => ({
    id,
    rawModelId,
    operation,
    declarationVersion,
    action,
  }));
}

export async function createProviderStore(config: ProviderConfig): Promise<ProviderStore> {
  const pool = new Pool({
    connectionString: config.databaseURL,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 8000,
    application_name: 'mio-providers',
  });
  pool.on('error', () => log.error('PROVIDER_DATABASE_CONNECTION_ERROR'));
  try {
    await checkProviderSchema(pool);
    return new ProviderStore(pool, config);
  } catch {
    await pool.end();
    throw new Error('PROVIDER_SCHEMA: run providers:migrate; database unavailable or incompatible');
  }
}
