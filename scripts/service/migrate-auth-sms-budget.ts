import type { Pool, PoolClient } from 'pg';
import { readSmsBudgetSchema, smsBudgetDayMs } from '../../src/auth/phone-budget-schema.ts';

async function recentLegacyEvents(db: Pick<Pool, 'query'>) {
  const { rows } = await db.query<{ id: string; events: string; nowMs: string }>(
    `SELECT id, events, floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS "nowMs"
     FROM "mioSmsBudget" WHERE events <> '[]'`,
  );
  const keys: string[] = [];
  const times: number[] = [];
  const invalidBudget = () => new Error('AUTH_SCHEMA: invalid legacy SMS budget events');
  for (const row of rows) {
    let values: unknown;
    try {
      values = JSON.parse(row.events);
    } catch {
      throw invalidBudget();
    }
    if (!Array.isArray(values)) throw invalidBudget();
    const now = Number(row.nowMs);
    for (const value of values) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value > now)
        throw invalidBudget();
      if (value > now - smsBudgetDayMs) {
        keys.push(row.id);
        times.push(value);
      }
    }
  }
  return { keys, times };
}

export async function previewSmsBudgetMigration(pool: Pool, rollback: boolean) {
  const state = await readSmsBudgetSchema(pool, true);
  if (rollback)
    return state === 'indexed'
      ? 'SMS budget rollback will restore all current-window events to the earlier writer layout.'
      : null;
  if (state === 'indexed') return null;
  if (state === 'legacy') await recentLegacyEvents(pool);
  return 'SMS budget migration will switch to indexed events and preserve the current 24-hour window.';
}

async function switchToIndexedEvents(client: PoolClient) {
  const { keys, times } = await recentLegacyEvents(client);
  await client.query(`CREATE TABLE "mioSmsBudgetEvent" (
    "budgetId" text NOT NULL REFERENCES "mioSmsBudget" (id) ON DELETE CASCADE,
    "occurredAtMs" bigint NOT NULL
  )`);
  await client.query(
    `INSERT INTO "mioSmsBudgetEvent" ("budgetId", "occurredAtMs")
     SELECT * FROM unnest($1::text[], $2::bigint[])`,
    [keys, times],
  );
  await client.query(`CREATE INDEX "mioSmsBudgetEvent_budget_time"
    ON "mioSmsBudgetEvent" ("budgetId", "occurredAtMs")`);
  await client.query(`UPDATE "mioSmsBudget" AS bucket SET events = '[]',
      "updatedAt" = GREATEST(bucket."updatedAt", (
        SELECT to_timestamp(max("occurredAtMs") / 1000.0)
        FROM "mioSmsBudgetEvent" WHERE "budgetId" = bucket.id
      )) WHERE events <> '[]'`);
  await client.query(`ALTER TABLE "mioSmsBudget"
    ADD CONSTRAINT "mioSmsBudgetEventsEmpty" CHECK (events = '[]')`);
}

async function restoreLegacyEvents(client: PoolClient) {
  await client.query('ALTER TABLE "mioSmsBudget" DROP CONSTRAINT "mioSmsBudgetEventsEmpty"');
  await client.query(
    `WITH current_events AS (
       SELECT "budgetId", json_agg("occurredAtMs" ORDER BY "occurredAtMs")::text AS events,
              max("occurredAtMs") AS latest
       FROM "mioSmsBudgetEvent"
       WHERE "occurredAtMs" > floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint - $1::bigint
       GROUP BY "budgetId"
     )
     UPDATE "mioSmsBudget" AS bucket SET events = current_events.events,
       "updatedAt" = GREATEST(bucket."updatedAt", to_timestamp(current_events.latest / 1000.0))
     FROM current_events WHERE bucket.id = current_events."budgetId"`,
    [smsBudgetDayMs],
  );
  await client.query('DROP TABLE "mioSmsBudgetEvent"');
}

export async function migrateSmsBudget(pool: Pool, rollback: boolean) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('LOCK TABLE "mioSmsBudget" IN ACCESS EXCLUSIVE MODE');
    const state = await readSmsBudgetSchema(client, true);
    const target = rollback ? 'legacy' : 'indexed';
    if (state !== target) {
      if (rollback) await restoreLegacyEvents(client);
      else await switchToIndexedEvents(client);
      if ((await readSmsBudgetSchema(client, true)) !== target)
        throw new Error('AUTH_SCHEMA: SMS budget migration did not reach the requested layout');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
