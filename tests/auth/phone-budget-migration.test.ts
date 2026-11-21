import { spawnSync } from 'node:child_process';
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

const configEnv = () => ({
  MIO_AUTH_BASE_URL: origin,
  MIO_AUTH_SECRET: secret,
  MIO_AUTH_DATABASE_URL: database.url,
});
const config = () => readAuthConfig(configEnv())!;

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

function runMigration(...args: string[]) {
  return spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', ...args], {
    env: configEnv(),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function migrate(...args: string[]) {
  const result = runMigration(...args);
  expect(result.status, result.error?.message ?? result.stderr).toBe(0);
  return result.stdout;
}

async function legacySchema() {
  // These are the original Better Auth tables, before the dedicated SMS event migration.
  await (await getMigrations(authOptions(config(), pool))).runMigrations();
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

async function eventRows() {
  const { rows } = await pool.query<{ budgetId: string; occurredAtMs: string }>(
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
  expect(migrate('--apply')).toContain('Authentication schema migration completed.');
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
  migrate('--apply');
  const converted = [
    ['global', duplicate],
    ['global', duplicate],
    [historicalKey, duplicate],
  ];
  expect(await eventRows()).toEqual(converted);
  expect(await legacyRows()).toEqual([]);
  migrate('--apply');
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
  expect(migrate('--rollback-sms-budget')).toContain('restore all current-window events');
  expect(await eventRows()).toEqual(withNewEvents);
  expect(await legacyRows()).toEqual([]);

  migrate('--rollback-sms-budget', '--apply');
  expect(await schemaVersion()).toEqual({ budget: '"mioSmsBudget"', event: null, fence: false });
  expect(await legacyRows()).toEqual(withNewEvents);
  expect(migrate('--apply', '--rollback-sms-budget')).toContain(
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

  migrate('--apply');
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
      const result = runMigration(...args);
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
  const failedForward = runMigration('--apply');
  expect(failedForward.status).toBe(1);
  expect(failedForward.stderr).toContain('fixture interruption after DDL');
  expect(await schemaVersion()).toEqual({ budget: '"mioSmsBudget"', event: null, fence: false });
  expect(await legacyRows()).toEqual([
    ['global', stamp],
    ['global', stamp],
  ]);
  await dropTrigger();
  migrate('--apply');
  const converted = await eventRows();
  expect(converted).toEqual([
    ['global', stamp],
    ['global', stamp],
  ]);

  await addTrigger();
  const failedRollback = runMigration('--rollback-sms-budget', '--apply');
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
  migrate('--rollback-sms-budget', '--apply');
  expect(await legacyRows()).toEqual(converted);
}, 20_000);

it('does not admit or repair a partial layout during startup or migration', async () => {
  migrate('--apply');
  await pool.query('DROP INDEX "mioSmsBudgetEvent_budget_time"');
  await expect(createAuthentication(config())).rejects.toThrow('AUTH_SCHEMA');
  for (const args of [[], ['--apply'], ['--rollback-sms-budget', '--apply']]) {
    const result = runMigration(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AUTH_SCHEMA: incomplete or invalid indexed SMS budget layout');
  }
  expect(await schemaVersion()).toEqual({
    budget: '"mioSmsBudget"',
    event: '"mioSmsBudgetEvent"',
    fence: true,
  });
}, 20_000);
