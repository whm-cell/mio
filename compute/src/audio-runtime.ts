import { createLogger } from '@mio/foundation/logging';
import { setTimeout as delay } from 'node:timers/promises';
import type { ObjectStore } from './adapters/cos.ts';
import { prepareAudioDirectory } from './adapters/media.ts';
import { Broker } from './adapters/rabbitmq.ts';
import { AudioWorker } from './audio-worker.ts';
import type { ResourceSlots } from './resource-slots.ts';

const log = createLogger('worker', 'audio');

export async function runAudioRuntime(
  config: { url: string; username: string; expectedUser: string; directory: string },
  store: ObjectStore,
  stop: AbortSignal,
  slots: ResourceSlots,
): Promise<void> {
  const scratch = prepareAudioDirectory(config.directory);
  while (!stop.aborted) {
    let broker: Broker | undefined;
    const disconnected = new AbortController();
    const round = AbortSignal.any([stop, disconnected.signal]);
    const { promise: stopped, resolve: resolveStopped } = Promise.withResolvers<void>();
    const onStop = () => resolveStopped();
    round.addEventListener('abort', onStop, { once: true });
    try {
      broker = await Broker.connect(config.url, config.username, config.expectedUser, round);
      const closed = broker.closed().then(() => disconnected.abort());
      const worker = new AudioWorker(store, broker, config.directory, scratch, round, slots);
      await Promise.race([
        broker.consumeAudio(
          (command, ack) => worker.handle(command, ack),
          (error) => disconnected.abort(error),
          () => !round.aborted,
        ),
        stopped,
      ]);
      await Promise.race([closed, stopped]);
    } catch {
      if (!stop.aborted) log.error('AUDIO_BROKER_CONNECTION_ERROR');
    } finally {
      round.removeEventListener('abort', onStop);
      disconnected.abort();
      await broker?.close();
    }
    if (!stop.aborted) await delay(5000, undefined, { signal: stop }).catch(() => {});
  }
}
