import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { epochMs } from '@mio/foundation/time';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { COMPUTE_MAX_MEDIA_BYTES } from '@mio/compute-contracts';
import type { ComputeResultV1 } from '@mio/compute-contracts';
import type { AssetObjectStore, AssetPrincipal } from '../assets/contracts.ts';
import { ComputeBroker } from '../integrations/rabbitmq.ts';
import type { ComputeConfig } from './config.ts';
import { ComputeError } from './errors.ts';
import type { ComputeStore, JobRow } from './store.ts';
const log = createLogger('app', 'compute');
const VIDEO_OUTBOX_BATCH = 10;
const BROKER_RETRY_INITIAL_MS = 1000;
const BROKER_RETRY_MAX_MS = 30_000;

function view(job: JobRow) {
  return {
    jobId: job.id,
    requestId: job.request_id,
    inputAssetId: job.input_asset_id,
    status: job.state,
    attempt: job.attempt,
    resultAssetId: job.result_asset_id,
    errorCode: job.error_code,
    createdAt: job.created_at.toISOString(),
    updatedAt: job.updated_at.toISOString(),
  };
}

/** Admissions and result commits drain before the pool closes; a late COS HEAD cannot commit. */
export function createComputeService(
  store: ComputeStore,
  objects: AssetObjectStore,
  config: ComputeConfig,
) {
  let stopping = false;
  let closing: Promise<void> | undefined;
  let broker: ComputeBroker | undefined;
  let polling: Promise<void> | undefined;
  let pollRequested = false;
  let retryAt = 0;
  let retryDelay = BROKER_RETRY_INITIAL_MS;
  const active = new Set<Promise<unknown>>();
  const disconnecting = new Set<Promise<void>>();
  const stop = new AbortController();
  const admit = <T>(run: () => Promise<T>): Promise<T> => {
    if (stopping) throw new ComputeError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_UNAVAILABLE');
    const action = run();
    active.add(action);
    void action.then(
      () => active.delete(action),
      () => active.delete(action),
    );
    return action;
  };
  const head = (key: string) =>
    new Promise<Awaited<ReturnType<AssetObjectStore['head']>>>((resolve, reject) => {
      if (stop.signal.aborted) {
        reject(new Error('COMPUTE_STOPPED'));
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        stop.signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        finish();
        reject(new Error('COMPUTE_STOPPED'));
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error('COMPUTE_OBJECT_TIMEOUT'));
      }, 180_000);
      stop.signal.addEventListener('abort', abort, { once: true });
      void objects.head(key).then(
        (value) => {
          finish();
          resolve(value);
        },
        (error: unknown) => {
          finish();
          reject(error);
        },
      );
    });
  const receive = (result: ComputeResultV1) =>
    admit(async () => {
      const resultLog = log.child({
        jobId: result.jobId,
        attemptId: result.attemptId,
        messageId: result.messageId,
      });
      if (result.state === 'succeeded' && (await store.current(result))) {
        const object = await head(result.output.key);
        if (
          object.size !== result.output.sizeBytes ||
          object.etag !== result.output.etag ||
          object.sha256 !== result.output.sha256
        )
          throw Object.assign(new Error('RESULT_OBJECT_MISMATCH'), { permanent: true });
      }
      try {
        await store.accept(result);
        resultLog.info('RESULT_COMMITTED');
      } catch (error) {
        if (error instanceof ComputeError && error.code === 'RESULT_CONFLICT') {
          resultLog.warn('RESULT_CONFLICT');
          throw Object.assign(error, { permanent: true });
        }
        throw error;
      }
    });
  const scheduleRetry = () => {
    pollRequested = false;
    if (stopping) return;
    log.error('COMPUTE_BROKER_RETRY');
    retryAt = epochMs() + retryDelay;
    retryDelay = Math.min(retryDelay * 2, BROKER_RETRY_MAX_MS);
  };
  const disconnect = (instance: ComputeBroker) => {
    if (broker !== instance) return;
    broker = undefined;
    scheduleRetry();
    const task = instance.close().catch(() => {});
    disconnecting.add(task);
    void task.finally(() => disconnecting.delete(task));
  };
  const poll = () => {
    if (stopping) {
      pollRequested = false;
      return;
    }
    if (polling) {
      pollRequested = true;
      return;
    }
    if (epochMs() < retryAt) {
      pollRequested = false;
      return;
    }
    let instance = broker;
    polling = admit(async () => {
      if (!instance) {
        const acquired = await ComputeBroker.connect(
          config.brokerURL,
          config.brokerUser,
          config.expectedResultUser,
          stop.signal,
          config.workerUsers,
        );
        if (stopping) {
          await acquired.close();
          return;
        }
        broker = acquired;
        instance = acquired;
        acquired.onClose(() => disconnect(acquired));
        if (broker !== acquired) return;
        try {
          await acquired.consume(receive, () => disconnect(acquired));
        } catch (error) {
          disconnect(acquired);
          throw error;
        }
      }
      for (let count = 0; count < VIDEO_OUTBOX_BATCH && !stopping && broker === instance; count++) {
        const item = await store.claim();
        if (!item) break;
        try {
          if (broker !== instance) throw new Error('COMPUTE_BROKER_CLOSED');
          await instance.publish(item.command);
          await store.sent(item.command, item.lease);
        } catch (error) {
          try {
            await store.release(item.command.messageId, item.lease);
          } finally {
            disconnect(instance);
          }
          throw error;
        }
      }
      if (!stopping && broker === instance) {
        retryAt = 0;
        retryDelay = BROKER_RETRY_INITIAL_MS;
      }
    })
      .catch(() => {
        if (broker === instance) scheduleRetry();
      })
      .finally(() => {
        polling = undefined;
        if (pollRequested && !stopping && epochMs() >= retryAt) {
          pollRequested = false;
          poll();
        } else {
          pollRequested = false;
        }
      });
  };
  const wakePoll = () => {
    if (stopping || epochMs() < retryAt) return;
    if (polling) {
      pollRequested = true;
      return;
    }
    poll();
  };
  const timer = setInterval(poll, 1000);
  timer.unref();
  poll();
  return {
    create(actor: AssetPrincipal, requestId: string, assetId: string) {
      return admit(async () => {
        if (!isUuidV4(requestId) || !isUuidV4(assetId))
          throw new ComputeError(HTTP_STATUS.BAD_REQUEST, 'COMPUTE_INPUT_INVALID');
        const previous = await store.request(actor.userId, requestId);
        if (previous) {
          if (previous.input_asset_id !== assetId)
            throw new ComputeError(HTTP_STATUS.CONFLICT, 'REQUEST_CONFLICT');
          return { created: false, job: view(previous) };
        }
        const input = await store.input(actor.userId, assetId);
        if (
          !input ||
          !input.raw_key.startsWith(`mio/raw/${assetId}/`) ||
          !isUuidV4(input.raw_key.slice(`mio/raw/${assetId}/`.length))
        )
          throw new ComputeError(HTTP_STATUS.NOT_FOUND, 'ASSET_NOT_FOUND');
        let object: Awaited<ReturnType<AssetObjectStore['head']>>;
        try {
          object = await head(input.raw_key);
        } catch {
          throw new ComputeError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_STORAGE_UNAVAILABLE');
        }
        const size = Number(input.size_bytes);
        if (object.size !== size || size < 1 || size > COMPUTE_MAX_MEDIA_BYTES)
          throw new ComputeError(HTTP_STATUS.CONFLICT, 'ASSET_SIZE_MISMATCH');
        if (!object.etag || object.etag.length > 256 || /[\x00-\x1f\x7f]/.test(object.etag))
          throw new ComputeError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_STORAGE_UNAVAILABLE');
        const created = await store.create(
          actor.userId,
          requestId,
          assetId,
          input.raw_key,
          size,
          object.etag,
        );
        if (created.created) wakePoll();
        return { created: created.created, job: view(created.job) };
      });
    },
    get(actor: AssetPrincipal, id: string) {
      return admit(async () => {
        if (!isUuidV4(id)) throw new ComputeError(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
        const job = await store.owned(id, actor.userId);
        if (!job) throw new ComputeError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
        return view(job);
      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      stopping = true;
      pollRequested = false;
      clearInterval(timer);
      closing = (async () => {
        const deadline = setTimeout(() => stop.abort(), 5000);
        try {
          if (broker) await broker.close();
          if (disconnecting.size > 0) await Promise.allSettled([...disconnecting]);
          await Promise.allSettled([...active]);
          await store.close();
        } finally {
          clearTimeout(deadline);
        }
      })();
      return closing;
    },
  };
}
