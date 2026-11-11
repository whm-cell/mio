/**
 * P5 local observation. Set OBSERVE_BASE_URL, OBSERVE_COOKIE, OBSERVE_ASSET_ID,
 * OBSERVE_JOB_ID, OBSERVE_PG_URL, OBSERVE_MQ_ENV, OBSERVE_MQ_CONTAINER,
 * OBSERVE_A_PID, OBSERVE_SCENARIO and OBSERVE_OUTPUT_DIR.
 * Optional: OBSERVE_QPS (default 5), OBSERVE_WARMUP_SECONDS (60),
 * OBSERVE_DURATION_SECONDS (600), OBSERVE_B_PID (omit if B is absent),
 * OBSERVE_BASELINE_SUMMARY for other scenarios.
 * The output directory must be a new child of .runtime. A duration other than
 * 600 seconds is recorded as a short observation and is ineligible for P5.
 * Run only after the owner has established and documented the chosen scenario.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';

type Route = 'health' | 'ready' | 'me' | 'asset' | 'job';
type Scenario = 'baseline' | 'saturated' | 'offline' | 'backlog';
type Sample = {
  route: Route;
  scheduledOffsetMs: number;
  startedOffsetMs: number | null;
  latencyMs: number | null;
  status: number | null;
  ok: boolean;
};
type Stats = { count: number; errors: number; p95Ms: number | null };
type PhaseTiming = {
  startedAt: string;
  windowMs: number;
  completedMs: number;
  dispatched: number;
  missed: number;
  actualQps: number;
  maxLatenessMs: number;
};
type Baseline = {
  scenario: string;
  profileDigest: string;
  eligible: boolean;
  measurement: Record<string, Stats>;
  monitoringErrors: number;
};
type ProcessStats = {
  count: number;
  ffmpegProcesses: number;
  cpuPercent: number;
  rssKiB: number;
} | null;
type Observation = {
  at: string;
  a: ProcessStats;
  b: ProcessStats;
  broker: { cpuPercent: number; memoryBytes: number } | null;
  queues: Record<string, { ready: number; unacknowledged: number; consumers: number }> | null;
  database: { pending: number; sent: number; unfinished: number; running: number } | null;
};

const run = promisify(execFile);
const routes: Route[] = ['health', 'ready', 'me', 'asset', 'job'];
const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`MISSING_${key}`);
  return value;
};
function integer(key: string, fallback: number, min: number, max: number): number {
  const value = process.env[key] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
    throw new Error(`INVALID_${key}`);
  return Number(value);
}
function localUrl(value: string, protocols: string[]): URL {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || url.hostname !== '127.0.0.1')
    throw new Error('LOCAL_LOOPBACK_REQUIRED');
  return url;
}
function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        if (index < 1) throw new Error('MQ_ENV_INVALID');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}
function stats(samples: Sample[]): Stats {
  const sorted = samples
    .flatMap((sample) => (sample.latencyMs === null ? [] : [sample.latencyMs]))
    .sort((a, b) => a - b);
  return {
    count: samples.length,
    errors: samples.filter((sample) => !sample.ok).length,
    p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1]! : null,
  };
}
export function compareMeasurements(
  measurement: Record<string, Stats>,
  baseline: Baseline | null,
  eligible: boolean,
): {
  comparison: Record<string, { limitMs: number; actualMs: number; pass: boolean }>;
  conclusion: string;
} {
  const comparison: Record<string, { limitMs: number; actualMs: number; pass: boolean }> = {};
  if (!baseline) return { comparison, conclusion: 'baseline_only' };
  const keys = ['all', ...routes];
  if (
    !eligible ||
    !baseline.eligible ||
    baseline.monitoringErrors !== 0 ||
    !keys.every(
      (key) =>
        baseline.measurement[key]?.errors === 0 &&
        baseline.measurement[key]!.count > 0 &&
        baseline.measurement[key]!.p95Ms !== null &&
        Number.isFinite(baseline.measurement[key]!.p95Ms),
    )
  )
    return { comparison, conclusion: 'inconclusive' };
  for (const key of keys) {
    const reference = baseline.measurement[key]!.p95Ms!;
    const actual = measurement[key]?.p95Ms;
    if (
      actual !== null &&
      actual !== undefined &&
      Number.isFinite(actual) &&
      measurement[key]!.count > 0
    ) {
      const limitMs = Math.max(reference * 1.2, reference + 20);
      comparison[key] = {
        limitMs,
        actualMs: actual,
        pass: measurement[key]!.errors === 0 && actual <= limitMs,
      };
    }
  }
  const conclusion =
    Object.keys(comparison).length !== keys.length
      ? 'inconclusive'
      : Object.values(comparison).every((item) => item.pass)
        ? 'thresholds_pass_scenario_unverified'
        : 'thresholds_fail';
  return { comparison, conclusion };
}
function processTree(
  rows: { pid: number; parent: number; cpu: number; rss: number; ffmpeg: boolean }[],
  root: number,
): ProcessStats {
  if (!rows.some((row) => row.pid === root)) return null;
  const members = new Set([root]);
  let size = 0;
  while (size !== members.size) {
    size = members.size;
    for (const row of rows) if (members.has(row.parent)) members.add(row.pid);
  }
  const selected = rows.filter((row) => members.has(row.pid));
  return {
    count: selected.length,
    ffmpegProcesses: selected.filter((row) => row.ffmpeg).length,
    cpuPercent: selected.reduce((sum, row) => sum + row.cpu, 0),
    rssKiB: selected.reduce((sum, row) => sum + row.rss, 0),
  };
}
async function processes(
  aPid: number,
  bPid: number,
): Promise<{ a: ProcessStats; b: ProcessStats }> {
  const { stdout } = await run(
    'ps',
    ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pcpu=', '-o', 'rss=', '-o', 'comm='],
    { timeout: 5000, maxBuffer: 2_000_000 },
  );
  const rows = stdout
    .trim()
    .split('\n')
    .flatMap((line) => {
      const parts = /^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line.trim());
      return parts
        ? [
            {
              pid: Number(parts[1]),
              parent: Number(parts[2]),
              cpu: Number(parts[3]),
              rss: Number(parts[4]),
              ffmpeg: basename(parts[5]!) === 'ffmpeg',
            },
          ]
        : [];
    });
  return { a: processTree(rows, aPid), b: processTree(rows, bPid) };
}
function byteSize(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|KiB|MiB|GiB)$/.exec(text.trim());
  if (!match) throw new Error('DOCKER_MEMORY_INVALID');
  const units: Record<string, number> = {
    B: 1,
    kB: 1000,
    MB: 1e6,
    GB: 1e9,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
  };
  return Number(match[1]) * units[match[2]!]!;
}
async function brokerStats(container: string): Promise<Observation['broker']> {
  const { stdout } = await run(
    'docker',
    ['stats', '--no-stream', '--format', '{{json .}}', container],
    { timeout: 8000, maxBuffer: 100_000 },
  );
  const result = JSON.parse(stdout.trim()) as { CPUPerc: string; MemUsage: string };
  const cpuPercent = Number(result.CPUPerc.replace('%', ''));
  if (!Number.isFinite(cpuPercent)) throw new Error('DOCKER_CPU_INVALID');
  return { cpuPercent, memoryBytes: byteSize(result.MemUsage.split('/')[0]!) };
}

async function main(): Promise<void> {
  const base = localUrl(required('OBSERVE_BASE_URL'), ['http:']);
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash)
    throw new Error('BASE_URL_INVALID');
  const cookie = required('OBSERVE_COOKIE');
  const asset = required('OBSERVE_ASSET_ID');
  const job = required('OBSERVE_JOB_ID');
  if (![asset, job].every((value) => /^[a-f0-9-]{36}$/.test(value)))
    throw new Error('IDENTIFIER_INVALID');
  const databaseUrl = localUrl(required('OBSERVE_PG_URL'), ['postgres:', 'postgresql:']);
  const mq = parseEnv(await readFile(required('OBSERVE_MQ_ENV'), 'utf8'));
  const management = localUrl(mq.RABBITMQ_MANAGEMENT_URL ?? '', ['http:']);
  if (
    management.username ||
    management.password ||
    management.pathname !== '/' ||
    management.search ||
    management.hash
  )
    throw new Error('MQ_URL_INVALID');
  const vhost = mq.RABBITMQ_DEFAULT_VHOST;
  const mqUser = mq.RABBITMQ_DEFAULT_USER;
  const mqPassword = mq.RABBITMQ_DEFAULT_PASS;
  if (!vhost || !mqUser || !mqPassword) throw new Error('MQ_ENV_MISSING');
  const container = required('OBSERVE_MQ_CONTAINER');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) throw new Error('CONTAINER_INVALID');
  const aPid = integer('OBSERVE_A_PID', 0, 1, 99999999);
  const bPid = integer('OBSERVE_B_PID', 0, 0, 99999999);
  const scenario = required('OBSERVE_SCENARIO') as Scenario;
  if (!['baseline', 'saturated', 'offline', 'backlog'].includes(scenario))
    throw new Error('SCENARIO_INVALID');
  const qps = integer('OBSERVE_QPS', 5, 1, 50);
  const warmup = integer('OBSERVE_WARMUP_SECONDS', 60, 1, 300);
  const duration = integer('OBSERVE_DURATION_SECONDS', 600, 1, 600);
  const runtime = await realpath('.runtime');
  const output = resolve(required('OBSERVE_OUTPUT_DIR'));
  const parent = await realpath(dirname(output));
  if (parent !== runtime && !parent.startsWith(`${runtime}${sep}`))
    throw new Error('PRIVATE_OUTPUT_REQUIRED');
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        version: 2,
        base: base.origin,
        asset,
        job,
        qps,
        warmup,
        duration,
        timeoutMs: 5000,
        routes,
      }),
    )
    .digest('hex');
  let baseline: Baseline | null = null;
  if (scenario !== 'baseline') {
    const baselinePath = await realpath(required('OBSERVE_BASELINE_SUMMARY'));
    if (!baselinePath.startsWith(`${runtime}${sep}`)) throw new Error('PRIVATE_BASELINE_REQUIRED');
    baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Baseline;
    if (!baseline || baseline.scenario !== 'baseline' || baseline.profileDigest !== digest)
      throw new Error('BASELINE_PROFILE_MISMATCH');
  }
  await mkdir(output, { mode: 0o700 });
  const samplesFile = createWriteStream(resolve(output, 'samples.jsonl'), {
    flags: 'wx',
    mode: 0o600,
  });
  let fileError = false;
  samplesFile.on('error', () => {
    fileError = true;
  });
  const append = (value: unknown): void => {
    samplesFile.write(`${JSON.stringify(value)}\n`);
  };
  const pool = new pg.Pool({
    connectionString: databaseUrl.href,
    max: 1,
    connectionTimeoutMillis: 3000,
    options: '-c default_transaction_read_only=on -c statement_timeout=3000',
  });
  const auth = Buffer.from(`${mqUser}:${mqPassword}`).toString('base64');
  const queueNames = [
    'mio.compute.commands.v1',
    'mio.compute.results.v1',
    'mio.compute.commands.dlq.v1',
    'mio.compute.results.dlq.v1',
  ];
  const paths: Record<Route, string> = {
    health: '/healthz',
    ready: '/readyz',
    me: '/api/v1/me',
    asset: `/api/v1/assets/${asset}`,
    job: `/api/v1/compute/jobs/${job}`,
  };
  const samples: Sample[] = [];
  let monitoringErrors = 0;
  let warmupErrors = 0;
  let monitoring = true;
  let pending = new Set<Promise<void>>();

  async function phase(seconds: number, measured: boolean): Promise<PhaseTiming> {
    const start = performance.now();
    const startedAt = new Date().toISOString();
    let dispatched = 0;
    let missed = 0;
    let maxLatenessMs = 0;
    for (let index = 0; index < seconds * qps; index++) {
      const route = routes[index % routes.length]!;
      const scheduledOffsetMs = (index * 1000) / qps;
      const target = start + scheduledOffsetMs;
      await sleep(Math.max(0, target - performance.now()));
      const started = performance.now();
      maxLatenessMs = Math.max(maxLatenessMs, started - target);
      if (started - target > 1000 || started >= start + seconds * 1000 || pending.size >= 100) {
        missed++;
        const sample = {
          route,
          scheduledOffsetMs,
          startedOffsetMs: null,
          latencyMs: null,
          status: null,
          ok: false,
        };
        if (measured) {
          samples.push(sample);
          append({ type: 'request', ...sample, reason: 'not_dispatched' });
        } else warmupErrors++;
        continue;
      }
      dispatched++;
      const promise: Promise<void> = (async () => {
        let status: number | null = null;
        let ok = false;
        try {
          const response = await fetch(new URL(paths[route], base), {
            headers: { cookie },
            redirect: 'manual',
            signal: AbortSignal.timeout(5000),
          });
          status = response.status;
          await response.arrayBuffer();
          ok = status === 200;
        } catch {
          /* A transport or body failure is one failed request. */
        }
        const sample = {
          route,
          scheduledOffsetMs,
          startedOffsetMs: started - start,
          latencyMs: performance.now() - started,
          status,
          ok,
        };
        if (measured) {
          samples.push(sample);
          append({ type: 'request', ...sample });
        } else if (!ok) warmupErrors++;
      })().finally(() => {
        pending.delete(promise);
      });
      pending.add(promise);
    }
    await sleep(Math.max(0, start + seconds * 1000 - performance.now()));
    const windowMs = performance.now() - start;
    await Promise.all(pending);
    pending = new Set();
    return {
      startedAt,
      windowMs,
      completedMs: performance.now() - start,
      dispatched,
      missed,
      actualQps: dispatched / seconds,
      maxLatenessMs,
    };
  }
  async function observe(): Promise<void> {
    const results = await Promise.allSettled([
      processes(aPid, bPid),
      brokerStats(container),
      Promise.all(
        queueNames.map(async (name) => {
          const response = await fetch(
            new URL(
              `/api/queues/${encodeURIComponent(vhost!)}/${encodeURIComponent(name)}`,
              management,
            ),
            { headers: { authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(5000) },
          );
          if (!response.ok) throw new Error('QUEUE_READ_FAILED');
          const body = (await response.json()) as {
            messages_ready: number;
            messages_unacknowledged: number;
            consumers: number;
          };
          if (
            ![body.messages_ready, body.messages_unacknowledged, body.consumers].every(
              Number.isFinite,
            )
          )
            throw new Error('QUEUE_RESPONSE_INVALID');
          return [
            name,
            {
              ready: body.messages_ready,
              unacknowledged: body.messages_unacknowledged,
              consumers: body.consumers,
            },
          ] as const;
        }),
      ),
      pool.query(`SELECT (SELECT count(*)::int FROM mio_compute_outbox WHERE sent_at IS NULL) AS pending,
        (SELECT count(*)::int FROM mio_compute_outbox WHERE sent_at IS NOT NULL) AS sent,
        (SELECT count(*)::int FROM mio_compute_jobs WHERE state IN ('accepted','queued','running')) AS unfinished,
        (SELECT count(*)::int FROM mio_compute_jobs WHERE state = 'running') AS running`),
    ]);
    const proc = results[0].status === 'fulfilled' ? results[0].value : null;
    const broker = results[1].status === 'fulfilled' ? results[1].value : null;
    const queues = results[2].status === 'fulfilled' ? Object.fromEntries(results[2].value) : null;
    const database =
      results[3].status === 'fulfilled'
        ? (results[3].value.rows[0] as Observation['database'])
        : null;
    const observation: Observation = {
      at: new Date().toISOString(),
      a: proc?.a ?? null,
      b: proc?.b ?? null,
      broker,
      queues,
      database,
    };
    if (!proc || !proc.a || !broker || !queues || !database) monitoringErrors++;
    append({ type: 'observation', ...observation });
  }
  async function monitor(): Promise<void> {
    while (monitoring) {
      await observe();
      if (monitoring) await sleep(10_000);
    }
  }

  try {
    append({
      type: 'start',
      at: new Date().toISOString(),
      scenario,
      profileDigest: digest,
      qps,
      warmup,
      duration,
    });
    const warmupTiming = await phase(warmup, false);
    const monitorTask = monitor();
    let measuredTiming: PhaseTiming;
    try {
      measuredTiming = await phase(duration, true);
    } finally {
      monitoring = false;
      await monitorTask;
    }
    const measurement: Record<string, Stats> = { all: stats(samples) };
    for (const route of routes)
      measurement[route] = stats(samples.filter((sample) => sample.route === route));
    const eligible =
      duration === 600 && samples.length === duration * qps && monitoringErrors === 0 && !fileError;
    const { comparison, conclusion } = compareMeasurements(measurement, baseline, eligible);
    const summary = {
      scenario,
      profileDigest: digest,
      qps,
      warmupSeconds: warmup,
      durationSeconds: duration,
      bPidProvided: bPid !== 0,
      warmupTiming,
      measuredTiming,
      eligible,
      warmupErrors,
      monitoringErrors,
      measurement,
      comparison,
      conclusion,
      scenarioVerification: 'pending_manual_review',
      notes:
        'CPU/RSS include process descendants; ps CPU uses platform process statistics, not a 10-second delta. Docker CPU has its own sampling interval. FFmpeg presence is sampled, not continuous proof. Short observations are ineligible for P5.',
    };
    append({ type: 'finish', at: new Date().toISOString(), conclusion });
    await new Promise<void>((resolveEnd, reject) =>
      samplesFile.end(() => (fileError ? reject(new Error('SAMPLE_WRITE_FAILED')) : resolveEnd())),
    );
    await writeFile(resolve(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(
      `Observation written: ${basename(output)}; ${conclusion}; scenario evidence requires review.\n`,
    );
  } finally {
    monitoring = false;
    await pool.end();
    if (!samplesFile.closed) samplesFile.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write(
      'Observation failed; inspect private partial evidence and local inputs.\n',
    );
    process.exitCode = 1;
  });
}
