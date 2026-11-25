import type { Broker } from './adapters/rabbitmq.ts';
import type { Worker } from './worker.ts';

/** One serial maintenance window for this worker's consumer and journal. */
export class Maintenance {
  readonly #broker: Pick<Broker, 'consuming' | 'pause' | 'consume'> &
    Partial<Pick<Broker, 'consumeTranscodes'>>;
  readonly #worker: Pick<Worker, 'handle' | 'admissionReady' | 'needsMaintenance' | 'reconcileOne'>;
  readonly #failed: (error: unknown) => void;
  #active = true;
  #parallelSubscribed = false;
  readonly #buffered: boolean;
  #flight: Promise<void> | null = null;

  constructor(
    broker: Pick<Broker, 'consuming' | 'pause' | 'consume'> &
      Partial<Pick<Broker, 'consumeTranscodes'>>,
    worker: Pick<Worker, 'handle' | 'admissionReady' | 'needsMaintenance' | 'reconcileOne'>,
    failed: (error: unknown) => void,
    buffered = false,
  ) {
    this.#broker = broker;
    this.#worker = worker;
    this.#failed = failed;
    this.#buffered = buffered;
  }

  tick(): Promise<void> {
    if (this.#flight) return this.#flight;
    const flight = this.#run().finally(() => {
      if (this.#flight === flight) this.#flight = null;
    });
    this.#flight = flight;
    return flight;
  }

  stop(): void {
    this.#active = false;
  }

  async wait(): Promise<void> {
    if (this.#flight) await this.#flight;
  }

  async #run(): Promise<void> {
    if (!this.#active) return;
    if (this.#buffered) {
      // Waiting deliveries cannot drain while paused at zero; reconcile different attempts in place.
      await this.#worker.reconcileOne();
      if (this.#active && !this.#parallelSubscribed) {
        await this.#broker.consumeTranscodes!(
          (command, ack) => this.#worker.handle(command, ack, true),
          this.#failed,
        );
        this.#parallelSubscribed = true;
      }
      return;
    }
    const needsCycle = !this.#broker.consuming || this.#worker.needsMaintenance();
    if (!needsCycle) return;
    await this.#broker.pause();
    if (!this.#active) return;
    await this.#worker.reconcileOne();
    if (this.#active && this.#worker.admissionReady()) {
      await this.#broker.consume(
        (command, ack) => this.#worker.handle(command, ack),
        this.#failed,
        () => this.#worker.admissionReady(),
      );
    }
  }
}
