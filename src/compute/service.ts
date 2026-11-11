import { COMPUTE_MAX_MEDIA_BYTES } from '@mio/compute-contracts';
import type { ComputeResultV1 } from '@mio/compute-contracts';
import type { AssetObjectStore, AssetPrincipal } from '../assets/contracts.ts';
import { ComputeBroker } from '../integrations/rabbitmq.ts';
import type { ComputeConfig } from './config.ts';
import { ComputeError } from './store.ts';
import type { ComputeStore, JobRow } from './store.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
  let retryAt = 0;
  let retryDelay = 1000;
  const active = new Set<Promise<unknown>>();
  const stop = new AbortController();
  const admit = <T>(run: () => Promise<T>): Promise<T> => {
    if (stopping) throw new ComputeError(503, 'COMPUTE_UNAVAILABLE');
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
      } catch (error) {
        if (error instanceof ComputeError && error.code === 'RESULT_CONFLICT')
          throw Object.assign(error, { permanent: true });
        throw error;
      }
    });
  const disconnect = (instance: ComputeBroker) => {
    if (broker === instance) broker = undefined;
    void instance.close().catch(() => {});
  };
  const poll = () => {
    if (stopping || polling || Date.now() < retryAt) return;
    polling = admit(async () => {
      if (!broker) {
        const acquired = await ComputeBroker.connect(
          config.brokerURL,
          config.brokerUser,
          config.expectedResultUser,
        );
        if (stopping) {
          await acquired.close();
          return;
        }
        broker = acquired;
        retryDelay = 1000;
        acquired.onClose(() => disconnect(acquired));
        try {
          await acquired.consume(receive, () => disconnect(acquired));
        } catch (error) {
          disconnect(acquired);
          throw error;
        }
      }
      const instance = broker;
      if (!instance || stopping) return;
      const item = await store.claim();
      if (!item) return;
      try {
        await instance.publish(item.command);
        await store.sent(item.command, item.lease);
      } catch (error) {
        await store.release(item.command.messageId, item.lease);
        disconnect(instance);
        throw error;
      }
    })
      .catch(() => {
        if (!stopping) {
          console.error('COMPUTE_BROKER_RETRY');
          retryAt = Date.now() + retryDelay;
          retryDelay = Math.min(retryDelay * 2, 30_000);
        }
      })
      .finally(() => {
        polling = undefined;
      });
  };
  const timer = setInterval(poll, 1000);
  timer.unref();
  poll();
  return {
    create(actor: AssetPrincipal, requestId: string, assetId: string) {
      return admit(async () => {
        if (!uuid.test(requestId) || !uuid.test(assetId))
          throw new ComputeError(400, 'COMPUTE_INPUT_INVALID');
        const previous = await store.request(actor.userId, requestId);
        if (previous) {
          if (previous.input_asset_id !== assetId) throw new ComputeError(409, 'REQUEST_CONFLICT');
          return { created: false, job: view(previous) };
        }
        const input = await store.input(actor.userId, assetId);
        if (
          !input ||
          !input.raw_key.startsWith(`mio/raw/${assetId}/`) ||
          !uuid.test(input.raw_key.slice(`mio/raw/${assetId}/`.length))
        )
          throw new ComputeError(404, 'ASSET_NOT_FOUND');
        let object: Awaited<ReturnType<AssetObjectStore['head']>>;
        try {
          object = await head(input.raw_key);
        } catch {
          throw new ComputeError(503, 'COMPUTE_STORAGE_UNAVAILABLE');
        }
        const size = Number(input.size_bytes);
        if (object.size !== size || size < 1 || size > COMPUTE_MAX_MEDIA_BYTES)
          throw new ComputeError(409, 'ASSET_SIZE_MISMATCH');
        if (!object.etag || object.etag.length > 256 || /[\x00-\x1f\x7f]/.test(object.etag))
          throw new ComputeError(503, 'COMPUTE_STORAGE_UNAVAILABLE');
        const created = await store.create(
          actor.userId,
          requestId,
          assetId,
          input.raw_key,
          size,
          object.etag,
        );
        return { created: created.created, job: view(created.job) };
      });
    },
    get(actor: AssetPrincipal, id: string) {
      return admit(async () => {
        if (!uuid.test(id)) throw new ComputeError(404, 'NOT_FOUND');
        const job = await store.owned(id, actor.userId);
        if (!job) throw new ComputeError(404, 'JOB_NOT_FOUND');
        return view(job);
      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      stopping = true;
      clearInterval(timer);
      closing = (async () => {
        const deadline = setTimeout(() => stop.abort(), 5000);
        try {
          if (broker) await broker.close();
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
