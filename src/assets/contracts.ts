import { HttpError } from '@mio/foundation/errors';

export const MAX_ASSET_BYTES = 1024 * 1024 * 1024;

export interface AssetPrincipal {
  userId: string;
  sessionId: string;
}

export interface AssetObjectStore {
  uploadUrl(key: string, size: number): string;
  downloadUrl(key: string): string;
  head(key: string): Promise<{ size: number; etag: string; sha256?: string }>;
  copy(source: string, target: string, etag: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type AssetErrorCode =
  | 'ASSET_NOT_FOUND'
  | 'ASSET_UNAVAILABLE'
  | 'ASSET_INPUT_INVALID'
  | 'ASSET_EXPIRED'
  | 'ASSET_UPLOAD_NOT_FOUND'
  | 'ASSET_STORAGE_UNAVAILABLE'
  | 'ASSET_SIZE_MISMATCH'
  | 'ASSET_SOURCE_CHANGED'
  | 'ASSET_BUSY'
  | 'ASSET_FINALIZE_SUPERSEDED';

export class AssetError extends HttpError<AssetErrorCode> {}
