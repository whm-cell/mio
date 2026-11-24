import { boundedJson } from './json-payload.ts';
import { mediaEnum, mediaUuid } from './media-validation.ts';

export const WORKER_TELEMETRY_QUEUE = 'mio.compute.worker.telemetry';
export const WORKER_TELEMETRY_ROUTING_KEY = 'worker.telemetry';
const WORKER_CONTROL_ROUTING_PREFIX = 'worker.limits.command.';
export const WORKER_MAX_MESSAGE_BYTES = 64 * 1024;

export type WorkerResourceClass = 'encode' | 'probe';
export interface WorkerLimits {
  total: number;
  encode: number;
  probe: number;
}
export interface WorkerExecutionIdentity {
  executionId: string;
  protocol: 'transcode.v1' | 'audio.inspect.v1' | 'media';
  jobId: string;
  attemptId: string | null;
  inspectionId: string | null;
  resource: WorkerResourceClass;
  slots: 1;
}
export interface WorkerActiveExecution extends WorkerExecutionIdentity {
  acquiredAt: number;
}
export type WorkerExecutionPhase = 'downloading' | 'processing' | 'uploading' | 'finalizing';
export interface WorkerTelemetryGap {
  first: { bootSequence: number; sequence: number; at: number };
  last: { bootSequence: number; sequence: number; at: number };
  count: number;
}
export type WorkerTelemetryEvent =
  | { kind: 'phase'; phase: WorkerExecutionPhase; at: number; execution: WorkerExecutionIdentity }
  | {
      kind: 'execution';
      state: 'queued' | 'acquired' | 'released' | 'cancelled';
      at: number;
      execution: WorkerExecutionIdentity;
    }
  | {
      kind: 'hold';
      state: 'blocked' | 'unblocked';
      at: number;
      resource: WorkerResourceClass;
      identity: string;
    }
  | { kind: 'limits'; state: 'applied'; at: number; limits: WorkerLimits };
export interface WorkerTelemetry {
  version: 1;
  type: 'worker.telemetry';
  messageId: string;
  instanceId: string;
  bootId: string;
  bootSequence: number;
  sequence: number;
  observedAt: number;
  limits: { hard: WorkerLimits; applied: WorkerLimits; revision: number };
  usage: { total: number; encode: number; probe: number };
  waiting: { total: number; encode: number; probe: number };
  holds: { encode: string[]; probe: string[] };
  active: WorkerActiveExecution[];
  event: WorkerTelemetryEvent | null;
  gap?: WorkerTelemetryGap;
}
export interface WorkerLimitsCommand {
  version: 1;
  type: 'worker.limits.command';
  messageId: string;
  instanceId: string;
  revision: number;
  requestedBy: string;
  requestedAt: number;
  limits: WorkerLimits;
}
export interface WorkerLimitsResult {
  version: 1;
  type: 'worker.limits.result';
  messageId: string;
  commandId: string;
  instanceId: string;
  bootId: string;
  bootSequence: number;
  sequence: number;
  observedAt: number;
  revision: number;
  status: 'applied' | 'rejected';
  reason: 'HARD_LIMIT_EXCEEDED' | 'INSTANCE_MISMATCH' | 'LIMITS_INVALID' | 'STALE_REVISION' | null;
  limits: WorkerLimits;
}

const instance = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const protocols = ['transcode.v1', 'audio.inspect.v1', 'media'] as const;
const executionStates = ['queued', 'acquired', 'released', 'cancelled'] as const;
const rejectionReasons = [
  'HARD_LIMIT_EXCEEDED',
  'INSTANCE_MISMATCH',
  'LIMITS_INVALID',
  'STALE_REVISION',
] as const;
export const WORKER_DEFAULT_LIMITS: Readonly<WorkerLimits> = Object.freeze({
  total: 2,
  encode: 1,
  probe: 1,
});
function invalid(): never {
  throw new Error('WORKER_MESSAGE_INVALID');
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  try {
    return mediaEnum(value, values);
  } catch {
    return invalid();
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, expected: readonly string[]): void {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}
function id(value: unknown): string {
  try {
    return mediaUuid(value);
  } catch {
    return invalid();
  }
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    return invalid();
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value))
    return invalid();
  return value;
}
export function parseWorkerInstanceId(value: unknown): string {
  if (typeof value !== 'string' || /\s/.test(value) || !instance.test(value)) return invalid();
  return value;
}
export function parseWorkerLimits(value: unknown): WorkerLimits {
  const limits = object(value);
  fields(limits, ['total', 'encode', 'probe']);
  return {
    total: integer(limits.total),
    encode: integer(limits.encode),
    probe: integer(limits.probe),
  };
}
function resource(value: unknown): WorkerResourceClass {
  if (value !== 'encode' && value !== 'probe') return invalid();
  return value;
}
function execution(value: unknown): WorkerExecutionIdentity {
  const item = object(value);
  fields(item, [
    'executionId',
    'protocol',
    'jobId',
    'attemptId',
    'inspectionId',
    'resource',
    'slots',
  ]);
  const protocol = choice(item.protocol, protocols);
  const resourceClass = resource(item.resource);
  const attemptId = item.attemptId === null ? null : id(item.attemptId);
  const inspectionId = item.inspectionId === null ? null : id(item.inspectionId);
  if (protocol === 'audio.inspect.v1') {
    if (inspectionId === null || attemptId !== null || resourceClass !== 'probe') invalid();
  } else if (
    attemptId === null ||
    inspectionId !== null ||
    (protocol === 'transcode.v1' && resourceClass !== 'encode')
  )
    invalid();
  return {
    executionId: id(item.executionId),
    protocol,
    jobId: id(item.jobId),
    attemptId,
    inspectionId,
    resource: resourceClass,
    slots: item.slots === 1 ? 1 : invalid(),
  };
}
function event(value: unknown): WorkerTelemetryEvent | null {
  if (value === null) return null;
  const item = object(value);
  if (item.kind === 'execution') {
    fields(item, ['kind', 'state', 'at', 'execution']);
    return {
      kind: 'execution',
      state: choice(item.state, executionStates),
      at: integer(item.at, 1, 8.64e15),
      execution: execution(item.execution),
    };
  }
  if (item.kind === 'phase') {
    fields(item, ['kind', 'phase', 'at', 'execution']);
    return {
      kind: 'phase',
      phase: choice(item.phase, ['downloading', 'processing', 'uploading', 'finalizing'] as const),
      at: integer(item.at, 1, 8.64e15),
      execution: execution(item.execution),
    };
  }
  if (item.kind === 'hold') {
    fields(item, ['kind', 'state', 'at', 'resource', 'identity']);
    if (item.state !== 'blocked' && item.state !== 'unblocked') invalid();
    return {
      kind: 'hold',
      state: item.state,
      at: integer(item.at, 1, 8.64e15),
      resource: resource(item.resource),
      identity: text(item.identity, 256),
    };
  }
  if (item.kind === 'limits') {
    fields(item, ['kind', 'state', 'at', 'limits']);
    if (item.state !== 'applied') invalid();
    return {
      kind: 'limits',
      state: 'applied',
      at: integer(item.at, 1, 8.64e15),
      limits: parseWorkerLimits(item.limits),
    };
  }
  return invalid();
}
function envelope(value: Record<string, unknown>, type: string) {
  if (value.version !== 1 || value.type !== type) invalid();
  return {
    messageId: id(value.messageId),
    instanceId: parseWorkerInstanceId(value.instanceId),
    bootId: id(value.bootId),
    bootSequence: integer(value.bootSequence, 1),
    sequence: integer(value.sequence, 1),
    observedAt: integer(value.observedAt, 1, 8.64e15),
  };
}
function telemetryGap(value: unknown, bootSequence: number, sequence: number): WorkerTelemetryGap {
  const item = object(value);
  fields(item, ['first', 'last', 'count']);
  const position = (value: unknown) => {
    const point = object(value);
    fields(point, ['bootSequence', 'sequence', 'at']);
    return {
      bootSequence: integer(point.bootSequence, 1),
      sequence: integer(point.sequence, 1),
      at: integer(point.at, 1, 8.64e15),
    };
  };
  const first = position(item.first),
    last = position(item.last);
  const count = integer(item.count, 1);
  const ordered =
    first.bootSequence < last.bootSequence ||
    (first.bootSequence === last.bootSequence && first.sequence <= last.sequence);
  if (
    !ordered ||
    last.bootSequence > bootSequence ||
    (last.bootSequence === bootSequence && last.sequence >= sequence) ||
    (first.bootSequence === last.bootSequence && count > last.sequence - first.sequence + 1)
  )
    invalid();
  return { first, last, count };
}

export function parseWorkerTelemetry(value: unknown): WorkerTelemetry {
  const message = object(boundedJson(value, WORKER_MAX_MESSAGE_BYTES, invalid));
  fields(message, [
    'version',
    'type',
    'messageId',
    'instanceId',
    'bootId',
    'bootSequence',
    'sequence',
    'observedAt',
    'limits',
    'usage',
    'waiting',
    'holds',
    'active',
    'event',
    ...(Object.hasOwn(message, 'gap') ? ['gap'] : []),
  ]);
  const base = envelope(message, 'worker.telemetry');
  const limits = object(message.limits);
  fields(limits, ['hard', 'applied', 'revision']);
  const hard = parseWorkerLimits(limits.hard);
  if (
    hard.total < WORKER_DEFAULT_LIMITS.total ||
    hard.encode < WORKER_DEFAULT_LIMITS.encode ||
    hard.probe < WORKER_DEFAULT_LIMITS.probe
  )
    invalid();
  const applied = parseWorkerLimits(limits.applied);
  if (applied.total > hard.total || applied.encode > hard.encode || applied.probe > hard.probe)
    invalid();
  const metric = (value: unknown) => {
    const item = object(value);
    fields(item, ['total', 'encode', 'probe']);
    const parsed = {
      total: integer(item.total),
      encode: integer(item.encode),
      probe: integer(item.probe),
    };
    if (parsed.total !== parsed.encode + parsed.probe) invalid();
    return parsed;
  };
  const holds = object(message.holds);
  fields(holds, ['encode', 'probe']);
  const holdList = (input: unknown) => {
    if (!Array.isArray(input) || input.length > 1024 || input.includes(undefined)) return invalid();
    const values = input.map((item) => text(item, 256));
    if (new Set(values).size !== values.length) invalid();
    return values;
  };
  if (
    !Array.isArray(message.active) ||
    message.active.length > hard.total ||
    message.active.includes(undefined)
  )
    invalid();
  const active = message.active.map((value) => {
    const item = object(value);
    fields(item, [
      'executionId',
      'protocol',
      'jobId',
      'attemptId',
      'inspectionId',
      'resource',
      'slots',
      'acquiredAt',
    ]);
    return {
      ...execution({
        executionId: item.executionId,
        protocol: item.protocol,
        jobId: item.jobId,
        attemptId: item.attemptId,
        inspectionId: item.inspectionId,
        resource: item.resource,
        slots: item.slots,
      }),
      acquiredAt: integer(item.acquiredAt, 1, 8.64e15),
    };
  });
  const usage = metric(message.usage);
  const encode = active.filter((item) => item.resource === 'encode').length;
  if (
    usage.encode > hard.encode ||
    usage.probe > hard.probe ||
    usage.total !== active.length ||
    usage.encode !== encode ||
    usage.probe !== active.length - encode ||
    new Set(active.map((item) => item.executionId)).size !== active.length
  )
    invalid();
  return {
    version: 1,
    type: 'worker.telemetry',
    ...base,
    limits: { hard, applied, revision: integer(limits.revision) },
    usage,
    waiting: metric(message.waiting),
    holds: { encode: holdList(holds.encode), probe: holdList(holds.probe) },
    active,
    event: event(message.event),
    ...(Object.hasOwn(message, 'gap')
      ? { gap: telemetryGap(message.gap, base.bootSequence, base.sequence) }
      : {}),
  };
}
export function parseWorkerLimitsCommand(value: unknown): WorkerLimitsCommand {
  const message = object(boundedJson(value, WORKER_MAX_MESSAGE_BYTES, invalid));
  fields(message, [
    'version',
    'type',
    'messageId',
    'instanceId',
    'revision',
    'requestedBy',
    'requestedAt',
    'limits',
  ]);
  if (message.version !== 1 || message.type !== 'worker.limits.command') invalid();
  return {
    version: 1,
    type: 'worker.limits.command',
    messageId: id(message.messageId),
    instanceId: parseWorkerInstanceId(message.instanceId),
    revision: integer(message.revision, 1),
    requestedBy: text(message.requestedBy, 128),
    requestedAt: integer(message.requestedAt, 1, 8.64e15),
    limits: parseWorkerLimits(message.limits),
  };
}
export function parseWorkerLimitsResult(value: unknown): WorkerLimitsResult {
  const message = object(boundedJson(value, WORKER_MAX_MESSAGE_BYTES, invalid));
  fields(message, [
    'version',
    'type',
    'messageId',
    'commandId',
    'instanceId',
    'bootId',
    'bootSequence',
    'sequence',
    'observedAt',
    'revision',
    'status',
    'reason',
    'limits',
  ]);
  const base = envelope(message, 'worker.limits.result');
  if (message.status !== 'applied' && message.status !== 'rejected') invalid();
  const reason =
    message.status === 'applied'
      ? message.reason === null
        ? null
        : invalid()
      : choice(message.reason, rejectionReasons);
  return {
    version: 1,
    type: 'worker.limits.result',
    ...base,
    commandId: id(message.commandId),
    revision: integer(message.revision, 1),
    status: message.status,
    reason,
    limits: parseWorkerLimits(message.limits),
  };
}
export function workerControlQueue(instanceId: string): string {
  return `mio.compute.worker.control.${parseWorkerInstanceId(instanceId)}`;
}
export function workerControlRoutingKey(instanceId: string): string {
  return WORKER_CONTROL_ROUTING_PREFIX + parseWorkerInstanceId(instanceId);
}

/** Exact, bounded deployment allowlist shared by topology and the A-side observer. */
export function parseWorkerInstanceIds(value: string | undefined): string[] {
  if (value === undefined) return [];
  if (value.length > 64 * 97) return invalid();
  const ids = value.split(',').map((item) => parseWorkerInstanceId(item.trim()));
  if (ids.length > 64 || new Set(ids).size !== ids.length) return invalid();
  return ids;
}
