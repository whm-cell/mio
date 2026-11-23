import { sha256Utf8 } from '@mio/foundation/hash';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { epochMs, utcISOString } from '@mio/foundation/time';
import { randomBytes } from 'node:crypto';
import { IMAGE_DRIVERS } from '../generations/contracts.ts';
import { DiscoveryError, discoverModels } from '../integrations/onelink/models.ts';
import type { DiscoveredModel, ModelTransport } from '../integrations/onelink/models.ts';
import type { RabbitmqMonitorSnapshot } from '../integrations/rabbitmq-monitor.ts';
import { probeRabbitmqMetrics } from '../integrations/rabbitmq-monitor.ts';
import type { RedisMonitorSnapshot } from '../integrations/redis.ts';
import { probeRedisMetrics } from '../integrations/redis.ts';
import { hashAdminPassword, verifyAdminPassword } from '../auth/admin-password.ts';
import type { AuthRuntimePolicy } from '../auth/config.ts';
import type { ProviderConfig } from '../providers/config.ts';
import {
  CHAT_PROFILES,
  ProviderError,
  categories,
  isProviderOperation,
} from '../providers/contracts.ts';
import type { Category, PlatformRouteRecord } from '../providers/contracts.ts';
import {
  serializeRouteInputSnapshot,
  validateModelRouteEntry,
} from '../providers/onelink/router.ts';
import { AUDIO_ROUTES } from '../providers/onelink/audio.ts';
import { VOICE_DRIVER } from '../providers/onelink/voices.ts';
import type { ProviderService } from '../providers/service.ts';
import { AdminError, SMS_BYPASS_CODE_PATTERN, isAuthSmsMode } from './contracts.ts';
import type {
  AdminAccountView,
  AdminAuthRuntimeDefaults,
  AdminCatalogSummary,
  AdminAudioRouteView,
  AdminDiscoveryCandidateItem,
  AdminGlobalSettingsView,
  AdminModelCatalogItem,
  AdminPrincipal,
  AdminProbeDiscoveryResult,
  AdminRouteTemplateUiHints,
  AdminStoredAuthSettings,
  MonitoringWindow,
} from './contracts.ts';
import { decryptProbeKey, encryptProbeKey, maskProbeKeyHint } from './credentials.ts';
import type { AdminStore } from './store.ts';

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,64}$/;
const TEMPLATE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const VENDOR_LABEL_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH_SETTINGS_KEYS = ['emailPasswordEnabled', 'smsMode', 'smsBypassCode'] as const;
const MAX_PG_INT32 = 2_147_483_647;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function validateGlobalSettingsUpdate(input: { expectedRevision?: unknown; auth?: unknown }): {
  expectedRevision: number;
  auth: AuthRuntimePolicy;
} {
  if (
    typeof input.expectedRevision !== 'number' ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.expectedRevision > MAX_PG_INT32
  ) {
    throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
  }
  if (!isPlainObject(input.auth)) {
    throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
  }
  for (const key of Object.keys(input.auth)) {
    if (!(AUTH_SETTINGS_KEYS as readonly string[]).includes(key)) {
      throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
    }
  }
  const { emailPasswordEnabled, smsMode, smsBypassCode } = input.auth;
  if (typeof emailPasswordEnabled !== 'boolean' || !isAuthSmsMode(smsMode)) {
    throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
  }
  if (smsMode === 'bypass') {
    if (typeof smsBypassCode !== 'string' || !SMS_BYPASS_CODE_PATTERN.test(smsBypassCode)) {
      throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
    }
  } else if (
    smsBypassCode !== null &&
    (typeof smsBypassCode !== 'string' || !SMS_BYPASS_CODE_PATTERN.test(smsBypassCode))
  ) {
    throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
  }
  return {
    expectedRevision: input.expectedRevision,
    auth: {
      emailPasswordEnabled,
      smsMode,
      smsBypassCode: smsBypassCode as string | null,
    },
  };
}

export interface AdminMonitorProbes {
  readonly probeRabbitmq?: () => Promise<RabbitmqMonitorSnapshot>;
  readonly probeRedis?: () => Promise<RedisMonitorSnapshot>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidRawModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validateApiKeyFormat(apiKey: unknown): string {
  if (
    typeof apiKey !== 'string' ||
    !apiKey ||
    Buffer.byteLength(apiKey, 'utf8') > 4096 ||
    /\s|[\u0000-\u001f\u007f*•]/.test(apiKey)
  ) {
    throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'PROVIDER_KEY_INVALID');
  }
  try {
    new Headers({ authorization: `Bearer ${apiKey}` });
  } catch {
    throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'PROVIDER_KEY_INVALID');
  }
  return apiKey;
}

function parseOptionalBoundedString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
  }
  return value.trim() || null;
}

function parseOptionalCategory(value: unknown): Category | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !categories.includes(value as Category)) {
    throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
  }
  return value as Category;
}

function parseOptionalVendorLabel(value: unknown): string | null | undefined {
  const parsed = parseOptionalBoundedString(value, 64);
  if (parsed && !VENDOR_LABEL_PATTERN.test(parsed)) {
    throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
  }
  return parsed;
}

function inferHeuristicCategory(rawModelId: string): Category | null {
  const lower = rawModelId.toLowerCase();
  if (lower.startsWith('image-') || lower.includes('seedream') || lower.includes('gpt-image')) {
    return 'image';
  }
  if (lower.startsWith('video-') || lower.includes('seedance') || lower.startsWith('veo')) {
    return 'video';
  }
  if (lower.startsWith('speech-') || lower.includes('tts')) return 'voice';
  if (lower.startsWith('music-')) return 'music';
  if (lower.includes('embedding')) return null;
  return 'chat';
}

function inferHeuristicVendor(
  rawModelId: string,
  metadata: Record<string, unknown>,
): string | null {
  if (typeof metadata.owned_by === 'string') {
    const cleaned = metadata.owned_by.trim().toLowerCase();
    if (
      cleaned &&
      cleaned !== 'system' &&
      cleaned !== 'custom' &&
      VENDOR_LABEL_PATTERN.test(cleaned)
    ) {
      return cleaned;
    }
  }
  const lower = rawModelId.toLowerCase();
  if (lower.includes('claude')) return 'anthropic';
  if (
    lower.includes('gpt') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3') ||
    lower.startsWith('o4')
  )
    return 'openai';
  if (lower.includes('gemini') || lower.startsWith('veo')) return 'google';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('doubao') || lower.includes('seedream') || lower.includes('seedance'))
    return 'volcengine';
  if (lower.includes('kling')) return 'kling';
  if (lower.includes('vidu')) return 'vidu';
  if (lower.includes('qwen') || lower.includes('wanx')) return 'alibaba';
  return null;
}

function buildDiscoveryCandidates(
  rows: readonly {
    raw_model_id: string;
    supplier_metadata: Record<string, unknown>;
    last_seen_at: string;
  }[],
  existingIds: ReadonlySet<string>,
  ignoredIds: ReadonlySet<string>,
): {
  candidates: AdminDiscoveryCandidateItem[];
  newCount: number;
  existingCount: number;
  ignoredCount: number;
} {
  let newCount = 0;
  let existingCount = 0;
  let ignoredCount = 0;
  const candidates: AdminDiscoveryCandidateItem[] = rows.map((row) => {
    const importState: 'new' | 'existing' | 'ignored' = existingIds.has(row.raw_model_id)
      ? 'existing'
      : ignoredIds.has(row.raw_model_id)
        ? 'ignored'
        : 'new';
    if (importState === 'new') newCount += 1;
    else if (importState === 'existing') existingCount += 1;
    else ignoredCount += 1;
    return {
      rawModelId: row.raw_model_id,
      suggestedCategory: inferHeuristicCategory(row.raw_model_id),
      suggestedVendor: inferHeuristicVendor(row.raw_model_id, row.supplier_metadata),
      supplierMetadata: row.supplier_metadata,
      importState,
      lastSeenAt: row.last_seen_at,
    };
  });
  return { candidates, newCount, existingCount, ignoredCount };
}

function parseStringHintArray(value: unknown, maxItems = 32): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
  }
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
    }
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 64) {
      throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
    }
    if (!normalized.includes(trimmed)) normalized.push(trimmed);
  }
  return normalized;
}

function validateTemplatePayload(input: {
  templateKey?: unknown;
  label?: unknown;
  description?: unknown;
  sortOrder?: unknown;
  routeTemplate?: unknown;
  uiHints?: unknown;
}) {
  if (typeof input.templateKey !== 'string' || !TEMPLATE_KEY_PATTERN.test(input.templateKey)) {
    throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
  }
  if (typeof input.label !== 'string' || !input.label.trim() || input.label.trim().length > 100) {
    throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
  }
  const description =
    input.description === undefined
      ? ''
      : typeof input.description === 'string' && input.description.length <= 500
        ? input.description.trim()
        : (() => {
            throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
          })();
  const sortOrder = input.sortOrder === undefined ? 100 : Number(input.sortOrder);
  if (!Number.isInteger(sortOrder) || sortOrder < -10_000 || sortOrder > 100_000) {
    throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
  }
  if (!isPlainObject(input.routeTemplate)) {
    throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ROUTE_INVALID');
  }
  let validated;
  try {
    validated = validateModelRouteEntry({
      ...input.routeTemplate,
      rawModelId: '__template_validation__',
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new AdminError(error.status, error.code);
    }
    throw error;
  }
  const snapshot = serializeRouteInputSnapshot(validated);
  delete snapshot.rawModelId;

  let uiHints: AdminRouteTemplateUiHints = {};
  if (input.uiHints !== undefined) {
    if (!isPlainObject(input.uiHints)) {
      throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
    }
    const allowedHintKeys = [
      'recommendedSizes',
      'recommendedAspectRatios',
      'recommendedOutputFormats',
      'recommendedQualities',
      'recommendedBackgrounds',
    ];
    for (const key of Object.keys(input.uiHints)) {
      if (!allowedHintKeys.includes(key)) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
    }
    const sizes = parseStringHintArray(input.uiHints.recommendedSizes);
    const ratios = parseStringHintArray(input.uiHints.recommendedAspectRatios);
    const formats = parseStringHintArray(input.uiHints.recommendedOutputFormats);
    const qualities = parseStringHintArray(input.uiHints.recommendedQualities);
    const backgrounds = parseStringHintArray(input.uiHints.recommendedBackgrounds);
    uiHints = {
      ...(sizes !== undefined ? { recommendedSizes: sizes } : {}),
      ...(ratios !== undefined ? { recommendedAspectRatios: ratios } : {}),
      ...(formats !== undefined ? { recommendedOutputFormats: formats } : {}),
      ...(qualities !== undefined ? { recommendedQualities: qualities } : {}),
      ...(backgrounds !== undefined ? { recommendedBackgrounds: backgrounds } : {}),
    };
  }

  return {
    templateKey: input.templateKey,
    label: input.label.trim(),
    description,
    operation: validated.operation,
    vendor: validated.vendor,
    driver: validated.driver,
    routeTemplate: snapshot,
    uiHints,
    sortOrder,
  };
}

export function createAdminService(
  store: AdminStore,
  providers: ProviderService,
  providerConfig: ProviderConfig,
  transport?: ModelTransport,
  monitors?: AdminMonitorProbes,
  authRuntimeDefaults?: AdminAuthRuntimeDefaults,
) {
  const cancellation = new AbortController();
  const activeProbes = new Set<Promise<AdminProbeDiscoveryResult>>();
  let dummyHashPromise: Promise<string> | undefined;
  let closing: Promise<void> | undefined;

  const defaults: AdminAuthRuntimeDefaults = {
    emailPasswordEnabled: authRuntimeDefaults?.emailPasswordEnabled ?? true,
    smsProviderConfigured: authRuntimeDefaults?.smsProviderConfigured ?? false,
  };
  const defaultAuthPolicy = (): AuthRuntimePolicy => ({
    emailPasswordEnabled: defaults.emailPasswordEnabled,
    smsMode: 'live',
    smsBypassCode: null,
  });
  let currentAuthPolicy: AuthRuntimePolicy = store.initialAuthSettings
    ? { ...store.initialAuthSettings.auth }
    : defaultAuthPolicy();
  let currentAuthRevision = store.initialAuthSettings?.revision ?? 0;

  const formatGlobalSettingsView = (
    stored: AdminStoredAuthSettings | null,
  ): AdminGlobalSettingsView => ({
    settings: stored ?? {
      auth: defaultAuthPolicy(),
      revision: 0,
      updatedBy: null,
      updatedAt: null,
    },
    runtime: {
      envEmailPasswordDefault: defaults.emailPasswordEnabled,
      smsProviderConfigured: defaults.smsProviderConfigured,
    },
  });

  const runRabbitmqProbe = monitors?.probeRabbitmq ?? (() => probeRabbitmqMetrics(undefined));
  const runRedisProbe = monitors?.probeRedis ?? (() => probeRedisMetrics(undefined));

  const assertOpen = () => {
    if (cancellation.signal.aborted) {
      throw new AdminError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ADMIN_UNAVAILABLE');
    }
  };

  const getDummyHash = () => {
    dummyHashPromise ??= hashAdminPassword('mio-dummy-timing-guard-password');
    return dummyHashPromise;
  };

  return {
    async login(
      username: unknown,
      password: unknown,
    ): Promise<{ admin: AdminAccountView; sessionToken: string }> {
      assertOpen();
      if (
        typeof username !== 'string' ||
        typeof password !== 'string' ||
        !USERNAME_PATTERN.test(username) ||
        password.length < 8 ||
        password.length > 128
      ) {
        throw new AdminError(HTTP_STATUS.UNAUTHORIZED, 'ADMIN_INVALID_CREDENTIALS');
      }
      const account = await store.findAccountByUsername(username);
      if (!account) {
        await verifyAdminPassword(await getDummyHash(), password).catch(() => false);
        throw new AdminError(HTTP_STATUS.UNAUTHORIZED, 'ADMIN_INVALID_CREDENTIALS');
      }
      const matched = await verifyAdminPassword(account.passwordHash, password);
      if (!matched) {
        throw new AdminError(HTTP_STATUS.UNAUTHORIZED, 'ADMIN_INVALID_CREDENTIALS');
      }
      const sessionToken = randomBytes(32).toString('base64url');
      const tokenDigest = sha256Utf8(sessionToken);
      const expiresAt = new Date(epochMs() + SESSION_TTL_MS);
      await store.createSession(account.view.id, tokenDigest, expiresAt);
      return { admin: account.view, sessionToken };
    },

    async authenticate(sessionToken: string | null): Promise<AdminPrincipal | null> {
      assertOpen();
      if (!sessionToken || sessionToken.length > 256) return null;
      return store.resolveSession(sha256Utf8(sessionToken));
    },

    async logout(sessionToken: string | null): Promise<void> {
      assertOpen();
      if (!sessionToken || sessionToken.length > 256) return;
      await store.deleteSession(sha256Utf8(sessionToken));
    },

    async updateAccount(
      principal: AdminPrincipal,
      input: { username?: unknown; currentPassword?: unknown; newPassword?: unknown },
    ): Promise<AdminAccountView> {
      assertOpen();
      const hasUsername = input.username !== undefined;
      const hasNewPassword = input.newPassword !== undefined;
      if (!hasUsername && !hasNewPassword) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
      let nextUsername: string | undefined;
      if (hasUsername) {
        if (typeof input.username !== 'string' || !USERNAME_PATTERN.test(input.username)) {
          throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
        }
        nextUsername = input.username;
      }
      let nextPasswordHash: string | undefined;
      if (hasNewPassword) {
        if (
          typeof input.newPassword !== 'string' ||
          input.newPassword.length < 8 ||
          input.newPassword.length > 128 ||
          typeof input.currentPassword !== 'string' ||
          !input.currentPassword
        ) {
          throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
        }
        const current = await store.findAccountById(principal.admin.id);
        if (!current) throw new AdminError(HTTP_STATUS.UNAUTHORIZED, 'ADMIN_UNAUTHORIZED');
        const verified = await verifyAdminPassword(current.passwordHash, input.currentPassword);
        if (!verified) {
          throw new AdminError(HTTP_STATUS.UNAUTHORIZED, 'ADMIN_PASSWORD_MISMATCH');
        }
        nextPasswordHash = await hashAdminPassword(input.newPassword);
      }
      return store.updateAccount(principal.admin.id, principal.tokenDigest, {
        ...(nextUsername !== undefined ? { username: nextUsername } : {}),
        ...(nextPasswordHash !== undefined ? { passwordHash: nextPasswordHash } : {}),
      });
    },

    async getProbeStatus() {
      assertOpen();
      return (await store.readProbeRecord()).view;
    },

    async clearProbeKey(principal: AdminPrincipal): Promise<void> {
      assertOpen();
      await store.clearProbeKey(principal.admin);
    },

    async discoverOneLink(
      principal: AdminPrincipal,
      input: { apiKey?: unknown; saveKey?: unknown },
    ): Promise<AdminProbeDiscoveryResult> {
      assertOpen();
      if (input.saveKey !== undefined && typeof input.saveKey !== 'boolean') {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
      const saveKey = input.saveKey === true;
      let suppliedKey: string | null = null;
      let resolvedKey: string;
      if (input.apiKey !== undefined && input.apiKey !== '') {
        suppliedKey = validateApiKeyFormat(input.apiKey);
        resolvedKey = suppliedKey;
      } else {
        if (saveKey) throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'PROBE_KEY_REQUIRED');
        const record = await store.readProbeRecord();
        if (!record.envelope) throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'PROBE_KEY_REQUIRED');
        resolvedKey = decryptProbeKey(record.envelope, record.envelope.keyVersion, providerConfig);
      }

      const task = (async (): Promise<AdminProbeDiscoveryResult> => {
        let models: DiscoveredModel[] = [];
        let status: 'connected' | 'failed' = 'failed';
        let errorCode: string | null = null;
        try {
          assertOpen();
          models = await discoverModels(resolvedKey, transport, 15_000, cancellation.signal);
          status = 'connected';
        } catch (error) {
          errorCode = error instanceof DiscoveryError ? error.code : 'UPSTREAM_UNAVAILABLE';
        }
        let savedEnvelope:
          | {
              keyVersion: number;
              maskedHint: string;
              envelope: ReturnType<typeof encryptProbeKey>;
            }
          | undefined;
        if (saveKey && suppliedKey && status === 'connected') {
          const keyVersion = await store.nextProbeKeyVersion();
          savedEnvelope = {
            keyVersion,
            maskedHint: maskProbeKeyHint(suppliedKey),
            envelope: encryptProbeKey(suppliedKey, keyVersion, providerConfig),
          };
        }
        const checkedAt = utcISOString();
        const outcome = await store.recordProbeOutcome({
          actor: principal.admin,
          status,
          models,
          error: errorCode,
          ...(savedEnvelope ? { savedEnvelope } : {}),
        });
        const sortedModels = [...models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const classified = buildDiscoveryCandidates(
          sortedModels.map((m) => ({
            raw_model_id: m.id,
            supplier_metadata: m.metadata,
            last_seen_at: checkedAt,
          })),
          outcome.existingIds,
          outcome.ignoredIds,
        );
        return {
          status,
          checkedAt,
          discoveredCount: models.length,
          newCount: classified.newCount,
          existingCount: classified.existingCount,
          ignoredCount: classified.ignoredCount,
          totalCatalogCount: outcome.totalCatalogCount,
          savedKey: Boolean(savedEnvelope),
          error: errorCode,
          candidates: classified.candidates,
        };
      })();

      activeProbes.add(task);
      try {
        return await task;
      } finally {
        activeProbes.delete(task);
      }
    },

    async listDiscoveryCandidates() {
      assertOpen();
      const cached = await store.readCachedDiscoveryCandidates();
      const classified = buildDiscoveryCandidates(
        cached.probeRows.map((r) => ({
          raw_model_id: r.raw_model_id,
          supplier_metadata: r.supplier_metadata,
          last_seen_at: r.last_seen_at.toISOString(),
        })),
        cached.existingIds,
        cached.ignoredIds,
      );
      return {
        totalProbeModels: cached.probeRows.length,
        newCount: classified.newCount,
        existingCount: classified.existingCount,
        ignoredCount: classified.ignoredCount,
        candidates: classified.candidates,
      };
    },

    async importModels(
      principal: AdminPrincipal,
      input: { items?: unknown; overwriteMetadata?: unknown },
    ) {
      assertOpen();
      if (
        !Array.isArray(input.items) ||
        input.items.length < 1 ||
        input.items.length > 500 ||
        (input.overwriteMetadata !== undefined && typeof input.overwriteMetadata !== 'boolean')
      ) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
      const seen = new Set<string>();
      const parsedItems = input.items.map((raw) => {
        if (!isPlainObject(raw) || !isValidRawModelId(raw.rawModelId)) {
          throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
        }
        for (const key of Object.keys(raw)) {
          if (
            ![
              'rawModelId',
              'displayLabel',
              'vendorLabel',
              'category',
              'description',
              'supplierMetadata',
              'userVisible',
              'allowUndiscovered',
              'callNotes',
            ].includes(key)
          ) {
            throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
          }
        }
        if (seen.has(raw.rawModelId)) {
          throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
        }
        seen.add(raw.rawModelId);
        if (raw.userVisible !== undefined && typeof raw.userVisible !== 'boolean') {
          throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
        }
        if (raw.allowUndiscovered !== undefined && typeof raw.allowUndiscovered !== 'boolean') {
          throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
        }
        if (raw.supplierMetadata !== undefined && !isPlainObject(raw.supplierMetadata)) {
          throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
        }
        const supplierMetadata = isPlainObject(raw.supplierMetadata) ? raw.supplierMetadata : {};
        const descriptionFromSupplier =
          typeof supplierMetadata.description === 'string' &&
          supplierMetadata.description.trim() &&
          supplierMetadata.description.trim().length <= 1000
            ? supplierMetadata.description.trim()
            : null;
        return {
          rawModelId: raw.rawModelId,
          displayLabel: parseOptionalBoundedString(raw.displayLabel, 100) ?? null,
          vendorLabel:
            parseOptionalVendorLabel(raw.vendorLabel) ??
            inferHeuristicVendor(raw.rawModelId, supplierMetadata),
          category: parseOptionalCategory(raw.category) ?? inferHeuristicCategory(raw.rawModelId),
          description: parseOptionalBoundedString(raw.description, 1000) ?? descriptionFromSupplier,
          supplierMetadata,
          userVisible: raw.userVisible ?? true,
          allowUndiscovered: raw.allowUndiscovered ?? false,
          callNotes: parseOptionalBoundedString(raw.callNotes, 2000) ?? null,
        };
      });
      return store.importCatalogModels(
        principal.admin,
        parsedItems,
        input.overwriteMetadata === true,
      );
    },

    async createModel(
      principal: AdminPrincipal,
      input: {
        rawModelId?: unknown;
        displayLabel?: unknown;
        vendorLabel?: unknown;
        category?: unknown;
        description?: unknown;
        userVisible?: unknown;
        allowUndiscovered?: unknown;
        callNotes?: unknown;
      },
    ) {
      assertOpen();
      if (!isValidRawModelId(input.rawModelId)) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
      if (input.userVisible !== undefined && typeof input.userVisible !== 'boolean') {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
      if (input.allowUndiscovered !== undefined && typeof input.allowUndiscovered !== 'boolean') {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
      const created = await store.createCatalogModel(principal.admin, {
        rawModelId: input.rawModelId,
        displayLabel: parseOptionalBoundedString(input.displayLabel, 100) ?? null,
        vendorLabel: parseOptionalVendorLabel(input.vendorLabel) ?? null,
        category: parseOptionalCategory(input.category) ?? null,
        description: parseOptionalBoundedString(input.description, 1000) ?? null,
        userVisible: input.userVisible ?? true,
        allowUndiscovered: input.allowUndiscovered ?? false,
        callNotes: parseOptionalBoundedString(input.callNotes, 2000) ?? null,
      });
      return { model: created };
    },

    async updateModel(
      principal: AdminPrincipal,
      input: {
        rawModelId?: unknown;
        displayLabel?: unknown;
        vendorLabel?: unknown;
        category?: unknown;
        description?: unknown;
        userVisible?: unknown;
        allowUndiscovered?: unknown;
        callNotes?: unknown;
      },
    ) {
      assertOpen();
      if (!isValidRawModelId(input.rawModelId)) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
      if (input.userVisible !== undefined && typeof input.userVisible !== 'boolean') {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
      if (input.allowUndiscovered !== undefined && typeof input.allowUndiscovered !== 'boolean') {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
      const displayLabel = parseOptionalBoundedString(input.displayLabel, 100);
      const vendorLabel = parseOptionalVendorLabel(input.vendorLabel);
      const category = parseOptionalCategory(input.category);
      const description = parseOptionalBoundedString(input.description, 1000);
      const callNotes = parseOptionalBoundedString(input.callNotes, 2000);
      const updated = await store.updateCatalogModel(principal.admin, {
        rawModelId: input.rawModelId,
        ...(displayLabel !== undefined ? { displayLabel } : {}),
        ...(vendorLabel !== undefined ? { vendorLabel } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(input.userVisible !== undefined ? { userVisible: input.userVisible } : {}),
        ...(input.allowUndiscovered !== undefined
          ? { allowUndiscovered: input.allowUndiscovered }
          : {}),
        ...(callNotes !== undefined ? { callNotes } : {}),
      });
      return { model: updated };
    },

    async deleteModel(
      principal: AdminPrincipal,
      input: { rawModelId?: unknown; ignoreFutureImports?: unknown; summary?: unknown },
    ) {
      assertOpen();
      if (!isValidRawModelId(input.rawModelId)) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
      if (
        input.ignoreFutureImports !== undefined &&
        typeof input.ignoreFutureImports !== 'boolean'
      ) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
      const summary = parseOptionalBoundedString(input.summary, 500) ?? null;
      const exists = await store.modelExistsInCatalog(input.rawModelId);
      if (!exists) {
        throw new AdminError(HTTP_STATUS.NOT_FOUND, 'MODEL_NOT_FOUND');
      }
      const deletedRevisions = await providers.deleteRoutes(input.rawModelId, {
        actorType: 'admin',
        actorId: principal.admin.id,
        actorName: principal.admin.username,
        summary: summary ?? `Cascade delete routes for ${input.rawModelId}`,
      });
      await store.deleteCatalogModel(principal.admin, {
        rawModelId: input.rawModelId,
        ignoreFutureImports: input.ignoreFutureImports === true,
        summary,
        deletedRoutesCount: deletedRevisions.length,
      });
      return {
        ok: true,
        rawModelId: input.rawModelId,
        deletedRoutesCount: deletedRevisions.length,
      };
    },

    async listModels(filters: {
      q?: string;
      category?: string;
      status?: string;
      visibility?: string;
    }): Promise<{ summary: AdminCatalogSummary; items: AdminModelCatalogItem[] }> {
      assertOpen();
      if (filters.category !== undefined && !categories.includes(filters.category as Category)) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
      }
      if (
        filters.status !== undefined &&
        !['enabled', 'disabled', 'pending'].includes(filters.status)
      ) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
      }
      if (
        filters.visibility !== undefined &&
        !['visible', 'hidden', 'curated'].includes(filters.visibility)
      ) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
      }

      const raw = await store.readUnifiedModelSources();
      const benchmarkMap = new Map(raw.benchmarkRows.map((row) => [row.raw_model_id, row]));
      const statsMap = new Map(raw.userStatsRows.map((row) => [row.raw_model_id, row]));
      const chatRoutes = new Map<string, PlatformRouteRecord & { updated_at: Date }>();
      const imageRoutes = new Map<string, PlatformRouteRecord & { updated_at: Date }>();
      const audioRoutes = new Map<string, AdminAudioRouteView[]>();
      for (const route of raw.routeRows) {
        if (route.operation === 'chat') chatRoutes.set(route.raw_model_id, route);
        else if (route.operation === 'image.generate') imageRoutes.set(route.raw_model_id, route);
        else {
          const stats = statsMap.get(route.raw_model_id);
          const verifiedUserCount = {
            'audio.voices.list': stats?.verified_voice_users ?? 0,
            'audio.tts': stats?.verified_tts_users ?? 0,
            'audio.clone': stats?.verified_clone_users ?? 0,
          }[route.operation];
          const entries = audioRoutes.get(route.raw_model_id) ?? [];
          entries.push({
            operation: route.operation,
            route: serializeRouteInputSnapshot(route),
            enabled: route.enabled,
            declarationVersion: route.declaration_version,
            verifiedUserCount,
            updatedAt: route.updated_at.toISOString(),
          });
          audioRoutes.set(route.raw_model_id, entries);
        }
      }

      const allItems: AdminModelCatalogItem[] = [...raw.catalogRows]
        .sort((a, b) =>
          a.raw_model_id < b.raw_model_id ? -1 : a.raw_model_id > b.raw_model_id ? 1 : 0,
        )
        .map((cat) => {
          const rawModelId = cat.raw_model_id;
          const benchmark = benchmarkMap.get(rawModelId);
          const stats = statsMap.get(rawModelId);
          const chat = chatRoutes.get(rawModelId);
          const image = imageRoutes.get(rawModelId);
          const voice = audioRoutes.get(rawModelId) ?? [];
          const category: Category | null =
            cat.category ??
            image?.classification ??
            chat?.classification ??
            (voice.length ? 'voice' : null);
          const supplierMeta =
            Object.keys(cat.supplier_metadata ?? {}).length > 0
              ? cat.supplier_metadata
              : (benchmark?.supplier_metadata ?? stats?.sample_metadata ?? null);
          return {
            rawModelId,
            displayLabel: cat.display_label,
            vendorLabel: cat.vendor_label ?? image?.vendor ?? chat?.vendor ?? null,
            category,
            description: cat.description,
            originSource: cat.origin_source,
            inBenchmarkCatalog: Boolean(benchmark),
            inLatestProbe: benchmark?.in_latest_probe ?? false,
            benchmarkMetadata: supplierMeta,
            benchmarkLastSeenAt: benchmark ? benchmark.last_seen_at.toISOString() : null,
            userDiscoveredCount: stats?.discovered_users ?? 0,
            userVerifiedChatCount: stats?.verified_chat_users ?? 0,
            userVerifiedImageCount: stats?.verified_image_users ?? 0,
            audioRoutes: voice.sort((a, b) => a.operation.localeCompare(b.operation)),
            policy: {
              userVisible: cat.user_visible,
              allowUndiscovered: cat.allow_undiscovered,
              displayLabel: cat.display_label,
              callNotes: cat.call_notes,
              updatedBy: cat.updated_by,
              updatedAt: cat.updated_at.toISOString(),
            },
            chatRoute: chat ? serializeRouteInputSnapshot(chat) : null,
            imageRoute: image ? serializeRouteInputSnapshot(image) : null,
            chatRouteMeta: chat
              ? {
                  enabled: chat.enabled,
                  declarationVersion: chat.declaration_version,
                  driver: chat.driver,
                  vendor: chat.vendor,
                  updatedAt: chat.updated_at.toISOString(),
                }
              : null,
            imageRouteMeta: image
              ? {
                  enabled: image.enabled,
                  declarationVersion: image.declaration_version,
                  driver: image.driver,
                  vendor: image.vendor,
                  updatedAt: image.updated_at.toISOString(),
                }
              : null,
            createdAt: cat.created_at.toISOString(),
            updatedAt: cat.updated_at.toISOString(),
          };
        });

      const routes = (item: AdminModelCatalogItem) =>
        [...item.audioRoutes, item.chatRouteMeta, item.imageRouteMeta].filter(
          (route) => route !== null,
        );
      const routeStates = new Map(
        allItems.map((item) => {
          const configured = routes(item);
          return [
            item.rawModelId,
            configured.length === 0
              ? 'pending'
              : configured.some((route) => route.enabled)
                ? 'enabled'
                : 'disabled',
          ];
        }),
      );
      const summary: AdminCatalogSummary = {
        totalModels: allItems.length,
        benchmarkModels: allItems.filter(
          (item) => item.inLatestProbe || item.userDiscoveredCount > 0,
        ).length,
        configuredEnabled: allItems.filter((item) => routeStates.get(item.rawModelId) === 'enabled')
          .length,
        configuredDisabled: allItems.filter(
          (item) => routeStates.get(item.rawModelId) === 'disabled',
        ).length,
        pendingRoutes: allItems.filter((item) => routeStates.get(item.rawModelId) === 'pending')
          .length,
        hiddenFromUsers: allItems.filter((item) => !item.policy.userVisible).length,
        curatedUndiscovered: allItems.filter((item) => item.policy.allowUndiscovered).length,
      };

      const keyword = filters.q?.trim().toLowerCase() ?? '';
      const filtered = allItems.filter((item) => {
        if (filters.category && item.category !== filters.category) return false;
        if (filters.status && routeStates.get(item.rawModelId) !== filters.status) return false;
        if (filters.visibility === 'visible' && !item.policy.userVisible) return false;
        if (filters.visibility === 'hidden' && item.policy.userVisible) return false;
        if (filters.visibility === 'curated' && !item.policy.allowUndiscovered) return false;
        if (keyword) {
          const desc = (
            item.description ??
            (typeof item.benchmarkMetadata?.description === 'string'
              ? item.benchmarkMetadata.description
              : '')
          ).toLowerCase();
          const vendor = (
            item.vendorLabel ??
            (typeof item.benchmarkMetadata?.owned_by === 'string'
              ? item.benchmarkMetadata.owned_by
              : '')
          ).toLowerCase();
          const label = item.displayLabel?.toLowerCase() ?? '';
          const notes = item.policy.callNotes?.toLowerCase() ?? '';
          if (
            !item.rawModelId.toLowerCase().includes(keyword) &&
            !desc.includes(keyword) &&
            !vendor.includes(keyword) &&
            !label.includes(keyword) &&
            !notes.includes(keyword)
          ) {
            return false;
          }
        }
        return true;
      });

      return { summary, items: filtered };
    },

    async publishRoutes(
      principal: AdminPrincipal,
      input: { route?: unknown; routes?: unknown; summary?: unknown },
    ) {
      assertOpen();
      const summary = parseOptionalBoundedString(input.summary, 500) ?? null;
      const payload = input.routes !== undefined ? { routes: input.routes } : input.route;
      if (payload === undefined) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ROUTE_INVALID');
      }
      try {
        return await providers.importRoutes(payload, {
          actorType: 'admin',
          actorId: principal.admin.id,
          actorName: principal.admin.username,
          summary,
        });
      } catch (error) {
        if (error instanceof ProviderError) {
          throw new AdminError(error.status, error.code);
        }
        throw error;
      }
    },

    async deleteRoute(
      principal: AdminPrincipal,
      input: { rawModelId?: unknown; operation?: unknown; summary?: unknown },
    ) {
      assertOpen();
      if (!isValidRawModelId(input.rawModelId) || !isProviderOperation(input.operation)) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
      const summary = parseOptionalBoundedString(input.summary, 500) ?? null;
      const deleted = await providers.deleteRoutes(
        input.rawModelId,
        {
          actorType: 'admin',
          actorId: principal.admin.id,
          actorName: principal.admin.username,
          summary,
        },
        input.operation,
      );
      if (deleted.length === 0) {
        throw new AdminError(HTTP_STATUS.NOT_FOUND, 'ROUTE_NOT_FOUND');
      }
      return { deleted: deleted[0]! };
    },

    async rollbackRoute(
      principal: AdminPrincipal,
      input: { revisionId?: unknown; summary?: unknown },
    ) {
      assertOpen();
      if (typeof input.revisionId !== 'string' || !UUID_PATTERN.test(input.revisionId)) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
      const summary = parseOptionalBoundedString(input.summary, 500) ?? null;
      const target = await store.findRouteRevision(input.revisionId);
      if (!target) {
        throw new AdminError(HTTP_STATUS.NOT_FOUND, 'REVISION_NOT_FOUND');
      }
      if (!target.after_route) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'REVISION_NOT_RESTORABLE');
      }
      try {
        const result = await providers.importRoutes([target.after_route], {
          actorType: 'admin',
          actorId: principal.admin.id,
          actorName: principal.admin.username,
          summary: summary ?? `Rollback to v${target.declaration_version}`,
          actionOverride: 'rollback',
        });
        const created = result.revisions[0];
        return {
          revisionId: created?.id ?? target.id,
          rawModelId: target.raw_model_id,
          operation: target.operation,
          declarationVersion: created?.declarationVersion ?? target.declaration_version,
          unchanged: result.unchanged > 0,
        };
      } catch (error) {
        if (error instanceof ProviderError) {
          throw new AdminError(error.status, error.code);
        }
        throw error;
      }
    },

    async listTemplates() {
      assertOpen();
      const items = await store.listTemplates();
      return {
        drivers: {
          chat: [...CHAT_PROFILES],
          image: [...IMAGE_DRIVERS],
          audio: [VOICE_DRIVER, AUDIO_ROUTES.tts.driver, AUDIO_ROUTES.clone.driver],
        },
        categories: [...categories],
        items,
      };
    },

    async createTemplate(
      principal: AdminPrincipal,
      input: {
        templateKey?: unknown;
        label?: unknown;
        description?: unknown;
        sortOrder?: unknown;
        routeTemplate?: unknown;
        uiHints?: unknown;
      },
    ) {
      assertOpen();
      const validated = validateTemplatePayload(input);
      const template = await store.createTemplate(principal.admin, validated);
      return { template };
    },

    async updateTemplate(
      principal: AdminPrincipal,
      input: {
        id?: unknown;
        templateKey?: unknown;
        label?: unknown;
        description?: unknown;
        sortOrder?: unknown;
        routeTemplate?: unknown;
        uiHints?: unknown;
      },
    ) {
      assertOpen();
      if (typeof input.id !== 'string' || !UUID_PATTERN.test(input.id)) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
      const validated = validateTemplatePayload(input);
      const template = await store.updateTemplate(principal.admin, {
        id: input.id,
        ...validated,
      });
      return { template };
    },

    async deleteTemplate(principal: AdminPrincipal, input: { id?: unknown }) {
      assertOpen();
      if (typeof input.id !== 'string' || !UUID_PATTERN.test(input.id)) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
      }
      await store.deleteTemplate(principal.admin, input.id);
      return { ok: true };
    },

    async listRevisions(rawModelId: string | undefined, limitRaw: string | undefined) {
      assertOpen();
      if (rawModelId !== undefined && !isValidRawModelId(rawModelId)) {
        throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
      }
      let limit = 50;
      if (limitRaw !== undefined) {
        const parsed = Number(limitRaw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
          throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
        }
        limit = parsed;
      }
      return store.listRevisions(rawModelId, limit);
    },

    async readMonitoring(windowRaw: string | undefined) {
      assertOpen();
      const window: MonitoringWindow =
        windowRaw === undefined
          ? '7d'
          : ['24h', '7d', '30d', 'all'].includes(windowRaw)
            ? (windowRaw as MonitoringWindow)
            : (() => {
                throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
              })();
      const [dbMonitoring, rabbitmq, redis] = await Promise.all([
        store.readMonitoring(window),
        runRabbitmqProbe(),
        runRedisProbe(),
      ]);
      return {
        ...dbMonitoring,
        rabbitmq,
        redis,
      };
    },

    getAuthPolicy(): AuthRuntimePolicy {
      return currentAuthPolicy;
    },

    async getGlobalSettings(): Promise<AdminGlobalSettingsView> {
      assertOpen();
      const stored = await store.readGlobalAuthSettings();
      if ((stored?.revision ?? 0) >= currentAuthRevision) {
        currentAuthPolicy = stored ? { ...stored.auth } : defaultAuthPolicy();
        currentAuthRevision = stored?.revision ?? 0;
      }
      return formatGlobalSettingsView(stored);
    },

    async updateGlobalSettings(
      principal: AdminPrincipal,
      input: { expectedRevision?: unknown; auth?: unknown },
    ): Promise<AdminGlobalSettingsView> {
      assertOpen();
      const validated = validateGlobalSettingsUpdate(input);
      const saved = await store.updateGlobalAuthSettings(principal.admin, validated);
      if (saved.revision >= currentAuthRevision) {
        currentAuthPolicy = { ...saved.auth };
        currentAuthRevision = saved.revision;
      }
      return formatGlobalSettingsView(saved);
    },

    close() {
      if (!closing) {
        cancellation.abort();
        closing = (async () => {
          await Promise.allSettled([...activeProbes]);
          await store.close();
        })();
      }
      return closing;
    },
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
