import { createHash } from 'node:crypto';

export const sha256Utf8 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
