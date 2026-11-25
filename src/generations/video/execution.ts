import { epochMs } from '@mio/foundation/time';
import type { AccountCredentialSnapshot, VideoRouteConfig } from '../../providers/contracts.ts';
import type {
  VideoAssetReference,
  VideoCreateRequest,
  VideoJobState,
  VideoRequestParameters,
} from './contracts.ts';

export interface VideoJobCommand {
  request: VideoCreateRequest;
  inputSnapshot: VideoAssetReference[];
  inputObjects?: Record<string, { key: string; etag: string }>;
}

export const VIDEO_EXECUTOR_MAX_QUERIES = 360;
export const VIDEO_EXECUTOR_MAX_AGE_SECONDS = 1800;
export const VIDEO_EXECUTOR_QUERY_INTERVAL_MS = 5000;
export const VIDEO_MATERIALIZATION_MAX_ATTEMPTS = 3;
export const VIDEO_QUOTA_LOCK = 672049926;

export interface VideoSubmissionReceipt {
  version: 1;
  jobId: string;
  ownerId: string;
  requestId: string;
  upstreamTaskId: string;
}

export type VideoSubmissionDisposition = 'confirmed' | 'deferred' | 'ineligible';

// The adapter validates the protocol identity. Keep only bounded, printable identifiers on disk.
export function isVideoUpstreamTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7E]{1,1024}$/.test(value) && !value.includes('://');
}

export type VideoResultSource = { url: string } | { errorCode: 'VIDEO_RESULT_INVALID' };

export function hasVideoResultUrl(value: unknown): value is { url: string } {
  return (
    value !== null && typeof value === 'object' && 'url' in value && typeof value.url === 'string'
  );
}

export class VideoResultUrlExpired extends Error {
  constructor() {
    super('VIDEO_RESULT_URL_EXPIRED');
  }
}

export interface VideoRecoveryQuery {
  state: 'available' | 'reserved';
  errorCode?: string;
  refreshed?: Record<number, 'pending' | 'finished'>;
}

/** The checkpoint contains media locators, never a supplier credential. */
export interface VideoCheckpoint {
  videos: VideoResultSource[];
  materializationAttempts: number;
  cleaned?: boolean;
  expired?: Record<number, true>;
  refreshAt?: string;
  recoveryQuery?: VideoRecoveryQuery;
}

export interface VideoExecution {
  id: string;
  owner_id: string;
  state: VideoJobState;
  error_code: string | null;
  command: VideoJobCommand;
  admitted: Record<string, unknown>;
  route_snapshot: { route: VideoRouteConfig; modelId: string };
  phase: 'ready' | 'submitting' | 'waiting' | 'querying' | 'materializing' | 'done';
  claim_id: string;
  snapshot: AccountCredentialSnapshot;
  upstream_task_id: string | null;
  query_attempt: number;
  async_max_queries: number | null;
  async_deadline: Date | null;
  checkpoint: VideoCheckpoint | null;
}

export function hasVideoQueryBudget(row: VideoExecution): boolean {
  return (
    row.query_attempt < (row.async_max_queries ?? 0) &&
    (row.async_deadline?.getTime() ?? 0) > epochMs()
  );
}

export interface VideoMaterializedOutput {
  index: number;
  assetId: string;
  key: string;
  etag: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  width: number;
  height: number;
  durationMs: number;
  hasAudio: boolean;
}

export type VideoMaterializer = (
  row: VideoExecution,
  video: { url: string },
  index: number,
  signal: AbortSignal,
) => Promise<VideoMaterializedOutput>;

export type VideoSubmitResult =
  { state: 'submitted'; upstreamTaskId: string } | { state: 'rejected' | 'unknown'; code: string };
export const VIDEO_QUERY_RETRY_CODES = [
  'VIDEO_QUERY_AUTH',
  'VIDEO_QUERY_RATE_LIMITED',
  'VIDEO_QUERY_UPSTREAM_UNAVAILABLE',
  'VIDEO_QUERY_TIMEOUT',
  'VIDEO_QUERY_NETWORK_ERROR',
  'VIDEO_QUERY_RESPONSE_INVALID',
  'VIDEO_QUERY_CREDENTIAL_UNAVAILABLE',
] as const;

export type VideoQueryRetryCode = (typeof VIDEO_QUERY_RETRY_CODES)[number];
export type VideoQueryResult =
  | { state: 'processing' }
  | { state: 'returned'; videos: VideoResultSource[] }
  | { state: 'unknown'; code: 'VIDEO_QUERY_IDENTITY_INVALID' | 'VIDEO_QUERY_STATUS_UNKNOWN' }
  | { state: 'retry'; code: VideoQueryRetryCode }
  | { state: 'failed'; code: string };
export interface VideoProtocol {
  submit(
    parameters: VideoRequestParameters,
    refs: Record<string, string>,
    key: string,
    signal: AbortSignal,
  ): Promise<VideoSubmitResult>;
  query(id: string, key: string, signal: AbortSignal): Promise<VideoQueryResult>;
}
export type VideoProtocolFactory = (
  route: VideoRouteConfig,
  modelId: string,
  transport?: typeof fetch,
) => VideoProtocol;
