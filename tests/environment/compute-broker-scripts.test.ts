import type * as ChildProcess from 'node:child_process';
import type * as Fs from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import type * as TimersPromises from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { readComputeBrokerEnvironment } from '../../scripts/service/compute-broker-env.ts';
import { compareMeasurements, observeCompute } from '../../scripts/service/observe-compute.ts';

const fixtures = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  query: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  mkdir: vi.fn(),
  realpath: async (path: string) => resolve(path),
  readFile: fixtures.readFile,
  writeFile: fixtures.writeFile,
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof Fs>()),
  createWriteStream: () =>
    new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFile: Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: async (command: string) => ({
      stdout:
        command === 'ps'
          ? '12345 1 0.1 19000 node\n'
          : JSON.stringify({ CPUPerc: '1%', MemUsage: '2 MiB / 1 GiB' }),
    }),
  }),
}));
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof TimersPromises>()),
  setTimeout: async (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
}));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      query = fixtures.query;
      async end() {}
    },
  },
}));

const composeEnv = [
  '  # private fixture',
  'RABBITMQ_DEFAULT_USER = "probe" # admin',
  "RABBITMQ_DEFAULT_PASS = 'quoted #= value'",
  'RABBITMQ_DEFAULT_VHOST = "isolated/test"',
  'RABBITMQ_AMQP_PORT = "56720"',
  'RABBITMQ_MANAGEMENT_PORT = "15680"',
  '',
].join('\r\n');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('reads the five Compose fields with dotenv rules and preserves an explicit loopback URL', () => {
  const result = readComputeBrokerEnvironment(composeEnv);
  expect(result).toMatchObject({
    user: 'probe',
    password: 'quoted #= value',
    vhost: 'isolated/test',
    amqpPort: '56720',
  });
  expect(result.management.origin).toBe('http://127.0.0.1:15680');

  const explicit = readComputeBrokerEnvironment(
    composeEnv.replace(
      'RABBITMQ_MANAGEMENT_PORT = "15680"',
      'RABBITMQ_MANAGEMENT_URL=http://127.0.0.1:15672/',
    ),
  );
  expect(explicit.management.origin).toBe('http://127.0.0.1:15672');
});

it.each([
  'https://127.0.0.1:15680/',
  'http://192.0.2.1:15680/',
  'http://name:password@127.0.0.1:15680/',
  'http://127.0.0.1:15680/admin',
  'http://127.0.0.1:15680/?extra=1',
  'http://127.0.0.1:15680/#fragment',
  '',
])('rejects explicit invalid management endpoints (%s)', (address) => {
  expect(() =>
    readComputeBrokerEnvironment(`${composeEnv}RABBITMQ_MANAGEMENT_URL="${address}"`),
  ).toThrow('BROKER_LOCAL_MANAGEMENT_REQUIRED');
});

it('rejects invalid inferred ports and missing credentials', () => {
  expect(() => readComputeBrokerEnvironment(composeEnv.replace('15680', '65536'))).toThrow(
    'BROKER_MANAGEMENT_PORT_INVALID',
  );
  expect(() =>
    readComputeBrokerEnvironment(composeEnv.replace(" 'quoted #= value'", ' ""')),
  ).toThrow('BROKER_ENV_MISSING');
});

it.each([
  { warmup: 1, duration: 600, monitorAvailable: true, eligible: false },
  { warmup: 60, duration: 2, monitorAvailable: true, eligible: false },
  { warmup: 60, duration: 600, monitorAvailable: true, eligible: true },
  { warmup: 60, duration: 600, monitorAvailable: false, eligible: false },
])(
  'runs observation sampling with $warmup s warmup and $duration s measurement (monitor $monitorAvailable)',
  async ({ warmup, duration, monitorAvailable, eligible }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    for (const [name, value] of Object.entries({
      OBSERVE_BASE_URL: 'http://127.0.0.1:18080',
      OBSERVE_COOKIE: 'probe=session',
      OBSERVE_ASSET_ID: '0'.repeat(36),
      OBSERVE_JOB_ID: '1'.repeat(36),
      OBSERVE_PG_URL: 'postgres://127.0.0.1/mio_regression_test',
      OBSERVE_MQ_ENV: '.runtime/private.env',
      OBSERVE_MQ_CONTAINER: 'isolated-container',
      OBSERVE_A_PID: '12345',
      OBSERVE_B_PID: '0',
      OBSERVE_QPS: '1',
      OBSERVE_WARMUP_SECONDS: String(warmup),
      OBSERVE_DURATION_SECONDS: String(duration),
      OBSERVE_SCENARIO: 'baseline',
      OBSERVE_OUTPUT_DIR: '.runtime/observation',
    }))
      vi.stubEnv(name, value);
    fixtures.readFile.mockResolvedValue(composeEnv);
    fixtures.query.mockResolvedValue({
      rows: [{ pending: 0, sent: 0, unfinished: 0, running: 0 }],
    });
    const fetchMock = vi.fn(async (url: URL) => {
      if (url.port === '18080') return new Response('ok');
      expect(url.origin).toBe('http://127.0.0.1:15680');
      expect(url.pathname).toContain('/api/queues/isolated%2Ftest/');
      if (!monitorAvailable) return new Response(null, { status: 503 });
      return Response.json({ messages_ready: 1, messages_unacknowledged: 0, consumers: 1 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = observeCompute();
    await vi.advanceTimersByTimeAsync((warmup + duration + 12) * 1000);
    await result;
    const summary = JSON.parse(fixtures.writeFile.mock.calls[0]![1] as string);
    expect(summary).toMatchObject({
      warmupSeconds: warmup,
      durationSeconds: duration,
      warmupTiming: { dispatched: warmup, missed: 0 },
      measuredTiming: { dispatched: duration, missed: 0 },
      eligible,
      measurement: { all: { count: duration, errors: 0 } },
    });
    expect(summary.monitoringErrors > 0).toBe(!monitorAvailable);
    expect(fixtures.query).toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.filter(([url]) => url.port === '15680').length,
    ).toBeGreaterThanOrEqual(4);
  },
);

it('rejects short or overlong baseline windows even when the summary claims eligibility', () => {
  const measurement = Object.fromEntries(
    ['all', 'health', 'ready', 'me', 'asset', 'job'].map((route) => [
      route,
      { count: 100, errors: 0, p95Ms: 30 },
    ]),
  );
  const baseline = {
    scenario: 'baseline',
    profileDigest: 'same-profile',
    warmupSeconds: 60,
    durationSeconds: 600,
    eligible: true,
    measurement,
    monitoringErrors: 0,
  };
  expect(compareMeasurements(measurement, baseline, true).conclusion).toBe(
    'thresholds_pass_scenario_unverified',
  );
  for (const window of [
    { warmupSeconds: 1 },
    { warmupSeconds: 61 },
    { durationSeconds: 599 },
    { monitoringErrors: 1 },
  ]) {
    expect(compareMeasurements(measurement, { ...baseline, ...window }, true)).toEqual({
      comparison: {},
      conclusion: 'inconclusive',
    });
  }
});
