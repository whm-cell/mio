import { createHash } from 'node:crypto';

export const sha256Utf8 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const sha256Bytes = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
