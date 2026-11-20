import sharp from 'sharp';
import type { Sharp } from 'sharp';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { decodeMaterialImage } from '../../src/materials/decode.ts';

// Run explicitly in its own process. Only this probe adds load and shortens the native budget.
const input = await sharp(randomBytes(2048 * 2048 * 3), {
  raw: { width: 2048, height: 2048, channels: 3 },
})
  .png()
  .toBuffer();
const prototype: Sharp = sharp.prototype;
const timeout = prototype.timeout,
  raw = prototype.raw;
const stop = new AbortController();
let requestedBudget: number | undefined,
  rawCalls = 0;
let nativeFailure: string | undefined;
let abortTimer: ReturnType<typeof setTimeout> | undefined;
prototype.timeout = function (this: Sharp, options: Parameters<Sharp['timeout']>[0]) {
  requestedBudget = options.seconds;
  return timeout.call(this, { seconds: 1 });
};
prototype.raw = function (this: Sharp, ...args: Parameters<Sharp['raw']>) {
  rawCalls++;
  abortTimer = setTimeout(() => stop.abort(new Error('probe cancellation')), 20);
  const pipeline = raw.apply(this, args).resize(6000, 6000).blur(1000);
  const toBuffer = pipeline.toBuffer.bind(pipeline);
  pipeline.toBuffer = (async () => {
    try {
      return await toBuffer();
    } catch (error) {
      nativeFailure = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }) as Sharp['toBuffer'];
  return pipeline;
};
const guard = setTimeout(() => {
  console.log(JSON.stringify({ failed: 'native probe exceeded 10 seconds' }));
  process.exit(2);
}, 10000);
const began = performance.now();
let rejected = false,
  failure: string | undefined;
try {
  await decodeMaterialImage(input, 'image/png', stop.signal);
} catch (error) {
  rejected = true;
  failure = error instanceof Error ? error.message : String(error);
} finally {
  prototype.timeout = timeout;
  prototype.raw = raw;
  clearTimeout(guard);
  if (abortTimer) clearTimeout(abortTimer);
}
const elapsedMs = performance.now() - began;
const followup = await decodeMaterialImage(input, 'image/png', new AbortController().signal);
console.log(
  JSON.stringify({
    requestedBudget,
    probeBudget: 1,
    rawCalls,
    rejected,
    aborted: stop.signal.aborted,
    failure,
    nativeFailure,
    elapsedMs,
    followup: followup.width,
    sourceBytes: input.length,
  }),
);
if (
  !rejected ||
  !nativeFailure?.toLowerCase().includes('timeout') ||
  !stop.signal.aborted ||
  requestedBudget !== 15 ||
  rawCalls !== 1 ||
  elapsedMs > 6000 ||
  followup.width !== 2048
)
  process.exitCode = 1;
