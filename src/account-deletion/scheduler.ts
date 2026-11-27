import { createId } from '@mio/foundation/identifiers';
import { monotonicMs } from '@mio/foundation/time';
import { createLogger } from '@mio/foundation/logging';
import type { AccountDeletionStore, CleanupJob } from './store.ts';

export interface CleanupStep {
  name: string;
  run(job: CleanupJob, signal: AbortSignal): Promise<{ done: boolean; remaining: number }>;
}
const log = createLogger('app', 'account-deletion');
export class CleanupFailure extends Error {
  readonly step: string;
  readonly code: string;
  constructor(step: string, code: string) {
    super(code);
    this.step = step;
    this.code = code;
  }
}

/** One bounded slice per account per round. Incomplete large accounts yield to the oldest unserved one. */
export function startAccountDeletion(store: AccountDeletionStore, steps: readonly CleanupStep[]) {
  let stopping = false;
  let active: Promise<void> | undefined;
  let monitorActive: Promise<void> | undefined;
  const stop = new AbortController();
  const executorId = createId();
  const names = steps.map((step) => step.name);
  if (!names.length || new Set(names).size !== names.length)
    throw new Error('CLEANUP_STEPS_INVALID');
  const round = () => {
    if (stopping || active) return active ?? Promise.resolve();
    active = (async () => {
      const until = monotonicMs() + 5000;
      for (let count = 0; count < 10 && !stopping && monotonicMs() < until; count++) {
        const job = await store.claim();
        if (!job) break;
        const step = steps.find((item) => !job.progress[item.name]);
        if (!step) {
          await store.complete(job, names);
          continue;
        }
        try {
          const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]);
          const aborted = Promise.withResolvers<never>();
          const abort = () => aborted.reject(new Error('CLEANUP_TIMEOUT'));
          signal.addEventListener('abort', abort, { once: true });
          try {
            const result = await Promise.race([step.run(job, signal), aborted.promise]);
            signal.throwIfAborted();
            await store.receipt(job, step.name, result.done, result.remaining);
          } finally {
            signal.removeEventListener('abort', abort);
          }
          await store.release(job);
        } catch (error) {
          await store.release(
            job,
            error instanceof CleanupFailure
              ? { step: error.step, code: error.code }
              : { step: step.name, code: 'ACCOUNT_CLEANUP_FAILED' },
          );
          log.warn('ACCOUNT_CLEANUP_RETRY');
        }
      }
    })()
      .catch(() => {
        log.error('ACCOUNT_CLEANUP_EXECUTOR_UNAVAILABLE');
      })
      .finally(() => {
        active = undefined;
      });
    return active;
  };
  const monitor = () => {
    if (stopping || monitorActive) return monitorActive ?? Promise.resolve();
    monitorActive = store
      .monitor()
      .catch(() => {
        log.error('ACCOUNT_CLEANUP_MONITOR_UNAVAILABLE');
      })
      .finally(() => {
        monitorActive = undefined;
      });
    return monitorActive;
  };
  const interval = setInterval(() => {
    void round();
  }, 1000);
  const monitoring = setInterval(() => {
    void monitor();
  }, 60_000);
  const heartbeat = setInterval(() => {
    void store.heartbeat(executorId).catch(() => {});
  }, 10_000);
  interval.unref();
  monitoring.unref();
  heartbeat.unref();
  void store.heartbeat(executorId).catch(() => {});
  void round();
  void monitor();
  return {
    wake: () => {
      void round();
    },
    round,
    monitor,
    async close() {
      stopping = true;
      clearInterval(interval);
      clearInterval(monitoring);
      clearInterval(heartbeat);
      stop.abort();
      await Promise.allSettled([active, monitorActive]);
      await store.close();
    },
  };
}
