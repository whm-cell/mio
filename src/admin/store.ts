import { readCreationLogSettings, saveCreationLogSettings } from './creation-logs.ts';
import type { CreationLogSettings } from './creation-logs.ts';
import { readStorageSettings, saveStorageSettings } from './storage-store.ts';
import type { StorageSettings } from './storage.ts';
import type { validateStorageSettingsUpdate } from './storage-store.ts';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createId } from '@mio/foundation/identifiers';
import { createLogger } from '@mio/foundation/logging';
import { epochMs, utcISOString } from '@mio/foundation/time';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import type { AuthRuntimePolicy, AuthSmsMode } from '../auth/config.ts';
import type { DiscoveredModel } from '../integrations/onelink/models.ts';
import type { OneLinkSsoRegisterResult } from '../integrations/onelink/sso.ts';
import type {
  Category,
  PlatformCatalogModelRecord,
  PlatformModelOriginSource,
  PlatformRouteRecord,
  ProviderOperation,
  PlatformRouteRevisionRecord,
} from '../providers/contracts.ts';
import { checkProviderSchema } from '../providers/schema.ts';
import type { AdminConfig } from './config.ts';
import { AdminError, SMS_BYPASS_CODE_PATTERN, isAuthSmsMode } from './contracts.ts';
import type {
  AdminAccountView,
  AdminAuditLogRecord,
  AdminComputeMonitoringSummary,
  AdminOneLinkSsoConfigView,
  AdminPrincipal,
  AdminRevisionsView,
  AdminRouteTemplateUiHints,
  AdminRouteTemplateView,
  AdminStoredAuthSettings,
  MonitoringWindow,
  OneLinkSsoRegistrationSource,
  OneLinkSsoRegistrationStatus,
  ProbeConfigView,
  UnifiedModelRawSources,
} from './contracts.ts';
import type { ProbeKeyEnvelope } from './credentials.ts';
import { checkAdminSchema } from './schema.ts';

const log = createLogger('app', 'admin-store');

interface AdminAccountRow {
  id: string;
  username: string;
  password_hash: string;
  is_super_admin: boolean;
  created_at: Date;
  updated_at: Date;
}

interface ProbeConfigRow {
  masked_hint: string | null;
  key_version: number | null;
  cipher_format: number | null;
  master_key_id: string | null;
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  auth_tag: Buffer | null;
  last_probed_at: Date | null;
  last_probe_status: 'connected' | 'failed' | null;
  last_probe_count: number | null;
  last_probe_error: string | null;
  updated_by: string | null;
  updated_at: Date;
}

interface RouteTemplateRow {
  id: string;
  template_key: string;
  label: string;
  description: string;
  operation: ProviderOperation;
  vendor: string;
  driver: string;
  route_template: Record<string, unknown>;
  ui_hints: AdminRouteTemplateUiHints;
  sort_order: number;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

type CatalogModelDbRow = Omit<PlatformCatalogModelRecord, 'created_at' | 'updated_at'> & {
  created_at: Date;
  updated_at: Date;
};

interface GlobalSettingsRow {
  setting_key: string;
  value: Record<string, unknown>;
  revision: number;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface OneLinkSsoConfigRow {
  environment: string;
  enabled: boolean;
  client_name: string;
  client_id: string | null;
  expected_client_id: string | null;
  registration_status: OneLinkSsoRegistrationStatus;
  registration_source: OneLinkSsoRegistrationSource | null;
  last_register_code: number | null;
  last_register_trace_id: string | null;
  last_register_message: string | null;
  last_registered_at: Date | null;
  revision: number;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const ONELINK_SSO_COLUMNS =
  'environment, enabled, client_name, client_id, expected_client_id, registration_status, registration_source, last_register_code, last_register_trace_id, last_register_message, last_registered_at, revision, updated_by, created_at, updated_at';

function toOneLinkSsoConfigView(row: OneLinkSsoConfigRow): AdminOneLinkSsoConfigView {
  return {
    environment: row.environment,
    enabled: row.enabled,
    clientName: row.client_name,
    clientId: row.client_id,
    expectedClientId: row.expected_client_id,
    registrationStatus: row.registration_status,
    registrationSource: row.registration_source,
    lastRegisterCode: row.last_register_code,
    lastRegisterTraceId: row.last_register_trace_id,
    lastRegisterMessage: row.last_register_message,
    lastRegisteredAt: row.last_registered_at?.toISOString() ?? null,
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  };
}

function toAuditOneLinkSsoState(view: AdminOneLinkSsoConfigView): Record<string, unknown> {
  return {
    environment: view.environment,
    enabled: view.enabled,
    clientName: view.clientName,
    clientId: view.clientId,
    expectedClientId: view.expectedClientId,
    registrationStatus: view.registrationStatus,
    registrationSource: view.registrationSource,
    revision: view.revision,
  };
}

function parseStoredAuthPolicy(value: Record<string, unknown>): AuthRuntimePolicy {
  const smsMode: AuthSmsMode = isAuthSmsMode(value.smsMode) ? value.smsMode : 'live';
  const smsBypassCode =
    typeof value.smsBypassCode === 'string' && SMS_BYPASS_CODE_PATTERN.test(value.smsBypassCode)
      ? value.smsBypassCode
      : null;
  return {
    emailPasswordEnabled:
      typeof value.emailPasswordEnabled === 'boolean' ? value.emailPasswordEnabled : true,
    smsMode,
    smsBypassCode,
  };
}

function toStoredAuthSettings(row: GlobalSettingsRow): AdminStoredAuthSettings {
  return {
    auth: parseStoredAuthPolicy(row.value),
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  };
}

function maskBypassCode(code: string | null): string | null {
  return code ? `${code.slice(0, 2)}****` : null;
}

function toAuditAuthState(policy: AuthRuntimePolicy, revision: number): Record<string, unknown> {
  return {
    emailPasswordEnabled: policy.emailPasswordEnabled,
    smsMode: policy.smsMode,
    smsBypassCodeMasked: maskBypassCode(policy.smsBypassCode),
    revision,
  };
}

function toAccountView(row: AdminAccountRow): AdminAccountView {
  return {
    id: row.id,
    username: row.username,
    isSuperAdmin: row.is_super_admin,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toTemplateView(row: RouteTemplateRow): AdminRouteTemplateView {
  return {
    id: row.id,
    templateKey: row.template_key,
    label: row.label,
    description: row.description,
    operation: row.operation,
    vendor: row.vendor,
    driver: row.driver,
    routeTemplate: row.route_template,
    uiHints: row.ui_hints ?? {},
    sortOrder: row.sort_order,
    updatedBy: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toCatalogRecord(row: CatalogModelDbRow): PlatformCatalogModelRecord {
  return {
    ...row,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function sanitizeErrorCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || /https?:\/\//i.test(trimmed)) return 'REDACTED_ERROR';
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(trimmed) ? trimmed : 'INTERNAL_ERROR';
}

function windowInterval(window: MonitoringWindow): string | null {
  if (window === '24h') return '24 hours';
  if (window === '7d') return '7 days';
  if (window === '30d') return '30 days';
  return null;
}

function createManagedPool(connectionString: string, name: string, max = 3): Pool {
  const pool = new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 5000,
    application_name: name,
  });
  pool.on('error', () => log.error('ADMIN_DATABASE_CONNECTION_ERROR'));
  return pool;
}

async function materializeCuratedModelForActiveProviders(
  client: PoolClient,
  rawModelId: string,
  displayLabel: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO mio_provider_models (
       provider_id, raw_model_id, supplier_metadata, metadata_source, membership_state
     )
     SELECT c.id, $1,
       jsonb_build_object('object', 'model', 'curated', true, 'description', COALESCE($2::text, '')),
       'admin-curated-hidden', 'historical'
     FROM mio_provider_configs c
     WHERE c.provider_type = 'onelink'
       AND c.enabled = true
       AND c.credential_auth_state <> 'rejected'
       AND c.catalog_version IS NOT NULL
       AND c.catalog_credential_version = c.credential_version
     ON CONFLICT (provider_id, raw_model_id) DO NOTHING`,
    [rawModelId, displayLabel],
  );
}

export class AdminStore {
  readonly initialAuthSettings: AdminStoredAuthSettings | null;
  readonly initialCreationLogSettings: CreationLogSettings;
  readonly initialStorageSettings: StorageSettings;
  readonly initialStorageSettingsReadAt: number;
  readonly initialOneLinkSsoConfig: AdminOneLinkSsoConfigView | null;
  readonly oneLinkSsoEnv: string;
  private readonly pool: Pool;
  private readonly conversationsPool: Pool | null;
  private readonly ownsConversationsPool: boolean;
  private readonly mediaPool: Pool | null;
  private closing: Promise<void> | undefined;

  constructor(
    pool: Pool,
    conversationsPool: Pool | null,
    ownsConversationsPool: boolean,
    mediaPool: Pool | null,
    initialCreationLogSettings: CreationLogSettings,
    initialStorageSettings: StorageSettings,
    initialAuthSettings: AdminStoredAuthSettings | null = null,
    initialOneLinkSsoConfig: AdminOneLinkSsoConfigView | null = null,
    oneLinkSsoEnv = 'dev',
    initialStorageSettingsReadAt = epochMs(),
  ) {
    this.pool = pool;
    this.conversationsPool = conversationsPool;
    this.ownsConversationsPool = ownsConversationsPool;
    this.mediaPool = mediaPool;
    this.initialAuthSettings = initialAuthSettings;
    this.initialCreationLogSettings = initialCreationLogSettings;
    this.initialStorageSettings = initialStorageSettings;
    this.initialStorageSettingsReadAt = initialStorageSettingsReadAt;
    this.initialOneLinkSsoConfig = initialOneLinkSsoConfig;
    this.oneLinkSsoEnv = oneLinkSsoEnv;
  }

  async recordAnnouncementOperation(
    actor: { id: string; username: string },
    action: string,
    targetId: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO mio_admin_audit_logs(id,actor_id,actor_name,action,target_id,summary)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        createId(),
        actor.id,
        actor.username,
        `announcement.${action}`,
        targetId,
        `Announcement ${action} requested; outcome is not implied`,
      ],
    );
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
      if (error instanceof AdminError) throw error;
      const pgErr = error as { code?: string; constraint?: string } | null;
      if (pgErr?.code === '23505') {
        const constraint = pgErr.constraint ?? '';
        if (constraint.includes('template_key')) {
          throw new AdminError(HTTP_STATUS.CONFLICT, 'TEMPLATE_KEY_TAKEN');
        }
        if (constraint.includes('catalog_models')) {
          throw new AdminError(HTTP_STATUS.CONFLICT, 'MODEL_ALREADY_EXISTS');
        }
        throw new AdminError(HTTP_STATUS.CONFLICT, 'ADMIN_USERNAME_TAKEN');
      }
      throw new AdminError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ADMIN_UNAVAILABLE');
    } finally {
      client.release();
    }
  }

  async bootstrapSuperAdmin(
    username: string,
    passwordHash: string,
    resetPassword = false,
  ): Promise<{ created: boolean; admin: AdminAccountView }> {
    return this.transaction(async (client) => {
      const existing = (
        await client.query<AdminAccountRow>(
          'SELECT * FROM mio_admin_accounts WHERE username=$1 FOR UPDATE',
          [username],
        )
      ).rows[0];
      if (existing) {
        if (!resetPassword) return { created: false, admin: toAccountView(existing) };
        const updated = (
          await client.query<AdminAccountRow>(
            `UPDATE mio_admin_accounts SET password_hash=$2, is_super_admin=true, updated_at=now()
             WHERE id=$1 RETURNING *`,
            [existing.id, passwordHash],
          )
        ).rows[0]!;
        await client.query('DELETE FROM mio_admin_sessions WHERE admin_id=$1', [existing.id]);
        return { created: false, admin: toAccountView(updated) };
      }
      const id = createId();
      const inserted = (
        await client.query<AdminAccountRow>(
          `INSERT INTO mio_admin_accounts (id, username, password_hash, is_super_admin)
           VALUES ($1, $2, $3, true) RETURNING *`,
          [id, username, passwordHash],
        )
      ).rows[0]!;
      await client.query(
        `INSERT INTO mio_admin_audit_logs (id, actor_id, actor_name, action, target_id, summary)
         VALUES ($1, $2, $3, 'admin.bootstrap', $2, 'Initialized super admin account')`,
        [createId(), id, username],
      );
      return { created: true, admin: toAccountView(inserted) };
    });
  }

  async findAccountByUsername(
    username: string,
  ): Promise<{ view: AdminAccountView; passwordHash: string } | null> {
    const row = (
      await this.pool.query<AdminAccountRow>('SELECT * FROM mio_admin_accounts WHERE username=$1', [
        username,
      ])
    ).rows[0];
    return row ? { view: toAccountView(row), passwordHash: row.password_hash } : null;
  }

  async findAccountById(
    id: string,
  ): Promise<{ view: AdminAccountView; passwordHash: string } | null> {
    const row = (
      await this.pool.query<AdminAccountRow>('SELECT * FROM mio_admin_accounts WHERE id=$1', [id])
    ).rows[0];
    return row ? { view: toAccountView(row), passwordHash: row.password_hash } : null;
  }

  async createSession(adminId: string, tokenDigest: string, expiresAt: Date): Promise<string> {
    return this.transaction(async (client) => {
      await client.query('DELETE FROM mio_admin_sessions WHERE expires_at <= now()');
      const sessionId = createId();
      await client.query(
        `INSERT INTO mio_admin_sessions (id, admin_id, token_digest, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [sessionId, adminId, tokenDigest, expiresAt],
      );
      return sessionId;
    });
  }

  async resolveSession(tokenDigest: string): Promise<AdminPrincipal | null> {
    const row = (
      await this.pool.query<AdminAccountRow & { session_id: string }>(
        `SELECT s.id AS session_id, a.*
         FROM mio_admin_sessions s
         JOIN mio_admin_accounts a ON a.id = s.admin_id
         WHERE s.token_digest = $1 AND s.expires_at > now()`,
        [tokenDigest],
      )
    ).rows[0];
    if (!row) return null;
    return {
      admin: toAccountView(row),
      sessionId: row.session_id,
      tokenDigest,
    };
  }

  async deleteSession(tokenDigest: string): Promise<void> {
    await this.pool.query('DELETE FROM mio_admin_sessions WHERE token_digest=$1', [tokenDigest]);
  }

  async updateAccount(
    adminId: string,
    currentTokenDigest: string,
    patch: { username?: string; passwordHash?: string },
  ): Promise<AdminAccountView> {
    return this.transaction(async (client) => {
      const existing = (
        await client.query<AdminAccountRow>(
          'SELECT * FROM mio_admin_accounts WHERE id=$1 FOR UPDATE',
          [adminId],
        )
      ).rows[0];
      if (!existing) throw new AdminError(HTTP_STATUS.UNAUTHORIZED, 'ADMIN_UNAUTHORIZED');
      const nextUsername = patch.username ?? existing.username;
      const nextHash = patch.passwordHash ?? existing.password_hash;
      const updated = (
        await client.query<AdminAccountRow>(
          `UPDATE mio_admin_accounts
           SET username=$2, password_hash=$3, updated_at=now()
           WHERE id=$1 RETURNING *`,
          [adminId, nextUsername, nextHash],
        )
      ).rows[0]!;
      if (patch.passwordHash) {
        await client.query(
          'DELETE FROM mio_admin_sessions WHERE admin_id=$1 AND token_digest <> $2',
          [adminId, currentTokenDigest],
        );
      }
      const actions: string[] = [];
      if (patch.username && patch.username !== existing.username) actions.push('username');
      if (patch.passwordHash) actions.push('password');
      await client.query(
        `INSERT INTO mio_admin_audit_logs (
          id, actor_id, actor_name, action, target_id, summary, before_state, after_state
        ) VALUES ($1, $2, $3, 'admin.account.update', $2, $4, $5::jsonb, $6::jsonb)`,
        [
          createId(),
          adminId,
          updated.username,
          `Updated ${actions.join(' & ') || 'account'}`,
          JSON.stringify({ username: existing.username }),
          JSON.stringify({
            username: updated.username,
            passwordChanged: Boolean(patch.passwordHash),
          }),
        ],
      );
      return toAccountView(updated);
    });
  }

  async readProbeRecord(): Promise<{
    view: ProbeConfigView;
    envelope: (ProbeKeyEnvelope & { keyVersion: number }) | null;
  }> {
    const row = (
      await this.pool.query<ProbeConfigRow>(
        "SELECT * FROM mio_admin_probe_configs WHERE provider_type='onelink'",
      )
    ).rows[0];
    if (!row) {
      return {
        view: {
          hasSavedKey: false,
          maskedHint: null,
          keyVersion: null,
          lastProbedAt: null,
          lastProbeStatus: null,
          lastProbeCount: null,
          lastProbeError: null,
          updatedBy: null,
          updatedAt: null,
        },
        envelope: null,
      };
    }
    const hasSavedKey =
      row.cipher_format === 1 &&
      row.key_version !== null &&
      row.master_key_id !== null &&
      row.nonce !== null &&
      row.ciphertext !== null &&
      row.auth_tag !== null;
    return {
      view: {
        hasSavedKey,
        maskedHint: hasSavedKey ? (row.masked_hint ?? '********') : null,
        keyVersion: row.key_version,
        lastProbedAt: row.last_probed_at?.toISOString() ?? null,
        lastProbeStatus: row.last_probe_status,
        lastProbeCount: row.last_probe_count,
        lastProbeError: row.last_probe_error,
        updatedBy: row.updated_by,
        updatedAt: row.updated_at.toISOString(),
      },
      envelope: hasSavedKey
        ? {
            keyVersion: row.key_version!,
            cipher_format: row.cipher_format!,
            master_key_id: row.master_key_id!,
            nonce: row.nonce!,
            ciphertext: row.ciphertext!,
            auth_tag: row.auth_tag!,
          }
        : null,
    };
  }

  async nextProbeKeyVersion(): Promise<number> {
    const row = (
      await this.pool.query<{ key_version: number | null }>(
        "SELECT key_version FROM mio_admin_probe_configs WHERE provider_type='onelink'",
      )
    ).rows[0];
    return (row?.key_version ?? 0) + 1;
  }

  async recordProbeOutcome(input: {
    actor: AdminAccountView;
    status: 'connected' | 'failed';
    models: DiscoveredModel[];
    error: string | null;
    savedEnvelope?: {
      keyVersion: number;
      maskedHint: string;
      envelope: ProbeKeyEnvelope;
    };
  }): Promise<{
    totalCatalogCount: number;
    existingIds: Set<string>;
    ignoredIds: Set<string>;
  }> {
    return this.transaction(async (client) => {
      if (input.status === 'connected') {
        await client.query(
          "UPDATE mio_admin_catalog_models SET in_latest_probe=false WHERE provider_type='onelink'",
        );
        if (input.models.length > 0) {
          await client.query(
            `INSERT INTO mio_admin_catalog_models (
              provider_type, raw_model_id, supplier_metadata, in_latest_probe, probe_seq, first_seen_at, last_seen_at
            )
            SELECT 'onelink', m.id, m.metadata, true, 1, now(), now()
            FROM jsonb_to_recordset($1::jsonb) AS m(id text, metadata jsonb)
            ON CONFLICT (provider_type, raw_model_id) DO UPDATE SET
              supplier_metadata = EXCLUDED.supplier_metadata,
              in_latest_probe = true,
              probe_seq = mio_admin_catalog_models.probe_seq + 1,
              last_seen_at = now()`,
            [JSON.stringify(input.models)],
          );
        }
      }
      if (input.savedEnvelope) {
        const { keyVersion, maskedHint, envelope } = input.savedEnvelope;
        await client.query(
          `INSERT INTO mio_admin_probe_configs (
            provider_type, masked_hint, key_version, cipher_format, master_key_id,
            nonce, ciphertext, auth_tag, last_probed_at, last_probe_status,
            last_probe_count, last_probe_error, updated_by, updated_at
          ) VALUES (
            'onelink', $1, $2, $3, $4, $5, $6, $7, now(), $8, $9, $10, $11, now()
          )
          ON CONFLICT (provider_type) DO UPDATE SET
            masked_hint = EXCLUDED.masked_hint,
            key_version = EXCLUDED.key_version,
            cipher_format = EXCLUDED.cipher_format,
            master_key_id = EXCLUDED.master_key_id,
            nonce = EXCLUDED.nonce,
            ciphertext = EXCLUDED.ciphertext,
            auth_tag = EXCLUDED.auth_tag,
            last_probed_at = now(),
            last_probe_status = EXCLUDED.last_probe_status,
            last_probe_count = EXCLUDED.last_probe_count,
            last_probe_error = EXCLUDED.last_probe_error,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()`,
          [
            maskedHint,
            keyVersion,
            envelope.cipher_format,
            envelope.master_key_id,
            envelope.nonce,
            envelope.ciphertext,
            envelope.auth_tag,
            input.status,
            input.status === 'connected' ? input.models.length : null,
            input.error,
            input.actor.username,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO mio_admin_probe_configs (
            provider_type, last_probed_at, last_probe_status, last_probe_count, last_probe_error, updated_by, updated_at
          ) VALUES ('onelink', now(), $1, $2, $3, $4, now())
          ON CONFLICT (provider_type) DO UPDATE SET
            last_probed_at = now(),
            last_probe_status = EXCLUDED.last_probe_status,
            last_probe_count = COALESCE(EXCLUDED.last_probe_count, mio_admin_probe_configs.last_probe_count),
            last_probe_error = EXCLUDED.last_probe_error,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()`,
          [
            input.status,
            input.status === 'connected' ? input.models.length : null,
            input.error,
            input.actor.username,
          ],
        );
      }
      await client.query(
        `INSERT INTO mio_admin_audit_logs (
          id, actor_id, actor_name, action, target_id, summary, after_state
        ) VALUES ($1, $2, $3, 'onelink.discover', 'onelink', $4, $5::jsonb)`,
        [
          createId(),
          input.actor.id,
          input.actor.username,
          input.status === 'connected'
            ? `Probed ${input.models.length} OneLink upstream models`
            : `OneLink probe failed: ${input.error ?? 'UNKNOWN'}`,
          JSON.stringify({
            status: input.status,
            discoveredCount: input.models.length,
            savedKey: Boolean(input.savedEnvelope),
            error: input.error,
          }),
        ],
      );
      const [existingRes, ignoredRes] = await Promise.all([
        client.query<{ raw_model_id: string }>(
          "SELECT raw_model_id FROM mio_provider_catalog_models WHERE provider_type='onelink'",
        ),
        client.query<{ raw_model_id: string }>(
          "SELECT raw_model_id FROM mio_admin_ignored_models WHERE provider_type='onelink'",
        ),
      ]);
      return {
        totalCatalogCount: existingRes.rows.length,
        existingIds: new Set(existingRes.rows.map((r) => r.raw_model_id)),
        ignoredIds: new Set(ignoredRes.rows.map((r) => r.raw_model_id)),
      };
    });
  }

  async readCachedDiscoveryCandidates(): Promise<{
    probeRows: readonly {
      raw_model_id: string;
      supplier_metadata: Record<string, unknown>;
      in_latest_probe: boolean;
      last_seen_at: Date;
    }[];
    existingIds: Set<string>;
    ignoredIds: Set<string>;
  }> {
    const [probeRes, existingRes, ignoredRes] = await Promise.all([
      this.pool.query<{
        raw_model_id: string;
        supplier_metadata: Record<string, unknown>;
        in_latest_probe: boolean;
        last_seen_at: Date;
      }>(
        `SELECT raw_model_id, supplier_metadata, in_latest_probe, last_seen_at
         FROM mio_admin_catalog_models
         WHERE provider_type='onelink' AND in_latest_probe=true
         ORDER BY raw_model_id COLLATE "C" ASC`,
      ),
      this.pool.query<{ raw_model_id: string }>(
        "SELECT raw_model_id FROM mio_provider_catalog_models WHERE provider_type='onelink'",
      ),
      this.pool.query<{ raw_model_id: string }>(
        "SELECT raw_model_id FROM mio_admin_ignored_models WHERE provider_type='onelink'",
      ),
    ]);
    return {
      probeRows: probeRes.rows,
      existingIds: new Set(existingRes.rows.map((r) => r.raw_model_id)),
      ignoredIds: new Set(ignoredRes.rows.map((r) => r.raw_model_id)),
    };
  }

  async clearProbeKey(actor: AdminAccountView): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `UPDATE mio_admin_probe_configs
         SET masked_hint=NULL, cipher_format=NULL, master_key_id=NULL, nonce=NULL, ciphertext=NULL, auth_tag=NULL,
             updated_by=$1, updated_at=now()
         WHERE provider_type='onelink'`,
        [actor.username],
      );
      await client.query(
        `INSERT INTO mio_admin_audit_logs (id, actor_id, actor_name, action, target_id, summary)
         VALUES ($1, $2, $3, 'onelink.probe_key.clear', 'onelink', 'Cleared saved OneLink probe key')`,
        [createId(), actor.id, actor.username],
      );
    });
  }

  async readUnifiedModelSources(): Promise<UnifiedModelRawSources> {
    const [catalog, benchmark, ignored, userStats, routes] = await Promise.all([
      this.pool.query<CatalogModelDbRow>(
        "SELECT * FROM mio_provider_catalog_models WHERE provider_type='onelink'",
      ),
      this.pool.query<{
        raw_model_id: string;
        supplier_metadata: Record<string, unknown>;
        in_latest_probe: boolean;
        last_seen_at: Date;
      }>(
        `SELECT raw_model_id, supplier_metadata, in_latest_probe, last_seen_at
         FROM mio_admin_catalog_models WHERE provider_type='onelink'`,
      ),
      this.pool.query<{
        raw_model_id: string;
        reason: string | null;
        ignored_by: string | null;
        ignored_at: Date;
      }>(
        `SELECT raw_model_id, reason, ignored_by, ignored_at
         FROM mio_admin_ignored_models WHERE provider_type='onelink'`,
      ),
      this.pool.query<{
        raw_model_id: string;
        discovered_users: number;
        verified_chat_users: number;
        verified_image_users: number;
        verified_video_users: number;
        verified_voice_users: number;
        verified_tts_users: number;
        verified_clone_users: number;
        sample_metadata: Record<string, unknown> | null;
      }>(
        `SELECT
           m.raw_model_id,
           COUNT(DISTINCT CASE
             WHEN m.membership_state = 'current'
              AND m.metadata_source = 'onelink-v1-models'
              AND c.catalog_credential_version = c.credential_version
              AND m.credential_version = c.credential_version
              AND m.catalog_version = c.catalog_version
             THEN c.id END)::int AS discovered_users,
           COUNT(DISTINCT CASE
             WHEN v.operation = 'chat'
              AND v.verification_status = 'verified'
              AND r_chat.declaration_version = v.declaration_version
              AND c.catalog_credential_version = c.credential_version
             THEN c.id END)::int AS verified_chat_users,
           COUNT(DISTINCT CASE
             WHEN v.operation = 'image.generate'
              AND v.verification_status = 'verified'
              AND r_img.declaration_version = v.declaration_version
              AND c.catalog_credential_version = c.credential_version
             THEN c.id END)::int AS verified_image_users,
           COUNT(DISTINCT CASE
             WHEN v.operation = 'video.generate'
              AND v.verification_status = 'verified'
              AND r_video.declaration_version = v.declaration_version
              AND c.catalog_credential_version = c.credential_version
             THEN c.id END)::int AS verified_video_users,
           COUNT(DISTINCT c.id) FILTER (WHERE current_audio.valid AND v.operation='audio.voices.list')::int AS verified_voice_users,
           COUNT(DISTINCT c.id) FILTER (WHERE current_audio.valid AND v.operation='audio.tts')::int AS verified_tts_users,
           COUNT(DISTINCT c.id) FILTER (WHERE current_audio.valid AND v.operation='audio.clone')::int AS verified_clone_users,
           (ARRAY_AGG(m.supplier_metadata ORDER BY m.last_seen_at DESC NULLS LAST)
             FILTER (WHERE m.metadata_source = 'onelink-v1-models'))[1] AS sample_metadata
         FROM mio_provider_models m
         JOIN mio_provider_configs c ON c.id = m.provider_id
         LEFT JOIN mio_provider_model_verifications v
           ON v.provider_id = m.provider_id AND v.model_key = m.model_key
         LEFT JOIN mio_provider_model_routes r_chat
           ON r_chat.provider_type = c.provider_type
          AND r_chat.raw_model_id = m.raw_model_id COLLATE "C"
          AND r_chat.operation = 'chat'
          AND r_chat.enabled = true
         LEFT JOIN mio_provider_model_routes r_img
           ON r_img.provider_type = c.provider_type
          AND r_img.raw_model_id = m.raw_model_id COLLATE "C"
          AND r_img.operation = 'image.generate'
          AND r_img.enabled = true
         LEFT JOIN mio_provider_model_routes r_video
           ON r_video.provider_type = c.provider_type
          AND r_video.raw_model_id = m.raw_model_id COLLATE "C"
          AND r_video.operation = 'video.generate'
          AND r_video.enabled = true
         LEFT JOIN mio_provider_model_routes r_audio
           ON r_audio.provider_type = c.provider_type
          AND r_audio.raw_model_id = m.raw_model_id COLLATE "C"
          AND r_audio.operation = v.operation
          AND r_audio.operation IN ('audio.voices.list','audio.tts','audio.clone')
          AND r_audio.enabled = true
         CROSS JOIN LATERAL (SELECT
           v.verification_status='verified' AND r_audio.declaration_version=v.declaration_version
           AND r_audio.driver=v.driver AND c.catalog_credential_version=c.credential_version
           AND v.tested_tuple->>'credentialVersion'=c.credential_version::text
           AND v.tested_tuple->>'catalogVersion'=c.catalog_version::text
           AND v.tested_tuple->>'adaptationVersion'=r_audio.declaration_version::text
           AND v.tested_tuple->>'operation'=v.operation
           AND v.tested_tuple->>'profile'=v.driver AS valid
         ) current_audio
         WHERE m.raw_model_id IS NOT NULL
         GROUP BY m.raw_model_id`,
      ),
      this.pool.query<PlatformRouteRecord & { updated_at: Date }>(
        "SELECT * FROM mio_provider_model_routes WHERE provider_type='onelink'",
      ),
    ]);
    return {
      catalogRows: catalog.rows,
      benchmarkRows: benchmark.rows,
      ignoredRows: ignored.rows,
      userStatsRows: userStats.rows,
      routeRows: routes.rows,
    };
  }

  async importCatalogModels(
    actor: AdminAccountView,
    items: readonly {
      rawModelId: string;
      displayLabel: string | null;
      vendorLabel: string | null;
      category: Category | null;
      description: string | null;
      supplierMetadata: Record<string, unknown>;
      userVisible: boolean;
      allowUndiscovered: boolean;
      callNotes: string | null;
    }[],
    overwriteMetadata: boolean,
  ): Promise<{ imported: number; updated: number; skipped: number }> {
    return this.transaction(async (client) => {
      let imported = 0;
      let updated = 0;
      let skipped = 0;
      for (const item of items) {
        const existing = (
          await client.query<CatalogModelDbRow>(
            `SELECT * FROM mio_provider_catalog_models
             WHERE provider_type='onelink' AND raw_model_id=$1 COLLATE "C" FOR UPDATE`,
            [item.rawModelId],
          )
        ).rows[0];
        await client.query(
          'DELETE FROM mio_admin_ignored_models WHERE provider_type=\'onelink\' AND raw_model_id=$1 COLLATE "C"',
          [item.rawModelId],
        );
        if (!existing) {
          await client.query(
            `INSERT INTO mio_provider_catalog_models (
               provider_type, raw_model_id, display_label, vendor_label, category, description,
               supplier_metadata, user_visible, allow_undiscovered, call_notes, origin_source, updated_by
             ) VALUES ('onelink', $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'onelink-import', $10)`,
            [
              item.rawModelId,
              item.displayLabel,
              item.vendorLabel,
              item.category,
              item.description,
              JSON.stringify(item.supplierMetadata),
              item.userVisible,
              item.allowUndiscovered,
              item.callNotes,
              actor.username,
            ],
          );
          if (item.allowUndiscovered && item.userVisible) {
            await materializeCuratedModelForActiveProviders(
              client,
              item.rawModelId,
              item.displayLabel,
            );
          }
          imported += 1;
        } else if (overwriteMetadata) {
          await client.query(
            `UPDATE mio_provider_catalog_models SET
               display_label = COALESCE($2, display_label),
               vendor_label = COALESCE($3, vendor_label),
               category = COALESCE($4, category),
               description = COALESCE($5, description),
               supplier_metadata = $6::jsonb,
               updated_by = $7,
               updated_at = now()
             WHERE provider_type='onelink' AND raw_model_id=$1 COLLATE "C"`,
            [
              item.rawModelId,
              item.displayLabel,
              item.vendorLabel,
              item.category,
              item.description,
              JSON.stringify(item.supplierMetadata),
              actor.username,
            ],
          );
          updated += 1;
        } else {
          skipped += 1;
        }
      }
      await client.query(
        `INSERT INTO mio_admin_audit_logs (
           id, actor_id, actor_name, action, target_id, summary, after_state
         ) VALUES ($1, $2, $3, 'models.import', 'onelink', $4, $5::jsonb)`,
        [
          createId(),
          actor.id,
          actor.username,
          `Imported ${imported} models (updated ${updated}, skipped ${skipped})`,
          JSON.stringify({
            imported,
            updated,
            skipped,
            modelIds: items.slice(0, 50).map((i) => i.rawModelId),
          }),
        ],
      );
      return { imported, updated, skipped };
    });
  }

  async createCatalogModel(
    actor: AdminAccountView,
    input: {
      rawModelId: string;
      displayLabel: string | null;
      vendorLabel: string | null;
      category: Category | null;
      description: string | null;
      userVisible: boolean;
      allowUndiscovered: boolean;
      callNotes: string | null;
      originSource?: PlatformModelOriginSource;
    },
  ): Promise<PlatformCatalogModelRecord> {
    return this.transaction(async (client) => {
      const existing = (
        await client.query(
          `SELECT 1 FROM mio_provider_catalog_models
           WHERE provider_type='onelink' AND raw_model_id=$1 COLLATE "C" FOR UPDATE`,
          [input.rawModelId],
        )
      ).rows[0];
      if (existing) throw new AdminError(HTTP_STATUS.CONFLICT, 'MODEL_ALREADY_EXISTS');
      await client.query(
        'DELETE FROM mio_admin_ignored_models WHERE provider_type=\'onelink\' AND raw_model_id=$1 COLLATE "C"',
        [input.rawModelId],
      );
      const inserted = (
        await client.query<CatalogModelDbRow>(
          `INSERT INTO mio_provider_catalog_models (
             provider_type, raw_model_id, display_label, vendor_label, category, description,
             user_visible, allow_undiscovered, call_notes, origin_source, updated_by
           ) VALUES ('onelink', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            input.rawModelId,
            input.displayLabel,
            input.vendorLabel,
            input.category,
            input.description,
            input.userVisible,
            input.allowUndiscovered,
            input.callNotes,
            input.originSource ?? 'admin-manual',
            actor.username,
          ],
        )
      ).rows[0]!;
      if (input.allowUndiscovered && input.userVisible) {
        await materializeCuratedModelForActiveProviders(
          client,
          input.rawModelId,
          input.displayLabel,
        );
      }
      await client.query(
        `INSERT INTO mio_admin_audit_logs (
           id, actor_id, actor_name, action, target_id, summary, after_state
         ) VALUES ($1, $2, $3, 'model.create', $4, $5, $6::jsonb)`,
        [
          createId(),
          actor.id,
          actor.username,
          input.rawModelId,
          `Created platform model ${input.rawModelId}`,
          JSON.stringify(toCatalogRecord(inserted)),
        ],
      );
      return toCatalogRecord(inserted);
    });
  }

  async updateCatalogModel(
    actor: AdminAccountView,
    input: {
      rawModelId: string;
      displayLabel?: string | null;
      vendorLabel?: string | null;
      category?: Category | null;
      description?: string | null;
      userVisible?: boolean;
      allowUndiscovered?: boolean;
      callNotes?: string | null;
    },
  ): Promise<PlatformCatalogModelRecord> {
    return this.transaction(async (client) => {
      const before = (
        await client.query<CatalogModelDbRow>(
          `SELECT * FROM mio_provider_catalog_models
           WHERE provider_type='onelink' AND raw_model_id=$1 COLLATE "C" FOR UPDATE`,
          [input.rawModelId],
        )
      ).rows[0];
      if (!before) throw new AdminError(HTTP_STATUS.NOT_FOUND, 'MODEL_NOT_FOUND');
      const nextDisplayLabel =
        input.displayLabel !== undefined ? input.displayLabel : before.display_label;
      const nextVendorLabel =
        input.vendorLabel !== undefined ? input.vendorLabel : before.vendor_label;
      const nextCategory = input.category !== undefined ? input.category : before.category;
      const nextDescription =
        input.description !== undefined ? input.description : before.description;
      const nextUserVisible =
        input.userVisible !== undefined ? input.userVisible : before.user_visible;
      const nextAllowUndiscovered =
        input.allowUndiscovered !== undefined ? input.allowUndiscovered : before.allow_undiscovered;
      const nextCallNotes = input.callNotes !== undefined ? input.callNotes : before.call_notes;
      const updated = (
        await client.query<CatalogModelDbRow>(
          `UPDATE mio_provider_catalog_models SET
             display_label = $2,
             vendor_label = $3,
             category = $4,
             description = $5,
             user_visible = $6,
             allow_undiscovered = $7,
             call_notes = $8,
             updated_by = $9,
             updated_at = now()
           WHERE provider_type='onelink' AND raw_model_id=$1 COLLATE "C"
           RETURNING *`,
          [
            input.rawModelId,
            nextDisplayLabel,
            nextVendorLabel,
            nextCategory,
            nextDescription,
            nextUserVisible,
            nextAllowUndiscovered,
            nextCallNotes,
            actor.username,
          ],
        )
      ).rows[0]!;
      if (nextAllowUndiscovered && nextUserVisible) {
        await materializeCuratedModelForActiveProviders(client, input.rawModelId, nextDisplayLabel);
      }
      await client.query(
        `INSERT INTO mio_admin_audit_logs (
           id, actor_id, actor_name, action, target_id, summary, before_state, after_state
         ) VALUES ($1, $2, $3, 'model.update', $4, $5, $6::jsonb, $7::jsonb)`,
        [
          createId(),
          actor.id,
          actor.username,
          input.rawModelId,
          `Updated model ${input.rawModelId} (visible=${nextUserVisible}, curated=${nextAllowUndiscovered})`,
          JSON.stringify(toCatalogRecord(before)),
          JSON.stringify(toCatalogRecord(updated)),
        ],
      );
      return toCatalogRecord(updated);
    });
  }

  async modelExistsInCatalog(rawModelId: string): Promise<boolean> {
    const res = await this.pool.query(
      'SELECT 1 FROM mio_provider_catalog_models WHERE provider_type=\'onelink\' AND raw_model_id=$1 COLLATE "C"',
      [rawModelId],
    );
    return res.rows.length > 0;
  }

  async deleteCatalogModel(
    actor: AdminAccountView,
    input: {
      rawModelId: string;
      ignoreFutureImports: boolean;
      summary: string | null;
      deletedRoutesCount: number;
    },
  ): Promise<void> {
    await this.transaction(async (client) => {
      const before = (
        await client.query<CatalogModelDbRow>(
          `SELECT * FROM mio_provider_catalog_models
           WHERE provider_type='onelink' AND raw_model_id=$1 COLLATE "C" FOR UPDATE`,
          [input.rawModelId],
        )
      ).rows[0];
      if (!before) throw new AdminError(HTTP_STATUS.NOT_FOUND, 'MODEL_NOT_FOUND');
      await client.query(
        'DELETE FROM mio_provider_catalog_models WHERE provider_type=\'onelink\' AND raw_model_id=$1 COLLATE "C"',
        [input.rawModelId],
      );
      if (input.ignoreFutureImports) {
        await client.query(
          `INSERT INTO mio_admin_ignored_models (provider_type, raw_model_id, reason, ignored_by, ignored_at)
           VALUES ('onelink', $1, $2, $3, now())
           ON CONFLICT (provider_type, raw_model_id) DO UPDATE SET
             reason = EXCLUDED.reason,
             ignored_by = EXCLUDED.ignored_by,
             ignored_at = now()`,
          [input.rawModelId, input.summary, actor.username],
        );
      }
      await client.query(
        `INSERT INTO mio_admin_audit_logs (
           id, actor_id, actor_name, action, target_id, summary, before_state, after_state
         ) VALUES ($1, $2, $3, 'model.delete', $4, $5, $6::jsonb, $7::jsonb)`,
        [
          createId(),
          actor.id,
          actor.username,
          input.rawModelId,
          input.summary ?? `Deleted model ${input.rawModelId}`,
          JSON.stringify(toCatalogRecord(before)),
          JSON.stringify({
            deleted: true,
            ignoreFutureImports: input.ignoreFutureImports,
            deletedRoutesCount: input.deletedRoutesCount,
          }),
        ],
      );
    });
  }

  async listTemplates(): Promise<AdminRouteTemplateView[]> {
    const res = await this.pool.query<RouteTemplateRow>(
      'SELECT * FROM mio_admin_route_templates ORDER BY sort_order ASC, label ASC, template_key ASC',
    );
    return res.rows.map(toTemplateView);
  }

  async createTemplate(
    actor: AdminAccountView,
    input: {
      templateKey: string;
      label: string;
      description: string;
      operation: ProviderOperation;
      vendor: string;
      driver: string;
      routeTemplate: Record<string, unknown>;
      uiHints: AdminRouteTemplateUiHints;
      sortOrder: number;
    },
  ): Promise<AdminRouteTemplateView> {
    return this.transaction(async (client) => {
      const id = createId();
      const inserted = (
        await client.query<RouteTemplateRow>(
          `INSERT INTO mio_admin_route_templates (
             id, template_key, label, description, operation, vendor, driver,
             route_template, ui_hints, sort_order, updated_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
           RETURNING *`,
          [
            id,
            input.templateKey,
            input.label,
            input.description,
            input.operation,
            input.vendor,
            input.driver,
            JSON.stringify(input.routeTemplate),
            JSON.stringify(input.uiHints),
            input.sortOrder,
            actor.username,
          ],
        )
      ).rows[0]!;
      const view = toTemplateView(inserted);
      await client.query(
        `INSERT INTO mio_admin_audit_logs (
           id, actor_id, actor_name, action, target_id, summary, after_state
         ) VALUES ($1, $2, $3, 'template.create', $4, $5, $6::jsonb)`,
        [
          createId(),
          actor.id,
          actor.username,
          view.templateKey,
          `Created route template ${view.label} (${view.templateKey})`,
          JSON.stringify(view),
        ],
      );
      return view;
    });
  }

  async updateTemplate(
    actor: AdminAccountView,
    input: {
      id: string;
      templateKey: string;
      label: string;
      description: string;
      operation: ProviderOperation;
      vendor: string;
      driver: string;
      routeTemplate: Record<string, unknown>;
      uiHints: AdminRouteTemplateUiHints;
      sortOrder: number;
    },
  ): Promise<AdminRouteTemplateView> {
    return this.transaction(async (client) => {
      const before = (
        await client.query<RouteTemplateRow>(
          'SELECT * FROM mio_admin_route_templates WHERE id=$1 FOR UPDATE',
          [input.id],
        )
      ).rows[0];
      if (!before) throw new AdminError(HTTP_STATUS.NOT_FOUND, 'TEMPLATE_NOT_FOUND');
      const updated = (
        await client.query<RouteTemplateRow>(
          `UPDATE mio_admin_route_templates SET
             template_key = $2,
             label = $3,
             description = $4,
             operation = $5,
             vendor = $6,
             driver = $7,
             route_template = $8::jsonb,
             ui_hints = $9::jsonb,
             sort_order = $10,
             updated_by = $11,
             updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [
            input.id,
            input.templateKey,
            input.label,
            input.description,
            input.operation,
            input.vendor,
            input.driver,
            JSON.stringify(input.routeTemplate),
            JSON.stringify(input.uiHints),
            input.sortOrder,
            actor.username,
          ],
        )
      ).rows[0]!;
      const view = toTemplateView(updated);
      await client.query(
        `INSERT INTO mio_admin_audit_logs (
           id, actor_id, actor_name, action, target_id, summary, before_state, after_state
         ) VALUES ($1, $2, $3, 'template.update', $4, $5, $6::jsonb, $7::jsonb)`,
        [
          createId(),
          actor.id,
          actor.username,
          view.templateKey,
          `Updated route template ${view.label} (${view.templateKey})`,
          JSON.stringify(toTemplateView(before)),
          JSON.stringify(view),
        ],
      );
      return view;
    });
  }

  async deleteTemplate(actor: AdminAccountView, id: string): Promise<void> {
    await this.transaction(async (client) => {
      const before = (
        await client.query<RouteTemplateRow>(
          'SELECT * FROM mio_admin_route_templates WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!before) throw new AdminError(HTTP_STATUS.NOT_FOUND, 'TEMPLATE_NOT_FOUND');
      await client.query('DELETE FROM mio_admin_route_templates WHERE id=$1', [id]);
      await client.query(
        `INSERT INTO mio_admin_audit_logs (
           id, actor_id, actor_name, action, target_id, summary, before_state
         ) VALUES ($1, $2, $3, 'template.delete', $4, $5, $6::jsonb)`,
        [
          createId(),
          actor.id,
          actor.username,
          before.template_key,
          `Deleted route template ${before.label} (${before.template_key})`,
          JSON.stringify(toTemplateView(before)),
        ],
      );
    });
  }

  async findRouteRevision(revisionId: string): Promise<PlatformRouteRevisionRecord | null> {
    return (
      (
        await this.pool.query<PlatformRouteRevisionRecord>(
          'SELECT * FROM mio_provider_model_route_revisions WHERE id=$1',
          [revisionId],
        )
      ).rows[0] ?? null
    );
  }

  async listRevisions(rawModelId: string | undefined, limit: number): Promise<AdminRevisionsView> {
    const [routeRevisions, auditLogs] = await Promise.all([
      rawModelId
        ? this.pool.query<PlatformRouteRevisionRecord>(
            `SELECT * FROM mio_provider_model_route_revisions
             WHERE provider_type='onelink' AND raw_model_id=$1 COLLATE "C"
             ORDER BY created_at DESC, declaration_version DESC LIMIT $2`,
            [rawModelId, limit],
          )
        : this.pool.query<PlatformRouteRevisionRecord>(
            `SELECT * FROM mio_provider_model_route_revisions
             WHERE provider_type='onelink'
             ORDER BY created_at DESC, declaration_version DESC LIMIT $1`,
            [limit],
          ),
      rawModelId
        ? this.pool.query<{
            id: string;
            actor_id: string | null;
            actor_name: string;
            action: string;
            target_id: string | null;
            summary: string | null;
            before_state: Record<string, unknown> | null;
            after_state: Record<string, unknown> | null;
            created_at: Date;
          }>(
            `SELECT * FROM mio_admin_audit_logs
             WHERE target_id=$1 ORDER BY created_at DESC LIMIT $2`,
            [rawModelId, limit],
          )
        : this.pool.query<{
            id: string;
            actor_id: string | null;
            actor_name: string;
            action: string;
            target_id: string | null;
            summary: string | null;
            before_state: Record<string, unknown> | null;
            after_state: Record<string, unknown> | null;
            created_at: Date;
          }>('SELECT * FROM mio_admin_audit_logs ORDER BY created_at DESC LIMIT $1', [limit]),
    ]);
    return {
      routeRevisions: routeRevisions.rows,
      auditLogs: auditLogs.rows.map((row): AdminAuditLogRecord => ({
        id: row.id,
        actorId: row.actor_id,
        actorName: row.actor_name,
        action: row.action,
        targetId: row.target_id,
        summary: row.summary,
        beforeState: row.before_state,
        afterState: row.after_state,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  async readMonitoring(window: MonitoringWindow) {
    const interval = windowInterval(window);
    const providerHealth = (
      await this.pool.query<{
        total_accounts: number;
        enabled_accounts: number;
        valid_accounts: number;
        rejected_accounts: number;
        unchecked_accounts: number;
      }>(
        `SELECT
           COUNT(*)::int AS total_accounts,
           COUNT(*) FILTER (WHERE enabled)::int AS enabled_accounts,
           COUNT(*) FILTER (WHERE credential_auth_state='valid')::int AS valid_accounts,
           COUNT(*) FILTER (WHERE credential_auth_state='rejected')::int AS rejected_accounts,
           COUNT(*) FILTER (WHERE credential_auth_state='unchecked')::int AS unchecked_accounts
         FROM mio_provider_configs`,
      )
    ).rows[0]!;

    const [images, conversations, compute] = await Promise.all([
      this.readImageMonitoring(interval),
      this.readConversationMonitoring(interval),
      this.readComputeMonitoring(interval),
    ]);
    return {
      window,
      generatedAt: utcISOString(),
      providers: {
        totalAccounts: providerHealth.total_accounts,
        enabledAccounts: providerHealth.enabled_accounts,
        validAccounts: providerHealth.valid_accounts,
        rejectedAccounts: providerHealth.rejected_accounts,
        uncheckedAccounts: providerHealth.unchecked_accounts,
      },
      images,
      conversations,
      compute,
    };
  }

  private async readComputeMonitoring(
    interval: string | null,
  ): Promise<AdminComputeMonitoringSummary> {
    if (!this.mediaPool) {
      return {
        enabled: false,
        jobs: { total: 0, accepted: 0, queued: 0, running: 0, succeeded: 0, failed: 0 },
        outbox: { pending: 0, leased: 0, oldestUnsentAgeSeconds: null },
        inboxProcessed: 0,
      };
    }
    const exists = (
      await this.mediaPool.query<{ jobs: string | null; outbox: string | null }>(
        `SELECT
           to_regclass('mio_compute_jobs')::text AS jobs,
           to_regclass('mio_compute_outbox')::text AS outbox`,
      )
    ).rows[0];
    if (!exists?.jobs || !exists.outbox) {
      return {
        enabled: false,
        jobs: { total: 0, accepted: 0, queued: 0, running: 0, succeeded: 0, failed: 0 },
        outbox: { pending: 0, leased: 0, oldestUnsentAgeSeconds: null },
        inboxProcessed: 0,
      };
    }
    const whereClause = interval ? 'WHERE created_at >= now() - $1::interval' : '';
    const params = interval ? [interval] : [];
    const [jobsRes, outboxRes, inboxRes] = await Promise.all([
      this.mediaPool.query<{
        total: number;
        accepted: number;
        queued: number;
        running: number;
        succeeded: number;
        failed: number;
      }>(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE state='accepted')::int AS accepted,
           COUNT(*) FILTER (WHERE state='queued')::int AS queued,
           COUNT(*) FILTER (WHERE state='running')::int AS running,
           COUNT(*) FILTER (WHERE state='succeeded')::int AS succeeded,
           COUNT(*) FILTER (WHERE state='failed')::int AS failed
         FROM mio_compute_jobs
         ${whereClause}`,
        params,
      ),
      this.mediaPool.query<{
        pending: number;
        leased: number;
        oldest_age_sec: number | null;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE sent_at IS NULL)::int AS pending,
           COUNT(*) FILTER (WHERE sent_at IS NULL AND lease_until > now())::int AS leased,
           (MAX(EXTRACT(EPOCH FROM (now() - created_at))) FILTER (WHERE sent_at IS NULL))::int AS oldest_age_sec
         FROM mio_compute_outbox`,
      ),
      this.mediaPool.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM mio_compute_inbox',
      ),
    ]);
    const j = jobsRes.rows[0]!;
    const o = outboxRes.rows[0]!;
    return {
      enabled: true,
      jobs: {
        total: j.total,
        accepted: j.accepted,
        queued: j.queued,
        running: j.running,
        succeeded: j.succeeded,
        failed: j.failed,
      },
      outbox: {
        pending: o.pending,
        leased: o.leased,
        oldestUnsentAgeSeconds: o.oldest_age_sec ?? null,
      },
      inboxProcessed: inboxRes.rows[0]?.count ?? 0,
    };
  }

  private async readImageMonitoring(interval: string | null) {
    if (!this.mediaPool) {
      return {
        enabled: false,
        totals: {
          total: 0,
          completed: 0,
          inFlight: 0,
          rejected: 0,
          upstreamFailed: 0,
          storageFailed: 0,
        },
        byModel: [],
        recentJobs: [],
      };
    }
    const exists = (
      await this.mediaPool.query<{ reg: string | null }>(
        "SELECT to_regclass('mio_image_jobs')::text AS reg",
      )
    ).rows[0]?.reg;
    if (!exists) {
      return {
        enabled: false,
        totals: {
          total: 0,
          completed: 0,
          inFlight: 0,
          rejected: 0,
          upstreamFailed: 0,
          storageFailed: 0,
        },
        byModel: [],
        recentJobs: [],
      };
    }
    const whereClause = interval ? 'WHERE j.created_at >= now() - $1::interval' : '';
    const params = interval ? [interval] : [];
    const [totalsRes, byModelRes, recentRes] = await Promise.all([
      this.mediaPool.query<{
        total: number;
        completed: number;
        in_flight: number;
        rejected: number;
        upstream_failed: number;
        storage_failed: number;
      }>(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE j.state='completed')::int AS completed,
           COUNT(*) FILTER (WHERE j.state IN ('accepted','submitted','processing','materializing'))::int AS in_flight,
           COUNT(*) FILTER (WHERE j.state='rejected')::int AS rejected,
           COUNT(*) FILTER (WHERE j.state IN ('failed','unknown') AND NOT COALESCE(e.storage_failed, false))::int AS upstream_failed,
           COUNT(*) FILTER (WHERE j.state IN ('materialization_failed','partial') OR COALESCE(e.storage_failed, false))::int AS storage_failed
         FROM mio_image_jobs j
         LEFT JOIN mio_image_executions e ON e.job_id = j.id
         ${whereClause}`,
        params,
      ),
      this.mediaPool.query<{
        model_id: string;
        driver: string;
        total: number;
        completed: number;
        in_flight: number;
        rejected: number;
        upstream_failed: number;
        storage_failed: number;
      }>(
        `SELECT
           COALESCE(j.command->>'model', 'unknown') AS model_id,
           COALESCE(j.route_snapshot->>'driver', 'unknown') AS driver,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE j.state='completed')::int AS completed,
           COUNT(*) FILTER (WHERE j.state IN ('accepted','submitted','processing','materializing'))::int AS in_flight,
           COUNT(*) FILTER (WHERE j.state='rejected')::int AS rejected,
           COUNT(*) FILTER (WHERE j.state IN ('failed','unknown') AND NOT COALESCE(e.storage_failed, false))::int AS upstream_failed,
           COUNT(*) FILTER (WHERE j.state IN ('materialization_failed','partial') OR COALESCE(e.storage_failed, false))::int AS storage_failed
         FROM mio_image_jobs j
         LEFT JOIN mio_image_executions e ON e.job_id = j.id
         ${whereClause}
         GROUP BY 1, 2
         ORDER BY total DESC, model_id ASC`,
        params,
      ),
      this.mediaPool.query<{
        id: string;
        model_id: string;
        driver: string;
        state: string;
        phase: string | null;
        storage_failed: boolean;
        query_attempt: number;
        error_code: string | null;
        output_count: number;
        created_at: Date;
      }>(
        `SELECT
           j.id,
           COALESCE(j.command->>'model', 'unknown') AS model_id,
           COALESCE(j.route_snapshot->>'driver', 'unknown') AS driver,
           j.state,
           e.phase,
           COALESCE(e.storage_failed, false) AS storage_failed,
           j.query_attempt,
           j.error_code,
           (SELECT COUNT(*)::int FROM mio_image_outputs o WHERE o.job_id = j.id) AS output_count,
           j.created_at
         FROM mio_image_jobs j
         LEFT JOIN mio_image_executions e ON e.job_id = j.id
         ${whereClause}
         ORDER BY j.created_at DESC
         LIMIT 30`,
        params,
      ),
    ]);
    const totals = totalsRes.rows[0]!;
    return {
      enabled: true,
      totals: {
        total: totals.total,
        completed: totals.completed,
        inFlight: totals.in_flight,
        rejected: totals.rejected,
        upstreamFailed: totals.upstream_failed,
        storageFailed: totals.storage_failed,
      },
      byModel: byModelRes.rows.map((row) => ({
        modelId: row.model_id,
        driver: row.driver,
        total: row.total,
        completed: row.completed,
        inFlight: row.in_flight,
        rejected: row.rejected,
        upstreamFailed: row.upstream_failed,
        storageFailed: row.storage_failed,
      })),
      recentJobs: recentRes.rows.map((row) => ({
        id: row.id,
        modelId: row.model_id,
        driver: row.driver,
        state: row.state,
        phase: row.phase,
        storageFailed: row.storage_failed,
        queryAttempt: row.query_attempt,
        errorCode: sanitizeErrorCode(row.error_code),
        outputCount: row.output_count,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  private async readConversationMonitoring(interval: string | null) {
    if (!this.conversationsPool) {
      return {
        enabled: false,
        totals: { total: 0, completed: 0, inFlight: 0, failed: 0, cancelled: 0, unknown: 0 },
        byModel: [],
        recentRequests: [],
      };
    }
    const exists = (
      await this.conversationsPool.query<{ reg: string | null }>(
        "SELECT to_regclass('mio_conversation_requests')::text AS reg",
      )
    ).rows[0]?.reg;
    if (!exists) {
      return {
        enabled: false,
        totals: { total: 0, completed: 0, inFlight: 0, failed: 0, cancelled: 0, unknown: 0 },
        byModel: [],
        recentRequests: [],
      };
    }
    const whereClause = interval ? 'WHERE r.created_at >= now() - $1::interval' : '';
    const params = interval ? [interval] : [];
    const [totalsRes, byModelRes, recentRes] = await Promise.all([
      this.conversationsPool.query<{
        total: number;
        completed: number;
        in_flight: number;
        failed: number;
        cancelled: number;
        unknown: number;
      }>(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE r.status='completed')::int AS completed,
           COUNT(*) FILTER (WHERE r.status IN ('accepted','input-persisted'))::int AS in_flight,
           COUNT(*) FILTER (WHERE r.status='failed')::int AS failed,
           COUNT(*) FILTER (WHERE r.status='cancelled')::int AS cancelled,
           COUNT(*) FILTER (WHERE r.status='unknown')::int AS unknown
         FROM mio_conversation_requests r
         ${whereClause}`,
        params,
      ),
      this.conversationsPool.query<{
        model_id: string;
        protocol: string;
        total: number;
        completed: number;
        failed: number;
        cancelled: number;
      }>(
        `SELECT
           COALESCE(r.model_binding->>'modelId', 'fixed-route') AS model_id,
           COALESCE(r.model_binding->>'protocol', 'default') AS protocol,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE r.status='completed')::int AS completed,
           COUNT(*) FILTER (WHERE r.status IN ('failed','unknown'))::int AS failed,
           COUNT(*) FILTER (WHERE r.status='cancelled')::int AS cancelled
         FROM mio_conversation_requests r
         ${whereClause}
         GROUP BY 1, 2
         ORDER BY total DESC, model_id ASC`,
        params,
      ),
      this.conversationsPool.query<{
        conversation_id: string;
        request_id: string;
        model_id: string;
        status: string;
        error_code: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT
           r.conversation_id,
           r.request_id,
           COALESCE(r.model_binding->>'modelId', 'fixed-route') AS model_id,
           r.status,
           r.error_code,
           r.created_at,
           r.updated_at
         FROM mio_conversation_requests r
         ${whereClause}
         ORDER BY r.created_at DESC
         LIMIT 25`,
        params,
      ),
    ]);
    const totals = totalsRes.rows[0]!;
    return {
      enabled: true,
      totals: {
        total: totals.total,
        completed: totals.completed,
        inFlight: totals.in_flight,
        failed: totals.failed,
        cancelled: totals.cancelled,
        unknown: totals.unknown,
      },
      byModel: byModelRes.rows.map((row) => ({
        modelId: row.model_id,
        protocol: row.protocol,
        total: row.total,
        completed: row.completed,
        failed: row.failed,
        cancelled: row.cancelled,
      })),
      recentRequests: recentRes.rows.map((row) => ({
        conversationId: row.conversation_id,
        requestId: row.request_id,
        modelId: row.model_id,
        status: row.status,
        errorCode: sanitizeErrorCode(row.error_code),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
    };
  }

  readCreationLogSettings() {
    return readCreationLogSettings(this.pool);
  }

  updateCreationLogSettings(
    actor: AdminAccountView,
    expectedRevision: number,
    retentionDays: number,
  ) {
    return this.transaction((client) =>
      saveCreationLogSettings(client, actor, expectedRevision, retentionDays),
    );
  }

  readStorageSettings() {
    return readStorageSettings(this.pool);
  }

  updateStorageSettings(
    actor: AdminAccountView,
    input: ReturnType<typeof validateStorageSettingsUpdate>,
  ) {
    return this.transaction((client) => saveStorageSettings(client, actor, input));
  }

  async readGlobalAuthSettings(): Promise<AdminStoredAuthSettings | null> {
    const row = (
      await this.pool.query<GlobalSettingsRow>(
        "SELECT setting_key, value, revision, updated_by, created_at, updated_at FROM mio_admin_global_settings WHERE setting_key = 'auth'",
      )
    ).rows[0];
    return row ? toStoredAuthSettings(row) : null;
  }

  async updateGlobalAuthSettings(
    actor: AdminAccountView,
    input: {
      expectedRevision: number;
      auth: AuthRuntimePolicy;
    },
  ): Promise<AdminStoredAuthSettings> {
    return this.transaction(async (client) => {
      const serializedValue = JSON.stringify({
        emailPasswordEnabled: input.auth.emailPasswordEnabled,
        smsMode: input.auth.smsMode,
        smsBypassCode: input.auth.smsBypassCode,
      });
      let beforeState: Record<string, unknown> | null = null;
      let updatedRow: GlobalSettingsRow | undefined;

      if (input.expectedRevision === 0) {
        updatedRow = (
          await client.query<GlobalSettingsRow>(
            `INSERT INTO mio_admin_global_settings (setting_key, value, revision, updated_by)
             VALUES ('auth', $1::jsonb, 1, $2)
             ON CONFLICT (setting_key) DO NOTHING
             RETURNING setting_key, value, revision, updated_by, created_at, updated_at`,
            [serializedValue, actor.username],
          )
        ).rows[0];
        if (!updatedRow) {
          throw new AdminError(HTTP_STATUS.CONFLICT, 'SETTINGS_CONFLICT');
        }
      } else {
        const existing = (
          await client.query<Pick<GlobalSettingsRow, 'value' | 'revision'>>(
            "SELECT value, revision FROM mio_admin_global_settings WHERE setting_key = 'auth' FOR UPDATE",
          )
        ).rows[0];
        if (!existing || existing.revision !== input.expectedRevision) {
          throw new AdminError(HTTP_STATUS.CONFLICT, 'SETTINGS_CONFLICT');
        }
        beforeState = toAuditAuthState(parseStoredAuthPolicy(existing.value), existing.revision);
        updatedRow = (
          await client.query<GlobalSettingsRow>(
            `UPDATE mio_admin_global_settings
             SET value = $1::jsonb, revision = revision + 1, updated_by = $2, updated_at = now()
             WHERE setting_key = 'auth' AND revision = $3
             RETURNING setting_key, value, revision, updated_by, created_at, updated_at`,
            [serializedValue, actor.username, input.expectedRevision],
          )
        ).rows[0];
        if (!updatedRow) {
          throw new AdminError(HTTP_STATUS.CONFLICT, 'SETTINGS_CONFLICT');
        }
      }

      const saved = toStoredAuthSettings(updatedRow);
      await client.query(
        `INSERT INTO mio_admin_audit_logs (
           id, actor_id, actor_name, action, target_id, summary, before_state, after_state
         ) VALUES ($1, $2, $3, 'settings.global.update', 'auth', $4, $5::jsonb, $6::jsonb)`,
        [
          createId(),
          actor.id,
          actor.username,
          `Updated global auth settings (emailPassword=${saved.auth.emailPasswordEnabled}, smsMode=${saved.auth.smsMode}, rev=${saved.revision})`,
          beforeState ? JSON.stringify(beforeState) : null,
          JSON.stringify(toAuditAuthState(saved.auth, saved.revision)),
        ],
      );
      return saved;
    });
  }

  async readOneLinkSsoConfig(environment: string): Promise<AdminOneLinkSsoConfigView | null> {
    const row = (
      await this.pool.query<OneLinkSsoConfigRow>(
        `SELECT ${ONELINK_SSO_COLUMNS} FROM mio_admin_onelink_sso_config WHERE environment = $1`,
        [environment],
      )
    ).rows[0];
    return row ? toOneLinkSsoConfigView(row) : null;
  }

  async updateOneLinkSsoConfig(
    actor: AdminAccountView,
    environment: string,
    input: {
      expectedRevision: number;
      enabled: boolean;
      expectedClientId?: string | null;
      clientName: string;
    },
  ): Promise<AdminOneLinkSsoConfigView> {
    return this.transaction(async (client) => {
      let beforeState: Record<string, unknown> | null = null;
      let updatedRow: OneLinkSsoConfigRow | undefined;

      if (input.expectedRevision === 0) {
        const expectedClientId = input.expectedClientId ?? null;
        updatedRow = (
          await client.query<OneLinkSsoConfigRow>(
            `INSERT INTO mio_admin_onelink_sso_config (
               environment, enabled, client_name, expected_client_id, revision, updated_by
             ) VALUES ($1, $2, $3, $4, 1, $5)
             ON CONFLICT (environment) DO NOTHING
             RETURNING ${ONELINK_SSO_COLUMNS}`,
            [environment, input.enabled, input.clientName, expectedClientId, actor.username],
          )
        ).rows[0];
        if (!updatedRow) {
          throw new AdminError(HTTP_STATUS.CONFLICT, 'SETTINGS_CONFLICT');
        }
      } else {
        const existing = (
          await client.query<OneLinkSsoConfigRow>(
            `SELECT ${ONELINK_SSO_COLUMNS} FROM mio_admin_onelink_sso_config WHERE environment = $1 FOR UPDATE`,
            [environment],
          )
        ).rows[0];
        if (!existing || existing.revision !== input.expectedRevision) {
          throw new AdminError(HTTP_STATUS.CONFLICT, 'SETTINGS_CONFLICT');
        }
        beforeState = toAuditOneLinkSsoState(toOneLinkSsoConfigView(existing));
        const nextExpectedClientId =
          input.expectedClientId === undefined
            ? existing.expected_client_id
            : input.expectedClientId;
        updatedRow = (
          await client.query<OneLinkSsoConfigRow>(
            `UPDATE mio_admin_onelink_sso_config
             SET enabled = $2, client_name = $3, expected_client_id = $4,
                 revision = revision + 1, updated_by = $5, updated_at = now()
             WHERE environment = $1 AND revision = $6
             RETURNING ${ONELINK_SSO_COLUMNS}`,
            [
              environment,
              input.enabled,
              input.clientName,
              nextExpectedClientId,
              actor.username,
              input.expectedRevision,
            ],
          )
        ).rows[0];
        if (!updatedRow) {
          throw new AdminError(HTTP_STATUS.CONFLICT, 'SETTINGS_CONFLICT');
        }
      }

      const saved = toOneLinkSsoConfigView(updatedRow);
      await client.query(
        `INSERT INTO mio_admin_audit_logs (
           id, actor_id, actor_name, action, target_id, summary, before_state, after_state
         ) VALUES ($1, $2, $3, 'onelink.sso.update', $4, $5, $6::jsonb, $7::jsonb)`,
        [
          createId(),
          actor.id,
          actor.username,
          environment,
          `Updated OneLink SSO config (env=${environment}, enabled=${saved.enabled}, rev=${saved.revision})`,
          beforeState ? JSON.stringify(beforeState) : null,
          JSON.stringify(toAuditOneLinkSsoState(saved)),
        ],
      );
      return saved;
    });
  }

  async recordOneLinkSsoRegistration(
    actor: AdminAccountView,
    environment: string,
    clientName: string,
    result: OneLinkSsoRegisterResult,
  ): Promise<AdminOneLinkSsoConfigView | null> {
    return this.transaction(async (client) => {
      const existing = (
        await client.query<OneLinkSsoConfigRow>(
          `SELECT ${ONELINK_SSO_COLUMNS} FROM mio_admin_onelink_sso_config WHERE environment = $1 FOR UPDATE`,
          [environment],
        )
      ).rows[0];

      if (result.kind === 'registered') {
        const beforeState = existing
          ? toAuditOneLinkSsoState(toOneLinkSsoConfigView(existing))
          : null;
        const row = (
          await client.query<OneLinkSsoConfigRow>(
            `INSERT INTO mio_admin_onelink_sso_config (
               environment, enabled, client_name, client_id, expected_client_id,
               registration_status, registration_source,
               last_register_code, last_register_trace_id, last_register_message,
               last_registered_at, revision, updated_by
             ) VALUES (
               $1, false, $2, $3, NULL,
               'registered', 'register_200',
               200, $4, 'registered',
               now(), 1, $5
             )
             ON CONFLICT (environment) DO UPDATE SET
               client_name = EXCLUDED.client_name,
               client_id = EXCLUDED.client_id,
               registration_status = 'registered',
               registration_source = 'register_200',
               last_register_code = 200,
               last_register_trace_id = EXCLUDED.last_register_trace_id,
               last_register_message = EXCLUDED.last_register_message,
               last_registered_at = now(),
               revision = mio_admin_onelink_sso_config.revision + 1,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()
             RETURNING ${ONELINK_SSO_COLUMNS}`,
            [environment, result.clientName, result.clientId, result.traceId, actor.username],
          )
        ).rows[0]!;
        const saved = toOneLinkSsoConfigView(row);
        await client.query(
          `INSERT INTO mio_admin_audit_logs (
             id, actor_id, actor_name, action, target_id, summary, before_state, after_state
           ) VALUES ($1, $2, $3, 'onelink.sso.register', $4, $5, $6::jsonb, $7::jsonb)`,
          [
            createId(),
            actor.id,
            actor.username,
            environment,
            `Registered OneLink SSO client (env=${environment}, code=200, rev=${saved.revision})`,
            beforeState ? JSON.stringify(beforeState) : null,
            JSON.stringify({
              ...toAuditOneLinkSsoState(saved),
              code: 200,
              traceId: result.traceId,
            }),
          ],
        );
        return saved;
      }

      if (result.kind === 'already_exists') {
        const beforeState = existing
          ? toAuditOneLinkSsoState(toOneLinkSsoConfigView(existing))
          : null;
        const row = (
          await client.query<OneLinkSsoConfigRow>(
            `INSERT INTO mio_admin_onelink_sso_config (
               environment, enabled, client_name, client_id, expected_client_id,
               registration_status, registration_source,
               last_register_code, last_register_trace_id, last_register_message,
               last_registered_at, revision, updated_by
             ) VALUES (
               $1, false, $2, $2, NULL,
               'trusted_existing', 'register_362_trusted',
               362, $3, 'already_exists_trusted',
               now(), 1, $4
             )
             ON CONFLICT (environment) DO UPDATE SET
               client_name = EXCLUDED.client_name,
               client_id = COALESCE(
                 mio_admin_onelink_sso_config.client_id,
                 mio_admin_onelink_sso_config.expected_client_id,
                 EXCLUDED.client_name
               ),
               registration_status = CASE
                 WHEN mio_admin_onelink_sso_config.registration_status = 'registered' THEN 'registered'
                 ELSE 'trusted_existing'
               END,
               registration_source = COALESCE(
                 mio_admin_onelink_sso_config.registration_source,
                 'register_362_trusted'
               ),
               last_register_code = 362,
               last_register_trace_id = EXCLUDED.last_register_trace_id,
               last_register_message = EXCLUDED.last_register_message,
               last_registered_at = now(),
               revision = mio_admin_onelink_sso_config.revision + 1,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()
             RETURNING ${ONELINK_SSO_COLUMNS}`,
            [environment, clientName, result.traceId, actor.username],
          )
        ).rows[0]!;
        const saved = toOneLinkSsoConfigView(row);
        await client.query(
          `INSERT INTO mio_admin_audit_logs (
             id, actor_id, actor_name, action, target_id, summary, before_state, after_state
           ) VALUES ($1, $2, $3, 'onelink.sso.register', $4, $5, $6::jsonb, $7::jsonb)`,
          [
            createId(),
            actor.id,
            actor.username,
            environment,
            `Trusted existing OneLink SSO client (env=${environment}, code=362, rev=${saved.revision})`,
            beforeState ? JSON.stringify(beforeState) : null,
            JSON.stringify({
              ...toAuditOneLinkSsoState(saved),
              code: 362,
              traceId: result.traceId,
            }),
          ],
        );
        return saved;
      }

      await client.query(
        `INSERT INTO mio_admin_audit_logs (
           id, actor_id, actor_name, action, target_id, summary, after_state
         ) VALUES ($1, $2, $3, 'onelink.sso.register_failed', $4, $5, $6::jsonb)`,
        [
          createId(),
          actor.id,
          actor.username,
          environment,
          `OneLink SSO client registration failed (env=${environment}, code=${result.code ?? 'null'})`,
          JSON.stringify({
            code: result.code,
            traceId: result.traceId,
          }),
        ],
      );
      return existing ? toOneLinkSsoConfigView(existing) : null;
    });
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closing = (async () => {
        const tasks: Promise<void>[] = [this.pool.end()];
        if (this.ownsConversationsPool && this.conversationsPool) {
          tasks.push(this.conversationsPool.end());
        }
        if (this.mediaPool) {
          tasks.push(this.mediaPool.end());
        }
        await Promise.allSettled(tasks);
      })();
    }
    return this.closing;
  }
}

export async function createAdminStore(
  config: AdminConfig,
  oneLinkSsoEnvOverride?: string,
): Promise<AdminStore> {
  const pool = createManagedPool(config.databaseURL, 'mio-admin', 4);
  const oneLinkSsoEnv = oneLinkSsoEnvOverride ?? config.oneLinkSsoEnv ?? 'dev';
  let conversationsPool: Pool | null = null;
  let ownsConversationsPool = false;
  let mediaPool: Pool | null = null;
  try {
    await checkProviderSchema(pool);
    await checkAdminSchema(pool);
    const initialStorageSettingsReadAt = epochMs();
    const [initialAuthRes, initialOneLinkRes, initialCreationLogSettings, initialStorageSettings] =
      await Promise.all([
        pool.query<GlobalSettingsRow>(
          "SELECT setting_key, value, revision, updated_by, created_at, updated_at FROM mio_admin_global_settings WHERE setting_key = 'auth'",
        ),
        pool.query<OneLinkSsoConfigRow>(
          `SELECT ${ONELINK_SSO_COLUMNS} FROM mio_admin_onelink_sso_config WHERE environment = $1`,
          [oneLinkSsoEnv],
        ),
        readCreationLogSettings(pool),
        readStorageSettings(pool),
      ]);
    const initialAuthRow = initialAuthRes.rows[0];
    const initialAuthSettings = initialAuthRow ? toStoredAuthSettings(initialAuthRow) : null;
    const initialOneLinkRow = initialOneLinkRes.rows[0];
    const initialOneLinkSsoConfig = initialOneLinkRow
      ? toOneLinkSsoConfigView(initialOneLinkRow)
      : null;
    if (config.conversationsDatabaseURL) {
      if (config.conversationsDatabaseURL === config.databaseURL) {
        conversationsPool = pool;
      } else {
        conversationsPool = createManagedPool(config.conversationsDatabaseURL, 'mio-admin-conv', 2);
        ownsConversationsPool = true;
      }
    }
    if (config.mediaDatabaseURL) {
      mediaPool = createManagedPool(config.mediaDatabaseURL, 'mio-admin-media', 2);
    }
    return new AdminStore(
      pool,
      conversationsPool,
      ownsConversationsPool,
      mediaPool,
      initialCreationLogSettings,
      initialStorageSettings,
      initialAuthSettings,
      initialOneLinkSsoConfig,
      oneLinkSsoEnv,
      initialStorageSettingsReadAt,
    );
  } catch (error) {
    await Promise.allSettled([
      pool.end(),
      ...(ownsConversationsPool && conversationsPool ? [conversationsPool.end()] : []),
      ...(mediaPool ? [mediaPool.end()] : []),
    ]);
    throw error instanceof Error &&
      (error.message.startsWith('ADMIN_SCHEMA') || error.message.startsWith('PROVIDER_SCHEMA'))
      ? error
      : new Error('ADMIN_STARTUP: admin database is unavailable or incompatible');
  }
}
