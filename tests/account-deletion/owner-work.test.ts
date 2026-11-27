import { expect, it } from 'vitest';
import { createOwnerWork } from '../../src/account-deletion/owner-work.ts';

it('waits for already admitted file I/O to settle before deletion and leaves other owners running', async () => {
  let closed = false;
  const work = createOwnerWork(async (owner) => owner === 'old' && closed);
  const oldEntered = Promise.withResolvers<AbortSignal>(),
    newEntered = Promise.withResolvers<AbortSignal>();
  const oldFinish = Promise.withResolvers<void>(),
    newFinish = Promise.withResolvers<void>();
  const events: string[] = [];
  const old = work.run('old', async (signal) => {
    oldEntered.resolve(signal);
    await oldFinish.promise;
    events.push('old-write');
  });
  const other = work.run('new', async (signal) => {
    newEntered.resolve(signal);
    await newFinish.promise;
  });
  const oldSignal = await oldEntered.promise,
    newSignal = await newEntered.promise;
  closed = true;
  const draining = work.drain('old').then(() => events.push('delete-old-files'));
  await Promise.resolve();
  expect(oldSignal.aborted).toBe(true);
  expect(newSignal.aborted).toBe(false);
  expect(events).toEqual([]);
  oldFinish.resolve();
  await old;
  await draining;
  expect(events).toEqual(['old-write', 'delete-old-files']);
  await expect(work.run('old', async () => events.push('late-write'))).rejects.toThrow(
    'ACCOUNT_DELETED',
  );
  newFinish.resolve();
  await other;
});

it('enrolls a claimed task before its asynchronous closed-user check so a concurrent drain cannot miss it', async () => {
  const query = Promise.withResolvers<boolean>();
  const work = createOwnerWork(() => query.promise);
  let started = false;
  const claimed = work.run('old', async () => {
    started = true;
  });
  const rejected = expect(claimed).rejects.toThrow();
  const drained = work.drain('old');
  query.resolve(false);
  await rejected;
  await drained;
  expect(started).toBe(false);
});
