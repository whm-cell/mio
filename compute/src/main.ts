import { createLogger } from '@mio/foundation/logging';
import { isJournalFailure, Journal } from './adapters/journal.ts';
import { ObjectStore } from './adapters/cos.ts';
import { processIdentity } from './adapters/media.ts';
import { Broker } from './adapters/rabbitmq.ts';
import { Worker } from './worker.ts';
import { createImageWorker, recoverImageMaterialization } from './image-worker.ts';
import { createId } from '@mio/foundation/identifiers';
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
  const materialize = (
    jobId: string,
    index: number,
    base64: string,
    format: string,
    fileId: string,
    signal?: AbortSignal,
  ) => store.image(jobId, index, base64, format, fileId, signal);
  const readImage = (ref: { key: string; etag: string; sizeBytes: number }, signal: AbortSignal) =>
    store.readImage(ref.key, ref.etag, ref.sizeBytes, signal);
  const images = createImageWorker(
    journal,
    process.env.MIO_IMAGE_KEY_ID ?? '',
    process.env.MIO_IMAGE_PRIVATE_KEY ?? '',
    materialize,
    fetch,
    readImage,
  );
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
      const imageStop = new AbortController();
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
        const imageBroker = broker;
        const handleImage: NonNullable<Parameters<Broker['consume']>[3]> = async (command, ack) => {
          let outcome;
          if (command.type === 'image.recover') {
            try {
              outcome = (
                await recoverImageMaterialization(
                  journal,
                  command.jobId,
                  command.commandId,
                  command.sequence,
                  materialize,
                  imageStop.signal,
                )
              ).outcome;
            } catch (error) {
              if (!(error instanceof Error) || error.message !== 'IMAGE_RESOLUTION_INVALID')
                throw error;
              outcome = { state: 'materialization_failed' as const, outputs: [] };
            }
          } else outcome = await images(command, imageStop.signal);
          await imageBroker.publishImage({
            version: 1,
            type: 'image.result',
            messageId: createId(),
            commandId:
              command.type === 'image.recover' || command.type === 'image.query'
                ? command.commandId
                : command.messageId,
            jobId: command.jobId,
            state: outcome.state,
            outputs: 'outputs' in outcome ? outcome.outputs : [],
            ...('errorCode' in outcome ? { errorCode: outcome.errorCode } : {}),
            ...('upstreamTaskId' in outcome ? { upstreamTaskId: outcome.upstreamTaskId } : {}),
            ...('queryAttempt' in outcome ? { queryAttempt: outcome.queryAttempt } : {}),
            ...(command.type === 'image.recover' ? { recoveryId: command.messageId } : {}),
          });
          if (outcome.state === 'materializing') throw new Error('IMAGE_MATERIALIZATION_PENDING');
          ack();
        };
        maintenance = new Maintenance(broker, current, fail, handleImage);
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
          log.error('JOURNAL_CONSUMPTION_STOPPED');
        } else if (!stopping) log.error('BROKER_CONNECTION_ERROR');
      } finally {
        maintenance?.stop();
        if (interval) clearInterval(interval);
        worker?.stop();
        const deadline = setTimeout(() => imageStop.abort(), 5000);
        try {
          if (broker) await broker.close();
        } finally {
          clearTimeout(deadline);
        }
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
  log.error('WORKER_STARTUP_FAILED');
  process.exitCode = 1;
});
