import { monotonicMs } from '@mio/foundation/time';
import { createLogger } from '@mio/foundation/logging';
import type { StorageAccounting } from './storage-store.ts';
import type { StorageHolder } from './storage.ts';

const log = createLogger('app', 'storage-reconciliation');
export type StorageHolderSource = {
  type: string;
  read: (owner: string) => Promise<readonly StorageHolder[]>;
};

/** Keyset batches, one pass at a time. Source failures retain existing durable references. */
export function startStorageReconciliation(
  store: StorageAccounting,
  sources: readonly StorageHolderSource[],
) {
  let cursor = '';
  let nextCycleAt = 0;
  let pending: Promise<void> | undefined;
  let policyPending: Promise<void> | undefined;
  let closed = false;
  const syncOwner = async (owner: string) => {
    if (closed) return;
    await store.reconcileOwner(owner, sources);
  };
  const tick = () =>
    (pending ??= (async () => {
      if (!cursor && monotonicMs() < nextCycleAt) return;
      const owners = await store.owners(cursor);
      for (const owner of owners) {
        if (closed) return;
        await syncOwner(owner).catch(() => log.warn('STORAGE_OWNER_RECONCILIATION_UNAVAILABLE'));
        cursor = owner;
      }
      if (owners.length < 10) {
        cursor = '';
        nextCycleAt = monotonicMs() + 60_000;
      }
    })().finally(() => {
      pending = undefined;
    }));
  const timer = setInterval(() => {
    // Policy convergence must progress even while a different owner waits on its source or row lock.
    policyPending ??= store.updatePolicy().finally(() => {
      policyPending = undefined;
    });
    void policyPending.catch(() => log.warn('STORAGE_POLICY_PROJECTION_UNAVAILABLE'));
    void tick().catch(() => log.warn('STORAGE_RECONCILIATION_UNAVAILABLE'));
  }, 1000);
  timer.unref();
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      await Promise.allSettled([pending, policyPending]);
    },
  };
}
