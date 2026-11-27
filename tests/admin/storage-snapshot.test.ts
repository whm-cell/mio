import { expect, it, vi } from 'vitest';
import { createStoragePolicySnapshot } from '../../src/admin/storage.ts';
import type { StorageSettings } from '../../src/admin/storage.ts';

const defaults = { revision: 0, quotaBytes: 5_368_709_120, warningAvailableBytes: 1_073_741_824 };

it('serves immutable synchronous snapshots without queries, converges across instances, and expires exactly at five seconds', async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => ({ ...defaults, revision: 1, quotaBytes: 8_589_934_592 }));
  const snapshot = createStoragePolicySnapshot({
    initialStorageSettings: defaults,
    initialStorageSettingsReadAt: Date.now(),
    readStorageSettings: read,
  });
  try {
    for (let i = 0; i < 20; i++) expect(snapshot.get()).toEqual(defaults);
    expect(read).not.toHaveBeenCalled();
    expect(Object.isFrozen(snapshot.get())).toBe(true);
    expect(() => {
      Object.assign(snapshot.get(), { quotaBytes: 1 });
    }).toThrow();
    await vi.advanceTimersByTimeAsync(999);
    expect(snapshot.get()).toEqual(defaults);
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshot.get()).toEqual({ ...defaults, revision: 1, quotaBytes: 8_589_934_592 });
    read.mockRejectedValue(new Error('admin offline'));
    snapshot.save({ ...defaults, revision: 2, quotaBytes: 9_663_676_416 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(snapshot.get()).toEqual({ ...defaults, revision: 2, quotaBytes: 9_663_676_416 });
    await vi.advanceTimersByTimeAsync(1);
    expect(() => snapshot.get()).toThrow('STORAGE_POLICY_UNAVAILABLE');
    read.mockResolvedValue({ ...defaults, revision: 3, quotaBytes: 10_737_418_240 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(snapshot.get()).toEqual({ ...defaults, revision: 3, quotaBytes: 10_737_418_240 });
  } finally {
    await snapshot.close();
    vi.useRealTimers();
  }
});

it('never lets a stale in-flight query overwrite or extend the lifetime of a locally saved revision', async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<StorageSettings>();
  const read = vi.fn(() => pending.promise);
  const snapshot = createStoragePolicySnapshot({
    initialStorageSettings: defaults,
    initialStorageSettingsReadAt: Date.now(),
    readStorageSettings: read,
  });
  try {
    const refresh = snapshot.refresh();
    snapshot.save({ ...defaults, revision: 1, quotaBytes: 8_589_934_592 });
    await vi.advanceTimersByTimeAsync(4000);
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve(defaults);
    expect(await refresh).toEqual({ ...defaults, revision: 1, quotaBytes: 8_589_934_592 });
    await vi.advanceTimersByTimeAsync(999);
    expect(snapshot.get().revision).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(() => snapshot.get()).toThrow('STORAGE_POLICY_UNAVAILABLE');
  } finally {
    await snapshot.close();
    vi.useRealTimers();
  }
});

it('bounds freshness from query start, refuses an old startup snapshot, and drains a single pending refresh on close', async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<StorageSettings>();
  const read = vi.fn(() => pending.promise);
  const snapshot = createStoragePolicySnapshot({
    initialStorageSettings: defaults,
    initialStorageSettingsReadAt: Date.now() - 5000,
    readStorageSettings: read,
  });
  try {
    expect(() => snapshot.get()).toThrow('STORAGE_POLICY_UNAVAILABLE');
    const refresh = snapshot.refresh();
    await vi.advanceTimersByTimeAsync(5000);
    pending.resolve({ ...defaults, revision: 1 });
    await refresh;
    expect(() => snapshot.get()).toThrow('STORAGE_POLICY_UNAVAILABLE');
    const next = Promise.withResolvers<StorageSettings>();
    read.mockImplementation(() => next.promise);
    await vi.advanceTimersByTimeAsync(1000);
    const finished = vi.fn();
    const closing = snapshot.close().then(finished);
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    next.resolve({ ...defaults, revision: 2 });
    await closing;
    expect(() => snapshot.get()).toThrow('STORAGE_POLICY_UNAVAILABLE');
    const count = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(count);
  } finally {
    await snapshot.close();
    vi.useRealTimers();
  }
});
