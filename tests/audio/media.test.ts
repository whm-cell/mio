import { randomUUID } from 'node:crypto';
import type { AudioInspectCommandV1, AudioInspectionInput } from '@mio/compute-contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { ComputeBroker } from '../../src/integrations/rabbitmq.ts';
import { createAudioMediaClient } from '../../src/audio/media.ts';

const config = {
  brokerURL: 'amqp://a:test@127.0.0.1/test',
  brokerUser: 'a',
  expectedResultUser: 'b',
};

function input(): AudioInspectionInput {
  const assetId = randomUUID();
  return {
    jobId: randomUUID(),
    assetId,
    key: `mio/raw/${assetId}/${randomUUID()}`,
    sizeBytes: 352044,
    etag: '"audio"',
    purpose: 'sample',
  };
}

afterEach(() => vi.restoreAllMocks());

it('waits for its shared stream subscription and settles an inspection during a hung publish', async () => {
  const subscribed = Promise.withResolvers<void>();
  const publication = Promise.withResolvers<void>();
  const fake = {
    consumeAudio: vi.fn(() => subscribed.promise),
    onClose: vi.fn(),
    publishAudio: vi.fn<(command: AudioInspectCommandV1) => Promise<void>>(
      () => publication.promise,
    ),
    close: vi.fn(async () => {}),
  };
  vi.spyOn(ComputeBroker, 'connect').mockResolvedValue(fake as unknown as ComputeBroker);
  const client = createAudioMediaClient(config);
  const stop = new AbortController();
  try {
    const read = client.inspect(input(), stop.signal);
    const rejected = expect(read).rejects.toMatchObject({ code: 'AUDIO_INSPECTION_TIMEOUT' });
    await vi.waitFor(() => expect(fake.consumeAudio).toHaveBeenCalledOnce());
    expect(fake.publishAudio).not.toHaveBeenCalled();
    subscribed.resolve();
    await vi.waitFor(() => expect(fake.publishAudio).toHaveBeenCalledOnce());
    stop.abort();
    await rejected;
  } finally {
    subscribed.resolve();
    publication.resolve();
    await client.close();
  }
});

it('cancels waiters on disconnect and subscribes again before any later request', async () => {
  const first = {
    consumeAudio: vi.fn(async () => {}),
    onClose: vi.fn<(fn: () => void) => void>(),
    publishAudio: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const second = { ...first, publishAudio: vi.fn(async () => {}) };
  vi.spyOn(ComputeBroker, 'connect')
    .mockResolvedValueOnce(first as unknown as ComputeBroker)
    .mockResolvedValueOnce(second as unknown as ComputeBroker);
  const client = createAudioMediaClient(config);
  const stop = new AbortController();
  try {
    const lost = client.inspect(input(), stop.signal);
    const rejected = expect(lost).rejects.toMatchObject({ code: 'AUDIO_INSPECTION_UNAVAILABLE' });
    await vi.waitFor(() => expect(first.publishAudio).toHaveBeenCalledOnce());
    first.onClose.mock.calls[0]![0]();
    await rejected;
    const retry = client.inspect(input(), stop.signal);
    const retryRejected = expect(retry).rejects.toMatchObject({ code: 'AUDIO_INSPECTION_TIMEOUT' });
    await vi.waitFor(() => expect(second.publishAudio).toHaveBeenCalledOnce());
    expect(ComputeBroker.connect).toHaveBeenCalledTimes(2);
    expect(first.consumeAudio).toHaveBeenCalledTimes(2);
    stop.abort();
    await retryRejected;
  } finally {
    stop.abort();
    await client.close();
  }
});
