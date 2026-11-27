import { epochMs } from '@mio/foundation/time';
import type {
  WorkerExecutionIdentity,
  WorkerLimits,
  WorkerResourceClass,
  WorkerTelemetryEvent,
} from '@mio/compute-contracts';
import type { Pool } from 'pg';
import type { WorkerInstanceRow } from './store.ts';

const STALE_MS = 15_000;
const OFFLINE_MS = 60_000;
const labels = ['online', 'stale', 'offline', 'unseen'] as const;
const noSlots = { total: 0, encode: 0, probe: 0 };
export const workerExecutionStates = [
  'queued',
  'active',
  'released',
  'cancelled',
  'unknown',
] as const;
type ExecutionState = (typeof workerExecutionStates)[number];
export interface WorkerExecutionFilters {
  instanceId?: string;
  jobId?: string;
  state?: ExecutionState;
  limit: number;
}

type ExecutionRow = {
  execution_id: string;
  instance_id: string;
  boot_id: string;
  protocol: WorkerExecutionIdentity['protocol'];
  job_id: string;
  attempt_id: string | null;
  inspection_id: string | null;
  resource: WorkerResourceClass;
  slots: number;
  state: ExecutionState;
  uncertain: boolean;
  queued_at: Date | null;
  acquired_at: Date | null;
  ended_at: Date | null;
  last_at: Date;
  business_state: string | null;
  business_stage: string | null;
};

// A lost event could have changed the state of a task already waiting during that boot.
// The stored gap position also applies when its carrier or the queued event arrives late.
const executionStateSQL = `
  CASE WHEN e.event_state IN ('queued','active') AND
    (e.uncertain OR COALESCE(LEAST(w.observed_at,w.received_at)<$2::timestamptz-interval '15 seconds',true)
      OR (e.event_state='queued' AND e.boot_sequence=(w.latest_gap->'last'->>'bootSequence')::bigint
        AND e.sequence<(w.latest_gap->'last'->>'sequence')::bigint))
    THEN 'unknown' ELSE e.event_state END
`;
const executionSQL = `
  SELECT e.*, ${executionStateSQL} AS state,
    COALESCE(t.state,m.state) AS business_state, m.stage AS business_stage
  FROM mio_compute_worker_executions e
  JOIN mio_compute_worker_instances w ON w.instance_id=e.instance_id
  LEFT JOIN mio_compute_jobs t
    ON e.protocol='transcode.v1' AND t.id=e.job_id AND t.attempt_id=e.attempt_id
  LEFT JOIN mio_media_jobs m
    ON e.protocol='media' AND m.id=e.job_id AND m.attempt_id=e.attempt_id
`;

function executionView(row: ExecutionRow) {
  return {
    executionId: row.execution_id,
    instanceId: row.instance_id,
    bootId: row.boot_id,
    protocol: row.protocol,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    inspectionId: row.inspection_id,
    resource: row.resource,
    slots: row.slots,
    state: row.state,
    uncertain: row.state === 'unknown' || (row.state === 'released' && !row.acquired_at),
    queuedAt: row.queued_at,
    acquiredAt: row.acquired_at,
    endedAt: row.ended_at,
    lastAt: row.last_at,
    businessState: row.business_state,
    businessStage: row.business_stage,
  };
}

function workerView(id: string, row: WorkerInstanceRow | undefined, now: number) {
  const observed = row?.observed_at?.getTime();
  const received = row?.received_at?.getTime();
  const age =
    observed === undefined || received === undefined
      ? null
      : Math.max(0, now - Math.min(observed, received));
  const status =
    age === null
      ? labels[3]
      : age > OFFLINE_MS
        ? labels[2]
        : age > STALE_MS
          ? labels[1]
          : labels[0];
  const snapshot = row?.snapshot ?? null;
  const draining =
    snapshot !== null &&
    (snapshot.usage.total > snapshot.limits.applied.total ||
      snapshot.usage.encode > snapshot.limits.applied.encode ||
      snapshot.usage.probe > snapshot.limits.applied.probe);
  return {
    instanceId: id,
    status,
    bootId: row?.boot_id ?? null,
    observedAt: row?.observed_at ?? null,
    receivedAt: row?.received_at ?? null,
    ageMs: age,
    clockUncertain:
      observed !== undefined && received !== undefined && Math.abs(observed - received) > STALE_MS,
    gap: row?.latest_gap ?? null,
    draining,
    snapshot,
    desired: row?.desired_limits
      ? {
          limits: row.desired_limits,
          revision: Number(row.desired_revision),
          commandId: row.desired_command_id,
          status: row.desired_status,
          reason: row.desired_reason,
          requestedAt: row.desired_requested_at,
          confirmedAt: row.desired_confirmed_at,
        }
      : null,
  };
}

interface HistoryPoint {
  at: Date;
  bootId?: string;
  usage: WorkerLimits;
  waiting: WorkerLimits;
  applied: WorkerLimits;
  hard: WorkerLimits;
  workers: number;
  clockUncertain: boolean;
  gap: boolean;
}
interface Sample extends Omit<HistoryPoint, 'workers'> {
  instance_id: string;
  tick: string;
}
const clock = 'abs(extract(epoch FROM s.observed_at - s.received_at)) > 15';
const gap = `s.gap IS NOT NULL OR EXISTS (
  SELECT 1 FROM mio_compute_worker_events e WHERE e.instance_id=s.instance_id AND e.gap IS NOT NULL
    AND e.event_at>s.sample_at-interval '5 seconds' AND e.event_at<=s.sample_at
)`;

const metrics = ['total', 'encode', 'probe'] as const;
export class WorkerObservabilityQueries {
  readonly #pool: Pool;
  readonly #instances: readonly string[];

  constructor(pool: Pool, instances: readonly string[]) {
    this.#pool = pool;
    this.#instances = [...instances].sort();
  }

  async workers(limit: number, offset: number, now = epochMs()) {
    const ids = this.#instances.slice(offset, offset + limit);
    if (!ids.length) return { workers: [], total: this.#instances.length, offset };
    const { rows } = await this.#pool.query<WorkerInstanceRow>(
      `SELECT * FROM mio_compute_worker_instances WHERE ${ids.length === 1 ? 'instance_id=$1' : 'instance_id=ANY($1::text[])'}`,
      [ids.length === 1 ? ids[0] : ids],
    );
    const byId = new Map(rows.map((row) => [row.instance_id, row]));
    return {
      workers: ids.map((id) => workerView(id, byId.get(id), now)),
      total: this.#instances.length,
      offset,
    };
  }

  async worker(id: string, now = epochMs()) {
    if (!this.#instances.includes(id)) return null;
    const row = (
      await this.#pool.query<WorkerInstanceRow>(
        'SELECT * FROM mio_compute_worker_instances WHERE instance_id=$1',
        [id],
      )
    ).rows[0];
    return workerView(id, row, now);
  }

  async summary(now = epochMs()) {
    const [{ workers }, { rows: queue }, { rows: peaks }] = await Promise.all([
      this.workers(this.#instances.length, 0, now),
      this.#pool.query<{ transcode: number; media: number }>(`
        SELECT (SELECT count(*)::integer FROM mio_compute_outbox WHERE sent_at IS NULL) AS transcode,
          (SELECT count(*)::integer FROM mio_media_outbox WHERE sent_at IS NULL) AS media
      `),
      this.#pool.query<{ instanceId: string; peak: number }>(
        `
        SELECT instance_id AS "instanceId",max((usage->>'total')::bigint)::float8 AS peak
        FROM mio_compute_worker_events WHERE ${this.#instances.length === 1 ? 'instance_id=$1' : 'instance_id=ANY($1::text[])'} AND event_at BETWEEN $2 AND $3
        AND kind='execution' GROUP BY instance_id ORDER BY instance_id
      `,
        [
          this.#instances.length === 1 ? this.#instances[0] : this.#instances,
          new Date(now - 3600_000),
          new Date(now),
        ],
      ),
    ]);
    const counts = { online: 0, stale: 0, offline: 0, unseen: 0 };
    const aggregate = {
      usage: { ...noSlots },
      applied: { ...noSlots },
      hard: { ...noSlots },
      waiting: { ...noSlots },
      heldResources: 0,
    };
    for (const worker of workers) {
      counts[worker.status]++;
      const snapshot = worker.snapshot;
      if (!snapshot || worker.status !== 'online') continue;
      for (const key of metrics) {
        aggregate.usage[key] += snapshot.usage[key];
        aggregate.applied[key] += snapshot.limits.applied[key];
        aggregate.hard[key] += snapshot.limits.hard[key];
        aggregate.waiting[key] += snapshot.waiting[key];
      }
      aggregate.heldResources +=
        Number(snapshot.holds.encode.length > 0) + Number(snapshot.holds.probe.length > 0);
    }
    const pending = queue[0]!;
    return {
      now: new Date(now),
      instances: counts,
      aggregate,
      outbox: { ...pending, total: pending.transcode + pending.media },
      broker: { ready: null, unacknowledged: null },
      peaks,
    };
  }

  async executions(input: WorkerExecutionFilters, now = epochMs()) {
    if (
      !this.#instances.length ||
      (input.instanceId !== undefined && !this.#instances.includes(input.instanceId))
    )
      return { executions: [] };
    const instanceId =
      input.instanceId ?? (this.#instances.length === 1 ? this.#instances[0] : undefined);
    const args: unknown[] = [instanceId ?? this.#instances, new Date(now)];
    const conditions = [
      instanceId === undefined ? 'e.instance_id=ANY($1::text[])' : 'e.instance_id=$1',
    ];
    if (input.jobId !== undefined) {
      args.push(input.jobId);
      conditions.push(`e.job_id=$${args.length}::uuid`);
    }
    if (input.state === 'active' || input.state === 'queued') {
      // Fixed literals expose the existing open partial-index predicate.
      conditions.push(
        input.state === 'active' ? "e.event_state='active'" : "e.event_state='queued'",
        'NOT e.uncertain',
        "LEAST(w.observed_at,w.received_at)>=$2::timestamptz-interval '15 seconds'",
      );
      if (input.state === 'queued')
        conditions.push(`NOT COALESCE(
        e.boot_sequence=(w.latest_gap->'last'->>'bootSequence')::bigint
        AND e.sequence<(w.latest_gap->'last'->>'sequence')::bigint,false)`);
    } else if (input.state !== undefined) {
      args.push(input.state);
      conditions.push(
        input.state === 'released' || input.state === 'cancelled'
          ? `e.event_state=$${args.length}`
          : `(${executionStateSQL})=$${args.length}`,
      );
    }
    args.push(input.limit);
    const { rows } = await this.#pool.query<ExecutionRow>(
      `${executionSQL} WHERE ${conditions.join(' AND ')}
      ORDER BY e.last_at DESC,e.execution_id LIMIT $${args.length}`,
      args,
    );
    return { executions: rows.map(executionView) };
  }

  async execution(id: string, now = epochMs()) {
    if (!this.#instances.length) return null;
    const singleton = this.#instances.length === 1;
    const row = (
      await this.#pool.query<ExecutionRow>(
        `${executionSQL} WHERE e.execution_id=$3 AND ${singleton ? 'e.instance_id=$1' : 'e.instance_id=ANY($1::text[])'}`,
        [singleton ? this.#instances[0] : this.#instances, new Date(now), id],
      )
    ).rows[0];
    if (!row) return null;
    const { rows } = await this.#pool.query<{
      sequence: string;
      detail: WorkerTelemetryEvent;
      at: Date;
      receivedAt: Date;
    }>(
      `
      SELECT sequence,detail,event_at AS "at",received_at AS "receivedAt"
      FROM mio_compute_worker_events WHERE execution_id=$1 ORDER BY sequence LIMIT 1000
    `,
      [id],
    );
    return {
      ...executionView(row),
      timeline: rows.map((event) => ({ ...event, sequence: Number(event.sequence) })),
    };
  }

  async history(instanceId: string | undefined, since: Date, until: Date, limit: number) {
    if (
      !this.#instances.length ||
      (instanceId !== undefined && !this.#instances.includes(instanceId))
    )
      return { since, until, points: [] };
    const pool = this.#pool;
    const ids = this.#instances;
    if (instanceId !== undefined) {
      const { rows } = await pool.query<HistoryPoint>(
        `SELECT s.sample_at AS at,s.boot_id AS "bootId",s.usage,s.waiting,s.applied,s.hard,1 AS workers,
          ${clock} AS "clockUncertain",(${gap}) AS gap
        FROM mio_compute_worker_samples s
        WHERE s.instance_id=$1 AND s.sample_at BETWEEN $2 AND $3
        ORDER BY s.sample_at DESC,s.received_at DESC,s.message_id DESC LIMIT $4`,
        [instanceId, since, until, limit],
      );
      return { since, until, points: rows.reverse() };
    }
    const singleton = ids.length === 1;
    const scope = singleton ? ids[0] : ids;
    const client = await pool.connect();
    let discard = false;
    const disconnected = () => {
      discard = true;
    };
    client.on('error', disconnected);
    try {
      // READ ONLY alone would retain READ COMMITTED's per-statement snapshots.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { rows: times } = await client.query<{
        sample_at: Date;
        boundary: string;
        tick: string;
      }>(
        `SELECT DISTINCT sample_at,sample_at::text AS boundary,
          (extract(epoch FROM sample_at)*1000000)::bigint::text AS tick
        FROM mio_compute_worker_samples
        WHERE ${singleton ? 'instance_id=$1' : 'instance_id=ANY($1::text[])'} AND sample_at BETWEEN $2 AND $3
        ORDER BY sample_at DESC LIMIT $4`,
        [scope, since, until, limit],
      );
      const { rows } = await client.query<Sample>(
        `SELECT DISTINCT ON (s.instance_id,s.sample_at) s.instance_id,s.sample_at AS at,
          (extract(epoch FROM s.sample_at)*1000000)::bigint::text AS tick,
          s.usage,s.waiting,s.applied,s.hard,${clock} AS "clockUncertain",(${gap}) AS gap
        FROM mio_compute_worker_samples s
        WHERE ${singleton ? 's.instance_id=$1' : 's.instance_id=ANY($1::text[])'} AND $4::boolean
          AND s.sample_at BETWEEN $2::timestamptz-interval '15 seconds' AND $3::timestamptz
        ORDER BY s.instance_id,s.sample_at,s.received_at DESC,s.message_id DESC`,
        [scope, times.at(-1)?.boundary ?? since, times[0]?.boundary ?? since, times.length > 0],
      );
      await client.query('COMMIT');
      const byInstance = new Map<string, Array<Sample & { micros: bigint }>>();
      for (const row of rows) {
        const samples = byInstance.get(row.instance_id) ?? [];
        samples.push({ ...row, micros: BigInt(row.tick) });
        byInstance.set(row.instance_id, samples);
      }
      const positions = new Map<string, number>();
      const points: HistoryPoint[] = [];
      for (const time of times.reverse()) {
        const tick = BigInt(time.tick);
        const point: HistoryPoint = {
          at: time.sample_at,
          usage: { ...noSlots },
          waiting: { ...noSlots },
          applied: { ...noSlots },
          hard: { ...noSlots },
          workers: 0,
          clockUncertain: false,
          gap: false,
        };
        for (const [id, samples] of byInstance) {
          let position = positions.get(id) ?? -1;
          while (position + 1 < samples.length && samples[position + 1]!.micros <= tick) position++;
          positions.set(id, position);
          const sample = samples[position];
          if (!sample || sample.micros < tick - 15_000_000n) continue;
          point.workers++;
          point.clockUncertain ||= sample.clockUncertain;
          point.gap ||= sample.gap;
          for (const name of ['usage', 'waiting', 'applied', 'hard'] as const)
            for (const resource of metrics) point[name][resource] += sample[name][resource];
        }
        points.push(point);
      }
      return { since, until, points };
    } catch (error) {
      if (!discard) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discard = true;
        }
      }
      throw error;
    } finally {
      client.removeListener('error', disconnected);
      client.release(discard);
    }
  }

  async limits(instanceId: string | undefined, limit: number) {
    if (
      !this.#instances.length ||
      (instanceId !== undefined && !this.#instances.includes(instanceId))
    )
      return { changes: [] };
    const singleton = instanceId ?? (this.#instances.length === 1 ? this.#instances[0] : undefined);
    const { rows } = await this.#pool.query(
      `
      SELECT command_id AS "commandId",instance_id AS "instanceId",revision::float8,
        requested_by AS "requestedBy",requested_at AS "requestedAt",
        previous_limits AS "previousLimits",requested_limits AS "requestedLimits",
        status,reason,applied_limits AS "appliedLimits",confirmed_at AS "confirmedAt",
        result_observed_at AS "resultObservedAt"
      FROM mio_compute_worker_limit_changes
      WHERE ${singleton === undefined ? 'instance_id=ANY($1::text[])' : 'instance_id=$1'}
      ORDER BY requested_at DESC,command_id LIMIT $2
    `,
      [singleton ?? this.#instances, limit],
    );
    return { changes: rows };
  }
}
