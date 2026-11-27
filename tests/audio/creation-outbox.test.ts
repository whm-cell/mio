import type { AudioInspection } from '@mio/compute-contracts';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { checkAudioSchema } from '../../src/audio/jobs/schema.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { creationLogSchemaSQL } from '../../src/notifications/creation-schema.ts';
import { createCreationLogStore } from '../../src/notifications/creation-store.ts';
import { createAudioStore } from '../../src/audio/jobs/store.ts';
import type { AudioJobRow } from '../../src/audio/jobs/store.ts';
import {
  createAudioCreationOutbox,
  enqueueAudioCreationLog,
  startAudioCreationDelivery,
} from '../../src/audio/jobs/creation-outbox.ts';
import type { CreationLogInput } from '../../src/notifications/creation-contracts.ts';

let db: Awaited<ReturnType<typeof authDatabase>>,
  mediaDB: Awaited<ReturnType<typeof authDatabase>>,
  pool: Pool,
  media: Pool;
let consumer: Awaited<ReturnType<typeof createCreationLogStore>>,
  audio: ReturnType<typeof createAudioStore>;
beforeAll(async () => {
  db = await authDatabase();
  mediaDB = await authDatabase();
  pool = new Pool({ connectionString: db.url });
  media = new Pool({ connectionString: mediaDB.url });
  await pool.query(providerSchemaSQL);
  await media.query(creationLogSchemaSQL);
  consumer = await createCreationLogStore(mediaDB.url, () => null);
  audio = createAudioStore(pool.query.bind(pool), async (action) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client.query.bind(client));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });
});
beforeEach(async () => {
  await pool.query('TRUNCATE mio_audio_creation_outbox,mio_audio_records,mio_audio_jobs CASCADE');
  await media.query('TRUNCATE mio_creation_logs,mio_audio_creation_receipts');
});
afterAll(async () => {
  await consumer?.close();
  await pool?.end();
  await media?.end();
  await db?.close();
  await mediaDB?.close();
});
async function job() {
  const id = randomUUID(),
    lease = randomUUID(),
    asset = randomUUID();
  await pool.query(
    `INSERT INTO mio_audio_jobs(id,owner_id,request_id,digest,kind,status,input,admission,output_asset_id,output_key,
    output_bytes,output_etag,output_sha256,lease_id,lease_until)
    VALUES($1,'audio-owner',$2,'digest','tts','materializing','{"text":"hello","modelRef":"test-model","voiceName":"test"}','{}',$3,'private-key',$4,'etag',$5,$6,now()+interval '1 hour')`,
    [id, randomUUID(), asset, Buffer.from('output'), 'a'.repeat(64), lease],
  );
  return {
    id,
    owner_id: 'audio-owner',
    kind: 'tts',
    status: 'materializing',
    input: { text: 'hello', modelRef: 'test-model', voiceName: 'test' },
    admission: {},
    output_bytes: Buffer.from('output'),
    output_url: null,
    output_asset_id: asset,
    output_key: 'private-key',
    lease_id: lease,
  } as AudioJobRow;
}
const inspection: AudioInspection = {
  durationMs: 1000,
  format: 'wav',
  mimeType: 'audio/wav',
  codec: 'pcm_s16le',
  sampleRate: 32000,
  channels: 1,
  sizeBytes: 6,
  sha256: 'a'.repeat(64),
};

it('rolls back ready and record publication when outbox insertion fails, then recovers without another generation', async () => {
  const row = await job();
  await pool.query(`CREATE FUNCTION fail_audio_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture outbox failure'; END $$;
    CREATE TRIGGER fail_audio_outbox BEFORE INSERT ON mio_audio_creation_outbox FOR EACH ROW EXECUTE FUNCTION fail_audio_outbox()`);
  await expect(audio.publish(row, inspection)).rejects.toThrow('fixture outbox failure');
  expect(
    (await pool.query('SELECT status FROM mio_audio_jobs WHERE id=$1', [row.id])).rows[0],
  ).toEqual({ status: 'materializing' });
  expect((await pool.query('SELECT * FROM mio_audio_records')).rowCount).toBe(0);
  await pool.query(
    'DROP TRIGGER fail_audio_outbox ON mio_audio_creation_outbox;DROP FUNCTION fail_audio_outbox()',
  );
  await audio.publish(row, inspection);
  const before = (await pool.query('SELECT * FROM mio_audio_creation_outbox')).rows[0]!;
  expect(before.payload).toMatchObject({
    jobId: row.id,
    eventKind: 'completed',
    ownerId: 'audio-owner',
  });
  expect((await pool.query('SELECT * FROM mio_audio_records')).rowCount).toBe(1);
  await enqueueAudioCreationLog(pool.query.bind(pool), row.id, 'completed');
  const after = (await pool.query('SELECT * FROM mio_audio_creation_outbox')).rows[0];
  expect(after).toEqual(before);
  await pool.query(providerSchemaSQL);
  expect((await pool.query('SELECT * FROM mio_audio_creation_outbox')).rows[0]).toEqual(before);
});

it('delivers through independent pools once, recovers ambiguous consumer success using the same event/time and never replays delivered rows', async () => {
  const row = await job();
  await audio.publish(row, inspection);
  const delivered = vi.fn(async (id: string, event: CreationLogInput) => {
    await consumer.receiveAudio(id, event);
    throw new Error('ack lost');
  });
  await audio.creationOutbox.deliver(delivered);
  expect((await media.query('SELECT * FROM mio_creation_logs')).rowCount).toBe(1);
  const original = (await pool.query('SELECT event_id,payload FROM mio_audio_creation_outbox'))
    .rows[0]!;
  await pool.query('UPDATE mio_audio_creation_outbox SET next_attempt_at=now()');
  const recovered = vi.fn(consumer.receiveAudio);
  await createAudioCreationOutbox(pool.query.bind(pool)).deliver(recovered);
  expect(recovered).toHaveBeenCalledWith(original.event_id, original.payload);
  await audio.creationOutbox.deliver(recovered);
  expect(recovered).toHaveBeenCalledOnce();
  expect((await media.query('SELECT * FROM mio_creation_logs')).rowCount).toBe(1);
  expect((await media.query('SELECT * FROM mio_audio_creation_receipts')).rowCount).toBe(1);
});

it('deadletters at exactly seven days before any callback and bounds a delivery round to twenty unlocked rows', async () => {
  for (let i = 0; i < 23; i++) {
    const row = await job();
    await audio.publish(row, inspection);
  }
  await pool.query(
    "UPDATE mio_audio_creation_outbox SET occurred_at=now()-interval '7 days',next_attempt_at=now()+interval '1 day'",
  );
  const receive = vi.fn(async () => {});
  await audio.creationOutbox.deliver(receive);
  expect(receive).not.toHaveBeenCalled();
  expect(
    (await pool.query('SELECT * FROM mio_audio_creation_outbox WHERE dead_lettered_at IS NOT NULL'))
      .rowCount,
  ).toBe(20);
  await audio.creationOutbox.deliver(receive);
  expect(
    (await pool.query('SELECT * FROM mio_audio_creation_outbox WHERE dead_lettered_at IS NOT NULL'))
      .rowCount,
  ).toBe(23);
});

it('uses leases across concurrent workers and drains its current callback before shutdown', async () => {
  for (let i = 0; i < 21; i++) {
    const row = await job();
    await audio.publish(row, inspection);
  }
  const receive = vi.fn(consumer.receiveAudio);
  await Promise.all([
    audio.creationOutbox.deliver(receive),
    createAudioCreationOutbox(pool.query.bind(pool)).deliver(receive),
  ]);
  expect(receive).toHaveBeenCalledTimes(21);
  expect(new Set(receive.mock.calls.map((x) => x[0])).size).toBe(21);
  const row = await job();
  await audio.publish(row, inspection);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const delivery = startAudioCreationDelivery(audio.creationOutbox, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const closed = vi.fn();
  const closing = delivery.close().then(closed);
  await Promise.resolve();
  expect(closed).not.toHaveBeenCalled();
  release.resolve();
  await closing;
  expect(closed).toHaveBeenCalledOnce();
});

it('checks outbox identity and pending index read-only and preserves existing events during migration', async () => {
  const row = await job();
  await audio.publish(row, inspection);
  const before = (await pool.query('SELECT * FROM mio_audio_creation_outbox')).rows;
  await pool.query('DROP INDEX mio_audio_creation_outbox_pending');
  await expect(checkAudioSchema(pool)).rejects.toThrow('outbox index');
  expect(
    (await pool.query("SELECT to_regclass('mio_audio_creation_outbox_pending') AS relation"))
      .rows[0].relation,
  ).toBeNull();
  await pool.query(providerSchemaSQL);
  await checkAudioSchema(pool);
  expect((await pool.query('SELECT * FROM mio_audio_creation_outbox')).rows).toEqual(before);
  await pool.query(
    'ALTER TABLE mio_audio_creation_outbox DROP CONSTRAINT mio_audio_creation_outbox_job_id_event_kind_key',
  );
  await expect(checkAudioSchema(pool)).rejects.toThrow('event identity');
  await pool.query(
    'ALTER TABLE mio_audio_creation_outbox ADD CONSTRAINT mio_audio_creation_outbox_job_id_event_kind_key UNIQUE(job_id,event_kind)',
  );
});
