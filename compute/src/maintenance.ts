import type { Broker } from './adapters/rabbitmq.ts';
import type { Worker } from './worker.ts';

type MaintenanceBroker = Pick<Broker, 'consuming' | 'pause' | 'consume'>;
type MaintenanceWorker = Pick<
  Worker,
  'handle' | 'handleVideoProbe' | 'admissionReady' | 'needsMaintenance' | 'reconcileOne'
>;

/** One serial maintenance window for this worker's consumer and journal. */
export class Maintenance {
  readonly #broker: MaintenanceBroker;
  readonly #worker: MaintenanceWorker;
  readonly #failed: (error: unknown) => void;
  #active = true;
  #parallelSubscribed = false;
  readonly #buffered: boolean;
  #flight: Promise<void> | null = null;

  constructor(
    broker: MaintenanceBroker,
    worker: MaintenanceWorker,
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
    const handleProbe = this.#worker.handleVideoProbe.bind(this.#worker);
    if (this.#buffered) {
      // Waiting deliveries cannot drain while paused at zero; reconcile different attempts in place.
      await this.#worker.reconcileOne();
      if (this.#active && !this.#parallelSubscribed) {
        await this.#broker.consume(
          (command, ack) => this.#worker.handle(command, ack, true),
          this.#failed,
          undefined,
          handleProbe,
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
    if (this.#active && (this.#worker.admissionReady() || this.#worker.admissionReady('probe'))) {
      await this.#broker.consume(
        (command, ack) => this.#worker.handle(command, ack),
        this.#failed,
        (command) =>
          this.#worker.admissionReady(command.type === 'video.probe' ? 'probe' : 'encode'),
        handleProbe,
      );
    }
  }
}
