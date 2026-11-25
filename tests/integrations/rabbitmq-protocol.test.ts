import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type SocketOptions } from 'amqplib';
import { expect, it, vi } from 'vitest';
import {
  COMMAND_QUEUE,
  RESULT_QUEUE,
  type ComputeCommandV1,
  type ComputeResultV1,
  type VideoProbeCommandV1,
  type VideoProbeResultV1,
} from '@mio/compute-contracts';
import { Journal } from '../../compute/src/adapters/journal.ts';
import { Broker } from '../../compute/src/adapters/rabbitmq.ts';
import { Maintenance } from '../../compute/src/maintenance.ts';
import { ResourceSlots } from '../../compute/src/resource-slots.ts';
import { Worker } from '../../compute/src/worker.ts';
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

it.each([false, true])(
  'routes video.probe with Worker observation enabled=%s',
  async (monitored) => {
    await withLocalTestBroker(async ({ appBrokerUrl, workerBrokerUrl, userA, userB }) => {
      const jobId = randomUUID();
      const attemptId = randomUUID();
      const command: VideoProbeCommandV1 = {
        version: 1,
        type: 'video.probe',
        messageId: randomUUID(),
        jobId,
        attemptId,
        outputIndex: 0,
        attempt: 1,
        source: {
          stagingKey: `mio/staging/video/${jobId}/0/${attemptId}.media`,
          sizeBytes: 1,
          etag: '"etag"',
          sha256: 'a'.repeat(64),
        },
      };
      const received = vi.fn<(value: VideoProbeResultV1) => void>();
      const transcodeResult = vi.fn();
      const failed = vi.fn();
      const assetId = randomUUID();
      const transcode: ComputeCommandV1 = {
        version: 1,
        type: 'transcode.request',
        messageId: randomUUID(),
        jobId: randomUUID(),
        attemptId: randomUUID(),
        attempt: 1,
        profile: 'mp4-h264-aac-720p24-v1',
        input: { assetId, key: `mio/raw/${assetId}/${randomUUID()}`, sizeBytes: 1, etag: 'etag' },
      };
      const downloadVideoProbe = vi.fn(async () => {
        throw new Error('SOURCE_CHANGED');
      });
      const slots = new ResourceSlots();
      if (monitored) slots.setLimits({ total: 1, encode: 0, probe: 1 });
      const directory = mkdtempSync(join(tmpdir(), 'mio-video-probe-broker-'));
      try {
        const journal = new Journal(directory, 'test-video-probe', true);
        try {
          const app = await ComputeBroker.connect(appBrokerUrl, userA, userB);
          try {
            await app.consume(
              async (value) => {
                transcodeResult(value);
              },
              failed,
              async (value) => {
                received(value);
              },
            );
            const broker = await Broker.connect(workerBrokerUrl, userB, userA);
            const worker = new Worker(
              journal,
              {
                async download() {
                  throw Object.assign(new Error('changed input'), { statusCode: 412 });
                },
                async head() {
                  return null;
                },
                async verify() {
                  return false;
                },
                upload: vi.fn(),
                downloadVideoProbe,
              },
              broker,
              directory,
              slots,
            );
            const maintenance = new Maintenance(broker, worker, failed, monitored);
            try {
              await maintenance.tick();
              if (monitored) {
                await app.publish(transcode);
                await vi.waitFor(() => expect(slots.snapshot().waiting.encode).toBe(1));
              }
              await app.publish({
                ...command,
                messageId: randomUUID(),
                source: { ...command.source, stagingKey: 'mio/staging/video/foreign' },
              });
              await app.publish(command);
              await vi.waitFor(
                () => {
                  expect(downloadVideoProbe).toHaveBeenCalledOnce();
                  expect(received).toHaveBeenCalledExactlyOnceWith(
                    expect.objectContaining({
                      type: 'video.probe.result',
                      commandId: command.messageId,
                      jobId,
                      attemptId,
                      outputIndex: 0,
                      attempt: 1,
                      source: command.source,
                      state: 'failed',
                      errorCode: 'SOURCE_CHANGED',
                    }),
                  );
                },
                { timeout: 5_000 },
              );
              expect(transcodeResult).not.toHaveBeenCalled();
              if (monitored) {
                expect(slots.snapshot().waiting.encode).toBe(1);
                slots.setLimits({ total: 1, encode: 1, probe: 1 });
                await vi.waitFor(() =>
                  expect(transcodeResult).toHaveBeenCalledWith(
                    expect.objectContaining({
                      jobId: transcode.jobId,
                      state: 'failed',
                      errorCode: 'INPUT_CHANGED',
                    }),
                  ),
                );
              }
              expect(failed).not.toHaveBeenCalled();
            } finally {
              maintenance.stop();
              worker.stop();
              await broker.close();
              await worker.waitIdle();
            }
          } finally {
            await app.close();
          }
        } finally {
          journal.close();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      await assertQueueBoundary(workerBrokerUrl, COMMAND_QUEUE, RESULT_QUEUE);
      await assertQueueBoundary(appBrokerUrl, RESULT_QUEUE, COMMAND_QUEUE);
    });
  },
  90_000,
);

it('verifies the vhost and both users are gone even when the protocol case throws', async () => {
  const failure = new Error('deliberate protocol case failure');
  // The fixture reports cleanup failures separately before propagating the exercise error.
  await expect(
    withLocalTestBroker(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
}, 90_000);
