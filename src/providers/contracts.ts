import { HttpError } from '@mio/foundation/errors';
import type { ImageGeometryEdge, ImageOperation, ImageProfile } from '@mio/compute-contracts';

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

export type ChatProfile = 'openai-chat' | 'anthropic-messages';
/** Evidence for an implemented protocol adaptation; catalog membership is deliberately absent. */
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
  image?: ImageCapabilityMetadata;
}
export interface AdaptationDeclaration {
  modelRef: string;
  operation: 'chat' | 'image.generate';
  profile: ChatProfile | ImageProfile;
  sourceKind: AdaptationSourceKind;
  source: string;
  sourceVersion: string;
  classification?: Category;
  metadata?: AdaptationCapabilityMetadata;
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
export interface AdaptationRecord {
  model_key: string;
  operation: 'chat' | 'image.generate';
  profile: ChatProfile | ImageProfile;
  declaration_version: number;
  source_kind: AdaptationSourceKind;
  source: string;
  source_version: string;
  capability_metadata: AdaptationCapabilityMetadata;
  verification_status: 'unverified' | 'verified';
  verified_at: string | null;
  verification_evidence: string | null;
  tested_tuple: Record<string, unknown> | null;
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
export interface ChatRuntimeSnapshot extends ChatSelection {
  readonly providerRevision: number;
  readonly credentialVersion: number;
  readonly capabilityVersion: string;
  readonly modelKey: string;
  readonly catalogVersion: number;
  readonly adaptationVersion: number;
  readonly operation: 'chat';
  readonly profile: ChatProfile;
  readonly contextWindow?: number;
  readonly apiKey: string;
}
