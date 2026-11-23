import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  AUDIO_INSPECT_PROFILE,
  AUDIO_MAX_SAMPLE_BYTES,
  parseAudioInspectCommandV1,
  parseAudioInspectResultV1,
  type AudioInspectCommandV1,
  type AudioInspectResultV1,
} from '@mio/compute-contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { drainInput, prepareAudioDirectory } from '../src/adapters/media.ts';
import { AudioWorker } from '../src/audio-worker.ts';

const sampleRate = 16000;
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mio-audio-test-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function wave(seconds: number): Buffer {
  const dataSize = sampleRate * seconds * 2;
  const body = Buffer.alloc(44 + dataSize);
  body.write('RIFF', 0);
  body.writeUInt32LE(body.length - 8, 4);
  body.write('WAVEfmt ', 8);
  body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20);
  body.writeUInt16LE(1, 22);
  body.writeUInt32LE(sampleRate, 24);
  body.writeUInt32LE(sampleRate * 2, 28);
  body.writeUInt16LE(2, 32);
  body.writeUInt16LE(16, 34);
  body.write('data', 36);
  body.writeUInt32LE(dataSize, 40);
  return body;
}

function command(sizeBytes = 100): AudioInspectCommandV1 {
  const jobId = randomUUID();
  const assetId = randomUUID();
  return {
    version: 1,
    type: 'audio.inspect.request',
    profile: AUDIO_INSPECT_PROFILE,
    messageId: randomUUID(),
    inspectionId: randomUUID(),
    jobId,
    purpose: 'sample',
    input: { assetId, key: `mio/raw/${assetId}/${randomUUID()}`, sizeBytes, etag: '"etag"' },
  };
}

function fixture(body: Buffer, headDigest?: string) {
  const sha256 = createHash('sha256').update(body).digest('hex');
  const head = vi.fn(async () => ({
    sizeBytes: body.length,
    etag: '"etag"',
    sha256: headDigest ?? sha256,
  }));
  const download = vi.fn(async (value, path, signal) => {
    await drainInput(Readable.from([body]), path, value.attemptId, value.input.sizeBytes, signal);
  });
  const publishAudio = vi.fn<(message: AudioInspectResultV1) => Promise<void>>(async () => {});
  const scratch = prepareAudioDirectory(directory);
  const stop = new AbortController();
  const worker = new AudioWorker(
    { head, download },
    { publishAudio },
    directory,
    scratch,
    stop.signal,
  );
  const req = command(body.length);
  return { worker, req, head, download, publishAudio, sha256, scratch, stop };
}

it('parses exact resource identities and applies purpose-specific bounds before I/O', () => {
  const request = command();
  expect(parseAudioInspectCommandV1(request)).toEqual(request);
  for (const invalid of [
    { ...request, input: { ...request.input, key: `mio/raw/${randomUUID()}/${randomUUID()}` } },
    { ...request, input: { ...request.input, key: 'https://invalid.example/voice.wav' } },
    { ...request, input: { ...request.input, sizeBytes: AUDIO_MAX_SAMPLE_BYTES + 1 } },
    { ...request, input: { ...request.input, sha256: 'not a digest' } },
    { ...request, input: { ...request.input, sha256: '1'.repeat(64), secret: 'hidden' } },
  ])
    expect(() => parseAudioInspectCommandV1(invalid)).toThrow('AUDIO_MESSAGE_INVALID');
  const output = { ...request, purpose: 'output' };
  expect(parseAudioInspectCommandV1(output)).toEqual(output);
  expect(() =>
    parseAudioInspectCommandV1({
      ...output,
      input: { ...output.input, key: `mio/raw/${randomUUID()}/${randomUUID()}` },
    }),
  ).toThrow('AUDIO_MESSAGE_INVALID');
});

it('decodes the complete object and only ACKs after a confirmed result', async () => {
  const body = wave(11);
  const { worker, req, publishAudio, sha256, scratch, download } = fixture(body);
  req.input.sha256 = sha256;
  const confirm = Promise.withResolvers<void>();
  publishAudio.mockReturnValueOnce(confirm.promise);
  const ack = vi.fn();
  const work = worker.handle(req, ack);
  try {
    await vi.waitFor(() => expect(publishAudio).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(publishAudio).toHaveBeenCalledWith({
      version: 1,
      type: 'audio.inspect.result',
      messageId: expect.any(String),
      commandId: req.messageId,
      inspectionId: req.inspectionId,
      jobId: req.jobId,
      state: 'succeeded',
      inspection: {
        durationMs: 11_000,
        format: 'wav',
        mimeType: 'audio/wav',
        codec: 'pcm_s16le',
        sampleRate,
        channels: 1,
        sizeBytes: body.length,
        sha256,
      },
    });
    const emitted = publishAudio.mock.calls[0]![0];
    expect(parseAudioInspectResultV1(emitted)).toEqual(emitted);
    if (emitted.state !== 'succeeded') throw new Error('EXPECTED_MEDIA_FACTS');
    expect(() =>
      parseAudioInspectResultV1({
        ...emitted,
        inspection: { ...emitted.inspection, mimeType: 'audio/mpeg' },
      }),
    ).toThrow('AUDIO_MESSAGE_INVALID');
    expect(download.mock.calls[0]?.[0].input).toEqual(req.input);
    expect(await readdir(scratch)).toEqual([]);
    expect(ack).not.toHaveBeenCalled();
  } finally {
    confirm.resolve();
    await work;
  }
  expect(ack).toHaveBeenCalledOnce();
});

it.each([
  { name: 'sample is less than ten seconds', seconds: 9, code: 'AUDIO_DURATION_INVALID' },
  { name: 'sample decodes past five minutes', seconds: 302, code: 'AUDIO_DURATION_INVALID' },
  {
    name: 'matching metadata with a corrupt last frame',
    seconds: 11,
    trim: 1,
    code: 'AUDIO_INPUT_INVALID',
  },
  {
    name: 'metadata digest differs from bytes',
    seconds: 11,
    digest: '5'.repeat(64),
    code: 'AUDIO_INPUT_CHANGED',
  },
])('publishes failure when $name', async ({ seconds, trim, digest, code }) => {
  const bytes = wave(seconds);
  const { worker, req, publishAudio, scratch } = fixture(
    trim ? bytes.subarray(0, bytes.length - trim) : bytes,
    digest,
  );
  const ack = vi.fn();
  await worker.handle(req, ack);
  expect(publishAudio).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      state: 'failed',
      errorCode: code,
    }),
  );
  expect(ack).toHaveBeenCalledOnce();
  expect(await readdir(scratch)).toEqual([]);
});

it('rejects changed object identity before downloading and leaves a failed publication unacked', async () => {
  const { worker, req, head, download, publishAudio } = fixture(wave(11));
  head.mockResolvedValueOnce({
    sizeBytes: req.input.sizeBytes,
    etag: '"changed"',
    sha256: '0'.repeat(64),
  });
  publishAudio.mockRejectedValueOnce(new Error('CONFIRM_TIMEOUT'));
  const ack = vi.fn();
  await expect(worker.handle(req, ack)).rejects.toThrow('CONFIRM_TIMEOUT');
  expect(download).not.toHaveBeenCalled();
  expect(ack).not.toHaveBeenCalled();
  expect(publishAudio).toHaveBeenCalledWith(
    expect.objectContaining({ state: 'failed', errorCode: 'AUDIO_INPUT_CHANGED' }),
  );
});
