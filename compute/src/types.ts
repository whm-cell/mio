import type { ComputeCommandV1, ComputeResultV1 } from '@mio/compute-contracts';

export type Phase =
  | 'received'
  | 'launching'
  | 'running'
  | 'output_ready'
  | 'uploading'
  | 'unknown_process'
  | 'unknown_upload'
  | 'unknown_mismatch'
  | 'succeeded'
  | 'failed';

export interface Attempt {
  command: ComputeCommandV1;
  phase: Phase;
  pid: number | null;
  processIdentity: string | null;
  outputSize: number | null;
  outputSha256: string | null;
  /** The local ACK call returned; AMQP does not confirm its receipt. */
  ackDispatched: boolean;
  cleaned: boolean;
  startedAt: number;
}

export interface PendingEvent {
  message: ComputeResultV1;
  confirmed: boolean;
}

export interface ObjectInfo {
  sizeBytes: number;
  etag: string;
  sha256: string | null;
}
