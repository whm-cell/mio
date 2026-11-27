import type { AudioJobView, AudioOperation } from '../audio/contracts.ts';
import type {
  VideoCreateRequest,
  VideoJobView,
  VideoMode,
} from '../generations/video/contracts.ts';
import type { FrozenAudioContext } from '../audio/jobs/service.ts';
import { HttpError } from '@mio/foundation/errors';
import type {
  ImageDriver,
  ImageOperation,
  ImageRequestParameters,
} from '../generations/image/contracts.ts';
import type {
  ChatReasoningEffort,
  ChatRuntimeSnapshot,
  ChatSelection,
  VideoParameterSpec,
} from '../providers/contracts.ts';
/** Application-facing values: no HTTP, authentication driver or DSH objects. */
export interface Principal {
  userId: string;
  sessionId: string;
}
export type RequestStatus =
  'accepted' | 'input-persisted' | 'completed' | 'cancelled' | 'failed' | 'unknown';
export type TerminalRequestStatus = Exclude<RequestStatus, 'accepted' | 'input-persisted'>;
export type ModelFailure =
  | 'MODEL_AUTH_FAILED'
  | 'MODEL_QUOTA_EXCEEDED'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_TIMEOUT'
  | 'MODEL_CONTEXT_OVERFLOW'
  | 'MODEL_UPSTREAM_ERROR'
  | 'TURN_STEP_BUDGET_EXCEEDED';
export type ConversationRunResult =
  | TerminalRequestStatus
  | typeof outputTruncation.reason
  | { status: 'failed'; error: ModelFailure };
export const isInFlightRequest = (status: RequestStatus) =>
  status === 'accepted' || status === 'input-persisted';
export const outputTruncation = { reason: 'max-tokens', message: '已达输出上限' } as const;
export const MAX_CONVERSATION_TITLE_BYTES = 120;

export type ConversationPurpose = 'general' | 'drama-script' | 'audio';
export interface AudioSelection {
  voiceRef: string | null;
  name: string | null;
  revision: number;
}
export const emptyAudioSelection: AudioSelection = Object.freeze({
  voiceRef: null,
  name: null,
  revision: 0,
});

export interface ConversationAudioTurn {
  readonly userId: string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly audioContext: FrozenAudioContext;
  readonly audioSelection: AudioSelection;
  selectAudioVoice(voiceRef: string): Promise<AudioSelection>;
}

export interface ConversationTurnContext {
  readonly purpose: ConversationPurpose;
  /** Validated UTF-8 JSON from the trusted project resolver for this turn. */
  readonly projectContext?: string;
  readonly audio?: ConversationAudioTurn;
}

export interface Conversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  state: 'creating' | 'ready' | 'unknown';
  modelRef?: string | null;
  purpose?: 'drama-script' | 'audio';
  audioSelection?: AudioSelection;
  reasoningEffort?: ChatReasoningEffort;
  forkedFromConversationId?: string;
  forkedUntilSeq?: number;
}
export interface ConversationArchive {
  id: string;
  archivedAt: string;
}
export interface ContextUsage {
  estimatedTokens: number;
  contextWindow: number | null;
  compacted: boolean;
}
export type CaptureContextUsage = (read: () => ContextUsage) => void;
export interface ModelObservation {
  readonly status?: number;
  readonly providerRequestId?: string;
  readonly usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  readonly usageStatus?: 'reported' | 'partial' | 'unknown';
  readonly finish: string;
  readonly failureCode?: string;
  readonly purpose?: 'compaction';
}
export interface ConversationRun {
  readonly userId: string;
  readonly conversationId: string;
  readonly dshSessionId: string;
  readonly requestId: string;
  readonly snapshot: ChatRuntimeSnapshot;
  readonly reasoningEffort?: ChatReasoningEffort;
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
  audioSelection?: AudioSelection;
  receipt: Receipt | null;
  contextUsage?: ContextUsage;
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
export type ConversationAudioToolName = 'submit_audio_job' | 'get_audio_job' | 'clone_audio_voice';
export type ConversationToolName =
  | ConversationImageToolName
  | 'list_image_models'
  | 'inspect_image_asset'
  | ConversationVideoToolName
  | 'list_video_models'
  | 'recover_video_job'
  | ConversationAudioToolName
  | 'list_audio_models'
  | 'list_audio_voices'
  | 'select_audio_voice';
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
export type ConversationVideoSubmitParameterSpec = Pick<
  VideoParameterSpec,
  | 'ratios'
  | 'resolutions'
  | 'durations'
  | 'maxPromptCodepoints'
  | 'requiresResolution'
  | 'generateAudio'
  | 'watermark'
>;
export interface ConversationVideoModelSummary {
  readonly modelRef: string;
  readonly modelId: string;
  readonly name: string;
  readonly vendor: string;
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly supportedModes: (
    | {
        mode: 'text_to_video';
        supported: boolean;
        parameters?: ConversationVideoSubmitParameterSpec;
      }
    | { mode: Exclude<VideoMode, 'text_to_video'>; supported: boolean }
  )[];
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
  createVideo(
    actor: { userId: string },
    request: Omit<VideoCreateRequest, 'expectedCapabilitiesVersion'>,
    signal?: AbortSignal,
  ): Promise<VideoJobView>;
  getVideo(actor: { userId: string }, jobId: string): Promise<VideoJobView>;
  recoverVideo(actor: { userId: string }, jobId: string): Promise<VideoJobView>;
}
export interface ConversationAudioTools {
  listModels(actor: { userId: string }, operation: AudioOperation): Promise<unknown[]>;
  listVoices(actor: { userId: string }, query: URLSearchParams): Promise<unknown>;
  create(
    actor: { userId: string },
    body: Record<string, unknown>,
  ): Promise<{ created: boolean; job: AudioJobView }>;
  clone(
    actor: { userId: string },
    body: Record<string, unknown>,
    fingerprint?: string,
  ): Promise<{ created: boolean; job: AudioJobView }>;
  get(actor: { userId: string }, id: string): Promise<AudioJobView>;
  freezeContext(actor: { userId: string }, value: unknown): Promise<FrozenAudioContext>;
  resolveVoice(
    actor: { userId: string },
    voiceRef: string,
  ): Promise<{ voiceRef: string; name: string }>;
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
  | { seq: number; role: 'tool'; tool: ConversationAudioToolName; job: AudioJobView }
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
  | { type: 'reasoning'; requestId: string; text: string }
  | {
      type: 'tool-status';
      requestId: string;
      tool: ConversationToolName;
      status: 'running' | 'completed' | 'failed';
    }
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
  | { type: 'tool'; requestId: string; tool: ConversationAudioToolName; job: AudioJobView }
  | { type: 'audio-selection'; conversationId: string; selection: AudioSelection }
  | { type: 'state'; receipt: Receipt; contextUsage?: ContextUsage }
  | { type: 'error'; code: string };
export interface ConversationEngine {
  readonly available: boolean;
  create(id: string, selection?: ChatSelection): Promise<void>;
  resolveForkBoundary?(sourceId: string, upToSeq?: number): Promise<number>;
  fork?(
    sourceId: string,
    targetId: string,
    upToSeq: number,
    selection?: ChatSelection,
  ): Promise<void>;
  hasRetainedImages?(id: string): Promise<boolean>;
  retainedAssetIds?(id: string): Promise<string[]>;
  rename(id: string, title: string): Promise<string>;
  history(id: string, afterSeq: number, limit: number, signal?: AbortSignal): Promise<HistoryPage>;
  contextUsage?(id: string, signal?: AbortSignal): Promise<ContextUsage>;
  compact?(
    id: string,
    binding: ConversationRun,
    signal: AbortSignal,
    captureContextUsage?: CaptureContextUsage,
  ): Promise<ConversationRunResult>;
  run(
    id: string,
    requestId: string,
    text: string,
    durable: () => Promise<void>,
    emit: (event: ConversationEvent) => void,
    binding?: ConversationRun,
    images?: readonly ConversationImageReference[],
    admitted?: (eventTimeMs: number, autoTitle?: string) => Promise<void>,
    captureContextUsage?: CaptureContextUsage,
    turnContext?: ConversationTurnContext,
  ): Promise<ConversationRunResult>;
  cancel(id: string, requestId: string): Promise<void>;
  close(): Promise<void>;
}
export class ConversationError extends HttpError {}
