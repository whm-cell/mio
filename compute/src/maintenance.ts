import type { Broker } from './adapters/rabbitmq.ts';
import type { Worker } from './worker.ts';

/** One serial maintenance window for this worker's consumer and journal. */
export class Maintenance {
  readonly #broker: Pick<Broker, 'consuming' | 'pause' | 'consume'> &
    Partial<Pick<Broker, 'imageConsuming' | 'imageClosing' | 'consumeImages'>>;
  readonly #worker: Pick<Worker, 'handle' | 'admissionReady' | 'needsMaintenance' | 'reconcileOne'>;
  readonly #failed: (error: unknown) => void;
  readonly #imageRetryMs: number;
  #active = true;
  #initialReconciled = false;
  #flight: Promise<void> | null = null;
  #imageFlight: Promise<void> | null = null;
  #imageRetryTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly imageHandle: Parameters<Broker['consume']>[3];
  constructor(
    broker: Pick<Broker, 'consuming' | 'pause' | 'consume'> &
      Partial<Pick<Broker, 'imageConsuming' | 'imageClosing' | 'consumeImages'>>,
    worker: Pick<Worker, 'handle' | 'admissionReady' | 'needsMaintenance' | 'reconcileOne'>,
    failed: (error: unknown) => void,
    imageHandle?: Parameters<Broker['consume']>[3],
    imageRetryMs = 1000,
  ) {
    this.#broker = broker;
    this.#worker = worker;
    this.#failed = failed;
    this.imageHandle = imageHandle;
    this.#imageRetryMs = imageRetryMs;
  }

  tick(): Promise<void> {
    if (this.#flight) {
      if (this.#initialReconciled) void this.#ensureImages().catch(this.#failed);
      return this.#flight;
    }
    let resolve: () => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const result = new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    const flight = result.finally(() => {
      if (this.#flight === flight) this.#flight = null;
    });
    this.#flight = flight;
    void this.#run().then(resolve, reject);
    return flight;
  }

  stop(): void {
    this.#active = false;
    if (this.#imageRetryTimer) {
      clearTimeout(this.#imageRetryTimer);
      this.#imageRetryTimer = null;
    }
  }

  async wait(): Promise<void> {
    if (this.#flight) await this.#flight;
    if (this.#imageFlight) await this.#imageFlight;
  }

  #scheduleImageRetry(): void {
    if (!this.#active || this.#imageRetryTimer) return;
    this.#imageRetryTimer = setTimeout(() => {
      this.#imageRetryTimer = null;
      if (!this.#active) return;
      void this.#ensureImages().catch(this.#failed);
    }, this.#imageRetryMs);
  }

  #ensureImages(): Promise<void> {
    if (this.#imageFlight) return this.#imageFlight;
    if (
      !this.#active ||
      !this.imageHandle ||
      !this.#broker.consumeImages ||
      this.#broker.imageConsuming ||
      this.#broker.imageClosing
    ) {
      return Promise.resolve();
    }
    const consumeImages = this.#broker.consumeImages.bind(this.#broker);
    const handle = this.imageHandle;
    const flight = consumeImages(handle, this.#failed, () => this.#scheduleImageRetry()).finally(
      () => {
        if (this.#imageFlight === flight) this.#imageFlight = null;
      },
    );
    this.#imageFlight = flight;
    return flight;
  }

  async #run(): Promise<void> {
    if (!this.#active) return;
    const videoNeedsCycle = !this.#broker.consuming || this.#worker.needsMaintenance();
    const imageRecovery = this.#initialReconciled ? this.#ensureImages() : null;
    if (videoNeedsCycle) {
      await this.#broker.pause();
      if (!this.#active) return;
      await this.#worker.reconcileOne();
    }
    this.#initialReconciled = true;
    if (imageRecovery) await imageRecovery;
    if (this.#active) {
      await this.#ensureImages();
    }
    if (videoNeedsCycle && this.#active && this.#worker.admissionReady()) {
      await this.#broker.consume(
        (command, ack) => this.#worker.handle(command, ack),
        this.#failed,
        () => this.#worker.admissionReady(),
        this.imageHandle,
      );
    }
  }
}
