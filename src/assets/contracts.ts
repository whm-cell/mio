import type { Readable } from 'node:stream';
import { HttpError } from '@mio/foundation/errors';

export const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
export const MAX_VISION_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_MATERIAL_SOURCE_BYTES = 20 * 1024 * 1024;

export interface AssetPrincipal {
  userId: string;
  sessionId: string;
}

export interface AssetObjectStore {
  uploadUrl(key: string, size: number, acl?: 'private'): string;
  downloadUrl(key: string): string;
  audioPlaybackUrl?(key: string, contentType: string): string;
  hlsSegmentUrl?(key: string, expiresIn: number): string;
  materialUrl?(key: string): string;
  head(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ size: number; etag: string; sha256?: string; contentType?: string }>;
  readImage?(key: string, etag: string, size: number, signal: AbortSignal): Promise<Uint8Array>;
  readMedia?(key: string, etag: string, size: number, signal: AbortSignal): Promise<Uint8Array>;
  /** Read at most maxBytes under the given ETag and verify the range against the object size. */
  readPrefix?(
    key: string,
    etag: string,
    size: number,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  putImage?(
    key: string,
    bytes: Uint8Array,
    format: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<{ key: string; sizeBytes: number; sha256: string; etag: string; contentType: string }>;
  putVideo?(
    key: string,
    stream: Readable,
    sizeBytes: number,
    sha256: string,
    contentMd5: string,
    signal: AbortSignal,
  ): Promise<{ key: string; sizeBytes: number; sha256: string; etag: string; contentType: string }>;
  readAudio?(key: string, etag: string, size: number, signal: AbortSignal): Promise<Uint8Array>;
  putAudio?(
    key: string,
    bytes: Uint8Array,
    format: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<{ key: string; sizeBytes: number; sha256: string; etag: string; contentType: string }>;
  ensureAudioPrivate?(
    key: string,
    expected: { sizeBytes: number; etag: string; sha256?: string },
    signal: AbortSignal,
  ): Promise<void>;
  copy(
    source: string,
    target: string,
    etag: string,
    acl?: 'private',
    options?: { signal: AbortSignal } & (
      { contentType: string; sha256: string } | { contentType?: never; sha256?: never }
    ),
  ): Promise<{ etag: string } | void>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}

/** Bound caller wait even when a HEAD implementation ignores the optional signal. */
export async function waitForObjectHead<T>(
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return read();
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const pending = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return read();
    });
    const result = await Promise.race([pending, aborted.promise]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
  }
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

export interface VisionSource {
  readonly assetId: string;
  readonly contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly data: Uint8Array;
  readonly etagDigest: string;
  readonly sourceDigest: string;
}

export interface MaterialImageSource extends VisionSource {
  readonly rawKey: string;
  readonly rawEtag: string;
  readonly size: number;
}

export class AssetError extends HttpError<AssetErrorCode> {}
