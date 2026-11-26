import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  parseWorkerInstanceIds,
  parseWorkerLimitsCommand,
  parseWorkerLimitsResult,
  parseWorkerTelemetry,
  WORKER_DEFAULT_LIMITS,
  WORKER_MAX_MESSAGE_BYTES,
  workerControlQueue,
} from '@mio/compute-contracts';

const instanceId = `mio-test-${'0'.repeat(64)}`;
const envelope = { version: 1, messageId: randomUUID(), instanceId };
const observation = { bootId: randomUUID(), bootSequence: 2, sequence: 3, observedAt: 100 };
const active = {
  executionId: randomUUID(),
  protocol: 'audio.inspect.v1',
  resource: 'probe',
  jobId: randomUUID(),
  inspectionId: randomUUID(),
  attemptId: null,
  slots: 1,
  acquiredAt: 90,
};

it('validates boot and execution identity, hard limits and telemetry counts on the raw wire', () => {
  const message = {
    ...envelope,
    ...observation,
    type: 'worker.telemetry',
    limits: {
      hard: { total: 2, encode: 3, probe: 3 },
      applied: { total: 0, encode: 3, probe: 0 },
      revision: 1,
    },
    usage: { total: 1, encode: 0, probe: 1 },
    waiting: { total: 0, encode: 0, probe: 0 },
    holds: { encode: [], probe: [] },
    active: [active],
    event: null,
  };
  expect(parseWorkerTelemetry(Buffer.from(JSON.stringify(message)))).toEqual(message);
  const videoProbe = {
    ...active,
    protocol: 'video.probe.v1',
    attemptId: randomUUID(),
    inspectionId: null,
  };
  expect(parseWorkerTelemetry({ ...message, active: [videoProbe] }).active).toEqual([videoProbe]);
  for (const changes of [
    { version: 2 },
    { bootId: undefined },
    { bootSequence: 0 },
    { sequence: 0 },
    { active: [{ ...active, protocol: [active.protocol] }] },
    { active: [{ ...active, inspectionId: null, attemptId: randomUUID() }] },
    { active: [{ ...active, resource: 'encode' }] },
    { active: [{ ...videoProbe, resource: 'encode' }], usage: { total: 1, encode: 1, probe: 0 } },
    { active: [{ ...videoProbe, attemptId: null }] },
    { active: [{ ...videoProbe, inspectionId: randomUUID() }] },
    { active: [active, active], usage: { total: 2, encode: 0, probe: 2 } },
    { active: [] },
    { holds: { encode: ['one', 'one'], probe: [] } },
    { event: { kind: 'execution', at: 99, state: ['acquired'], execution: active } },
  ])
    expect(() => parseWorkerTelemetry({ ...message, ...changes })).toThrow(
      'WORKER_MESSAGE_INVALID',
    );
  const anotherProbe = { ...active, executionId: randomUUID(), inspectionId: randomUUID() };
  const twoProbes = {
    ...message,
    active: [active, anotherProbe],
    usage: { total: 2, encode: 0, probe: 2 },
  };
  expect(parseWorkerTelemetry(twoProbes).usage.probe).toBe(2);
  expect(() =>
    parseWorkerTelemetry({
      ...twoProbes,
      limits: { ...twoProbes.limits, hard: { total: 2, encode: 3, probe: 1 } },
    }),
  ).toThrow('WORKER_MESSAGE_INVALID');
  const padded = JSON.stringify(message).padEnd(WORKER_MAX_MESSAGE_BYTES);
  expect(parseWorkerTelemetry(Buffer.from(padded)).active).toEqual([active]);
  expect(() => parseWorkerTelemetry(Buffer.from(padded + ' '))).toThrow('WORKER_MESSAGE_INVALID');
});

it('checks exact instances, config revisions, and result reason discriminants', () => {
  expect(parseWorkerInstanceIds(`${instanceId}, worker.b`)).toEqual([instanceId, 'worker.b']);
  expect(workerControlQueue(instanceId)).toBe(`mio.compute.worker.control.${instanceId}`);
  for (const ids of ['worker.a,worker.a', 'worker.*', 'worker,a/b', 'worker,', ''])
    expect(() => parseWorkerInstanceIds(ids)).toThrow('WORKER_MESSAGE_INVALID');
  const command = {
    ...envelope,
    type: 'worker.limits.command',
    revision: 2,
    requestedBy: 'operator-id',
    requestedAt: 100,
    limits: { total: 1, encode: 4, probe: 0 },
  };
  expect(parseWorkerLimitsCommand(command)).toEqual(command);
  expect(() => parseWorkerLimitsCommand({ ...command, revision: 0 })).toThrow(
    'WORKER_MESSAGE_INVALID',
  );
  expect(() => parseWorkerLimitsCommand({ ...command, instanceId: 'worker\n' })).toThrow(
    'WORKER_MESSAGE_INVALID',
  );
  const result = {
    ...envelope,
    ...observation,
    type: 'worker.limits.result',
    commandId: command.messageId,
    revision: command.revision,
    status: 'rejected',
    reason: 'STALE_REVISION',
    limits: WORKER_DEFAULT_LIMITS,
  };
  expect(parseWorkerLimitsResult(result)).toEqual(result);
  expect(parseWorkerLimitsResult({ ...result, reason: 'INSTANCE_MISMATCH' }).reason).toBe(
    'INSTANCE_MISMATCH',
  );
  expect(parseWorkerLimitsResult({ ...result, status: 'applied', reason: null }).reason).toBeNull();
  expect(() => parseWorkerLimitsResult({ ...result, status: 'applied' })).toThrow(
    'WORKER_MESSAGE_INVALID',
  );
  expect(() => parseWorkerLimitsResult({ ...result, reason: ['STALE_REVISION'] })).toThrow(
    'WORKER_MESSAGE_INVALID',
  );
});

it('accepts optional durable loss ranges and phase events while retaining the original wire shape', () => {
  const { acquiredAt: _at, ...execution } = active;
  void _at;
  const base = {
    ...envelope,
    ...observation,
    type: 'worker.telemetry',
    limits: { hard: WORKER_DEFAULT_LIMITS, applied: WORKER_DEFAULT_LIMITS, revision: 0 },
    usage: { total: 1, encode: 0, probe: 1 },
    waiting: { total: 0, encode: 0, probe: 0 },
    holds: { encode: [], probe: [] },
    active: [active],
    event: null,
  };
  expect(parseWorkerTelemetry(base)).toEqual(base);
  const gap = {
    first: { bootSequence: 2, sequence: 1, at: 40 },
    last: { bootSequence: 2, sequence: 2, at: 50 },
    count: 2,
  };
  expect(
    parseWorkerTelemetry({
      ...base,
      gap,
      event: { kind: 'phase', phase: 'processing', at: 98, execution },
    }),
  ).toMatchObject({
    gap,
    event: { kind: 'phase', phase: 'processing', execution },
  });
  for (const invalid of [
    { ...gap, count: 0 },
    { ...gap, count: 3 },
    { ...gap, first: gap.last, last: gap.first },
    { ...gap, last: { ...gap.last, sequence: 3 } },
    { ...gap, last: { ...gap.last, bootSequence: 3 } },
  ])
    expect(() => parseWorkerTelemetry({ ...base, gap: invalid })).toThrow('WORKER_MESSAGE_INVALID');
  expect(() =>
    parseWorkerTelemetry({
      ...base,
      event: { kind: 'phase', phase: 'arbitrary', at: 98, execution },
    }),
  ).toThrow('WORKER_MESSAGE_INVALID');
});
