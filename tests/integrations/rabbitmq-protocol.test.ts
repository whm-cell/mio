import { randomUUID } from 'node:crypto';
import { connect, type SocketOptions } from 'amqplib';
import { expect, it, vi } from 'vitest';
import {
  COMMAND_QUEUE,
  RESULT_QUEUE,
  type ComputeCommandV1,
  type ComputeResultV1,
} from '@mio/compute-contracts';
import { Broker } from '../../compute/src/adapters/rabbitmq.ts';
import { ComputeBroker } from '../../src/integrations/rabbitmq.ts';
import { withLocalTestBroker } from '../support/local-broker-fixture.ts';

async function assertQueueBoundary(url: string, drainedQueue: string, forbiddenQueue: string) {
  const socket: SocketOptions & { signal: AbortSignal } = { signal: AbortSignal.timeout(5_000) };
  const connection = await connect(url, socket);
  connection.on('error', () => {});
  try {
    const channel = await connection.createChannel();
    channel.on('error', () => {});
    expect(await channel.get(drainedQueue, { noAck: false })).toBe(false);
    await expect(channel.consume(forbiddenQueue, () => {}, { noAck: false })).rejects.toMatchObject(
      {
        code: 403,
        message: expect.stringContaining('ACCESS_REFUSED'),
      },
    );
  } finally {
    await connection.close();
  }
}

it('routes an A command and B result, honors both ACKs, and refuses each role the other queue', async () => {
  await withLocalTestBroker(async ({ appBrokerUrl, workerBrokerUrl, userA, userB }) => {
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
    const result: ComputeResultV1 = {
      version: 1,
      type: 'transcode.result',
      messageId: randomUUID(),
      commandId: command.messageId,
      jobId: command.jobId,
      attemptId: command.attemptId,
      attempt: command.attempt,
      state: 'running',
    };
    const receivedCommand = vi.fn<(value: ComputeCommandV1) => void>();
    const receivedResult = vi.fn<(value: ComputeResultV1) => void>();
    const failed = vi.fn();
    const app = await ComputeBroker.connect(appBrokerUrl, userA, userB);
    try {
      await app.consume(async (value) => {
        receivedResult(value);
      }, failed);
      const worker = await Broker.connect(workerBrokerUrl, userB, userA);
      try {
        await worker.consume(
          async (value, ack) => {
            await worker.publish(result);
            ack();
            receivedCommand(value);
          },
          failed,
          () => true,
        );
        await app.publish(command);
        await vi.waitFor(
          () => {
            expect(receivedCommand).toHaveBeenCalledExactlyOnceWith(command);
            expect(receivedResult).toHaveBeenCalledExactlyOnceWith(result);
          },
          { timeout: 5_000 },
        );
        // Closing this channel after ACK requeues any delivery that the broker still sees as unacked.
        await worker.pause();
        expect(failed).not.toHaveBeenCalled();
      } finally {
        await worker.close();
      }
    } finally {
      await app.close();
    }
    await assertQueueBoundary(workerBrokerUrl, COMMAND_QUEUE, RESULT_QUEUE);
    await assertQueueBoundary(appBrokerUrl, RESULT_QUEUE, COMMAND_QUEUE);
  });
}, 90_000);

it('verifies the vhost and both users are gone even when the protocol case throws', async () => {
  const failure = new Error('deliberate protocol case failure');
  // The fixture reports cleanup failures separately before propagating the exercise error.
  await expect(
    withLocalTestBroker(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
}, 90_000);
