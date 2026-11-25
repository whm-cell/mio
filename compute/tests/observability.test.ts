import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkerLimits, WorkerLimitsCommand, WorkerTelemetry } from '@mio/compute-contracts';
import {
  checkWorkerObservabilityJournal,
  migrateWorkerObservabilityJournal,
  WorkerObservabilityJournal,
} from '../src/adapters/worker-observability-journal.ts';
import { createWorkerObservability, runWorkerObservability } from '../src/observability-runtime.ts';

const databases: DatabaseSync[] = [];
const hard = { total: 4, encode: 3, probe: 2 };
const empty = { total: 0, encode: 0, probe: 0 };
function database() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(
    'CREATE TABLE metadata(schema_version INTEGER NOT NULL); INSERT INTO metadata VALUES(7);',
  );
  migrateWorkerObservabilityJournal(db);
  checkWorkerObservabilityJournal(db);
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function slots(journal: WorkerObservabilityJournal, ceiling = hard) {
  let applied = ceiling;
  return {
    snapshot: () => ({
      hard: ceiling,
      applied,
      usage: empty,
      waiting: empty,
      active: [],
      holds: { encode: [], probe: [] },
    }),
    setLimits: vi.fn((limits: WorkerLimits) => {
      expect(journal.control().bootSequence).toBeGreaterThan(0);
      applied = limits;
    }),
    subscribe: () => () => {},
  };
}

function command(
  revision: number,
  limits: WorkerLimits,
  instanceId = 'b-worker',
): WorkerLimitsCommand {
  return {
    version: 1,
    type: 'worker.limits.command',
    messageId: randomUUID(),
    instanceId,
    revision,
    limits,
    requestedBy: 'fixture-operator',
    requestedAt: Date.now(),
  };
}

function drain(journal: WorkerObservabilityJournal, at = Date.now()) {
  const messages = [];
  for (let message = journal.peek(); message; message = journal.peek()) {
    messages.push(message.message);
    journal.settled(message.id, at);
  }
  return messages;
}

it('persists control decisions before admission and reports the same revision after a clamped restart', () => {
  const db = database();
  const journal = new WorkerObservabilityJournal(db);
  const firstSlots = slots(journal);
  const worker = createWorkerObservability('b-worker', journal, firstSlots);
  const selected = command(1, { total: 3, encode: 3, probe: 0 });
  firstSlots.setLimits.mockImplementationOnce(() => {
    expect(journal.control().applied.requested).toEqual(selected.limits);
    expect(journal.control().applied.revision).toBe(1);
  });
  worker.apply(selected);
  worker.apply(selected);
  expect(firstSlots.setLimits).toHaveBeenCalledTimes(2);
  const oversized = command(2, { total: 12, encode: 0, probe: 0 });
  worker.apply(oversized);
  worker.apply(command(3, empty, 'another-worker'));
  expect(journal.control().applied.revision).toBe(1);
  expect(journal.control().handled).toMatchObject({ revision: 2, reason: 'HARD_LIMIT_EXCEEDED' });
  const before = drain(journal).filter((message) => message.type === 'worker.limits.result');
  expect(before.map(({ status, reason }) => [status, reason])).toEqual([
    ['applied', null],
    ['applied', null],
    ['rejected', 'HARD_LIMIT_EXCEEDED'],
    ['rejected', 'INSTANCE_MISMATCH'],
  ]);

  const restarted = new WorkerObservabilityJournal(db);
  const lower = { total: 2, encode: 1, probe: 1 };
  const restartSlots = slots(restarted, lower);
  const runtime = createWorkerObservability('b-worker', restarted, restartSlots);
  runtime.confirmBoot();
  runtime.apply(oversized);
  runtime.apply(selected);
  const after = drain(restarted);
  expect(restartSlots.setLimits.mock.calls).toEqual([[{ total: 2, encode: 1, probe: 0 }]]);
  expect(after[0]).toMatchObject({
    bootSequence: 2,
    revision: 1,
    commandId: selected.messageId,
    status: 'applied',
    limits: { total: 2, encode: 1, probe: 0 },
  });
  expect(after[0]?.bootId).not.toEqual(before[0]?.bootId);
  expect(after[1]).toMatchObject({ revision: 2, reason: 'HARD_LIMIT_EXCEEDED' });
  expect(after[2]).toMatchObject({ revision: 2, reason: 'HARD_LIMIT_EXCEEDED' });
  expect(after[3]).toMatchObject({ revision: 1, reason: 'STALE_REVISION' });
});

it('rolls back a control write as a unit and records a bounded telemetry gap without breaking callers', () => {
  const db = database();
  const journal = new WorkerObservabilityJournal(db);
  const recorder = slots(journal);
  const runtime = createWorkerObservability('b-worker', journal, recorder);
  db.exec(`CREATE TRIGGER broken_observation BEFORE INSERT ON worker_observation_outbox BEGIN
    SELECT RAISE(FAIL,'fixture journal fault'); END;`);
  expect(() => runtime.observe(null)).not.toThrow();
  const pause = command(1, empty);
  expect(() => runtime.apply(pause)).toThrow('fixture journal fault');
  expect(journal.control().applied.revision).toBe(0);
  expect(recorder.setLimits).toHaveBeenCalledTimes(1);
  db.exec('DROP TRIGGER broken_observation');
  runtime.apply(pause);
  runtime.observe(null);
  const messages = drain(journal, Date.now() - 25 * 60 * 60_000);
  expect(messages.find((message) => message.type === 'worker.telemetry')).toMatchObject({
    limits: { revision: 1, applied: empty },
    gap: {
      first: { bootSequence: 1, sequence: 1 },
      last: { bootSequence: 1, sequence: 1 },
      count: 1,
    },
  });
  runtime.observe(null);
  journal.prune(Date.now());
  expect(db.prepare('SELECT confirmed_at FROM worker_observation_outbox').all()).toEqual([
    { confirmed_at: null },
  ]);
});

it('evicts actual telemetry at the fixed cap and protects the message awaiting broker confirmation', () => {
  const db = database();
  db.exec(`UPDATE worker_observation_state SET boot_sequence=1;
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100000)
    INSERT INTO worker_observation_outbox(message_id,boot_sequence,sequence,observed_at,type,body)
    SELECT 'fixture-'||i,1,i,1000+i,'worker.telemetry','{}' FROM n`);
  const journal = new WorkerObservabilityJournal(db);
  const runtime = createWorkerObservability('b-worker', journal, slots(journal));
  const inFlight = journal.peek()!;
  runtime.observe(null);
  const newest = db
    .prepare('SELECT body FROM worker_observation_outbox WHERE boot_sequence=2')
    .get();
  const message = JSON.parse(String(newest?.body)) as WorkerTelemetry;
  expect(message).toMatchObject({
    gap: {
      first: { bootSequence: 1, sequence: 2 },
      last: { bootSequence: 1, sequence: 2 },
      count: 1,
    },
  });
  expect(db.prepare('SELECT count(*) AS n FROM worker_observation_outbox').get()?.n).toBe(100000);
  expect(db.prepare('SELECT id FROM worker_observation_outbox WHERE id=1').get()?.id).toBe(
    inFlight.id,
  );
  journal.settled(inFlight.id, Date.now());
});

it('prioritizes a live snapshot while the older sequence still drains in order', () => {
  const db = database();
  const journal = new WorkerObservabilityJournal(db);
  const worker = createWorkerObservability('b-worker', journal, slots(journal));
  for (let i = 0; i < 2048; i++) worker.observe(null);
  const restarted = new WorkerObservabilityJournal(db);
  const current = createWorkerObservability('b-worker', restarted, slots(restarted));
  current.observe(null);
  const fresh = restarted.peek(true)!;
  expect(fresh.message).toMatchObject({ bootSequence: 2, sequence: 1 });
  restarted.settled(fresh.id, Date.now());
  expect(restarted.peek()?.message).toMatchObject({ bootSequence: 1, sequence: 1 });
});

it('retains only compact identities for confirmed frames and reuses SQLite payload space', () => {
  const db = database();
  const journal = new WorkerObservabilityJournal(db);
  const { bootSequence } = journal.boot();
  const hard = { total: 64, encode: 64, probe: 1 };
  const at = Date.now();
  const bootId = randomUUID();
  const active: WorkerTelemetry['active'] = Array.from({ length: 64 }, () => ({
    executionId: randomUUID(),
    protocol: 'transcode.v1',
    jobId: randomUUID(),
    attemptId: randomUUID(),
    inspectionId: null,
    resource: 'encode',
    slots: 1,
    acquiredAt: at,
  }));
  for (let sequence = 1; sequence <= 512; sequence++) {
    journal.telemetry({
      version: 1,
      type: 'worker.telemetry',
      messageId: randomUUID(),
      instanceId: 'b-worker',
      bootId,
      bootSequence,
      sequence,
      observedAt: at,
      limits: { hard, applied: hard, revision: 0 },
      usage: { total: 64, encode: 64, probe: 0 },
      active,
      waiting: empty,
      holds: { encode: [], probe: [] },
      event: null,
    });
    const pending = journal.peek()!;
    expect(pending.message.type).toBe('worker.telemetry');
    journal.settled(pending.id, at);
  }
  const retained = db
    .prepare('SELECT count(*) AS count,sum(length(body)) AS text FROM worker_observation_outbox')
    .get();
  const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count);
  const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size);
  expect(retained).toMatchObject({ count: 512, text: 1024 });
  expect(pageSize * pages).toBeLessThan(1024 * 1024);
});

it('protects an unconfirmed control receipt when the telemetry byte budget is exhausted', () => {
  const db = database();
  db.exec(`UPDATE worker_observation_state SET boot_sequence=1;
    INSERT INTO worker_observation_outbox(message_id,boot_sequence,sequence,observed_at,type,body,body_bytes)
    VALUES('fixture-control',1,1,1234,'worker.limits.result','{}',268435456)`);
  const journal = new WorkerObservabilityJournal(db);
  const worker = createWorkerObservability('b-worker', journal, slots(journal));
  expect(() => worker.observe(null)).not.toThrow();
  expect(() => worker.apply(command(1, empty))).toThrow('WORKER_OBSERVATION_OUTBOX_FULL');
  expect(journal.control().applied.revision).toBe(0);
  expect(db.prepare('SELECT message_id FROM worker_observation_outbox').all()).toEqual([
    { message_id: 'fixture-control' },
  ]);
});

it('stops a B observation cycle waiting on broker registration', async () => {
  const journal = new WorkerObservabilityJournal(database());
  const recorder = slots(journal);
  const runtime = createWorkerObservability('b-worker', journal, recorder);
  const stop = new AbortController();
  const entered = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  const close = vi.fn(async () => {});
  const started = runWorkerObservability(
    'b-worker',
    journal,
    recorder,
    runtime,
    async () => ({
      async consumeWorkerControl() {
        entered.resolve();
        return blocked.promise;
      },
      async publishWorker() {},
      closed: () => blocked.promise,
      close,
    }),
    stop.signal,
  );
  await entered.promise;
  stop.abort();
  await started;
  expect(close).toHaveBeenCalledOnce();
}, 1000);
