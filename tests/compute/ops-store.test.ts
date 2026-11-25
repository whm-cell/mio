import { randomUUID } from 'node:crypto';
import { parseWorkerTelemetry } from '@mio/compute-contracts';
import type {
  WorkerExecutionIdentity,
  WorkerLimitsResult,
  WorkerTelemetry,
  WorkerTelemetryEvent,
} from '@mio/compute-contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import {
  startWorkerObservability,
  WorkerControlStore,
} from '../../src/compute/observability/control.ts';
import { WorkerObservabilityQueries } from '../../src/compute/observability/queries.ts';
import {
  checkWorkerObservabilitySchema,
  workerObservabilitySchemaSQL,
} from '../../src/compute/observability/schema.ts';
import { WorkerObservabilityStore } from '../../src/compute/observability/store.ts';
import { authDatabase } from '../support/auth-database.ts';

const ids = ['worker-a', 'worker-b', 'worker-c', 'worker-unknown'];
const zero = { total: 0, encode: 0, probe: 0 };
const one = { total: 1, encode: 1, probe: 1 };
const two = { total: 2, encode: 1, probe: 1 };
const dayMs = 86_400_000;
let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let observations: WorkerObservabilityStore;
let queries: WorkerObservabilityQueries;
let control: WorkerControlStore;

beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(computeSchemaSQL);
  await pool.query(workerObservabilitySchemaSQL);
  await pool.query(workerObservabilitySchemaSQL);
  await checkWorkerObservabilitySchema(pool);
  observations = new WorkerObservabilityStore(pool, ids);
  queries = new WorkerObservabilityQueries(pool, ids);
  control = new WorkerControlStore(pool, ids);
}, 45_000);
beforeEach(async () => {
  await pool.query('TRUNCATE mio_compute_worker_instances CASCADE');
});
afterAll(async () => {
  await pool?.end();
  await database?.close();
}, 30_000);

function worker(instanceId = 'worker-a', bootSequence = 1, bootId = randomUUID()) {
  return (
    sequence: number,
    observedAt: number,
    event: WorkerTelemetryEvent | null = null,
  ): WorkerTelemetry => ({
    version: 1,
    type: 'worker.telemetry',
    messageId: randomUUID(),
    instanceId,
    bootId,
    bootSequence,
    sequence,
    observedAt,
    limits: { hard: two, applied: two, revision: 0 },
    usage: zero,
    waiting: zero,
    holds: { encode: [], probe: [] },
    active: [],
    event,
  });
}
function execution(): WorkerExecutionIdentity {
  return {
    executionId: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    inspectionId: null,
    protocol: 'media',
    resource: 'encode',
    slots: 1,
  };
}
const record = (at: number, message: WorkerTelemetry) =>
  observations.receive(message, new Date(at));

it('keeps new boot and sequence state while reconstructing out-of-order short executions', async () => {
  const now = Date.now();
  const a1 = worker();
  const a2 = worker('worker-a', 2);
  const first = execution();
  const acquired = a1(3, now - 40_000, {
    kind: 'execution',
    state: 'acquired',
    at: now - 40_000,
    execution: first,
  });
  acquired.usage = { total: 1, encode: 1, probe: 0 };
  acquired.active = [{ ...first, acquiredAt: now - 40_000 }];
  const released = a1(4, now - 39_000, {
    kind: 'execution',
    state: 'released',
    at: now - 39_000,
    execution: first,
  });
  const queued = a1(2, now - 41_000, {
    kind: 'execution',
    state: 'queued',
    at: now - 41_000,
    execution: first,
  });
  await record(now - 42_000, a1(1, now - 42_000));
  await record(now - 38_000, released);
  await record(now - 37_000, acquired);
  await record(now - 36_000, queued);
  await record(now - 35_000, released);
  const unknown = execution();
  await record(
    now - 32_000,
    a1(5, now - 32_000, {
      kind: 'execution',
      state: 'acquired',
      at: now - 32_000,
      execution: unknown,
    }),
  );
  const current = a2(1, now - 2_000);
  await record(now - 2_000, current);
  await record(now - 1_500, a1(9, now - 1_500));
  await expect(record(now - 1_000, worker('worker-a', 1)(100, now - 1000))).rejects.toThrow(
    'WORKER_BOOT_CONFLICT',
  );
  await expect(record(now - 500, worker('unlisted')(1, now - 500))).rejects.toThrow(
    'WORKER_INSTANCE_DENIED',
  );
  expect(await queries.worker('worker-a', now)).toMatchObject({
    bootId: current.bootId,
    status: 'online',
    observedAt: new Date(now - 2000),
  });
  const complete = await queries.execution(first.executionId);
  expect(complete).toMatchObject({
    state: 'released',
    queuedAt: new Date(now - 41_000),
    acquiredAt: new Date(now - 40_000),
    endedAt: new Date(now - 39_000),
  });
  expect(complete?.timeline.map((event) => event.sequence)).toEqual([2, 3, 4]);
  expect(await queries.execution(unknown.executionId)).toMatchObject({
    state: 'unknown',
    uncertain: true,
  });
  expect(
    (await queries.executions({ state: 'unknown', instanceId: 'worker-a', limit: 5 })).executions,
  ).toMatchObject([{ executionId: unknown.executionId }]);
  expect((await queries.summary(now)).peaks).toEqual([{ instanceId: 'worker-a', peak: 1 }]);
});

it('returns fresh bounded histories, separates stale/offline, and aggregates only recent samples', async () => {
  const now = Date.now();
  const a = worker();
  const b = worker('worker-b');
  await record(now - 58_000, a(1, now - 58_000));
  await record(now - 30_000, b(1, now - 30_000));
  await record(now - 10_000, a(2, now - 10_000));
  await record(now - 5000, b(2, now - 7000));
  await record(now - 500, worker('worker-c')(1, now - 65_000));
  expect(
    (await queries.workers(3, 1, now)).workers.map((row) => [
      row.instanceId,
      row.status,
      row.clockUncertain,
    ]),
  ).toEqual([
    ['worker-b', 'online', false],
    ['worker-c', 'offline', true],
    ['worker-unknown', 'unseen', false],
  ]);
  const history = await queries.history(undefined, new Date(now - 60_000), new Date(now), 2);
  expect(
    history.points.map((point) => [point.at.getTime(), point.workers, point.applied.total]),
  ).toEqual([
    [now - 10_000, 1, 2],
    [now - 7_000, 2, 4],
  ]);
  const raw = await queries.history('worker-a', new Date(now - 60_000), new Date(now), 10);
  expect(raw.points.map((point) => point.at.getTime())).toEqual([now - 58_000, now - 10_000]);
  expect(await queries.worker('worker-a', now + 8_000)).toMatchObject({ status: 'stale' });
  expect(await queries.summary(now)).toMatchObject({
    instances: { online: 2, stale: 0, offline: 1, unseen: 1 },
    aggregate: { applied: { total: 4 } },
    broker: { ready: null, unacknowledged: null },
  });
});

it('exposes a standalone video probe by job and attempt with its real slot timeline', async () => {
  const now = Date.now();
  const message = worker();
  const probe: WorkerExecutionIdentity = {
    ...execution(),
    protocol: 'video.probe.v1',
    resource: 'probe',
  };
  const acquired = message(1, now - 20, {
    kind: 'execution',
    state: 'acquired',
    at: now - 20,
    execution: probe,
  });
  acquired.usage = { total: 1, encode: 0, probe: 1 };
  acquired.active = [{ ...probe, acquiredAt: now - 20 }];
  await record(now - 20, parseWorkerTelemetry(acquired));
  expect(await queries.worker('worker-a', now)).toMatchObject({
    snapshot: { usage: acquired.usage, active: acquired.active },
  });
  await record(
    now - 10,
    parseWorkerTelemetry({
      ...message(2, now - 10, {
        kind: 'phase',
        phase: 'processing',
        at: now - 10,
        execution: probe,
      }),
      active: acquired.active,
      usage: acquired.usage,
    }),
  );
  await record(
    now,
    parseWorkerTelemetry(
      message(3, now, {
        kind: 'execution',
        state: 'released',
        at: now,
        execution: probe,
      }),
    ),
  );
  expect((await queries.executions({ jobId: probe.jobId, limit: 1 })).executions).toMatchObject([
    { ...probe, state: 'released', acquiredAt: new Date(now - 20), endedAt: new Date(now) },
  ]);
  expect(await queries.execution(probe.executionId)).toMatchObject({
    ...probe,
    businessState: null,
    businessStage: null,
    timeline: [
      { detail: { kind: 'execution', state: 'acquired' } },
      { detail: { kind: 'phase', phase: 'processing' } },
      { detail: { kind: 'execution', state: 'released' } },
    ],
  });
  expect(await queries.worker('worker-a', now)).toMatchObject({
    snapshot: { usage: zero, active: [] },
  });
});

it('serializes conflicting edits, correlates applied receipts, and keeps control claims independent per instance', async () => {
  const now = Date.now();
  const a = worker();
  const old = a(1, now - 5000);
  await record(now - 5000, old);
  await record(now - 5000, worker('worker-b')(1, now - 5000));
  const edits = await Promise.allSettled([
    control.request('worker-a', 'operator-1', 0, one),
    control.request('worker-a', 'operator-2', 0, one),
  ]);
  const update = edits.find((result) => result.status === 'fulfilled')?.value;
  expect(update).toMatchObject({ revision: 1, status: 'pending', limits: one });
  expect(edits.find((result) => result.status === 'rejected')?.reason).toMatchObject({
    status: 409,
    code: 'WORKER_REVISION_CONFLICT',
  });
  await expect(
    control.request('worker-a', 'operator', 1, { ...two, encode: 2 }),
  ).rejects.toMatchObject({
    status: 400,
    code: 'WORKER_HARD_LIMIT_EXCEEDED',
  });
  const second = await control.request('worker-a', 'operator-3', 1, zero);
  const b = await control.request('worker-b', 'operator-3', 0, one);
  const lease = await control.claim(new Set());
  expect(lease?.command.messageId).toBe(update?.commandId);
  const other = await control.claim(new Set(['worker-a']));
  expect(other?.command.messageId).toBe(b.commandId);
  await control.settle(lease!.command.messageId, lease!.lease, true);
  expect((await control.claim(new Set()))?.command.messageId).toBe(second.commandId);

  const reboot = worker('worker-a', 2)(1, now - 3000);
  await record(now - 3000, reboot);
  const result: WorkerLimitsResult = {
    version: 1,
    type: 'worker.limits.result',
    messageId: randomUUID(),
    instanceId: 'worker-a',
    bootId: old.bootId,
    bootSequence: 1,
    sequence: 2,
    observedAt: now - 1000,
    commandId: second.commandId,
    revision: 2,
    status: 'applied',
    reason: null,
    limits: zero,
  };
  await observations.receive(result, new Date(now - 1000));
  expect(await queries.worker('worker-a', now)).toMatchObject({
    desired: { revision: 2, status: 'pending' },
  });
  await observations.receive(
    { ...result, messageId: randomUUID(), bootId: reboot.bootId, bootSequence: 2 },
    new Date(now),
  );
  expect(await queries.worker('worker-a', now)).toMatchObject({
    desired: { revision: 2, status: 'applied' },
  });
  expect(await queries.limits('worker-a', 10)).toMatchObject({
    changes: expect.arrayContaining([
      expect.objectContaining({
        revision: 2,
        requestedBy: 'operator-3',
        status: 'applied',
        previousLimits: one,
        requestedLimits: zero,
        appliedLimits: zero,
      }),
    ]),
  });
});

it('prunes 7/30/90-day data without deleting inbox entries still referenced by execution or control audit', async () => {
  const now = Date.now();
  const a = worker();
  const sample = a(1, now - 8 * dayMs);
  await record(sample.observedAt, sample);
  const old = a(2, now - 31 * dayMs, {
    kind: 'execution',
    state: 'released',
    at: now - 31 * dayMs,
    execution: execution(),
  });
  const retained = a(3, now - 10 * dayMs, {
    kind: 'execution',
    state: 'released',
    at: now - 10 * dayMs,
    execution: execution(),
  });
  await record(old.observedAt, old);
  await record(retained.observedAt, retained);
  const update = await control.request('worker-a', 'operator', 0, one);
  const pending = await control.request('worker-a', 'operator', 1, two);
  const receipt: WorkerLimitsResult = {
    version: 1,
    type: 'worker.limits.result',
    messageId: randomUUID(),
    commandId: update.commandId,
    instanceId: 'worker-a',
    bootId: sample.bootId,
    bootSequence: 1,
    sequence: 4,
    observedAt: now - 20 * dayMs,
    revision: 1,
    status: 'applied',
    reason: null,
    limits: one,
  };
  await observations.receive(receipt, new Date(receipt.observedAt));
  await pool.query(
    "UPDATE mio_compute_worker_limit_changes SET requested_at=now()-interval '91 days'",
  );
  await pool.query(
    "UPDATE mio_compute_worker_control_outbox SET sent_at=now()-interval '80 days' WHERE command_id=$1",
    [update.commandId],
  );
  await observations.prune(new Date(now));
  const messages = async () =>
    (
      await pool.query<{ message_id: string }>('SELECT message_id FROM mio_compute_worker_inbox')
    ).rows.map((row) => row.message_id);
  expect(await messages()).toEqual(expect.arrayContaining([retained.messageId, receipt.messageId]));
  expect(await messages()).not.toEqual(expect.arrayContaining([sample.messageId, old.messageId]));
  expect((await queries.executions({ limit: 20 })).executions).toHaveLength(1);
  await pool.query(
    "UPDATE mio_compute_worker_control_outbox SET sent_at=now()-interval '91 days' WHERE command_id=$1",
    [update.commandId],
  );
  await observations.prune(new Date(now));
  expect(await messages()).toEqual([retained.messageId]);
  expect(await queries.limits('worker-a', 10)).toMatchObject({
    changes: [{ commandId: pending.commandId, status: 'pending' }],
  });
});

it('keeps the actual gap, marks a missing terminal observation unknown, and accepts a later true release', async () => {
  const now = Date.now();
  const a = worker();
  const one = execution();
  const acquired = a(1, now - 11_000, {
    kind: 'execution',
    state: 'acquired',
    at: now - 11_000,
    execution: one,
  });
  acquired.usage = { total: 1, encode: 1, probe: 0 };
  acquired.active = [{ ...one, acquiredAt: now - 11_000 }];
  await record(now - 11_000, acquired);
  const bare = a(3, now - 5_000);
  await record(now - 5_000, bare);
  expect(await queries.worker('worker-a', now)).toMatchObject({ gap: null });
  expect(await queries.execution(one.executionId)).toMatchObject({
    state: 'unknown',
    endedAt: null,
  });
  const loss = {
    first: { bootSequence: 1, sequence: 4, at: now - 4000 },
    last: { bootSequence: 1, sequence: 4, at: now - 4000 },
    count: 1,
  };
  const marked = { ...a(5, now - 500), gap: loss };
  await record(now - 500, marked);
  await record(now - 400, marked);
  expect(await queries.worker('worker-a', now)).toMatchObject({
    gap: loss,
    snapshot: { usage: zero },
  });
  const history = await queries.history('worker-a', new Date(now - 15_000), new Date(now), 20);
  expect(history.points.map((point) => point.gap)).toEqual([false, true]);
  await record(
    now - 200,
    a(2, now - 8_000, { kind: 'execution', state: 'released', at: now - 8_000, execution: one }),
  );
  expect(await queries.execution(one.executionId)).toMatchObject({
    state: 'released',
    uncertain: false,
    endedAt: new Date(now - 8000),
  });
  expect(await queries.worker('worker-a', now)).toMatchObject({ observedAt: new Date(now - 500) });
});

it('preserves a matching durable rejection delivered after a new boot without changing actual state', async () => {
  const now = Date.now();
  const first = worker()(1, now - 3000);
  await record(now - 3000, first);
  const update = await control.request('worker-a', 'op', 0, one);
  const fresh = worker('worker-a', 2)(1, now - 1000);
  await record(now - 1000, fresh);
  await observations.receive({
    version: 1,
    type: 'worker.limits.result',
    messageId: randomUUID(),
    commandId: update.commandId,
    instanceId: first.instanceId,
    bootId: first.bootId,
    bootSequence: 1,
    sequence: 2,
    observedAt: now - 2000,
    revision: 1,
    status: 'rejected',
    reason: 'HARD_LIMIT_EXCEEDED',
    limits: two,
  });
  expect(await queries.worker('worker-a', now)).toMatchObject({
    bootId: fresh.bootId,
    snapshot: { limits: { revision: 0, applied: two } },
    desired: { status: 'rejected', reason: 'HARD_LIMIT_EXCEEDED', revision: 1 },
  });
});

it('materializes real snapshot occupancy and preserves unknown when a queued cancellation was lost', async () => {
  const now = Date.now();
  const a = worker();
  const live = execution();
  const waiting = execution();
  const marker = {
    first: { bootSequence: 1, sequence: 1, at: now - 3000 },
    last: { bootSequence: 1, sequence: 1, at: now - 3000 },
    count: 1,
  };
  const sample = {
    ...a(2, now - 2000),
    active: [{ ...live, acquiredAt: now - 3000 }],
    usage: { total: 1, encode: 1, probe: 0 },
    gap: marker,
  };
  await record(now - 2000, sample);
  expect(await queries.execution(live.executionId)).toMatchObject({
    state: 'active',
    acquiredAt: new Date(now - 3000),
    endedAt: null,
    timeline: [],
  });
  const queued = a(3, now - 1500, {
    kind: 'execution',
    state: 'queued',
    at: now - 1500,
    execution: waiting,
  });
  queued.active = sample.active;
  queued.usage = sample.usage;
  queued.waiting = { total: 1, encode: 1, probe: 0 };
  await record(now - 1500, queued);
  expect(await queries.execution(waiting.executionId)).toMatchObject({
    state: 'queued',
    acquiredAt: null,
  });
  await record(now - 500, a(5, now - 500));
  expect(await queries.execution(waiting.executionId)).toMatchObject({
    state: 'unknown',
    acquiredAt: null,
    endedAt: null,
  });
  await record(
    now - 200,
    a(4, now - 1000, { kind: 'execution', state: 'cancelled', at: now - 1000, execution: waiting }),
  );
  expect(await queries.execution(waiting.executionId)).toMatchObject({
    state: 'cancelled',
    endedAt: new Date(now - 1000),
  });
});

it.each([
  [1, 3, 4, 5],
  [4, 1, 3, 5],
  [5, 1, 4, 3],
])('uses the loss position when queue messages arrive as %j %j %j %j', async (...order) => {
  const now = Date.now();
  const a = worker();
  const before = execution();
  const after = execution();
  const waiting = { total: 1, encode: 1, probe: 0 };
  const position = { bootSequence: 1, sequence: 2, at: now - 3000 };
  const messages: Record<number, WorkerTelemetry> = {
    1: {
      ...a(1, now - 4000, {
        kind: 'execution',
        state: 'queued',
        execution: before,
        at: now - 4000,
      }),
      waiting,
    },
    3: {
      ...a(3, now - 2000, {
        kind: 'execution',
        state: 'queued',
        execution: after,
        at: now - 2000,
      }),
      waiting,
    },
    4: { ...a(4, now - 1000), waiting, gap: { first: position, last: position, count: 1 } },
    5: { ...a(5, now), waiting },
  };
  for (const sequence of order) await record(now, parseWorkerTelemetry(messages[sequence]));

  expect(await queries.worker('worker-a', now)).toMatchObject({
    gap: messages[4]!.gap,
    snapshot: { waiting },
    observedAt: new Date(now),
  });
  expect(await queries.execution(before.executionId)).toMatchObject({
    state: 'unknown',
    endedAt: null,
  });
  expect(await queries.execution(after.executionId)).toMatchObject({ state: 'queued' });
  expect((await queries.executions({ state: 'unknown', limit: 10 })).executions).toMatchObject([
    { executionId: before.executionId },
  ]);

  await record(
    now,
    parseWorkerTelemetry(
      a(2, now - 3000, {
        kind: 'execution',
        state: 'cancelled',
        execution: before,
        at: now - 3000,
      }),
    ),
  );
  expect(await queries.execution(before.executionId)).toMatchObject({
    state: 'cancelled',
    endedAt: new Date(now - 3000),
  });
});

it('preserves a current queue when a loss belonged to another boot or instance', async () => {
  const now = Date.now();
  const a = worker('worker-a', 2);
  const b = worker('worker-b', 2);
  const current = execution();
  const waiting = { total: 1, encode: 1, probe: 0 };
  const queue = a(1, now - 4000, {
    kind: 'execution',
    state: 'queued',
    execution: current,
    at: now - 4000,
  });
  await record(now, parseWorkerTelemetry({ ...queue, waiting }));
  const old = { bootSequence: 1, sequence: 2, at: now - 5000 };
  await record(
    now,
    parseWorkerTelemetry({
      ...a(2, now - 3000),
      waiting,
      gap: { first: old, last: old, count: 1 },
    }),
  );
  const other = { bootSequence: 2, sequence: 2, at: now - 3000 };
  await record(
    now,
    parseWorkerTelemetry({
      ...b(3, now - 2000),
      gap: { first: other, last: other, count: 1 },
    }),
  );
  expect(await queries.execution(current.executionId)).toMatchObject({ state: 'queued' });

  await record(now, parseWorkerTelemetry(a(3, now - 1000)));
  expect(await queries.execution(current.executionId)).toMatchObject({
    state: 'unknown',
    endedAt: null,
  });
});

it('corrects an earlier stale replay without letting a later replay erase a durable outcome', async () => {
  const now = Date.now();
  const a = worker();
  const identity = a(1, now - 1500);
  await record(now - 1500, identity);
  const saved = await control.request('worker-a', 'operator', 0, one);
  await control.request('worker-a', 'operator', 1, two);
  const receipt: WorkerLimitsResult = {
    version: 1,
    type: 'worker.limits.result',
    messageId: randomUUID(),
    instanceId: 'worker-a',
    bootId: identity.bootId,
    bootSequence: 1,
    sequence: 3,
    observedAt: now - 500,
    commandId: saved.commandId,
    revision: 1,
    status: 'rejected',
    reason: 'STALE_REVISION',
    limits: two,
  };
  await observations.receive(receipt);
  await observations.receive({
    ...receipt,
    messageId: randomUUID(),
    sequence: 2,
    observedAt: now - 1000,
    status: 'applied',
    reason: null,
    limits: one,
  });
  await observations.receive({ ...receipt, messageId: randomUUID(), sequence: 4, observedAt: now });
  expect(await queries.limits('worker-a', 10)).toMatchObject({
    changes: expect.arrayContaining([
      expect.objectContaining({ revision: 1, status: 'applied', appliedLimits: one, reason: null }),
    ]),
  });
  expect(await queries.worker('worker-a', now)).toMatchObject({
    desired: { revision: 2, status: 'pending' },
  });
});

it('closes A observation even when a broker never resolves consumer registration', async () => {
  const entered = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  const close = vi.fn(async () => {});
  const runtime = startWorkerObservability(
    async () => ({
      async consumeWorker() {
        entered.resolve();
        return blocked.promise;
      },
      async publishWorkerControl() {},
      onClose() {},
      close,
    }),
    observations,
    undefined,
  );
  await entered.promise;
  await runtime.close();
  expect(close).toHaveBeenCalledOnce();
}, 1000);
