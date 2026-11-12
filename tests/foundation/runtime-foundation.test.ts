import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createLogger } from '@mio/foundation/logging';
import { ApplicationError, HttpError } from '@mio/foundation/errors';
import { createId, isUuidV4 } from '@mio/foundation/identifiers';
import { sha256Utf8 } from '@mio/foundation/hash';
import { epochMs, monotonicMs, utcISOString } from '@mio/foundation/time';
import * as time from '@mio/foundation/time';
import { readBody, readJsonBody } from '../../src/http-request.ts';

afterEach(() => vi.useRealTimers());

it('emits only allowed UUID correlations and contains sink failures', () => {
  const lines: string[] = [];
  const requestId = createId();
  const jobId = createId();
  const log = createLogger('app', 'http', (line) => {
    lines.push(line);
  });
  log.child({ requestId, jobId }).warn('REQUEST_FAILED', {
    attemptId: 'cookie=secret',
    body: 'password secret',
    error: new Error('signed-url-secret'),
  } as never);
  const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(entry).toMatchObject({
    level: 'warn',
    service: 'app',
    component: 'http',
    event: 'REQUEST_FAILED',
    requestId,
    jobId,
  });
  expect(Object.keys(entry).sort()).toEqual([
    'component',
    'event',
    'jobId',
    'level',
    'requestId',
    'service',
    'timestamp',
  ]);
  expect(lines[0]).not.toMatch(/secret|password|cookie|signed-url/);
  createLogger('secret=value', 'cookie=secret', (line) => {
    lines.push(line);
  }).error('password=secret');
  expect(JSON.parse(lines[1]!)).toMatchObject({
    service: 'invalid',
    component: 'invalid',
    event: 'INVALID_EVENT',
  });
  expect(lines[1]).not.toContain('secret');
  expect(() =>
    createLogger('app', 'http', () => {
      throw new Error('sink');
    }).error('FAILED'),
  ).not.toThrow();
});

it('observes asynchronous sink rejection without changing the caller outcome', async () => {
  let reject!: (reason: Error) => void;
  const failure = new Promise<void>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  const handled = vi.spyOn(failure, 'catch');
  const log = createLogger('app', 'test', () => failure);
  const outcome = (() => {
    log.error('WRITE_FAILED');
    return 'business-completed';
  })();
  reject(new Error('asynchronous sink failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(handled).toHaveBeenCalledOnce();
  expect(outcome).toBe('business-completed');
});

it('drops output while a standard stream is backpressured and resumes on drain', () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(false);
  try {
    const log = createLogger('app', 'test');
    log.info('FIRST');
    log.info('DROPPED');
    expect(write).toHaveBeenCalledTimes(1);
    process.stdout.emit('drain');
    log.info('RESUMED');
    expect(write).toHaveBeenCalledTimes(2);
    process.stdout.emit('drain');
  } finally {
    write.mockRestore();
  }
});

it('keeps wall and monotonic clocks separate, and preserves basic primitive semantics', () => {
  const clock = { epochMs: () => 1_700_000_000_000, monotonicMs: () => 42 };
  expect(epochMs(clock)).toBe(1_700_000_000_000);
  expect(monotonicMs(clock)).toBe(42);
  expect(utcISOString(clock)).toBe('2023-11-14T22:13:20.000Z');
  expect(Object.keys(time)).not.toContain('systemClock');
  expect(sha256Utf8('abc')).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  const id = createId();
  expect(isUuidV4(id)).toBe(true);
  expect(isUuidV4('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toBe(false);
  const error = new HttpError(409, 'CONFLICT');
  expect(error).toBeInstanceOf(ApplicationError);
  expect(error).toMatchObject({ status: 409, code: 'CONFLICT', message: 'CONFLICT' });
});

function request(): PassThrough & IncomingMessage {
  return new PassThrough() as PassThrough & IncomingMessage;
}

it.each([8192, 16384])(
  'counts bytes at the %i boundary, including multibyte input',
  async (limit) => {
    const exact = request();
    const accepted = readBody(exact, limit);
    exact.end(Buffer.from('界'.repeat(Math.floor(limit / 3)) + 'x'.repeat(limit % 3)));
    expect((await accepted).length).toBe(limit);
    const excess = request();
    const rejected = readBody(excess, limit);
    excess.end(Buffer.alloc(limit + 1));
    await expect(rejected).rejects.toMatchObject({ status: 413, code: 'BODY_TOO_LARGE' });
    expect(excess.listenerCount('data')).toBe(0);
    expect(excess.listenerCount('aborted')).toBe(0);
  },
);

it('cleans up on abort and timeout and rejects malformed JSON', async () => {
  const aborted = request();
  const abortedResult = readBody(aborted);
  aborted.emit('aborted');
  await expect(abortedResult).rejects.toMatchObject({ status: 400, code: 'BODY_INVALID' });
  for (const event of ['data', 'end', 'error', 'aborted'])
    expect(aborted.listenerCount(event)).toBe(0);
  vi.useFakeTimers();
  const slow = request();
  const timed = readBody(slow);
  vi.advanceTimersByTime(10_000);
  await expect(timed).rejects.toMatchObject({ status: 408, code: 'BODY_TIMEOUT' });
  expect(slow.listenerCount('data')).toBe(0);
  const bad = request();
  const json = readJsonBody(bad);
  bad.end('[]');
  await expect(json).rejects.toMatchObject({ status: 400, code: 'BODY_INVALID' });
});
