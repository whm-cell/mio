export interface CreationLogInput {
  ownerId: string;
  mediaType: 'image' | 'video' | 'audio';
  jobId: string;
  eventKind: 'completed' | 'partial' | 'failed';
  title: string;
  summary: string;
  occurredAt: string;
}

export interface CreationLog extends Omit<CreationLogInput, 'ownerId'> {
  id: string;
  isRead: boolean;
}

export interface CreationCursor {
  occurredAt: string;
  id: string;
}

export type CreationQuery = <Row extends object>(
  sql: string,
  values?: unknown[],
) => Promise<{ rows: Row[]; rowCount: number | null }>;

export const AUDIO_EVENT_MAX_AGE_DAYS = 7;
export const AUDIO_RECEIPT_TTL_DAYS = 8;
