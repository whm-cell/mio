import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@mio/foundation/logging';
import { Broker } from './adapters/rabbitmq.ts';
import type { Journal } from './adapters/journal.ts';
import { isJournalFailure } from './adapters/journal.ts';
import type { MediaExecutor } from './media-execution.ts';
import { MediaWorker, reserveMediaProcesses } from './media-worker.ts';
import type { MediaStore } from './media-worker.ts';
import type { ResourceSlots } from './resource-slots.ts';

export interface MediaRuntimeConfig {
  url: string;
  userId: string;
  expectedUserId: string;
  directory: string;
}
const log = createLogger('worker', 'media');

/** Resolve after stop and admitted work drains. Journal failures stop Worker B. */
export async function runMediaRuntime(
  config: MediaRuntimeConfig,
  store: MediaStore,
  journal: Pick<Journal, 'media'>,
  executor: MediaExecutor,
  stop: AbortSignal,
  slots: ResourceSlots,
): Promise<void> {
  reserveMediaProcesses(journal.media, slots);
  while (!stop.aborted) {
    try {
      await runConnection(config, store, journal, executor, stop, slots);
    } catch (error) {
      if (isJournalFailure(error)) throw error;
      if (!stop.aborted) log.error('MEDIA_BROKER_CONNECTION_ERROR');
    }
    if (!stop.aborted) await delay(5000, undefined, { signal: stop }).catch(() => {});
  }
}

async function runConnection(
  config: MediaRuntimeConfig,
  store: MediaStore,
  journal: Pick<Journal, 'media'>,
  executor: MediaExecutor,
  stop: AbortSignal,
  slots: ResourceSlots,
): Promise<void> {
  const disconnected = new AbortController();
  const round = AbortSignal.any([stop, disconnected.signal]);
  const stopped = Promise.withResolvers<void>();
  const onStop = () => stopped.resolve();
  round.addEventListener('abort', onStop, { once: true });
  if (round.aborted) onStop();
  let broker: Broker | undefined;
  let worker: MediaWorker | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cleanup: Promise<void> | undefined;
  let failure: unknown;
  const fail = (error: unknown) => {
    if (!failure || isJournalFailure(error)) failure = error;
    disconnected.abort(error);
  };
  try {
    const connected = (broker = await Broker.connect(
      config.url,
      config.userId,
      config.expectedUserId,
      round,
    ));
    void connected.closed().then(() => disconnected.abort());
    const current = (worker = new MediaWorker(
      store,
      connected,
      journal,
      config.directory,
      executor,
      round,
      slots,
      fail,
    ));
    // Cancellation stays admissible even while encoding/probing waits on a HOLD.
    await Promise.race([
      connected.consumeMediaControl((control, ack) => current.control(control, ack), fail),
      stopped.promise,
    ]);
    round.throwIfAborted();
    await current.recover();
    round.throwIfAborted();
    for (const resource of ['encode', 'probe'] as const) {
      await Promise.race([
        connected.consumeMedia(resource, (command, ack) => current.handle(command, ack), fail),
        stopped.promise,
      ]);
      round.throwIfAborted();
    }
    timer = setInterval(() => {
      if (cleanup) return;
      cleanup = current
        .cleanupExpired()
        .catch(fail)
        .finally(() => {
          cleanup = undefined;
        });
    }, 60_000);
    timer.unref();
    await stopped.promise;
  } finally {
    round.removeEventListener('abort', onStop);
    disconnected.abort();
    if (timer) clearInterval(timer);
    await cleanup;
    try {
      await worker?.close();
    } finally {
      await broker?.close();
    }
    if (failure) throw failure;
  }
}
