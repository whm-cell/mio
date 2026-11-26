import { MEDIA_VERSION } from '@mio/compute-contracts';
import { sha256Utf8 } from '@mio/foundation/hash';
import { HttpError } from '@mio/foundation/errors';
import type {
  MediaCommand,
  MediaData,
  MediaFile,
  MediaInputSnapshot,
  MediaOperation,
  MediaRequest,
  WorkerResourceClass,
} from '@mio/compute-contracts';

export type MediaCommandLane = WorkerResourceClass | 'control';
export class MediaError extends HttpError<string> {}
export interface MediaJobRow {
  id: string;
  owner_id: string;
  request_id: string;
  request_hash: string;
  operation: MediaOperation;
  parameters: MediaRequest['parameters'];
  inputs: MediaInputSnapshot[];
  profile: MediaCommand['profile'];
  state:
    | 'accepted'
    | 'queued'
    | 'running'
    | 'reconciling'
    | 'cancel_requested'
    | 'succeeded'
    | 'failed'
    | 'cancelled';
  attempt: 1 | 2 | 3;
  attempt_id: string;
  command_id: string;
  cancel_requested: boolean;
  error_code: string | null;
  stage: string | null;
  progress: number;
  data: MediaData;
  created_at: Date;
  updated_at: Date;
}
export interface MediaJobViewRow extends MediaJobRow {
  outputs: {
    assetId: string;
    name: string;
    role: MediaFile['role'];
    contentType: string;
    sizeBytes: number;
  }[];
}
export interface MediaInputRow {
  id: string;
  raw_key: string;
  size_bytes: string;
  source_etag: string | null;
}
/** Object key order has no application meaning; input and timeline array order does. */
export function canonicalMedia(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalMedia).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(record)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalMedia(record[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}
export function mediaRequestHash(request: MediaRequest): string {
  return sha256Utf8(
    canonicalMedia({
      operation: request.operation,
      inputs: request.inputs,
      parameters: request.parameters,
    }),
  );
}
export function mediaCommand(job: MediaJobRow): MediaCommand {
  return {
    version: MEDIA_VERSION,
    type: 'media.request',
    messageId: job.command_id,
    jobId: job.id,
    attemptId: job.attempt_id,
    attempt: job.attempt,
    profile: job.profile,
    operation: job.operation,
    parameters: job.parameters,
    inputs: job.inputs,
  } as MediaCommand;
}
export function mediaTerminal(job: MediaJobRow): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(job.state);
}
