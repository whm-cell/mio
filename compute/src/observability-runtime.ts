import { createId } from '@mio/foundation/identifiers';
import { createLogger } from '@mio/foundation/logging';
import { epochMs } from '@mio/foundation/time';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  WorkerLimits,
  WorkerLimitsCommand,
  WorkerLimitsResult,
  WorkerTelemetry,
  WorkerTelemetryEvent,
} from '@mio/compute-contracts';
import { WorkerTelemetryPublishRejected } from './adapters/rabbitmq.ts';
import type { WorkerObservabilityJournal } from './adapters/worker-observability-journal.ts';

const log = createLogger('worker', 'observability');
const heartbeatMs = 5_000;

type Snapshot = Pick<WorkerTelemetry, 'limits' | 'usage' | 'waiting' | 'holds' | 'active'>;
interface ObservedSlots {
  snapshot(): Omit<Snapshot, 'limits'> & { hard: WorkerLimits; applied: WorkerLimits };
  setLimits(limits: WorkerLimits): void;
  subscribe(observe: (event: WorkerTelemetryEvent) => void): () => void;
}

interface ObservabilityBroker {
  consumeWorkerControl(
    instanceId: string,
    handle: (command: WorkerLimitsCommand, ack: () => void) => Promise<void>,
    failed: (error: unknown) => void,
  ): Promise<void>;
  publishWorker(message: WorkerTelemetry | WorkerLimitsResult): Promise<void>;
  closed(): Promise<void>;
  close(): Promise<void>;
}

function sameLimits(left: WorkerLimits, right: WorkerLimits): boolean {
  return left.total === right.total && left.encode === right.encode && left.probe === right.probe;
}

function clamp(limits: WorkerLimits, hard: WorkerLimits): WorkerLimits {
  return {
    total: Math.min(limits.total, hard.total),
    encode: Math.min(limits.encode, hard.encode),
    probe: Math.min(limits.probe, hard.probe),
  };
}

export function createWorkerObservability(
  instanceId: string,
  journal: WorkerObservabilityJournal,
  slots: ObservedSlots,
) {
  const boot = journal.boot();
  const bootId = createId();
  const { hard } = slots.snapshot();
  // Deployment can lower the ceiling without reviving an older control command.
  let applied = { revision: boot.applied.revision, limits: clamp(boot.applied.requested, hard) };
  slots.setLimits(applied.limits);
  let sequence = 0;
  let recordFailed = false;
  const envelope = () => ({
    version: 1 as const,
    messageId: createId(),
    instanceId,
    bootId,
    bootSequence: boot.bootSequence,
    sequence: ++sequence,
    observedAt: epochMs(),
  });
  const observe = (event: WorkerTelemetryEvent | null) => {
    try {
      const { usage, waiting, holds, active } = slots.snapshot();
      journal.telemetry({
        ...envelope(),
        type: 'worker.telemetry',
        limits: { hard, applied: applied.limits, revision: applied.revision },
        usage,
        waiting,
        holds,
        active,
        event,
      });
      recordFailed = false;
    } catch {
      if (!recordFailed) log.error('WORKER_TELEMETRY_RECORD_FAILED');
      recordFailed = true;
    }
  };
  const apply = (command: WorkerLimitsCommand) => {
    const { handled } = journal.control();
    const { revision, limits, messageId: id } = command;
    let reason: WorkerLimitsResult['reason'] = 'STALE_REVISION';
    let change = false;
    if (command.instanceId !== instanceId) reason = 'INSTANCE_MISMATCH';
    else if (
      revision === handled?.revision &&
      handled.id === id &&
      sameLimits(handled.limits, limits)
    )
      reason = handled.reason;
    else if (revision > (handled?.revision ?? 0)) {
      change = true;
      reason = sameLimits(limits, clamp(limits, hard)) ? null : 'HARD_LIMIT_EXCEEDED';
    }
    const fresh = change && reason === null;
    const effective = fresh ? limits : applied.limits;
    journal.result(
      {
        ...envelope(),
        type: 'worker.limits.result',
        commandId: id,
        revision,
        status: reason === null ? 'applied' : 'rejected',
        reason,
        limits: effective,
      },
      change ? { revision, id, limits, reason } : null,
    );
    if (fresh) {
      applied = { revision, limits };
      slots.setLimits(limits);
      observe({ kind: 'limits', state: 'applied', at: epochMs(), limits });
    }
  };
  const { commandId, revision } = boot.applied;
  const bootstrap: Pick<
    WorkerLimitsResult,
    'commandId' | 'revision' | 'status' | 'reason' | 'limits'
  >[] = [];
  if (commandId)
    bootstrap.push({
      commandId,
      revision,
      status: 'applied' as const,
      reason: null,
      limits: applied.limits,
    });
  if (boot.handled?.reason)
    bootstrap.push({
      commandId: boot.handled.id,
      revision: boot.handled.revision,
      status: 'rejected' as const,
      reason: boot.handled.reason,
      limits: applied.limits,
    });
  const confirmBoot = () => {
    while (bootstrap.length) {
      journal.result({ ...envelope(), type: 'worker.limits.result', ...bootstrap[0]! }, null);
      bootstrap.shift();
    }
  };
  return { observe, apply, confirmBoot };
}

async function flush(
  journal: WorkerObservabilityJournal,
  broker: ObservabilityBroker,
  stop: AbortSignal,
) {
  for (let n = 0; n < 32 && !stop.aborted; n++) {
    const item = journal.peek(n === 0);
    if (!item) return;
    let confirmed: number | null = null;
    try {
      await broker.publishWorker(item.message);
      confirmed = epochMs();
    } finally {
      journal.settled(item.id, confirmed);
    }
  }
}

export async function runWorkerObservability(
  instanceId: string,
  journal: WorkerObservabilityJournal,
  slots: ObservedSlots,
  runtime: ReturnType<typeof createWorkerObservability>,
  connect: (stop: AbortSignal) => Promise<ObservabilityBroker>,
  stop: AbortSignal,
): Promise<void> {
  const unsubscribe = slots.subscribe(runtime.observe);
  const recordHeartbeat = () => {
    // The boot may replay a durable applied or rejected command after a transient write failure.
    try {
      runtime.confirmBoot();
    } catch {
      log.error('WORKER_OBSERVATION_BOOT_CONFIRM_FAILED');
    }
    runtime.observe(null);
  };
  recordHeartbeat();
  const heartbeat = setInterval(recordHeartbeat, heartbeatMs);
  const retention = setInterval(() => {
    try {
      journal.prune(epochMs());
    } catch {
      log.error('WORKER_OBSERVATION_PRUNE_FAILED');
    }
  }, 60_000);
  heartbeat.unref();
  retention.unref();
  try {
    while (!stop.aborted) {
      let broker: ObservabilityBroker | undefined;
      try {
        broker = await connect(stop);
        const disconnect = new AbortController();
        const cycle = AbortSignal.any([disconnect.signal, stop]);
        void broker.closed().then(() => disconnect.abort());
        cycle.throwIfAborted();
        const { promise: cancelled, resolve: cancel } = Promise.withResolvers<void>();
        const onStop = () => cancel();
        cycle.addEventListener('abort', onStop, { once: true });
        try {
          await Promise.race([
            broker.consumeWorkerControl(
              instanceId,
              async (command, ack) => {
                cycle.throwIfAborted();
                runtime.apply(command);
                ack();
              },
              () => disconnect.abort(),
            ),
            cancelled,
          ]);
        } finally {
          cycle.removeEventListener('abort', onStop);
        }
        while (!cycle.aborted) {
          try {
            await flush(journal, broker, cycle);
          } catch (error) {
            if (!(error instanceof WorkerTelemetryPublishRejected)) throw error;
            log.warn('WORKER_TELEMETRY_ROUTE_REJECTED');
          }
          await delay(1_000, undefined, { signal: cycle }).catch(() => {});
        }
      } catch {
        if (!stop.aborted) log.error('WORKER_OBSERVABILITY_TRANSPORT_FAILED');
      } finally {
        await broker?.close().catch(() => {});
      }
      if (!stop.aborted) await delay(5_000, undefined, { signal: stop }).catch(() => {});
    }
  } finally {
    clearInterval(heartbeat);
    clearInterval(retention);
    unsubscribe();
  }
}
