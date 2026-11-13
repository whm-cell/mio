import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type PhonePurpose = 'login' | 'bind';
export interface PhoneLimits {
  phoneHour: number;
  phoneDay: number;
  ipHour: number;
  ipDay: number;
  globalDay: number;
}
export interface BindingIdentity {
  userId: string;
  sessionId: string;
}

const hour = 60 * 60 * 1000;
const day = 24 * hour;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const challengeKey = (purpose: PhonePurpose, phone: string) => digest(`${purpose}\0${phone}`);
const codeDigest = (
  secret: string,
  id: string,
  purpose: PhonePurpose,
  phone: string,
  code: string,
  binding?: BindingIdentity,
) =>
  createHmac('sha256', secret)
    .update(
      `${id}\0${purpose}\0${phone}\0${binding?.userId ?? ''}\0${binding?.sessionId ?? ''}\0${code}`,
    )
    .digest('hex');

async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface BudgetRow {
  id: string;
  events: string;
}

async function bindingSessionIsActive(client: PoolClient, binding: BindingIdentity) {
  const locked = await client.query(
    'SELECT id FROM "session" WHERE id = $1 AND "userId" = $2 FOR UPDATE',
    [binding.sessionId, binding.userId],
  );
  if (!locked.rowCount) return false;
  const active = await client.query(
    `SELECT id FROM "session" WHERE id = $1 AND "userId" = $2 AND "expiresAt" > clock_timestamp()
     AND "createdAt" > clock_timestamp() - interval '10 minutes'`,
    [binding.sessionId, binding.userId],
  );
  return active.rowCount === 1;
}

/** Reserve every budget and replace the matching challenge in one PG transaction. */
export async function reservePhoneChallenge(
  pool: Pool,
  secret: string,
  limits: PhoneLimits,
  purpose: PhonePurpose,
  phone: string,
  ip: string,
  binding?: BindingIdentity,
) {
  const id = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  return transaction(pool, async (client) => {
    const keys = [
      {
        id: `phone:${digest(phone)}`,
        hour: limits.phoneHour,
        day: limits.phoneDay,
        cooldown: true,
      },
      { id: `ip:${digest(ip)}`, hour: limits.ipHour, day: limits.ipDay, cooldown: false },
      { id: 'global', hour: Infinity, day: limits.globalDay, cooldown: false },
    ].sort((a, b) => a.id.localeCompare(b.id));
    const rows: BudgetRow[] = [];
    for (const key of keys) {
      await client.query(
        'INSERT INTO "mioSmsBudget" (id, events, "updatedAt") VALUES ($1, $2, clock_timestamp()) ON CONFLICT (id) DO NOTHING',
        [key.id, '[]'],
      );
      rows.push(
        (
          await client.query<BudgetRow>(
            'SELECT id, events FROM "mioSmsBudget" WHERE id = $1 FOR UPDATE',
            [key.id],
          )
        ).rows[0]!,
      );
    }
    const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    const timestamp = now.getTime();
    for (const [index, key] of keys.entries()) {
      const row = rows[index]!;
      const parsed: unknown = JSON.parse(row.events);
      if (
        !Array.isArray(parsed) ||
        parsed.some((entry) => !Number.isSafeInteger(entry) || entry > timestamp)
      )
        throw new Error('SMS_BUDGET_INVALID');
      const events = (parsed as number[]).filter((entry) => entry > timestamp - day);
      if (
        events.length >= key.day ||
        events.filter((entry) => entry > timestamp - hour).length >= key.hour ||
        (key.cooldown && events.some((entry) => entry > timestamp - 60_000))
      )
        throw new Error('SMS_RATE_LIMITED');
      await client.query('UPDATE "mioSmsBudget" SET events = $2, "updatedAt" = $3 WHERE id = $1', [
        key.id,
        JSON.stringify([...events, timestamp]),
        now,
      ]);
    }
    await client.query(
      `INSERT INTO "mioPhoneChallenge" (id, "challengeKey", "codeHash", purpose, "userId", "sessionId", status, attempts, "expiresAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, $7)
       ON CONFLICT ("challengeKey") DO UPDATE SET id = EXCLUDED.id, "codeHash" = EXCLUDED."codeHash", purpose = EXCLUDED.purpose,
       "userId" = EXCLUDED."userId", "sessionId" = EXCLUDED."sessionId", status = EXCLUDED.status,
       attempts = EXCLUDED.attempts, "expiresAt" = EXCLUDED."expiresAt"`,
      [
        id,
        challengeKey(purpose, phone),
        codeDigest(secret, id, purpose, phone, code, binding),
        purpose,
        binding?.userId ?? null,
        binding?.sessionId ?? null,
        new Date(timestamp + 5 * 60_000),
      ],
    );
    if (binding && !(await bindingSessionIsActive(client, binding)))
      throw new Error('SESSION_REQUIRED');
    await client.query(
      `DELETE FROM "mioPhoneChallenge" WHERE id IN
       (SELECT id FROM "mioPhoneChallenge" WHERE "expiresAt" <= clock_timestamp() LIMIT 100 FOR UPDATE SKIP LOCKED)`,
    );
    await client.query(
      `DELETE FROM "mioSmsBudget" WHERE id IN
       (SELECT id FROM "mioSmsBudget" WHERE "updatedAt" <= clock_timestamp() - interval '1 day' LIMIT 100 FOR UPDATE SKIP LOCKED)`,
    );
    return { id, code };
  });
}

/** A late success cannot activate a replacement challenge. */
export async function activatePhoneChallenge(pool: Pool, id: string) {
  return transaction(pool, async (client) => {
    const locked = await client.query(
      'SELECT id FROM "mioPhoneChallenge" WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!locked.rowCount) return false;
    const result = await client.query(
      `UPDATE "mioPhoneChallenge" SET status = 'active' WHERE id = $1 AND status = 'pending' AND "expiresAt" > clock_timestamp()`,
      [id],
    );
    return result.rowCount === 1;
  });
}

interface ChallengeRow {
  id: string;
  codeHash: string;
  purpose: PhonePurpose;
  userId: string | null;
  sessionId: string | null;
  status: string;
  attempts: number;
  expiresAt: Date;
}

/** A bind locks and rechecks the original session before changing its user. */
export async function consumePhoneChallenge(
  pool: Pool,
  secret: string,
  purpose: PhonePurpose,
  phone: string,
  code: string,
  binding?: BindingIdentity,
): Promise<'ok' | 'invalid' | 'conflict' | 'session'> {
  return transaction(pool, async (client) => {
    const result = await client.query<ChallengeRow>(
      'SELECT * FROM "mioPhoneChallenge" WHERE "challengeKey" = $1 FOR UPDATE',
      [challengeKey(purpose, phone)],
    );
    const row = result.rows[0];
    const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    if (
      !row ||
      row.purpose !== purpose ||
      row.status !== 'active' ||
      row.expiresAt <= now ||
      row.userId !== (binding?.userId ?? null) ||
      row.sessionId !== (binding?.sessionId ?? null)
    )
      return 'invalid';
    const expected = Buffer.from(row.codeHash, 'hex');
    const supplied = Buffer.from(codeDigest(secret, row.id, purpose, phone, code, binding), 'hex');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      if (row.attempts + 1 >= 3)
        await client.query('DELETE FROM "mioPhoneChallenge" WHERE id = $1', [row.id]);
      else
        await client.query('UPDATE "mioPhoneChallenge" SET attempts = attempts + 1 WHERE id = $1', [
          row.id,
        ]);
      return 'invalid';
    }
    if (binding) {
      if (!(await bindingSessionIsActive(client, binding))) return 'session';
      const consumed = await client.query(
        'DELETE FROM "mioPhoneChallenge" WHERE id = $1 AND "expiresAt" > clock_timestamp() RETURNING id',
        [row.id],
      );
      if (!consumed.rowCount) return 'invalid';
      await client.query('SAVEPOINT phone_bind');
      try {
        const updated = await client.query(
          `UPDATE "user" SET "phoneNumber" = $2, "phoneNumberVerified" = true, "updatedAt" = now()
           WHERE id = $1 AND "phoneNumber" IS NULL RETURNING id`,
          [binding.userId, phone],
        );
        if (!updated.rowCount) return 'conflict';
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        await client.query('ROLLBACK TO SAVEPOINT phone_bind');
        return 'conflict';
      }
      return 'ok';
    }
    const consumed = await client.query(
      'DELETE FROM "mioPhoneChallenge" WHERE id = $1 AND "expiresAt" > clock_timestamp() RETURNING id',
      [row.id],
    );
    return consumed.rowCount ? 'ok' : 'invalid';
  });
}
