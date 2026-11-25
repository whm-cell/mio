import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { sha256Utf8 } from '@mio/foundation/hash';
import { createId } from '@mio/foundation/identifiers';
import type { Pool, PoolClient } from 'pg';
import { reserveSmsBudget } from './phone-budget.ts';
import type { PhoneLimits } from './phone-budget.ts';
import type { SmsBudgetTables } from './phone-budget-schema.ts';
import { withAuthTransaction } from './transaction.ts';

export type PhonePurpose = 'login' | 'bind' | 'onelink_existing';
export interface BindingIdentity {
  userId: string;
  sessionId: string;
}
export interface OneLinkExistingChallengeScope {
  readonly pendingId: string;
  readonly candidateToken: string;
}

const challengeKey = (purpose: 'login' | 'bind', phone: string) =>
  sha256Utf8(`${purpose}\0${phone}`);
const oneLinkExistingChallengeKey = (pendingId: string, phone: string) =>
  sha256Utf8(`onelink_existing\0${pendingId}\0${phone}`);
const codeDigest = (
  secret: string,
  id: string,
  purpose: PhonePurpose,
  phone: string,
  code: string,
  scopeUserId: string | null,
  scopeSessionId: string | null,
) =>
  createHmac('sha256', secret)
    .update(`${id}\0${purpose}\0${phone}\0${scopeUserId ?? ''}\0${scopeSessionId ?? ''}\0${code}`)
    .digest('hex');

export async function bindingSessionIsActive(client: PoolClient, binding: BindingIdentity) {
  const locked = await client.query(
    'SELECT id FROM "session" WHERE id = $1 AND "userId" = $2 FOR UPDATE',
    [binding.sessionId, binding.userId],
  );
  if (!locked.rowCount) return false;
  const active = await client.query(
    `SELECT s.id FROM "session" s
     JOIN "user" u ON u.id = s."userId"
     WHERE s.id = $1 AND s."userId" = $2
       AND COALESCE(u.disabled, false) = false
       AND s."expiresAt" > clock_timestamp()
       AND s."createdAt" > clock_timestamp() - interval '10 minutes'`,
    [binding.sessionId, binding.userId],
  );
  return active.rowCount === 1;
}

async function upsertPhoneChallenge(
  pool: Pool,
  tables: SmsBudgetTables,
  secret: string,
  limits: PhoneLimits,
  input: {
    readonly purpose: PhonePurpose;
    readonly key: string;
    readonly phone: string;
    readonly ip: string;
    readonly scopeUserId: string | null;
    readonly scopeSessionId: string | null;
    readonly binding?: BindingIdentity;
  },
) {
  const id = createId();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  return withAuthTransaction(pool, async (client) => {
    const timestamp = await reserveSmsBudget(client, tables, limits, input.phone, input.ip);
    await client.query(
      `INSERT INTO "mioPhoneChallenge" (id, "challengeKey", "codeHash", purpose, "userId", "sessionId", status, attempts, "expiresAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, $7)
       ON CONFLICT ("challengeKey") DO UPDATE SET id = EXCLUDED.id, "codeHash" = EXCLUDED."codeHash", purpose = EXCLUDED.purpose,
       "userId" = EXCLUDED."userId", "sessionId" = EXCLUDED."sessionId", status = EXCLUDED.status,
       attempts = EXCLUDED.attempts, "expiresAt" = EXCLUDED."expiresAt"`,
      [
        id,
        input.key,
        codeDigest(
          secret,
          id,
          input.purpose,
          input.phone,
          code,
          input.scopeUserId,
          input.scopeSessionId,
        ),
        input.purpose,
        input.scopeUserId,
        input.scopeSessionId,
        new Date(timestamp + 5 * 60_000),
      ],
    );
    if (input.binding && !(await bindingSessionIsActive(client, input.binding)))
      throw new Error('SESSION_REQUIRED');
    await client.query(
      `DELETE FROM "mioPhoneChallenge" WHERE id IN
       (SELECT id FROM "mioPhoneChallenge" WHERE "expiresAt" <= clock_timestamp() LIMIT 100 FOR UPDATE SKIP LOCKED)`,
    );
    await client.query(
      `DELETE FROM ${tables.budget} WHERE id IN
       (SELECT id FROM ${tables.budget} WHERE "updatedAt" <= clock_timestamp() - interval '24 hours' LIMIT 100 FOR UPDATE SKIP LOCKED)`,
    );
    return { id, code };
  });
}

/** Reserve every budget and replace the matching challenge in one PG transaction. */
export function reservePhoneChallenge(
  pool: Pool,
  tables: SmsBudgetTables,
  secret: string,
  limits: PhoneLimits,
  purpose: 'login' | 'bind',
  phone: string,
  ip: string,
  binding?: BindingIdentity,
) {
  return upsertPhoneChallenge(pool, tables, secret, limits, {
    purpose,
    key: challengeKey(purpose, phone),
    phone,
    ip,
    scopeUserId: binding?.userId ?? null,
    scopeSessionId: binding?.sessionId ?? null,
    ...(binding ? { binding } : {}),
  });
}

/** Reserve a pending-scoped real-SMS challenge for linking an existing phone account to OneLink. */
export function reserveOneLinkExistingPhoneChallenge(
  pool: Pool,
  tables: SmsBudgetTables,
  secret: string,
  limits: PhoneLimits,
  phone: string,
  ip: string,
  scope: OneLinkExistingChallengeScope,
) {
  return upsertPhoneChallenge(pool, tables, secret, limits, {
    purpose: 'onelink_existing',
    key: oneLinkExistingChallengeKey(scope.pendingId, phone),
    phone,
    ip,
    scopeUserId: scope.pendingId,
    scopeSessionId: sha256Utf8(scope.candidateToken),
  });
}

/** A late success cannot activate a replacement challenge. */
export async function activatePhoneChallenge(pool: Pool, id: string) {
  return withAuthTransaction(pool, async (client) => {
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

async function verifyChallengeRow(
  client: PoolClient,
  secret: string,
  input: {
    readonly key: string;
    readonly purpose: PhonePurpose;
    readonly phone: string;
    readonly code: string;
    readonly scopeUserId: string | null;
    readonly scopeSessionId: string | null;
  },
): Promise<ChallengeRow | null> {
  const result = await client.query<ChallengeRow>(
    'SELECT * FROM "mioPhoneChallenge" WHERE "challengeKey" = $1 FOR UPDATE',
    [input.key],
  );
  const row = result.rows[0];
  const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  if (
    !row ||
    row.purpose !== input.purpose ||
    row.status !== 'active' ||
    row.expiresAt <= now ||
    row.userId !== input.scopeUserId ||
    row.sessionId !== input.scopeSessionId
  )
    return null;
  const expected = Buffer.from(row.codeHash, 'hex');
  const supplied = Buffer.from(
    codeDigest(
      secret,
      row.id,
      input.purpose,
      input.phone,
      input.code,
      input.scopeUserId,
      input.scopeSessionId,
    ),
    'hex',
  );
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    if (row.attempts + 1 >= 3)
      await client.query('DELETE FROM "mioPhoneChallenge" WHERE id = $1', [row.id]);
    else
      await client.query('UPDATE "mioPhoneChallenge" SET attempts = attempts + 1 WHERE id = $1', [
        row.id,
      ]);
    return null;
  }
  return row;
}

async function applyUserPhoneBind(
  client: PoolClient,
  userId: string,
  phone: string,
): Promise<'ok' | 'conflict'> {
  await client.query('SAVEPOINT phone_bind');
  try {
    const updated = await client.query(
      `UPDATE "user" SET "phoneNumber" = $2, "phoneNumberVerified" = true, "updatedAt" = now()
       WHERE id = $1 AND "phoneNumber" IS NULL RETURNING id`,
      [userId, phone],
    );
    if (!updated.rowCount) return 'conflict';
  } catch (error) {
    if ((error as { code?: string }).code !== '23505') throw error;
    await client.query('ROLLBACK TO SAVEPOINT phone_bind');
    return 'conflict';
  }
  return 'ok';
}

/** Bind a phone number under smsMode='bypass' with the same lock order and session recheck. */
export async function bindPhoneWithoutChallenge(
  pool: Pool,
  phone: string,
  binding: BindingIdentity,
): Promise<'ok' | 'conflict' | 'session'> {
  return withAuthTransaction(pool, async (client) => {
    await client.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [binding.userId]);
    if (!(await bindingSessionIsActive(client, binding))) return 'session';
    return applyUserPhoneBind(client, binding.userId, phone);
  });
}

/** A bind locks and rechecks the original session before changing its user. */
export async function consumePhoneChallenge(
  pool: Pool,
  secret: string,
  purpose: 'login' | 'bind',
  phone: string,
  code: string,
  binding?: BindingIdentity,
): Promise<'ok' | 'invalid' | 'conflict' | 'session'> {
  return withAuthTransaction(pool, async (client) => {
    const row = await verifyChallengeRow(client, secret, {
      key: challengeKey(purpose, phone),
      purpose,
      phone,
      code,
      scopeUserId: binding?.userId ?? null,
      scopeSessionId: binding?.sessionId ?? null,
    });
    if (!row) return 'invalid';
    if (binding) {
      // Lock "user" before "session" to enforce global lock order ("mioPhoneChallenge" -> "user" -> "session").
      await client.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [binding.userId]);
      if (!(await bindingSessionIsActive(client, binding))) return 'session';
      const consumed = await client.query(
        'DELETE FROM "mioPhoneChallenge" WHERE id = $1 AND "expiresAt" > clock_timestamp() RETURNING id',
        [row.id],
      );
      if (!consumed.rowCount) return 'invalid';
      return applyUserPhoneBind(client, binding.userId, phone);
    }
    const consumed = await client.query(
      'DELETE FROM "mioPhoneChallenge" WHERE id = $1 AND "expiresAt" > clock_timestamp() RETURNING id',
      [row.id],
    );
    return consumed.rowCount ? 'ok' : 'invalid';
  });
}

/** Atomically verify and single-use consume an onelink_existing OTP challenge. */
export async function consumeOneLinkExistingPhoneChallenge(
  pool: Pool,
  secret: string,
  phone: string,
  code: string,
  scope: OneLinkExistingChallengeScope,
): Promise<'ok' | 'invalid'> {
  return withAuthTransaction(pool, async (client) => {
    const row = await verifyChallengeRow(client, secret, {
      key: oneLinkExistingChallengeKey(scope.pendingId, phone),
      purpose: 'onelink_existing',
      phone,
      code,
      scopeUserId: scope.pendingId,
      scopeSessionId: sha256Utf8(scope.candidateToken),
    });
    if (!row) return 'invalid';
    const consumed = await client.query(
      'DELETE FROM "mioPhoneChallenge" WHERE id = $1 AND "expiresAt" > clock_timestamp() RETURNING id',
      [row.id],
    );
    return consumed.rowCount ? 'ok' : 'invalid';
  });
}
