import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { createId } from '@mio/foundation/identifiers';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { ProviderError } from './contracts.ts';
import type { Discovery, ProviderView, Category, ChatRuntimeSnapshot } from './contracts.ts';
import type { ProviderConfig } from './config.ts';
import type { DiscoveredModel } from '../integrations/onelink/models.ts';
import { encryptCredential } from './credentials.ts';
import { checkProviderSchema } from './schema.ts';
import { providerStateSQL, providerView } from './state.ts';
import type { ProviderRow, ProviderState } from './state.ts';
import { findModel, membershipError, chatAdaptation, validateDeclaration } from './catalog.ts';

const log = createLogger('app', 'provider-store');

export interface SettingsPatch {
  enabled?: boolean;
  defaultImageWatermark?: boolean;
  defaultVideoWatermark?: boolean;
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
  /** One MVCC statement: credentials, membership, declarations and preferences agree. */
  async state(owner: string): Promise<ProviderState | null> {
    return (await this.pool.query<ProviderState>(providerStateSQL, [owner])).rows[0] ?? null;
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
          "UPDATE mio_provider_model_adaptations SET verification_status='unverified' WHERE provider_id=$1",
          [id],
        );
      }
      return providerView(result.rows[0]);
    });
  }
  async settings(owner: string, expected: number, patch: SettingsPatch): Promise<ProviderView> {
    return this.transaction(async (client) => {
      const row = await this.locked(client, owner, expected);
      return providerView(
        (
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
        ).rows[0]!,
      );
    });
  }
  async preference(
    owner: string,
    expected: number,
    modelRef: string,
    usage: Category,
    patch: { enabled?: boolean; isDefault?: boolean },
  ): Promise<ProviderView> {
    return this.transaction(async (client) => {
      const row = await this.locked(client, owner, expected);
      const state = (await client.query<ProviderState>(providerStateSQL, [owner])).rows[0]!;
      const model = findModel(state.models, modelRef);
      const reason = membershipError(row, model);
      if (reason) throw new ProviderError(HTTP_STATUS.CONFLICT, reason);
      if (usage !== 'chat')
        throw new ProviderError(HTTP_STATUS.CONFLICT, 'MODEL_USAGE_UNSUPPORTED');
      if (!chatAdaptation(state.adaptations, model!.model_key))
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
  async declare(owner: string, expected: number, input: unknown): Promise<ProviderView> {
    const entry = validateDeclaration(input);
    return this.transaction(async (client) => {
      const row = await this.locked(client, owner, expected);
      const state = (await client.query<ProviderState>(providerStateSQL, [owner])).rows[0]!;
      const model = findModel(state.models, entry.modelRef);
      const reason = membershipError(row, model);
      if (reason) throw new ProviderError(HTTP_STATUS.CONFLICT, reason);
      await client.query(
        `INSERT INTO mio_provider_model_adaptations(provider_id,model_key,operation,profile,declaration_version,
          source,source_version,capability_metadata) VALUES($1,$2,$3,$4,1,$5,$6,$7::jsonb)
          ON CONFLICT(provider_id,model_key,operation) DO UPDATE SET profile=$4,
          declaration_version=mio_provider_model_adaptations.declaration_version+1,source=$5,source_version=$6,
          capability_metadata=$7::jsonb,verification_status='unverified'`,
        [
          row.id,
          model!.model_key,
          entry.operation,
          entry.profile,
          entry.source,
          entry.sourceVersion,
          JSON.stringify(entry.metadata ?? {}),
        ],
      );
      if (entry.classification !== undefined)
        await client.query(
          'UPDATE mio_provider_models SET classification=$3,classification_source=$4 WHERE provider_id=$1 AND model_key=$2',
          [
            row.id,
            model!.model_key,
            entry.classification,
            `deployment:${entry.source}@${entry.sourceVersion}`,
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
          "UPDATE mio_provider_models SET membership_state='removed' WHERE provider_id=$1 AND membership_state='current'",
          [row.id],
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
        await client.query(
          `UPDATE mio_provider_configs SET catalog_version=$2,catalog_credential_version=credential_version,
          catalog_succeeded_at=now(),credential_auth_state='valid' WHERE id=$1`,
          [row.id, version],
        );
        await client.query(
          "UPDATE mio_provider_model_adaptations SET verification_status='unverified' WHERE provider_id=$1",
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
    snapshot: ChatRuntimeSnapshot,
    evidence: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const row = await this.locked(client, owner);
      if (row.id !== snapshot.providerConfigId)
        throw new ProviderError(HTTP_STATUS.CONFLICT, 'MODEL_NOT_FOUND');
      const current =
        row.credential_version === snapshot.credentialVersion &&
        row.catalog_version === snapshot.catalogVersion;
      // Late completion remains in its request observation and cannot overwrite a newer tuple's verification.
      if (!current) return;
      const tuple = {
        credentialVersion: snapshot.credentialVersion,
        catalogVersion: snapshot.catalogVersion,
        adaptationVersion: snapshot.adaptationVersion,
        operation: snapshot.operation,
        profile: snapshot.profile,
      };
      await client.query(
        `UPDATE mio_provider_model_adaptations SET verification_status='verified',verified_at=now(),
          verification_evidence=$5,tested_tuple=$6::jsonb
          WHERE provider_id=$1 AND model_key=$2 AND operation=$3 AND declaration_version=$4 AND profile=$7`,
        [
          row.id,
          snapshot.modelKey,
          snapshot.operation,
          snapshot.adaptationVersion,
          evidence,
          JSON.stringify(tuple),
          snapshot.profile,
        ],
      );
    });
  }
  close(): Promise<void> {
    return (this.closing ??= this.pool.end());
  }
}
export async function createProviderStore(config: ProviderConfig): Promise<ProviderStore> {
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
    await checkProviderSchema(pool);
    return new ProviderStore(pool, config);
  } catch {
    await pool.end();
    throw new Error('PROVIDER_SCHEMA: run providers:migrate; database unavailable or incompatible');
  }
}
