import { parseWorkerLimitsCommand } from '@mio/compute-contracts';
import type {
  WorkerLimits,
  WorkerLimitsCommand,
  WorkerLimitsResult,
  WorkerTelemetry,
} from '@mio/compute-contracts';
import { HttpError } from '@mio/foundation/errors';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createId } from '@mio/foundation/identifiers';
import { createLogger } from '@mio/foundation/logging';
import { epochMs } from '@mio/foundation/time';
import type { Pool } from 'pg';
import { computeTransaction } from '../database.ts';
import { WorkerControlPublishRejected } from '../../integrations/rabbitmq.ts';
import type { WorkerInstanceRow, WorkerObservabilityStore } from './store.ts';

export class WorkerOpsError extends HttpError {}

const log = createLogger('app', 'worker-observability');
type ControlLease = { command: WorkerLimitsCommand; lease_id: string };
type WorkerMessage = WorkerTelemetry | WorkerLimitsResult;

export class WorkerControlStore {
  readonly #pool: Pool;
  readonly #instances: readonly string[];

  constructor(pool: Pool, instances: readonly string[]) {
    this.#pool = pool;
    this.#instances = instances;
  }

  async request(
    instanceId: string,
    requestedBy: string,
    expectedRevision: number,
    limits: WorkerLimits,
  ) {
    if (!this.#instances.includes(instanceId))
      throw new WorkerOpsError(HTTP_STATUS.NOT_FOUND, 'WORKER_NOT_FOUND');
    return computeTransaction(this.#pool, async (client) => {
      const current = (
        await client.query<WorkerInstanceRow>(
          'SELECT * FROM mio_compute_worker_instances WHERE instance_id=$1 FOR UPDATE',
          [instanceId],
        )
      ).rows[0];
      if (!current?.snapshot) throw new WorkerOpsError(HTTP_STATUS.CONFLICT, 'WORKER_NOT_OBSERVED');
      const revision = Math.max(Number(current.desired_revision), current.snapshot.limits.revision);
      if (revision !== expectedRevision)
        throw new WorkerOpsError(HTTP_STATUS.CONFLICT, 'WORKER_REVISION_CONFLICT');
      const { hard, applied } = current.snapshot.limits;
      if (limits.total > hard.total || limits.encode > hard.encode || limits.probe > hard.probe)
        throw new WorkerOpsError(HTTP_STATUS.BAD_REQUEST, 'WORKER_HARD_LIMIT_EXCEEDED');
      const command = parseWorkerLimitsCommand({
        version: 1,
        type: 'worker.limits.command',
        messageId: createId(),
        instanceId,
        revision: revision + 1,
        limits,
        requestedBy,
        requestedAt: epochMs(),
      });
      const at = new Date(command.requestedAt);
      const previous = current.desired_limits ?? applied;
      await client.query(
        `
        INSERT INTO mio_compute_worker_limit_changes(command_id,instance_id,revision,requested_by,requested_at,
          previous_limits,requested_limits)
        VALUES($1,$2,$3,$4,$5,$6,$7)
      `,
        [command.messageId, instanceId, command.revision, requestedBy, at, previous, limits],
      );
      await client.query(
        `
        UPDATE mio_compute_worker_instances
        SET desired_revision=$2,desired_limits=$3,desired_command_id=$4,desired_requested_at=$5,
          desired_status='pending',desired_reason=NULL,desired_confirmed_at=NULL
        WHERE instance_id=$1
      `,
        [instanceId, command.revision, limits, command.messageId, at],
      );
      await client.query(
        `
        INSERT INTO mio_compute_worker_control_outbox(command_id,instance_id,revision,command,created_at)
        VALUES($1,$2,$3,$4,$5)
      `,
        [command.messageId, instanceId, command.revision, command, at],
      );
      return {
        commandId: command.messageId,
        revision: command.revision,
        requestedAt: at,
        limits,
        status: 'pending',
      };
    });
  }

  async claim(blocked: ReadonlySet<string>, now = epochMs()) {
    const { rows } = await this.#pool.query<ControlLease>(
      `
      WITH wanted AS (
        SELECT o.command_id FROM mio_compute_worker_control_outbox o
        WHERE o.instance_id=ANY($1::text[]) AND o.instance_id<>ALL($2::text[])
          AND o.sent_at IS NULL AND (o.lease_until IS NULL OR o.lease_until<$4)
          AND NOT EXISTS (
            SELECT 1 FROM mio_compute_worker_control_outbox earlier
            WHERE earlier.instance_id=o.instance_id AND earlier.revision<o.revision AND earlier.sent_at IS NULL
          )
        ORDER BY o.created_at,o.command_id LIMIT 1 FOR UPDATE OF o SKIP LOCKED
      )
      UPDATE mio_compute_worker_control_outbox o SET lease_id=$3,lease_until=$4::timestamptz+interval '30 seconds'
      FROM wanted WHERE o.command_id=wanted.command_id RETURNING o.command,o.lease_id
    `,
      [this.#instances, [...blocked], createId(), new Date(now)],
    );
    const row = rows[0];
    if (!row) return null;
    return { command: parseWorkerLimitsCommand(row.command), lease: row.lease_id };
  }

  async settle(id: string, lease: string, confirmed: boolean, now = epochMs()): Promise<void> {
    await this.#pool.query(
      `
      UPDATE mio_compute_worker_control_outbox
      SET lease_id=NULL,lease_until=NULL,sent_at=CASE WHEN $3 THEN $4::timestamptz END
      WHERE command_id=$1 AND lease_id=$2 AND sent_at IS NULL
    `,
      [id, lease, confirmed, new Date(now)],
    );
  }
}

interface ObservabilityConnection {
  consumeWorker(
    handle: (message: WorkerMessage) => Promise<void>,
    failed: () => void,
  ): Promise<void>;
  publishWorkerControl(command: WorkerLimitsCommand): Promise<void>;
  onClose(handler: () => void): void;
  close(): Promise<void>;
}

/** The dedicated connection keeps Worker history and per-instance control independent of compute publishing. */
export function startWorkerObservability(
  connect: (stop: AbortSignal) => Promise<ObservabilityConnection>,
  observations: WorkerObservabilityStore,
  control: WorkerControlStore | undefined,
) {
  const stop = new AbortController();
  let broker: ObservabilityConnection | undefined;
  let dispatch: Promise<void> | undefined;
  let pruning: Promise<void> | undefined;
  let retryAt = 0;
  const closing = new Set<Promise<void>>();
  const failed = (connection: ObservabilityConnection) => {
    if (broker !== connection) return;
    broker = undefined;
    retryAt = epochMs() + 5_000;
    const task = connection.close().catch(() => {});
    closing.add(task);
    void task.finally(() => closing.delete(task));
  };
  const wake = () => {
    if (stop.signal.aborted || dispatch || epochMs() < retryAt) return;
    dispatch = (async () => {
      if (!broker) {
        const connection = await connect(stop.signal);
        if (stop.signal.aborted) {
          await connection.close();
          return;
        }
        broker = connection;
        const { promise: cancelled, resolve: cancel } = Promise.withResolvers<void>();
        connection.onClose(() => {
          cancel();
          failed(connection);
        });
        const onStop = () => cancel();
        stop.signal.addEventListener('abort', onStop, { once: true });
        try {
          await Promise.race([
            connection.consumeWorker(
              (message) => {
                stop.signal.throwIfAborted();
                return observations.receive(message);
              },
              () => {
                cancel();
                failed(connection);
              },
            ),
            cancelled,
          ]);
        } finally {
          stop.signal.removeEventListener('abort', onStop);
        }
      }
      const connection = broker;
      if (!control || !connection) return;
      const blocked = new Set<string>();
      for (let i = 0; i < 16 && !stop.signal.aborted && broker === connection; i++) {
        const item = await control.claim(blocked);
        if (!item) break;
        try {
          await connection.publishWorkerControl(item.command);
          await control.settle(item.command.messageId, item.lease, true);
        } catch (error) {
          await control.settle(item.command.messageId, item.lease, false);
          if (!(error instanceof WorkerControlPublishRejected)) throw error;
          blocked.add(item.command.instanceId);
          log.warn('WORKER_CONTROL_ROUTE_REJECTED', { messageId: item.command.messageId });
        }
      }
    })()
      .catch(() => {
        if (stop.signal.aborted) return;
        log.error('WORKER_OBSERVABILITY_DISPATCH_FAILED');
        if (broker) failed(broker);
        else retryAt = epochMs() + 5_000;
      })
      .finally(() => {
        dispatch = undefined;
      });
  };
  const prune = () => {
    if (stop.signal.aborted || pruning) return;
    pruning = observations
      .prune()
      .catch(() => {
        log.error('WORKER_OBSERVABILITY_PRUNE_FAILED');
      })
      .finally(() => {
        pruning = undefined;
      });
  };
  const watch = setInterval(wake, 1_000);
  const retention = setInterval(prune, 60_000);
  watch.unref();
  retention.unref();
  wake();
  prune();
  return {
    wake,
    async close() {
      stop.abort();
      clearInterval(watch);
      clearInterval(retention);
      if (broker) failed(broker);
      await Promise.allSettled([dispatch, pruning]);
      await Promise.allSettled([...closing]);
    },
  };
}
