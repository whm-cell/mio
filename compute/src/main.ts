import { isJournalFailure, Journal } from './adapters/journal.ts';
import { ObjectStore } from './adapters/cos.ts';
import { processIdentity } from './adapters/media.ts';
import { Broker } from './adapters/rabbitmq.ts';
import { Worker } from './worker.ts';
import { Maintenance } from './maintenance.ts';

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
  const store = new ObjectStore({
    bucket: required('MIO_COS_BUCKET'),
    region: required('MIO_COS_REGION'),
    secretId: required('MIO_COS_SECRET_ID'),
    secretKey: required('MIO_COS_SECRET_KEY'),
  });
  const journal = new Journal(directory, instance);
  let stopping = false;
  let worker: Worker | null = null;
  let notifyStop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    notifyStop = resolve;
  });
  const stop = () => {
    stopping = true;
    worker?.stop();
    notifyStop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopping) {
      let broker: Broker | undefined;
      let interval: ReturnType<typeof setInterval> | undefined;
      let maintenance: Maintenance | undefined;
      try {
        broker = await Broker.connect(url, username, expectedUser);
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
          stopping = true;
          console.error('compute worker journal failed; consumption stopped');
        } else if (!stopping) console.error('compute worker connection error');
      } finally {
        maintenance?.stop();
        if (interval) clearInterval(interval);
        worker?.stop();
        if (broker) await broker.close();
        if (maintenance) await maintenance.wait().catch(() => {});
        if (worker) await worker.waitIdle();
        worker = null;
      }
      if (!stopping) await new Promise<void>((resolve) => setTimeout(resolve, 5000));
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    journal.close();
  }
}

void start().catch(() => {
  console.error('compute worker startup failed');
  process.exitCode = 1;
});
