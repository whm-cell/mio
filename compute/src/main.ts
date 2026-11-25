import {
  parseWorkerInstanceId,
  parseWorkerInstanceIds,
  WORKER_DEFAULT_LIMITS,
} from '@mio/compute-contracts';
import { createWorkerObservability, runWorkerObservability } from './observability-runtime.ts';
import { createLogger } from '@mio/foundation/logging';
import { setTimeout as delay } from 'node:timers/promises';
import { isJournalFailure, Journal } from './adapters/journal.ts';
import { ObjectStore } from './adapters/cos.ts';
import { processIdentity } from './adapters/media.ts';
import { Broker } from './adapters/rabbitmq.ts';
import { Worker } from './worker.ts';
import { Maintenance } from './maintenance.ts';
import { runAudioRuntime } from './audio-runtime.ts';
import { ResourceSlots } from './resource-slots.ts';
import { checkMediaCapabilities } from './adapters/media-process.ts';
import { executeMedia } from './media-executor.ts';
import { runMediaRuntime } from './media-runtime.ts';

const log = createLogger('worker', 'main');

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`CONFIG_REQUIRED:${name}`);
  return value;
}

function deploymentMaximum(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`CONFIG_INVALID:${name}`);
  return Number(value);
}

async function start(): Promise<void> {
  const directory = required('MIO_COMPUTE_DIRECTORY');
  const instance = required('MIO_COMPUTE_INSTANCE_ID');
  if (process.argv[2] === 'init') {
    const journal = new Journal(directory, instance, true);
    journal.close();
    return;
  }
  if (process.argv[2] === 'resolve-no-pid' || process.argv[2] === 'resolve-media-no-pid') {
    if (
      process.argv[4] !== '--confirmed-process-terminated' ||
      !process.argv[3] ||
      !process.argv[5]
    )
      throw new Error('RESOLUTION_ARGUMENTS_REQUIRED');
    const journal = new Journal(directory, instance);
    try {
      if (process.argv[2] === 'resolve-media-no-pid')
        journal.media.resolveNoPid(process.argv[3], process.argv[5]);
      else journal.resolveNoPid(process.argv[3], process.argv[5]);
    } finally {
      journal.close();
    }
    return;
  }
  if (process.argv[2] !== 'start') throw new Error('EXPECTED_INIT_OR_START');
  const instances = parseWorkerInstanceIds(process.env.MIO_COMPUTE_WORKER_INSTANCE_IDS);
  const monitored = instances.length > 0 && instances.includes(parseWorkerInstanceId(instance));
  if (instances.length && !monitored) throw new Error('WORKER_INSTANCE_NOT_PROVISIONED');
  const slots = new ResourceSlots({
    total: deploymentMaximum('MIO_COMPUTE_HARD_MAX_TOTAL', WORKER_DEFAULT_LIMITS.total),
    encode: deploymentMaximum('MIO_COMPUTE_HARD_MAX_ENCODE', WORKER_DEFAULT_LIMITS.encode),
    probe: deploymentMaximum('MIO_COMPUTE_HARD_MAX_PROBE', WORKER_DEFAULT_LIMITS.probe),
  });
  if (!processIdentity()) throw new Error('PROCESS_IDENTITY_UNAVAILABLE');
  const url = required('RABBITMQ_URL');
  const username = required('MIO_COMPUTE_BROKER_USER');
  if (decodeURIComponent(new URL(url).username) !== username)
    throw new Error('BROKER_USER_MISMATCH');
  const expectedUser = required('MIO_COMPUTE_EXPECTED_COMMAND_USER');
  if (username === expectedUser) throw new Error('BROKER_IDENTITIES_MUST_DIFFER');
  if (
    process.env.MIO_COS_SESSION_TOKEN !== undefined &&
    (!process.env.MIO_COS_SESSION_TOKEN || /\s/.test(process.env.MIO_COS_SESSION_TOKEN))
  )
    throw new Error('CONFIG_INVALID:MIO_COS_SESSION_TOKEN');
  const store = new ObjectStore({
    bucket: required('MIO_COS_BUCKET'),
    region: required('MIO_COS_REGION'),
    secretId: required('MIO_COS_SECRET_ID'),
    secretKey: required('MIO_COS_SECRET_KEY'),
    ...(process.env.MIO_COS_SESSION_TOKEN
      ? { sessionToken: process.env.MIO_COS_SESSION_TOKEN }
      : {}),
  });
  const journal = new Journal(directory, instance);
  slots.setHold('encode', 'transcode', journal.hasUnknownProcess());
  const stopping = new AbortController();
  let worker: Worker | null = null;
  const stop = () => {
    worker?.stop();
    stopping.abort(new Error('WORKER_STOPPED'));
  };
  let observability: ReturnType<typeof createWorkerObservability> | undefined;
  try {
    if (monitored)
      observability = createWorkerObservability(instance, journal.observability, slots);
  } catch (error) {
    journal.close();
    throw error;
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const telemetry = observability
    ? runWorkerObservability(
        instance,
        journal.observability,
        slots,
        observability,
        (signal) => Broker.connect(url, username, expectedUser, signal),
        stopping.signal,
      )
    : undefined;
  const mediaCapabilities = checkMediaCapabilities(
    AbortSignal.any([stopping.signal, AbortSignal.timeout(30_000)]),
  ).then(
    () => true,
    () => {
      if (!stopping.signal.aborted) log.error('CAPABILITY_UNAVAILABLE');
      return false;
    },
  );
  const media = runMediaRuntime(
    { url, userId: username, expectedUserId: expectedUser, directory },
    store,
    journal,
    async (command, context) => {
      if (!(await mediaCapabilities)) throw new Error('CAPABILITY_UNAVAILABLE');
      return executeMedia(command, context);
    },
    stopping.signal,
    slots,
  ).catch(() => {
    stop();
    log.error('MEDIA_JOURNAL_CONSUMPTION_STOPPED');
    process.exitCode = 1;
  });
  const audio = runAudioRuntime(
    { url, username, expectedUser, directory },
    store,
    stopping.signal,
    slots,
    monitored,
  ).catch(() => log.error('AUDIO_WORKER_STOPPED'));
  try {
    while (!stopping.signal.aborted) {
      const { promise: stopped, resolve: resolveStopped } = Promise.withResolvers<void>();
      const onStop = () => resolveStopped();
      stopping.signal.addEventListener('abort', onStop, { once: true });
      let broker: Broker | undefined;
      let interval: ReturnType<typeof setInterval> | undefined;
      let maintenance: Maintenance | undefined;
      try {
        broker = await Broker.connect(url, username, expectedUser, stopping.signal);
        stopping.signal.throwIfAborted();
        worker = new Worker(journal, store, broker, directory, slots);
        const current = worker;
        let fail: (error: unknown) => void = () => {};
        const failed = new Promise<never>((_resolve, reject) => {
          fail = reject;
        });
        void failed.catch(() => {});
        const closed = broker.closed();
        maintenance = new Maintenance(broker, current, fail, monitored);
        const initialized = await Promise.race([
          maintenance.tick().then(() => true),
          closed.then(() => false),
          stopped.then(() => false),
          failed,
        ]);
        if (!initialized) throw new Error('BROKER_CLOSED');
        const cycle = maintenance;
        interval = setInterval(() => {
          void cycle.tick().catch(fail);
        }, 30_000);
        await Promise.race([closed, failed, stopped]);
      } catch (error) {
        if (isJournalFailure(error)) {
          stop();
          log.error('JOURNAL_CONSUMPTION_STOPPED');
        } else if (!stopping.signal.aborted) log.error('BROKER_CONNECTION_ERROR');
      } finally {
        stopping.signal.removeEventListener('abort', onStop);
        maintenance?.stop();
        if (interval) clearInterval(interval);
        worker?.stop();
        if (worker) await worker.waitIdle();
        if (broker) await broker.close();
        if (maintenance) await maintenance.wait().catch(() => {});
        worker = null;
      }
      if (!stopping.signal.aborted)
        await delay(5000, undefined, { signal: stopping.signal }).catch(() => {});
    }
  } finally {
    stop();
    await Promise.all([audio, media, telemetry]);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    journal.close();
  }
}

void start().catch(() => {
  log.error('WORKER_STARTUP_FAILED');
  process.exitCode = 1;
});
