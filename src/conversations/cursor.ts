import { HTTP_STATUS } from '@mio/foundation/http-status';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { ConversationError } from './contracts.ts';

export type ConversationCursor =
  { kind: 'legacy'; id: string } | { kind: 'activity'; updatedAt: string; id: string };

export function parseConversationCursor(after: string | undefined): ConversationCursor | undefined {
  if (after === undefined) return;
  if (isUuidV4(after)) return { kind: 'legacy', id: after };
  try {
    if (after.length > 256 || !/^[A-Za-z0-9_-]+$/.test(after)) throw new Error();
    const bytes = Buffer.from(after, 'base64url');
    if (bytes.toString('base64url') !== after) throw new Error();
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      !('v' in value) ||
      value.v !== 1 ||
      !('updatedAt' in value) ||
      typeof value.updatedAt !== 'string' ||
      !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.updatedAt) ||
      new Date(value.updatedAt).toISOString() !==
        value.updatedAt.replace(/(\.\d{3})\d{3}Z$/, '$1Z') ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !isUuidV4(value.id)
    )
      throw new Error();
    return { kind: 'activity', updatedAt: value.updatedAt, id: value.id };
  } catch {
    throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
  }
}

export function encodeConversationCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, updatedAt, id })).toString('base64url');
}
