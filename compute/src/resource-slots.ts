import { parseWorkerLimits, WORKER_DEFAULT_LIMITS } from '@mio/compute-contracts';
import { createLogger } from '@mio/foundation/logging';
import { epochMs } from '@mio/foundation/time';
import type {
  WorkerActiveExecution,
  WorkerExecutionIdentity,
  WorkerExecutionPhase,
  WorkerLimits,
  WorkerResourceClass,
  WorkerTelemetryEvent,
} from '@mio/compute-contracts';

const log = createLogger('worker', 'resource-slots');

interface Waiter {
  resource: WorkerResourceClass;
  outputRecovery: boolean;
  execution: WorkerExecutionIdentity | undefined;
  admit: (release: () => void) => void;
}

/** One admission pool accounts for real execution across the three compute protocols. */
export class ResourceSlots {
  readonly #hard: WorkerLimits;
  #limits: WorkerLimits;
  readonly #usage = { encode: 0, probe: 0 };
  readonly #holds = { encode: new Set<string>(), probe: new Set<string>() };
  readonly #waiting = new Set<Waiter>();
  readonly #active = new Map<string, WorkerActiveExecution>();
  readonly #observers = new Set<(event: WorkerTelemetryEvent) => void>();

  constructor(limits = WORKER_DEFAULT_LIMITS) {
    this.#hard = parseWorkerLimits(limits);
    this.#limits = this.#hard;
    if (
      limits.total < WORKER_DEFAULT_LIMITS.total ||
      limits.encode < WORKER_DEFAULT_LIMITS.encode ||
      limits.probe < WORKER_DEFAULT_LIMITS.probe
    )
      throw new Error('WORKER_HARD_LIMIT_INVALID');
  }

  subscribe(observe: (event: WorkerTelemetryEvent) => void): () => void {
    this.#observers.add(observe);
    return () => this.#observers.delete(observe);
  }

  #notify(event: WorkerTelemetryEvent): void {
    for (const observe of this.#observers) {
      try {
        observe(event);
      } catch {
        log.error('WORKER_SLOT_OBSERVATION_FAILED');
      }
    }
  }

  snapshot() {
    let encode = 0;
    for (const waiter of this.#waiting) if (waiter.resource === 'encode') encode++;
    return {
      hard: this.#hard,
      applied: this.#limits,
      usage: { total: this.#usage.encode + this.#usage.probe, ...this.#usage },
      waiting: { total: this.#waiting.size, encode, probe: this.#waiting.size - encode },
      holds: { encode: [...this.#holds.encode], probe: [...this.#holds.probe] },
      active: [...this.#active.values()],
    };
  }

  setLimits(limits: WorkerLimits): void {
    const next = parseWorkerLimits(limits);
    if (
      next.total > this.#hard.total ||
      next.encode > this.#hard.encode ||
      next.probe > this.#hard.probe
    )
      throw new Error('WORKER_HARD_LIMIT_EXCEEDED');
    this.#limits = next;
    this.#drain();
  }

  phase(executionId: string, phase: WorkerExecutionPhase): void {
    const active = this.#active.get(executionId);
    if (!active) return;
    const { acquiredAt: _acquiredAt, ...execution } = active;
    void _acquiredAt;
    this.#notify({ kind: 'phase', phase, at: epochMs(), execution });
  }

  available(resource: WorkerResourceClass): boolean {
    return this.#canTake(resource, false);
  }

  #canTake(resource: WorkerResourceClass, outputRecovery: boolean): boolean {
    return (
      (outputRecovery || this.#holds[resource].size === 0) &&
      this.#usage.encode + this.#usage.probe < this.#limits.total &&
      this.#usage[resource] < this.#limits[resource]
    );
  }

  setHold(resource: WorkerResourceClass, identity: string, blocked: boolean): void {
    const holds = this.#holds[resource];
    if (blocked === holds.has(identity)) return;
    if (blocked) holds.add(identity);
    else holds.delete(identity);
    this.#notify({
      kind: 'hold',
      state: blocked ? 'blocked' : 'unblocked',
      at: epochMs(),
      resource,
      identity,
    });
    if (!blocked) this.#drain();
  }

  acquire(resource: WorkerResourceClass, execution?: WorkerExecutionIdentity): (() => void) | null {
    return this.available(resource) ? this.#take(resource, execution) : null;
  }

  /** Reserve capacity to reconcile existing output of an old attempt without running FFmpeg. */
  acquireOutputRecovery(
    resource: WorkerResourceClass,
    execution?: WorkerExecutionIdentity,
  ): (() => void) | null {
    return this.#canTake(resource, true) ? this.#take(resource, execution) : null;
  }

  #take(resource: WorkerResourceClass, execution?: WorkerExecutionIdentity): () => void {
    if (execution && (this.#active.has(execution.executionId) || execution.resource !== resource))
      throw new Error('WORKER_EXECUTION_SLOT_CONFLICT');
    this.#usage[resource]++;
    if (execution) {
      const at = epochMs();
      this.#active.set(execution.executionId, { ...execution, acquiredAt: at });
      this.#notify({ kind: 'execution', state: 'acquired', at, execution });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#usage[resource]--;
      if (execution) {
        this.#active.delete(execution.executionId);
        this.#notify({ kind: 'execution', state: 'released', at: epochMs(), execution });
      }
      this.#drain();
    };
  }

  wait(
    resource: WorkerResourceClass,
    signal: AbortSignal,
    execution?: WorkerExecutionIdentity,
  ): Promise<() => void> {
    return this.#wait(resource, signal, false, execution);
  }

  waitForOutputRecovery(
    resource: WorkerResourceClass,
    signal: AbortSignal,
    execution?: WorkerExecutionIdentity,
  ): Promise<() => void> {
    return this.#wait(resource, signal, true, execution);
  }

  #wait(
    resource: WorkerResourceClass,
    signal: AbortSignal,
    outputRecovery: boolean,
    execution: WorkerExecutionIdentity | undefined,
  ): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#canTake(resource, outputRecovery))
      return Promise.resolve(this.#take(resource, execution));
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#waiting.delete(waiter);
        if (execution)
          this.#notify({ kind: 'execution', state: 'cancelled', at: epochMs(), execution });
        reject(signal.reason);
      };
      const waiter: Waiter = {
        resource,
        outputRecovery,
        execution,
        admit: (release) => {
          signal.removeEventListener('abort', abort);
          resolve(release);
        },
      };
      this.#waiting.add(waiter);
      signal.addEventListener('abort', abort, { once: true });
      if (execution) this.#notify({ kind: 'execution', state: 'queued', at: epochMs(), execution });
    });
  }

  #drain(): void {
    for (const waiter of this.#waiting) {
      if (this.#canTake(waiter.resource, waiter.outputRecovery)) {
        this.#waiting.delete(waiter);
        waiter.admit(this.#take(waiter.resource, waiter.execution));
      }
    }
  }
}
