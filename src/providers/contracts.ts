import { HttpError } from '@mio/foundation/errors';
import type {
  ImageDriver,
  ImageGeometryEdge,
  ImageOperation,
  ImageRouteConfig,
} from '@mio/compute-contracts';

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
export interface AdaptationCapabilityMetadata {
  contextWindow?: number;
  maxOutputTokens?: number;
  image?: ImageCapabilityMetadata;
}
export interface ModelRecord {
  model_key: string;
  raw_model_id: string | null;
  legacy_ref: string | null;
  unavailable_reason: string | null;
  supplier_metadata: Record<string, unknown>;
  display_name: string | null;
  description_override: string | null;
  classification: Category | null;
  classification_source: string | null;
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
  readonly apiKey: string;
}
/** Request-owned memory only. Never serialize this object into logs, receipts or storage. */
export interface ImageRuntimeSnapshot {
  readonly modelId: string;
  readonly modelKey: string;
  readonly vendor: string;
  readonly profile: ImageDriver;
  readonly route: ImageRouteConfig;
  readonly defaultImageWatermark: boolean;
  readonly capabilityMetadata: AdaptationCapabilityMetadata;
  readonly providerRevision: number;
  readonly providerConfigId: string;
  readonly credentialVersion: number;
  readonly catalogVersion: number;
  readonly adaptationVersion: number;
  readonly apiKey: string;
}
