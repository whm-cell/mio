import type { Pool } from 'pg';

export const smsBudgetDayMs = 24 * 60 * 60 * 1000;

/** PostgreSQL-quoted names bound to the same schema. */
export interface SmsBudgetTables {
  budget: string;
  event: string;
}

/** Inspect the current SMS storage layout without reading or writing budget contents. */
export async function readSmsBudgetSchema(db: Pick<Pool, 'query'>, migrationTarget = false) {
  const { rows } = await db.query<{
    budgetName: string;
    eventName: string;
    hasBudget: boolean;
    hasEvent: boolean;
    hasFence: boolean;
    validBudget: boolean;
    validEvent: boolean;
    validFence: boolean;
  }>(
    `WITH target AS (
       SELECT COALESCE(CASE WHEN NOT $1 THEN (
         SELECT ns.nspname FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
         WHERE c.oid = pg_catalog.to_regclass('"mioSmsBudget"')
       ) END, pg_catalog.current_schema()) AS schema_name
     ), names AS (
       SELECT pg_catalog.format('%I.%I', schema_name, 'mioSmsBudget') AS budget_name,
              pg_catalog.format('%I.%I', schema_name, 'mioSmsBudgetEvent') AS event_name
       FROM target
     ), relations AS (
       SELECT budget_name, event_name, pg_catalog.to_regclass(budget_name) AS budget,
              pg_catalog.to_regclass(event_name) AS event
       FROM names
     ), columns AS (
       SELECT a.attrelid, a.attnum, a.attname, a.atttypid, a.attnotnull
       FROM pg_catalog.pg_attribute a, relations r
       WHERE a.attrelid IN (r.budget, r.event) AND a.attnum > 0 AND NOT a.attisdropped
     )
     SELECT r.budget_name AS "budgetName", r.event_name AS "eventName",
       b.oid IS NOT NULL AS "hasBudget", e.oid IS NOT NULL AS "hasEvent",
       fence.oid IS NOT NULL AS "hasFence",
       b.relkind = 'r' AND b.relpersistence = 'p' AND
       (SELECT count(*) FROM columns c WHERE c.attrelid = b.oid AND c.attnotnull AND (
         (c.attname IN ('id', 'events') AND c.atttypid = 'text'::regtype) OR
         (c.attname = 'updatedAt' AND c.atttypid = 'timestamptz'::regtype))) = 3 AND
       EXISTS (SELECT 1 FROM pg_catalog.pg_index i
         WHERE i.indrelid = b.oid AND i.indisprimary AND i.indisvalid AND i.indnkeyatts = 1
           AND i.indkey[0] = (SELECT attnum FROM columns WHERE attrelid = b.oid AND attname = 'id'))
       AS "validBudget",
       e.relkind = 'r' AND e.relpersistence = 'p' AND e.relnamespace = b.relnamespace AND
       (SELECT count(*) FROM columns WHERE attrelid = e.oid) = 2 AND
       event_key.attnotnull AND event_key.atttypid = 'text'::regtype AND
       event_time.attnotnull AND event_time.atttypid = 'bigint'::regtype AND
       EXISTS (SELECT 1 FROM pg_catalog.pg_constraint fk
         WHERE fk.conrelid = e.oid AND fk.confrelid = b.oid AND fk.contype = 'f'
           AND fk.convalidated AND fk.confdeltype = 'c' AND fk.conkey = ARRAY[event_key.attnum]
           AND fk.confkey = ARRAY[(SELECT attnum FROM columns WHERE attrelid = b.oid AND attname = 'id')]) AND
       EXISTS (SELECT 1 FROM pg_catalog.pg_index i
         JOIN pg_catalog.pg_class ix ON ix.oid = i.indexrelid
         JOIN pg_catalog.pg_am am ON am.oid = ix.relam
         WHERE i.indrelid = e.oid AND i.indisvalid AND i.indisready AND NOT i.indisunique
           AND am.amname = 'btree' AND i.indnkeyatts = 2 AND i.indpred IS NULL
           AND i.indkey[0] = event_key.attnum AND i.indkey[1] = event_time.attnum) AND
       NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = e.oid AND i.indisunique)
       AS "validEvent",
       fence.contype = 'c' AND fence.convalidated
         AND pg_catalog.pg_get_expr(fence.conbin, fence.conrelid) = $2 AS "validFence"
     FROM relations r
     LEFT JOIN pg_catalog.pg_class b ON b.oid = r.budget
     LEFT JOIN pg_catalog.pg_class e ON e.oid = r.event
     LEFT JOIN pg_catalog.pg_constraint fence
       ON fence.conrelid = b.oid AND fence.conname = 'mioSmsBudgetEventsEmpty'
     LEFT JOIN columns event_key ON event_key.attrelid = e.oid AND event_key.attname = 'budgetId'
     LEFT JOIN columns event_time ON event_time.attrelid = e.oid AND event_time.attname = 'occurredAtMs'`,
    [migrationTarget, "(events = '[]'::text)"],
  );
  const shape = rows[0]!;
  const tables: SmsBudgetTables = { budget: shape.budgetName, event: shape.eventName };
  if (!shape.hasBudget && !shape.hasEvent) return { layout: 'empty', tables } as const;
  if (!shape.validBudget) throw new Error('AUTH_SCHEMA: invalid SMS budget key table');
  if (!shape.hasEvent && !shape.hasFence) return { layout: 'legacy', tables } as const;
  if (!shape.validEvent || !shape.validFence)
    throw new Error('AUTH_SCHEMA: incomplete or invalid indexed SMS budget layout');
  return { layout: 'indexed', tables } as const;
}
