import { performance } from 'node:perf_hooks';

export interface Clock {
  epochMs(): number;
  monotonicMs(): number;
}

const systemClock: Clock = {
  epochMs: () => Date.now(),
  monotonicMs: () => performance.now(),
};

export const epochMs = (clock: Clock = systemClock): number => clock.epochMs();
export const monotonicMs = (clock: Clock = systemClock): number => clock.monotonicMs();
export const utcISOString = (clock: Clock = systemClock): string =>
  new Date(clock.epochMs()).toISOString();
