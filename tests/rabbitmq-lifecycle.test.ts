import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ConsumeMessage } from 'amqplib';
import { connect } from 'amqplib';
import { beforeEach, expect, it, vi } from 'vitest';
import { ComputeBroker } from '../src/integrations/rabbitmq.ts';
import { createComputeService } from '../src/compute/service.ts';
import type { ComputeStore } from '../src/compute/store.ts';
import type { AssetObjectStore } from '../src/assets/contracts.ts';

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
function connections() {
  const consumer = new TestConnection(),
    publisher = new TestConnection();
  vi.mocked(connect)
    .mockResolvedValueOnce(consumer as never)
    .mockResolvedValueOnce(publisher as never);
  return { consumer, publisher };
}
const open = () => ComputeBroker.connect('amqp://a:secret@127.0.0.1/test', 'a', 'b');

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
