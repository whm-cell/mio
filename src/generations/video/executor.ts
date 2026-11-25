import { createLogger } from '@mio/foundation/logging';
import { epochMs } from '@mio/foundation/time';
import type { VideoGenerationStore } from './store.ts';
import type { VideoMaterializer } from './execution.ts';
import { createVideoRunner } from './runner.ts';
import type { VideoExecutorProvider, VideoTransports } from './runner.ts';
import { VideoSubmissionReceipts } from './submission-receipts.ts';

const log = createLogger('app', 'video-executor');
const NETWORK_CONCURRENCY = 4;

/** The parent generation service owns the shared pool; this executor owns only its lease. */
export async function createVideoExecutor(
  store: VideoGenerationStore,
  provider: () => VideoExecutorProvider | undefined,
  materialize: VideoMaterializer,
  transports: VideoTransports,
  dataDirectory: string,
) {
  const execution = store.executorStore();
  const receipts = new VideoSubmissionReceipts(dataDirectory);
  let stopping = false;
  let closing: Promise<void> | undefined;
  let pumping: Promise<void> | undefined;
  let cleaning: Promise<void> | undefined;
  let replaying: Promise<void> | undefined;
  let retryAt = 0;
  const stop = new AbortController();
  const active = new Set<Promise<void>>();
  const run = createVideoRunner(
    execution,
    provider,
    materialize,
    stop.signal,
    transports,
    receipts,
  );
  const pump = () => {
    if (stopping || pumping || epochMs() < retryAt) return;
    pumping = (async () => {
      while (!stopping && active.size < NETWORK_CONCURRENCY) {
        const row = await execution.claim();
        if (!row) break;
        if (stopping) {
          await execution.release(row);
          break;
        }
        const pending = run(row).catch(async () => {
          retryAt = epochMs() + 1000;
          log.error('VIDEO_EXECUTION_PENDING');
          await execution.release(row).catch(() => {});
        });
        active.add(pending);
        void pending.then(() => {
          active.delete(pending);
          pump();
        });
      }
    })()
      .catch(() => {
        retryAt = epochMs() + 1000;
        log.error('VIDEO_DATABASE_UNAVAILABLE');
      })
      .finally(() => {
        pumping = undefined;
      });
  };
  await execution.startExecutor(() => {
    stopping = true;
    stop.abort();
    log.error('VIDEO_EXECUTOR_LEASE_LOST');
  });
  const clean = () => {
    if (stopping || cleaning || !transports.cleanup) return;
    cleaning = (async () => {
      for (const row of await execution.completedCleanup()) {
        if (stopping) break;
        let cleaned = false;
        try {
          await transports.cleanup!(
            row,
            AbortSignal.any([stop.signal, AbortSignal.timeout(60_000)]),
          );
          cleaned = true;
        } catch {
          log.error('VIDEO_CLEANUP_PENDING');
        }
        await execution.cleanupResult(row.id, cleaned);
      }
    })()
      .catch(() => log.error('VIDEO_CLEANUP_PENDING'))
      .finally(() => {
        cleaning = undefined;
      });
  };
  const replay = () => {
    if (stopping || replaying || epochMs() < retryAt) return;
    replaying = receipts
      .replay((receipt, canReplay) => execution.receive(receipt, canReplay), stop.signal)
      .catch(() => log.error('VIDEO_SUBMISSION_RECONCILIATION_PENDING'))
      .finally(() => {
        replaying = undefined;
      });
  };
  const timer = setInterval(() => {
    pump();
    clean();
    replay();
  }, 1000);
  timer.unref();
  pump();
  clean();
  replay();
  return {
    wake() {
      setImmediate(pump);
    },
    close() {
      if (!closing) {
        stopping = true;
        clearInterval(timer);
        stop.abort();
        closing = (async () => {
          await pumping;
          await cleaning;
          await replaying;
          await Promise.allSettled([...active]);
          try {
            await receipts.close();
          } finally {
            await execution.close();
          }
        })();
      }
      return closing;
    },
  };
}
