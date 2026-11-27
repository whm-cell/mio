import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { WorkerControlStore } from '../../src/compute/observability/control.ts';
import { WorkerObservabilityQueries } from '../../src/compute/observability/queries.ts';
import {
  openWorkerObservabilityPools,
  WorkerObservabilityStore,
} from '../../src/compute/observability/store.ts';
import { authDatabase } from '../support/auth-database.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
beforeAll(async () => {
  const target = new URL(process.env.MIO_TEST_DATABASE_URL!);
  if (
    process.env.GITHUB_ACTIONS !== 'true' &&
    (target.pathname !== '/mio_regression_test' || target.username !== 'mio_regression')
  )
    throw new Error('B07_REQUIRES_MIO_DEV_REGRESSION_DATABASE');
  database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    await pool.query(assetSchemaSQL);
    await pool.query(computeSchemaSQL);
  } finally {
    await pool.end();
  }
});
afterAll(async () => {
  await database?.close();
});

it('keeps two queued readers independent from three write/control connections with actual SQL and driver budgets', async () => {
  const pools = await openWorkerObservabilityPools(database.url);
  const first = await pools.read.connect();
  const second = await pools.read.connect();
  const now = Date.parse('2030-01-01T00:00:00Z');
  const queries = new WorkerObservabilityQueries(pools.read, ['worker-a']);
  const waiting = queries.workers(1, 0, now);
  const writers: PoolClient[] = [];
  try {
    await vi.waitFor(() => expect(pools.read.waitingCount).toBe(1));
    const budgets = `SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`;
    expect((await first.query(budgets)).rows[0]).toEqual({ statement: '5s', lock: '3s' });
    expect((await pools.write.query(budgets)).rows[0]).toEqual({ statement: '5s', lock: '3s' });
    expect(pools.read.options).toMatchObject({
      max: 2,
      statement_timeout: 5000,
      query_timeout: 8000,
      lock_timeout: 3000,
    });
    expect(pools.write.options).toMatchObject({
      max: 3,
      statement_timeout: 5000,
      query_timeout: 8000,
      lock_timeout: 3000,
    });
    const observations = new WorkerObservabilityStore(pools.write, ['worker-a']);
    const control = new WorkerControlStore(pools.write, ['worker-a']);
    const zero = { total: 0, encode: 0, probe: 0 };
    const one = { total: 1, encode: 1, probe: 1 };
    await observations.receive(
      {
        version: 1,
        type: 'worker.telemetry',
        messageId: randomUUID(),
        instanceId: 'worker-a',
        bootId: randomUUID(),
        bootSequence: 1,
        sequence: 1,
        observedAt: now,
        limits: { hard: one, applied: one, revision: 0 },
        usage: zero,
        waiting: zero,
        holds: { encode: [], probe: [] },
        active: [],
        event: null,
      },
      new Date(now),
    );
    const command = await control.request('worker-a', 'pool-operator', 0, zero);
    const claim = await control.claim(new Set(), now);
    expect(claim?.command.messageId).toBe(command.commandId);
    expect(
      (
        await pools.write.query(
          'SELECT lease_until FROM mio_compute_worker_control_outbox WHERE command_id=$1',
          [command.commandId],
        )
      ).rows[0].lease_until,
    ).toEqual(new Date(now + 30_000));
    expect(await control.claim(new Set(), now + 30_000)).toBeNull();
    const renewed = await control.claim(new Set(), now + 30_001);
    expect(renewed?.command.messageId).toBe(command.commandId);
    await control.settle(command.commandId, claim!.lease, true, now + 31_000);
    expect(
      (
        await pools.write.query(
          'SELECT sent_at FROM mio_compute_worker_control_outbox WHERE command_id=$1',
          [command.commandId],
        )
      ).rows[0].sent_at,
    ).toBeNull();
    await control.settle(command.commandId, renewed!.lease, true, now + 32_000);
    expect(
      (
        await pools.write.query(
          'SELECT sent_at FROM mio_compute_worker_control_outbox WHERE command_id=$1',
          [command.commandId],
        )
      ).rows[0].sent_at,
    ).toEqual(new Date(now + 32_000));
    expect(pools.read.waitingCount).toBe(1); // Control completed with both readers still occupied.
    writers.push(
      ...(await Promise.all([pools.write.connect(), pools.write.connect(), pools.write.connect()])),
    );
    const pids = await Promise.all(
      writers.map((client) => client.query('SELECT pg_backend_pid() AS pid')),
    );
    expect(new Set(pids.map((result) => result.rows[0].pid)).size).toBe(3);
    process.stdout.write(
      'B07_POOL_ISOLATION ' +
        JSON.stringify({
          readMax: pools.read.options.max,
          writeMax: pools.write.options.max,
          readQueueDuringControl: pools.read.waitingCount,
          writerPids: pids.map((result) => result.rows[0].pid),
          statement: 5000,
          query: 8000,
          lock: 3000,
        }) +
        '\n',
    );
  } finally {
    writers.forEach((client) => client.release());
    first.release();
    second.release();
    await waiting;
    await pools.close();
  }
  expect(pools.read.totalCount).toBe(0);
  expect(pools.write.totalCount).toBe(0);
});

it('closes both actual pools even when one end reports failure', async () => {
  const pools = await openWorkerObservabilityPools(database.url);
  const original = pools.read.end.bind(pools.read);
  const failed = vi.spyOn(pools.read, 'end').mockImplementation(async () => {
    await original();
    throw new Error('injected read close failure');
  });
  const other = vi.spyOn(pools.write, 'end');
  try {
    await expect(pools.close()).rejects.toBeInstanceOf(AggregateError);
    expect(other).toHaveBeenCalledOnce();
    expect(pools.read.ended).toBe(true);
    expect(pools.write.ended).toBe(true);
    expect(pools.read.totalCount + pools.write.totalCount).toBe(0);
  } finally {
    failed.mockRestore();
    other.mockRestore();
  }
});

it('releases both pools on schema-open failure and keeps the original error even if cleanup fails', async () => {
  const originalQuery = Client.prototype.query;
  const originalEnd = Pool.prototype.end;
  const closed: Pool[] = [];
  const budgets: unknown[] = [];
  const query = vi.spyOn(Client.prototype, 'query').mockImplementation(function (
    this: Client,
    ...args: unknown[]
  ) {
    budgets.push((this as unknown as { connectionParameters: unknown }).connectionParameters);
    return Reflect.apply(originalQuery, this, ['SELECT 1/0', ...args.slice(1)]);
  });
  const end = vi.spyOn(Pool.prototype, 'end').mockImplementation(function (
    this: Pool,
    ...args: unknown[]
  ) {
    return Reflect.apply(originalEnd, this, args).then(() => {
      closed.push(this);
      if (this.options.max === 2) throw new Error('injected close after schema failure');
    });
  });
  try {
    await expect(openWorkerObservabilityPools(database.url)).rejects.toMatchObject({
      code: '22012',
    });
    expect(closed.map((pool) => pool.options.max).sort()).toEqual([2, 3]);
    expect(closed.every((pool) => pool.ended && pool.totalCount === 0)).toBe(true);
    for (const budget of budgets)
      expect(budget).toMatchObject({
        statement_timeout: 5000,
        query_timeout: 8000,
        lock_timeout: 3000,
      });
  } finally {
    query.mockRestore();
    end.mockRestore();
  }
});
