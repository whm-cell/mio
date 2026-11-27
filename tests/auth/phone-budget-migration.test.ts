import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { authDeletionGuardsSQL } from '../../src/auth/deletion-schema.ts';
import { randomBytes } from 'node:crypto';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { authOptions, readAuthConfig } from '../../src/auth/config.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import { authDatabase } from '../support/auth-database.ts';

const origin = 'http://127.0.0.1:6199';
const secret = randomBytes(40).toString('hex');
let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
const services: Awaited<ReturnType<typeof createAuthentication>>[] = [];

const configEnv = (databaseURL = database.url) => ({
  MIO_AUTH_BASE_URL: origin,
  MIO_AUTH_SECRET: secret,
  MIO_AUTH_DATABASE_URL: databaseURL,
});
const config = (databaseURL?: string) => readAuthConfig(configEnv(databaseURL))!;

beforeEach(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.observerURL });
}, 30_000);

afterEach(async () => {
  try {
    await Promise.all(services.splice(0).map((service) => service.close()));
  } finally {
    try {
      if (pool) await pool.end();
    } finally {
      if (database) await database.close();
    }
  }
});

function runMigration(args: string[], databaseURL = database.url) {
  return spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', ...args], {
    env: configEnv(databaseURL),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function migrate(args: string[] = [], databaseURL = database.url) {
  const result = runMigration(args, databaseURL);
  expect(result.status, result.error?.message ?? result.stderr).toBe(0);
  return result.stdout;
}

async function legacySchema() {
  // These are the original Better Auth tables, before the dedicated SMS event migration.
  await (await getMigrations(authOptions(config(), pool))).runMigrations();
  await pool.query(authDeletionGuardsSQL);
}

function request(path: string, body: unknown) {
  return new Request(`${origin}/api/auth/${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-mio-client-ip': '192.0.2.10' },
    body: JSON.stringify(body),
  });
}

async function schemaVersion() {
  const { rows } = await pool.query(`SELECT
    to_regclass('"mioSmsBudget"')::text AS budget,
    to_regclass('"mioSmsBudgetEvent"')::text AS event,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('"mioSmsBudget"')
      AND conname = 'mioSmsBudgetEventsEmpty') AS fence`);
  return rows[0];
}

async function eventRows(observer = pool) {
  const { rows } = await observer.query<{ budgetId: string; occurredAtMs: string }>(
    `SELECT "budgetId", "occurredAtMs" FROM "mioSmsBudgetEvent" ORDER BY "budgetId", "occurredAtMs"`,
  );
  return rows.map(({ budgetId, occurredAtMs }) => [budgetId, Number(occurredAtMs)]);
}

async function legacyRows() {
  const { rows } = await pool.query<{ id: string; events: string }>(
    'SELECT id, events FROM "mioSmsBudget" ORDER BY id',
  );
  return rows.flatMap(({ id, events }) =>
    (JSON.parse(events) as number[]).map((event) => [id, event]),
  );
}

async function databaseTime() {
  const { rows } = await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  return rows[0]!.now.getTime();
}

it('only applies SMS tables from the explicit command on a fresh database', async () => {
  await expect(createAuthentication(config())).rejects.toThrow('AUTH_SCHEMA');
  expect(migrate()).toContain('SMS budget migration will switch to indexed events');
  expect(await schemaVersion()).toEqual({ budget: null, event: null, fence: false });
  expect(migrate(['--apply'])).toContain('Authentication schema migration completed.');
  expect(await schemaVersion()).toEqual({
    budget: '"mioSmsBudget"',
    event: '"mioSmsBudgetEvent"',
    fence: true,
  });
  expect(migrate()).toContain('Authentication schema is current.');
  const auth = await createAuthentication(config());
  services.push(auth);
  const response = await auth.handler(
    request('phone-number/send-otp', { phoneNumber: '13800138101' }),
  );
  expect(response.status).toBe(503);
  expect(await eventRows()).toEqual([]);
}, 20_000);

it('copies the last 24 hours without deduplicating and restores events written after cutover', async () => {
  await legacySchema();
  const disabled = await createAuthentication(config());
  services.push(disabled);
  const signUp = await disabled.handler(
    request('sign-up/email', {
      name: 'Existing owner',
      email: 'owner@example.test',
      password: 'sms-migration-fixture-password',
    }),
  );
  expect(signUp.status).toBe(200);
  const session = signUp.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const principal = await disabled.identity(new Headers({ cookie: session }));
  expect(principal?.userId).toBeTruthy();

  let sends = 0;
  const sender = async () => {
    sends++;
  };
  await expect(createAuthentication(config(), undefined, sender)).rejects.toThrow('AUTH_SCHEMA');
  const stamp = await databaseTime();
  const duplicate = stamp - 30_000;
  const expired = stamp - 86_401_000;
  const historicalKey = 'phone:' + 'a'.repeat(64);
  await pool.query(
    `INSERT INTO "mioSmsBudget" (id, events, "updatedAt")
     VALUES ('global', $1, clock_timestamp()), ($2, $3, clock_timestamp() - interval '25 hours')`,
    [JSON.stringify([expired, duplicate, duplicate]), historicalKey, JSON.stringify([duplicate])],
  );
  expect(migrate()).toContain('preserve the current 24-hour window');
  expect((await schemaVersion()).event).toBeNull();
  expect(await legacyRows()).toEqual([
    ['global', expired],
    ['global', duplicate],
    ['global', duplicate],
    [historicalKey, duplicate],
  ]);
  migrate(['--apply']);
  const converted = [
    ['global', duplicate],
    ['global', duplicate],
    [historicalKey, duplicate],
  ];
  expect(await eventRows()).toEqual(converted);
  expect(await legacyRows()).toEqual([]);
  migrate(['--apply']);
  expect(await eventRows()).toEqual(converted);

  // The earlier writer updates its array before calling the provider.
  await expect(
    pool.query('UPDATE "mioSmsBudget" SET events = $1 WHERE id = $2', [
      JSON.stringify([duplicate]),
      'global',
    ]),
  ).rejects.toMatchObject({ code: '23514', constraint: 'mioSmsBudgetEventsEmpty' });
  const auth = await createAuthentication(config(), undefined, sender);
  services.push(auth);
  expect(await auth.identity(new Headers({ cookie: session }))).toEqual(principal);
  const response = await auth.handler(
    request('phone-number/send-otp', { phoneNumber: '13800138102' }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  expect(sends).toBe(1);
  const withNewEvents = await eventRows();
  expect(withNewEvents).toHaveLength(6);
  expect(withNewEvents).toEqual(expect.arrayContaining(converted));
  expect(migrate(['--rollback-sms-budget'])).toContain('restore all current-window events');
  expect(await eventRows()).toEqual(withNewEvents);
  expect(await legacyRows()).toEqual([]);

  migrate(['--rollback-sms-budget', '--apply']);
  expect(await schemaVersion()).toEqual({ budget: '"mioSmsBudget"', event: null, fence: false });
  expect(await legacyRows()).toEqual(withNewEvents);
  expect(migrate(['--apply', '--rollback-sms-budget'])).toContain(
    'already uses the earlier writer layout',
  );
  expect(await legacyRows()).toEqual(withNewEvents);
  const afterRollback = await auth.handler(
    request('phone-number/send-otp', { phoneNumber: '13800138103' }),
  );
  expect(afterRollback.status).toBe(503);
  expect(sends).toBe(1);
  expect(await legacyRows()).toEqual(withNewEvents);
  expect(await disabled.identity(new Headers({ cookie: session }))).toEqual(principal);
  await expect(createAuthentication(config(), undefined, sender)).rejects.toThrow('AUTH_SCHEMA');

  migrate(['--apply']);
  expect(await eventRows()).toEqual(withNewEvents);
}, 20_000);

it.each(['{"unexpected":"private-fixture"}', '[1.25]', '[9007199254740991]'])(
  'rejects invalid legacy budget data before switching',
  async (events) => {
    await legacySchema();
    await pool.query('INSERT INTO "mioSmsBudget" VALUES ($1, $2, clock_timestamp())', [
      'global',
      events,
    ]);
    for (const args of [[], ['--apply']]) {
      const result = runMigration(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('AUTH_SCHEMA: invalid legacy SMS budget events');
      expect(result.stderr).not.toContain(events);
      expect(await schemaVersion()).toEqual({
        budget: '"mioSmsBudget"',
        event: null,
        fence: false,
      });
      expect((await pool.query('SELECT events FROM "mioSmsBudget"')).rows).toEqual([{ events }]);
    }
  },
  20_000,
);

it('rolls back both layout changes if the rewrite is interrupted and resumes on retry', async () => {
  await legacySchema();
  const stamp = await databaseTime();
  const events = JSON.stringify([stamp, stamp]);
  await pool.query('INSERT INTO "mioSmsBudget" VALUES ($1, $2, clock_timestamp())', [
    'global',
    events,
  ]);
  await pool.query(`CREATE FUNCTION reject_budget_migration() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture interruption after DDL'; END $$`);
  const addTrigger = () =>
    pool.query(`CREATE TRIGGER reject_budget_migration
    BEFORE UPDATE ON "mioSmsBudget" FOR EACH STATEMENT EXECUTE FUNCTION reject_budget_migration()`);
  const dropTrigger = () => pool.query('DROP TRIGGER reject_budget_migration ON "mioSmsBudget"');
  await addTrigger();
  const failedForward = runMigration(['--apply']);
  expect(failedForward.status).toBe(1);
  expect(failedForward.stderr).toContain('fixture interruption after DDL');
  expect(await schemaVersion()).toEqual({ budget: '"mioSmsBudget"', event: null, fence: false });
  expect(await legacyRows()).toEqual([
    ['global', stamp],
    ['global', stamp],
  ]);
  await dropTrigger();
  migrate(['--apply']);
  const converted = await eventRows();
  expect(converted).toEqual([
    ['global', stamp],
    ['global', stamp],
  ]);

  await addTrigger();
  const failedRollback = runMigration(['--rollback-sms-budget', '--apply']);
  expect(failedRollback.status).toBe(1);
  expect(failedRollback.stderr).toContain('fixture interruption after DDL');
  expect(await schemaVersion()).toEqual({
    budget: '"mioSmsBudget"',
    event: '"mioSmsBudgetEvent"',
    fence: true,
  });
  expect(await eventRows()).toEqual(converted);
  expect(await legacyRows()).toEqual([]);
  await dropTrigger();
  migrate(['--rollback-sms-budget', '--apply']);
  expect(await legacyRows()).toEqual(converted);
}, 20_000);

it('does not admit or repair a partial layout during startup or migration', async () => {
  migrate(['--apply']);
  await pool.query('DROP INDEX "mioSmsBudgetEvent_budget_time"');
  await expect(createAuthentication(config())).rejects.toThrow('AUTH_SCHEMA');
  for (const args of [[], ['--apply'], ['--rollback-sms-budget', '--apply']]) {
    const result = runMigration(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AUTH_SCHEMA: incomplete or invalid indexed SMS budget layout');
  }
  expect(await schemaVersion()).toEqual({
    budget: '"mioSmsBudget"',
    event: '"mioSmsBudgetEvent"',
    fence: true,
  });
}, 20_000);

it('keeps both budget relations in the owning schema through cutover and rollback', async () => {
  const fallback = await authDatabase();
  const fallbackPool = new Pool({ connectionString: fallback.observerURL });
  let fallbackAuth: Awaited<ReturnType<typeof createAuthentication>> | undefined;
  try {
    migrate(['--apply'], fallback.url);
    const phoneNumber = '13800138104';
    const smsPath = 'phone-number/send-otp';
    fallbackAuth = await createAuthentication(config(fallback.url), undefined, async () => {});
    expect((await fallbackAuth.handler(request(smsPath, { phoneNumber }))).status).toBe(200);
    await fallbackPool.query(
      'UPDATE "mioSmsBudgetEvent" SET "occurredAtMs" = "occurredAtMs" - 120000',
    );
    const fallbackState = async () => ({
      events: await eventRows(fallbackPool),
      keys: (await fallbackPool.query('SELECT * FROM "mioSmsBudget" ORDER BY id')).rows,
      challenges: (await fallbackPool.query('SELECT id, status FROM "mioPhoneChallenge"')).rows,
    });
    const fallbackBefore = await fallbackState();
    expect(fallbackBefore.events).toHaveLength(3);

    await legacySchema();
    const combined = new URL(database.url);
    combined.searchParams.set(
      'options',
      `-csearch_path=${database.applicationName},${fallback.applicationName}`,
    );
    const selected = combined.toString();
    const disabled = await createAuthentication(config(selected));
    services.push(disabled);
    const signedUp = await disabled.handler(
      request('sign-up/email', {
        name: 'Selected schema owner',
        email: 'selected@example.test',
        password: 'selected-schema-fixture-password',
      }),
    );
    expect(signedUp.status).toBe(200);
    const session = signedUp.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const principal = await disabled.identity(new Headers({ cookie: session }));
    expect(principal?.userId).toBeTruthy();

    expect(migrate([], selected)).toContain('switch to indexed events');
    migrate(['--apply'], selected);
    let sends = 0;
    const auth = await createAuthentication(config(selected), undefined, async () => {
      sends++;
    });
    services.push(auth);
    expect((await auth.handler(request(smsPath, { phoneNumber: '13800138105' }))).status).toBe(200);
    expect(sends).toBe(1);
    const selectedEvents = await eventRows();
    expect(selectedEvents).toHaveLength(3);
    expect(await fallbackState()).toEqual(fallbackBefore);

    expect(migrate(['--rollback-sms-budget'], selected)).toContain(
      'restore all current-window events',
    );
    migrate(['--rollback-sms-budget', '--apply'], selected);
    expect((await schemaVersion()).event).toBeNull();
    expect(await legacyRows()).toEqual(selectedEvents);
    expect((await auth.handler(request(smsPath, { phoneNumber }))).status).toBe(503);
    expect(sends).toBe(1);
    expect(await legacyRows()).toEqual(selectedEvents);
    const restarted = await createAuthentication(config(selected));
    services.push(restarted);
    expect(await restarted.identity(new Headers({ cookie: session }))).toEqual(principal);
    expect((await restarted.handler(request(smsPath, { phoneNumber }))).status).toBe(503);
    expect(await fallbackState()).toEqual(fallbackBefore);
  } finally {
    try {
      await fallbackAuth?.close();
    } finally {
      try {
        await fallbackPool.end();
      } finally {
        await fallback.close();
      }
    }
  }
}, 20_000);

it('sets effective auth migration startup lock_timeout while preserving URL search_path/options', async () => {
  const url = new URL(database.url);
  url.searchParams.set(
    'options',
    `${url.searchParams.get('options')} -cstatement_timeout=11000 -clock_timeout=0`,
  );
  url.searchParams.set('lock_timeout', '0');
  const trace = `data:text/javascript,${encodeURIComponent(`
    import pg from ${JSON.stringify(pathToFileURL(resolve('node_modules/pg/lib/index.js')).href)};
    const query = pg.Client.prototype.query;
    pg.Client.prototype.query = async function(...args) {
      const sql=typeof args[0]==='string'?args[0]:args[0].text;
      if (/^create table/i.test(sql)) {
        const lock=await query.call(this,'SHOW lock_timeout');
        const statement=await query.call(this,'SHOW statement_timeout');
        const schema=await query.call(this,'SELECT current_schema() AS schema');
        console.log(JSON.stringify({trace:'auth-ddl',lock:lock.rows[0].lock_timeout,statement:statement.rows[0].statement_timeout,schema:schema.rows[0].schema}));
      }
      return query.apply(this,args);
    };
  `)}`;
  const result = spawnSync(
    process.execPath,
    ['--import', trace, 'scripts/service/migrate-auth.ts', '--apply'],
    {
      env: configEnv(url.toString()),
      encoding: 'utf8',
      timeout: 15000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const traces = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  console.log('MIGRATION_AUTH_SETTINGS', JSON.stringify(traces));
  expect(traces.length).toBeGreaterThan(1);
  expect(
    traces.every(
      (row) =>
        row.lock === '5s' && row.statement === '11s' && row.schema === database.applicationName,
    ),
  ).toBe(true);
  expect((await pool.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
  expect((await schemaVersion()).event).toBe('"mioSmsBudgetEvent"');
});

it('times out a blocked third-party auth ALTER and succeeds after the lock is released', async () => {
  await legacySchema();
  await pool.query('ALTER TABLE "user" DROP COLUMN "emailVerified"');
  const blocker = await pool.connect();
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<unknown> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE "user" IN SHARE MODE');
    child = spawn(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
      env: configEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = once(child, 'close');
    child.stdout!.resume();
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += chunk;
    });
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = Boolean(
        (
          await pool.query(
            `SELECT 1 FROM pg_stat_activity
        WHERE application_name=$1 AND wait_event_type='Lock' AND query ILIKE 'alter table%'`,
            [database.applicationName],
          )
        ).rowCount,
      );
      if (waiting) break;
      await delay(50);
    }
    expect(waiting, stderr).toBe(true);
    expect(
      await Promise.race([closed, delay(7500).then(() => 'did not exit on lock timeout')]),
      stderr,
    ).toEqual([1, null]);
    expect(stderr).toContain('lock timeout');
    expect(
      (
        await pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='user' AND column_name='emailVerified'`)
      ).rows,
    ).toEqual([]);
    await blocker.query('ROLLBACK');
    migrate(['--apply']);
    expect(
      (
        await pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='user' AND column_name='emailVerified'`)
      ).rows,
    ).toHaveLength(1);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    if (closed) await closed;
    await blocker.query('ROLLBACK');
    blocker.release();
  }
});
