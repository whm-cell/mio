import { sha256Utf8 } from '@mio/foundation/hash';
import type { PoolClient } from 'pg';
import { smsBudgetDayMs } from './phone-budget-schema.ts';
import type { SmsBudgetTables } from './phone-budget-schema.ts';

const hour = 60 * 60 * 1000;

export interface PhoneLimits {
  phoneHour: number;
  phoneDay: number;
  ipHour: number;
  ipDay: number;
  globalDay: number;
  accountOpsDay: number;
}

export type AccountOperationSmsPurpose =
  'phone_rebind' | 'wechat_existing' | 'onelink_existing' | 'account_deletion';

/** The caller owns the transaction and commits this debit with the pending challenge. */
export async function reserveSmsBudget(
  client: PoolClient,
  tables: SmsBudgetTables,
  limits: PhoneLimits,
  phone: string,
  ip: string,
  purpose: 'login' | 'bind' | AccountOperationSmsPurpose = 'login',
) {
  // Every writer takes the global, IP, and phone keys in that order.
  const keys = [
    {
      id: purpose === 'login' || purpose === 'bind' ? 'global' : 'global:account_ops',
      hour: Infinity,
      day: purpose === 'login' || purpose === 'bind' ? limits.globalDay : limits.accountOpsDay,
      cooldown: false,
    },
    { id: `ip:${sha256Utf8(ip)}`, hour: limits.ipHour, day: limits.ipDay, cooldown: false },
    {
      id: `phone:${sha256Utf8(phone)}`,
      hour: limits.phoneHour,
      day: limits.phoneDay,
      cooldown: true,
    },
  ];
  for (const { id } of keys) {
    await client.query(
      `INSERT INTO ${tables.budget} (id, events, "updatedAt")
       VALUES ($1, '[]', clock_timestamp()) ON CONFLICT (id) DO NOTHING`,
      [id],
    );
    await client.query(`SELECT id FROM ${tables.budget} WHERE id = $1 FOR UPDATE`, [id]);
  }
  const ids = keys.map(({ id }) => id);
  const { rows } = await client.query<{
    now: Date;
    day: number;
    hour: number;
    latest: string | null;
  }>(
    `WITH tick AS MATERIALIZED (SELECT date_trunc('milliseconds', clock_timestamp()) AS now),
          budget_time AS (SELECT now, (extract(epoch FROM now) * 1000)::bigint AS ms FROM tick)
     SELECT budget_time.now, usage.*
     FROM budget_time CROSS JOIN unnest($1::text[]) WITH ORDINALITY AS bucket(id, position)
     CROSS JOIN LATERAL (
       SELECT count(*)::int AS day,
              (count(*) FILTER (WHERE "occurredAtMs" > budget_time.ms - $3::bigint))::int AS hour,
              max("occurredAtMs") AS latest
       FROM ${tables.event}
       WHERE "budgetId" = bucket.id AND "occurredAtMs" > budget_time.ms - $2::bigint
     ) AS usage
     ORDER BY bucket.position`,
    [ids, smsBudgetDayMs, hour],
  );
  const now = rows[0]!.now;
  const timestamp = now.getTime();
  for (const [index, key] of keys.entries()) {
    const usage = rows[index]!;
    const latest = usage.latest === null ? -Infinity : Number(usage.latest);
    if (latest > timestamp) throw new Error('SMS_BUDGET_INVALID');
    if (
      usage.day >= key.day ||
      usage.hour >= key.hour ||
      (key.cooldown && latest > timestamp - 60_000)
    )
      throw new Error('SMS_RATE_LIMITED');
  }
  await client.query(
    `WITH touched AS (UPDATE ${tables.budget} SET "updatedAt" = $2 WHERE id = ANY($1::text[]) RETURNING id)
     INSERT INTO ${tables.event} ("budgetId", "occurredAtMs") SELECT id, $3 FROM touched`,
    [ids, now, timestamp],
  );
  await client.query(
    `DELETE FROM ${tables.event} WHERE "budgetId" = ANY($1::text[]) AND "occurredAtMs" <= $2`,
    [ids, timestamp - smsBudgetDayMs],
  );
  return timestamp;
}
