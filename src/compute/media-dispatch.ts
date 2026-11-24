import { epochMs } from '@mio/foundation/time';
import { createLogger } from '@mio/foundation/logging';
import type { MediaResult } from '@mio/compute-contracts';
import { ComputeBroker, MediaPublishRejected } from '../integrations/rabbitmq.ts';
import type { ComputeConfig } from './config.ts';
import type { MediaStore } from './media-store.ts';
import type { MediaCommandLane } from './media-model.ts';

const log = createLogger('app', 'media-dispatch');

/** Publish confirms precede sent; reconnects and failed publishes retain the stable outbox ID. */
export function mediaDispatch(
  store: MediaStore,
  config: ComputeConfig,
  receive: (result: MediaResult) => Promise<void>,
) {
  let stopping = false;
  const stop = new AbortController();
  let broker: ComputeBroker | undefined;
  let polling: Promise<void> | undefined;
  let requested = false;
  let retryAt = 0,
    delay = 1000;
  const lanes = (['control', 'probe', 'encode'] as const satisfies MediaCommandLane[]).map(
    (name) => ({
      name,
      retryAt: 0,
      delay: 1000,
    }),
  );
  const disconnects = new Set<Promise<void>>();
  const failed = (instance: ComputeBroker) => {
    if (broker !== instance) return;
    broker = undefined;
    retryAt = epochMs() + delay;
    delay = Math.min(delay * 2, 30_000);
    const closing = instance.close().catch(() => {});
    disconnects.add(closing);
    void closing.finally(() => disconnects.delete(closing));
  };
  const wake = () => {
    if (stopping || epochMs() < retryAt) return;
    if (polling) {
      requested = true;
      return;
    }
    polling = (async () => {
      if (!broker) {
        const acquired = await ComputeBroker.connect(
          config.brokerURL,
          config.brokerUser,
          config.expectedResultUser,
          stop.signal,
        );
        if (stopping) {
          await acquired.close();
          return;
        }
        broker = acquired;
        acquired.onClose(() => failed(acquired));
        await acquired.consumeMedia(receive, () => failed(acquired));
      }
      const instance = broker;
      if (!instance) return;
      // An explicit NACK can be caused by overflow on one queue while the
      // other queues remain writable. The confirm channel remains usable.
      for (const lane of lanes) {
        if (epochMs() < lane.retryAt) continue;
        for (let n = 0; n < 10 && !stopping && broker === instance; n++) {
          const item = await store.claim(lane.name);
          if (!item) break;
          try {
            await instance.publishMedia(item.command);
            await store.sent(item.command, item.lease);
            lane.retryAt = 0;
            lane.delay = 1000;
          } catch (error) {
            await store.release(item.command.messageId, item.lease);
            if (!(error instanceof MediaPublishRejected)) throw error;
            log.warn('MEDIA_COMMAND_ROUTE_REJECTED', { messageId: item.command.messageId });
            lane.retryAt = epochMs() + lane.delay;
            lane.delay = Math.min(lane.delay * 2, 30_000);
            break;
          }
        }
      }
      if (broker === instance) {
        retryAt = 0;
        delay = 1000;
      }
    })()
      .catch(() => {
        if (stopping) return;
        log.error('MEDIA_DISPATCH_FAILED');
        if (broker) failed(broker);
        else {
          retryAt = epochMs() + delay;
          delay = Math.min(delay * 2, 30_000);
        }
      })
      .finally(() => {
        polling = undefined;
        if (requested && !stopping) {
          requested = false;
          wake();
        }
      });
  };
  const timer = setInterval(wake, 1000);
  timer.unref();
  wake();
  return {
    wake,
    async close() {
      stopping = true;
      clearInterval(timer);
      stop.abort();
      await polling;
      if (broker) await broker.close();
      await Promise.allSettled([...disconnects]);
    },
  };
}
