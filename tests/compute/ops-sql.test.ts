import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { WorkerObservabilityQueries } from '../../src/compute/observability/queries.ts';
import {
  checkWorkerObservabilitySchema,
  workerObservabilitySchemaSQL,
} from '../../src/compute/observability/schema.ts';
import { WorkerObservabilityStore } from '../../src/compute/observability/store.ts';
import { authDatabase } from '../support/auth-database.ts';

function recordProbe(kind: string, value: unknown) {
  process.stdout.write(kind + ' ' + JSON.stringify(value) + '\n');
}

// Exact historical DDL from 69efaf92ac79d7c19e758e065d24d4666112359e.
// Materialized here so regression does not require Git history or private .work files.
const legacySchemaSQL = `
CREATE TABLE IF NOT EXISTS mio_compute_worker_instances (
  instance_id text PRIMARY KEY,
  boot_id uuid, boot_sequence bigint, sequence bigint,
  observed_at timestamptz, received_at timestamptz,
  snapshot jsonb,
  desired_revision bigint NOT NULL DEFAULT 0, desired_limits jsonb,
  desired_command_id uuid, desired_requested_at timestamptz,
  desired_status text CHECK (desired_status IN ('pending','applied','rejected')),
  desired_reason text, desired_confirmed_at timestamptz,
  latest_gap jsonb
);
CREATE TABLE IF NOT EXISTS mio_compute_worker_inbox (
  message_id uuid PRIMARY KEY,
  instance_id text NOT NULL REFERENCES mio_compute_worker_instances(instance_id),
  boot_id uuid NOT NULL, boot_sequence bigint NOT NULL, sequence bigint NOT NULL,
  digest text NOT NULL, received_at timestamptz NOT NULL,
  UNIQUE(instance_id,boot_sequence,sequence),
  UNIQUE(instance_id,boot_id,sequence)
);
CREATE INDEX IF NOT EXISTS mio_compute_worker_inbox_retention
  ON mio_compute_worker_inbox(received_at);
CREATE TABLE IF NOT EXISTS mio_compute_worker_samples (
  message_id uuid PRIMARY KEY REFERENCES mio_compute_worker_inbox(message_id),
  instance_id text NOT NULL REFERENCES mio_compute_worker_instances(instance_id),
  boot_id uuid NOT NULL,
  sample_at timestamptz NOT NULL, observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL,
  usage jsonb NOT NULL, waiting jsonb NOT NULL, hard jsonb NOT NULL, applied jsonb NOT NULL,
  revision bigint NOT NULL, holds jsonb NOT NULL, gap jsonb
);
CREATE INDEX IF NOT EXISTS mio_compute_worker_samples_instance_time
  ON mio_compute_worker_samples(instance_id,sample_at DESC,received_at DESC,message_id DESC);
CREATE INDEX IF NOT EXISTS mio_compute_worker_samples_time
  ON mio_compute_worker_samples(sample_at DESC);
CREATE INDEX IF NOT EXISTS mio_compute_worker_samples_retention
  ON mio_compute_worker_samples(received_at);
CREATE TABLE IF NOT EXISTS mio_compute_worker_events (
  message_id uuid PRIMARY KEY REFERENCES mio_compute_worker_inbox(message_id),
  instance_id text NOT NULL REFERENCES mio_compute_worker_instances(instance_id),
  boot_id uuid NOT NULL, boot_sequence bigint NOT NULL, sequence bigint NOT NULL,
  execution_id uuid, event_at timestamptz NOT NULL, received_at timestamptz NOT NULL,
  kind text NOT NULL, detail jsonb NOT NULL, usage jsonb NOT NULL, gap jsonb
);
CREATE INDEX IF NOT EXISTS mio_compute_worker_events_execution
  ON mio_compute_worker_events(execution_id,sequence) WHERE execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mio_compute_worker_events_time
  ON mio_compute_worker_events(event_at DESC);
CREATE INDEX IF NOT EXISTS mio_compute_worker_events_gap
  ON mio_compute_worker_events(instance_id,event_at) WHERE gap IS NOT NULL;
CREATE INDEX IF NOT EXISTS mio_compute_worker_events_retention
  ON mio_compute_worker_events(received_at);
CREATE TABLE IF NOT EXISTS mio_compute_worker_executions (
  execution_id uuid PRIMARY KEY,
  instance_id text NOT NULL REFERENCES mio_compute_worker_instances(instance_id),
  boot_id uuid NOT NULL, boot_sequence bigint NOT NULL,
  protocol text NOT NULL, job_id uuid NOT NULL, attempt_id uuid, inspection_id uuid,
  resource text NOT NULL, slots smallint NOT NULL,
  sequence bigint NOT NULL,
  event_state text NOT NULL CHECK (event_state IN ('queued','active','released','cancelled')),
  uncertain boolean NOT NULL DEFAULT false,
  queued_at timestamptz, acquired_at timestamptz, ended_at timestamptz,
  last_at timestamptz NOT NULL, last_received_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS mio_compute_worker_executions_job
  ON mio_compute_worker_executions(job_id,last_at DESC,execution_id);
CREATE INDEX IF NOT EXISTS mio_compute_worker_executions_instance
  ON mio_compute_worker_executions(instance_id,last_at DESC,execution_id);
CREATE INDEX IF NOT EXISTS mio_compute_worker_executions_time
  ON mio_compute_worker_executions(last_at DESC,execution_id);
CREATE INDEX IF NOT EXISTS mio_compute_worker_executions_open
  ON mio_compute_worker_executions(instance_id,boot_sequence)
  WHERE event_state IN ('queued','active') AND NOT uncertain;
CREATE INDEX IF NOT EXISTS mio_compute_worker_executions_retention
  ON mio_compute_worker_executions(last_received_at);
CREATE TABLE IF NOT EXISTS mio_compute_worker_limit_changes (
  command_id uuid PRIMARY KEY, instance_id text NOT NULL REFERENCES mio_compute_worker_instances(instance_id),
  revision bigint NOT NULL, requested_by text NOT NULL, requested_at timestamptz NOT NULL,
  previous_limits jsonb NOT NULL, requested_limits jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected')),
  reason text, applied_limits jsonb, confirmed_at timestamptz, result_observed_at timestamptz,
  result_message_id uuid REFERENCES mio_compute_worker_inbox(message_id),
  UNIQUE(instance_id,revision)
);
CREATE INDEX IF NOT EXISTS mio_compute_worker_limit_changes_time
  ON mio_compute_worker_limit_changes(requested_at DESC,command_id);
CREATE INDEX IF NOT EXISTS mio_compute_worker_limit_changes_result
  ON mio_compute_worker_limit_changes(result_message_id) WHERE result_message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS mio_compute_worker_control_outbox (
  command_id uuid PRIMARY KEY REFERENCES mio_compute_worker_limit_changes(command_id),
  instance_id text NOT NULL REFERENCES mio_compute_worker_instances(instance_id),
  revision bigint NOT NULL, command jsonb NOT NULL,
  lease_id uuid, lease_until timestamptz, sent_at timestamptz, created_at timestamptz NOT NULL,
  UNIQUE(instance_id,revision)
);
CREATE INDEX IF NOT EXISTS mio_compute_worker_control_pending
  ON mio_compute_worker_control_outbox(instance_id,revision) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS mio_compute_worker_control_sent
  ON mio_compute_worker_control_outbox(sent_at) WHERE sent_at IS NOT NULL;
`;
const legacyClock = 'abs(extract(epoch FROM s.observed_at - s.received_at)) > 15';
const legacyGap = `s.gap IS NOT NULL OR EXISTS (
  SELECT 1 FROM mio_compute_worker_events e WHERE e.instance_id=s.instance_id AND e.gap IS NOT NULL
    AND e.event_at>s.sample_at-interval '5 seconds' AND e.event_at<=s.sample_at)`;
const legacySum = (name: string) => `jsonb_build_object('total',sum((s.${name}->>'total')::bigint),
  'encode',sum((s.${name}->>'encode')::bigint),'probe',sum((s.${name}->>'probe')::bigint))`;
// The baseline's aggregate, retained only as a behavior oracle, never a runtime fallback.
const legacyHistorySQL = `WITH times AS (
  SELECT DISTINCT sample_at FROM mio_compute_worker_samples
  WHERE instance_id=ANY($1::text[]) AND sample_at BETWEEN $2 AND $3
  ORDER BY sample_at DESC LIMIT $4)
  SELECT t.sample_at AS at,${legacySum('usage')} AS usage,${legacySum('waiting')} AS waiting,
    ${legacySum('applied')} AS applied,${legacySum('hard')} AS hard,
    count(*)::integer AS workers,bool_or(${legacyClock}) AS "clockUncertain",bool_or(${legacyGap}) AS gap
  FROM times t CROSS JOIN unnest($1::text[]) AS w(instance_id)
  CROSS JOIN LATERAL (
    SELECT instance_id,sample_at,usage,waiting,applied,hard,observed_at,received_at,gap
    FROM mio_compute_worker_samples
    WHERE instance_id=w.instance_id AND sample_at BETWEEN t.sample_at-interval '15 seconds' AND t.sample_at
    ORDER BY sample_at DESC,received_at DESC,message_id DESC LIMIT 1) s
  GROUP BY t.sample_at ORDER BY t.sample_at DESC`;

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let sequence = 0;
const boot = randomUUID();
const ids = ['worker-a', 'worker-b', 'worker-c', 'worker-unseen'];
const zero = { total: 0, encode: 0, probe: 0 };
const since = new Date('2030-01-01T00:00:20.000Z');
const until = new Date('2030-01-01T00:00:40.000Z');

beforeAll(async () => {
  const target = new URL(process.env.MIO_TEST_DATABASE_URL!);
  if (
    process.env.GITHUB_ACTIONS !== 'true' &&
    (target.pathname !== '/mio_regression_test' || target.username !== 'mio_regression')
  )
    throw new Error('B07_REQUIRES_MIO_DEV_REGRESSION_DATABASE');
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url, max: 2 });
  await pool.query(assetSchemaSQL);
  await pool.query(computeSchemaSQL);
  recordProbe(
    'B07_PG_IDENTITY',
    (
      await pool.query(
        'SELECT current_database() AS database,current_user AS role,current_schema() AS schema,version() AS version',
      )
    ).rows[0],
  );
});
beforeEach(async () => {
  await pool.query('TRUNCATE mio_compute_worker_instances CASCADE');
});
afterAll(async () => {
  await pool?.end();
  await database?.close();
});

async function sample(
  instance: string,
  at: string,
  usage: number,
  received = at,
  messageId = randomUUID(),
  observed = at,
  connection = pool,
) {
  await connection.query(
    'INSERT INTO mio_compute_worker_instances(instance_id) VALUES($1) ON CONFLICT DO NOTHING',
    [instance],
  );
  await connection.query(
    `INSERT INTO mio_compute_worker_inbox
    (message_id,instance_id,boot_id,boot_sequence,sequence,digest,received_at)
    VALUES($1,$2,$3,1,$4,'legacy-fixture',$5)`,
    [messageId, instance, boot, ++sequence, received],
  );
  await connection.query(
    `INSERT INTO mio_compute_worker_samples
    (message_id,instance_id,boot_id,sample_at,observed_at,received_at,usage,waiting,hard,applied,revision,holds)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,0,'{"encode":[],"probe":[]}')`,
    [
      messageId,
      instance,
      boot,
      at,
      observed,
      received,
      { total: usage, encode: usage, probe: 0 },
      zero,
    ],
  );
  return messageId;
}
async function gapEvent(instance: string, at: string) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mio_compute_worker_inbox
    (message_id,instance_id,boot_id,boot_sequence,sequence,digest,received_at,kind)
    VALUES($1,$2,$3,1,$4,'gap-fixture',$5,'event')`,
    [id, instance, boot, ++sequence, at],
  );
  await pool.query(
    `INSERT INTO mio_compute_worker_events
    (message_id,instance_id,boot_id,boot_sequence,sequence,event_at,received_at,kind,detail,usage,gap)
    VALUES($1,$2,$3,1,$4,$5,$5,'phase','{}',$6,'{}')`,
    [id, instance, boot, sequence, at, zero],
  );
}
async function historyFixture() {
  await sample('worker-c', '2030-01-01T00:00:05.000Z', 3);
  await sample('worker-unlisted', '2030-01-01T00:00:39.000Z', 100);
  await sample(
    'worker-b',
    '2030-01-01T00:00:20.000Z',
    1,
    undefined,
    undefined,
    '2030-01-01T00:00:04.000Z',
  );
  await sample('worker-a', '2030-01-01T00:00:20.000Z', 2, '2030-01-01T00:00:22.000Z');
  await sample(
    'worker-a',
    '2030-01-01T00:00:20.000Z',
    5,
    '2030-01-01T00:00:23.000Z',
    '00000000-0000-4000-8000-000000000001',
  );
  await sample(
    'worker-a',
    '2030-01-01T00:00:20.000Z',
    7,
    '2030-01-01T00:00:23.000Z',
    '00000000-0000-4000-8000-000000000002',
  );
  await sample('worker-a', '2030-01-01T00:00:25.000Z', 8);
  await sample('worker-a', '2030-01-01T00:00:25.000001Z', 9);
  await sample('worker-b', '2030-01-01T00:00:40.000Z', 4);
  await sample('worker-a', '2030-01-01T00:00:40.000001Z', 100);
  await gapEvent('worker-a', '2030-01-01T00:00:15.000Z'); // Exclusive lower gap boundary at t=20.
  await gapEvent('worker-a', '2030-01-01T00:00:20.000Z'); // Inclusive upper gap boundary.
}
async function legacyHistory(limit: number, selectedIds: readonly string[] = ids) {
  return {
    since,
    until,
    points: (await pool.query(legacyHistorySQL, [selectedIds, since, until, limit])).rows.reverse(),
  };
}

it('matches real baseline history before replacement, including ties, microseconds, prefixes, gaps and limits', async () => {
  await historyFixture();
  for (const selectedIds of [ids, ['worker-a']]) {
    for (const limit of [1, 2, 1000]) {
      const expected = await legacyHistory(limit, selectedIds);
      expect(
        await new WorkerObservabilityQueries(pool, selectedIds).history(
          undefined,
          since,
          until,
          limit,
        ),
      ).toEqual(expected);
    }
  }
  const result = await new WorkerObservabilityQueries(pool, ids).history(
    undefined,
    since,
    until,
    1000,
  );
  expect(
    result.points.map((point) => [
      point.at.getTime() - since.getTime(),
      point.workers,
      point.usage.total,
      point.gap,
    ]),
  ).toEqual([
    [0, 3, 11, true],
    [5000, 2, 9, false],
    [5000, 2, 10, false],
    [20000, 2, 13, false],
  ]);
  const raw = await new WorkerObservabilityQueries(pool, ids).history('worker-a', since, until, 2);
  expect(raw.points.map((point) => point.usage.total)).toEqual([8, 9]);
  recordProbe('B07_HISTORY_EQUIVALENCE', {
    baseline: '69efaf92ac79d7c19e758e065d24d4666112359e',
    limits: [1, 2, 1000],
    points: result.points,
  });
});

it('uses exactly two data queries in one read-only repeatable snapshot under concurrent ingestion, including empty history', async () => {
  await historyFixture();
  const expected = await legacyHistory(1000);
  const writer = new Pool({ connectionString: database.url, max: 1 });
  const original = Client.prototype.query;
  let injected = false;
  let settings: unknown;
  const calls: string[] = [];
  const query = vi.spyOn(Client.prototype, 'query').mockImplementation(function (
    this: Client,
    ...args: unknown[]
  ) {
    const sql = typeof args[0] === 'string' ? args[0] : '';
    if (sql.startsWith('BEGIN ISOLATION') || sql.startsWith('SELECT DISTINCT') || sql === 'COMMIT')
      calls.push(sql);
    const result = Reflect.apply(original, this, args);
    if (!injected && sql.startsWith('SELECT DISTINCT sample_at')) {
      injected = true;
      return result.then(async (rows: unknown) => {
        settings = (
          await Reflect.apply(original, this, [
            "SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation",
          ])
        ).rows[0];
        await sample(
          'worker-a',
          '2030-01-01T00:00:39.000Z',
          50,
          undefined,
          undefined,
          undefined,
          writer,
        );
        return rows;
      });
    }
    return result;
  });
  try {
    expect(
      await new WorkerObservabilityQueries(pool, ids).history(undefined, since, until, 1000),
    ).toEqual(expected);
    expect(settings).toEqual({ readonly: 'on', isolation: 'repeatable read' });
    expect(calls.filter((sql) => sql.startsWith('SELECT'))).toHaveLength(2);
    expect(calls[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    calls.length = 0;
    expect(
      (
        await new WorkerObservabilityQueries(pool, ids).history(
          undefined,
          new Date('2031-01-01'),
          new Date('2031-01-02'),
          10,
        )
      ).points,
    ).toEqual([]);
    expect(calls.filter((sql) => sql.startsWith('SELECT'))).toHaveLength(2);
  } finally {
    query.mockRestore();
    await writer.end();
  }
});

it('migrates the actual historical schema and drains bounded backlog without losing audit, fresh rows or legacy orphans', async () => {
  const historical = await authDatabase();
  const old = new Pool({ connectionString: historical.url });
  try {
    await old.query(legacySchemaSQL);
    await expect(checkWorkerObservabilitySchema(old)).rejects.toMatchObject({ code: '42703' });
    const oldSample = await sample(
      'worker-a',
      '2030-01-01',
      1,
      undefined,
      undefined,
      undefined,
      old,
    );
    const retainedEvent = await sample(
      'worker-a',
      '2030-01-20',
      1,
      undefined,
      undefined,
      undefined,
      old,
    );
    await old.query(
      `INSERT INTO mio_compute_worker_events(message_id,instance_id,boot_id,boot_sequence,sequence,event_at,received_at,kind,detail,usage)
      SELECT message_id,instance_id,boot_id,1,1,sample_at,received_at,'phase','{}',usage FROM mio_compute_worker_samples WHERE message_id=$1`,
      [retainedEvent],
    );
    await old.query('DELETE FROM mio_compute_worker_samples WHERE message_id=$1', [retainedEvent]);
    const receipt = randomUUID();
    const orphan = randomUUID();
    await old.query(
      `INSERT INTO mio_compute_worker_inbox(message_id,instance_id,boot_id,boot_sequence,sequence,digest,received_at)
      VALUES($1,'worker-a',$3,1,100001,'receipt','2030-01-01'),($2,'worker-a',$3,1,100002,'orphan','2030-01-01')`,
      [receipt, orphan, boot],
    );
    await old.query(
      `INSERT INTO mio_compute_worker_limit_changes(command_id,instance_id,revision,requested_by,requested_at,previous_limits,requested_limits,result_message_id)
      VALUES($1,'worker-a',1,'historical-operator','2030-02-01',$2,$2,$3)`,
      [randomUUID(), zero, receipt],
    );
    const fresh = await sample('worker-a', '2030-02-01', 2, undefined, undefined, undefined, old);
    const before = (
      await old.query('SELECT message_id FROM mio_compute_worker_inbox ORDER BY message_id')
    ).rows;
    await old.query(workerObservabilitySchemaSQL);
    await old.query(workerObservabilitySchemaSQL);
    expect(
      (await old.query('SELECT message_id FROM mio_compute_worker_inbox ORDER BY message_id')).rows,
    ).toEqual(before);
    const kinds = new Map(
      (await old.query('SELECT message_id,kind FROM mio_compute_worker_inbox')).rows.map((row) => [
        row.message_id,
        row.kind,
      ]),
    );
    expect([
      kinds.get(oldSample),
      kinds.get(retainedEvent),
      kinds.get(receipt),
      kinds.get(orphan),
    ]).toEqual(['sample', 'event', 'limit_result', 'limit_result']);
    await old.query(
      `INSERT INTO mio_compute_worker_inbox(message_id,instance_id,boot_id,boot_sequence,sequence,digest,received_at,kind)
      SELECT md5('b07-backlog-'||i)::uuid,'worker-a',$1,2,i,'backlog','2030-01-01','sample' FROM generate_series(1,2001) i`,
      [randomUUID()],
    );
    await old.query(
      `INSERT INTO mio_compute_worker_samples(message_id,instance_id,boot_id,sample_at,observed_at,received_at,usage,waiting,hard,applied,revision,holds)
      SELECT message_id,instance_id,boot_id,received_at,received_at,received_at,$1,$1,$1,$1,0,'{}'
      FROM mio_compute_worker_inbox WHERE boot_sequence=2`,
      [zero],
    );
    const observations = new WorkerObservabilityStore(old, ['worker-a']);
    await observations.prune(new Date('2030-02-01'));
    expect(
      Number(
        (
          await old.query(
            "SELECT count(*) FROM mio_compute_worker_samples WHERE received_at<'2030-01-25'",
          )
        ).rows[0].count,
      ),
    ).toBe(2);
    await observations.prune(new Date('2030-02-01'));
    const remaining = (await old.query('SELECT message_id FROM mio_compute_worker_inbox')).rows
      .map((row) => row.message_id)
      .sort();
    expect(remaining).toEqual([retainedEvent, receipt, fresh].sort());
    const indexes = (
      await old.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename='mio_compute_worker_inbox'",
      )
    ).rows.map((row) => row.indexname);
    expect(indexes).toContain('mio_compute_worker_inbox_limit_result_retention');
    expect(indexes).not.toContain('mio_compute_worker_inbox_retention');
    recordProbe('B07_HISTORICAL_MIGRATION', {
      source: '69efaf92 exact old schema',
      before: before.length,
      backlog: 2001,
      firstPassExpiredRemaining: 2,
      finalInbox: remaining,
      orphanRemoved: orphan,
    });
  } finally {
    await old.end();
    await historical.close();
  }
});

it('short-circuits denied identities and empty pages, and uses equality for singletons without changing results', async () => {
  const queries = new WorkerObservabilityQueries(pool, ids);
  const query = vi.spyOn(pool, 'query');
  const connect = vi.spyOn(pool, 'connect');
  try {
    expect(await queries.workers(64, 64)).toEqual({ workers: [], total: ids.length, offset: 64 });
    expect(await queries.worker('unlisted')).toBeNull();
    expect(await queries.history('unlisted', since, until, 5)).toEqual({
      since,
      until,
      points: [],
    });
    expect(await queries.limits('unlisted', 5)).toEqual({ changes: [] });
    expect(await queries.executions({ instanceId: "worker-a' OR true--", limit: 5 })).toEqual({
      executions: [],
    });
    const empty = new WorkerObservabilityQueries(pool, []);
    expect(await empty.execution(randomUUID())).toBeNull();
    expect(await empty.executions({ limit: 5 })).toEqual({ executions: [] });
    expect(await empty.history(undefined, since, until, 5)).toEqual({ since, until, points: [] });
    expect(await empty.limits(undefined, 5)).toEqual({ changes: [] });
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
    connect.mockRestore();
  }
  const singleton = new WorkerObservabilityQueries(pool, ['worker-a']);
  const oneQuery = vi.spyOn(pool, 'query');
  try {
    expect((await singleton.workers(10, 0)).workers).toMatchObject([
      { instanceId: 'worker-a', status: 'unseen' },
    ]);
    await singleton.executions({ limit: 5 });
    await singleton.limits(undefined, 5);
    await singleton.history('worker-a', since, until, 5);
    for (const call of oneQuery.mock.calls) {
      expect(call[0]).toContain('instance_id=$1');
      expect(call[0]).not.toContain('instance_id=ANY');
      expect(call[1]?.[0]).toBe('worker-a');
    }
  } finally {
    oneQuery.mockRestore();
  }
});

it('keeps execution state CASE equivalence across app-clock boundaries, gaps, uncertain and terminal rows', async () => {
  const now = until.getTime();
  for (const [id, age, gap] of [
    ['worker-a', 15_000, { last: { bootSequence: 1, sequence: 10 } }],
    ['worker-b', 15_001, null],
    ['worker-c', null, null],
  ] as const) {
    await pool.query(
      `INSERT INTO mio_compute_worker_instances(instance_id,observed_at,received_at,latest_gap)
      VALUES($1,$2,$2,$3)`,
      [id, age === null ? null : new Date(now - age), gap],
    );
    for (const [index, state] of [
      'queued',
      'queued',
      'active',
      'active',
      'released',
      'cancelled',
    ].entries()) {
      await pool.query(
        `INSERT INTO mio_compute_worker_executions(execution_id,instance_id,boot_id,boot_sequence,protocol,job_id,
        resource,slots,sequence,event_state,uncertain,last_at,last_received_at)
        VALUES($1,$2,$3,1,'media',$4,'encode',1,$5,$6,$7,$8,$8)`,
        [
          randomUUID(),
          id,
          boot,
          randomUUID(),
          index === 0 ? 1 : 11,
          state,
          index === 3,
          new Date(now - index),
        ],
      );
    }
  }
  const queries = new WorkerObservabilityQueries(pool, ids);
  const legacyState = `CASE WHEN e.event_state IN ('queued','active') AND
    (e.uncertain OR COALESCE(LEAST(w.observed_at,w.received_at)<$2::timestamptz-interval '15 seconds',true)
      OR (e.event_state='queued' AND e.boot_sequence=(w.latest_gap->'last'->>'bootSequence')::bigint
        AND e.sequence<(w.latest_gap->'last'->>'sequence')::bigint))
    THEN 'unknown' ELSE e.event_state END`;
  for (const state of [
    undefined,
    'active',
    'queued',
    'released',
    'cancelled',
    'unknown',
  ] as const) {
    const expected = (
      await pool.query(
        `SELECT e.execution_id AS "executionId",${legacyState} AS state
      FROM mio_compute_worker_executions e JOIN mio_compute_worker_instances w ON w.instance_id=e.instance_id
      WHERE e.instance_id=ANY($1::text[]) AND ($3::text IS NULL OR (${legacyState})=$3)
      ORDER BY e.last_at DESC,e.execution_id LIMIT 100`,
        [ids, new Date(now), state ?? null],
      )
    ).rows;
    const filter = state === undefined ? { limit: 100 } : { state, limit: 100 };
    expect(
      (await queries.executions(filter, now)).executions.map((row) => ({
        executionId: row.executionId,
        state: row.state,
      })),
    ).toEqual(expected);
  }
  expect(await queries.worker('worker-a', now)).toMatchObject({ status: 'online', ageMs: 15_000 });
  expect(await queries.worker('worker-b', now)).toMatchObject({ status: 'stale', ageMs: 15_001 });
  const first = (
    await queries.executions({ state: 'active', instanceId: 'worker-a', limit: 5 }, now)
  ).executions[0]!;
  expect(await queries.execution(first.executionId, now)).toMatchObject({ state: 'active' });
  expect(await queries.execution(first.executionId, now + 1)).toMatchObject({ state: 'unknown' });
  expect((await queries.executions({ jobId: first.jobId, limit: 5 }, now)).executions).toHaveLength(
    1,
  );
});

function planSummary(document: Record<string, unknown>) {
  const indexes: string[] = [];
  const walk = (node: Record<string, unknown>) => {
    if (typeof node['Index Name'] === 'string') indexes.push(node['Index Name']);
    for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) walk(child);
  };
  const root = document.Plan as Record<string, unknown>;
  walk(root);
  return {
    indexes,
    executionMs: document['Execution Time'],
    sharedHit: root['Shared Hit Blocks'],
    sharedRead: root['Shared Read Blocks'],
    planRows: root['Plan Rows'],
  };
}

it('measures one-hour peaks across all event kinds/selectivity and proves actual open-index use for active execution', async () => {
  const now = new Date('2030-02-01T12:00:00Z');
  const beforeHour = new Date(now.getTime() - 3600_000);
  const allowed = Array.from({ length: 24 }, (_, i) => `worker-${i}`);
  await pool.query(
    `INSERT INTO mio_compute_worker_instances(instance_id,observed_at,received_at)
    SELECT 'worker-'||i,$1,$1 FROM generate_series(0,23) i`,
    [now],
  );
  const peaks = `SELECT instance_id AS "instanceId",max((usage->>'total')::bigint)::float8 AS peak
    FROM mio_compute_worker_events WHERE instance_id=ANY($1::text[]) AND event_at BETWEEN $2 AND $3
    AND kind='execution' GROUP BY instance_id ORDER BY instance_id`;
  const plans: unknown[] = [];
  for (const percent of [5, 50, 95]) {
    await pool.query('TRUNCATE mio_compute_worker_events,mio_compute_worker_inbox CASCADE');
    await pool.query('DROP INDEX IF EXISTS mio_compute_worker_events_execution_peak');
    await pool.query(
      `INSERT INTO mio_compute_worker_inbox(message_id,instance_id,boot_id,boot_sequence,sequence,digest,received_at,kind)
      SELECT md5(i::text)::uuid,'worker-'||(i%24),$1,1,i,'synthetic',$2,'event' FROM generate_series(1,40000) i`,
      [boot, now],
    );
    await pool.query(
      `INSERT INTO mio_compute_worker_events(message_id,instance_id,boot_id,boot_sequence,sequence,event_at,received_at,kind,detail,usage)
      SELECT message_id,instance_id,boot_id,1,sequence,$2::timestamptz-(sequence%14400)*interval '1 second',$2,
      CASE WHEN sequence%100<$1 THEN 'execution' ELSE (ARRAY['phase','hold','limits'])[1+(sequence%3)::int] END,
      '{}',jsonb_build_object('total',sequence%7,'encode',sequence%7,'probe',0) FROM mio_compute_worker_inbox`,
      [percent, now],
    );
    await pool.query('ANALYZE mio_compute_worker_events');
    const comparisons: Array<{ width: number; expected: unknown; baseline: unknown }> = [];
    for (const width of [1, 24]) {
      const args = [allowed.slice(0, width), beforeHour, now];
      comparisons.push({
        width,
        expected: (await pool.query(peaks, args)).rows,
        baseline: (
          await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) ' + peaks, args)
        ).rows[0]['QUERY PLAN'][0],
      });
    }
    await pool.query(`CREATE INDEX mio_compute_worker_events_execution_peak
      ON mio_compute_worker_events(instance_id,event_at) WHERE kind='execution'`);
    const bytes = (
      await pool.query(
        "SELECT pg_relation_size('mio_compute_worker_events_execution_peak') AS bytes",
      )
    ).rows[0].bytes;
    for (const comparison of comparisons) {
      const args = [allowed.slice(0, comparison.width), beforeHour, now];
      expect((await pool.query(peaks, args)).rows).toEqual(comparison.expected);
      const candidate = (
        await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) ' + peaks, args)
      ).rows[0]['QUERY PLAN'][0];
      plans.push({
        percent,
        width: comparison.width,
        rows: 40000,
        bytes,
        baseline: planSummary(comparison.baseline as Record<string, unknown>),
        candidate: planSummary(candidate),
      });
      if (percent === 5 && comparison.width === 1)
        expect(planSummary(candidate).indexes).toContain(
          'mio_compute_worker_events_execution_peak',
        );
    }
  }
  await pool.query(
    `INSERT INTO mio_compute_worker_executions(execution_id,instance_id,boot_id,boot_sequence,protocol,job_id,resource,slots,sequence,event_state,last_at,last_received_at)
    SELECT md5('execution-'||i)::uuid,'worker-'||(i%24),$1,1,'media',md5('job-'||i)::uuid,'encode',1,i,
      CASE WHEN i%200=0 THEN 'active' ELSE 'released' END,$2,$2 FROM generate_series(1,40000) i`,
    [boot, now],
  );
  await pool.query('ANALYZE mio_compute_worker_executions');
  const queries = new WorkerObservabilityQueries(pool, allowed);
  const query = vi.spyOn(pool, 'query');
  let statement: string;
  let values: unknown[];
  try {
    expect(
      (
        await queries.executions(
          { instanceId: 'worker-0', state: 'active', limit: 100 },
          now.getTime(),
        )
      ).executions.length,
    ).toBeGreaterThan(0);
    [statement, values] = query.mock.calls[0] as unknown as [string, unknown[]];
  } finally {
    query.mockRestore();
  }
  const active = (
    await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) ' + statement, values)
  ).rows[0]['QUERY PLAN'][0];
  expect(planSummary(active).indexes).toContain('mio_compute_worker_executions_open');
  recordProbe(
    'B07_PEAK_AND_ACTIVE_PLANS',
    JSON.stringify({
      peaks: plans,
      active,
      workload:
        'synthetic 40000 event/execution rows; 24 workers; four real event kinds; 5/50/95pct execution; no production capacity claim',
    }),
  );
});

it('rolls back a failed precise inbox delete, skips locked expired samples, and leaves no orphan after retry', async () => {
  const id = await sample('worker-a', '2030-01-01', 1);
  await pool.query("UPDATE mio_compute_worker_inbox SET kind='sample' WHERE message_id=$1", [id]);
  const observations = new WorkerObservabilityStore(pool, ['worker-a']);
  const locker = await pool.connect();
  try {
    await locker.query('BEGIN');
    await locker.query(
      'SELECT message_id FROM mio_compute_worker_samples WHERE message_id=$1 FOR UPDATE',
      [id],
    );
    await observations.prune(new Date('2030-02-01'));
    expect((await pool.query('SELECT message_id FROM mio_compute_worker_samples')).rows).toEqual([
      { message_id: id },
    ]);
  } finally {
    await locker.query('ROLLBACK');
    locker.release();
  }
  const root = new Error('injected inbox delete failure after sample DELETE RETURNING');
  const original = Client.prototype.query;
  const query = vi.spyOn(Client.prototype, 'query').mockImplementation(function (
    this: Client,
    ...args: unknown[]
  ) {
    if (
      typeof args[0] === 'string' &&
      args[0].startsWith('DELETE FROM mio_compute_worker_inbox t WHERE message_id=ANY')
    )
      return Promise.reject(root);
    return Reflect.apply(original, this, args);
  });
  try {
    await expect(observations.prune(new Date('2030-02-01'))).rejects.toBe(root);
  } finally {
    query.mockRestore();
  }
  expect((await pool.query('SELECT message_id FROM mio_compute_worker_samples')).rows).toEqual([
    { message_id: id },
  ]);
  expect((await pool.query('SELECT message_id FROM mio_compute_worker_inbox')).rows).toEqual([
    { message_id: id },
  ]);
  await observations.prune(new Date('2030-02-01'));
  expect((await pool.query('SELECT message_id FROM mio_compute_worker_samples')).rows).toEqual([]);
  expect((await pool.query('SELECT message_id FROM mio_compute_worker_inbox')).rows).toEqual([]);
});

it('evicts a history connection after failed rollback and preserves the original read error', async () => {
  await historyFixture();
  const root = new Error('injected second history read failure');
  const before = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const original = Client.prototype.query;
  const query = vi.spyOn(Client.prototype, 'query').mockImplementation(function (
    this: Client,
    ...args: unknown[]
  ) {
    if (typeof args[0] === 'string' && args[0].startsWith('SELECT DISTINCT ON'))
      return Promise.reject(root);
    if (args[0] === 'ROLLBACK')
      return Promise.reject(new Error('injected rollback delivery failure'));
    return Reflect.apply(original, this, args);
  });
  try {
    await expect(
      new WorkerObservabilityQueries(pool, ids).history(undefined, since, until, 100),
    ).rejects.toBe(root);
  } finally {
    query.mockRestore();
  }
  const after = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  expect(after).not.toBe(before);
  expect(
    await new WorkerObservabilityQueries(pool, ids).history(undefined, since, until, 100),
  ).toEqual(await legacyHistory(100));
});

it('avoids walking retained telemetry during limit-result inbox cleanup with the partial kind index', async () => {
  const now = new Date('2030-02-01T12:00:00Z');
  await pool.query("INSERT INTO mio_compute_worker_instances(instance_id) VALUES('worker-a')");
  await pool.query('DROP INDEX mio_compute_worker_inbox_limit_result_retention');
  await pool.query(
    'CREATE INDEX mio_compute_worker_inbox_retention ON mio_compute_worker_inbox(received_at)',
  );
  await pool.query(
    `INSERT INTO mio_compute_worker_inbox(message_id,instance_id,boot_id,boot_sequence,sequence,digest,received_at,kind)
    SELECT md5('retained-'||i)::uuid,'worker-a',$1,1,i,'retained',$2::timestamptz-interval '20 days','event'
    FROM generate_series(1,40000) i`,
    [boot, now],
  );
  await pool.query(
    `INSERT INTO mio_compute_worker_events(message_id,instance_id,boot_id,boot_sequence,sequence,event_at,received_at,kind,detail,usage)
    SELECT message_id,instance_id,boot_id,boot_sequence,sequence,received_at,received_at,'phase','{}',$1 FROM mio_compute_worker_inbox`,
    [zero],
  );
  await pool.query(
    `INSERT INTO mio_compute_worker_inbox(message_id,instance_id,boot_id,boot_sequence,sequence,digest,received_at,kind)
    SELECT md5('receipt-'||i)::uuid,'worker-a',$1,1,i+40000,'receipt',$2::timestamptz-interval '10 days','limit_result'
    FROM generate_series(1,64) i`,
    [boot, now],
  );
  await pool.query('ANALYZE mio_compute_worker_inbox; ANALYZE mio_compute_worker_events');
  const references = `NOT EXISTS (SELECT 1 FROM mio_compute_worker_samples s WHERE s.message_id=t.message_id)
    AND NOT EXISTS (SELECT 1 FROM mio_compute_worker_events e WHERE e.message_id=t.message_id)
    AND NOT EXISTS (SELECT 1 FROM mio_compute_worker_limit_changes l WHERE l.result_message_id=t.message_id)`;
  const scan = `SELECT t.message_id FROM mio_compute_worker_inbox t
    WHERE t.received_at<$1::timestamptz-interval '7 days' AND ${references} LIMIT 2000 FOR UPDATE SKIP LOCKED`;
  const expected = (await pool.query(scan, [now])).rows;
  const baseline = (
    await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) ' + scan, [now])
  ).rows[0]['QUERY PLAN'][0];
  await pool.query(
    "CREATE INDEX mio_compute_worker_inbox_limit_result_retention ON mio_compute_worker_inbox(received_at) WHERE kind='limit_result'",
  );
  await pool.query('DROP INDEX mio_compute_worker_inbox_retention');
  const precise = scan.replace(
    'WHERE t.received_at',
    "WHERE kind='limit_result' AND t.received_at",
  );
  expect(
    (await pool.query(precise, [now])).rows.sort((a, b) =>
      a.message_id.localeCompare(b.message_id),
    ),
  ).toEqual(expected.sort((a, b) => a.message_id.localeCompare(b.message_id)));
  const candidate = (
    await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) ' + precise, [now])
  ).rows[0]['QUERY PLAN'][0];
  expect(planSummary(candidate).indexes).toContain(
    'mio_compute_worker_inbox_limit_result_retention',
  );
  await new WorkerObservabilityStore(pool, ['worker-a']).prune(now);
  expect(
    Number((await pool.query('SELECT count(*) FROM mio_compute_worker_inbox')).rows[0].count),
  ).toBe(40000);
  recordProbe('B07_INBOX_PLANS', {
    retainedEvents: 40000,
    expiredReceipts: 64,
    baseline: planSummary(baseline),
    candidate: planSummary(candidate),
    baselinePlan: baseline,
    candidatePlan: candidate,
  });
});
