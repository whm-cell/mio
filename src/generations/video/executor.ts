import { createOwnerWork } from '../../account-deletion/owner-work.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { epochMs } from '@mio/foundation/time';
import { GenerationError } from '../errors.ts';
import { VideoClaimUnsettled } from './execution-store.ts';
import type { VideoClaim, VideoExecutionStore } from './execution-store.ts';
import type { VideoExecution, VideoMaterializer } from './execution.ts';
import { VideoProtocolRouteInvalid } from './execution.ts';
import { createVideoRunner } from './runner.ts';
import type { VideoExecutorProvider, VideoTransports } from './runner.ts';
import type { VideoGenerationStore } from './store.ts';
import { VideoSubmissionReceipts } from './submission-receipts.ts';

const log = createLogger('app', 'video-executor');
const CONCURRENCY = 4;
const POLL_INTERVAL_MS = 1000;
const STOP_SETTLEMENT_ATTEMPTS = 3;

async function settleClaim(
  settle: () => Promise<unknown>,
  stop: AbortSignal,
  action: 'RELEASE' | 'TERMINAL',
) {
  let pending = false;
  let attemptsAfterStop = 0;
  // Keep the original claim in its slot until PostgreSQL acknowledges the write.
  for (;;) {
    // The runner may already have attempted a release before reaching this fallback.
    if (pending || action === 'RELEASE') await delay(POLL_INTERVAL_MS);
    if (stop.aborted) attemptsAfterStop++;
    try {
      await settle();
      return;
    } catch {
      if (!pending) log.error(`VIDEO_CLAIM_${action}_PENDING`);
      pending = true;
      if (attemptsAfterStop === STOP_SETTLEMENT_ATTEMPTS) {
        // A new lease holder reconciles any claim that survived these attempts.
        log.error(`VIDEO_CLAIM_${action}_UNAVAILABLE`);
        return;
      }
    }
  }
}

async function cleanCompleted(
  execution: VideoExecutionStore,
  cleanup: NonNullable<VideoTransports['cleanup']>,
  row: VideoExecution,
  stop: AbortSignal,
) {
  let cleaned = false;
  try {
    await cleanup(row, AbortSignal.any([stop, AbortSignal.timeout(60_000)]));
    cleaned = true;
  } catch (error) {
    if (
      stop.aborted &&
      (error === stop.reason || (error instanceof Error && error.cause === stop.reason))
    )
      return;
    log.error('VIDEO_CLEANUP_PENDING');
  }
  await execution.cleanupResult(row.id, cleaned);
}

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
  const stop = new AbortController();
  const signal = stop.signal;
  const cleanup = transports.cleanup;
  const ownerWork = createOwnerWork((owner) => execution.accountClosed(owner));
  const run = (row: Parameters<ReturnType<typeof createVideoRunner>>[0]) =>
    ownerWork.run(row.owner_id, (ownerSignal) =>
      createVideoRunner(
        execution,
        provider,
        materialize,
        AbortSignal.any([signal, ownerSignal]),
        transports,
        receipts,
      )(row),
    );
  const active = new Set<Promise<void>>();
  let timer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  let claiming = false;
  let wantsClaim = true;
  let retryAt = 0;
  let maintaining = false;
  let cleanupBatch: VideoExecution[] = [];
  let cleanupAt = 0;
  let replayAt = 0;

  const halt = () => {
    if (signal.aborted) return;
    clearInterval(timer);
    stop.abort(new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'VIDEO_UNAVAILABLE'));
  };

  const releaseClaim = (row: VideoClaim) =>
    settleClaim(() => execution.release(row), signal, 'RELEASE');

  const runClaim = async () => {
    let row: VideoExecution | undefined;
    let unsettled: VideoClaim | undefined;
    try {
      if (!signal.aborted) row = await execution.claim(signal);
    } catch (error) {
      if (error instanceof VideoClaimUnsettled) unsettled = error.claim;
      if (!signal.aborted) {
        retryAt = epochMs() + POLL_INTERVAL_MS;
        log.error('VIDEO_DATABASE_UNAVAILABLE');
      }
    } finally {
      claiming = false;
    }
    if (unsettled) return releaseClaim(unsettled);
    if (!row) return;
    wantsClaim = true;
    pump();
    try {
      await run(row);
    } catch (error) {
      if (error instanceof VideoProtocolRouteInvalid) {
        const beforeSubmit = row.phase === 'ready';
        return settleClaim(
          () =>
            execution.settleInvalidRoute(
              row,
              beforeSubmit ? 'rejected' : 'failed',
              beforeSubmit ? 'VIDEO_INPUT_OR_CREDENTIAL_UNAVAILABLE' : 'VIDEO_TASK_INVALID',
            ),
          signal,
          'TERMINAL',
        );
      }
      retryAt = epochMs() + POLL_INTERVAL_MS;
      log.error('VIDEO_EXECUTION_PENDING');
      await releaseClaim(row);
    }
  };

  const replay = async () => {
    try {
      if (!signal.aborted)
        await receipts.replay(
          (receipt, canReplay) => execution.receive(receipt, canReplay),
          signal,
        );
    } catch {
      log.error('VIDEO_SUBMISSION_RECONCILIATION_PENDING');
    } finally {
      replayAt = epochMs() + POLL_INTERVAL_MS;
      maintaining = false;
    }
  };

  const clean = async () => {
    try {
      if (signal.aborted || !cleanup) return;
      // Keep the existing bounded selection and yield between storage operations.
      if (!cleanupBatch.length) cleanupBatch = await execution.completedCleanup();
      const row = cleanupBatch.shift();
      if (row && !signal.aborted)
        await ownerWork.run(row.owner_id, (ownerSignal) =>
          cleanCompleted(execution, cleanup, row, AbortSignal.any([signal, ownerSignal])),
        );
    } catch {
      log.error('VIDEO_CLEANUP_PENDING');
    } finally {
      cleanupAt = epochMs() + POLL_INTERVAL_MS;
      maintaining = false;
    }
  };

  const start = (work: () => Promise<void>) => {
    // Enroll before the claim, scan or transport can yield.
    const pending = Promise.resolve().then(work);
    active.add(pending);
    void pending.finally(() => {
      active.delete(pending);
      pump();
    });
  };

  const pump = () => {
    if (signal.aborted || active.size >= CONCURRENCY) return;
    const now = epochMs();
    // One slot gives due maintenance the next opening. All slots can run jobs
    // whenever there is no due maintenance.
    if (
      !maintaining &&
      (replayAt <= now || (cleanup && (cleanupBatch.length || cleanupAt <= now)))
    ) {
      maintaining = true;
      start(replayAt <= now ? replay : clean);
    }
    if (!claiming && wantsClaim && retryAt <= now && active.size < CONCURRENCY) {
      claiming = true;
      wantsClaim = false;
      start(runClaim);
    }
  };

  const wake = () => {
    wantsClaim = true;
    pump();
  };
  await execution.startExecutor(() => {
    halt();
    log.error('VIDEO_EXECUTOR_LEASE_LOST');
  });
  if (!signal.aborted) {
    timer = setInterval(wake, POLL_INTERVAL_MS);
    timer.unref();
    wake();
  }
  return {
    drainAccount: (owner: string) => ownerWork.drain(owner),
    signal,
    wake() {
      if (!signal.aborted) setImmediate(wake);
    },
    close() {
      closing ??= Promise.resolve().then(async () => {
        await Promise.allSettled(active);
        try {
          await receipts.close();
        } finally {
          await execution.close();
        }
      });
      halt();
      return closing;
    },
  };
}
