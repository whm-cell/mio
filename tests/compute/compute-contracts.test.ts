import { expect, it } from 'vitest';
import {
  COMPUTE_PROFILE,
  parseComputeCommandV1,
  parseComputeResultV1,
} from '../../contracts/compute/src/index.ts';

const jobId = '11111111-1111-4111-8111-111111111111';
const attemptId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
const rawId = '44444444-4444-4444-8444-444444444444';
const commandId = '55555555-5555-4555-8555-555555555555';
const eventId = '66666666-6666-4666-8666-666666666666';
const command = {
  version: 1,
  type: 'transcode.request',
  messageId: commandId,
  jobId,
  attemptId,
  attempt: 1,
  profile: COMPUTE_PROFILE,
  input: { assetId, key: `mio/raw/${assetId}/${rawId}`, sizeBytes: 100, etag: '"raw"' },
};
const base = {
  version: 1,
  type: 'transcode.result',
  messageId: eventId,
  commandId,
  jobId,
  attemptId,
  attempt: 1,
};
const output = {
  key: `mio/derived/${jobId}/${attemptId}/result.mp4`,
  sizeBytes: 100,
  etag: '"output"',
  sha256: 'a'.repeat(64),
};

it('accepts only the frozen command shape and server-owned raw key', () => {
  expect(parseComputeCommandV1(command)).toEqual(command);
  const reordered = {
    input: { etag: command.input.etag, sizeBytes: 100, key: command.input.key, assetId },
    profile: COMPUTE_PROFILE,
    attempt: 1,
    attemptId,
    jobId,
    messageId: commandId,
    type: 'transcode.request',
    version: 1,
  };
  expect(JSON.stringify(parseComputeCommandV1(reordered))).toBe(
    JSON.stringify(parseComputeCommandV1(command)),
  );
  for (const value of [
    { ...command, owner: 'forged' },
    { ...command, version: 2 },
    { ...command, attempt: 4 },
    { ...command, input: { ...command.input, key: `mio/raw/${jobId}/${rawId}` } },
    { ...command, input: { ...command.input, sizeBytes: 1024 ** 3 + 1 } },
    { ...command, input: { ...command.input, etag: 'bad\nheader' } },
  ])
    expect(() => parseComputeCommandV1(value)).toThrow('COMPUTE_MESSAGE_INVALID');
});

it('accepts state-specific result shapes and rejects forged output paths or codes', () => {
  for (const value of [
    { ...base, state: 'running' },
    { ...base, state: 'succeeded', output },
    { ...base, state: 'failed', errorCode: 'WORKER_INTERRUPTED' },
    { ...base, state: 'unknown', errorCode: 'UPLOAD_UNKNOWN' },
  ])
    expect(parseComputeResultV1(value)).toEqual(value);
  const reordered = {
    output: {
      sha256: output.sha256,
      etag: output.etag,
      sizeBytes: output.sizeBytes,
      key: output.key,
    },
    state: 'succeeded',
    attempt: 1,
    attemptId,
    jobId,
    commandId,
    messageId: eventId,
    type: 'transcode.result',
    version: 1,
  };
  expect(JSON.stringify(parseComputeResultV1(reordered))).toBe(
    JSON.stringify(parseComputeResultV1({ ...base, state: 'succeeded', output })),
  );
  for (const value of [
    { ...base, state: 'running', output },
    { ...base, state: 'failed', errorCode: 'UPLOAD_UNKNOWN' },
    { ...base, state: 'unknown', errorCode: 'WORKER_INTERRUPTED' },
    {
      ...base,
      state: 'succeeded',
      output: { ...output, key: `mio/derived/${jobId}/${rawId}/result.mp4` },
    },
    { ...base, state: 'succeeded', output: { ...output, sha256: 'bad' } },
    { ...base, state: 'succeeded', output: { ...output, sizeBytes: 1024 ** 3 + 1 } },
  ])
    expect(() => parseComputeResultV1(value)).toThrow('COMPUTE_MESSAGE_INVALID');
});
