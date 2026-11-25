import { connect } from 'amqplib';
import { createId } from '@mio/foundation/identifiers';
import { EventEmitter } from 'node:events';
import type {
  Channel,
  ChannelModel,
  ConfirmChannel,
  ConsumeMessage,
  Message,
  SocketOptions,
} from 'amqplib';
import {
  AUDIO_COMMAND_QUEUE,
  AUDIO_MAX_MESSAGE_BYTES,
  AUDIO_RESULT_ROUTING_KEY,
  COMMAND_QUEUE,
  COMPUTE_MAX_MESSAGE_BYTES,
  MEDIA_CONTROL_QUEUE,
  MEDIA_ENCODE_QUEUE,
  MEDIA_MAX_MESSAGE_BYTES,
  MEDIA_PROBE_QUEUE,
  MEDIA_RESULT_ROUTING_KEY,
  RESULT_EXCHANGE,
  RESULT_ROUTING_KEY,
  WORKER_TELEMETRY_ROUTING_KEY,
  WORKER_MAX_MESSAGE_BYTES,
  VIDEO_PROBE_RESULT_ROUTING_KEY,
  parseWorkerLimitsCommand,
  workerControlQueue,
  mediaResourceClass,
  parseAudioInspectCommandV1,
  parseComputeCommandV1,
  parseMediaCommand,
  parseMediaControl,
  parseVideoProbeCommandV1,
} from '@mio/compute-contracts';
import type {
  AudioInspectCommandV1,
  AudioInspectResultV1,
  ComputeCommandV1,
  ComputeResultV1,
  MediaCommand,
  MediaControl,
  MediaResult,
  VideoProbeCommandV1,
  VideoProbeResultV1,
  WorkerResourceClass,
  WorkerTelemetry,
  WorkerLimitsResult,
  WorkerLimitsCommand,
} from '@mio/compute-contracts';

export class WorkerTelemetryPublishRejected extends Error {}

const BROKER_STARTUP_TIMEOUT_MS = 5000;
const BROKER_CLOSE_TIMEOUT_MS = 5000;

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

interface CommandProtocol<T> {
  queue: string;
  maxBytes: number;
  parse(value: unknown): T;
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
  readonly #transport: AbortController;
  #gate: ConsumerGate | null = null;
  #handling: Promise<void> | null = null;
  #pause: Promise<void> | null = null;
  #handlerFailure: unknown = null;
  readonly #concurrentHandling = new Set<Promise<void>>();
  #concurrentClosing = false;

  private constructor(
    consumerConnection: ChannelModel,
    publisherConnection: ChannelModel,
    consumer: ConsumerSlot,
    publisher: ConfirmChannel,
    userId: string,
    expectedUserId: string,
    state: BrokerState,
    closedConnections: WeakSet<ChannelModel>,
    transport: AbortController,
  ) {
    this.#consumerConnection = consumerConnection;
    this.#publisherConnection = publisherConnection;
    this.#consumer = consumer;
    this.#publisher = publisher;
    this.#userId = userId;
    this.#expectedUserId = expectedUserId;
    this.#state = state;
    this.#closedConnections = closedConnections;
    this.#transport = transport;
  }

  static async connect(
    url: string,
    userId: string,
    expectedUserId: string,
    stop?: AbortSignal,
  ): Promise<Broker> {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'amqps:' &&
      !(
        parsed.protocol === 'amqp:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      )
    ) {
      throw new Error('BROKER_TLS_REQUIRED');
    }
    stop?.throwIfAborted();
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
    const transport = new AbortController();
    // amqplib passes these options through to Node's TCP and TLS sockets.
    const socketOptions: SocketOptions & { signal: AbortSignal } = {
      timeout: BROKER_STARTUP_TIMEOUT_MS,
      signal: transport.signal,
    };
    const connections: ChannelModel[] = [];
    const openConnection = async () => {
      transport.signal.throwIfAborted();
      const connection = await connect(url, socketOptions);
      connection.once('close', () => closedConnections.add(connection));
      watch(connection);
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
      const slot = watchConsumer(consumer, state);
      transport.signal.throwIfAborted();
      const publisher = await publisherConnection.createConfirmChannel();
      watch(publisher);
      transport.signal.throwIfAborted();
      if (state.closed) throw new Error('BROKER_CLOSED');
      await Promise.all([consumer.prefetch(1), publisher.prefetch(1)]);
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
        transport,
      );
    };
    const { promise: cancelled, reject } = Promise.withResolvers<never>();
    const onAbort = () => reject(transport.signal.reason);
    transport.signal.addEventListener('abort', onAbort, { once: true });
    const onStop = () => transport.abort(stop?.reason);
    stop?.addEventListener('abort', onStop, { once: true });
    const deadline = setTimeout(
      () => transport.abort(new Error('BROKER_STARTUP_TIMEOUT')),
      BROKER_STARTUP_TIMEOUT_MS,
    );
    try {
      const broker = await Promise.race([initialize(), cancelled]);
      transport.signal.throwIfAborted();
      return broker;
    } catch (error) {
      transport.abort();
      await Promise.all(
        connections.map((connection) => closeConnection(connection, closedConnections)),
      );
      throw error;
    } finally {
      // The live broker owns its sockets through the drain and connection close handshake.
      clearTimeout(deadline);
      stop?.removeEventListener('abort', onStop);
      transport.signal.removeEventListener('abort', onAbort);
    }
  }

  publish(message: ComputeResultV1): Promise<void> {
    return this.publishMessage(message, RESULT_ROUTING_KEY);
  }
  publishVideoProbe(message: VideoProbeResultV1): Promise<void> {
    return this.publishMessage(message, VIDEO_PROBE_RESULT_ROUTING_KEY);
  }

  publishAudio(message: AudioInspectResultV1): Promise<void> {
    return this.publishMessage(message, AUDIO_RESULT_ROUTING_KEY);
  }

  publishMedia(message: MediaResult): Promise<void> {
    return this.publishMessage(message, MEDIA_RESULT_ROUTING_KEY);
  }

  publishWorker(message: WorkerTelemetry | WorkerLimitsResult): Promise<void> {
    return this.publishMessage(message, WORKER_TELEMETRY_ROUTING_KEY).catch((error: unknown) => {
      if (error instanceof Error && ['message nacked', 'MESSAGE_RETURNED'].includes(error.message))
        throw new WorkerTelemetryPublishRejected(error.message, { cause: error });
      throw error;
    });
  }

  private async publishMessage(
    message:
      | ComputeResultV1
      | VideoProbeResultV1
      | AudioInspectResultV1
      | MediaResult
      | WorkerTelemetry
      | WorkerLimitsResult,
    routingKey: string,
  ): Promise<void> {
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
          routingKey,
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

  consume(
    handle: (command: ComputeCommandV1, ack: () => void) => Promise<void>,
    failed: (error: unknown) => void,
    canAdmit: () => boolean,
    handleVideoProbe?: (command: VideoProbeCommandV1, ack: () => void) => Promise<void>,
  ): Promise<void> {
    return this.consumeCommands(
      {
        queue: COMMAND_QUEUE,
        maxBytes: COMPUTE_MAX_MESSAGE_BYTES,
        parse(value): ComputeCommandV1 | VideoProbeCommandV1 {
          return value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            (value as Record<string, unknown>).type === 'video.probe'
            ? parseVideoProbeCommandV1(value)
            : parseComputeCommandV1(value);
        },
      },
      async (command, ack) => {
        if (command.type === 'video.probe') {
          if (!handleVideoProbe) throw new Error('VIDEO_PROBE_HANDLER_UNAVAILABLE');
          return handleVideoProbe(command, ack);
        }
        return handle(command, ack);
      },
      failed,
      canAdmit,
    );
  }

  consumeAudio(
    handle: (command: AudioInspectCommandV1, ack: () => void) => Promise<void>,
    failed: (error: unknown) => void,
    canAdmit: () => boolean,
  ): Promise<void> {
    return this.consumeCommands(
      {
        queue: AUDIO_COMMAND_QUEUE,
        maxBytes: AUDIO_MAX_MESSAGE_BYTES,
        parse: parseAudioInspectCommandV1,
      },
      handle,
      failed,
      canAdmit,
    );
  }

  consumeTranscodes(
    handle: (command: ComputeCommandV1, ack: () => void) => Promise<void>,
    failed: (error: unknown) => void,
  ): Promise<void> {
    return this.#consumeConcurrentChannel(
      {
        queue: COMMAND_QUEUE,
        maxBytes: COMPUTE_MAX_MESSAGE_BYTES,
        parse: parseComputeCommandV1,
      },
      handle,
      failed,
      32,
    );
  }

  consumeAudioInspections(
    handle: (command: AudioInspectCommandV1, ack: () => void) => Promise<void>,
    failed: (error: unknown) => void,
  ): Promise<void> {
    return this.#consumeConcurrentChannel(
      {
        queue: AUDIO_COMMAND_QUEUE,
        maxBytes: AUDIO_MAX_MESSAGE_BYTES,
        parse: parseAudioInspectCommandV1,
      },
      handle,
      failed,
      32,
    );
  }

  consumeWorkerControl(
    instanceId: string,
    handle: (command: WorkerLimitsCommand, ack: () => void) => Promise<void>,
    failed: (error: unknown) => void,
  ): Promise<void> {
    return this.#consumeConcurrentChannel(
      {
        queue: workerControlQueue(instanceId),
        maxBytes: WORKER_MAX_MESSAGE_BYTES,
        parse: parseWorkerLimitsCommand,
      },
      handle,
      failed,
    );
  }

  consumeMedia(
    resource: WorkerResourceClass,
    handle: (command: MediaCommand, ack: () => void) => Promise<void>,
    failed: (error: unknown) => void,
  ): Promise<void> {
    return this.#consumeConcurrentChannel(
      {
        queue: resource === 'encode' ? MEDIA_ENCODE_QUEUE : MEDIA_PROBE_QUEUE,
        maxBytes: MEDIA_MAX_MESSAGE_BYTES,
        parse(value) {
          const command = parseMediaCommand(value);
          if (mediaResourceClass(command.operation) !== resource)
            throw new Error('COMMAND_RESOURCE_MISMATCH');
          return command;
        },
      },
      handle,
      failed,
      32,
    );
  }

  consumeMediaControl(
    handle: (command: MediaControl, ack: () => void) => Promise<void>,
    failed: (error: unknown) => void,
  ): Promise<void> {
    return this.#consumeConcurrentChannel(
      { queue: MEDIA_CONTROL_QUEUE, maxBytes: MEDIA_MAX_MESSAGE_BYTES, parse: parseMediaControl },
      handle,
      failed,
    );
  }

  async #consumeConcurrentChannel<T extends { messageId: string }>(
    protocol: CommandProtocol<T>,
    handle: (command: T, ack: () => void) => Promise<void>,
    failed: (error: unknown) => void,
    prefetch = 1,
  ): Promise<void> {
    if (this.#state.closed || this.#concurrentClosing) throw new Error('BROKER_CLOSED');
    const channel = await this.#consumerConnection.createChannel();
    watchConsumer(channel, this.#state);
    await channel.prefetch(prefetch);
    await channel.consume(
      protocol.queue,
      (message) => {
        if (this.#state.closed || this.#concurrentClosing) return;
        if (!message) {
          failed(new Error('CONSUMER_CANCELLED'));
          return;
        }
        let command: T;
        try {
          command = this.#decodeCommand(protocol, message);
        } catch {
          try {
            channel.reject(message, false);
          } catch (error) {
            failed(error);
          }
          return;
        }
        const tracked = handle(command, () => channel.ack(message))
          .catch((error: unknown) => {
            if (error instanceof Error && error.message === 'ATTEMPT_CONFLICT') {
              try {
                channel.reject(message, false);
              } catch (rejectError) {
                failed(rejectError);
              }
            } else failed(error);
          })
          .finally(() => {
            this.#concurrentHandling.delete(tracked);
          });
        this.#concurrentHandling.add(tracked);
      },
      { noAck: false, consumerTag: `mio-${createId()}` },
    );
  }

  #decodeCommand<T extends { messageId: string }>(
    protocol: CommandProtocol<T>,
    message: ConsumeMessage,
  ): T {
    if (
      message.properties.userId !== this.#expectedUserId ||
      message.properties.contentType !== 'application/json' ||
      message.content.length > protocol.maxBytes
    )
      throw new Error('COMMAND_INVALID');
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(message.content),
    );
    const command = protocol.parse(value);
    if (message.properties.messageId !== command.messageId) throw new Error('COMMAND_ID_MISMATCH');
    return command;
  }

  private async consumeCommands<T extends { messageId: string }>(
    protocol: CommandProtocol<T>,
    handle: (command: T, ack: () => void) => Promise<void>,
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
      protocol.queue,
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
        let command: T;
        try {
          command = this.#decodeCommand(protocol, message);
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
            return handle(command, () => slot.channel.ack(message));
          })
          .catch((error: unknown) => {
            const code = error instanceof Error ? error.message : '';
            if (code === 'ATTEMPT_CONFLICT') {
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
    this.#concurrentClosing = true;
    // Preserve journal ownership until admitted transcodes finish.
    if (this.#handling) await this.#handling;
    await Promise.allSettled(this.#concurrentHandling);
    this.#state.markClosed();
    const deadline = setTimeout(() => this.#transport.abort(), BROKER_CLOSE_TIMEOUT_MS);
    try {
      await Promise.all([
        closeConnection(this.#consumerConnection, this.#closedConnections),
        closeConnection(this.#publisherConnection, this.#closedConnections),
      ]);
    } finally {
      clearTimeout(deadline);
      this.#transport.abort();
    }
  }
}
