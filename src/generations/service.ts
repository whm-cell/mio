import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { epochMs } from '@mio/foundation/time';
import { isUuidV4 } from '@mio/foundation/identifiers';
import type { ImageRequestParameters } from './contracts.ts';
import type { ProviderService } from '../providers/service.ts';
import type { AssetPrincipal } from '../assets/contracts.ts';
import type { GenerationObjects } from './execution.ts';
import type { GenerationConfig } from './config.ts';
import type { GenerationStore } from './store.ts';
import { GenerationFiles } from './files.ts';
import { GenerationError } from './errors.ts';
import { createGenerationAdmission } from './admission.ts';
import { createGenerationRunner } from './runner.ts';
import { cleanCompletedGeneration } from './materialize.ts';
import type { GenerationTransports } from './runner.ts';

const log = createLogger('app', 'generations');
const NETWORK_CONCURRENCY = 4;

/** The service owns its pool and drains admissions/executions before releasing it. */
export async function createGenerationService(
  store: GenerationStore,
  objects: GenerationObjects,
  config: GenerationConfig,
  provider: () => ProviderService | undefined,
  transports: GenerationTransports = {},
) {
  if (!objects.putImage) throw new Error('GENERATION_CONFIG: image object writes required');
  const files = new GenerationFiles(config.dataDirectory);
  await files.initialize();
  let stopping = false;
  let closing: Promise<void> | undefined;
  let pumping: Promise<void> | undefined;
  let retryAt = 0;
  const stop = new AbortController();
  const active = new Set<Promise<void>>();
  const admissions = new Set<Promise<unknown>>();
  const run = createGenerationRunner(store, files, objects, provider, stop.signal, transports);
  const head = (key: string) =>
    new Promise<Awaited<ReturnType<GenerationObjects['head']>>>((resolve, reject) => {
      if (stop.signal.aborted) return reject(new Error('GENERATION_STOPPED'));
      const finish = () => {
        clearTimeout(timer);
        stop.signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        finish();
        reject(new Error('GENERATION_STOPPED'));
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error('GENERATION_OBJECT_TIMEOUT'));
      }, 180_000);
      timer.unref();
      stop.signal.addEventListener('abort', abort, { once: true });
      void objects.head(key).then(
        (object) => {
          finish();
          resolve(object);
        },
        (error: unknown) => {
          finish();
          reject(error);
        },
      );
    });
  const create = createGenerationAdmission(store, files, head, provider);
  let cleanup: Promise<void> | undefined;
  let cleanupCursor: string | undefined;
  const clean = () => {
    if (stopping || cleanup) return;
    cleanup = (async () => {
      const rows = await store.completedCleanup(cleanupCursor);
      if (!rows.length) cleanupCursor = undefined;
      for (const row of rows) {
        if (stopping) break;
        cleanupCursor = row.id;
        try {
          await cleanCompletedGeneration(row, store, files, head, stop.signal);
        } catch {
          log.error('GENERATION_FILE_CLEANUP_PENDING');
        }
      }
    })()
      .catch(() => log.error('GENERATION_FILE_CLEANUP_PENDING'))
      .finally(() => {
        cleanup = undefined;
      });
  };
  const admit = <T>(action: () => Promise<T>): Promise<T> => {
    if (stopping) throw new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_UNAVAILABLE');
    const pending = action();
    admissions.add(pending);
    void pending.then(
      () => admissions.delete(pending),
      () => admissions.delete(pending),
    );
    return pending;
  };
  const pump = () => {
    if (stopping || pumping || epochMs() < retryAt) return;
    pumping = (async () => {
      while (!stopping && active.size < NETWORK_CONCURRENCY) {
        const row = await store.claim();
        if (!row) break;
        if (stopping) {
          await store.release(row);
          break;
        }
        const pending = run(row).catch(async () => {
          retryAt = epochMs() + 1000;
          log.error('GENERATION_EXECUTION_PENDING');
          await store.release(row).catch(() => {});
        });
        active.add(pending);
        void pending.finally(() => {
          active.delete(pending);
          pump();
        });
      }
    })()
      .catch(() => {
        retryAt = epochMs() + 1000;
        log.error('GENERATION_DATABASE_UNAVAILABLE');
      })
      .finally(() => {
        pumping = undefined;
      });
  };
  await store.startExecutor(() => {
    stopping = true;
    stop.abort();
    log.error('GENERATION_EXECUTOR_LEASE_LOST');
  });
  const timer = setInterval(() => {
    pump();
    clean();
  }, 1000);
  timer.unref();
  pump();
  clean();
  return {
    createImage(
      actor: { readonly userId: string; readonly sessionId?: string },
      requestId: string,
      modelRef: string,
      parameters: ImageRequestParameters,
      tool?: { signal: AbortSignal },
    ) {
      return admit(async () => {
        const job = await create(actor, requestId, modelRef, parameters, tool);
        setImmediate(pump);
        return job;
      });
    },
    getImage(actor: { readonly userId: string; readonly sessionId?: string }, id: string) {
      return admit(() => store.imageGet(actor.userId, id));
    },
    recoverImage(actor: AssetPrincipal, id: string) {
      return admit(async () => {
        if (!isUuidV4(id)) throw new GenerationError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
        await store.imageRecover(actor.userId, id);
        setImmediate(pump);
        return store.imageGet(actor.userId, id);
      });
    },
    close() {
      if (!closing) {
        stopping = true;
        clearInterval(timer);
        stop.abort();
        closing = (async () => {
          await pumping;
          await cleanup;
          await Promise.allSettled([...admissions, ...active]);
          await store.close();
        })();
      }
      return closing;
    },
  };
}
export type GenerationService = Awaited<ReturnType<typeof createGenerationService>>;
