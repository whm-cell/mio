import type { Pool, PoolClient } from 'pg';
import { readSmsBudgetSchema, smsBudgetDayMs } from '../../src/auth/phone-budget-schema.ts';
import type { SmsBudgetTables } from '../../src/auth/phone-budget-schema.ts';

async function recentLegacyEvents(db: Pick<Pool, 'query'>, tables: SmsBudgetTables) {
  const { rows } = await db.query<{ id: string; events: string; nowMs: string }>(
    `SELECT id, events, floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS "nowMs"
     FROM ${tables.budget} WHERE events <> '[]'`,
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
  const { layout, tables } = await readSmsBudgetSchema(pool, true);
  if (rollback)
    return layout === 'indexed'
      ? 'SMS budget rollback will restore all current-window events to the earlier writer layout.'
      : null;
  if (layout === 'indexed') return null;
  if (layout === 'legacy') await recentLegacyEvents(pool, tables);
  return 'SMS budget migration will switch to indexed events and preserve the current 24-hour window.';
}

async function switchToIndexedEvents(client: PoolClient, tables: SmsBudgetTables) {
  const { keys, times } = await recentLegacyEvents(client, tables);
  await client.query(`CREATE TABLE ${tables.event} (
    "budgetId" text NOT NULL REFERENCES ${tables.budget} (id) ON DELETE CASCADE,
    "occurredAtMs" bigint NOT NULL
  )`);
  await client.query(
    `INSERT INTO ${tables.event} ("budgetId", "occurredAtMs")
     SELECT * FROM unnest($1::text[], $2::bigint[])`,
    [keys, times],
  );
  await client.query(`CREATE INDEX "mioSmsBudgetEvent_budget_time"
    ON ${tables.event} ("budgetId", "occurredAtMs")`);
  await client.query(`UPDATE ${tables.budget} AS bucket SET events = '[]',
      "updatedAt" = GREATEST(bucket."updatedAt", (
        SELECT to_timestamp(max("occurredAtMs") / 1000.0)
        FROM ${tables.event} WHERE "budgetId" = bucket.id
      )) WHERE events <> '[]'`);
  await client.query(`ALTER TABLE ${tables.budget}
    ADD CONSTRAINT "mioSmsBudgetEventsEmpty" CHECK (events = '[]')`);
}

async function restoreLegacyEvents(client: PoolClient, tables: SmsBudgetTables) {
  await client.query(`ALTER TABLE ${tables.budget} DROP CONSTRAINT "mioSmsBudgetEventsEmpty"`);
  await client.query(
    `WITH current_events AS (
       SELECT "budgetId", json_agg("occurredAtMs" ORDER BY "occurredAtMs")::text AS events,
              max("occurredAtMs") AS latest
       FROM ${tables.event}
       WHERE "occurredAtMs" > floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint - $1::bigint
       GROUP BY "budgetId"
     )
     UPDATE ${tables.budget} AS bucket SET events = current_events.events,
       "updatedAt" = GREATEST(bucket."updatedAt", to_timestamp(current_events.latest / 1000.0))
     FROM current_events WHERE bucket.id = current_events."budgetId"`,
    [smsBudgetDayMs],
  );
  await client.query(`DROP TABLE ${tables.event}`);
}

export async function migrateSmsBudget(pool: Pool, rollback: boolean) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const { tables } = await readSmsBudgetSchema(client, true);
    await client.query(`LOCK TABLE ${tables.budget} IN ACCESS EXCLUSIVE MODE`);
    const { layout } = await readSmsBudgetSchema(client, true);
    const target = rollback ? 'legacy' : 'indexed';
    if (layout !== target) {
      if (rollback) await restoreLegacyEvents(client, tables);
      else await switchToIndexedEvents(client, tables);
      if ((await readSmsBudgetSchema(client, true)).layout !== target)
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
