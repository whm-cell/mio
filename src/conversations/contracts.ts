import type { ChatSelection, ChatRuntimeSnapshot } from '../providers/contracts.ts';
/** Application-facing values: no HTTP, authentication driver or DSH objects. */
export interface Principal {
  userId: string;
  sessionId: string;
}
export type RequestStatus =
  'accepted' | 'input-persisted' | 'completed' | 'cancelled' | 'failed' | 'unknown';
export interface Conversation {
  id: string;
  createdAt: string;
  state: 'creating' | 'ready' | 'unknown';
  modelRef?: string | null;
}
export interface ModelObservation {
  readonly status?: number;
  readonly providerRequestId?: string;
  readonly usage?: { inputTokens: number; outputTokens: number; totalTokens?: number };
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
  observe(observation: ModelObservation): Promise<void>;
}
export interface Receipt {
  conversationId: string;
  requestId: string;
  status: RequestStatus;
  error?: string;
}
export type HistoryItem =
  | { seq: number; role: 'user' | 'assistant'; text: string; interrupted?: true }
  | {
      seq: number;
      role: 'status';
      status: 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'unknown';
    };
export interface HistoryPage {
  items: HistoryItem[];
  nextAfterSeq: number;
  hasMore: boolean;
}
export type ConversationEvent =
  | { type: 'text'; requestId: string; text: string }
  | { type: 'state'; receipt: Receipt }
  | { type: 'error'; code: string };
export interface ConversationEngine {
  readonly available: boolean;
  create(id: string, selection?: ChatSelection): Promise<void>;
  history(id: string, afterSeq: number, limit: number): Promise<HistoryPage>;
  run(
    id: string,
    requestId: string,
    text: string,
    durable: () => Promise<void>,
    emit: (event: ConversationEvent) => void,
    binding?: ConversationRun,
  ): Promise<'completed' | 'cancelled' | 'failed' | 'unknown'>;
  cancel(id: string, requestId: string): Promise<void>;
  close(): Promise<void>;
}
export class ConversationError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
