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
  RouteRevisionAction,
  RouteRevisionActor,
  VerificationSnapshot,
} from './contracts.ts';
import type { ProviderConfig } from './config.ts';
import type { DiscoveredModel } from '../integrations/onelink/models.ts';
import { encryptCredential } from './credentials.ts';
import { checkProviderSchema } from './schema.ts';
import { providerStateSQL, providerView } from './state.ts';
import type { ProviderRow, ProviderState } from './state.ts';
import {
  findCatalogModel,
  findModel,
  membershipError,
  resolveEffectiveChat,
  resolveEffectiveImage,
} from './catalog.ts';
import {
  canonicalRouteComparable,
  serializeRouteInputSnapshot,
  validateRouteImportPayload,
} from './onelink/router.ts';

const log = createLogger('app', 'provider-store');

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
  operation: 'chat' | 'image.generate' | 'video.generate';
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
/** All mutations serialize on the configuration row; network calls run outside the transaction. */
export class ProviderStore {
  private readonly pool: Pool;
  private readonly config: ProviderConfig;
  private closing: Promise<void> | undefined;
  constructor(pool: Pool, config: ProviderConfig) {
    this.pool = pool;
    this.config = config;
  }

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await action(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error instanceof ProviderError
        ? error
        : new ProviderError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'PROVIDER_UNAVAILABLE');
    } finally {
      client.release();
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
      const state = (await client.query<ProviderState>(providerStateSQL(false), [owner])).rows[0]!;
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
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      const revisions: RouteRevisionResult[] = [];
      for (const entry of entries) {
        await client.query(
          `INSERT INTO mio_provider_catalog_models (
             provider_type, raw_model_id, vendor_label, category, origin_source, updated_by
           ) VALUES ($1, $2, $3, $4, 'route-import', $5)
           ON CONFLICT (provider_type, raw_model_id) DO NOTHING`,
          [
            entry.providerType,
            entry.rawModelId,
            entry.vendor,
            entry.classification,
            resolvedActor.actorName,
          ],
        );
        const existing = (
          await client.query<PlatformRouteRecord>(
            `SELECT * FROM mio_provider_model_routes
              WHERE provider_type=$1 AND raw_model_id=$2 COLLATE "C" AND operation=$3
              FOR UPDATE`,
            [entry.providerType, entry.rawModelId, entry.operation],
          )
        ).rows[0];
        if (!existing) {
          await client.query(
            `INSERT INTO mio_provider_model_routes (
              provider_type, raw_model_id, operation, vendor, driver, classification,
              submit_path, edit_path, query_path_template, param_spec, request_defaults,
              output_spec, capability_metadata, source_kind, source, source_version,
              declaration_version, enabled
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9,
              $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb,
              $14, $15, $16, 1, $17
            )`,
            [
              entry.providerType,
              entry.rawModelId,
              entry.operation,
              entry.vendor,
              entry.driver,
              entry.classification,
              entry.submitPath,
              entry.editPath,
              entry.queryPathTemplate,
              JSON.stringify(entry.paramSpec),
              JSON.stringify(entry.requestDefaults),
              JSON.stringify(entry.outputSpec),
              JSON.stringify(entry.capabilityMetadata),
              entry.sourceKind,
              entry.source,
              entry.sourceVersion,
              entry.enabled,
            ],
          );
          const revisionId = createId();
          const action: RouteRevisionAction = resolvedActor.actionOverride ?? 'create';
          await client.query(
            `INSERT INTO mio_provider_model_route_revisions (
              id, provider_type, raw_model_id, operation, declaration_version,
              action, actor_type, actor_id, actor_name, summary, before_route, after_route
            ) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, NULL, $10::jsonb)`,
            [
              revisionId,
              entry.providerType,
              entry.rawModelId,
              entry.operation,
              action,
              resolvedActor.actorType,
              resolvedActor.actorId ?? null,
              resolvedActor.actorName,
              resolvedActor.summary ?? null,
              JSON.stringify(serializeRouteInputSnapshot(entry)),
            ],
          );
          revisions.push({
            id: revisionId,
            rawModelId: entry.rawModelId,
            operation: entry.operation,
            declarationVersion: 1,
            action,
          });
          inserted += 1;
        } else if (canonicalRouteComparable(existing) === canonicalRouteComparable(entry)) {
          unchanged += 1;
        } else {
          const nextVersion = existing.declaration_version + 1;
          await client.query(
            `UPDATE mio_provider_model_routes SET
              vendor=$4, driver=$5, classification=$6, submit_path=$7, edit_path=$8,
              query_path_template=$9, param_spec=$10::jsonb, request_defaults=$11::jsonb,
              output_spec=$12::jsonb, capability_metadata=$13::jsonb, source_kind=$14,
              source=$15, source_version=$16, enabled=$17,
              declaration_version=$18,
              updated_at=now()
              WHERE provider_type=$1 AND raw_model_id=$2 COLLATE "C" AND operation=$3`,
            [
              entry.providerType,
              entry.rawModelId,
              entry.operation,
              entry.vendor,
              entry.driver,
              entry.classification,
              entry.submitPath,
              entry.editPath,
              entry.queryPathTemplate,
              JSON.stringify(entry.paramSpec),
              JSON.stringify(entry.requestDefaults),
              JSON.stringify(entry.outputSpec),
              JSON.stringify(entry.capabilityMetadata),
              entry.sourceKind,
              entry.source,
              entry.sourceVersion,
              entry.enabled,
              nextVersion,
            ],
          );
          const onlyEnabledToggled =
            existing.enabled !== entry.enabled &&
            canonicalRouteComparable({ ...existing, enabled: entry.enabled }) ===
              canonicalRouteComparable(entry);
          const action: RouteRevisionAction =
            resolvedActor.actionOverride ??
            (onlyEnabledToggled ? (entry.enabled ? 'enable' : 'disable') : 'update');
          const revisionId = createId();
          await client.query(
            `INSERT INTO mio_provider_model_route_revisions (
              id, provider_type, raw_model_id, operation, declaration_version,
              action, actor_type, actor_id, actor_name, summary, before_route, after_route
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)`,
            [
              revisionId,
              entry.providerType,
              entry.rawModelId,
              entry.operation,
              nextVersion,
              action,
              resolvedActor.actorType,
              resolvedActor.actorId ?? null,
              resolvedActor.actorName,
              resolvedActor.summary ?? null,
              JSON.stringify(serializeRouteInputSnapshot(existing)),
              JSON.stringify(serializeRouteInputSnapshot(entry)),
            ],
          );
          revisions.push({
            id: revisionId,
            rawModelId: entry.rawModelId,
            operation: entry.operation,
            declarationVersion: nextVersion,
            action,
          });
          updated += 1;
        }
      }
      return { total: entries.length, inserted, updated, unchanged, revisions };
    });
  }
  async deleteRoutes(
    rawModelId: string,
    actor: RouteRevisionActor,
    operation?: 'chat' | 'image.generate' | 'video.generate',
  ): Promise<RouteRevisionResult[]> {
    return this.transaction(async (client) => {
      const existingRows = (
        await client.query<PlatformRouteRecord>(
          operation
            ? `SELECT * FROM mio_provider_model_routes
               WHERE provider_type='onelink' AND raw_model_id=$1 COLLATE "C" AND operation=$2
               FOR UPDATE`
            : `SELECT * FROM mio_provider_model_routes
               WHERE provider_type='onelink' AND raw_model_id=$1 COLLATE "C"
               ORDER BY operation ASC
               FOR UPDATE`,
          operation ? [rawModelId, operation] : [rawModelId],
        )
      ).rows;
      const revisions: RouteRevisionResult[] = [];
      for (const existing of existingRows) {
        await client.query(
          `DELETE FROM mio_provider_model_routes
           WHERE provider_type='onelink' AND raw_model_id=$1 COLLATE "C" AND operation=$2`,
          [existing.raw_model_id, existing.operation],
        );
        const nextVersion = existing.declaration_version + 1;
        const revisionId = createId();
        await client.query(
          `INSERT INTO mio_provider_model_route_revisions (
             id, provider_type, raw_model_id, operation, declaration_version,
             action, actor_type, actor_id, actor_name, summary, before_route, after_route
           ) VALUES ($1, 'onelink', $2, $3, $4, 'delete', $5, $6, $7, $8, $9::jsonb, NULL)`,
          [
            revisionId,
            existing.raw_model_id,
            existing.operation,
            nextVersion,
            actor.actorType,
            actor.actorId ?? null,
            actor.actorName,
            actor.summary ?? null,
            JSON.stringify(serializeRouteInputSnapshot(existing)),
          ],
        );
        revisions.push({
          id: revisionId,
          rawModelId: existing.raw_model_id,
          operation: existing.operation,
          declarationVersion: nextVersion,
          action: 'delete',
        });
      }
      return revisions;
    });
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
  /** Only an observed successful runtime call may mark the exact tested tuple; old references stay visible. */
  async recordVerification(
    owner: string,
    snapshot: VerificationSnapshot,
    evidence: string,
  ): Promise<void> {
    // No video driver is runtime-supported in this slice, so declarations cannot be verified.
    if (snapshot.operation === 'video.generate') return;
    await this.transaction(async (client) => {
      const row = await this.locked(client, owner);
      if (row.id !== snapshot.providerConfigId)
        throw new ProviderError(HTTP_STATUS.CONFLICT, 'MODEL_NOT_FOUND');
      const current =
        row.credential_version === snapshot.credentialVersion &&
        row.catalog_version === snapshot.catalogVersion;
      // Late completion remains in its request observation and cannot overwrite a newer tuple's verification.
      if (!current) return;
      const state = (await client.query<ProviderState>(providerStateSQL(false), [owner])).rows[0];
      const model = state?.models.find((item) => item.model_key === snapshot.modelKey);
      if (!state || !model) return;
      const effective =
        snapshot.operation === 'chat'
          ? resolveEffectiveChat(state, model)
          : resolveEffectiveImage(state, model);
      if (
        !effective ||
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
export async function createProviderStore(
  config: ProviderConfig,
  images = false,
): Promise<ProviderStore> {
  const pool = new Pool({
    connectionString: config.databaseURL,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 5000,
    application_name: 'mio-providers',
  });
  pool.on('error', () => log.error('PROVIDER_DATABASE_CONNECTION_ERROR'));
  try {
    await checkProviderSchema(pool, images);
    return new ProviderStore(pool, config);
  } catch {
    await pool.end();
    throw new Error('PROVIDER_SCHEMA: run providers:migrate; database unavailable or incompatible');
  }
}
