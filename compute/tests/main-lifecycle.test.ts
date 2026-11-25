import type * as Timers from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { ResourceSlots } from '../src/resource-slots.ts';

const fixture = vi.hoisted(() => ({
  connect: vi.fn(),
  closeJournal: vi.fn(),
  slots: vi.fn(),
  backoffListeners: [] as number[],
}));

vi.mock('../src/adapters/journal.ts', () => ({
  Journal: class {
    close = fixture.closeJournal;
    hasUnknownProcess = () => false;
  },
  isJournalFailure: () => false,
}));
vi.mock('../src/adapters/cos.ts', () => ({ ObjectStore: class {} }));
vi.mock('../src/adapters/media.ts', () => ({ processIdentity: () => 'test-process' }));
vi.mock('../src/adapters/rabbitmq.ts', () => ({ Broker: { connect: fixture.connect } }));
vi.mock('../src/worker.ts', () => ({
  Worker: class {
    constructor(
      _journal: unknown,
      _store: unknown,
      _broker: unknown,
      _dir: string,
      slots: ResourceSlots,
    ) {
      fixture.slots(slots.snapshot().hard);
    }
    stop() {}
    async waitIdle() {}
  },
}));
vi.mock('../src/audio-runtime.ts', () => ({ runAudioRuntime: async () => {} }));
vi.mock('../src/media-runtime.ts', () => ({ runMediaRuntime: async () => {} }));
vi.mock('../src/adapters/media-process.ts', () => ({ checkMediaCapabilities: async () => {} }));
vi.mock('../src/maintenance.ts', () => ({
  Maintenance: class {
    async tick() {}
    stop() {}
    async wait() {}
  },
}));
vi.mock('node:timers/promises', async (original) => {
  const timers = await original<typeof Timers>();
  return {
    ...timers,
    setTimeout: async (_duration: number, _value: unknown, options: { signal: AbortSignal }) => {
      fixture.backoffListeners.push(getEventListeners(options.signal, 'abort').length);
    },
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

function stubWorkerEnvironment(overrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({
    MIO_COMPUTE_DIRECTORY: '/unused-fixture',
    MIO_COMPUTE_INSTANCE_ID: 'fixture',
    MIO_COMPUTE_HARD_MAX_TOTAL: '3',
    MIO_COMPUTE_HARD_MAX_ENCODE: '2',
    MIO_COMPUTE_HARD_MAX_PROBE: '1',
    RABBITMQ_URL: 'amqp://worker:fixture@127.0.0.1/test',
    MIO_COMPUTE_BROKER_USER: 'worker',
    MIO_COMPUTE_EXPECTED_COMMAND_USER: 'app',
    MIO_COS_BUCKET: 'fixture',
    MIO_COS_REGION: 'fixture',
    MIO_COS_SECRET_ID: 'fixture',
    MIO_COS_SECRET_KEY: 'fixture',
    ...overrides,
  }))
    vi.stubEnv(key, value);
  vi.stubEnv('MIO_COS_SESSION_TOKEN', undefined);
  vi.stubEnv('MIO_COMPUTE_WORKER_INSTANCE_IDS', undefined);
}

it('unsubscribes each reconnect lifetime before backoff and still stops the active round', async () => {
  const previous = new Set(process.listeners('SIGTERM'));
  const originalArgv = process.argv;
  process.argv = [originalArgv[0]!, 'worker', 'start'];
  stubWorkerEnvironment();
  const rounds: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  let stopping: AbortSignal | undefined;
  fixture.connect.mockImplementation(async (_url, _username, _expected, signal: AbortSignal) => {
    stopping = signal;
    const round = Promise.withResolvers<void>();
    rounds.push(round);
    return { closed: () => round.promise, close: async () => {} };
  });
  fixture.backoffListeners.length = 0;
  fixture.closeJournal.mockClear();
  let stop: (() => void) | undefined;
  try {
    await import('../src/main.ts');
    await vi.waitFor(() => expect(rounds).toHaveLength(1));
    expect(fixture.slots).toHaveBeenCalledWith({ total: 3, encode: 2, probe: 1 });
    stop = process.listeners('SIGTERM').find((listener) => !previous.has(listener)) as
      (() => void) | undefined;
    expect(stop).toBeTypeOf('function');
    for (let index = 0; index < 24; index++) {
      expect(getEventListeners(stopping!, 'abort')).toHaveLength(1);
      rounds[index]!.resolve();
      await vi.waitFor(() => expect(rounds).toHaveLength(index + 2));
    }
    expect(fixture.backoffListeners).toHaveLength(24);
    expect(fixture.backoffListeners.every((count) => count === 0)).toBe(true);
    stop!();
    await vi.waitFor(() => expect(fixture.closeJournal).toHaveBeenCalledOnce());
    expect(getEventListeners(stopping!, 'abort')).toHaveLength(0);
    expect(process.listeners('SIGTERM').filter((listener) => !previous.has(listener))).toEqual([]);
  } finally {
    stop?.();
    process.argv = originalArgv;
  }
});

it.each([
  ['MIO_COMPUTE_HARD_MAX_TOTAL', '1'],
  ['MIO_COMPUTE_HARD_MAX_ENCODE', '0'],
  ['MIO_COMPUTE_HARD_MAX_PROBE', '1.5'],
])('rejects %s=%s before connecting to RabbitMQ', async (key, value) => {
  const previous = new Set(process.listeners('SIGTERM'));
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  process.argv = [originalArgv[0]!, 'worker', 'start'];
  process.exitCode = undefined;
  stubWorkerEnvironment({ [key]: value });
  fixture.connect.mockReset().mockImplementation(
    (_url, _username, _expected, signal: AbortSignal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  try {
    await import('../src/main.ts');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(fixture.connect).not.toHaveBeenCalled();
  } finally {
    for (const listener of process.listeners('SIGTERM')) {
      if (!previous.has(listener)) listener('SIGTERM');
    }
    process.exitCode = originalExitCode;
    process.argv = originalArgv;
  }
});
