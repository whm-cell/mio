import { createId } from '@mio/foundation/identifiers';
import { createLogger } from '@mio/foundation/logging';
import { AUDIO_EVENT_MAX_AGE_DAYS } from '../../notifications/creation-contracts.ts';
import type { CreationLogInput, CreationQuery } from '../../notifications/creation-contracts.ts';

const log = createLogger('app', 'audio-creation-outbox');

/** This query runs in the same providers transaction as ready/definitive-failure publication. */
export async function enqueueAudioCreationLog(
  query: CreationQuery,
  jobId: string,
  eventKind: 'completed' | 'failed',
) {
  await query(
    `INSERT INTO mio_audio_creation_outbox(event_id,owner_id,job_id,event_kind,occurred_at,payload)
     SELECT $1,owner_id,id,$2,updated_at,jsonb_build_object(
       'ownerId',owner_id,'mediaType','audio','jobId',id,'eventKind',$2::text,
       'title',$3::text,'summary',$4::text,
       'occurredAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
     FROM mio_audio_jobs WHERE id=$5
     ON CONFLICT(job_id,event_kind) DO NOTHING`,
    [
      createId(),
      eventKind,
      eventKind === 'completed' ? '音频创作完成' : '音频创作失败',
      eventKind === 'completed' ? '音频作品已保存，可在作品记录中查看。' : '本次音频创作确定失败。',
      jobId,
    ],
  );
}

export function createAudioCreationOutbox(query: CreationQuery) {
  let running: Promise<void> | undefined;
  return {
    deliver(receive: (eventId: string, event: CreationLogInput) => Promise<void>) {
      return (running ??= (async () => {
        // Claim a small batch in one short statement, then release the providers connection before I/O.
        const lease = createId();
        const { rows } = await query<{
          event_id: string;
          payload: CreationLogInput;
        }>(
          `UPDATE mio_audio_creation_outbox SET lease_id=$1,lease_until=statement_timestamp()+interval '30 seconds'
           WHERE event_id IN (
             SELECT event_id FROM mio_audio_creation_outbox WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND NOT EXISTS(SELECT 1 FROM mio_closed_accounts c WHERE c.user_id=mio_audio_creation_outbox.owner_id)
             AND (lease_until IS NULL OR lease_until<=statement_timestamp())
             AND (next_attempt_at<=statement_timestamp() OR occurred_at<=statement_timestamp()-$2*interval '24 hours')
             ORDER BY occurred_at,event_id LIMIT 20 FOR UPDATE SKIP LOCKED)
           RETURNING event_id,payload`,
          [lease, AUDIO_EVENT_MAX_AGE_DAYS],
        );
        for (const row of rows) {
          // Recheck immediately before every callback: earlier deliveries can take time.
          const eligible = await query<{ expired: boolean }>(
            `SELECT occurred_at<=statement_timestamp()-$3*interval '24 hours' AS expired
             FROM mio_audio_creation_outbox WHERE event_id=$1 AND lease_id=$2 AND lease_until>statement_timestamp()`,
            [row.event_id, lease, AUDIO_EVENT_MAX_AGE_DAYS],
          );
          if (!eligible.rows[0]) continue;
          if (eligible.rows[0].expired) {
            await query(
              `UPDATE mio_audio_creation_outbox SET dead_lettered_at=now(),lease_id=NULL,lease_until=NULL
              WHERE event_id=$1 AND lease_id=$2`,
              [row.event_id, lease],
            );
            log.warn('AUDIO_CREATION_EVENT_EXPIRED', {
              messageId: row.event_id,
              jobId: row.payload.jobId,
            });
            continue;
          }
          try {
            await receive(row.event_id, row.payload);
            await query(
              `UPDATE mio_audio_creation_outbox SET delivered_at=now(),lease_id=NULL,lease_until=NULL
              WHERE event_id=$1 AND lease_id=$2`,
              [row.event_id, lease],
            );
          } catch {
            await query(
              `UPDATE mio_audio_creation_outbox SET next_attempt_at=now()+interval '1 minute',
              lease_id=NULL,lease_until=NULL WHERE event_id=$1 AND lease_id=$2`,
              [row.event_id, lease],
            );
            log.warn('AUDIO_CREATION_DELIVERY_DEFERRED', {
              messageId: row.event_id,
              jobId: row.payload.jobId,
            });
          }
        }
      })().finally(() => {
        running = undefined;
      }));
    },
  };
}

export function startAudioCreationDelivery(
  outbox: ReturnType<typeof createAudioCreationOutbox>,
  receive: (eventId: string, event: CreationLogInput) => Promise<void>,
) {
  let closing: Promise<void> | undefined;
  let active: Promise<void> | undefined;
  const tick = () => {
    if (!closing && !active)
      active = outbox
        .deliver(receive)
        .catch(() => log.warn('AUDIO_CREATION_DELIVERY_UNAVAILABLE'))
        .finally(() => {
          active = undefined;
        });
  };
  const timer = setInterval(tick, 1000);
  timer.unref();
  tick();
  return {
    close() {
      clearInterval(timer);
      return (closing ??= active ?? Promise.resolve());
    },
  };
}
