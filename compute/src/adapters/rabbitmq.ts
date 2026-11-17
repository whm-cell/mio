import { connect } from 'amqplib';
import { createId } from '@mio/foundation/identifiers';
import { EventEmitter } from 'node:events';
import type { Channel, ChannelModel, ConfirmChannel, ConsumeMessage, Message } from 'amqplib';
import {
  COMMAND_QUEUE,
  COMPUTE_MAX_MESSAGE_BYTES,
  IMAGE_COMMAND_QUEUE,
  IMAGE_MAX_MESSAGE_BYTES,
  IMAGE_WORKER_PREFETCH,
  RESULT_EXCHANGE,
  RESULT_ROUTING_KEY,
  parseComputeCommandV1,
  parseImageCommand,
  parseImageQuery,
  parseImageRecovery,
} from '@mio/compute-contracts';
import type {
  ComputeCommandV1,
  ComputeResultV1,
  ImageCommandV1,
  ImageQueryCommandV1,
  ImageRecoveryCommandV1,
  ImageResultV1,
} from '@mio/compute-contracts';
import { isJournalFailure } from './journal.ts';

interface BrokerState {
  closed: boolean;
  events: EventEmitter;
  markClosed: () => void;
}
interface ConsumerSlot {
  channel: Channel;
  closing: boolean;
  closed: boolean;
  failed: boolean;
}
interface ConsumerGate {
  open: boolean;
  slot: ConsumerSlot;
}
type ImageCommand = ImageCommandV1 | ImageQueryCommandV1 | ImageRecoveryCommandV1;
type ImageHandler = (command: ImageCommand, ack: () => void) => Promise<void>;

async function closeConnection(
  connection: ChannelModel,
  closedConnections: WeakSet<ChannelModel>,
): Promise<void> {
  if (closedConnections.has(connection)) return;
  let onClose: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    onClose = resolve;
    connection.once('close', onClose);
  });
  try {
    let closing: Promise<void>;
    try {
      closing = connection.close();
    } catch {
      closing = closed;
    }
    // amqplib can emit close after a socket error without settling close(). Its
    // already-closed error also covers close before our listener was attached.
    await Promise.race([
      closing.catch((error: unknown) => {
        if (
          error instanceof Error &&
          error.name === 'IllegalOperationError' &&
          error.message.startsWith('Connection closed (')
        )
          return;
        return closed;
      }),
      closed,
    ]);
  } finally {
    connection.off('close', onClose);
  }
}

function watchConsumer(channel: Channel, state: BrokerState): ConsumerSlot {
  const slot = { channel, closing: false, closed: false, failed: false };
  channel.on('error', () => {
    slot.failed = true;
    if (!slot.closing) state.markClosed();
  });
  channel.once('close', () => {
    slot.closed = true;
    if (!slot.closing) state.markClosed();
  });
  return slot;
}

export class Broker {
  readonly #consumerConnection: ChannelModel;
  readonly #publisherConnection: ChannelModel;
  #consumer: ConsumerSlot | null;
  readonly #publisher: ConfirmChannel;
  readonly #userId: string;
  readonly #expectedUserId: string;
  readonly #state: BrokerState;
  readonly #closedConnections: WeakSet<ChannelModel>;
  #gate: ConsumerGate | null = null;
  #handling: Promise<void> | null = null;
  #pause: Promise<void> | null = null;
  #handlerFailure: unknown = null;
  #imageConsumer: ConsumerSlot | null = null;
  #imageGate: ConsumerGate | null = null;
  readonly #imageHandling = new Set<Promise<void>>();
  readonly #imageLocks = new Map<string, Promise<void>>();
  #imageClose: Promise<void> | null = null;

  private constructor(
    consumerConnection: ChannelModel,
    publisherConnection: ChannelModel,
    consumer: ConsumerSlot,
    publisher: ConfirmChannel,
    userId: string,
    expectedUserId: string,
    state: BrokerState,
    closedConnections: WeakSet<ChannelModel>,
  ) {
    this.#consumerConnection = consumerConnection;
    this.#publisherConnection = publisherConnection;
    this.#consumer = consumer;
    this.#publisher = publisher;
    this.#userId = userId;
    this.#expectedUserId = expectedUserId;
    this.#state = state;
    this.#closedConnections = closedConnections;
  }

  static async connect(url: string, userId: string, expectedUserId: string): Promise<Broker> {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'amqps:' &&
      !(
        parsed.protocol === 'amqp:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      )
    ) {
      throw new Error('BROKER_TLS_REQUIRED');
    }
    const state: BrokerState = { closed: false, events: new EventEmitter(), markClosed: () => {} };
    const markClosed = () => {
      if (!state.closed) {
        state.closed = true;
        state.events.emit('closed');
      }
    };
    state.markClosed = markClosed;
    const watch = (surface: ChannelModel | Channel) => {
      surface.on('error', markClosed);
      surface.once('close', markClosed);
    };
    const closedConnections = new WeakSet<ChannelModel>();
    const watchConnection = (surface: ChannelModel) => {
      surface.once('close', () => closedConnections.add(surface));
      watch(surface);
    };
    const consumerConnection = await connect(url);
    watchConnection(consumerConnection);
    try {
      const publisherConnection = await connect(url);
      watchConnection(publisherConnection);
      try {
        const consumer = await consumerConnection.createChannel();
        const slot = watchConsumer(consumer, state);
        const publisher = await publisherConnection.createConfirmChannel();
        watch(publisher);
        if (state.closed) throw new Error('BROKER_CLOSED');
        await consumer.prefetch(1);
        await publisher.prefetch(1);
        if (state.closed) throw new Error('BROKER_CLOSED');
        return new Broker(
          consumerConnection,
          publisherConnection,
          slot,
          publisher,
          userId,
          expectedUserId,
          state,
          closedConnections,
        );
      } catch (error) {
        await closeConnection(publisherConnection, closedConnections);
        throw error;
      }
    } catch (error) {
      await closeConnection(consumerConnection, closedConnections);
      throw error;
    }
  }

  publish(message: ComputeResultV1): Promise<void> {
    return this.publishMessage(message);
  }
  publishImage(message: ImageResultV1): Promise<void> {
    return this.publishMessage(message);
  }
  private async publishMessage(message: ComputeResultV1 | ImageResultV1): Promise<void> {
    if (this.#state.closed) throw new Error('BROKER_CLOSED');
    let returned = false;
    const onReturn = (result: Message) => {
      if (result.properties.messageId === message.messageId) returned = true;
    };
    this.#publisher.on('return', onReturn);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onDrain: (() => void) | undefined;
    let onClosed: (() => void) | undefined;
    try {
      let drain: Promise<void> = Promise.resolve();
      const closed = new Promise<never>((_resolve, reject) => {
        onClosed = () => reject(new Error('BROKER_CLOSED'));
        this.#state.events.once('closed', onClosed);
        if (this.#state.closed) onClosed();
      });
      const confirmation = new Promise<void>((resolve, reject) => {
        const writable = this.#publisher.publish(
          RESULT_EXCHANGE,
          RESULT_ROUTING_KEY,
          Buffer.from(JSON.stringify(message)),
          {
            persistent: true,
            mandatory: true,
            contentType: 'application/json',
            messageId: message.messageId,
            userId: this.#userId,
          },
          (error) =>
            error ? reject(error) : returned ? reject(new Error('MESSAGE_RETURNED')) : resolve(),
        );
        if (!writable)
          drain = new Promise<void>((drained) => {
            onDrain = drained;
            this.#publisher.once('drain', onDrain);
          });
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('CONFIRM_TIMEOUT')), 30_000);
      });
      await Promise.race([Promise.all([confirmation, drain]), timeout, closed]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onDrain) this.#publisher.off('drain', onDrain);
      if (onClosed) this.#state.events.off('closed', onClosed);
      this.#publisher.off('return', onReturn);
    }
  }

  #runImageSerial(jobId: string, run: () => Promise<void>): Promise<void> {
    const previous = this.#imageLocks.get(jobId) ?? Promise.resolve();
    const current = previous.then(run);
    const tracked = current
      .catch(() => {})
      .finally(() => {
        if (this.#imageLocks.get(jobId) === tracked) {
          this.#imageLocks.delete(jobId);
        }
      });
    this.#imageLocks.set(jobId, tracked);
    return current;
  }

  async consume(
    handle: (command: ComputeCommandV1, ack: () => void) => Promise<void>,
    failed: (error: unknown) => void,
    canAdmit: () => boolean,
    imageHandle?: ImageHandler,
  ): Promise<void> {
    if (this.#state.closed || this.#gate || this.#pause || this.#handling)
      throw new Error('BROKER_CONSUMER_BUSY');
    let slot = this.#consumer;
    if (!slot) {
      const channel = await this.#consumerConnection.createChannel();
      slot = watchConsumer(channel, this.#state);
      await channel.prefetch(1);
      if (this.#state.closed) throw new Error('BROKER_CLOSED');
      this.#consumer = slot;
    }
    const gate: ConsumerGate = { slot, open: true };
    this.#gate = gate;
    const report = (error: unknown) => {
      this.#handlerFailure = error;
      gate.open = false;
      failed(error);
    };
    await slot.channel.consume(
      COMMAND_QUEUE,
      (message: ConsumeMessage | null) => {
        // A closed gate leaves late deliveries unacked; closing this exact channel requeues them.
        // Late cancellation notifications from that channel also belong to the old consumer.
        if (!gate.open || this.#state.closed) return;
        if (!message) {
          report(new Error('CONSUMER_CANCELLED'));
          return;
        }
        try {
          if (this.#handling || !canAdmit()) {
            void this.pause().catch(report);
            return;
          }
        } catch (error) {
          report(error);
          return;
        }
        let command:
          ComputeCommandV1 | ImageCommandV1 | ImageQueryCommandV1 | ImageRecoveryCommandV1;
        try {
          if (
            message.properties.userId !== this.#expectedUserId ||
            message.properties.contentType !== 'application/json' ||
            message.content.length > IMAGE_MAX_MESSAGE_BYTES
          )
            throw new Error('COMMAND_INVALID');
          const body = new TextDecoder('utf-8', { fatal: true }).decode(message.content);
          const value: unknown = JSON.parse(body);
          command =
            value && typeof value === 'object' && 'type' in value && value.type === 'image.request'
              ? parseImageCommand(value)
              : value &&
                  typeof value === 'object' &&
                  'type' in value &&
                  value.type === 'image.query'
                ? parseImageQuery(value)
                : value &&
                    typeof value === 'object' &&
                    'type' in value &&
                    value.type === 'image.recover'
                  ? parseImageRecovery(value)
                  : parseComputeCommandV1(value);
          if (
            command.type === 'transcode.request' &&
            message.content.length > COMPUTE_MAX_MESSAGE_BYTES
          )
            throw new Error('COMMAND_INVALID');
          if (message.properties.messageId !== command.messageId)
            throw new Error('COMMAND_ID_MISMATCH');
        } catch {
          try {
            slot.channel.reject(message, false);
          } catch (error) {
            report(error);
          }
          return;
        }
        const tracked = Promise.resolve()
          .then(() => {
            if (
              command.type === 'image.request' ||
              command.type === 'image.query' ||
              command.type === 'image.recover'
            ) {
              if (!imageHandle) throw new Error('IMAGE_HANDLER_UNAVAILABLE');
              const runImage = imageHandle;
              const imageCommand = command;
              return this.#runImageSerial(imageCommand.jobId, async () => {
                if (!gate.open || this.#state.closed) return;
                await runImage(imageCommand, () => slot.channel.ack(message));
              });
            }
            return handle(command, () => slot.channel.ack(message));
          })
          .catch((error: unknown) => {
            const code = error instanceof Error ? error.message : '';
            if (
              code === 'ATTEMPT_CONFLICT' ||
              code === 'IMAGE_COMMAND_CONFLICT' ||
              code === 'IMAGE_QUERY_UNKNOWN'
            ) {
              try {
                slot.channel.reject(message, false);
              } catch (rejectError) {
                report(rejectError);
              }
            } else if (code === 'WORKER_NOT_READY') {
              void this.pause().catch(report);
            } else report(error);
          })
          .finally(() => {
            if (this.#handling === tracked) this.#handling = null;
          });
        this.#handling = tracked;
      },
      { noAck: false, consumerTag: `mio-${createId()}` },
    );
  }

  async consumeImages(
    handle: ImageHandler,
    failed: (error: unknown) => void,
    onRetry?: () => void,
  ): Promise<void> {
    if (this.#state.closed || this.#imageGate || this.#imageClose || this.#imageHandling.size > 0)
      throw new Error('BROKER_IMAGE_CONSUMER_BUSY');
    let slot = this.#imageConsumer;
    if (!slot) {
      const channel = await this.#consumerConnection.createChannel();
      slot = watchConsumer(channel, this.#state);
      await channel.prefetch(IMAGE_WORKER_PREFETCH);
      if (this.#state.closed || slot.closed || this.#imageClose) throw new Error('BROKER_CLOSED');
      this.#imageConsumer = slot;
    }
    const activeSlot = slot;
    const gate: ConsumerGate = { slot: activeSlot, open: true };
    this.#imageGate = gate;
    const report = (error: unknown) => {
      gate.open = false;
      failed(error);
    };
    const recycleImageChannel = () => {
      if (this.#state.closed) return;
      void this.closeImages().then(() => {
        if (this.#state.closed) return;
        if (activeSlot.failed) report(new Error('BROKER_CLOSED'));
        else onRetry?.();
      }, report);
    };
    await activeSlot.channel.consume(
      IMAGE_COMMAND_QUEUE,
      (message: ConsumeMessage | null) => {
        if (!gate.open || this.#state.closed) return;
        if (!message) {
          gate.open = false;
          if (this.#state.closed) report(new Error('CONSUMER_CANCELLED'));
          else recycleImageChannel();
          return;
        }
        let command: ImageCommand;
        try {
          if (
            message.properties.userId !== this.#expectedUserId ||
            message.properties.contentType !== 'application/json' ||
            message.content.length > IMAGE_MAX_MESSAGE_BYTES
          )
            throw new Error('COMMAND_INVALID');
          const body = new TextDecoder('utf-8', { fatal: true }).decode(message.content);
          const value: unknown = JSON.parse(body);
          if (
            value &&
            typeof value === 'object' &&
            'type' in value &&
            value.type === 'image.request'
          )
            command = parseImageCommand(value);
          else if (
            value &&
            typeof value === 'object' &&
            'type' in value &&
            value.type === 'image.query'
          )
            command = parseImageQuery(value);
          else if (
            value &&
            typeof value === 'object' &&
            'type' in value &&
            value.type === 'image.recover'
          )
            command = parseImageRecovery(value);
          else throw new Error('COMMAND_INVALID');
          if (message.properties.messageId !== command.messageId)
            throw new Error('COMMAND_ID_MISMATCH');
        } catch {
          try {
            activeSlot.channel.reject(message, false);
          } catch (error) {
            report(error);
          }
          return;
        }
        let isolateChannelRetry = false;
        const tracked = this.#runImageSerial(command.jobId, async () => {
          if (!gate.open || this.#state.closed) return;
          await handle(command, () => activeSlot.channel.ack(message));
        })
          .catch((error: unknown) => {
            const code = error instanceof Error ? error.message : '';
            if (code === 'IMAGE_COMMAND_CONFLICT' || code === 'IMAGE_QUERY_UNKNOWN') {
              try {
                activeSlot.channel.reject(message, false);
              } catch (rejectError) {
                report(rejectError);
              }
            } else if (isJournalFailure(error) || this.#state.closed) {
              report(error);
            } else {
              gate.open = false;
              isolateChannelRetry = true;
            }
          })
          .finally(() => {
            this.#imageHandling.delete(tracked);
            if (isolateChannelRetry) {
              recycleImageChannel();
            }
          });
        this.#imageHandling.add(tracked);
      },
      { noAck: false, consumerTag: `mio-img-${createId()}` },
    );
  }

  get consuming(): boolean {
    return this.#gate?.open === true;
  }

  get imageConsuming(): boolean {
    return this.#imageGate?.open === true;
  }

  get imageClosing(): boolean {
    return this.#imageClose !== null;
  }

  /** Close the gate synchronously, drain accepted work, then close its channel to requeue late deliveries. */
  pause(): Promise<void> {
    if (this.#pause) return this.#pause;
    const gate = this.#gate;
    const slot = this.#consumer;
    if (gate) gate.open = false;
    const tracked = (async () => {
      if (this.#handling) await this.#handling;
      if (this.#handlerFailure) throw this.#handlerFailure;
      if (slot) {
        if (!slot.closed) {
          let onClose: () => void = () => {};
          const closed = new Promise<void>((resolve) => {
            onClose = resolve;
            slot.channel.once('close', onClose);
          });
          slot.closing = true;
          try {
            await Promise.race([slot.channel.close(), closed]);
          } finally {
            slot.channel.off('close', onClose);
          }
        }
        if (slot.failed || this.#state.closed) throw new Error('BROKER_CLOSED');
        if (this.#consumer === slot) this.#consumer = null;
      }
      if (this.#gate === gate) this.#gate = null;
    })().finally(() => {
      if (this.#pause === tracked) this.#pause = null;
    });
    this.#pause = tracked;
    return tracked;
  }

  /** Close the image gate synchronously, drain active image handlers, then close the image channel. */
  closeImages(): Promise<void> {
    if (this.#imageClose) return this.#imageClose;
    const gate = this.#imageGate;
    const slot = this.#imageConsumer;
    if (gate) gate.open = false;
    const tracked = (async () => {
      if (this.#imageHandling.size > 0) {
        await Promise.allSettled([...this.#imageHandling]);
      }
      if (slot) {
        if (!slot.closed) {
          let onClose: () => void = () => {};
          const closed = new Promise<void>((resolve) => {
            onClose = resolve;
            slot.channel.once('close', onClose);
          });
          slot.closing = true;
          try {
            await Promise.race([slot.channel.close().catch(() => closed), closed]);
          } finally {
            slot.channel.off('close', onClose);
          }
        }
        if (this.#imageConsumer === slot) this.#imageConsumer = null;
      }
      if (this.#imageGate === gate) this.#imageGate = null;
    })().finally(() => {
      if (this.#imageClose === tracked) this.#imageClose = null;
    });
    this.#imageClose = tracked;
    return tracked;
  }

  closed(): Promise<void> {
    if (this.#state.closed) return Promise.resolve();
    return new Promise((resolve) => this.#state.events.once('closed', resolve));
  }

  async close(): Promise<void> {
    if (this.#gate) this.#gate.open = false;
    if (this.#imageGate) this.#imageGate.open = false;
    // Do not close the journal's owner while any admitted video or image handler can still write.
    // The caller aborts its bounded operations if the shutdown grace period expires.
    if (this.#handling) await this.#handling;
    await this.closeImages();
    this.#state.markClosed();
    await Promise.all([
      closeConnection(this.#consumerConnection, this.#closedConnections),
      closeConnection(this.#publisherConnection, this.#closedConnections),
    ]);
  }
}
