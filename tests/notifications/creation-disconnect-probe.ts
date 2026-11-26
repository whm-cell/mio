import { Client } from 'pg';
import { createCreationLogStore } from '../../src/notifications/creation-store.ts';
import type { CreationLogInput } from '../../src/notifications/creation-contracts.ts';

const url = process.env.MIO_TEST_DATABASE_URL;
const eventId = process.env.MIO_CREATION_PROBE_EVENT_ID;
const rawEvent = process.env.MIO_CREATION_PROBE_EVENT;
if (!url || !eventId || !rawEvent || !process.send) throw new Error('Missing isolated probe input');
const event = JSON.parse(rawEvent) as CreationLogInput;
const store = await createCreationLogStore(url, () => null);
const resume = Promise.withResolvers<void>();
process.once('message', (message) => {
  if (message === 'resume') resume.resolve();
});
const originalQuery = Client.prototype.query;
let held = false;
Client.prototype.query = function (this: Client, ...args: unknown[]) {
  const result = Reflect.apply(originalQuery, this, args) as unknown;
  const sql = typeof args[0] === 'string' ? args[0] : '';
  if (
    !held &&
    sql.includes('INSERT INTO mio_audio_creation_receipts') &&
    result instanceof Promise
  ) {
    held = true;
    return result.then(async (value) => {
      // Pause only after the real receipt INSERT succeeds, with its transaction still borrowed.
      this.once('end', () => process.send?.({ phase: 'disconnected' }));
      process.send?.({
        phase: 'borrowed',
        pid: (this as Client & { processID: number }).processID,
      });
      await resume.promise;
      return value;
    });
  }
  return result;
} as typeof Client.prototype.query;
try {
  let rejected = false;
  try {
    await store.receiveAudio(eventId, event);
  } catch (error) {
    rejected = true;
    process.send({
      phase: 'rejected',
      message: error instanceof Error ? error.message : 'unknown',
    });
  }
  if (!rejected) throw new Error('Disconnected transaction unexpectedly committed');
  await store.receiveAudio(eventId, event);
  process.send({ phase: 'retried', items: (await store.list(event.ownerId, 1, 10)).items });
} finally {
  Client.prototype.query = originalQuery;
  await store.close();
  process.disconnect();
}
