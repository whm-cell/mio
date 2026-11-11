import { connect } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Channel, ChannelModel, ConfirmChannel, ConsumeMessage, Message } from 'amqplib';
import {
  COMMAND_QUEUE,
  COMPUTE_MAX_MESSAGE_BYTES,
  RESULT_EXCHANGE,
  RESULT_ROUTING_KEY,
  parseComputeCommandV1,
} from '@mio/compute-contracts';
import type { ComputeCommandV1, ComputeResultV1 } from '@mio/compute-contracts';

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

  async publish(message: ComputeResultV1): Promise<void> {
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

  async consume(
    handle: (command: ComputeCommandV1, ack: () => void) => Promise<void>,
    failed: (error: unknown) => void,
    canAdmit: () => boolean,
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
        let command: ComputeCommandV1;
        try {
          if (
            message.properties.userId !== this.#expectedUserId ||
            message.properties.contentType !== 'application/json' ||
            message.content.length > COMPUTE_MAX_MESSAGE_BYTES
          )
            throw new Error('COMMAND_INVALID');
          const body = new TextDecoder('utf-8', { fatal: true }).decode(message.content);
          command = parseComputeCommandV1(JSON.parse(body) as unknown);
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
          .then(() => handle(command, () => slot.channel.ack(message)))
          .catch((error: unknown) => {
            if ((error as Error).message === 'ATTEMPT_CONFLICT') {
              try {
                slot.channel.reject(message, false);
              } catch (rejectError) {
                report(rejectError);
              }
            } else if ((error as Error).message === 'WORKER_NOT_READY') {
              void this.pause().catch(report);
            } else report(error);
          })
          .finally(() => {
            if (this.#handling === tracked) this.#handling = null;
          });
        this.#handling = tracked;
      },
      { noAck: false, consumerTag: `mio-${randomUUID()}` },
    );
  }

  get consuming(): boolean {
    return this.#gate?.open === true;
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

  closed(): Promise<void> {
    if (this.#state.closed) return Promise.resolve();
    return new Promise((resolve) => this.#state.events.once('closed', resolve));
  }

  async close(): Promise<void> {
    if (this.#gate) this.#gate.open = false;
    this.#state.markClosed();
    await Promise.all([
      closeConnection(this.#consumerConnection, this.#closedConnections),
      closeConnection(this.#publisherConnection, this.#closedConnections),
    ]);
  }
}
