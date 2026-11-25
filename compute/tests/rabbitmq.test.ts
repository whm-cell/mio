import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  COMPUTE_PROFILE,
  parseComputeCommandV1,
  parseVideoProbeResultV1,
} from '@mio/compute-contracts';
import type {
  ComputeCommandV1,
  ComputeResultV1,
  VideoProbeCommandV1,
} from '@mio/compute-contracts';
import type { ConsumeMessage } from 'amqplib';
import { Journal } from '../src/adapters/journal.ts';
import { paths, processIdentity } from '../src/adapters/media.ts';
import { Maintenance } from '../src/maintenance.ts';
import { Worker } from '../src/worker.ts';

const directories: string[] = [];

async function fixture(closeDuringPrefetch = false, publisherAlreadyClosed = false) {
  function makeConsumer(closeEarly = false) {
    let callback: ((message: ConsumeMessage | null) => void) | null = null;
    const outstanding = new Set<ConsumeMessage>();
    const requeued: ConsumeMessage[] = [];
    const channel = Object.assign(new EventEmitter(), {
      prefetch: vi.fn(async () => {
        if (closeEarly) channel.emit('close');
      }),
      consume: vi.fn(
        async (
          ...args: [string, (message: ConsumeMessage | null) => void, { consumerTag: string }]
        ) => {
          callback = args[1];
          return { consumerTag: args[2].consumerTag };
        },
      ),
      ack: vi.fn((message: ConsumeMessage) => {
        outstanding.delete(message);
      }),
      reject: vi.fn((message: ConsumeMessage) => {
        outstanding.delete(message);
      }),
      close: vi.fn(async () => {
        requeued.push(...outstanding);
        outstanding.clear();
        channel.emit('close');
      }),
      deliver(message: ConsumeMessage) {
        outstanding.add(message);
        callback?.(message);
      },
      invokeOld(message: ConsumeMessage | null) {
        callback?.(message);
      },
      requeued,
    });
    return channel;
  }
  const consumer = makeConsumer(closeDuringPrefetch);
  const nextConsumer = makeConsumer();
  const thirdConsumer = makeConsumer();
  const fourthConsumer = makeConsumer();
  const publisher = Object.assign(new EventEmitter(), {
    publish: vi.fn<(...args: unknown[]) => boolean>().mockReturnValue(false),
    prefetch: vi.fn(async () => {
      if (publisherAlreadyClosed) throw new Error('channel already closed');
    }),
  });
  const consumerConnection = Object.assign(new EventEmitter(), {
    createChannel: vi
      .fn()
      .mockResolvedValueOnce(consumer)
      .mockResolvedValueOnce(nextConsumer)
      .mockResolvedValueOnce(thirdConsumer)
      .mockResolvedValueOnce(fourthConsumer),
    close: vi.fn(async () => {
      consumerConnection.emit('close');
    }),
  });
  const publisherConnection = Object.assign(new EventEmitter(), {
    createConfirmChannel: vi.fn(async () => {
      if (publisherAlreadyClosed) publisher.emit('close');
      return publisher;
    }),
    close: vi.fn(async () => {
      publisherConnection.emit('close');
    }),
  });
  const connect = vi
    .fn()
    .mockResolvedValueOnce(consumerConnection)
    .mockResolvedValueOnce(publisherConnection);
  vi.doMock('amqplib', () => ({ connect }));
  const { Broker } = await import('../src/adapters/rabbitmq.ts');
  return {
    Broker,
    connect,
    consumer,
    nextConsumer,
    thirdConsumer,
    fourthConsumer,
    publisher,
    consumerConnection,
    publisherConnection,
  };
}

function delivery(): ConsumeMessage {
  const assetId = randomUUID();
  const command = {
    version: 1,
    type: 'transcode.request',
    messageId: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    attempt: 1,
    profile: COMPUTE_PROFILE,
    input: { assetId, key: `mio/raw/${assetId}/${randomUUID()}`, sizeBytes: 1, etag: '"raw"' },
  };
  return {
    content: Buffer.from(JSON.stringify(command)),
    properties: { userId: 'app-a', contentType: 'application/json', messageId: command.messageId },
  } as ConsumeMessage;
}

function videoProbeDelivery(): ConsumeMessage {
  const jobId = randomUUID();
  const outputIndex = 0;
  const attemptId = randomUUID();
  const messageId = randomUUID();
  const command: VideoProbeCommandV1 = {
    version: 1,
    type: 'video.probe',
    messageId,
    jobId,
    outputIndex,
    attemptId,
    attempt: 1,
    source: {
      stagingKey: `mio/staging/video/${jobId}/${outputIndex}/${attemptId}.media`,
      sizeBytes: 1,
      etag: '"staging"',
      sha256: 'a'.repeat(64),
    },
  };
  return {
    content: Buffer.from(JSON.stringify(command)),
    properties: { userId: 'app-a', contentType: 'application/json', messageId },
  } as ConsumeMessage;
}

afterEach(() => {
  vi.doUnmock('amqplib');
  vi.resetModules();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

it.each(['amqp', 'amqps'])(
  'destroys a real %s handshake socket when Worker startup stops',
  async (protocol) => {
    const accepted = Promise.withResolvers<Socket>();
    const server = createServer(accepted.resolve);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { Broker } = await import('../src/adapters/rabbitmq.ts');
    const stop = new AbortController();
    const failure = new Error('test shutdown');
    const connection = Broker.connect(
      `${protocol}://127.0.0.1:${(server.address() as AddressInfo).port}`,
      'worker-b',
      'app-a',
      stop.signal,
    ).catch((error: unknown) => error);
    const socket = await accepted.promise;
    try {
      await once(socket, 'data');
      const closed = once(socket, 'close');
      stop.abort(failure);
      expect(await Promise.race([connection, delay(750, 'handshake still pending')])).toBe(failure);
      expect(await Promise.race([closed.then(() => 'closed'), delay(750, 'socket open')])).toBe(
        'closed',
      );
    } finally {
      socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await connection;
    }
  },
);

it('enforces one startup deadline through channel setup and releases both connections', async () => {
  const { Broker, consumerConnection, publisherConnection } = await fixture();
  publisherConnection.createConfirmChannel.mockImplementationOnce(() => new Promise(() => {}));
  vi.useFakeTimers();
  try {
    const connection = Broker.connect('amqp://localhost', 'worker-b', 'app-a').catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(consumerConnection.close).toHaveBeenCalledOnce();
    expect(publisherConnection.close).toHaveBeenCalledOnce();
    await expect(connection).resolves.toEqual(new Error('BROKER_STARTUP_TIMEOUT'));
  } finally {
    vi.useRealTimers();
  }
});

it('releases the first connection on stop and closes a second connection that opens late', async () => {
  const { Broker, connect, consumerConnection, publisherConnection } = await fixture();
  const late = Promise.withResolvers<typeof publisherConnection>();
  connect.mockReset().mockResolvedValueOnce(consumerConnection).mockReturnValueOnce(late.promise);
  const stop = new AbortController();
  const failure = new Error('test shutdown');
  const connection = Broker.connect('amqp://localhost', 'worker-b', 'app-a', stop.signal).catch(
    (error: unknown) => error,
  );
  try {
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    stop.abort(failure);
    expect(await Promise.race([connection, delay(750, 'startup still pending')])).toBe(failure);
    expect(consumerConnection.close).toHaveBeenCalledOnce();
  } finally {
    late.resolve(publisherConnection);
  }
  await vi.waitFor(() => expect(publisherConnection.close).toHaveBeenCalledOnce());
  expect(publisherConnection.createConfirmChannel).not.toHaveBeenCalled();
});

it('keeps the startup signal and deadline from interrupting an established publisher', async () => {
  const { Broker, connect, publisher } = await fixture();
  const stop = new AbortController();
  vi.useFakeTimers();
  try {
    const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a', stop.signal);
    const transports = connect.mock.calls.map(
      ([, options]) => (options as { signal: AbortSignal } | undefined)?.signal,
    );
    expect(transports).toHaveLength(2);
    stop.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(transports.every((signal) => signal?.aborted === false)).toBe(true);
    publisher.publish.mockImplementationOnce((...args) => {
      const confirm = args.at(-1) as (error: null) => void;
      confirm(null);
      return true;
    });
    const { messageId, jobId, attemptId } = parseComputeCommandV1(
      JSON.parse(delivery().content.toString()),
    );
    await broker.publish({
      version: 1,
      type: 'transcode.result',
      state: 'running',
      messageId: randomUUID(),
      commandId: messageId,
      jobId,
      attemptId,
      attempt: 1,
    });
    await broker.close();
  } finally {
    vi.useRealTimers();
  }
});

it('observes a consumer-only channel close while both connections remain open', async () => {
  const { Broker, consumer, consumerConnection, publisherConnection } = await fixture();
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  const closed = broker.closed();
  consumer.emit('close');
  await expect(closed).resolves.toBeUndefined();
  await expect(broker.closed()).resolves.toBeUndefined();
  expect(consumerConnection.close).not.toHaveBeenCalled();
  expect(publisherConnection.close).not.toHaveBeenCalled();
  await broker.close();
});

it('finishes closing after the actual connection close event even when amqplib leaves close unresolved', async () => {
  const { Broker, consumerConnection, publisherConnection } = await fixture();
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  consumerConnection.emit('close');
  publisherConnection.close.mockImplementation(() => {
    queueMicrotask(() => publisherConnection.emit('close'));
    return new Promise<void>(() => {});
  });
  await broker.close();
  expect(consumerConnection.close).not.toHaveBeenCalled();
  expect(publisherConnection.close).toHaveBeenCalledOnce();
});

it('accepts amqplib already-closed state when close happened before listeners were attached', async () => {
  const { Broker, consumerConnection } = await fixture();
  consumerConnection.createChannel.mockReset().mockRejectedValue(new Error('channel unavailable'));
  consumerConnection.close.mockRejectedValueOnce(
    Object.assign(new Error('Connection closed (by client)'), { name: 'IllegalOperationError' }),
  );
  await expect(Broker.connect('amqp://localhost', 'worker-b', 'app-a')).rejects.toThrow(
    'channel unavailable',
  );
});

it('does not reopen a consumer when its connection dies during channel close', async () => {
  const { Broker, consumer, consumerConnection, nextConsumer } = await fixture();
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  const failed = vi.fn();
  await broker.consume(
    async () => {},
    failed,
    () => true,
  );
  consumer.close.mockImplementation(() => {
    queueMicrotask(() => {
      consumer.emit('error', new Error('channel lost'));
      consumer.emit('close');
      consumerConnection.emit('close');
    });
    return new Promise<void>(() => {});
  });
  await expect(broker.pause()).rejects.toThrow('BROKER_CLOSED');
  expect(nextConsumer.consume).not.toHaveBeenCalled();
  await broker.close();
});

it('rejects a channel that closes during setup rather than returning a dead broker', async () => {
  const { Broker, consumerConnection, publisherConnection } = await fixture(true);
  await expect(Broker.connect('amqp://localhost', 'worker-b', 'app-a')).rejects.toThrow(
    'BROKER_CLOSED',
  );
  expect(consumerConnection.close).toHaveBeenCalledOnce();
  expect(publisherConnection.close).toHaveBeenCalledOnce();
});

it('rejects a publisher channel already closed before its listener could be attached', async () => {
  const { Broker, consumerConnection, publisherConnection } = await fixture(false, true);
  await expect(Broker.connect('amqp://localhost', 'worker-b', 'app-a')).rejects.toThrow(
    'channel already closed',
  );
  expect(consumerConnection.close).toHaveBeenCalledOnce();
  expect(publisherConnection.close).toHaveBeenCalledOnce();
});

it('reports a server consumer cancellation even while channel and connection remain open', async () => {
  const { Broker, consumer } = await fixture();
  consumer.consume.mockImplementation(async (_queue, callback) => {
    callback(null);
    return { consumerTag: 'test' };
  });
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  const failed = vi.fn();
  await broker.consume(
    async () => {},
    failed,
    () => true,
  );
  expect(failed).toHaveBeenCalledOnce();
  expect(failed.mock.calls[0]?.[0]).toMatchObject({ message: 'CONSUMER_CANCELLED' });
  await broker.close();
});

it('closes admission synchronously, drains an accepted handler and requeues a late delivery on the old channel', async () => {
  const { Broker, consumer, nextConsumer } = await fixture();
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  const failed = vi.fn();
  const closed = vi.fn();
  void broker.closed().then(closed);
  await broker.consume(
    async (command, ack) => {
      started.push(command.messageId);
      await gate;
      ack();
    },
    failed,
    () => true,
  );
  const first = delivery();
  const late = delivery();
  consumer.deliver(first);
  await vi.waitFor(() => expect(started).toHaveLength(1));
  const paused = broker.pause();
  expect(broker.consuming).toBe(false);
  consumer.deliver(late);
  expect(started).toHaveLength(1);
  expect(consumer.close).not.toHaveBeenCalled();
  expect(consumer.ack).not.toHaveBeenCalled();
  release();
  await paused;
  expect(consumer.ack).toHaveBeenCalledWith(first);
  expect(consumer.ack).not.toHaveBeenCalledWith(late);
  expect(consumer.reject).not.toHaveBeenCalledWith(late, expect.anything());
  expect(consumer.requeued).toEqual([late]);
  expect(failed).not.toHaveBeenCalled();
  await broker.consume(
    async (_command, ack) => {
      ack();
    },
    failed,
    () => true,
  );
  consumer.invokeOld(delivery());
  consumer.invokeOld(null);
  consumer.emit('error', new Error('old channel error'));
  expect(failed).not.toHaveBeenCalled();
  expect(closed).not.toHaveBeenCalled();
  expect(nextConsumer.ack).not.toHaveBeenCalled();
  const fresh = delivery();
  nextConsumer.deliver(fresh);
  await vi.waitFor(() => expect(nextConsumer.ack).toHaveBeenCalledWith(fresh));
  nextConsumer.invokeOld(null);
  expect(failed).toHaveBeenCalledOnce();
  expect(failed.mock.calls[0]?.[0]).toMatchObject({ message: 'CONSUMER_CANCELLED' });
  await broker.close();
});

it('requeues a delivery when pause races with consumer registration', async () => {
  const { Broker, consumer, nextConsumer } = await fixture();
  const original = consumer.consume.getMockImplementation();
  const close = consumer.close.getMockImplementation();
  let release: () => void = () => {};
  const registered = new Promise<void>((resolve) => {
    release = resolve;
  });
  consumer.consume.mockImplementationOnce(async (...args) => {
    const reply = await original?.(...args);
    await registered;
    return reply as { consumerTag: string };
  });
  consumer.close.mockImplementationOnce(async () => {
    await registered;
    await close?.();
  });
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  const handle = vi.fn(async () => {});
  const failed = vi.fn();
  const subscribing = broker.consume(handle, failed, () => true);
  await vi.waitFor(() => expect(consumer.consume).toHaveBeenCalledOnce());
  const paused = broker.pause();
  const late = delivery();
  consumer.deliver(late);
  release();
  await Promise.all([subscribing, paused]);
  expect(handle).not.toHaveBeenCalled();
  expect(consumer.requeued).toEqual([late]);
  await broker.consume(
    async (_command, ack) => {
      ack();
    },
    failed,
    () => true,
  );
  nextConsumer.deliver(late);
  await vi.waitFor(() => expect(nextConsumer.ack).toHaveBeenCalledWith(late));
  expect(failed).not.toHaveBeenCalled();
  await broker.close();
});

it('requeues a delivery without entering a handler when admission closes or the worker becomes busy', async () => {
  const { Broker, consumer } = await fixture();
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  const handle = vi.fn(async () => {});
  const failed = vi.fn();
  await broker.consume(handle, failed, () => false);
  const late = delivery();
  consumer.deliver(late);
  expect(broker.consuming).toBe(false);
  await vi.waitFor(() => expect(consumer.close).toHaveBeenCalledOnce());
  expect(consumer.requeued).toEqual([late]);
  expect(handle).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  await broker.close();
});

it('requeues if worker readiness changes between callback admission and handler entry', async () => {
  const { Broker, consumer, nextConsumer } = await fixture();
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  const failed = vi.fn();
  await broker.consume(
    async () => {
      throw new Error('WORKER_NOT_READY');
    },
    failed,
    () => true,
  );
  const late = delivery();
  consumer.deliver(late);
  await vi.waitFor(() => expect(consumer.requeued).toEqual([late]));
  expect(consumer.ack).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  await broker.consume(
    async (_command, ack) => {
      ack();
    },
    failed,
    () => true,
  );
  nextConsumer.deliver(late);
  await vi.waitFor(() => expect(nextConsumer.ack).toHaveBeenCalledWith(late));
  await broker.close();
});

it('keeps subscription paused across blocked admission and resumes after a later maintenance tick', async () => {
  const { Broker, consumer, nextConsumer } = await fixture();
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  let ready = false;
  const worker = {
    admissionReady: () => ready,
    needsMaintenance: () => !ready,
    reconcileOne: vi.fn(async () => {}),
    handleVideoProbe: vi.fn(async () => {}),
    handle: vi.fn(async (_command: ComputeCommandV1, ack: () => void) => {
      ack();
    }),
  };
  const failed = vi.fn();
  const maintenance = new Maintenance(broker, worker, failed);
  await maintenance.tick();
  await maintenance.tick();
  expect(consumer.close).toHaveBeenCalledOnce();
  expect(nextConsumer.consume).not.toHaveBeenCalled();
  expect(worker.reconcileOne).toHaveBeenCalledTimes(2);
  ready = true;
  await maintenance.tick();
  expect(broker.consuming).toBe(true);
  const message = delivery();
  nextConsumer.deliver(message);
  await vi.waitFor(() => expect(nextConsumer.ack).toHaveBeenCalledWith(message));
  expect(failed).not.toHaveBeenCalled();
  maintenance.stop();
  await broker.close();
});

it('does not proceed past pause after an accepted handler fails', async () => {
  const { Broker, consumer } = await fixture();
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const failed = vi.fn();
  await broker.consume(
    async () => {
      await gate;
      throw new Error('handler failed');
    },
    failed,
    () => true,
  );
  consumer.deliver(delivery());
  const paused = broker.pause();
  release();
  await expect(paused).rejects.toThrow('handler failed');
  expect(consumer.close).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledOnce();
  await broker.close();
});

it('runs a real worker maintenance window before starting the next delivery ACK clock', async () => {
  const { Broker, nextConsumer, thirdConsumer } = await fixture();
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  const root = mkdtempSync(join(tmpdir(), 'mio-maintenance-'));
  directories.push(root);
  const journal = new Journal(root, 'instance', true);
  const old = parseComputeCommandV1(JSON.parse(delivery().content.toString('utf8')) as unknown);
  const oldContent = Buffer.from('x');
  const digest = createHash('sha256').update(oldContent).digest('hex');
  let verifyStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    verifyStarted = resolve;
  });
  const events: ComputeResultV1[] = [];
  const wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  const store = {
    async download(_command: unknown, _directory: string, signal: AbortSignal) {
      await wait(600, signal);
      throw Object.assign(new Error('changed input'), { statusCode: 412 });
    },
    async head() {
      return { sizeBytes: 1, sha256: digest, etag: '"object"' };
    },
    async verify(_key: string, _size: number, _digest: string, signal: AbortSignal) {
      verifyStarted();
      await wait(600, signal);
      return true;
    },
    async upload() {},
  };
  const worker = new Worker(
    journal,
    store,
    {
      async publish(event) {
        events.push(event);
      },
    },
    root,
  );
  const failed = vi.fn();
  const maintenance = new Maintenance(broker, worker, failed);
  await maintenance.tick();
  journal.accept(old);
  journal.transition(old.attemptId, 'launching');
  journal.recordPid(old.attemptId, process.pid, processIdentity() as string);
  journal.recordOutput(old.attemptId, 1, digest);
  const unknown: ComputeResultV1 = {
    version: 1,
    type: 'transcode.result',
    messageId: randomUUID(),
    commandId: old.messageId,
    jobId: old.jobId,
    attemptId: old.attemptId,
    attempt: old.attempt,
    state: 'unknown',
    errorCode: 'UPLOAD_UNKNOWN',
  };
  journal.transition(old.attemptId, 'unknown_upload', unknown);
  journal.confirm(unknown.messageId);
  writeFileSync(paths(root, old.attemptId).output, oldContent);
  let closeChannel: () => void = () => {};
  const closing = new Promise<void>((resolve) => {
    closeChannel = resolve;
  });
  const originalClose = nextConsumer.close.getMockImplementation();
  nextConsumer.close.mockImplementationOnce(async () => {
    await closing;
    await originalClose?.();
  });
  const first = maintenance.tick();
  expect(maintenance.tick()).toBe(first);
  expect(broker.consuming).toBe(false);
  const late = delivery();
  const incoming = parseComputeCommandV1(JSON.parse(late.content.toString('utf8')) as unknown);
  nextConsumer.deliver(late);
  expect(journal.get(incoming.attemptId)).toBeNull();
  closeChannel();
  await started;
  expect(nextConsumer.requeued).toEqual([late]);
  expect(journal.get(incoming.attemptId)).toBeNull();
  await first;
  expect(broker.consuming).toBe(true);
  let cancelled = false;
  const timeout = setTimeout(() => {
    cancelled = true;
    worker.stop();
  }, 750);
  thirdConsumer.deliver(late);
  await vi.waitFor(() => expect(thirdConsumer.ack).toHaveBeenCalledWith(late), {
    timeout: 1800,
    interval: 20,
  });
  clearTimeout(timeout);
  expect(cancelled).toBe(false);
  expect(journal.get(incoming.attemptId)).toMatchObject({ phase: 'failed', ackDispatched: true });
  expect(
    events.some((event) => event.state === 'failed' && event.errorCode === 'WORKER_INTERRUPTED'),
  ).toBe(false);
  expect(failed).not.toHaveBeenCalled();
  maintenance.stop();
  worker.stop();
  await broker.close();
  journal.close();
}, 5000);

it('does not resume a stopped maintenance window after its in-flight recovery returns', async () => {
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const broker = { consuming: false, pause: vi.fn(async () => {}), consume: vi.fn(async () => {}) };
  const worker = {
    admissionReady: () => true,
    needsMaintenance: () => true,
    handleVideoProbe: vi.fn(async () => {}),
    reconcileOne: vi.fn(async () => {
      await pending;
    }),
    handle: vi.fn(async () => {}),
  };
  const maintenance = new Maintenance(broker, worker, () => {});
  const flight = maintenance.tick();
  await vi.waitFor(() => expect(worker.reconcileOne).toHaveBeenCalledOnce());
  maintenance.stop();
  finish();
  await flight;
  expect(broker.consume).not.toHaveBeenCalled();
});

it('aborts a backpressured unconfirmed publish on publisher-channel close and removes listeners', async () => {
  const { Broker, publisher } = await fixture();
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  const message: ComputeResultV1 = {
    version: 1,
    type: 'transcode.result',
    messageId: randomUUID(),
    commandId: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    attempt: 1,
    state: 'running',
  };
  const pending = broker.publish(message);
  expect(publisher.listenerCount('drain')).toBe(1);
  publisher.emit('close');
  await expect(pending).rejects.toThrow('BROKER_CLOSED');
  expect(publisher.listenerCount('drain')).toBe(0);
  expect(publisher.listenerCount('return')).toBe(0);
  await expect(broker.publish(message)).rejects.toThrow('BROKER_CLOSED');
  await broker.close();
});

it('rejects retired image recovery commands before entering a heavy-media handler', async () => {
  const { Broker, consumer } = await fixture();
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  const handle = vi.fn(async () => {});
  const failed = vi.fn();
  await broker.consume(handle, failed, () => true);
  const messageId = randomUUID();
  const message = {
    content: Buffer.from(
      JSON.stringify({
        version: 1,
        type: 'image.recover',
        messageId,
        commandId: randomUUID(),
        jobId: randomUUID(),
        sequence: 1,
      }),
    ),
    properties: { userId: 'app-a', contentType: 'application/json', messageId },
  } as ConsumeMessage;
  consumer.deliver(message);
  expect(consumer.reject).toHaveBeenCalledWith(message, false);
  expect(handle).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  await broker.close();
});

it('dispatches video.probe v1 to its dedicated handler without entering transcode', async () => {
  const { Broker, consumer } = await fixture();
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  const transcode = vi.fn(async (_command: ComputeCommandV1, ack: () => void) => ack());
  const probe = vi.fn(async (_command: VideoProbeCommandV1, ack: () => void) => ack());
  const failed = vi.fn();
  await broker.consume(transcode, failed, () => true, probe);
  const message = videoProbeDelivery();
  consumer.deliver(message);
  await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
  expect(transcode).not.toHaveBeenCalled();
  expect(probe.mock.calls[0]?.[0].source.stagingKey).toContain('mio/staging/video/');
  await vi.waitFor(() => expect(consumer.ack).toHaveBeenCalledWith(message));
  expect(consumer.reject).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  await broker.close();
});

it('publishes video.probe results on their separate v1 routing key', async () => {
  const { Broker, publisher } = await fixture();
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  publisher.publish.mockImplementation((...args) => {
    const confirm = args.at(-1) as (error: null) => void;
    confirm(null);
    return true;
  });
  const command = videoProbeDelivery();
  const request = JSON.parse(command.content.toString('utf8')) as VideoProbeCommandV1;
  const result = parseVideoProbeResultV1({
    version: 1,
    type: 'video.probe.result',
    messageId: randomUUID(),
    commandId: request.messageId,
    jobId: request.jobId,
    outputIndex: request.outputIndex,
    attemptId: request.attemptId,
    attempt: request.attempt,
    source: request.source,
    state: 'failed',
    errorCode: 'SOURCE_INVALID',
  });
  await broker.publishVideoProbe(result);
  expect(publisher.publish.mock.calls[0]?.[0]).toBe('mio.compute.results.v1');
  expect(publisher.publish.mock.calls[0]?.[1]).toBe('video.probe.result.v1');
  await broker.close();
});
