import { sha256Utf8 } from '@mio/foundation/hash';
import { epochMs } from '@mio/foundation/time';
import type {
  WorkerLimits,
  WorkerLimitsResult,
  WorkerTelemetry,
  WorkerTelemetryGap,
} from '@mio/compute-contracts';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { checkWorkerObservabilitySchema } from './schema.ts';
import { createLogger } from '@mio/foundation/logging';
import { computeTransaction } from '../database.ts';

type WorkerMessage = WorkerTelemetry | WorkerLimitsResult;
type LimitStatus = WorkerLimitsResult['status'] | 'pending';
type WorkerSnapshot = Pick<WorkerTelemetry, 'limits' | 'usage' | 'waiting' | 'holds' | 'active'>;

export interface WorkerInstanceRow {
  instance_id: string;
  boot_id: string | null;
  boot_sequence: string | null;
  sequence: string | null;
  observed_at: Date | null;
  received_at: Date | null;
  snapshot: WorkerSnapshot | null;
  desired_revision: string;
  desired_limits: WorkerLimits | null;
  desired_command_id: string | null;
  desired_requested_at: Date | null;
  desired_status: LimitStatus | null;
  desired_reason: WorkerLimitsResult['reason'];
  desired_confirmed_at: Date | null;
  latest_gap: WorkerTelemetryGap | null;
}

/** Invalid identity or conflicting replay. The broker dead-letters this instead of retrying it. */
export class WorkerObservationConflict extends Error {
  readonly permanent = true;
}

async function reserveMessage(
  client: PoolClient,
  message: WorkerMessage,
  receivedAt: Date,
): Promise<WorkerInstanceRow | null> {
  await client.query(
    'INSERT INTO mio_compute_worker_instances(instance_id) VALUES($1) ON CONFLICT DO NOTHING',
    [message.instanceId],
  );
  const current = (
    await client.query<WorkerInstanceRow>(
      'SELECT * FROM mio_compute_worker_instances WHERE instance_id=$1 FOR UPDATE',
      [message.instanceId],
    )
  ).rows[0]!;
  const digest = sha256Utf8(JSON.stringify(message));
  const identity = [message.instanceId, message.bootId, message.bootSequence, message.sequence];
  if (
    current.boot_id &&
    (current.boot_id === message.bootId) !==
      (Number(current.boot_sequence) === message.bootSequence)
  )
    throw new WorkerObservationConflict('WORKER_BOOT_CONFLICT');
  if (current.boot_id !== message.bootId) {
    // Exact boot lookups use the leading columns of the two inbox keys.
    const known = (
      await client.query<{ id: string | null; seq: string | null }>(
        `
      SELECT
        (SELECT boot_id FROM mio_compute_worker_inbox
          WHERE instance_id=$1 AND boot_sequence=$3 LIMIT 1) AS id,
        (SELECT boot_sequence FROM mio_compute_worker_inbox
          WHERE instance_id=$1 AND boot_id=$2 LIMIT 1) AS seq
    `,
        identity.slice(0, 3),
      )
    ).rows[0]!;
    if (
      (known.id && known.id !== message.bootId) ||
      (known.seq !== null && Number(known.seq) !== message.bootSequence)
    )
      throw new WorkerObservationConflict('WORKER_BOOT_CONFLICT');
  }
  const inserted = await client.query(
    `
    INSERT INTO mio_compute_worker_inbox(instance_id,boot_id,boot_sequence,sequence,message_id,digest,received_at,kind)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING
  `,
    [
      ...identity,
      message.messageId,
      digest,
      receivedAt,
      message.type === 'worker.limits.result' ? 'limit_result' : message.event ? 'event' : 'sample',
    ],
  );
  if (inserted.rowCount) return current;
  const previous = (
    await client.query<{ digest: string }>(
      'SELECT digest FROM mio_compute_worker_inbox WHERE message_id=$1',
      [message.messageId],
    )
  ).rows[0];
  if (previous?.digest !== digest) throw new WorkerObservationConflict('WORKER_MESSAGE_CONFLICT');
  return null;
}

async function updateInstance(
  client: PoolClient,
  current: WorkerInstanceRow,
  message: WorkerTelemetry,
  observedAt: Date,
  receivedAt: Date,
): Promise<void> {
  const boot = Number(current.boot_sequence);
  if (
    message.bootSequence < boot ||
    (message.bootSequence === boot && message.sequence <= Number(current.sequence))
  )
    return;
  if (message.limits.revision < (current.snapshot?.limits.revision ?? 0))
    throw new WorkerObservationConflict('WORKER_REVISION_REGRESSION');
  if (message.bootSequence > boot) {
    await client.query(
      `
      UPDATE mio_compute_worker_executions SET uncertain=true
      WHERE instance_id=$1 AND boot_sequence<$2 AND event_state IN ('queued','active') AND NOT uncertain
    `,
      [message.instanceId, message.bootSequence],
    );
  }
  const { limits, usage, waiting, holds, active } = message;
  await client.query(
    `
    UPDATE mio_compute_worker_instances
    SET boot_id=$2,boot_sequence=$3,sequence=$4,observed_at=$5,received_at=$6,snapshot=$7
    WHERE instance_id=$1
  `,
    [
      message.instanceId,
      message.bootId,
      message.bootSequence,
      message.sequence,
      observedAt,
      receivedAt,
      JSON.stringify({ limits, usage, waiting, holds, active } satisfies WorkerSnapshot),
    ],
  );
  if (active.length) {
    // A heartbeat can arrive before its acquisition event or survive a lost event.
    await client.query(
      `
      INSERT INTO mio_compute_worker_executions AS previous(
        execution_id,instance_id,boot_id,boot_sequence,protocol,job_id,attempt_id,inspection_id,
        resource,slots,sequence,event_state,acquired_at,last_at,last_received_at
      )
      SELECT r."executionId",$1,$2,$3,r.protocol,r."jobId",r."attemptId",r."inspectionId",
        r.resource,r.slots,$4,'active',to_timestamp(r."acquiredAt"/1000.0),
        to_timestamp(r."acquiredAt"/1000.0),$5
      FROM jsonb_to_recordset($6::jsonb) AS r("executionId" uuid,protocol text,"jobId" uuid,
        "attemptId" uuid,"inspectionId" uuid,resource text,slots smallint,"acquiredAt" double precision)
      ON CONFLICT(execution_id) DO UPDATE SET
        event_state='active',sequence=EXCLUDED.sequence,uncertain=false,
        acquired_at=LEAST(previous.acquired_at,EXCLUDED.acquired_at),
        last_at=GREATEST(previous.last_at,EXCLUDED.last_at),last_received_at=EXCLUDED.last_received_at
      WHERE previous.instance_id=EXCLUDED.instance_id AND previous.boot_id=EXCLUDED.boot_id
        AND previous.sequence<EXCLUDED.sequence AND
        (previous.event_state='queued' OR (previous.event_state='active' AND previous.uncertain))
        AND (previous.protocol,previous.job_id,previous.attempt_id,previous.inspection_id,previous.resource)
          IS NOT DISTINCT FROM
          (EXCLUDED.protocol,EXCLUDED.job_id,EXCLUDED.attempt_id,EXCLUDED.inspection_id,EXCLUDED.resource)
    `,
      [
        message.instanceId,
        message.bootId,
        message.bootSequence,
        message.sequence,
        receivedAt,
        JSON.stringify(active),
      ],
    );
  }
  // Missing occupancy or waiting can be determined from the current snapshot, but never a terminal time.
  await client.query(
    `
    UPDATE mio_compute_worker_executions SET uncertain=true
    WHERE instance_id=$1 AND boot_id=$2 AND sequence<$3 AND NOT uncertain
      AND execution_id<>ALL($4::uuid[]) AND (
        event_state='active' OR
        (event_state='queued' AND (
          (resource='encode' AND $5=0) OR (resource='probe' AND $6=0)
        ))
      )
  `,
    [
      message.instanceId,
      message.bootId,
      message.sequence,
      active.map((item) => item.executionId),
      waiting.encode,
      waiting.probe,
    ],
  );
}

async function storeExecution(
  client: PoolClient,
  message: WorkerTelemetry,
  event: Extract<NonNullable<WorkerTelemetry['event']>, { kind: 'execution' }>,
  receivedAt: Date,
  retired: boolean,
): Promise<void> {
  const { executionId, protocol, jobId, attemptId, inspectionId, resource, slots } =
    event.execution;
  const at = new Date(event.at);
  const state = event.state === 'acquired' ? 'active' : event.state;
  const result = await client.query(
    `
    INSERT INTO mio_compute_worker_executions (
      execution_id,instance_id,boot_id,boot_sequence,protocol,job_id,attempt_id,inspection_id,resource,
      slots,sequence,event_state,uncertain,queued_at,acquired_at,ended_at,last_at,last_received_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
      CASE WHEN $12='queued' THEN $14::timestamptz END,
      CASE WHEN $12='active' THEN $14::timestamptz END,
      CASE WHEN $12 IN ('released','cancelled') THEN $14::timestamptz END,$14,$15)
    ON CONFLICT(execution_id) DO UPDATE SET
      sequence=GREATEST(EXCLUDED.sequence,mio_compute_worker_executions.sequence),
      event_state=CASE WHEN EXCLUDED.sequence>mio_compute_worker_executions.sequence
        THEN EXCLUDED.event_state ELSE mio_compute_worker_executions.event_state END,
      uncertain=EXCLUDED.uncertain OR mio_compute_worker_executions.uncertain,
      queued_at=LEAST(EXCLUDED.queued_at,mio_compute_worker_executions.queued_at),
      acquired_at=LEAST(EXCLUDED.acquired_at,mio_compute_worker_executions.acquired_at),
      ended_at=GREATEST(EXCLUDED.ended_at,mio_compute_worker_executions.ended_at),
      last_at=GREATEST(EXCLUDED.last_at,mio_compute_worker_executions.last_at),
      last_received_at=GREATEST(EXCLUDED.last_received_at,mio_compute_worker_executions.last_received_at)
    WHERE (mio_compute_worker_executions.instance_id,mio_compute_worker_executions.boot_id,
      mio_compute_worker_executions.protocol,mio_compute_worker_executions.job_id,
      mio_compute_worker_executions.attempt_id,mio_compute_worker_executions.inspection_id,
      mio_compute_worker_executions.resource)
      IS NOT DISTINCT FROM
      (EXCLUDED.instance_id,EXCLUDED.boot_id,EXCLUDED.protocol,EXCLUDED.job_id,
        EXCLUDED.attempt_id,EXCLUDED.inspection_id,EXCLUDED.resource)
  `,
    [
      executionId,
      message.instanceId,
      message.bootId,
      message.bootSequence,
      protocol,
      jobId,
      attemptId,
      inspectionId,
      resource,
      slots,
      message.sequence,
      state,
      retired,
      at,
      receivedAt,
    ],
  );
  if (!result.rowCount) throw new WorkerObservationConflict('WORKER_EXECUTION_CONFLICT');
}

async function storeTelemetry(
  client: PoolClient,
  current: WorkerInstanceRow,
  message: WorkerTelemetry,
  receivedAt: Date,
): Promise<void> {
  const observedAt = new Date(message.observedAt);
  await updateInstance(client, current, message, observedAt, receivedAt);
  const { event, gap } = message;
  if (gap) {
    await client.query(
      `
      UPDATE mio_compute_worker_instances SET latest_gap=$2 WHERE instance_id=$1
        AND (latest_gap IS NULL OR
          ((latest_gap->'last'->>'bootSequence')::bigint,(latest_gap->'last'->>'sequence')::bigint)
          < ($3,$4))
    `,
      [message.instanceId, gap, gap.last.bootSequence, gap.last.sequence],
    );
  }
  if (!event) {
    const sampleAt = new Date(Math.min(message.observedAt, receivedAt.getTime()));
    await client.query(
      `
      INSERT INTO mio_compute_worker_samples(message_id,instance_id,boot_id,sample_at,observed_at,
        received_at,usage,waiting,hard,applied,revision,holds,gap)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `,
      [
        message.messageId,
        message.instanceId,
        message.bootId,
        sampleAt,
        observedAt,
        receivedAt,
        message.usage,
        message.waiting,
        message.limits.hard,
        message.limits.applied,
        message.limits.revision,
        message.holds,
        gap ?? null,
      ],
    );
    return;
  }
  await client.query(
    `
    INSERT INTO mio_compute_worker_events(message_id,instance_id,boot_id,boot_sequence,sequence,
      execution_id,event_at,received_at,kind,detail,usage,gap) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  `,
    [
      message.messageId,
      message.instanceId,
      message.bootId,
      message.bootSequence,
      message.sequence,
      'execution' in event ? event.execution.executionId : null,
      new Date(event.at),
      receivedAt,
      event.kind,
      JSON.stringify(event),
      message.usage,
      gap ?? null,
    ],
  );
  if (event.kind === 'execution') {
    await storeExecution(
      client,
      message,
      event,
      receivedAt,
      message.bootSequence < Number(current.boot_sequence) ||
        (message.bootId === current.boot_id &&
          message.sequence < Number(current.sequence) &&
          (event.state === 'acquired' ||
            (event.state === 'queued' &&
              current.snapshot?.waiting[event.execution.resource] === 0)) &&
          !current.snapshot?.active.some(
            (item) => item.executionId === event.execution.executionId,
          )),
    );
  }
}

async function storeLimitResult(
  client: PoolClient,
  current: WorkerInstanceRow,
  result: WorkerLimitsResult,
  receivedAt: Date,
): Promise<void> {
  // STALE_REVISION is a replay outcome. An original durable decision outranks it.
  await client.query(
    `
    UPDATE mio_compute_worker_limit_changes
    SET status=$4,reason=$5,applied_limits=$6,confirmed_at=$7,result_observed_at=$8,result_message_id=$9
    WHERE instance_id=$1 AND command_id=$2 AND revision=$3 AND (
      status='pending' OR (status='rejected' AND reason='STALE_REVISION' AND $5 IS DISTINCT FROM 'STALE_REVISION')
    )
  `,
    [
      result.instanceId,
      result.commandId,
      result.revision,
      result.status,
      result.reason,
      result.limits,
      receivedAt,
      new Date(result.observedAt),
      result.messageId,
    ],
  );
  if (
    result.commandId !== current.desired_command_id ||
    (result.status === 'applied' && result.bootSequence < Number(current.boot_sequence))
  )
    return;
  // Old applied receipts remain in audit; they do not confirm the current boot.
  await client.query(
    `
    UPDATE mio_compute_worker_instances w
    SET desired_status=$4,desired_reason=$5,desired_confirmed_at=$6
    FROM mio_compute_worker_limit_changes a
    WHERE w.instance_id=$1 AND w.desired_command_id=$2 AND w.desired_revision=$3
      AND a.command_id=$2 AND a.status=$4 AND a.reason IS NOT DISTINCT FROM $5
      AND (w.desired_status='pending' OR (w.desired_reason='STALE_REVISION' AND $5 IS DISTINCT FROM 'STALE_REVISION'))
  `,
    [
      result.instanceId,
      result.commandId,
      result.revision,
      result.status,
      result.reason,
      receivedAt,
    ],
  );
}

const retention = [
  [
    'mio_compute_worker_executions',
    'execution_id',
    "last_received_at < $1::timestamptz - interval '30 days'",
  ],
  [
    'mio_compute_worker_control_outbox',
    'command_id',
    "sent_at < $1::timestamptz - interval '90 days'",
  ],
  [
    'mio_compute_worker_limit_changes',
    'command_id',
    `requested_at < $1::timestamptz - interval '90 days'
    AND NOT EXISTS(SELECT 1 FROM mio_compute_worker_control_outbox o WHERE o.command_id=t.command_id)`,
  ],
  [
    'mio_compute_worker_inbox',
    'message_id',
    `kind='limit_result' AND received_at < $1::timestamptz - interval '7 days'
    AND NOT EXISTS (SELECT 1 FROM mio_compute_worker_samples s WHERE s.message_id=t.message_id)
    AND NOT EXISTS (SELECT 1 FROM mio_compute_worker_events e WHERE e.message_id=t.message_id)
    AND NOT EXISTS (SELECT 1 FROM mio_compute_worker_limit_changes l WHERE l.result_message_id=t.message_id)`,
  ],
] as const;

export class WorkerObservabilityStore {
  readonly #pool: Pool;
  readonly #allowlist: ReadonlySet<string>;

  constructor(pool: Pool, instances: readonly string[]) {
    this.#pool = pool;
    this.#allowlist = new Set(instances);
  }

  async receive(message: WorkerMessage, receivedAt = new Date(epochMs())): Promise<void> {
    if (!this.#allowlist.has(message.instanceId))
      throw new WorkerObservationConflict('WORKER_INSTANCE_DENIED');
    await computeTransaction(this.#pool, async (client) => {
      const current = await reserveMessage(client, message, receivedAt);
      if (!current) return;
      if (message.type === 'worker.telemetry')
        await storeTelemetry(client, current, message, receivedAt);
      else await storeLimitResult(client, current, message, receivedAt);
    });
  }

  async prune(now = new Date(epochMs())): Promise<void> {
    for (const [table, days] of [
      ['mio_compute_worker_samples', 7],
      ['mio_compute_worker_events', 30],
    ] as const) {
      await computeTransaction(this.#pool, async (client) => {
        const { rows } = await client.query<{ message_id: string }>(
          `DELETE FROM ${table} WHERE message_id IN (
            SELECT message_id FROM ${table}
            WHERE received_at < $1::timestamptz - $2 * interval '1 day'
            LIMIT 2000 FOR UPDATE SKIP LOCKED
          ) RETURNING message_id`,
          [now, days],
        );
        if (!rows.length) return;
        // Restrict all reference checks to this batch's PKs, including legacy mixed references.
        await client.query(
          `DELETE FROM mio_compute_worker_inbox t WHERE message_id=ANY($1::uuid[])
            AND NOT EXISTS (SELECT 1 FROM mio_compute_worker_samples s WHERE s.message_id=t.message_id)
            AND NOT EXISTS (SELECT 1 FROM mio_compute_worker_events e WHERE e.message_id=t.message_id)
            AND NOT EXISTS (SELECT 1 FROM mio_compute_worker_limit_changes l WHERE l.result_message_id=t.message_id)`,
          [rows.map((row) => row.message_id)],
        );
      });
    }
    // Independent bounded deletes release row locks between data classes.
    for (const [table, id, expired] of retention) {
      await this.#pool.query(
        `
        DELETE FROM ${table} WHERE ${id} IN (
          SELECT t.${id} FROM ${table} t WHERE ${expired} LIMIT 2000 FOR UPDATE SKIP LOCKED
        )
      `,
        [now],
      );
    }
  }
}

export async function openWorkerObservabilityPools(databaseURL: string) {
  const options = {
    connectionString: databaseURL,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 8000,
    lock_timeout: 3000,
  };
  const read = new Pool({ ...options, max: 2 });
  const write = new Pool({ ...options, max: 3 });
  const close = async () => {
    const results = await Promise.allSettled([read.end(), write.end()]);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Worker database cleanup failed',
      );
  };
  const log = createLogger('app', 'worker-observability-db');
  for (const pool of [read, write])
    pool.on('error', () => log.error('WORKER_OBSERVABILITY_DATABASE_FAILED'));
  try {
    await Promise.all([
      checkWorkerObservabilitySchema(read),
      checkWorkerObservabilitySchema(write),
    ]);
    return { read, write, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
