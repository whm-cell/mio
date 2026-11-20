import type * as Amqplib from 'amqplib';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { ConsumeMessage } from 'amqplib';
import { connect } from 'amqplib';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { COMMAND_EXCHANGE, COMMAND_ROUTING_KEY } from '@mio/compute-contracts';
import type { ComputeCommandV1 } from '@mio/compute-contracts';
import { ComputeBroker } from '../../src/integrations/rabbitmq.ts';
import { createComputeService } from '../../src/compute/service.ts';
import { ComputeError } from '../../src/compute/errors.ts';
import type { ComputeStore, JobRow } from '../../src/compute/store.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';

vi.mock('amqplib', () => ({ connect: vi.fn() }));
class TestChannel extends EventEmitter {
  prefetch = vi.fn(async () => {});
  ack = vi.fn();
  reject = vi.fn();
  publish = vi.fn((...args: [string, string, Buffer, object, (error: Error | null) => void]) => {
    void args;
    return true;
  });
  delivery: ((message: ConsumeMessage | null) => void) | undefined;
  consume = vi.fn(async (_queue: string, callback: (message: ConsumeMessage | null) => void) => {
    this.delivery = callback;
    return { consumerTag: 'test' };
  });
}
class TestConnection extends EventEmitter {
  readonly channel = new TestChannel();
  createChannel = vi.fn(async () => this.channel);
  createConfirmChannel = vi.fn(async () => this.channel);
  close = vi.fn(async () => {
    this.emit('close');
  });
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());
function connections() {
  const consumer = new TestConnection(),
    publisher = new TestConnection();
  vi.mocked(connect)
    .mockResolvedValueOnce(consumer as never)
    .mockResolvedValueOnce(publisher as never);
  return { consumer, publisher };
}
const open = () => ComputeBroker.connect('amqp://a:secret@127.0.0.1/test', 'a', 'b');

it.each(['amqp', 'amqps'])(
  'destroys a real %s startup socket on service cancellation',
  async (protocol) => {
    const actual = await vi.importActual<typeof Amqplib>('amqplib');
    vi.mocked(connect).mockImplementationOnce((url, options) => actual.connect(url, options));
    const accepted = Promise.withResolvers<Socket>();
    const server = createServer(accepted.resolve);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const stop = new AbortController();
    const failure = new Error('test shutdown');
    const connecting = ComputeBroker.connect(
      `${protocol}://127.0.0.1:${(server.address() as AddressInfo).port}`,
      'a',
      'b',
      stop.signal,
    ).catch((error: unknown) => error);
    const socket = await accepted.promise;
    try {
      await once(socket, 'data');
      const closed = once(socket, 'close');
      stop.abort(failure);
      expect(await Promise.race([connecting, delay(750, 'startup pending')])).toBe(failure);
      expect(await Promise.race([closed.then(() => 'closed'), delay(750, 'socket open')])).toBe(
        'closed',
      );
    } finally {
      socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await connecting;
    }
  },
);

it('applies the startup deadline to a stalled channel RPC and releases both transports', async () => {
  const pair = connections();
  pair.publisher.createConfirmChannel.mockImplementationOnce(() => new Promise(() => {}));
  vi.useFakeTimers();
  const connecting = open().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await connecting).toEqual(new Error('BROKER_STARTUP_TIMEOUT'));
  expect(pair.consumer.close).toHaveBeenCalledOnce();
  expect(pair.publisher.close).toHaveBeenCalledOnce();
  expect(
    vi
      .mocked(connect)
      .mock.calls.every(([, options]) => (options as { signal: AbortSignal }).signal.aborted),
  ).toBe(true);
});

it.each(['channel', 'consume'] as const)(
  'closes the PG pool when shutdown interrupts stalled %s setup',
  async (stage) => {
    const pair = connections();
    if (stage === 'channel')
      pair.publisher.createConfirmChannel.mockImplementationOnce(() => new Promise(() => {}));
    else pair.consumer.channel.consume.mockImplementationOnce(() => new Promise(() => {}));
    const store = {
      claim: vi.fn(async () => undefined),
      close: vi.fn(async () => {}),
    } as unknown as ComputeStore;
    vi.useFakeTimers();
    const service = createComputeService(store, {} as AssetObjectStore, {
      brokerURL: 'amqp://a:secret@127.0.0.1/test',
      brokerUser: 'a',
      expectedResultUser: 'b',
    });
    await vi.advanceTimersByTimeAsync(0);
    const closing = service.close();
    await vi.advanceTimersByTimeAsync(5000);
    await closing;
    expect(store.close).toHaveBeenCalledOnce();
    expect(pair.consumer.close).toHaveBeenCalledOnce();
    expect(pair.publisher.close).toHaveBeenCalledOnce();
  },
);

it('terminates a stalled close handshake at the deadline through the socket abort signals', async () => {
  const pair = connections();
  const broker = await open();
  const transports = vi
    .mocked(connect)
    .mock.calls.map(([, options]) => (options as { signal: AbortSignal }).signal);
  for (const [index, connection] of [pair.consumer, pair.publisher].entries()) {
    connection.close.mockImplementationOnce(() => new Promise(() => {}));
    transports[index]!.addEventListener('abort', () => connection.emit('close'), { once: true });
  }
  vi.useFakeTimers();
  const closing = broker.close();
  await vi.advanceTimersByTimeAsync(4999);
  expect(transports.every((signal) => !signal.aborted)).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  await closing;
  expect(transports.every((signal) => signal.aborted)).toBe(true);
});

it.each(['consumer', 'publisher'] as const)(
  'notifies when only the %s channel closes',
  async (which) => {
    const pair = connections();
    const broker = await open();
    const closed = vi.fn();
    broker.onClose(closed);
    pair[which].channel.emit('close');
    expect(closed).toHaveBeenCalledTimes(1);
    expect(pair.consumer.close).not.toHaveBeenCalled();
    expect(pair.publisher.close).not.toHaveBeenCalled();
    pair[which === 'consumer' ? 'publisher' : 'consumer'].channel.emit('close');
    expect(closed).toHaveBeenCalledTimes(1);
    await broker.close();
  },
);

it('remembers a channel close before the service installs its callback', async () => {
  const pair = connections();
  const broker = await open();
  pair.consumer.channel.emit('close');
  const closed = vi.fn();
  broker.onClose(closed);
  expect(closed).toHaveBeenCalledTimes(1);
  await broker.close();
});

it('rejects a channel already closed during setup and releases both connections', async () => {
  const pair = connections();
  pair.consumer.channel.prefetch.mockRejectedValueOnce(new Error('closed before observer'));
  await expect(open()).rejects.toThrow('closed before observer');
  expect(pair.consumer.close).toHaveBeenCalledOnce();
  expect(pair.publisher.close).toHaveBeenCalledOnce();
});

it('rejects a close observed between channel setup and broker return', async () => {
  const pair = connections();
  pair.publisher.channel.prefetch.mockImplementationOnce(async () => {
    pair.publisher.channel.emit('close');
  });
  await expect(open()).rejects.toThrow('BROKER_CHANNEL_CLOSED');
  expect(pair.consumer.close).toHaveBeenCalledOnce();
  expect(pair.publisher.close).toHaveBeenCalledOnce();
});

it('finishes failed setup when a connection closed before close() can settle', async () => {
  const pair = connections();
  pair.publisher.close.mockImplementationOnce(() => new Promise<void>(() => {}));
  pair.publisher.channel.prefetch.mockImplementationOnce(async () => {
    pair.publisher.emit('close');
    throw new Error('publisher connection lost');
  });
  const outcome = await Promise.race([
    open().then(
      () => 'unexpected success',
      (error: Error) => error.message,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('cleanup stalled'), 250)),
  ]);
  expect(outcome).toBe('publisher connection lost');
  expect(pair.consumer.close).toHaveBeenCalledOnce();
});

it('finishes close when the connection closes but its close() promise remains pending', async () => {
  const pair = connections();
  const broker = await open();
  pair.consumer.close.mockImplementationOnce(() => new Promise<void>(() => {}));
  const closing = broker.close();
  expect(broker.close()).toBe(closing);
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false);
  pair.consumer.emit('close');
  const outcome = await Promise.race([
    closing.then(() => 'closed'),
    new Promise<string>((resolve) => setTimeout(() => resolve('cleanup stalled'), 250)),
  ]);
  expect(outcome).toBe('closed');
  expect(pair.consumer.listenerCount('close')).toBe(0);
});

it('waits for close after an unrelated close error', async () => {
  const pair = connections();
  const broker = await open();
  const unrelated = Object.assign(new Error('another operation failed'), {
    name: 'IllegalOperationError',
  });
  pair.consumer.close.mockRejectedValueOnce(unrelated);
  let settled = false;
  const closing = broker.close().then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false);
  pair.consumer.emit('close');
  await closing;
});

it('removes a pending drain listener when publisher confirmation fails', async () => {
  const pair = connections();
  pair.publisher.channel.publish.mockImplementationOnce(
    (_exchange, _key, _body, _options, confirm) => {
      queueMicrotask(() => confirm(new Error('nack')));
      return false;
    },
  );
  const broker = await open();
  const assetId = randomUUID();
  await expect(
    broker.publish({
      version: 1,
      type: 'transcode.request',
      messageId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
      attempt: 1,
      profile: 'mp4-h264-aac-720p24-v1',
      input: { assetId, key: `mio/raw/${assetId}/${randomUUID()}`, sizeBytes: 1, etag: 'etag' },
    }),
  ).rejects.toThrow('nack');
  expect(pair.publisher.channel.listenerCount('drain')).toBe(0);
  expect(pair.publisher.channel.listenerCount('return')).toBe(0);
  await broker.close();
});

it.each(['channel-close', 'consumer-cancel'] as const)(
  'reconnects the result consumer after %s while TCP stays open',
  async (event) => {
    const first = connections();
    const second = connections();
    const store = {
      claim: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as ComputeStore;
    const service = createComputeService(store, {} as AssetObjectStore, {
      brokerURL: 'amqp://a:secret@127.0.0.1/test',
      brokerUser: 'a',
      expectedResultUser: 'b',
    });
    try {
      await vi.waitFor(() => expect(first.consumer.channel.consume).toHaveBeenCalled(), {
        timeout: 2000,
      });
      if (event === 'channel-close') first.consumer.channel.emit('close');
      else first.consumer.channel.delivery!(null);
      await vi.waitFor(() => expect(second.consumer.channel.consume).toHaveBeenCalled(), {
        timeout: 4000,
      });
    } finally {
      await service.close();
    }
  },
);

it.each(['handshake', 'immediate-close', 'consume', 'publish-and-close'] as const)(
  'backs off repeated %s failures through the cap and resets after a recovered outbox flush',
  async (failure) => {
    const retryDelays = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000];
    const attemptSize = failure === 'handshake' ? 1 : 2;
    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      if (failure === 'handshake') {
        vi.mocked(connect).mockRejectedValueOnce(new Error('handshake failed'));
        continue;
      }
      const pair = connections();
      if (failure === 'immediate-close')
        pair.consumer.channel.consume.mockImplementationOnce(async () => {
          pair.consumer.channel.emit('close');
          return { consumerTag: 'closed' };
        });
      else if (failure === 'consume')
        pair.consumer.channel.consume.mockRejectedValueOnce(new Error('registration failed'));
      else
        pair.publisher.channel.publish.mockImplementationOnce(
          (_exchange, _key, _body, _options, confirm) => {
            queueMicrotask(() => {
              pair.consumer.channel.emit('close');
              confirm(new Error('publish failed'));
            });
            return true;
          },
        );
    }
    const healthy = connections();
    healthy.publisher.channel.publish.mockImplementationOnce(
      (_exchange, _key, _body, _options, confirm) => {
        queueMicrotask(() => confirm(null));
        return true;
      },
    );
    vi.mocked(connect).mockRejectedValueOnce(new Error('unavailable after recovery'));
    const assetId = randomUUID();
    const command: ComputeCommandV1 = {
      version: 1,
      type: 'transcode.request',
      messageId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
      attempt: 1,
      profile: 'mp4-h264-aac-720p24-v1',
      input: { assetId, key: `mio/raw/${assetId}/${randomUUID()}`, sizeBytes: 1, etag: 'etag' },
    };
    let pending = true;
    const store = {
      claim: vi.fn(async () => (pending ? { command, lease: 'lease' } : undefined)),
      sent: vi.fn(async () => {
        pending = false;
      }),
      release: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as unknown as ComputeStore;
    vi.useFakeTimers();
    const service = createComputeService(store, {} as AssetObjectStore, {
      brokerURL: 'amqp://a:secret@127.0.0.1/test',
      brokerUser: 'a',
      expectedResultUser: 'b',
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      for (const [attempt, backoff] of retryDelays.entries()) {
        await vi.advanceTimersByTimeAsync(backoff - 1);
        expect(connect).toHaveBeenCalledTimes((attempt + 1) * attemptSize);
        expect(store.sent).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(connect).toHaveBeenCalledTimes(retryDelays.length * attemptSize + 2);
      expect(healthy.consumer.channel.consume).toHaveBeenCalledOnce();
      expect(store.sent).toHaveBeenCalledExactlyOnceWith(command, 'lease');
      expect(store.release).toHaveBeenCalledTimes(
        failure === 'publish-and-close' ? retryDelays.length : 0,
      );
      healthy.consumer.channel.emit('close');
      await vi.advanceTimersByTimeAsync(999);
      expect(connect).toHaveBeenCalledTimes(retryDelays.length * attemptSize + 2);
      await vi.advanceTimersByTimeAsync(1);
      expect(connect).toHaveBeenCalledTimes(retryDelays.length * attemptSize + 3);
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  },
);

it('ignores a delayed close from a broker already replaced after a registration failure', async () => {
  const stale = connections();
  stale.consumer.channel.consume.mockRejectedValueOnce(new Error('registration failed'));
  stale.consumer.close.mockImplementationOnce(() => new Promise(() => {}));
  stale.publisher.close.mockImplementationOnce(() => new Promise(() => {}));
  const healthy = connections();
  const store = {
    claim: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as ComputeStore;
  vi.useFakeTimers();
  const service = createComputeService(store, {} as AssetObjectStore, {
    brokerURL: 'amqp://a:secret@127.0.0.1/test',
    brokerUser: 'a',
    expectedResultUser: 'b',
  });
  try {
    await vi.advanceTimersByTimeAsync(1000);
    expect(healthy.consumer.channel.consume).toHaveBeenCalledOnce();
    expect(store.claim).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    stale.consumer.emit('close');
    stale.publisher.emit('close');
    await vi.advanceTimersByTimeAsync(500);
    expect(store.claim).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(4);
  } finally {
    stale.consumer.emit('close');
    stale.publisher.emit('close');
    await service.close();
    vi.useRealTimers();
  }
});

it('treats a synchronous result-handler failure as recoverable and never acknowledges it', async () => {
  const pair = connections();
  const broker = await open();
  const failed = vi.fn();
  await broker.consume(() => {
    throw new Error('closing');
  }, failed);
  const messageId = randomUUID();
  const result = {
    version: 1,
    type: 'transcode.result',
    messageId,
    commandId: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    attempt: 1,
    state: 'running',
  };
  pair.consumer.channel.delivery!({
    properties: { userId: 'b', messageId, contentType: 'application/json' },
    content: Buffer.from(JSON.stringify(result)),
  } as ConsumeMessage);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(failed).toHaveBeenCalledOnce();
  expect(pair.consumer.channel.ack).not.toHaveBeenCalled();
  await broker.close();
});

it.each(['conflict', 'transient', 'sink-failure'] as const)(
  'preserves result acknowledgment semantics through the service for %s',
  async (scenario) => {
    const pair = connections();
    const accept = vi.fn(async () => {
      if (scenario === 'conflict') throw new ComputeError(409, 'RESULT_CONFLICT');
      if (scenario === 'transient') throw new Error('database disconnected');
    });
    const store = {
      accept,
      claim: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as ComputeStore;
    const service = createComputeService(store, {} as AssetObjectStore, {
      brokerURL: 'amqp://a:secret@127.0.0.1/test',
      brokerUser: 'a',
      expectedResultUser: 'b',
    });
    const result = {
      version: 1,
      type: 'transcode.result',
      messageId: randomUUID(),
      commandId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
      attempt: 1,
      state: 'running',
    };
    const message = {
      properties: { userId: 'b', messageId: result.messageId, contentType: 'application/json' },
      content: Buffer.from(JSON.stringify(result)),
    } as ConsumeMessage;
    let output = '';
    try {
      await vi.waitFor(() => expect(pair.consumer.channel.consume).toHaveBeenCalled(), {
        timeout: 2000,
      });
      const sink =
        scenario === 'sink-failure'
          ? vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
              output += String(chunk);
              throw new Error('failed output');
            })
          : undefined;
      try {
        pair.consumer.channel.delivery!(message);
        await new Promise<void>((resolve) => setImmediate(resolve));
      } finally {
        sink?.mockRestore();
      }
      expect(accept).toHaveBeenCalledOnce();
      if (scenario === 'conflict') {
        expect(pair.consumer.channel.reject).toHaveBeenCalledWith(message, false);
        expect(pair.consumer.channel.ack).not.toHaveBeenCalled();
      } else if (scenario === 'transient') {
        expect(pair.consumer.channel.reject).not.toHaveBeenCalled();
        expect(pair.consumer.channel.ack).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(pair.consumer.close).toHaveBeenCalled());
      } else {
        expect(pair.consumer.channel.ack).toHaveBeenCalledWith(message);
        expect(JSON.parse(output)).toMatchObject({
          event: 'RESULT_COMMITTED',
          jobId: result.jobId,
          attemptId: result.attemptId,
          messageId: result.messageId,
        });
        expect(output).not.toContain('secret');
      }
    } finally {
      await service.close();
    }
  },
);

it('rejects a retired image result and continues committing later transcode results', async () => {
  const pair = connections();
  const store = {
    accept: vi.fn().mockResolvedValue(undefined),
    claim: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as ComputeStore;
  const service = createComputeService(store, {} as AssetObjectStore, {
    brokerURL: 'amqp://a:secret@127.0.0.1/test',
    brokerUser: 'a',
    expectedResultUser: 'b',
  });
  const image = {
    version: 1,
    type: 'image.result',
    messageId: randomUUID(),
    commandId: randomUUID(),
    jobId: randomUUID(),
    state: 'unknown',
    outputs: [],
  };
  const video = {
    version: 1,
    type: 'transcode.result',
    messageId: randomUUID(),
    commandId: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    attempt: 1,
    state: 'running',
  };
  const delivery = (result: typeof image | typeof video) =>
    ({
      properties: { userId: 'b', messageId: result.messageId, contentType: 'application/json' },
      content: Buffer.from(JSON.stringify(result)),
    }) as ConsumeMessage;
  try {
    await vi.waitFor(() => expect(pair.consumer.channel.consume).toHaveBeenCalled(), {
      timeout: 2000,
    });
    const retired = delivery(image),
      next = delivery(video);
    pair.consumer.channel.delivery!(retired);
    await vi.waitFor(() =>
      expect(pair.consumer.channel.reject).toHaveBeenCalledWith(retired, false),
    );
    expect(store.accept).not.toHaveBeenCalled();
    pair.consumer.channel.delivery!(next);
    await vi.waitFor(() => expect(pair.consumer.channel.ack).toHaveBeenCalledWith(next));
    expect(store.accept).toHaveBeenCalledOnce();
  } finally {
    await service.close();
  }
});

it('routes transcode commands and preserves bounded result prefetch', async () => {
  const pair = connections();
  pair.publisher.channel.publish.mockImplementation(
    (_exchange, _routingKey, _body, _options, confirm) => {
      queueMicrotask(() => confirm(null));
      return true;
    },
  );
  const broker = await open();
  expect(pair.consumer.channel.prefetch).toHaveBeenCalledWith(4);
  expect(pair.publisher.channel.prefetch).toHaveBeenCalledWith(1);
  const assetId = randomUUID();
  await broker.publish({
    version: 1,
    type: 'transcode.request',
    messageId: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    attempt: 1,
    profile: 'mp4-h264-aac-720p24-v1',
    input: { assetId, key: `mio/raw/${assetId}/${randomUUID()}`, sizeBytes: 1, etag: 'etag' },
  });
  expect(pair.publisher.channel.publish).toHaveBeenCalledOnce();
  expect(pair.publisher.channel.publish.mock.calls[0]?.[0]).toBe(COMMAND_EXCHANGE);
  expect(pair.publisher.channel.publish.mock.calls[0]?.[1]).toBe(COMMAND_ROUTING_KEY);
  await broker.close();
});

it('drains concurrent transcode result handlers and COS heads before closing connections and store', async () => {
  const pair = connections();
  const events: string[] = [];
  let releaseHeads: () => void = () => {};
  const headGate = new Promise<void>((resolve) => {
    releaseHeads = resolve;
  });
  const store = {
    current: vi.fn().mockResolvedValue(true),
    accept: vi.fn(async () => {
      events.push('accept');
    }),
    claim: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(async () => {
      events.push('store.close');
    }),
  } as unknown as ComputeStore;
  const objects = {
    head: vi.fn(async () => {
      events.push('head.start');
      await headGate;
      events.push('head.end');
      return { size: 3, etag: 'etag', sha256: 'a'.repeat(64) };
    }),
  } as unknown as AssetObjectStore;
  pair.consumer.close.mockImplementation(async () => {
    events.push('consumer.close');
    pair.consumer.emit('close');
  });
  const service = createComputeService(store, objects, {
    brokerURL: 'amqp://a:secret@127.0.0.1/test',
    brokerUser: 'a',
    expectedResultUser: 'b',
  });
  await vi.waitFor(() => expect(pair.consumer.channel.consume).toHaveBeenCalled(), {
    timeout: 2000,
  });
  const completed = () => {
    const jobId = randomUUID(),
      attemptId = randomUUID(),
      messageId = randomUUID();
    const result = {
      version: 1,
      type: 'transcode.result',
      messageId,
      commandId: randomUUID(),
      jobId,
      attemptId,
      attempt: 1,
      state: 'succeeded',
      output: {
        key: `mio/derived/${jobId}/${attemptId}/result.mp4`,
        sizeBytes: 3,
        etag: 'etag',
        sha256: 'a'.repeat(64),
      },
    };
    return {
      properties: { userId: 'b', messageId, contentType: 'application/json' },
      content: Buffer.from(JSON.stringify(result)),
    } as ConsumeMessage;
  };
  const first = completed(),
    second = completed(),
    late = completed();
  pair.consumer.channel.delivery!(first);
  pair.consumer.channel.delivery!(second);
  await vi.waitFor(() => expect(objects.head).toHaveBeenCalledTimes(2));
  const closing = service.close();
  pair.consumer.channel.delivery!(late);
  expect(objects.head).toHaveBeenCalledTimes(2);
  expect(pair.consumer.close).not.toHaveBeenCalled();
  expect(store.close).not.toHaveBeenCalled();
  releaseHeads();
  await closing;
  expect(pair.consumer.channel.ack).toHaveBeenCalledWith(first);
  expect(pair.consumer.channel.ack).toHaveBeenCalledWith(second);
  expect(pair.consumer.channel.ack).not.toHaveBeenCalledWith(late);
  expect(store.accept).toHaveBeenCalledTimes(2);
  expect(events.lastIndexOf('accept')).toBeLessThan(events.indexOf('consumer.close'));
  expect(events.indexOf('consumer.close')).toBeLessThan(events.indexOf('store.close'));
});

it('wakes transcode outbox draining immediately and coalesces concurrent admissions', async () => {
  const pair = connections();
  pair.publisher.channel.publish.mockImplementation(
    (_exchange, _routingKey, _body, _options, confirm) => {
      queueMicrotask(() => confirm(null));
      return true;
    },
  );
  const queue: { command: ComputeCommandV1; lease: string }[] = [];
  const assetId = randomUUID(),
    key = `mio/raw/${assetId}/${randomUUID()}`;
  const store = {
    request: vi.fn().mockResolvedValue(undefined),
    input: vi.fn().mockResolvedValue({ raw_key: key, size_bytes: '3' }),
    create: vi.fn(async (owner: string, requestId: string) => {
      const id = randomUUID(),
        attemptId = randomUUID(),
        commandId = randomUUID();
      const job: JobRow = {
        id,
        owner_id: owner,
        request_id: requestId,
        input_asset_id: assetId,
        input_key: key,
        input_size: '3',
        input_etag: 'etag',
        state: 'accepted',
        attempt: 1,
        attempt_id: attemptId,
        command_id: commandId,
        result_asset_id: null,
        error_code: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      queue.push({
        command: {
          version: 1,
          type: 'transcode.request',
          messageId: commandId,
          jobId: id,
          attemptId,
          attempt: 1,
          profile: 'mp4-h264-aac-720p24-v1',
          input: { assetId, key, sizeBytes: 3, etag: 'etag' },
        },
        lease: randomUUID(),
      });
      return { created: true, job };
    }),
    claim: vi.fn(async () => queue.shift()),
    sent: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as ComputeStore;
  const objects = {
    head: vi.fn(async () => ({ size: 3, etag: 'etag' })),
  } as unknown as AssetObjectStore;
  const service = createComputeService(store, objects, {
    brokerURL: 'amqp://a:secret@127.0.0.1/test',
    brokerUser: 'a',
    expectedResultUser: 'b',
  });
  try {
    await vi.waitFor(() => expect(pair.consumer.channel.consume).toHaveBeenCalled(), {
      timeout: 2000,
    });
    const startedAt = Date.now();
    await Promise.all(
      Array.from({ length: 15 }, () =>
        service.create({ userId: 'u1', sessionId: 's1' }, randomUUID(), assetId),
      ),
    );
    await vi.waitFor(() => expect(store.sent).toHaveBeenCalledTimes(15), {
      timeout: 500,
      interval: 10,
    });
    expect(Date.now() - startedAt).toBeLessThan(800);
  } finally {
    await service.close();
  }
});
