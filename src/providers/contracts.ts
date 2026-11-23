import { HttpError } from '@mio/foundation/errors';
import type {
  ImageDriver,
  ImageGeometryEdge,
  ImageOperation,
  ImageRouteConfig,
} from '../generations/contracts.ts';

/** Provider values are independent of the Agent framework and authentication library. */
export interface ProviderPrincipal {
  userId: string;
  sessionId: string;
}
export const categories = ['chat', 'image', 'video', 'voice', 'music'] as const;
export type Category = (typeof categories)[number];
export class ProviderError extends HttpError {}
export interface Discovery {
  credentialVersion: number;
  checkedAt: string;
  status: 'connected' | 'failed';
  scope: 'models-only';
  ids: string[];
  error: string | null;
  refreshSeq: number;
}
export interface ProviderView {
  id: string;
  type: 'onelink';
  enabled: boolean;
  hasKey: true;
  masked: '********';
  credentialVersion: number;
  revision: number;
  defaultImageWatermark: boolean;
  defaultVideoWatermark: boolean;
  discovery: Discovery | null;
  catalog: {
    version: number | null;
    credentialVersion: number | null;
    succeededAt: string | null;
    current: boolean;
    stale: boolean;
  };
  credentialAuthState: 'unchecked' | 'valid' | 'rejected';
  lastAttempt: {
    seq: number;
    credentialVersion: number;
    startedAt: string;
    finishedAt: string | null;
    status: 'running' | 'connected' | 'failed';
    error: string | null;
  } | null;
}
export interface ModelPreference {
  model_key: string;
  usage: Category;
  enabled: boolean;
  is_default: boolean;
}

export const CHAT_PROFILES = ['openai-chat', 'anthropic-messages'] as const;
export type ChatProfile = (typeof CHAT_PROFILES)[number];
export type ChatCacheRetention = 'none' | 'short' | 'long';
/** Evidence for an implemented protocol route; catalog membership is deliberately absent. */
export type AdaptationSourceKind = 'protocol-reference' | 'runtime-observation';
export interface ImageCapabilityMetadata {
  modes: ImageOperation[];
  mask?: { format: 'png' };
  references?: { maxImages: number };
  geometry?: { unit: 'pixels'; edges: ImageGeometryEdge[] };
  async?: {
    operations: ImageOperation[];
    maxQueries: number;
    maxAgeSeconds: number;
  };
}
export interface ImageParameterView {
  readonly supportedOperations: ImageOperation[];
  readonly requiresAsync: boolean;
  readonly maxN: number;
  readonly allowExplicitN: boolean;
  readonly allowedSizes: string[] | null;
  readonly defaultSize: string | null;
  readonly allowCustomDimensions: boolean;
  readonly allowedAspectRatios: string[];
  readonly maxReferenceImages: number;
  readonly allowGenerateReferences: boolean;
  readonly allowMaskPng: boolean;
  readonly allowOutpaintGeometry: boolean;
  readonly allowedQualities: ('high' | 'medium' | 'low' | 'auto')[];
  readonly allowedBackgrounds: ('transparent' | 'opaque' | 'auto')[];
  readonly allowedModerations: ('low' | 'auto')[];
  readonly allowedOutputFormats: ('png' | 'jpeg' | 'webp')[];
  readonly fixedOutputFormat: 'png' | 'jpeg' | 'webp' | null;
  readonly allowOutputCompression: boolean;
  readonly allowWatermarkOverride: boolean;
  readonly defaultWatermark: boolean | null;
}
export interface AdaptationCapabilityMetadata {
  contextWindow?: number;
  maxOutputTokens?: number;
  cacheRetention?: ChatCacheRetention;
  inputModalities?: ('text' | 'image')[];
  maxRequestImages?: number;
  maxRequestImageBytes?: number;
  requestImagePixelBudget?: number;
  requestImageMaxBytes?: number;
  image?: ImageCapabilityMetadata;
}

export interface ChatImageBudget {
  readonly maxRequestImages: number;
  readonly maxRequestImageBytes: number;
  readonly requestImagePixelBudget: number;
  readonly requestImageMaxBytes: number;
}

export const DEFAULT_CHAT_IMAGE_BUDGET: ChatImageBudget = Object.freeze({
  maxRequestImages: 4,
  maxRequestImageBytes: 10 * 1024 * 1024,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 5 * 1024 * 1024,
});
export interface ModelRecord {
  model_key: string;
  raw_model_id: string | null;
  legacy_ref: string | null;
  unavailable_reason: string | null;
  supplier_metadata: Record<string, unknown>;
  display_name: string | null;
  description_override: string | null;
  metadata_source: string | null;
  credential_version: number | null;
  catalog_version: number | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  membership_state: 'current' | 'removed' | 'historical';
}
export interface PlatformRouteRecord {
  provider_type: 'onelink';
  raw_model_id: string;
  operation: 'chat' | 'image.generate';
  vendor: string;
  driver: string;
  classification: Category;
  submit_path: string;
  edit_path: string | null;
  query_path_template: string | null;
  param_spec: Record<string, unknown>;
  request_defaults: Record<string, unknown>;
  output_spec: Record<string, unknown>;
  capability_metadata: AdaptationCapabilityMetadata;
  source_kind: AdaptationSourceKind;
  source: string;
  source_version: string;
  declaration_version: number;
  enabled: boolean;
}
export interface VerificationRecord {
  provider_id: string;
  model_key: string;
  operation: 'chat' | 'image.generate';
  declaration_version: number;
  driver: string;
  verification_status: 'unverified' | 'verified';
  verified_at: string | null;
  verification_evidence: string | null;
  tested_tuple: Record<string, unknown> | null;
}

export type PlatformModelOriginSource = 'onelink-import' | 'admin-manual' | 'route-import';

export interface PlatformCatalogModelRecord {
  provider_type: 'onelink';
  raw_model_id: string;
  display_label: string | null;
  vendor_label: string | null;
  category: Category | null;
  description: string | null;
  supplier_metadata: Record<string, unknown>;
  user_visible: boolean;
  allow_undiscovered: boolean;
  call_notes: string | null;
  origin_source: PlatformModelOriginSource;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export type RouteRevisionAction =
  'create' | 'update' | 'enable' | 'disable' | 'delete' | 'rollback' | 'cli-import';

export interface RouteRevisionActor {
  readonly actorType: 'admin' | 'cli';
  readonly actorId?: string | null;
  readonly actorName: string;
  readonly summary?: string | null;
  readonly actionOverride?: 'rollback' | 'cli-import';
}

export interface PlatformRouteRevisionRecord {
  id: string;
  provider_type: 'onelink';
  raw_model_id: string;
  operation: 'chat' | 'image.generate';
  declaration_version: number;
  action: RouteRevisionAction;
  actor_type: 'admin' | 'cli';
  actor_id: string | null;
  actor_name: string;
  summary: string | null;
  before_route: Record<string, unknown> | null;
  after_route: Record<string, unknown> | null;
  created_at: string;
}

export interface ModelRouteInput {
  providerType?: 'onelink';
  rawModelId: string;
  operation: 'chat' | 'image.generate';
  vendor: string;
  driver: ChatProfile | ImageDriver;
  classification: Category;
  submitPath: string;
  editPath?: string | null;
  queryPathTemplate?: string | null;
  paramSpec?: Record<string, unknown>;
  requestDefaults?: Record<string, unknown>;
  outputSpec?: Record<string, unknown>;
  capabilityMetadata?: AdaptationCapabilityMetadata;
  sourceKind: AdaptationSourceKind;
  source: string;
  sourceVersion: string;
  enabled?: boolean;
}

export interface VerificationSnapshot {
  readonly providerConfigId: string;
  readonly credentialVersion: number;
  readonly catalogVersion: number;
  readonly adaptationVersion: number;
  readonly modelKey: string;
  readonly operation: 'chat' | 'image.generate';
  readonly profile: string;
}

/** Frozen logical selection. Credentials are resolved only when accepting a new input. */
export interface ChatSelection {
  readonly providerConfigId: string;
  readonly modelRef: string;
  readonly modelId: string;
  readonly modelKey?: string;
  readonly protocol: ChatProfile;
}
/** Request-owned memory only. Never serialize this object into logs, receipts or storage. */
export interface ChatRuntimeSnapshot extends ChatSelection, VerificationSnapshot {
  readonly providerRevision: number;
  readonly credentialVersion: number;
  readonly capabilityVersion: string;
  readonly modelKey: string;
  readonly catalogVersion: number;
  readonly adaptationVersion: number;
  readonly vendor?: string;
  readonly operation: 'chat';
  readonly profile: ChatProfile;
  readonly submitPath?: string;
  readonly maxOutputTokens?: number;
  readonly contextWindow?: number;
  readonly cacheRetention?: ChatCacheRetention;
  readonly inputModalities?: readonly ('text' | 'image')[];
  readonly imageBudget?: ChatImageBudget;
  readonly apiKey: string;
}
/** Account resources have no model/catalog dependency. Open only for one controlled outbound request. */
export interface AccountCredentialSnapshot {
  readonly providerConfigId: string;
  readonly credentialVersion: number;
  readonly credential: {
    readonly cipherFormat: number;
    readonly masterKeyId: string;
    readonly nonce: string;
    readonly ciphertext: string;
    readonly authTag: string;
  };
}

/** Durable admission keeps encrypted provider bytes; only an outbound action opens them. */
export interface ImageAdmissionSnapshot extends AccountCredentialSnapshot {
  readonly modelId: string;
  readonly modelKey: string;
  readonly vendor: string;
  readonly profile: ImageDriver;
  readonly route: ImageRouteConfig;
  readonly defaultImageWatermark: boolean;
  readonly capabilityMetadata: AdaptationCapabilityMetadata;
  readonly providerRevision: number;
  readonly catalogVersion: number;
  readonly adaptationVersion: number;
}
