/** Enroll before the first await: closing an owner cannot miss a claimed task about to start I/O. */
export function createOwnerWork(isClosed: (owner: string) => Promise<boolean>) {
  const active = new Map<string, Set<{ stop: AbortController; task: Promise<unknown> }>>();
  return {
    run<T>(owner: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const stop = new AbortController();
      const entries = active.get(owner) ?? new Set();
      active.set(owner, entries);
      const task = Promise.resolve().then(async () => {
        if (await isClosed(owner)) throw new Error('ACCOUNT_DELETED');
        stop.signal.throwIfAborted();
        return run(stop.signal);
      });
      const entry = { stop, task };
      entries.add(entry);
      const done = () => {
        entries.delete(entry);
        if (!entries.size) active.delete(owner);
      };
      void task.then(done, done);
      return task;
    },
    async drain(owner: string) {
      const entries = [...(active.get(owner) ?? [])];
      for (const entry of entries) entry.stop.abort();
      await Promise.allSettled(entries.map((entry) => entry.task));
    },
  };
}
