import { randomUUID } from 'node:crypto';
import {
  AUDIO_COMMAND_QUEUE,
  AUDIO_RESULT_QUEUE,
  RESULT_QUEUE,
  type AudioInspectCommandV1,
  type AudioInspectResultV1,
  type AudioInspectionInput,
} from '@mio/compute-contracts';
import { expect, it } from 'vitest';
import { Broker } from '../../compute/src/adapters/rabbitmq.ts';
import { createAudioMediaClient } from '../../src/audio/media.ts';
import { withLocalTestBroker } from '../support/local-broker-fixture.ts';

function input(): AudioInspectionInput {
  const assetId = randomUUID();
  return {
    jobId: randomUUID(),
    assetId,
    key: `mio/raw/${assetId}/${randomUUID()}`,
    sizeBytes: 12345,
    etag: '"audio"',
    purpose: 'sample',
  };
}

function result(command: AudioInspectCommandV1, durationMs: number): AudioInspectResultV1 {
  return {
    version: 1,
    type: 'audio.inspect.result',
    messageId: randomUUID(),
    commandId: command.messageId,
    inspectionId: command.inspectionId,
    jobId: command.jobId,
    state: 'succeeded',
    inspection: {
      durationMs,
      format: 'wav',
      mimeType: 'audio/wav',
      codec: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      sizeBytes: 12345,
      sha256: 'a'.repeat(64),
    },
  };
}

it('routes independent stream cursors, confirmation and command redelivery through the broker', async () => {
  await withLocalTestBroker(
    async ({ appBrokerUrl, workerBrokerUrl, userA, userB, queueDefinitions }) => {
      const queues = await queueDefinitions();
      const stream = queues.find(({ name }) => name === AUDIO_RESULT_QUEUE);
      expect(stream).toMatchObject({
        type: 'stream',
        operator_policy: 'mio-audio-result-retention',
        effective_policy_definition: { 'max-length-bytes': 64 * 1024 ** 2 },
        arguments: expect.arrayContaining([
          ['x-max-age', 'longstr', '1h'],
          ['x-stream-max-segment-size-bytes', 'long', 8 * 1024 ** 2],
        ]),
      });
      expect(stream?.effective_policy_definition).not.toHaveProperty('overflow');
      for (const name of [AUDIO_COMMAND_QUEUE, RESULT_QUEUE])
        expect(queues.find((queue) => queue.name === name)).toMatchObject({
          type: 'quorum',
          operator_policy: 'mio-capacity',
          effective_policy_definition: {
            'max-length-bytes': 1024 ** 3,
            overflow: 'reject-publish',
          },
        });

      const config = { brokerURL: appBrokerUrl, brokerUser: userA, expectedResultUser: userB };
      const firstClient = createAudioMediaClient(config);
      const secondClient = createAudioMediaClient(config);
      const firstWorker = await Broker.connect(workerBrokerUrl, userB, userA);
      const secondWorker = await Broker.connect(workerBrokerUrl, userB, userA);
      const bothArrived = Promise.withResolvers<void>();
      const published = Promise.withResolvers<void>();
      const first = input();
      const second = input();
      const seen = new Set<string>();
      const workerFailure = Promise.withResolvers<never>();
      void workerFailure.promise.catch(() => {});
      const originalsAcked = Promise.withResolvers<void>();
      let acknowledgements = 0;
      const consume = async (worker: Broker) =>
        worker.consumeAudio(
          async (command, ack) => {
            seen.add(command.jobId);
            if (seen.size === 2) bothArrived.resolve();
            await bothArrived.promise;
            if (command.jobId === first.jobId) {
              await published.promise;
              await worker.publishAudio(result(command, 11_000));
            } else {
              // A different command ID with the same inspection/job must not settle the waiter.
              await worker.publishAudio({ ...result(command, 12_001), commandId: randomUUID() });
              await worker.publishAudio(result(command, 12_000));
              published.resolve();
            }
            ack();
            if (++acknowledgements === 2) originalsAcked.resolve();
          },
          workerFailure.reject,
          () => true,
        );
      try {
        await Promise.all([consume(firstWorker), consume(secondWorker)]);
        const deadline = AbortSignal.timeout(8_000);
        await expect(
          Promise.race([
            Promise.all([
              firstClient.inspect(first, deadline),
              secondClient.inspect(second, deadline),
            ]),
            workerFailure.promise,
          ]),
        ).resolves.toEqual([
          expect.objectContaining({ durationMs: 11_000 }),
          expect.objectContaining({ durationMs: 12_000 }),
        ]);
        expect(seen).toEqual(new Set([first.jobId, second.jobId]));
        await Promise.race([originalsAcked.promise, workerFailure.promise]);
      } finally {
        bothArrived.resolve();
        published.resolve();
        await Promise.all([firstWorker.close(), secondWorker.close()]);
      }

      const interruptedWorker = await Broker.connect(workerBrokerUrl, userB, userA);
      const interrupted = Promise.withResolvers<AudioInspectCommandV1>();
      const publishFailed = Promise.withResolvers<unknown>();
      const replacement = await Broker.connect(workerBrokerUrl, userB, userA);
      try {
        await interruptedWorker.consumeAudio(
          async (command) => {
            interrupted.resolve(command);
            throw new Error('SIMULATED_RESULT_CONFIRMATION_FAILURE');
          },
          publishFailed.resolve,
          () => true,
        );
        const inspected = firstClient.inspect(input(), AbortSignal.timeout(8_000));
        void inspected.catch(() => {});
        const command = await Promise.race([
          interrupted.promise,
          inspected.then(() => {
            throw new Error('UNEXPECTED_INSPECTION_COMPLETION');
          }),
        ]);
        expect(await publishFailed.promise).toMatchObject({
          message: 'SIMULATED_RESULT_CONFIRMATION_FAILURE',
        });
        await replacement.consumeAudio(
          async (value, ack) => {
            expect(value).toEqual(command);
            await replacement.publishAudio(result(value, 13_000));
            ack();
          },
          workerFailure.reject,
          () => true,
        );
        await interruptedWorker.close();
        await expect(Promise.race([inspected, workerFailure.promise])).resolves.toMatchObject({
          durationMs: 13_000,
        });
        await replacement.pause();

        const cancelled = secondClient.inspect(input(), AbortSignal.timeout(8_000));
        const assertion = expect(cancelled).rejects.toMatchObject({
          code: 'AUDIO_INSPECTION_UNAVAILABLE',
        });
        await secondClient.close();
        await assertion;
      } finally {
        await Promise.allSettled([
          firstClient.close(),
          secondClient.close(),
          interruptedWorker.close(),
          replacement.close(),
        ]);
      }
    },
  );
}, 90_000);
