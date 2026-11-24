import { connect } from 'amqplib';
import type {
  Channel,
  ChannelModel,
  ConfirmChannel,
  ConsumeMessage,
  Message,
  SocketOptions,
} from 'amqplib';
import {
  AUDIO_COMMAND_ROUTING_KEY,
  AUDIO_MAX_MESSAGE_BYTES,
  AUDIO_RESULT_QUEUE,
  COMMAND_EXCHANGE,
  COMMAND_ROUTING_KEY,
  COMPUTE_MAX_MESSAGE_BYTES,
  MEDIA_CONTROL_ROUTING_KEY,
  MEDIA_ENCODE_ROUTING_KEY,
  MEDIA_MAX_MESSAGE_BYTES,
  MEDIA_PROBE_ROUTING_KEY,
  MEDIA_RESULT_QUEUE,
  RESULT_QUEUE,
  mediaResourceClass,
  parseAudioInspectResultV1,
  parseComputeResultV1,
  parseMediaResult,
} from '@mio/compute-contracts';
import type {
  AudioInspectCommandV1,
  AudioInspectResultV1,
  ComputeCommandV1,
  ComputeResultV1,
  MediaCommand,
  MediaControl,
  MediaResult,
} from '@mio/compute-contracts';

/** The broker resolved this individual command as rejected. Connection state is independent. */
export class MediaPublishRejected extends Error {}

async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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
  private readonly transport: AbortController;
  private readonly inFlight = new Set<Promise<void>>();
  private accepting = true;
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
    transport: AbortController,
  ) {
    this.consumerConnection = consumerConnection;
    this.publisherConnection = publisherConnection;
    this.consumer = consumer;
    this.publisher = publisher;
    this.userId = userId;
    this.expectedUserId = expectedUserId;
    this.lifecycle = lifecycle;
    this.closedConnections = closedConnections;
    this.transport = transport;
  }

  static async connect(
    url: string,
    userId: string,
    expectedUserId: string,
    stop?: AbortSignal,
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
    stop?.throwIfAborted();
    const transport = new AbortController();
    const socketOptions: SocketOptions & { signal: AbortSignal } = {
      timeout: 5000,
      signal: transport.signal,
    };
    const connections: ChannelModel[] = [];
    const openConnection = async () => {
      transport.signal.throwIfAborted();
      const connection = await connect(url, socketOptions);
      watchConnection(connection);
      if (transport.signal.aborted) {
        await closeConnection(connection, closedConnections);
        transport.signal.throwIfAborted();
      }
      connections.push(connection);
      return connection;
    };
    const initialize = async () => {
      const consumerConnection = await openConnection();
      const publisherConnection = await openConnection();
      transport.signal.throwIfAborted();
      const consumer = await consumerConnection.createChannel();
      consumer.on('error', () => {});
      consumer.once('close', closed);
      await consumer.prefetch(4);
      transport.signal.throwIfAborted();
      const publisher = await publisherConnection.createConfirmChannel();
      transport.signal.throwIfAborted();
      publisher.on('error', () => {});
      publisher.once('close', closed);
      // A QoS RPC proves an already-closed channel is not silently returned to the caller.
      await publisher.prefetch(1);
      transport.signal.throwIfAborted();
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
        transport,
      );
    };
    const onStop = () => transport.abort(stop?.reason);
    stop?.addEventListener('abort', onStop, { once: true });
    const deadline = setTimeout(() => transport.abort(new Error('BROKER_STARTUP_TIMEOUT')), 5000);
    try {
      const broker = await untilAborted(initialize(), transport.signal);
      transport.signal.throwIfAborted();
      return broker;
    } catch (error) {
      transport.abort(error);
      await Promise.all(
        connections.map((connection) => closeConnection(connection, closedConnections)),
      );
      throw error;
    } finally {
      clearTimeout(deadline);
      stop?.removeEventListener('abort', onStop);
    }
  }

  publish(message: ComputeCommandV1): Promise<void> {
    return this.publishCommand(COMMAND_ROUTING_KEY, message);
  }

  publishAudio(message: AudioInspectCommandV1): Promise<void> {
    return this.publishCommand(AUDIO_COMMAND_ROUTING_KEY, message);
  }

  publishMedia(message: MediaCommand | MediaControl): Promise<void> {
    const routingKey =
      message.type === 'media.control'
        ? MEDIA_CONTROL_ROUTING_KEY
        : mediaResourceClass(message.operation) === 'encode'
          ? MEDIA_ENCODE_ROUTING_KEY
          : MEDIA_PROBE_ROUTING_KEY;
    return this.publishCommand(routingKey, message).catch((error: unknown) => {
      // amqplib 2.2.1 uses "message nacked" for the confirm callback on Basic.Nack.
      if (error instanceof Error && ['message nacked', 'MESSAGE_RETURNED'].includes(error.message))
        throw new MediaPublishRejected(error.message, { cause: error });
      throw error;
    });
  }

  private async publishCommand(
    routingKey: string,
    message: ComputeCommandV1 | AudioInspectCommandV1 | MediaCommand | MediaControl,
  ): Promise<void> {
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
          routingKey,
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
      await untilAborted(
        Promise.race([Promise.all([confirmation, drain]), timeout]),
        this.transport.signal,
      );
    } finally {
      if (timer) clearTimeout(timer);
      this.publisher.off('return', onReturn);
      if (onDrain) this.publisher.off('drain', onDrain);
    }
  }

  consume(handle: (result: ComputeResultV1) => Promise<void>, failed: () => void): Promise<void> {
    return this.consumeResults(
      { queue: RESULT_QUEUE, maxBytes: COMPUTE_MAX_MESSAGE_BYTES, parse: parseComputeResultV1 },
      handle,
      failed,
      this.transport.signal,
    );
  }

  consumeAudio(
    handle: (result: AudioInspectResultV1) => Promise<void>,
    failed: () => void,
    stop: AbortSignal,
  ): Promise<void> {
    return this.consumeResults(
      {
        queue: AUDIO_RESULT_QUEUE,
        maxBytes: AUDIO_MAX_MESSAGE_BYTES,
        parse: parseAudioInspectResultV1,
      },
      handle,
      failed,
      AbortSignal.any([stop, this.transport.signal]),
    );
  }

  async consumeMedia(
    handle: (result: MediaResult) => Promise<void>,
    failed: () => void,
  ): Promise<void> {
    // Media progress has no wire sequence field. Keep dispatch order through
    // the inbox of this dedicated media result consumer.
    await untilAborted(this.consumer.prefetch(1), this.transport.signal);
    return this.consumeResults(
      { queue: MEDIA_RESULT_QUEUE, maxBytes: MEDIA_MAX_MESSAGE_BYTES, parse: parseMediaResult },
      handle,
      failed,
      this.transport.signal,
    );
  }

  private async consumeResults<T extends { messageId: string }>(
    protocol: { queue: string; maxBytes: number; parse: (value: unknown) => T },
    handle: (result: T) => Promise<void>,
    failed: () => void,
    stop: AbortSignal,
  ): Promise<void> {
    stop.throwIfAborted();
    const stream = protocol.queue === AUDIO_RESULT_QUEUE;
    await untilAborted(
      this.consumer.consume(
        protocol.queue,
        (message: ConsumeMessage | null) => {
          if (!this.accepting || this.lifecycle.closed) return;
          if (!message) {
            failed();
            return;
          }
          let result: T;
          try {
            if (
              message.properties.userId !== this.expectedUserId ||
              message.properties.contentType !== 'application/json' ||
              message.content.length > protocol.maxBytes
            )
              throw new Error('RESULT_INVALID');
            const value: unknown = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(message.content),
            );
            result = protocol.parse(value);
            if (message.properties.messageId !== result.messageId)
              throw new Error('RESULT_ID_MISMATCH');
          } catch {
            try {
              // A stream retains entries after ACK. Advance this consumer past invalid entries.
              if (stream) this.consumer.ack(message);
              else this.consumer.reject(message, false);
            } catch {
              if (this.accepting) failed();
            }
            return;
          }
          let shouldFail = false;
          const task = (async () => {
            try {
              await handle(result);
            } catch (error) {
              if (!this.lifecycle.closed) {
                if ((error as { permanent?: boolean })?.permanent) {
                  try {
                    if (stream) this.consumer.ack(message);
                    else this.consumer.reject(message, false);
                  } catch {
                    shouldFail = true;
                  }
                } else {
                  shouldFail = true;
                }
              }
              return;
            }
            if (!this.lifecycle.closed) {
              try {
                this.consumer.ack(message);
              } catch {
                shouldFail = true;
              }
            }
          })();
          const tracked = task.finally(() => {
            this.inFlight.delete(tracked);
            if (shouldFail && this.accepting) failed();
          });
          this.inFlight.add(tracked);
        },
        { noAck: false, ...(stream ? { arguments: { 'x-stream-offset': 'next' } } : {}) },
      ),
      stop,
    );
  }
  onClose(callback: () => void): void {
    if (this.lifecycle.closed) callback();
    else this.lifecycle.callback = callback;
  }
  close(): Promise<void> {
    this.accepting = false;
    if (!this.closing)
      this.closing = Promise.resolve().then(async () => {
        const deadline = setTimeout(
          () => this.transport.abort(new Error('BROKER_CLOSE_TIMEOUT')),
          5000,
        );
        try {
          if (this.inFlight.size > 0) {
            await untilAborted(Promise.allSettled([...this.inFlight]), this.transport.signal).catch(
              () => {},
            );
          }
          await Promise.all([
            closeConnection(this.consumerConnection, this.closedConnections),
            closeConnection(this.publisherConnection, this.closedConnections),
          ]);
        } finally {
          clearTimeout(deadline);
          this.transport.abort();
        }
      });
    return this.closing;
  }
}
