import { randomUUID } from 'node:crypto';
import { connect, type SocketOptions } from 'amqplib';
import { expect, it, vi } from 'vitest';
import { COMMAND_QUEUE, RESULT_QUEUE, type ComputeCommandV1 } from '@mio/compute-contracts';
import { Broker } from '../../compute/src/adapters/rabbitmq.ts';
import { ComputeBroker } from '../../src/integrations/rabbitmq.ts';
import { withLocalTestBroker } from '../support/local-broker-fixture.ts';

async function assertReadDenied(url: string, forbiddenQueue: string, drainedQueue?: string) {
  const socket: SocketOptions & { signal: AbortSignal } = { signal: AbortSignal.timeout(5_000) };
  const connection = await connect(url, socket);
  connection.on('error', () => {});
  try {
    const channel = await connection.createChannel();
    channel.on('error', () => {});
    if (drainedQueue) expect(await channel.get(drainedQueue, { noAck: false })).toBe(false);
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

it('routes an A command to B, honors the ACK, and refuses each role the other queue', async () => {
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
    const received = vi.fn<(value: ComputeCommandV1) => void>();
    const failed = vi.fn<(error: unknown) => void>();
    const app = await ComputeBroker.connect(appBrokerUrl, userA, userB);
    try {
      const worker = await Broker.connect(workerBrokerUrl, userB, userA);
      try {
        await worker.consume(
          async (value, ack) => {
            ack();
            received(value);
          },
          failed,
          () => true,
        );
        await app.publish(command);
        await vi.waitFor(() => expect(received).toHaveBeenCalledExactlyOnceWith(command), {
          timeout: 5_000,
        });
        // Closing this channel after ACK requeues any delivery that the broker still sees as unacked.
        await worker.pause();
        expect(failed).not.toHaveBeenCalled();
      } finally {
        await worker.close();
      }
    } finally {
      await app.close();
    }
    await assertReadDenied(workerBrokerUrl, RESULT_QUEUE, COMMAND_QUEUE);
    await assertReadDenied(appBrokerUrl, COMMAND_QUEUE);
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
