import { createLogger } from '@mio/foundation/logging';
import { setTimeout as delay } from 'node:timers/promises';
import { isJournalFailure, Journal } from './adapters/journal.ts';
import { ObjectStore } from './adapters/cos.ts';
import { processIdentity } from './adapters/media.ts';
import { Broker } from './adapters/rabbitmq.ts';
import { Worker } from './worker.ts';
import { Maintenance } from './maintenance.ts';

const log = createLogger('worker', 'main');

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`CONFIG_REQUIRED:${name}`);
  return value;
}

async function start(): Promise<void> {
  const directory = required('MIO_COMPUTE_DIRECTORY');
  const instance = required('MIO_COMPUTE_INSTANCE_ID');
  if (process.argv[2] === 'init') {
    const journal = new Journal(directory, instance, true);
    journal.close();
    return;
  }
  if (process.argv[2] === 'resolve-no-pid') {
    if (
      process.argv[4] !== '--confirmed-process-terminated' ||
      !process.argv[3] ||
      !process.argv[5]
    )
      throw new Error('RESOLUTION_ARGUMENTS_REQUIRED');
    const journal = new Journal(directory, instance);
    try {
      journal.resolveNoPid(process.argv[3], process.argv[5]);
    } finally {
      journal.close();
    }
    return;
  }
  if (process.argv[2] !== 'start') throw new Error('EXPECTED_INIT_OR_START');
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
  const stopping = new AbortController();
  let worker: Worker | null = null;
  const stopped = new Promise<void>((resolve) => {
    stopping.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  const stop = () => {
    worker?.stop();
    stopping.abort(new Error('WORKER_STOPPED'));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopping.signal.aborted) {
      let broker: Broker | undefined;
      let interval: ReturnType<typeof setInterval> | undefined;
      let maintenance: Maintenance | undefined;
      try {
        broker = await Broker.connect(url, username, expectedUser, stopping.signal);
        stopping.signal.throwIfAborted();
        worker = new Worker(journal, store, broker, directory);
        const current = worker;
        let fail: (error: unknown) => void = () => {};
        const failed = new Promise<never>((_resolve, reject) => {
          fail = reject;
        });
        void failed.catch(() => {});
        const closed = broker.closed();
        maintenance = new Maintenance(broker, current, fail);
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
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    journal.close();
  }
}

void start().catch(() => {
  log.error('WORKER_STARTUP_FAILED');
  process.exitCode = 1;
});
