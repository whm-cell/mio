import { Pool } from 'pg';
import { createLogger } from '@mio/foundation/logging';
import { NotificationError } from './contracts.ts';
import { AUDIO_EVENT_MAX_AGE_DAYS, AUDIO_RECEIPT_TTL_DAYS } from './creation-contracts.ts';
import type { CreationLog, CreationLogInput, CreationCursor } from './creation-contracts.ts';
import { checkCreationLogSchema } from './creation-schema.ts';
import { writeCreationLog } from './creation-write.ts';

const log = createLogger('app', 'creation-logs');
const BATCH_SIZE = 100;
const BATCH_INTERVAL_MS = 1000;
interface Row {
  id: string;
  media_type: CreationLogInput['mediaType'];
  job_id: string;
  event_kind: CreationLogInput['eventKind'];
  title: string;
  summary: string;
  occurred_at: Date;
  cursor_time: string;
  read_at: Date | null;
}

// Ordinary policies use the time index. Very large valid day counts exceed PostgreSQL's interval range;
// compare numeric epochs for that rare case rather than accepting a setting that breaks every read.
function retentionWindowSQL(days: number | null, parameter: string): string {
  if (days !== null && days > 1_000_000)
    return `(extract(epoch from statement_timestamp())-extract(epoch from occurred_at)<${parameter}::numeric*86400)`;
  return `(${parameter}::double precision IS NULL OR occurred_at>statement_timestamp()-${parameter}*interval '24 hours')`;
}

export async function createCreationLogStore(
  databaseURL: string,
  retentionDays: () => number | null,
) {
  const pool = new Pool({
    connectionString: databaseURL,
    max: 3,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 5000,
  });
  pool.on('error', () => log.error('CREATION_LOG_DATABASE_CONNECTION_ERROR'));
  try {
    await checkCreationLogSchema(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  let closing: Promise<void> | undefined;
  let cleaning: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new NotificationError(503, 'NOTIFICATIONS_UNAVAILABLE'));
    const task = Promise.resolve().then(operation);
    active.add(task);
    void task.finally(() => active.delete(task)).catch(() => {});
    return task;
  };
  // Every batch reads the current snapshot. A failed/expired policy stops deletion, not retention filtering.
  const cleanupBatch = async () => {
    await pool.query(
      `DELETE FROM mio_audio_creation_receipts WHERE event_id IN (
       SELECT event_id FROM mio_audio_creation_receipts
       WHERE recorded_at<=statement_timestamp()-$1*interval '24 hours'
       ORDER BY recorded_at,event_id LIMIT $2 FOR UPDATE SKIP LOCKED)`,
      [AUDIO_RECEIPT_TTL_DAYS, BATCH_SIZE],
    );
    const days = retentionDays();
    if (days !== null)
      await pool.query(
        `DELETE FROM mio_creation_logs WHERE id IN (
       SELECT id FROM mio_creation_logs WHERE NOT ${retentionWindowSQL(days, '$1')}
       ORDER BY occurred_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)`,
        [days, BATCH_SIZE],
      );
  };
  const cleanup = () =>
    (cleaning ??= run(cleanupBatch).finally(() => {
      cleaning = undefined;
    }));
  const timer = setInterval(() => {
    void cleanup().catch(() => log.warn('CREATION_LOG_CLEANUP_UNAVAILABLE'));
  }, BATCH_INTERVAL_MS);
  timer.unref();
  return {
    list(owner: string, page: number, pageSize: number, cursor?: CreationCursor) {
      return run(async () => {
        const days = retentionDays();
        const { rows } = await pool.query<Row>(
          `SELECT *,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time FROM mio_creation_logs WHERE owner_id=$1
           AND ${retentionWindowSQL(days, '$2')}
           AND ($3::timestamptz IS NULL OR (occurred_at,id)<($3::timestamptz,$4::uuid))
           ORDER BY occurred_at DESC,id DESC LIMIT $5`,
          [owner, days, cursor?.occurredAt ?? null, cursor?.id ?? null, pageSize + 1],
        );
        const items: CreationLog[] = rows.slice(0, pageSize).map((row) => ({
          id: row.id,
          mediaType: row.media_type,
          jobId: row.job_id,
          eventKind: row.event_kind,
          title: row.title,
          summary: row.summary,
          occurredAt: row.occurred_at.toISOString(),
          isRead: row.read_at !== null,
        }));
        const last = items.at(-1);
        const hasMore = rows.length > pageSize;
        return {
          items,
          page,
          pageSize,
          hasMore,
          nextCursor:
            hasMore && last
              ? Buffer.from(
                  JSON.stringify({ occurredAt: rows[items.length - 1]!.cursor_time, id: last.id }),
                ).toString('base64url')
              : null,
        };
      });
    },
    markRead(owner: string, id: string) {
      return run(async () => {
        const days = retentionDays();
        const result = await pool.query(
          `UPDATE mio_creation_logs SET read_at=COALESCE(read_at,statement_timestamp()) WHERE id=$1 AND owner_id=$2
           AND ${retentionWindowSQL(days, '$3')}`,
          [id, owner, days],
        );
        if (!result.rowCount) throw new NotificationError(404, 'NOTIFICATION_NOT_FOUND');
      });
    },
    receiveAudio(eventId: string, event: CreationLogInput): Promise<void> {
      return run(async () => {
        if (event.mediaType !== 'audio') throw new Error('CREATION_LOG_EVENT_INVALID');
        const client = await pool.connect();
        let discard = false;
        const disconnected = () => {
          discard = true;
        };
        // Checked-out clients are no longer covered by the pool's idle error listener.
        client.on('error', disconnected);
        try {
          await client.query('BEGIN');
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('mio:closed-account:'||$1,0))",
            [event.ownerId],
          );
          if (
            (
              await client.query('SELECT 1 FROM mio_closed_accounts WHERE user_id=$1', [
                event.ownerId,
              ])
            ).rowCount
          ) {
            await client.query('COMMIT');
            return;
          }
          const days = retentionDays();
          const receipt = await client.query<{ in_window: boolean }>(
            `INSERT INTO mio_audio_creation_receipts(event_id) VALUES($1) ON CONFLICT DO NOTHING
             RETURNING ($2::timestamptz>statement_timestamp()-$3*interval '24 hours'
               AND ($4::double precision IS NULL OR $2::timestamptz>statement_timestamp()-$4*interval '24 hours')) AS in_window`,
            [
              eventId,
              event.occurredAt,
              AUDIO_EVENT_MAX_AGE_DAYS,
              Math.min(days ?? AUDIO_EVENT_MAX_AGE_DAYS, AUDIO_EVENT_MAX_AGE_DAYS),
            ],
          );
          if (receipt.rows[0]?.in_window) await writeCreationLog(client.query.bind(client), event);
          await client.query('COMMIT');
        } catch (error) {
          if (!discard) {
            try {
              await client.query('ROLLBACK');
            } catch {
              discard = true;
            }
          }
          throw error;
        } finally {
          client.removeListener('error', disconnected);
          client.release(discard);
        }
      });
    },
    cleanup,
    close() {
      clearInterval(timer);
      return (closing ??= Promise.allSettled([...active]).then(() => pool.end()));
    },
  };
}
export type CreationLogStore = Awaited<ReturnType<typeof createCreationLogStore>>;
