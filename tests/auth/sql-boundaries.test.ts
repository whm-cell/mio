import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import type { Client, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { sha256Utf8 } from '@mio/foundation/hash';
import { readAuthConfig } from '../../src/auth/config.ts';
import { readSmsBudgetSchema } from '../../src/auth/phone-budget-schema.ts';
import type { SmsBudgetTables } from '../../src/auth/phone-budget-schema.ts';
import { reservePhoneChallenge } from '../../src/auth/phone-store.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import { withAuthTransaction } from '../../src/auth/transaction.ts';
import { authDatabase } from '../support/auth-database.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let observer: Pool;
let runtimePool: Pool;
let auth: Awaited<ReturnType<typeof createAuthentication>>;
let tables: SmsBudgetTables;
const secret = randomBytes(40).toString('hex');
const phone = '+8613800138101';
const ip = '127.0.0.101';
const ids = ['global', `ip:${sha256Utf8(ip)}`, `phone:${sha256Utf8(phone)}`];
const limits = {
  globalDay: 1000,
  accountOpsDay: 1000,
  ipHour: 20,
  ipDay: 100,
  phoneHour: 5,
  phoneDay: 10,
};

beforeAll(async () => {
  const target = new URL(process.env.MIO_TEST_DATABASE_URL!);
  if (
    process.env.GITHUB_ACTIONS !== 'true' &&
    (target.pathname !== '/mio_regression_test' || target.username !== 'mio_regression')
  )
    throw new Error('AUTH_SQL_REQUIRES_ISOLATED_REGRESSION_DATABASE');
  database = await authDatabase();
  pool = new Pool({
    connectionString: database.url,
    connectionTimeoutMillis: 5000,
    query_timeout: 8000,
  });
  observer = new Pool({ connectionString: database.observerURL, connectionTimeoutMillis: 5000 });
  const migrated = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      PATH: process.env.PATH ?? '',
      MIO_AUTH_BASE_URL: 'http://127.0.0.1',
      MIO_AUTH_SECRET: secret,
      MIO_AUTH_DATABASE_URL: database.url,
    },
  });
  expect(migrated.status, migrated.stderr).toBe(0);
  tables = (await readSmsBudgetSchema(pool)).tables;
  const runtimePools = new Set<Pool>();
  const original = Pool.prototype.connect;
  const capture = vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (
    this: Pool,
    ...args: unknown[]
  ) {
    if ((this.options as { application_name?: string }).application_name === 'mio-auth')
      runtimePools.add(this);
    return Reflect.apply(original, this, args);
  });
  try {
    auth = await createAuthentication(
      readAuthConfig({
        MIO_AUTH_BASE_URL: 'http://127.0.0.1',
        MIO_AUTH_SECRET: secret,
        MIO_AUTH_DATABASE_URL: database.url,
      })!,
    );
  } finally {
    capture.mockRestore();
  }
  expect(runtimePools.size).toBe(1);
  runtimePool = [...runtimePools][0]!;
  process.stdout.write(
    'AUTH_SQL_DATABASE ' +
      JSON.stringify(
        (
          await observer.query(
            'SELECT current_database() AS database,current_user AS role,current_schema() AS schema,version() AS version',
          )
        ).rows[0],
      ) +
      '\n',
  );
}, 45000);

beforeEach(async () => {
  await pool.query('DELETE FROM "mioPhoneChallenge"');
  await pool.query('DELETE FROM "mioSmsBudget"');
});
afterAll(async () => {
  await auth?.close();
  await pool?.end();
  await observer?.end();
  await database?.close();
}, 30000);

async function seed(keys: string[], expired = false) {
  await pool.query(
    `INSERT INTO "mioSmsBudget" (id,events,"updatedAt")
     SELECT id,'[]',clock_timestamp()-CASE WHEN $2 THEN interval '25 hours' ELSE interval '0' END
     FROM unnest($1::text[]) AS bucket(id)`,
    [keys, expired],
  );
}
async function block(key: string) {
  const client = await observer.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM "mioSmsBudget" WHERE id=$1 FOR UPDATE', [key]);
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  return { client, pid };
}
async function waitingOn(pid: number) {
  return vi.waitFor(
    async () => {
      const { rows } = await observer.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE application_name=$1
       AND wait_event_type='Lock' AND $2::int=ANY(pg_blocking_pids(pid))`,
        [database.applicationName, pid],
      );
      expect(rows).toHaveLength(1);
      return rows[0]!.pid;
    },
    { timeout: 2000, interval: 10 },
  );
}
async function release(client: PoolClient) {
  try {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}
const reserve = () => reservePhoneChallenge(pool, tables, secret, limits, 'login', phone, ip);

it('bounds plain runtime queries on the server before the client read deadline', async () => {
  const settings = (
    await runtimePool.query(
      `SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`,
    )
  ).rows[0];
  expect(settings).toEqual({ statement: '5s', lock: '3s' });
  expect(runtimePool.options.query_timeout).toBe(8000);
  await expect(runtimePool.query('SELECT pg_sleep(5.2)')).rejects.toMatchObject({ code: '57014' });
  expect((await runtimePool.query('SELECT 1 AS alive')).rows).toEqual([{ alive: 1 }]);
}, 10000);

it('bounds a plain runtime row-lock wait independently of transaction helpers', async () => {
  await seed(['global']);
  const blocker = await block('global');
  try {
    const query = {
      text: 'SELECT id FROM "mioSmsBudget" WHERE id=$1 FOR UPDATE',
      values: ['global'],
      query_timeout: 6500,
    };
    await expect(runtimePool.query(query)).rejects.toMatchObject({ code: '55P03' });
  } finally {
    await release(blocker.client);
  }
}, 10000);

it('retains local deadlines and resets them for an independently supplied pool', async () => {
  expect((await pool.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
  const settings = await withAuthTransaction(
    pool,
    async (client) =>
      (
        await client.query(
          `SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`,
        )
      ).rows[0],
  );
  expect(settings).toEqual({ statement: '5s', lock: '3s' });
  expect((await pool.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
});

it('keeps global ownership ahead of lower-key insert and unique-lock acquisition', async () => {
  await seed(['global']);
  const blocker = await block('global');
  const pending = reserve();
  void pending.catch(() => {});
  try {
    await waitingOn(blocker.pid);
    const independent = await observer.connect();
    try {
      await independent.query('BEGIN');
      await independent.query("SET LOCAL lock_timeout='100ms'");
      await independent.query(
        `INSERT INTO "mioSmsBudget"(id,events,"updatedAt")
         SELECT id,'[]',clock_timestamp() FROM unnest($1::text[]) AS bucket(id)`,
        [ids.slice(1)],
      );
      await independent.query('COMMIT');
    } finally {
      await release(independent);
    }
    await blocker.client.query('COMMIT');
    const challenge = await pending;
    expect((await observer.query('SELECT id,status FROM "mioPhoneChallenge"')).rows).toEqual([
      { id: challenge.id, status: 'pending' },
    ]);
    expect(
      (await observer.query('SELECT count(*)::int n FROM "mioSmsBudgetEvent"')).rows[0].n,
    ).toBe(3);
  } finally {
    await release(blocker.client);
    await pending.catch(() => {});
  }
});

it('locks IP before phone while retaining global and acquired IP ownership', async () => {
  await seed(ids);
  const ipBlocker = await block(ids[1]!);
  const phoneBlocker = await block(ids[2]!);
  const pending = reserve();
  void pending.catch(() => {});
  try {
    const waiter = await waitingOn(ipBlocker.pid);
    expect(
      (await observer.query('SELECT pg_blocking_pids($1) AS pids', [waiter])).rows[0].pids,
    ).not.toContain(phoneBlocker.pid);
    await ipBlocker.client.query('COMMIT');
    expect(await waitingOn(phoneBlocker.pid)).toBe(waiter);
    for (const key of ids.slice(0, 2))
      await expect(
        observer.query('SELECT id FROM "mioSmsBudget" WHERE id=$1 FOR UPDATE NOWAIT', [key]),
      ).rejects.toMatchObject({ code: '55P03' });
    await phoneBlocker.client.query('COMMIT');
    await pending;
    const events = (
      await observer.query(
        'SELECT "budgetId",count(*)::int n FROM "mioSmsBudgetEvent" GROUP BY "budgetId" ORDER BY "budgetId"',
      )
    ).rows;
    expect(events).toEqual([...ids].sort().map((id) => ({ budgetId: id, n: 1 })));
  } finally {
    await release(ipBlocker.client);
    await release(phoneBlocker.client);
    await pending.catch(() => {});
  }
});

it('skips locked stale parents and cascades only the expired keys it can safely clean', async () => {
  await seed(['stale:free', 'stale:locked'], true);
  await pool.query(
    `INSERT INTO "mioSmsBudgetEvent"("budgetId","occurredAtMs")
     SELECT id,0 FROM "mioSmsBudget" WHERE id=ANY($1::text[])`,
    [['stale:free', 'stale:locked']],
  );
  const blocker = await block('stale:locked');
  try {
    await reserve();
    expect(
      (await observer.query('SELECT id FROM "mioSmsBudget" WHERE id LIKE $1', ['stale:%'])).rows,
    ).toEqual([{ id: 'stale:locked' }]);
    expect(
      (await observer.query('SELECT "budgetId" FROM "mioSmsBudgetEvent" WHERE "occurredAtMs"=0'))
        .rows,
    ).toEqual([{ budgetId: 'stale:locked' }]);
    await blocker.client.query('COMMIT');
    await reservePhoneChallenge(pool, tables, secret, limits, 'login', '+8613800138102', ip);
    expect(
      (await observer.query('SELECT "budgetId" FROM "mioSmsBudgetEvent" WHERE "occurredAtMs"=0'))
        .rows,
    ).toEqual([]);
    expect(
      (await observer.query('SELECT count(*)::int n FROM "mioPhoneChallenge"')).rows[0].n,
    ).toBe(2);
  } finally {
    await release(blocker.client);
  }
});

it('rolls back the entire reservation if expired-parent cascade cannot lock its child event', async () => {
  await seed(['stale:blocked-event'], true);
  await pool.query('INSERT INTO "mioSmsBudgetEvent"("budgetId","occurredAtMs") VALUES($1,0)', [
    'stale:blocked-event',
  ]);
  const blocker = await observer.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT * FROM "mioSmsBudgetEvent" WHERE "budgetId"=$1 FOR UPDATE', [
      'stale:blocked-event',
    ]);
    await expect(reserve()).rejects.toMatchObject({ code: '55P03' });
    expect((await observer.query('SELECT id FROM "mioSmsBudget"')).rows).toEqual([
      { id: 'stale:blocked-event' },
    ]);
    expect((await observer.query('SELECT * FROM "mioPhoneChallenge"')).rows).toEqual([]);
    expect(
      (await observer.query('SELECT "budgetId","occurredAtMs" FROM "mioSmsBudgetEvent"')).rows,
    ).toEqual([{ budgetId: 'stale:blocked-event', occurredAtMs: '0' }]);
  } finally {
    await release(blocker);
  }
}, 10000);

it('retains debit and pending atomicity while recording actual reservation SQL traffic', async () => {
  const client = await pool.connect();
  const original = client.query;
  const statements: string[] = [];
  const trace = vi.spyOn(client, 'query').mockImplementation(function (
    this: Client,
    ...args: unknown[]
  ) {
    statements.push(typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text);
    return Reflect.apply(original, this, args);
  });
  client.release();
  try {
    const challenge = await reserve();
    expect((await observer.query('SELECT id,status FROM "mioPhoneChallenge"')).rows).toEqual([
      { id: challenge.id, status: 'pending' },
    ]);
    expect(
      (await observer.query('SELECT count(*)::int n FROM "mioSmsBudgetEvent"')).rows[0].n,
    ).toBe(3);
    process.stdout.write('AUTH_RESERVATION_SQL ' + JSON.stringify(statements) + '\n');
  } finally {
    trace.mockRestore();
  }
});
