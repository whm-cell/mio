import { randomUUID } from 'node:crypto';
import { connect, type Channel, type ChannelModel, type SocketOptions } from 'amqplib';
import { expect, it, vi } from 'vitest';
import {
  COMMAND_EXCHANGE,
  MEDIA_CONTROL_QUEUE,
  MEDIA_CONTROL_ROUTING_KEY,
  MEDIA_ENCODE_QUEUE,
  MEDIA_ENCODE_ROUTING_KEY,
  MEDIA_PROBE_QUEUE,
  MEDIA_PROBE_ROUTING_KEY,
  MEDIA_PROFILE,
  MEDIA_RESULT_QUEUE,
  MEDIA_RESULT_ROUTING_KEY,
  MEDIA_VERSION,
  RESULT_EXCHANGE,
  WORKER_TELEMETRY_QUEUE,
  WORKER_TELEMETRY_ROUTING_KEY,
  parseMediaCommand,
  parseMediaControl,
  parseMediaResult,
  parseWorkerLimitsCommand,
  parseWorkerLimitsResult,
  workerControlQueue,
  workerControlRoutingKey,
} from '@mio/compute-contracts';
import { withLocalTestBroker } from '../support/local-broker-fixture.ts';

const primary = 'worker.one';
const secondary = 'worker.two';
const probeDlq = `${MEDIA_PROBE_QUEUE}.dlq`;

async function open(url: string) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5000);
  const options: SocketOptions & { signal: AbortSignal } = { signal: controller.signal };
  try {
    const connection = await connect(url, options);
    connection.on('error', () => {});
    return connection;
  } finally {
    clearTimeout(deadline);
  }
}

async function publisher(connection: ChannelModel, userId: string, exchange: string) {
  const channel = await connection.createConfirmChannel();
  channel.on('error', () => {});
  const returned: string[] = [];
  channel.on('return', (message) => returned.push(message.properties.messageId));
  return async <T extends { messageId: string }>(
    route: string,
    message: T,
    publishedUser = userId,
  ) => {
    channel.publish(exchange, route, Buffer.from(JSON.stringify(message)), {
      persistent: true,
      mandatory: true,
      contentType: 'application/json',
      messageId: message.messageId,
      userId: publishedUser,
    });
    await channel.waitForConfirms();
    expect(returned).not.toContain(message.messageId);
  };
}

async function get(channel: Channel, queue: string, userId: string) {
  const delivery = await channel.get(queue, { noAck: false });
  if (!delivery) throw new Error(`No delivery in ${queue}`);
  expect(delivery.properties.userId).toBe(userId);
  expect(delivery.properties.contentType).toBe('application/json');
  return delivery;
}

it('routes media and instance control over real AMQP with least permissions and durable dead letters', async () => {
  await withLocalTestBroker(
    async ({
      appBrokerUrl,
      workerBrokerUrl,
      userA,
      userB,
      queueDefinitions,
      restrictWorkerToObservation,
    }) => {
      const poisonId = randomUUID();
      let poisonBody: Buffer | undefined;
      const a = await open(appBrokerUrl);
      try {
        const b = await open(workerBrokerUrl);
        try {
          const sendCommand = await publisher(a, userA, COMMAND_EXCHANGE);
          const sendResult = await publisher(b, userB, RESULT_EXCHANGE);
          const receiveCommand = await b.createChannel();
          const receiveResult = await a.createChannel();
          receiveCommand.on('error', () => {});
          receiveResult.on('error', () => {});
          const assetId = randomUUID();
          const base = {
            version: MEDIA_VERSION,
            messageId: randomUUID(),
            jobId: randomUUID(),
            attemptId: randomUUID(),
          };
          const probe = {
            ...base,
            type: 'media.request',
            profile: MEDIA_PROFILE,
            operation: 'media.probe',
            attempt: 1,
            inputs: [
              { assetId, key: `mio/raw/${assetId}/${randomUUID()}`, sizeBytes: 1, etag: 'etag' },
            ],
            parameters: {},
          };
          const encode = {
            ...probe,
            messageId: randomUUID(),
            operation: 'video.trim',
            parameters: { startSeconds: 0, endSeconds: 1 },
          };
          const cancel = {
            ...base,
            messageId: randomUUID(),
            type: 'media.control',
            action: 'cancel',
          };
          const limits = {
            version: 1,
            type: 'worker.limits.command',
            messageId: randomUUID(),
            instanceId: primary,
            revision: 1,
            requestedBy: 'fixture-operator',
            requestedAt: 100,
            limits: { total: 2, encode: 1, probe: 1 },
          };
          const result = {
            ...base,
            type: 'media.result',
            messageId: randomUUID(),
            commandId: probe.messageId,
            attempt: 1,
            state: 'cancelled',
          };
          const applied = {
            version: 1,
            type: 'worker.limits.result',
            messageId: randomUUID(),
            commandId: limits.messageId,
            instanceId: primary,
            bootId: randomUUID(),
            bootSequence: 1,
            sequence: 1,
            observedAt: 101,
            revision: 1,
            status: 'applied',
            reason: null,
            limits: limits.limits,
          };
          await sendCommand(MEDIA_ENCODE_ROUTING_KEY, encode);
          await sendCommand(MEDIA_PROBE_ROUTING_KEY, probe);
          await sendCommand(MEDIA_CONTROL_ROUTING_KEY, cancel);
          await sendCommand(workerControlRoutingKey(primary), limits);
          await sendCommand(workerControlRoutingKey(secondary), {
            ...limits,
            instanceId: secondary,
            messageId: randomUUID(),
          });
          const heldEncode = await get(receiveCommand, MEDIA_ENCODE_QUEUE, userA);
          expect(parseMediaCommand(heldEncode.content)).toEqual(encode);
          for (const [queue, parse, expected] of [
            [MEDIA_PROBE_QUEUE, parseMediaCommand, probe],
            [MEDIA_CONTROL_QUEUE, parseMediaControl, cancel],
            [workerControlQueue(primary), parseWorkerLimitsCommand, limits],
          ] as const) {
            const message = await get(receiveCommand, queue, userA);
            expect(parse(message.content)).toEqual(expected);
            receiveCommand.ack(message);
          }
          receiveCommand.ack(heldEncode);
          await sendResult(MEDIA_RESULT_ROUTING_KEY, result);
          await sendResult(WORKER_TELEMETRY_ROUTING_KEY, applied);
          const mediaResult = await get(receiveResult, MEDIA_RESULT_QUEUE, userB);
          expect(parseMediaResult(mediaResult.content)).toEqual(result);
          receiveResult.ack(mediaResult);
          const workerResult = await get(receiveResult, WORKER_TELEMETRY_QUEUE, userB);
          expect(parseWorkerLimitsResult(workerResult.content)).toEqual(applied);
          receiveResult.ack(workerResult);

          const poison = { ...probe, messageId: poisonId, version: 9 };
          await sendCommand(MEDIA_PROBE_ROUTING_KEY, poison);
          const rejected = await get(receiveCommand, MEDIA_PROBE_QUEUE, userA);
          expect(() => parseMediaCommand(rejected.content)).toThrow('MEDIA_INPUT_INVALID');
          poisonBody = rejected.content;
          receiveCommand.reject(rejected, false);
          // Drain the reject frame on this channel before exercising permission-induced closures.
          await receiveCommand.prefetch(1);
          await expect(
            receiveCommand.get(workerControlQueue(secondary), { noAck: false }),
          ).rejects.toMatchObject({ code: 403 });
          await expect(
            receiveResult.get(MEDIA_CONTROL_QUEUE, { noAck: false }),
          ).rejects.toMatchObject({ code: 403 });
          await expect(
            sendCommand(MEDIA_PROBE_ROUTING_KEY, { ...probe, messageId: randomUUID() }, userB),
          ).rejects.toThrow();
        } finally {
          await b.close();
        }
      } finally {
        await a.close();
      }
      if (!restrictWorkerToObservation || !poisonBody)
        throw new Error('DLQ observation unavailable');
      const observer = await open(await restrictWorkerToObservation());
      try {
        const channel = await observer.createChannel();
        const delivery = await vi.waitFor(
          async () => {
            const value = await channel.get(probeDlq, { noAck: false });
            if (!value) throw new Error('Dead letter has not arrived');
            return value;
          },
          { timeout: 8000 },
        );
        expect(delivery.properties.messageId).toBe(poisonId);
        expect(delivery.content).toEqual(poisonBody);
        expect(delivery.properties.headers?.['x-death']).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ queue: MEDIA_PROBE_QUEUE, reason: 'rejected' }),
          ]),
        );
        channel.ack(delivery);
        await channel.prefetch(1);
      } finally {
        await observer.close();
      }
      const queues = await queueDefinitions();
      expect(queues.find(({ name }) => name === probeDlq)).toMatchObject({ type: 'quorum' });
      expect(queues.find(({ name }) => name === MEDIA_PROBE_QUEUE)).toMatchObject({
        type: 'quorum',
        effective_policy_definition: { 'max-length-bytes': 1024 ** 3, overflow: 'reject-publish' },
        arguments: expect.arrayContaining([
          ['x-dead-letter-strategy', 'longstr', 'at-least-once'],
          ['x-delivery-limit', 'long', -1],
        ]),
      });
    },
    { instanceId: primary, instanceIds: [primary, secondary], observeQueue: probeDlq },
  );
}, 90_000);
