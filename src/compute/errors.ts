import { HttpError } from '@mio/foundation/errors';

export type ComputeErrorCode =
  | 'REQUEST_CONFLICT'
  | 'COMPUTE_QUOTA_EXCEEDED'
  | 'ASSET_NOT_FOUND'
  | 'RESULT_CONFLICT'
  | 'COMPUTE_UNAVAILABLE'
  | 'COMPUTE_INPUT_INVALID'
  | 'COMPUTE_STORAGE_UNAVAILABLE'
  | 'ASSET_SIZE_MISMATCH'
  | 'NOT_FOUND'
  | 'JOB_NOT_FOUND';

export class ComputeError extends HttpError<ComputeErrorCode> {}
