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

export class AssetError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
