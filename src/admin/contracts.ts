import { HttpError } from '@mio/foundation/errors';
import type { AuthRuntimePolicy, AuthSmsMode } from '../auth/config.ts';
import type {
  Category,
  PlatformCatalogModelRecord,
  PlatformModelOriginSource,
  PlatformRouteRecord,
  PlatformRouteRevisionRecord,
  ProviderOperation,
} from '../providers/contracts.ts';

export class AdminError extends HttpError {}

export interface AdminAccountView {
  readonly id: string;
  readonly username: string;
  readonly isSuperAdmin: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminPrincipal {
  readonly admin: AdminAccountView;
  readonly sessionId: string;
  readonly tokenDigest: string;
}

export interface ProbeConfigView {
  readonly hasSavedKey: boolean;
  readonly maskedHint: string | null;
  readonly keyVersion: number | null;
  readonly lastProbedAt: string | null;
  readonly lastProbeStatus: 'connected' | 'failed' | null;
  readonly lastProbeCount: number | null;
  readonly lastProbeError: string | null;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

export interface AdminDiscoveryCandidateItem {
  readonly rawModelId: string;
  readonly suggestedCategory: Category | null;
  readonly suggestedVendor: string | null;
  readonly supplierMetadata: Record<string, unknown>;
  readonly importState: 'new' | 'existing' | 'ignored';
  readonly lastSeenAt: string;
}

export interface AdminProbeDiscoveryResult {
  readonly status: 'connected' | 'failed';
  readonly checkedAt: string;
  readonly discoveredCount: number;
  readonly newCount: number;
  readonly existingCount: number;
  readonly ignoredCount: number;
  readonly totalCatalogCount: number;
  readonly savedKey: boolean;
  readonly error: string | null;
  readonly candidates: readonly AdminDiscoveryCandidateItem[];
}

export interface AdminModelCatalogItem {
  readonly rawModelId: string;
  readonly displayLabel: string | null;
  readonly vendorLabel: string | null;
  readonly category: Category | null;
  readonly description: string | null;
  readonly originSource: PlatformModelOriginSource;
  readonly inBenchmarkCatalog: boolean;
  readonly inLatestProbe: boolean;
  readonly benchmarkMetadata: Record<string, unknown> | null;
  readonly benchmarkLastSeenAt: string | null;
  readonly userDiscoveredCount: number;
  readonly userVerifiedChatCount: number;
  readonly userVerifiedImageCount: number;
  readonly audioRoutes: readonly AdminAudioRouteView[];
  readonly policy: {
    readonly userVisible: boolean;
    readonly allowUndiscovered: boolean;
    readonly displayLabel: string | null;
    readonly callNotes: string | null;
    readonly updatedBy: string | null;
    readonly updatedAt: string | null;
  };
  readonly chatRoute: Record<string, unknown> | null;
  readonly imageRoute: Record<string, unknown> | null;
  readonly chatRouteMeta: {
    readonly enabled: boolean;
    readonly declarationVersion: number;
    readonly driver: string;
    readonly vendor: string;
    readonly updatedAt: string;
  } | null;
  readonly imageRouteMeta: {
    readonly enabled: boolean;
    readonly declarationVersion: number;
    readonly driver: string;
    readonly vendor: string;
    readonly updatedAt: string;
  } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminAudioRouteView {
  readonly operation: Extract<ProviderOperation, `audio.${string}`>;
  readonly route: Record<string, unknown>;
  readonly enabled: boolean;
  readonly declarationVersion: number;
  readonly verifiedUserCount: number;
  readonly updatedAt: string;
}

export interface AdminCatalogSummary {
  readonly totalModels: number;
  readonly benchmarkModels: number;
  readonly configuredEnabled: number;
  readonly configuredDisabled: number;
  readonly pendingRoutes: number;
  readonly hiddenFromUsers: number;
  readonly curatedUndiscovered: number;
}

export interface AdminRouteTemplateUiHints {
  readonly recommendedSizes?: readonly string[];
  readonly recommendedAspectRatios?: readonly string[];
  readonly recommendedOutputFormats?: readonly string[];
  readonly recommendedQualities?: readonly string[];
  readonly recommendedBackgrounds?: readonly string[];
}

export interface AdminRouteTemplateView {
  readonly id: string;
  readonly templateKey: string;
  readonly label: string;
  readonly description: string;
  readonly operation: ProviderOperation;
  readonly vendor: string;
  readonly driver: string;
  readonly routeTemplate: Record<string, unknown>;
  readonly uiHints: AdminRouteTemplateUiHints;
  readonly sortOrder: number;
  readonly updatedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type MonitoringWindow = '24h' | '7d' | '30d' | 'all';

export interface AdminComputeMonitoringSummary {
  readonly enabled: boolean;
  readonly jobs: {
    readonly total: number;
    readonly accepted: number;
    readonly queued: number;
    readonly running: number;
    readonly succeeded: number;
    readonly failed: number;
  };
  readonly outbox: {
    readonly pending: number;
    readonly leased: number;
    readonly oldestUnsentAgeSeconds: number | null;
  };
  readonly inboxProcessed: number;
}

export interface AdminAuditLogRecord {
  readonly id: string;
  readonly actorId: string | null;
  readonly actorName: string;
  readonly action: string;
  readonly targetId: string | null;
  readonly summary: string | null;
  readonly beforeState: Record<string, unknown> | null;
  readonly afterState: Record<string, unknown> | null;
  readonly createdAt: string;
}

export interface UnifiedModelRawSources {
  readonly catalogRows: readonly (Omit<PlatformCatalogModelRecord, 'created_at' | 'updated_at'> & {
    created_at: Date;
    updated_at: Date;
  })[];
  readonly benchmarkRows: readonly {
    raw_model_id: string;
    supplier_metadata: Record<string, unknown>;
    in_latest_probe: boolean;
    last_seen_at: Date;
  }[];
  readonly ignoredRows: readonly {
    raw_model_id: string;
    reason: string | null;
    ignored_by: string | null;
    ignored_at: Date;
  }[];
  readonly userStatsRows: readonly {
    raw_model_id: string;
    discovered_users: number;
    verified_chat_users: number;
    verified_image_users: number;
    verified_voice_users: number;
    verified_tts_users: number;
    verified_clone_users: number;
    sample_metadata: Record<string, unknown> | null;
  }[];
  readonly routeRows: readonly (PlatformRouteRecord & { updated_at: Date })[];
}

export interface AdminRevisionsView {
  readonly routeRevisions: readonly PlatformRouteRevisionRecord[];
  readonly auditLogs: readonly AdminAuditLogRecord[];
}

export const SMS_BYPASS_CODE_PATTERN = /^\d{6}$/;

export function isAuthSmsMode(value: unknown): value is AuthSmsMode {
  return value === 'live' || value === 'bypass' || value === 'disabled';
}

export interface AdminStoredAuthSettings {
  readonly auth: AuthRuntimePolicy;
  readonly revision: number;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

export interface AdminAuthRuntimeDefaults {
  readonly emailPasswordEnabled: boolean;
  readonly smsProviderConfigured: boolean;
}

export interface AdminGlobalSettingsView {
  readonly settings: AdminStoredAuthSettings;
  readonly runtime: {
    readonly envEmailPasswordDefault: boolean;
    readonly smsProviderConfigured: boolean;
  };
}

export type OneLinkSsoRegistrationStatus = 'unregistered' | 'registered' | 'trusted_existing';
export type OneLinkSsoRegistrationSource = 'register_200' | 'register_362_trusted';
export type OneLinkSsoRegisterOutcome =
  'registered' | 'already_exists_trusted' | 'rejected' | 'failed';

export interface AdminOneLinkSsoConfigView {
  readonly environment: string;
  readonly enabled: boolean;
  readonly clientName: string;
  readonly clientId: string | null;
  readonly expectedClientId: string | null;
  readonly registrationStatus: OneLinkSsoRegistrationStatus;
  readonly registrationSource: OneLinkSsoRegistrationSource | null;
  readonly lastRegisterCode: number | null;
  readonly lastRegisterTraceId: string | null;
  readonly lastRegisterMessage: string | null;
  readonly lastRegisteredAt: string | null;
  readonly revision: number;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

export interface AdminOneLinkSsoRuntimeView {
  readonly configured: boolean;
  readonly hasEncryptionKey: boolean;
  readonly authorizeOrigin: string | null;
  readonly registerOrigin: string | null;
  readonly callbackUrl: string | null;
  readonly tokenVerificationMode: 'payload_sub_unverified';
}

export interface AdminOneLinkSsoView {
  readonly config: AdminOneLinkSsoConfigView;
  readonly runtime: AdminOneLinkSsoRuntimeView;
}

export interface AdminOneLinkSsoRegisterView extends AdminOneLinkSsoView {
  readonly outcome: OneLinkSsoRegisterOutcome;
  readonly upstreamCode: number | null;
  readonly errorCode: string | null;
  readonly traceId: string | null;
}
