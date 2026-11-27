import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { sha256Utf8 } from '@mio/foundation/hash';
import { createId } from '@mio/foundation/identifiers';
import type { Pool, PoolClient } from 'pg';
import { reserveSmsBudget } from './phone-budget.ts';
import type { AccountOperationSmsPurpose, PhoneLimits } from './phone-budget.ts';
import type { SmsBudgetTables } from './phone-budget-schema.ts';
import { withAuthTransaction } from './transaction.ts';

type PhonePurpose = 'login' | 'bind' | AccountOperationSmsPurpose;
export interface BindingIdentity {
  userId: string;
  sessionId: string;
}
interface OneLinkExistingChallengeScope {
  readonly pendingId: string;
  readonly candidateToken: string;
}

const challengeKey = (purpose: 'login' | 'bind', phone: string) =>
  sha256Utf8(`${purpose}\0${phone}`);
const pendingChallengeKey = (purpose: PhonePurpose, pendingId: string, phone: string) =>
  sha256Utf8(`${purpose}\0${pendingId}\0${phone}`);
const rebindChallengeKey = (binding: BindingIdentity, phone: string) =>
  sha256Utf8(`phone_rebind\0${binding.userId}\0${binding.sessionId}\0${phone}`);
const codeDigest = (
  secret: string,
  id: string,
  purpose: PhonePurpose,
  phone: string,
  code: string,
  scopeUserId: string | null,
  scopeSessionId: string | null,
  originalPhone: string | null = null,
) =>
  createHmac('sha256', secret)
    .update(
      `${id}\0${purpose}\0${phone}\0${scopeUserId ?? ''}\0${scopeSessionId ?? ''}\0${code}${originalPhone === null ? '' : `\0${originalPhone}`}`,
    )
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
  tables: SmsBudgetTables | undefined,
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
    readonly originalPhone?: string;
    readonly fixedCode?: string;
  },
) {
  const id = createId();
  const code = input.fixedCode ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
  return withAuthTransaction(pool, async (client) => {
    let scopeUserId = input.scopeUserId;
    let subjectUserId = input.binding?.userId ?? null;
    if (['login', 'wechat_existing', 'onelink_existing'].includes(input.purpose)) {
      subjectUserId =
        (
          await client.query<{ id: string }>(
            'SELECT id FROM "user" WHERE "phoneNumber"=$1 FOR UPDATE',
            [input.phone],
          )
        ).rows[0]?.id ?? null;
      if (input.purpose === 'login') scopeUserId = subjectUserId;
    }
    // All session-scoped operations lock the user before any challenge. Deletion uses the same order.
    if (input.binding) {
      await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [input.binding.userId]);
      if (!(await bindingSessionIsActive(client, input.binding)))
        throw new Error('SESSION_REQUIRED');
    }
    if (!input.fixedCode && !tables) throw new Error('SMS_UNAVAILABLE');
    const timestamp = input.fixedCode
      ? (
          await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
        ).rows[0]!.now.getTime()
      : await reserveSmsBudget(client, tables!, limits, input.phone, input.ip, input.purpose);
    await client.query(
      `INSERT INTO "mioPhoneChallenge" (id, "challengeKey", "codeHash", purpose, "userId", "sessionId", status, attempts, "expiresAt", "originalPhone", "phoneDigest", "subjectUserId")
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, $7, $8, $9, $10)
       ON CONFLICT ("challengeKey") DO UPDATE SET id = EXCLUDED.id, "codeHash" = EXCLUDED."codeHash", purpose = EXCLUDED.purpose,
       "userId" = EXCLUDED."userId", "sessionId" = EXCLUDED."sessionId", status = EXCLUDED.status,
       attempts = EXCLUDED.attempts, "expiresAt" = EXCLUDED."expiresAt", "originalPhone" = EXCLUDED."originalPhone", "phoneDigest"=EXCLUDED."phoneDigest", "subjectUserId"=EXCLUDED."subjectUserId"`,
      [
        id,
        input.key,
        codeDigest(
          secret,
          id,
          input.purpose,
          input.phone,
          code,
          scopeUserId,
          input.scopeSessionId,
          input.originalPhone ?? null,
        ),
        input.purpose,
        scopeUserId,
        input.scopeSessionId,
        new Date(timestamp + 5 * 60_000),
        input.originalPhone ?? null,
        sha256Utf8(input.phone),
        subjectUserId,
      ],
    );
    if (input.binding && input.originalPhone) {
      const user = await client.query(
        `SELECT id FROM "user" WHERE id=$1 AND "phoneNumber"=$2
         AND "phoneNumberVerified"=true AND COALESCE(disabled,false)=false FOR UPDATE`,
        [input.binding.userId, input.originalPhone],
      );
      if (!user.rowCount) throw new Error('PHONE_CONFLICT');
    }
    if (input.binding && !(await bindingSessionIsActive(client, input.binding)))
      throw new Error('SESSION_REQUIRED');
    await client.query(
      `DELETE FROM "mioPhoneChallenge" WHERE id IN
       (SELECT id FROM "mioPhoneChallenge" WHERE "expiresAt" <= clock_timestamp() LIMIT 100 FOR UPDATE SKIP LOCKED)`,
    );
    if (tables)
      await client.query(
        `DELETE FROM ${tables.budget} WHERE id IN
       (SELECT id FROM ${tables.budget} WHERE "updatedAt" <= clock_timestamp() - interval '24 hours' LIMIT 100 FOR UPDATE SKIP LOCKED)`,
      );
    return { id, code };
  });
}

/** Freeze the phone's original account in the consumed proof; never look up a replacement account afterwards. */
export async function consumePhoneLoginChallenge(
  pool: Pool,
  secret: string,
  phone: string,
  code: string,
) {
  const key = challengeKey('login', phone);
  const observed = (
    await pool.query<{ userId: string | null }>(
      'SELECT "userId" FROM "mioPhoneChallenge" WHERE "challengeKey"=$1',
      [key],
    )
  ).rows[0];
  if (!observed) return { status: 'invalid' } as const;
  return withAuthTransaction(pool, async (client) => {
    const subject = (
      await client.query<{
        id: string;
        phoneNumber: string | null;
        phoneNumberVerified: boolean;
        disabled: boolean;
        deletedAt: Date | null;
      }>(
        `SELECT id,"phoneNumber","phoneNumberVerified",disabled,"deletedAt" FROM "user"
       WHERE ${observed.userId ? 'id' : '"phoneNumber"'}=$1 FOR UPDATE`,
        [observed.userId ?? phone],
      )
    ).rows[0];
    if (
      observed.userId
        ? !subject ||
          subject.phoneNumber !== phone ||
          !subject.phoneNumberVerified ||
          subject.deletedAt
        : Boolean(subject)
    )
      return { status: 'invalid' } as const;
    const row = await verifyChallengeRow(client, secret, {
      key,
      purpose: 'login',
      phone,
      code,
      scopeUserId: observed.userId,
      scopeSessionId: null,
    });
    if (!row) return { status: 'invalid' } as const;
    const consumed = await client.query(
      'DELETE FROM "mioPhoneChallenge" WHERE id=$1 AND "expiresAt">clock_timestamp() RETURNING id',
      [row.id],
    );
    if (!consumed.rowCount) return { status: 'invalid' } as const;
    return subject?.disabled
      ? ({ status: 'disabled' } as const)
      : ({ status: 'ok', userId: observed.userId } as const);
  });
}

export function validateNewPhoneSession(pool: Pool, binding: BindingIdentity, phone: string) {
  return withAuthTransaction(pool, async (client) => {
    await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [binding.userId]);
    const active = await client.query(
      `SELECT 1 FROM "user" u JOIN "session" s ON s."userId"=u.id
      WHERE u.id=$1 AND s.id=$2 AND u."phoneNumber"=$3 AND u."phoneNumberVerified"=true
      AND COALESCE(u.disabled,false)=false AND u."deletedAt" IS NULL AND s."expiresAt">clock_timestamp()`,
      [binding.userId, binding.sessionId, phone],
    );
    if (active.rowCount) return true;
    await client.query('DELETE FROM "session" WHERE id=$1 AND "userId"=$2', [
      binding.sessionId,
      binding.userId,
    ]);
    return false;
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
  tables: SmsBudgetTables | undefined,
  secret: string,
  limits: PhoneLimits,
  phone: string,
  ip: string,
  scope: OneLinkExistingChallengeScope,
  fixedCode?: string,
) {
  return upsertPhoneChallenge(pool, tables, secret, limits, {
    purpose: 'onelink_existing',
    key: pendingChallengeKey('onelink_existing', scope.pendingId, phone),
    phone,
    ip,
    scopeUserId: scope.pendingId,
    scopeSessionId: sha256Utf8(scope.candidateToken),
    ...(fixedCode ? { fixedCode } : {}),
  });
}

export function reserveWechatExistingPhoneChallenge(
  pool: Pool,
  tables: SmsBudgetTables | undefined,
  secret: string,
  limits: PhoneLimits,
  phone: string,
  ip: string,
  scope: OneLinkExistingChallengeScope,
  fixedCode?: string,
) {
  return upsertPhoneChallenge(pool, tables, secret, limits, {
    purpose: 'wechat_existing',
    key: pendingChallengeKey('wechat_existing', scope.pendingId, phone),
    phone,
    ip,
    scopeUserId: scope.pendingId,
    scopeSessionId: sha256Utf8(scope.candidateToken),
    ...(fixedCode ? { fixedCode } : {}),
  });
}

export async function reservePhoneRebindChallenge(
  pool: Pool,
  tables: SmsBudgetTables | undefined,
  secret: string,
  limits: PhoneLimits,
  phone: string,
  ip: string,
  binding: BindingIdentity,
  fixedCode?: string,
) {
  const user = (
    await pool.query<{ phoneNumber: string | null; phoneNumberVerified: boolean }>(
      'SELECT "phoneNumber", "phoneNumberVerified" FROM "user" WHERE id=$1',
      [binding.userId],
    )
  ).rows[0];
  if (!user?.phoneNumber || !user.phoneNumberVerified) throw new Error('PHONE_REQUIRED');
  const occupied = await pool.query('SELECT id FROM "user" WHERE "phoneNumber"=$1', [phone]);
  if (occupied.rowCount) throw new Error('PHONE_CONFLICT');
  return upsertPhoneChallenge(pool, tables, secret, limits, {
    purpose: 'phone_rebind',
    key: rebindChallengeKey(binding, phone),
    phone,
    ip,
    scopeUserId: binding.userId,
    scopeSessionId: binding.sessionId,
    binding,
    originalPhone: user.phoneNumber,
    ...(fixedCode ? { fixedCode } : {}),
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
  originalPhone: string | null;
  phoneDigest: string | null;
  subjectUserId: string | null;
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
    row.sessionId !== input.scopeSessionId ||
    row.phoneDigest !== sha256Utf8(input.phone)
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
      row.originalPhone ?? null,
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
  purpose: 'bind',
  phone: string,
  code: string,
  binding: BindingIdentity,
): Promise<'ok' | 'invalid' | 'conflict' | 'session'> {
  return withAuthTransaction(pool, async (client) => {
    await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [binding.userId]);
    const row = await verifyChallengeRow(client, secret, {
      key: challengeKey(purpose, phone),
      purpose,
      phone,
      code,
      scopeUserId: binding.userId,
      scopeSessionId: binding.sessionId,
    });
    if (!row) return 'invalid';
    if (!(await bindingSessionIsActive(client, binding))) return 'session';
    const consumed = await client.query(
      'DELETE FROM "mioPhoneChallenge" WHERE id=$1 AND "expiresAt">clock_timestamp() RETURNING id',
      [row.id],
    );
    if (!consumed.rowCount) return 'invalid';
    return applyUserPhoneBind(client, binding.userId, phone);
  });
}

/** Consume inside the caller's final binding transaction, so proof and association cannot race. */
export async function consumePendingPhoneChallenge(
  client: PoolClient,
  secret: string,
  purpose: 'wechat_existing' | 'onelink_existing',
  phone: string,
  code: string,
  scope: OneLinkExistingChallengeScope & { subjectUserId: string | null },
) {
  const row = await verifyChallengeRow(client, secret, {
    key: pendingChallengeKey(purpose, scope.pendingId, phone),
    purpose,
    phone,
    code,
    scopeUserId: scope.pendingId,
    scopeSessionId: sha256Utf8(scope.candidateToken),
  });
  if (!row || row.subjectUserId !== scope.subjectUserId) return false;
  const consumed = await client.query(
    'DELETE FROM "mioPhoneChallenge" WHERE id=$1 AND "expiresAt">clock_timestamp() RETURNING id',
    [row.id],
  );
  return consumed.rowCount === 1;
}

class RebindChallengeExpired extends Error {}

export async function consumePhoneRebindChallenge(
  pool: Pool,
  secret: string,
  phone: string,
  code: string,
  binding: BindingIdentity,
): Promise<'ok' | 'invalid' | 'conflict' | 'session'> {
  try {
    return await withAuthTransaction(pool, async (client) => {
      await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [binding.userId]);
      const row = await verifyChallengeRow(client, secret, {
        key: rebindChallengeKey(binding, phone),
        purpose: 'phone_rebind',
        phone,
        code,
        scopeUserId: binding.userId,
        scopeSessionId: binding.sessionId,
      });
      if (!row) return 'invalid';
      const user = await client.query<{ phoneNumber: string | null; phoneNumberVerified: boolean }>(
        'SELECT "phoneNumber", "phoneNumberVerified" FROM "user" WHERE id=$1 FOR UPDATE',
        [binding.userId],
      );
      if (!(await bindingSessionIsActive(client, binding))) return 'session';
      if (
        !row.originalPhone ||
        !user.rows[0]?.phoneNumberVerified ||
        user.rows[0].phoneNumber !== row.originalPhone ||
        row.originalPhone === phone
      )
        return 'conflict';
      await client.query('SAVEPOINT phone_rebind');
      try {
        await client.query(
          'UPDATE "user" SET "phoneNumber"=$2, "phoneNumberVerified"=true, "updatedAt"=clock_timestamp() WHERE id=$1',
          [binding.userId, phone],
        );
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        await client.query('ROLLBACK TO SAVEPOINT phone_rebind');
        return 'conflict';
      }
      const consumed = await client.query(
        'DELETE FROM "mioPhoneChallenge" WHERE id=$1 AND "expiresAt">clock_timestamp() RETURNING id',
        [row.id],
      );
      if (!consumed.rowCount) throw new RebindChallengeExpired();
      return 'ok';
    });
  } catch (error) {
    if (error instanceof RebindChallengeExpired) return 'invalid';
    throw error;
  }
}

const deletionChallengeKey = (binding: BindingIdentity, phone: string) =>
  sha256Utf8(`account_deletion\0${binding.userId}\0${binding.sessionId}\0${phone}`);

export async function reserveAccountDeletionChallenge(
  pool: Pool,
  tables: SmsBudgetTables | undefined,
  secret: string,
  limits: PhoneLimits,
  ip: string,
  binding: BindingIdentity,
  fixedCode?: string,
) {
  const user = (
    await pool.query<{ phoneNumber: string | null; phoneNumberVerified: boolean }>(
      'SELECT "phoneNumber","phoneNumberVerified" FROM "user" WHERE id=$1',
      [binding.userId],
    )
  ).rows[0];
  if (!user?.phoneNumber || !user.phoneNumberVerified) throw new Error('PHONE_REQUIRED');
  const challenge = await upsertPhoneChallenge(pool, tables, secret, limits, {
    purpose: 'account_deletion',
    key: deletionChallengeKey(binding, user.phoneNumber),
    phone: user.phoneNumber,
    ip,
    scopeUserId: binding.userId,
    scopeSessionId: binding.sessionId,
    binding,
    originalPhone: user.phoneNumber,
    ...(fixedCode ? { fixedCode } : {}),
  });
  return { ...challenge, phone: user.phoneNumber };
}

/** Caller holds the user/session locks and commits consumption with permanent deletion. */
export async function consumeAccountDeletionChallenge(
  client: PoolClient,
  secret: string,
  binding: BindingIdentity,
  phone: string,
  code: string,
) {
  const row = await verifyChallengeRow(client, secret, {
    key: deletionChallengeKey(binding, phone),
    purpose: 'account_deletion',
    phone,
    code,
    scopeUserId: binding.userId,
    scopeSessionId: binding.sessionId,
  });
  if (!row || row.originalPhone !== phone) return false;
  const consumed = await client.query(
    'DELETE FROM "mioPhoneChallenge" WHERE id=$1 AND "expiresAt">clock_timestamp() RETURNING id',
    [row.id],
  );
  return consumed.rowCount === 1;
}
