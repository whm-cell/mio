import { connect } from 'amqplib';
import type { Channel, ChannelModel, ConfirmChannel, ConsumeMessage, Message } from 'amqplib';
import {
  COMMAND_EXCHANGE,
  COMMAND_ROUTING_KEY,
  COMPUTE_MAX_MESSAGE_BYTES,
  RESULT_QUEUE,
  parseComputeResultV1,
} from '@mio/compute-contracts';
import type { ComputeCommandV1, ComputeResultV1 } from '@mio/compute-contracts';

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
    // amqplib can emit close before settling close(), or before its model is returned.
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

/** Runtime identities only use provisioned topology; deployment owns declarations and policies. */
export class ComputeBroker {
  private readonly consumerConnection: ChannelModel;
  private readonly publisherConnection: ChannelModel;
  private readonly consumer: Channel;
  private readonly publisher: ConfirmChannel;
  private readonly userId: string;
  private readonly expectedUserId: string;
  private readonly lifecycle: { closed: boolean; callback: (() => void) | undefined };
  private readonly closedConnections: WeakSet<ChannelModel>;
  private closing: Promise<void> | undefined;
  private constructor(
    consumerConnection: ChannelModel,
    publisherConnection: ChannelModel,
    consumer: Channel,
    publisher: ConfirmChannel,
    userId: string,
    expectedUserId: string,
    lifecycle: { closed: boolean; callback: (() => void) | undefined },
    closedConnections: WeakSet<ChannelModel>,
  ) {
    this.consumerConnection = consumerConnection;
    this.publisherConnection = publisherConnection;
    this.consumer = consumer;
    this.publisher = publisher;
    this.userId = userId;
    this.expectedUserId = expectedUserId;
    this.lifecycle = lifecycle;
    this.closedConnections = closedConnections;
  }

  static async connect(
    url: string,
    userId: string,
    expectedUserId: string,
  ): Promise<ComputeBroker> {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'amqps:' &&
      !(
        parsed.protocol === 'amqp:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      )
    )
      throw new Error('BROKER_TLS_REQUIRED');
    const lifecycle: { closed: boolean; callback: (() => void) | undefined } = {
      closed: false,
      callback: undefined,
    };
    const closed = () => {
      if (lifecycle.closed) return;
      lifecycle.closed = true;
      lifecycle.callback?.();
    };
    const closedConnections = new WeakSet<ChannelModel>();
    const watchConnection = (connection: ChannelModel) => {
      connection.on('error', () => {});
      connection.once('close', () => {
        closedConnections.add(connection);
        closed();
      });
    };
    const consumerConnection = await connect(url, { timeout: 5000 });
    watchConnection(consumerConnection);
    try {
      const publisherConnection = await connect(url, { timeout: 5000 });
      watchConnection(publisherConnection);
      try {
        const consumer = await consumerConnection.createChannel();
        consumer.on('error', () => {});
        consumer.once('close', closed);
        await consumer.prefetch(1);
        const publisher = await publisherConnection.createConfirmChannel();
        publisher.on('error', () => {});
        publisher.once('close', closed);
        // A QoS RPC proves an already-closed channel is not silently returned to the caller.
        await publisher.prefetch(1);
        if (lifecycle.closed) throw new Error('BROKER_CHANNEL_CLOSED');
        return new ComputeBroker(
          consumerConnection,
          publisherConnection,
          consumer,
          publisher,
          userId,
          expectedUserId,
          lifecycle,
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

  async publish(message: ComputeCommandV1): Promise<void> {
    let returned = false;
    const onReturn = (value: Message) => {
      if (value.properties.messageId === message.messageId) returned = true;
    };
    this.publisher.on('return', onReturn);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onDrain: (() => void) | undefined;
    try {
      let drain: Promise<void> = Promise.resolve();
      const confirmation = new Promise<void>((resolve, reject) => {
        const writable = this.publisher.publish(
          COMMAND_EXCHANGE,
          COMMAND_ROUTING_KEY,
          Buffer.from(JSON.stringify(message)),
          {
            persistent: true,
            mandatory: true,
            contentType: 'application/json',
            messageId: message.messageId,
            userId: this.userId,
          },
          (error) =>
            error ? reject(error) : returned ? reject(new Error('MESSAGE_RETURNED')) : resolve(),
        );
        if (!writable)
          drain = new Promise<void>((resolveDrain) => {
            onDrain = resolveDrain;
            this.publisher.once('drain', onDrain);
          });
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('CONFIRM_TIMEOUT')), 30_000);
      });
      await Promise.race([Promise.all([confirmation, drain]), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      this.publisher.off('return', onReturn);
      if (onDrain) this.publisher.off('drain', onDrain);
    }
  }

  async consume(
    handle: (result: ComputeResultV1) => Promise<void>,
    failed: () => void,
  ): Promise<void> {
    await this.consumer.consume(
      RESULT_QUEUE,
      (message: ConsumeMessage | null) => {
        if (!message) {
          failed();
          return;
        }
        let result: ComputeResultV1;
        try {
          if (
            message.properties.userId !== this.expectedUserId ||
            message.properties.contentType !== 'application/json' ||
            message.content.length > COMPUTE_MAX_MESSAGE_BYTES
          )
            throw new Error('RESULT_INVALID');
          result = parseComputeResultV1(
            JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(message.content),
            ) as unknown,
          );
          if (message.properties.messageId !== result.messageId)
            throw new Error('RESULT_ID_MISMATCH');
        } catch {
          this.consumer.reject(message, false);
          return;
        }
        void Promise.resolve()
          .then(() => handle(result))
          .then(
            () => {
              try {
                this.consumer.ack(message);
              } catch {
                failed();
              }
            },
            (error: unknown) => {
              if ((error as { permanent?: boolean })?.permanent) {
                try {
                  this.consumer.reject(message, false);
                } catch {
                  failed();
                }
              } else failed();
            },
          );
      },
      { noAck: false },
    );
  }
  onClose(callback: () => void): void {
    if (this.lifecycle.closed) callback();
    else this.lifecycle.callback = callback;
  }
  close(): Promise<void> {
    if (!this.closing)
      this.closing = Promise.resolve().then(async () => {
        await Promise.all([
          closeConnection(this.consumerConnection, this.closedConnections),
          closeConnection(this.publisherConnection, this.closedConnections),
        ]);
      });
    return this.closing;
  }
}
