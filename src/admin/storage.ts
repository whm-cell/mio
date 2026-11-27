import { epochMs } from '@mio/foundation/time';
import { AdminError } from './contracts.ts';

export interface StorageSettings {
  readonly revision: number;
  readonly quotaBytes: number;
  readonly warningAvailableBytes: number;
}

/** User reads stay synchronous; failed refreshes cannot extend the five-second freshness window. */
export function createStoragePolicySnapshot(store: {
  initialStorageSettings: StorageSettings;
  initialStorageSettingsReadAt: number;
  readStorageSettings(): Promise<StorageSettings>;
}) {
  let value = Object.freeze({ ...store.initialStorageSettings });
  let observedAt = store.initialStorageSettingsReadAt;
  let pending: Promise<StorageSettings> | undefined;
  let closed = false;
  const save = (next: StorageSettings, started = epochMs()) => {
    if (
      !closed &&
      (next.revision > value.revision ||
        (next.revision === value.revision && started >= observedAt))
    ) {
      value = Object.freeze({ ...next });
      observedAt = started;
    }
    return value;
  };
  const refresh = () =>
    (pending ??= (async () => {
      const started = epochMs();
      return save(await store.readStorageSettings(), started);
    })().finally(() => {
      pending = undefined;
    }));
  const timer = setInterval(() => {
    void refresh().catch(() => {});
  }, 1000);
  timer.unref();
  return {
    save,
    refresh,
    get(): StorageSettings {
      if (closed || epochMs() >= observedAt + 5000)
        throw new AdminError(503, 'STORAGE_POLICY_UNAVAILABLE');
      return value;
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await pending?.catch(() => {});
    },
  };
}
