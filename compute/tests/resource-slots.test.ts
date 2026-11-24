import { expect, it } from 'vitest';
import { ResourceSlots } from '../src/resource-slots.ts';

it('counts independent classes under a single total and releases a slot only once', () => {
  const slots = new ResourceSlots({ total: 2, encode: 3, probe: 2 });
  const first = slots.acquire('encode');
  const second = slots.acquire('encode');
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(slots.acquire('encode')).toBeNull();
  expect(slots.acquire('probe')).toBeNull();
  first!();
  first!();
  const probe = slots.acquire('probe');
  expect(probe).not.toBeNull();
  expect(slots.acquire('probe')).toBeNull();
  second!();
  probe!();
  expect(slots.available('probe')).toBe(true);
  expect(slots.available('encode')).toBe(true);
  expect(() => new ResourceSlots({ total: 1, encode: 1, probe: 1 })).toThrow(
    'WORKER_HARD_LIMIT_INVALID',
  );
});

it('does not bypass a HOLD, permits the other class, and removes cancelled waiters', async () => {
  const slots = new ResourceSlots();
  slots.setHold('encode', 'unsettled-1', true);
  slots.setHold('encode', 'unsettled-2', true);
  const cancelled = new AbortController();
  const waiting = slots.wait('encode', cancelled.signal);
  const rejected = expect(waiting).rejects.toThrow('fixture stop');
  cancelled.abort(new Error('fixture stop'));
  await rejected;
  const releaseProbe = await slots.wait('probe', new AbortController().signal);
  slots.setHold('encode', 'unsettled-1', false);
  expect(slots.acquire('encode')).toBeNull();
  const promise = slots.wait('encode', new AbortController().signal);
  slots.setHold('encode', 'unsettled-2', false);
  const releaseEncode = await promise;
  expect(slots.available('encode')).toBe(false);
  releaseEncode();
  releaseProbe();
  expect(slots.available('encode')).toBe(true);
});
