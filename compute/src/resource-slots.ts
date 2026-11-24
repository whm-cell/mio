import { parseWorkerLimits, WORKER_DEFAULT_LIMITS } from '@mio/compute-contracts';
import type { WorkerLimits, WorkerResourceClass } from '@mio/compute-contracts';

interface Waiter {
  resource: WorkerResourceClass;
  outputRecovery: boolean;
  admit: (release: () => void) => void;
}

/** Count admission once per execution, with class-specific HOLD and idempotent release. */
export class ResourceSlots {
  readonly #limits: WorkerLimits;
  readonly #usage = { encode: 0, probe: 0 };
  readonly #holds = { encode: new Set<string>(), probe: new Set<string>() };
  readonly #waiting = new Set<Waiter>();

  constructor(limits = WORKER_DEFAULT_LIMITS) {
    this.#limits = parseWorkerLimits(limits);
    if (
      limits.total < WORKER_DEFAULT_LIMITS.total ||
      limits.encode < WORKER_DEFAULT_LIMITS.encode ||
      limits.probe < WORKER_DEFAULT_LIMITS.probe
    )
      throw new Error('WORKER_HARD_LIMIT_INVALID');
  }

  available(resource: WorkerResourceClass): boolean {
    return this.#holds[resource].size === 0 && this.#hasCapacity(resource);
  }

  #hasCapacity(resource: WorkerResourceClass): boolean {
    return (
      this.#usage.encode + this.#usage.probe < this.#limits.total &&
      this.#usage[resource] < this.#limits[resource]
    );
  }

  setHold(resource: WorkerResourceClass, identity: string, blocked: boolean): void {
    if (blocked) this.#holds[resource].add(identity);
    else if (this.#holds[resource].delete(identity)) this.#drain();
  }

  acquire(resource: WorkerResourceClass): (() => void) | null {
    return this.available(resource) ? this.#take(resource) : null;
  }

  /** Reserve capacity to reconcile existing output of an old attempt without running FFmpeg. */
  acquireOutputRecovery(resource: WorkerResourceClass): (() => void) | null {
    return this.#hasCapacity(resource) ? this.#take(resource) : null;
  }

  #take(resource: WorkerResourceClass): () => void {
    this.#usage[resource]++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#usage[resource]--;
      this.#drain();
    };
  }

  wait(resource: WorkerResourceClass, signal: AbortSignal): Promise<() => void> {
    return this.#wait(resource, signal, false);
  }

  waitForOutputRecovery(resource: WorkerResourceClass, signal: AbortSignal): Promise<() => void> {
    return this.#wait(resource, signal, true);
  }

  #wait(
    resource: WorkerResourceClass,
    signal: AbortSignal,
    outputRecovery: boolean,
  ): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const release = outputRecovery ? this.acquireOutputRecovery(resource) : this.acquire(resource);
    if (release) return Promise.resolve(release);
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#waiting.delete(waiter);
        reject(signal.reason);
      };
      const waiter: Waiter = {
        resource,
        outputRecovery,
        admit: (release) => {
          signal.removeEventListener('abort', abort);
          resolve(release);
        },
      };
      this.#waiting.add(waiter);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  #drain(): void {
    for (const waiter of this.#waiting) {
      const release = waiter.outputRecovery
        ? this.acquireOutputRecovery(waiter.resource)
        : this.acquire(waiter.resource);
      if (release) {
        this.#waiting.delete(waiter);
        waiter.admit(release);
      }
    }
  }
}
