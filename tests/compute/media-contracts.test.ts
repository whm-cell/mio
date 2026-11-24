import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MEDIA_MAX_MESSAGE_BYTES,
  MEDIA_OPERATIONS,
  MEDIA_PROFILE,
  parseMediaRequest,
  parseMediaCommand,
  parseMediaControl,
  parseMediaResult,
  parseMediaManifest,
  mediaObjectPrefix,
  mediaResourceClass,
} from '@mio/compute-contracts';
import type { MediaOperation } from '@mio/compute-contracts';
import {
  computePermissions,
  computeTopology,
} from '../../scripts/service/compute-broker-topology.ts';

const assetId = randomUUID(),
  jobId = randomUUID(),
  attemptId = randomUUID();
const examples: Record<MediaOperation, unknown> = {
  'media.probe': {},
  'video.reference_prepare': {},
  'video.derivatives': { profile: 'canvas' },
  'video.trim': { startSeconds: 1, endSeconds: 4 },
  'frames.extract': { mode: 'first_last' },
  'scenes.detect': {},
  'video.split': { boundaries: [1, 2] },
  'audio.extract': { profile: 'asr' },
  'audio.waveform': { points: 1024 },
  'audio.remux': {},
  'audio.concat': {},
  'media.export': { format: 'webm' },
  'subtitle.burn': { cues: [{ startSeconds: 0, endSeconds: 1, text: '你好，世界' }] },
  'composition.render': {
    resolution: '1080p',
    durationSeconds: 5,
    tracks: [{ kind: 'video', index: 0, locked: true }],
    items: [{ kind: 'video', track: 0, inputIndex: 0, startSeconds: 0, durationSeconds: 5 }],
  },
  'video.mix': { clips: [{ inputIndex: 0, startSeconds: 0, durationSeconds: 1 }], seed: 7 },
  'video.narration_render': { videoInputIndex: 0, narrationInputIndex: 1 },
};
function request(operation: MediaOperation = 'media.probe') {
  return {
    requestId: randomUUID(),
    operation,
    inputs: [
      { assetId },
      ...(['audio.remux', 'video.narration_render'].includes(operation)
        ? [{ assetId: randomUUID() }]
        : []),
    ],
    parameters: examples[operation],
  };
}
function command() {
  return {
    version: 1,
    type: 'media.request',
    messageId: randomUUID(),
    jobId,
    attemptId,
    attempt: 1,
    profile: MEDIA_PROFILE,
    operation: 'media.probe',
    inputs: [
      { assetId, key: `mio/raw/${assetId}/${randomUUID()}`, sizeBytes: 1024, etag: 'frozen-etag' },
    ],
    parameters: {},
  };
}
describe('media contract', () => {
  it('accepts exactly the sixteen application operations with typed bounded parameters', () => {
    expect(MEDIA_OPERATIONS).toHaveLength(16);
    for (const operation of MEDIA_OPERATIONS) {
      const example = request(operation);
      expect(parseMediaRequest(example).operation).toBe(operation);
      expect(() =>
        parseMediaRequest({
          ...example,
          parameters: { ...(example.parameters as object), arbitrary: true },
        }),
      ).toThrow('MEDIA_INPUT_INVALID');
    }
    expect(parseMediaCommand(command()).inputs[0]?.etag).toBe('frozen-etag');
  });
  it('rejects caller paths, URLs, commands, duplicate inputs and oversized envelopes', () => {
    for (const parameters of [
      { path: '/tmp/a' },
      { url: 'https://example.test' },
      { ffmpegArgs: ['-i'] },
      { filter: 'movie=/etc/passwd' },
    ])
      expect(() => parseMediaRequest({ ...request(), parameters })).toThrow();
    expect(() => parseMediaRequest({ ...request(), ownerId: 'other' })).toThrow();
    expect(() => parseMediaRequest({ ...request(), inputs: [{ assetId }, { assetId }] })).toThrow();
    expect(() =>
      parseMediaRequest({
        ...request(),
        inputs: Array.from({ length: 65 }, () => ({ assetId: randomUUID() })),
      }),
    ).toThrow();
    expect(() =>
      parseMediaRequest({ ...request(), blob: 'x'.repeat(MEDIA_MAX_MESSAGE_BYTES) }),
    ).toThrow();
    expect(() =>
      parseMediaCommand({
        ...command(),
        inputs: [{ ...command().inputs[0], key: 'mio/raw/../../secret' }],
      }),
    ).toThrow();
    expect(() => parseMediaCommand({ ...command(), attempt: 4 })).toThrow();
    expect(() => parseMediaCommand({ ...command(), profile: 'future' })).toThrow();
  });
  it('measures raw UTF-8 before parsing and rejects invalid encodings and old envelopes', () => {
    const payload = Buffer.from(JSON.stringify(command()));
    const padded = Buffer.concat([
      payload,
      Buffer.alloc(MEDIA_MAX_MESSAGE_BYTES - payload.length, 0x20),
    ]);
    expect(parseMediaCommand(padded).operation).toBe('media.probe');
    expect(() => parseMediaCommand(Buffer.concat([padded, Buffer.of(0x20)]))).toThrow(
      'MEDIA_INPUT_INVALID',
    );
    expect(() => parseMediaCommand(Buffer.concat([payload, Buffer.of(0xff)]))).toThrow(
      'MEDIA_INPUT_INVALID',
    );
    expect(() => parseMediaCommand({ ...command(), version: 2 })).toThrow('MEDIA_INPUT_INVALID');
    expect(() => parseMediaCommand({ ...command(), jobId: jobId + '\n' })).toThrow(
      'MEDIA_INPUT_INVALID',
    );
    const subtitles = Array.from({ length: 35 }, () => ({
      startSeconds: 0,
      endSeconds: 1,
      text: '界'.repeat(3000),
    }));
    const rawRequest = JSON.stringify({
      ...request('subtitle.burn'),
      parameters: { cues: subtitles },
    });
    expect(rawRequest.length).toBeLessThan(MEDIA_MAX_MESSAGE_BYTES);
    expect(Buffer.byteLength(rawRequest)).toBeGreaterThan(MEDIA_MAX_MESSAGE_BYTES);
    expect(() => parseMediaRequest(rawRequest)).toThrow('MEDIA_INPUT_INVALID');
  });
  it('enforces business limits and timeline ownership of referenced tracks/inputs', () => {
    for (const [operation, parameters] of [
      ['video.trim', { startSeconds: 0, endSeconds: 600.01 }],
      ['video.trim', { startSeconds: 2, endSeconds: 1 }],
      ['video.split', { boundaries: [2, 1] }],
      ['audio.waveform', { points: 4097 }],
      ['frames.extract', { mode: 'interval', intervalSeconds: 0 }],
      ['audio.extract', { profile: 'asr', format: 'mp3' }],
      ['subtitle.burn', { cues: [{ startSeconds: 1, endSeconds: 1, text: 'a' }] }],
    ] as const)
      expect(() => parseMediaRequest({ ...request(operation), parameters })).toThrow();
    const p = examples['composition.render'] as { items: Record<string, unknown>[] };
    expect(() =>
      parseMediaRequest({
        ...request('composition.render'),
        parameters: { ...p, items: [{ ...p.items[0], track: 1 }] },
      }),
    ).toThrow();
    expect(() =>
      parseMediaRequest({
        ...request('composition.render'),
        parameters: { ...p, items: Array(257).fill(p.items[0]) },
      }),
    ).toThrow();
  });
  it('binds every manifest object to one attempt and rejects arbitrary metadata', () => {
    const prefix = mediaObjectPrefix(jobId, attemptId);
    const file = {
      name: 'result.mp4',
      role: 'primary',
      contentType: 'video/mp4',
      key: prefix + 'result.mp4',
      sizeBytes: 1,
      etag: 'x',
      sha256: 'a'.repeat(64),
    };
    const manifest = {
      version: 1,
      jobId,
      attemptId,
      profile: MEDIA_PROFILE,
      operation: 'media.probe',
      files: [file],
      data: {},
    };
    expect(parseMediaManifest(manifest).files).toHaveLength(1);
    expect(() => parseMediaManifest({ ...manifest, files: [file, file] })).toThrow();
    expect(() =>
      parseMediaManifest({
        ...manifest,
        files: [{ ...file, key: mediaObjectPrefix(jobId, randomUUID()) + 'result.mp4' }],
      }),
    ).toThrow();
    expect(() => parseMediaManifest({ ...manifest, data: { credential: 'secret' } })).toThrow();
    expect(() => parseMediaManifest({ ...manifest, data: { waveform: [Infinity] } })).toThrow();
    const envelope = {
      version: 1,
      type: 'media.result',
      messageId: randomUUID(),
      commandId: randomUUID(),
      jobId,
      attemptId,
      attempt: 1,
    };
    expect(
      parseMediaResult({ ...envelope, state: 'reconciling', errorCode: 'PROCESS_UNKNOWN' }).state,
    ).toBe('reconciling');
    expect(() =>
      parseMediaResult({
        ...envelope,
        state: 'succeeded',
        manifest: { key: prefix + 'other.json', sizeBytes: 1, etag: 'x', sha256: 'a'.repeat(64) },
      }),
    ).toThrow();
    expect(
      parseMediaControl({
        version: 1,
        type: 'media.control',
        messageId: randomUUID(),
        jobId,
        attemptId,
        action: 'cancel',
      }).action,
    ).toBe('cancel');
  });
  it('provisions separate durable control and resource queues without widening runtime privileges', () => {
    const topology = computeTopology('test-media');
    for (const name of ['encode', 'probe', 'control']) {
      const queue = `mio.compute.media.${name}`;
      expect(topology.find((r) => r.path === `queues/test-media/${queue}`)?.body).toMatchObject({
        durable: true,
        arguments: {
          'x-queue-type': 'quorum',
          'x-delivery-limit': -1,
          'x-dead-letter-strategy': 'at-least-once',
        },
      });
      expect(new RegExp(computePermissions('b').read).test(queue)).toBe(true);
      expect(new RegExp(computePermissions('a').read).test(queue)).toBe(false);
      expect(new RegExp(computePermissions('b').read).test(`${queue}.dlq`)).toBe(false);
    }
    expect(mediaResourceClass('media.probe')).toBe('probe');
    expect(mediaResourceClass('composition.render')).toBe('encode');
  });
});
