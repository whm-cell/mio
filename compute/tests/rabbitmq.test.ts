import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  COMPUTE_PROFILE,
  IMAGE_COMMAND_QUEUE,
  IMAGE_WORKER_PREFETCH,
  imageCommandCredentialBinding,
  parseComputeCommandV1,
} from '@mio/compute-contracts';
import type { ComputeCommandV1, ComputeResultV1 } from '@mio/compute-contracts';
import type { ConsumeMessage } from 'amqplib';
import { Journal } from '../src/adapters/journal.ts';
import { paths, processIdentity } from '../src/adapters/media.ts';
import { Maintenance } from '../src/maintenance.ts';
import { Worker } from '../src/worker.ts';
import { createImageWorker } from '../src/image-worker.ts';
import { sealImageKey } from '../../src/compute/image-credentials.ts';

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

afterEach(() => {
  vi.doUnmock('amqplib');
  vi.resetModules();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
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

it('waits for an in-flight paid image handler to save its response before broker close returns', async () => {
  const { Broker, consumer, publisher, consumerConnection, publisherConnection } = await fixture();
  publisher.publish.mockImplementation((...args: unknown[]) => {
    (args[4] as (error: null) => void)(null);
    return true;
  });
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');
  const root = mkdtempSync(join(tmpdir(), 'mio-image-close-'));
  directories.push(root);
  const instance = randomUUID();
  let journal = new Journal(root, instance, true);
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const input = { model: 'gpt-image-2', prompt: 'square' };
  const route = {
    driver: 'openai-images' as const,
    vendor: 'openai',
    submitPath: '/v1/images/generations',
    editPath: '/v1/images/edits',
    queryPathTemplate: null,
    requiresAsync: false,
    effectiveWatermark: null,
    paramSpec: {
      supportedOperations: ['generate', 'edit'] as const,
      requiresAsync: false,
      maxN: 10,
      allowExplicitN: true,
      allowedSizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
      allowCustomDimensions: true,
      maxReferenceImages: 16,
      allowGenerateReferences: false,
      allowMaskPng: true,
      allowOutpaintGeometry: false,
      allowedQualities: ['high', 'medium', 'low', 'auto'] as const,
      allowedBackgrounds: ['transparent', 'opaque', 'auto'] as const,
      allowedModerations: ['low', 'auto'] as const,
      allowedOutputFormats: ['png', 'jpeg', 'webp'] as const,
      allowOutputCompression: true,
      allowUserField: true,
      allowedAspectRatios: [],
      allowWatermarkOverride: false,
      async: null,
    },
    requestDefaults: { responseFormat: 'b64_json' as const },
    outputSpec: { fixedOutputFormat: null },
  };
  const jobId = randomUUID(),
    ownerId = randomUUID(),
    expiresAt = Date.now() + 60000;
  const baseCommand = {
    version: 1 as const,
    type: 'image.request' as const,
    profile: 'openai-images' as const,
    route,
    messageId: randomUUID(),
    jobId,
    ownerId,
    expiresAt,
    input,
  };
  const command = {
    ...baseCommand,
    credential: sealImageKey(
      'secret',
      imageCommandCredentialBinding(baseCommand),
      'b1',
      keys.publicKey,
    ),
  };
  let release: (response: Response) => void = () => {};
  const transport = vi.fn<typeof fetch>().mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  let output:
    | {
        key: string;
        sizeBytes: number;
        sha256: string;
        etag: string;
        contentType: string;
      }
    | undefined;
  const materialize = async (
    job: string,
    index: number,
    _data: string,
    format: string,
    fileId: string,
  ) => {
    output = {
      key: `mio/derived/${job}/images/${index}-${fileId}.${format}`,
      sizeBytes: 3,
      sha256: 'a'.repeat(64),
      etag: 'etag',
      contentType: `image/${format}`,
    };
    return output;
  };
  const worker = createImageWorker(journal, 'b1', keys.privateKey, materialize, transport);
  const failed = vi.fn();
  await broker.consume(
    async () => {},
    failed,
    () => true,
    async (image, ack) => {
      if (image.type !== 'image.request') throw new Error('unexpected');
      const result = await worker(image);
      await broker.publishImage({
        version: 1,
        type: 'image.result',
        messageId: randomUUID(),
        commandId: image.messageId,
        jobId: image.jobId,
        state: result.state,
        outputs: 'outputs' in result ? result.outputs : [],
        ...('errorCode' in result ? { errorCode: result.errorCode } : {}),
      });
      ack();
    },
  );
  const message = {
    content: Buffer.from(JSON.stringify(command)),
    properties: { userId: 'app-a', contentType: 'application/json', messageId: command.messageId },
  } as ConsumeMessage;
  consumer.deliver(message);
  await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
  const closing = broker.close();
  expect(consumerConnection.close).not.toHaveBeenCalled();
  expect(publisherConnection.close).not.toHaveBeenCalled();
  release(Response.json({ data: [{ b64_json: 'YWJj' }] }));
  await closing;
  expect(consumer.ack).toHaveBeenCalledWith(message);
  expect(failed).not.toHaveBeenCalled();
  expect(journal.image(jobId)?.phase).toBe('completed');
  journal.close();
  journal = new Journal(root, instance);
  expect(await createImageWorker(journal, '', '', materialize, transport)(command)).toEqual({
    state: 'completed',
    outputs: [output],
  });
  expect(transport).toHaveBeenCalledOnce();
  journal.close();
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

it('runs 4 concurrent distinct image jobs while video channel is busy, serializes same jobId, dead-letters invalid messages, and drains on close', async () => {
  const { Broker, nextConsumer, thirdConsumer, publisher } = await fixture();
  publisher.publish.mockImplementation((...args: unknown[]) => {
    (args[4] as (error: null) => void)(null);
    return true;
  });
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');

  let releaseVideo: () => void = () => {};
  const videoBlocked = new Promise<void>((resolve) => {
    releaseVideo = resolve;
  });
  let videoBusy = false;
  let videoStarted = false;
  const worker = {
    admissionReady: () => !videoBusy,
    needsMaintenance: () => false,
    reconcileOne: vi.fn(async () => {}),
    handle: vi.fn(async (_command: ComputeCommandV1, ack: () => void) => {
      videoBusy = true;
      videoStarted = true;
      await videoBlocked;
      videoBusy = false;
      ack();
    }),
  };

  let activeImages = 0;
  let maxConcurrency = 0;
  const activeByJob = new Map<string, number>();
  let maxSameJobConcurrency = 0;
  const executionOrder: string[] = [];
  const gates = new Map<string, { promise: Promise<void>; release: () => void }>();

  const makeGate = (key: string) => {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.set(key, { promise, release });
    return promise;
  };

  const failed = vi.fn();
  const maintenance = new Maintenance(broker, worker, failed, async (command, ack) => {
    activeImages += 1;
    maxConcurrency = Math.max(maxConcurrency, activeImages);
    const sameCount = (activeByJob.get(command.jobId) ?? 0) + 1;
    activeByJob.set(command.jobId, sameCount);
    maxSameJobConcurrency = Math.max(maxSameJobConcurrency, sameCount);
    executionOrder.push(`start:${command.messageId}`);
    try {
      const gate = gates.get(command.messageId);
      if (gate) await gate.promise;
      await broker.publishImage({
        version: 1,
        type: 'image.result',
        messageId: randomUUID(),
        commandId: command.type === 'image.recover' ? command.commandId : command.messageId,
        jobId: command.jobId,
        state: 'completed',
        outputs: [],
      });
      ack();
      executionOrder.push(`done:${command.messageId}`);
    } finally {
      activeByJob.set(command.jobId, (activeByJob.get(command.jobId) ?? 1) - 1);
      activeImages -= 1;
    }
  });

  await maintenance.tick();
  expect(nextConsumer.prefetch).toHaveBeenCalledWith(IMAGE_WORKER_PREFETCH);
  expect(nextConsumer.consume).toHaveBeenCalledWith(
    IMAGE_COMMAND_QUEUE,
    expect.any(Function),
    expect.objectContaining({ noAck: false }),
  );
  expect(broker.imageConsuming).toBe(true);

  // Occupy the video channel with a long-running video job and trigger a second video delivery + maintenance tick.
  const firstVideo = delivery();
  const secondVideo = delivery();
  thirdConsumer.deliver(firstVideo);
  await vi.waitFor(() => expect(videoStarted).toBe(true));
  thirdConsumer.deliver(secondVideo);
  await vi.waitFor(() => expect(broker.consuming).toBe(false));
  const backgroundTick = maintenance.tick();
  expect(broker.imageConsuming).toBe(true);

  const imageRecoverDelivery = (jobId: string, sequence: number) => {
    const command = {
      version: 1 as const,
      type: 'image.recover' as const,
      messageId: randomUUID(),
      commandId: randomUUID(),
      jobId,
      sequence,
    };
    return {
      command,
      message: {
        content: Buffer.from(JSON.stringify(command)),
        properties: {
          userId: 'app-a',
          contentType: 'application/json',
          messageId: command.messageId,
        },
      } as ConsumeMessage,
    };
  };

  // Misrouted video command & invalid sender on IMAGE_COMMAND_QUEUE must be dead-lettered immediately.
  const misroutedVideo = delivery();
  const wrongSender = {
    content: Buffer.from('{}'),
    properties: { userId: 'mallory', contentType: 'application/json', messageId: randomUUID() },
  } as ConsumeMessage;
  nextConsumer.deliver(misroutedVideo);
  nextConsumer.deliver(wrongSender);
  expect(nextConsumer.reject).toHaveBeenCalledWith(misroutedVideo, false);
  expect(nextConsumer.reject).toHaveBeenCalledWith(wrongSender, false);

  // Deliver 4 distinct jobIds concurrently while video is still blocked!
  const distinct = Array.from({ length: 4 }, (_, index) =>
    imageRecoverDelivery(randomUUID(), index + 1),
  );
  for (const item of distinct) {
    makeGate(item.command.messageId);
    nextConsumer.deliver(item.message);
  }
  await vi.waitFor(() => expect(activeImages).toBe(4));
  expect(maxConcurrency).toBe(4);
  for (const item of distinct) gates.get(item.command.messageId)?.release();
  await vi.waitFor(() =>
    expect(
      distinct.every((item) => nextConsumer.ack.mock.calls.some(([m]) => m === item.message)),
    ).toBe(true),
  );

  // Deliver 2 commands for the SAME jobId concurrently — must execute strictly serially!
  const sharedJobId = randomUUID();
  const sameFirst = imageRecoverDelivery(sharedJobId, 1);
  const sameSecond = imageRecoverDelivery(sharedJobId, 2);
  makeGate(sameFirst.command.messageId);
  nextConsumer.deliver(sameFirst.message);
  nextConsumer.deliver(sameSecond.message);
  await vi.waitFor(() => expect(executionOrder).toContain(`start:${sameFirst.command.messageId}`));
  expect(executionOrder).not.toContain(`start:${sameSecond.command.messageId}`);
  expect(maxSameJobConcurrency).toBe(1);
  gates.get(sameFirst.command.messageId)?.release();
  await vi.waitFor(() => expect(executionOrder).toContain(`done:${sameSecond.command.messageId}`));
  expect(maxSameJobConcurrency).toBe(1);
  expect(executionOrder.indexOf(`done:${sameFirst.command.messageId}`)).toBeLessThan(
    executionOrder.indexOf(`start:${sameSecond.command.messageId}`),
  );

  // Graceful close: drains in-flight image task + publishImage while requeueing late deliveries.
  const closingItem = imageRecoverDelivery(randomUUID(), 1);
  const lateItem = imageRecoverDelivery(randomUUID(), 2);
  makeGate(closingItem.command.messageId);
  nextConsumer.deliver(closingItem.message);
  await vi.waitFor(() =>
    expect(executionOrder).toContain(`start:${closingItem.command.messageId}`),
  );

  maintenance.stop();
  releaseVideo();
  await backgroundTick;
  const closing = broker.close();
  expect(broker.imageConsuming).toBe(false);
  nextConsumer.deliver(lateItem.message);
  expect(executionOrder).not.toContain(`start:${lateItem.command.messageId}`);

  gates.get(closingItem.command.messageId)?.release();
  await closing;

  expect(nextConsumer.ack).toHaveBeenCalledWith(closingItem.message);
  expect(nextConsumer.ack).not.toHaveBeenCalledWith(lateItem.message);
  expect(nextConsumer.requeued).toContain(lateItem.message);
  expect(failed).not.toHaveBeenCalled();
});

it('dead-letters IMAGE_COMMAND_CONFLICT / IMAGE_QUERY_UNKNOWN and isolates IMAGE_MATERIALIZATION_PENDING recovery without interrupting active video or healthy concurrent images', async () => {
  const { Broker, nextConsumer, thirdConsumer, fourthConsumer, publisher } = await fixture();
  publisher.publish.mockImplementation((...args: unknown[]) => {
    (args[4] as (error: null) => void)(null);
    return true;
  });
  const broker = await Broker.connect('amqp://localhost', 'worker-b', 'app-a');

  let releaseVideo: () => void = () => {};
  const videoGate = new Promise<void>((resolve) => {
    releaseVideo = resolve;
  });
  let videoRunning = false;
  const worker = {
    admissionReady: () => !videoRunning,
    needsMaintenance: () => false,
    reconcileOne: vi.fn(async () => {}),
    handle: vi.fn(async (_command: ComputeCommandV1, ack: () => void) => {
      videoRunning = true;
      await videoGate;
      videoRunning = false;
      ack();
    }),
  };

  let releaseHealthyImage: () => void = () => {};
  const healthyImageGate = new Promise<void>((resolve) => {
    releaseHealthyImage = resolve;
  });
  let healthyStarted = false;
  const behaviorByMessageId = new Map<
    string,
    'conflict' | 'query_unknown' | 'pending_once' | 'healthy'
  >();

  const failed = vi.fn();
  const maintenance = new Maintenance(
    broker,
    worker,
    failed,
    async (command, ack) => {
      const mode = behaviorByMessageId.get(command.messageId);
      if (mode === 'conflict') throw new Error('IMAGE_COMMAND_CONFLICT');
      if (mode === 'query_unknown') throw new Error('IMAGE_QUERY_UNKNOWN');
      if (mode === 'pending_once') {
        behaviorByMessageId.delete(command.messageId);
        throw new Error('IMAGE_MATERIALIZATION_PENDING');
      }
      if (mode === 'healthy') {
        healthyStarted = true;
        await healthyImageGate;
      }
      await broker.publishImage({
        version: 1,
        type: 'image.result',
        messageId: randomUUID(),
        commandId: command.type === 'image.recover' ? command.commandId : command.messageId,
        jobId: command.jobId,
        state: 'completed',
        outputs: [],
      });
      ack();
    },
    40,
  );

  await maintenance.tick();
  const makeRecover = (jobId = randomUUID()) => {
    const command = {
      version: 1 as const,
      type: 'image.recover' as const,
      messageId: randomUUID(),
      commandId: randomUUID(),
      jobId,
      sequence: 1,
    };
    return {
      command,
      message: {
        content: Buffer.from(JSON.stringify(command)),
        properties: {
          userId: 'app-a',
          contentType: 'application/json',
          messageId: command.messageId,
        },
      } as ConsumeMessage,
    };
  };

  // Legacy COMMAND_QUEUE rejects IMAGE_COMMAND_CONFLICT straight to DLQ before video starts.
  const legacyConflict = makeRecover();
  behaviorByMessageId.set(legacyConflict.command.messageId, 'conflict');
  thirdConsumer.deliver(legacyConflict.message);
  await vi.waitFor(() =>
    expect(thirdConsumer.reject).toHaveBeenCalledWith(legacyConflict.message, false),
  );

  // Start slow video transcode on thirdConsumer.
  const videoMsg = delivery();
  thirdConsumer.deliver(videoMsg);
  await vi.waitFor(() => expect(videoRunning).toBe(true));

  // IMAGE_COMMAND_CONFLICT and IMAGE_QUERY_UNKNOWN on IMAGE_COMMAND_QUEUE go straight to DLQ without closing channel.
  const imgConflict = makeRecover();
  const imgQueryUnknown = makeRecover();
  behaviorByMessageId.set(imgConflict.command.messageId, 'conflict');
  behaviorByMessageId.set(imgQueryUnknown.command.messageId, 'query_unknown');
  nextConsumer.deliver(imgConflict.message);
  nextConsumer.deliver(imgQueryUnknown.message);
  await vi.waitFor(() => {
    expect(nextConsumer.reject).toHaveBeenCalledWith(imgConflict.message, false);
    expect(nextConsumer.reject).toHaveBeenCalledWith(imgQueryUnknown.message, false);
  });
  expect(broker.imageConsuming).toBe(true);
  expect(failed).not.toHaveBeenCalled();

  // Start a healthy concurrent image job, then deliver a transient IMAGE_MATERIALIZATION_PENDING failure!
  const healthy = makeRecover();
  const transientFail = makeRecover();
  behaviorByMessageId.set(healthy.command.messageId, 'healthy');
  behaviorByMessageId.set(transientFail.command.messageId, 'pending_once');
  nextConsumer.deliver(healthy.message);
  await vi.waitFor(() => expect(healthyStarted).toBe(true));

  nextConsumer.deliver(transientFail.message);
  await vi.waitFor(() => expect(broker.imageConsuming).toBe(false));
  // Healthy image is still running: nextConsumer must NOT close until healthy finishes and acks!
  expect(nextConsumer.close).not.toHaveBeenCalled();
  expect(videoRunning).toBe(true);
  expect(failed).not.toHaveBeenCalled();

  // Even if Maintenance.tick() runs while closeImages() is still draining healthy, it must not throw BROKER_IMAGE_CONSUMER_BUSY.
  await maintenance.tick();
  expect(failed).not.toHaveBeenCalled();

  releaseHealthyImage();
  await vi.waitFor(() => expect(nextConsumer.close).toHaveBeenCalledOnce());
  expect(nextConsumer.ack).toHaveBeenCalledWith(healthy.message);
  expect(nextConsumer.requeued).toEqual([transientFail.message]);
  expect(videoRunning).toBe(true);

  // Maintenance bounded retry reopens fourthConsumer automatically while video is STILL running!
  await vi.waitFor(() => expect(fourthConsumer.consume).toHaveBeenCalledOnce(), { timeout: 1000 });
  expect(broker.imageConsuming).toBe(true);
  expect(videoRunning).toBe(true);

  // Redelivered transientFail succeeds and acks on fourthConsumer!
  fourthConsumer.deliver(transientFail.message);
  await vi.waitFor(() => expect(fourthConsumer.ack).toHaveBeenCalledWith(transientFail.message));
  expect(failed).not.toHaveBeenCalled();

  maintenance.stop();
  releaseVideo();
  await vi.waitFor(() => expect(thirdConsumer.ack).toHaveBeenCalledWith(videoMsg));
  await broker.close();
});
