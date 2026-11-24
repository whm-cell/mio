import { HttpError } from '@mio/foundation/errors';
import type {
  ImageDriver,
  ImageOperation,
  ImageRequestParameters,
} from '../generations/contracts.ts';
import type {
  VideoCapabilitiesView,
  VideoCreateRequest,
  VideoJobView,
  VideoMode,
} from '../generations/video-contracts.ts';
import type { ChatSelection, ChatRuntimeSnapshot } from '../providers/contracts.ts';
/** Application-facing values: no HTTP, authentication driver or DSH objects. */
export interface Principal {
  userId: string;
  sessionId: string;
}
export type RequestStatus =
  'accepted' | 'input-persisted' | 'completed' | 'cancelled' | 'failed' | 'unknown';
export type TerminalRequestStatus = Exclude<RequestStatus, 'accepted' | 'input-persisted'>;
export const isInFlightRequest = (status: RequestStatus) =>
  status === 'accepted' || status === 'input-persisted';
export const outputTruncation = { reason: 'max-tokens', message: '已达输出上限' } as const;
export interface Conversation {
  id: string;
  createdAt: string;
  state: 'creating' | 'ready' | 'unknown';
  modelRef?: string | null;
}
export interface ModelObservation {
  readonly status?: number;
  readonly providerRequestId?: string;
  readonly usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  readonly usageStatus?: 'reported' | 'partial' | 'unknown';
  readonly finish: string;
  readonly failureCode?: string;
}
export interface ConversationRun {
  readonly userId: string;
  readonly conversationId: string;
  readonly dshSessionId: string;
  readonly requestId: string;
  readonly snapshot: ChatRuntimeSnapshot;
  offloadableImages?(): number;
  observe(observation: ModelObservation): Promise<void>;
}
export interface Receipt {
  conversationId: string;
  requestId: string;
  status: RequestStatus;
  error?: string;
  truncation?: typeof outputTruncation;
}
export interface ConversationSnapshot {
  conversationId: string;
  activeRequestId: string | null;
  receipt: Receipt | null;
}
/** Serializable image identity; binary content and private object keys stay outside history. */
export interface ConversationImageReference {
  readonly attachmentId: string;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}
export interface ConversationImageTarget {
  readonly width: number;
  readonly height: number;
  readonly maxBytes: number;
}
export interface ConversationImagePreview {
  readonly variantId: string;
  readonly attachment: ConversationImageReference;
  readonly data: Uint8Array;
  readonly mediaType: ConversationImageReference['mediaType'];
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly depth: 'uchar';
  readonly space: 'srgb';
  readonly hasAlpha: boolean;
  readonly fingerprint: string;
}
export interface ConversationVision {
  prepareRequest(
    ownerId: string,
    assetId: string,
    budget: { maxPixels: number; maxBytes: number },
    signal: AbortSignal,
  ): Promise<{ reference: ConversationImageReference; previewBytes: number }>;
  prepare(
    ownerId: string,
    assetId: string,
    signal: AbortSignal,
  ): Promise<ConversationImageReference>;
  target(
    ref: ConversationImageReference,
    budget: { maxPixels: number; maxBytes: number },
  ): ConversationImageTarget;
  preview(
    ownerId: string,
    ref: ConversationImageReference,
    target: ConversationImageTarget,
    signal: AbortSignal,
  ): Promise<ConversationImagePreview>;
  assetId(ref: ConversationImageReference): string;
  acquireRequest(signal: AbortSignal): Promise<() => void>;
}
export type ConversationImageToolName = 'submit_image_job' | 'get_image_job';
export interface ConversationImageJobOutput {
  readonly index: number;
  readonly assetId: string;
}
export interface ConversationImageJobView {
  readonly jobId: string;
  readonly status: string;
  readonly requestedCount: number;
  readonly errorCode: string | null;
  readonly assetIds: string[];
  readonly outputs: ConversationImageJobOutput[];
}
export interface ConversationImageModelSummary {
  readonly modelRef: string;
  readonly modelId: string;
  readonly name: string;
  readonly vendor: string;
  readonly driver: ImageDriver;
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
  readonly allowedQualities: ('high' | 'medium' | 'low' | 'auto')[];
  readonly allowedBackgrounds: ('transparent' | 'opaque' | 'auto')[];
  readonly allowedOutputFormats: ('png' | 'jpeg' | 'webp')[];
}
export interface ConversationImageTools {
  listModels(actor: { userId: string }): Promise<ConversationImageModelSummary[]>;
  createImage(
    actor: { userId: string },
    requestId: string,
    modelRef: string,
    parameters: ImageRequestParameters,
    signal: AbortSignal,
  ): Promise<ConversationImageJobView>;
  getImage(actor: { userId: string }, jobId: string): Promise<ConversationImageJobView>;
}
export type ConversationVideoToolName = 'submit_video_job' | 'get_video_job';
export interface ConversationVideoModelSummary {
  readonly modelRef: string;
  readonly modelId: string;
  readonly name: string;
  readonly vendor: string;
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly supportedModes: { mode: VideoMode; supported: boolean }[];
}
export interface ConversationVideoJobOutput {
  readonly index: number;
  readonly assetId: string | null;
  readonly status: string;
  readonly errorCode: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly hasAudio: boolean | null;
}
export interface ConversationVideoJobView {
  readonly jobId: string;
  readonly status: VideoJobView['state'];
  readonly mode: VideoMode;
  readonly modelRef: string;
  readonly createdAt: string;
  readonly errorCode: string | null;
  readonly outputs: ConversationVideoJobOutput[];
}
export interface ConversationVideoTools {
  listModels(actor: { userId: string }): Promise<ConversationVideoModelSummary[]>;
  capabilities(actor: { userId: string }, modelRef: string): Promise<VideoCapabilitiesView>;
  createVideo(actor: { userId: string }, request: VideoCreateRequest): Promise<VideoJobView>;
  getVideo(actor: { userId: string }, jobId: string): Promise<VideoJobView>;
  recoverVideo(actor: { userId: string }, jobId: string): Promise<VideoJobView>;
}
export type HistoryItem =
  | {
      seq: number;
      role: 'user' | 'assistant';
      text: string;
      interrupted?: true;
      imageAssetIds?: string[];
    }
  | { seq: number; role: 'tool'; tool: ConversationImageToolName; job: ConversationImageJobView }
  | { seq: number; role: 'tool'; tool: ConversationVideoToolName; job: ConversationVideoJobView }
  | {
      seq: number;
      role: 'status';
      status: 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'unknown';
      truncation?: typeof outputTruncation;
    };
export interface HistoryPage {
  items: HistoryItem[];
  nextAfterSeq: number;
  hasMore: boolean;
}
export type ConversationEvent =
  | { type: 'text'; requestId: string; text: string }
  | {
      type: 'tool';
      requestId: string;
      tool: ConversationImageToolName;
      job: ConversationImageJobView;
    }
  | {
      type: 'tool';
      requestId: string;
      tool: ConversationVideoToolName;
      job: ConversationVideoJobView;
    }
  | { type: 'state'; receipt: Receipt }
  | { type: 'error'; code: string };
export interface ConversationEngine {
  readonly available: boolean;
  create(id: string, selection?: ChatSelection): Promise<void>;
  history(id: string, afterSeq: number, limit: number, signal?: AbortSignal): Promise<HistoryPage>;
  run(
    id: string,
    requestId: string,
    text: string,
    durable: () => Promise<void>,
    emit: (event: ConversationEvent) => void,
    binding?: ConversationRun,
    images?: readonly ConversationImageReference[],
  ): Promise<TerminalRequestStatus | typeof outputTruncation.reason>;
  cancel(id: string, requestId: string): Promise<void>;
  close(): Promise<void>;
}
export class ConversationError extends HttpError {}
