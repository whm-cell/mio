import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { connect } from 'amqplib';
import {
  VIDEO_PROBE_ADMISSION_MS,
  VIDEO_PROBE_EXECUTION_MS,
  VIDEO_PROBE_REPLY_MS,
} from '@mio/compute-contracts';
import type { VideoProbeCommandV1, VideoProbeResultV1 } from '@mio/compute-contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVideoProbeCoordinator } from '../../src/compute/transcode/video-probe.ts';
import { ComputeBroker, VideoProbePublishUnconfirmed } from '../../src/integrations/rabbitmq.ts';

vi.mock('amqplib', () => ({ connect: vi.fn() }));

const waitMs = VIDEO_PROBE_ADMISSION_MS + VIDEO_PROBE_EXECUTION_MS + VIDEO_PROBE_REPLY_MS;

function probe(): [VideoProbeCommandV1, Extract<VideoProbeResultV1, { state: 'succeeded' }>] {
  const jobId = randomUUID();
  const attemptId = randomUUID();
  const messageId = randomUUID();
  const source = {
    stagingKey: `mio/staging/video/${jobId}/0/${attemptId}.media`,
    sizeBytes: 1,
    etag: '"staging-etag"',
    sha256: 'a'.repeat(64),
  };
  const identity = { version: 1, jobId, attemptId, outputIndex: 0, attempt: 1, source } as const;
  return [
    { ...identity, type: 'video.probe', messageId },
    {
      ...identity,
      type: 'video.probe.result',
      messageId: randomUUID(),
      commandId: messageId,
      state: 'succeeded',
      media: {
        container: 'mp4',
        videoCodec: 'h264',
        width: 320,
        height: 240,
        durationSeconds: 1,
        hasAudio: false,
        audioCodec: null,
      },
    },
  ];
}

async function controlledBroker() {
  const consumer = Object.assign(new EventEmitter(), { prefetch: async () => {} });
  const publisher = Object.assign(new EventEmitter(), {
    prefetch: async () => {},
    publish: vi.fn((...args: [string, string, Buffer, object, (error: Error | null) => void]) => {
      void args;
      return true;
    }),
  });
  vi.mocked(connect)
    .mockResolvedValueOnce(
      Object.assign(new EventEmitter(), {
        createChannel: async () => consumer,
        close: async () => {},
      }) as never,
    )
    .mockResolvedValueOnce(
      Object.assign(new EventEmitter(), {
        createConfirmChannel: async () => publisher,
        close: async () => {},
      }) as never,
    );
  const broker = await ComputeBroker.connect('amqp://localhost', 'app', 'worker');
  const confirm = (error: Error | null) => publisher.publish.mock.calls[0]![4](error);
  return { broker, publisher, confirm };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each(['CONFIRM_TIMEOUT', 'channel closed'] as const)(
  'accepts a matching result through the complete probe window after %s',
  async (failure) => {
    const [command, result] = probe();
    const coordinator = createVideoProbeCoordinator();
    const { broker, publisher, confirm } = await controlledBroker();
    const publish = vi.fn(broker.publish.bind(broker));
    const dispatchedAt = Date.now();
    const pending = coordinator.run(command, publish, new AbortController().signal);
    const settled = vi.fn();
    void pending.then(settled, settled);
    try {
      expect(publish).toHaveBeenCalledExactlyOnceWith(
        command,
        dispatchedAt + VIDEO_PROBE_ADMISSION_MS,
      );
      expect(publisher.publish).toHaveBeenCalledOnce();
      if (failure === 'channel closed') {
        confirm(new Error(failure));
        publisher.emit('close');
      }

      await vi.advanceTimersByTimeAsync(waitMs - 1);
      const sending = publish.mock.results[0]!.value;
      await expect(sending).rejects.toBeInstanceOf(VideoProbePublishUnconfirmed);
      await expect(sending).rejects.toHaveProperty('cause.message', failure);
      expect(settled).not.toHaveBeenCalled();
      await expect(
        coordinator.receive({ ...result, source: { ...result.source, etag: '"other"' } }),
      ).rejects.toMatchObject({ message: 'VIDEO_PROBE_RESULT_MISMATCH', permanent: true });
      expect(settled).not.toHaveBeenCalled();
      await coordinator.receive(result);
      await expect(pending).resolves.toEqual(result.media);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await broker.close();
    }
  },
);

it('times out without a correlated result and releases the pending request at the deadline', async () => {
  const [command, result] = probe();
  const coordinator = createVideoProbeCoordinator();
  const pending = coordinator.run(command, async () => {}, new AbortController().signal);
  const settled = vi.fn();
  void pending.then(settled, settled);
  await vi.advanceTimersByTimeAsync(waitMs - 1);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).rejects.toThrow('VIDEO_PROBE_TIMEOUT');
  await expect(coordinator.receive(result)).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  const replay = coordinator.run(command, async () => {}, new AbortController().signal);
  await coordinator.receive(result);
  await expect(replay).resolves.toEqual(result.media);
});

it.each([
  ['MESSAGE_RETURNED', 'VIDEO_PROBE_PUBLISH_FAILED'],
  ['message nacked', 'VIDEO_PROBE_PUBLISH_FAILED'],
  ['pre-dispatch', 'VIDEO_PROBE_PUBLISH_FAILED'],
  ['unavailable', 'VIDEO_PROBE_PUBLISH_FAILED'],
  ['abort', 'VIDEO_PROBE_ABORTED'],
  ['close', 'VIDEO_PROBE_STOPPED'],
] as const)('releases pending state immediately on %s', async (failure, reason) => {
  const [command, result] = probe();
  const coordinator = createVideoProbeCoordinator();
  const controller = new AbortController();
  const { broker, publisher, confirm } = await controlledBroker();
  try {
    if (failure === 'unavailable') publisher.emit('close');
    if (failure === 'pre-dispatch')
      publisher.publish.mockImplementationOnce(() => {
        throw new Error('channel closed');
      });
    const pending = coordinator.run(command, broker.publish.bind(broker), controller.signal);
    if (failure === 'MESSAGE_RETURNED') {
      publisher.emit('return', { properties: { messageId: command.messageId } });
      confirm(new Error('channel closed'));
    }
    if (failure === 'message nacked') confirm(new Error(failure));
    if (failure === 'abort' || failure === 'close') {
      confirm(null);
      if (failure === 'abort') controller.abort();
      else coordinator.close();
    }
    const cause = {
      MESSAGE_RETURNED: 'MESSAGE_RETURNED',
      'message nacked': 'message nacked',
      'pre-dispatch': 'channel closed',
      unavailable: 'BROKER_CHANNEL_CLOSED',
      abort: undefined,
      close: undefined,
    }[failure];
    await expect(pending).rejects.toMatchObject({
      message: reason,
      ...(cause === undefined ? {} : { cause: expect.objectContaining({ message: cause }) }),
    });
    if (failure === 'unavailable') expect(publisher.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(coordinator.receive(result)).resolves.toBeUndefined();
  } finally {
    await broker.close();
  }
});
