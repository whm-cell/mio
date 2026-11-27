import { createId } from '@mio/foundation/identifiers';
import type { CreationLogInput, CreationQuery } from './creation-contracts.ts';

/** Caller owns the result transaction, including rollback when the message insert fails. */
export async function writeCreationLog(
  query: CreationQuery,
  event: CreationLogInput,
): Promise<void> {
  await query(
    `INSERT INTO mio_creation_logs(id,owner_id,media_type,job_id,event_kind,title,summary,occurred_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(owner_id,media_type,job_id,event_kind) DO NOTHING`,
    [
      createId(),
      event.ownerId,
      event.mediaType,
      event.jobId,
      event.eventKind,
      event.title,
      event.summary,
      event.occurredAt,
    ],
  );
}
