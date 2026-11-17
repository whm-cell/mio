import type { ImageDriver, ImageInput, ImageRouteConfig } from './contracts.ts';
import type { ImageAdmissionSnapshot } from '../providers/contracts.ts';
import type { AssetObjectStore } from '../assets/contracts.ts';

export interface GenerationRequest {
  version: 1;
  type: 'image.request';
  messageId: string;
  jobId: string;
  ownerId: string;
  expiresAt: number;
  profile: ImageDriver;
  route: ImageRouteConfig;
  input: ImageInput;
}

export interface GeneratedObject {
  key: string;
  sizeBytes: number;
  sha256: string;
  etag: string;
  contentType: string;
}

export type GenerationObjects = AssetObjectStore;

export interface SavedImage {
  index: number;
  file: string;
  format: 'png' | 'jpeg' | 'webp';
  sizeBytes: number;
  sha256: string;
}

/** No supplier credential is ever written into this recovery document. */
export interface ImageCheckpoint {
  version: 1;
  revision: number;
  jobId: string;
  commandId: string;
  expectedCount: number;
  receivedAll: boolean;
  images: SavedImage[];
  invalidIndices: number[];
  outputs: Record<string, GeneratedObject>;
  attemptedKeys: Record<string, string[]>;
  attempts: number;
  lastRecoverySequence: number;
}

export interface CheckpointRef {
  file: string;
  sha256: string;
  revision: number;
}

export interface GenerationExecution {
  id: string;
  owner_id: string;
  state: string;
  command: GenerationRequest;
  admitted: Record<string, unknown>;
  active_recovery_seq: number;
  upstream_task_id: string | null;
  query_attempt: number;
  async_max_queries: number | null;
  async_deadline: Date | null;
  phase: 'ready' | 'submitting' | 'waiting' | 'querying' | 'materializing' | 'done';
  claim_id: string;
  snapshot: ImageAdmissionSnapshot | null;
  checkpoint: CheckpointRef | null;
}
