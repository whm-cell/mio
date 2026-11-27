export interface AccountDeletionTombstone {
  userId: string;
  finalizedAt: string;
}

/** The external archive is deliberately limited to these two fields, without arbitrary JSON in errors. */
export function parseAccountDeletionTombstone(input: unknown): AccountDeletionTombstone {
  let value: unknown = input;
  if (input instanceof Uint8Array || typeof input === 'string') {
    try {
      value = JSON.parse(typeof input === 'string' ? input : Buffer.from(input).toString('utf8'));
    } catch {
      throw new Error('ACCOUNT_TOMBSTONE_INVALID');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('ACCOUNT_TOMBSTONE_INVALID');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.userId !== 'string' ||
    !record.userId ||
    record.userId.length > 128 ||
    typeof record.finalizedAt !== 'string'
  )
    throw new Error('ACCOUNT_TOMBSTONE_INVALID');
  const time = new Date(record.finalizedAt);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== record.finalizedAt)
    throw new Error('ACCOUNT_TOMBSTONE_INVALID');
  return { userId: record.userId, finalizedAt: record.finalizedAt };
}
