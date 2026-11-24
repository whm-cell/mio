import type { AccountCredentialSnapshot, VideoRouteConfig } from '../providers/contracts.ts';
import type {
  VideoCreateRequest,
  VideoJobState,
  VideoRequestParameters,
} from './video-contracts.ts';

export interface VideoJobCommand {
  request: VideoCreateRequest;
  inputSnapshot: { assetId: string; mediaType?: 'image' | 'audio' | 'video'; role?: string }[];
}

export const VIDEO_EXECUTOR_MAX_QUERIES = 360;
export const VIDEO_EXECUTOR_MAX_AGE_SECONDS = 1800;
export const VIDEO_EXECUTOR_QUERY_INTERVAL_MS = 5000;

export interface VideoResultSource {
  url: string;
}

/** The checkpoint contains media locators, never a supplier credential. */
export interface VideoCheckpoint {
  videos: VideoResultSource[];
  materializationAttempts: number;
  cleaned?: boolean;
}

export interface VideoExecution {
  id: string;
  owner_id: string;
  state: VideoJobState;
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
  videos: VideoResultSource[],
  signal: AbortSignal,
) => Promise<VideoMaterializedOutput[]>;

export type VideoSubmitResult =
  { state: 'submitted'; upstreamTaskId: string } | { state: 'rejected' | 'unknown'; code: string };
export type VideoQueryResult =
  | { state: 'processing' }
  | { state: 'returned'; videos: VideoResultSource[] }
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
