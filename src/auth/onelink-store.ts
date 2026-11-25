import { createId } from '@mio/foundation/identifiers';
import { timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { generateUniqueDisplayId } from './account.ts';
import { bindingSessionIsActive } from './phone-store.ts';
import type { BindingIdentity } from './phone-store.ts';
import { withAuthTransaction } from './transaction.ts';

export const oneLinkPendingSchema = {
  mioOneLinkPending: {
    fields: {
      tokenDigest: { type: 'string', unique: true },
      intent: { type: 'string' },
      status: { type: 'string', index: true },
      initiatorUserId: { type: 'string', required: false },
      initiatorSessionId: { type: 'string', required: false },
      candidateSub: { type: 'string', required: false },
      candidateClientId: { type: 'string', required: false },
      candidateToken: { type: 'string', required: false },
      returnPath: { type: 'string' },
      expiresAt: { type: 'date', index: true },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
    },
  },
} as const;

export type OneLinkPendingIntent = 'login' | 'bind';
export type OneLinkPendingStatus =
  'started' | 'candidate_ready' | 'completed' | 'rejected' | 'cancelled';

export interface CreateOneLinkPendingInput {
  readonly tokenDigest: string;
  readonly intent: OneLinkPendingIntent;
  readonly initiatorUserId: string | null;
  readonly initiatorSessionId: string | null;
  readonly returnPath: string;
}

export interface OneLinkPendingCandidateInput {
  readonly candidateSub: string;
  readonly candidateClientId: string | null;
  readonly candidateToken: string;
}

export interface OneLinkPendingRecord {
  readonly id: string;
  readonly tokenDigest: string;
  readonly intent: OneLinkPendingIntent;
  readonly status: OneLinkPendingStatus;
  readonly initiatorUserId: string | null;
  readonly initiatorSessionId: string | null;
  readonly candidateSub: string | null;
  readonly candidateClientId: string | null;
  readonly candidateToken: string | null;
  readonly returnPath: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expired: boolean;
}

export interface BoundOneLinkUser {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
  readonly image: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly disabled: boolean;
}

/** Retain expired rows for ten minutes before bounded cleanup so expiry remains observable. */
export function createOneLinkPending(
  pool: Pool,
  input: CreateOneLinkPendingInput,
): Promise<string> {
  return withAuthTransaction(pool, async (client) => {
    await client.query(
      `DELETE FROM "mioOneLinkPending" WHERE id IN (
         SELECT id FROM "mioOneLinkPending"
         WHERE "expiresAt" <= clock_timestamp() - interval '10 minutes'
         ORDER BY "expiresAt"
         LIMIT 100
         FOR UPDATE SKIP LOCKED
       )`,
    );
    const id = createId();
    await client.query(
      `INSERT INTO "mioOneLinkPending" (
         id, "tokenDigest", intent, status,
         "initiatorUserId", "initiatorSessionId", "returnPath",
         "expiresAt", "createdAt", "updatedAt"
       ) VALUES (
         $1, $2, $3, 'started',
         $4, $5, $6,
         clock_timestamp() + interval '10 minutes',
         clock_timestamp(),
         clock_timestamp()
       )`,
      [
        id,
        input.tokenDigest,
        input.intent,
        input.initiatorUserId,
        input.initiatorSessionId,
        input.returnPath,
      ],
    );
    return id;
  });
}

export async function readOneLinkPendingByDigest(
  pool: Pool,
  tokenDigest: string,
): Promise<OneLinkPendingRecord | null> {
  const query = {
    text: `SELECT id, "tokenDigest", intent, status,
                  "initiatorUserId", "initiatorSessionId",
                  "candidateSub", "candidateClientId", "candidateToken",
                  "returnPath", "expiresAt", "createdAt", "updatedAt",
                  ("expiresAt" <= clock_timestamp()) AS expired
           FROM "mioOneLinkPending"
           WHERE "tokenDigest" = $1`,
    values: [tokenDigest],
    query_timeout: 5000,
  };
  const result = await pool.query<OneLinkPendingRecord>(query);
  return result.rows[0] ?? null;
}

/** Atomically stage a candidate only from started; late/concurrent callbacks never overwrite it. */
export function transitionStartedPendingToCandidate(
  pool: Pool,
  id: string,
  candidate: OneLinkPendingCandidateInput,
): Promise<boolean> {
  return withAuthTransaction(pool, async (client) => {
    const result = await client.query(
      `UPDATE "mioOneLinkPending"
       SET status = 'candidate_ready',
           "candidateSub" = $2,
           "candidateClientId" = $3,
           "candidateToken" = $4,
           "updatedAt" = clock_timestamp()
       WHERE id = $1
         AND status = 'started'
         AND "expiresAt" > clock_timestamp()`,
      [id, candidate.candidateSub, candidate.candidateClientId, candidate.candidateToken],
    );
    return result.rowCount === 1;
  });
}

export function completeStartedPendingLogin(pool: Pool, id: string): Promise<boolean> {
  return withAuthTransaction(pool, async (client) => {
    const result = await client.query(
      `UPDATE "mioOneLinkPending"
       SET status = 'completed',
           "updatedAt" = clock_timestamp()
       WHERE id = $1
         AND status = 'started'
         AND intent = 'login'
         AND "expiresAt" > clock_timestamp()`,
      [id],
    );
    return result.rowCount === 1;
  });
}

export function rejectStartedPending(pool: Pool, id: string): Promise<boolean> {
  return withAuthTransaction(pool, async (client) => {
    const result = await client.query(
      `UPDATE "mioOneLinkPending"
       SET status = 'rejected',
           "updatedAt" = clock_timestamp()
       WHERE id = $1
         AND status = 'started'`,
      [id],
    );
    return result.rowCount === 1;
  });
}

export function cancelActiveOneLinkPending(pool: Pool, tokenDigest: string): Promise<void> {
  return withAuthTransaction(pool, async (client) => {
    await client.query(
      `UPDATE "mioOneLinkPending"
       SET status = 'cancelled',
           "updatedAt" = clock_timestamp()
       WHERE "tokenDigest" = $1
         AND status IN ('started', 'candidate_ready')`,
      [tokenDigest],
    );
  });
}

export async function findBoundOneLinkUser(
  pool: Pool,
  sub: string,
): Promise<BoundOneLinkUser | null> {
  const query = {
    text: `SELECT u.id, u.email, u."emailVerified", u.name, u.image,
                  u."createdAt", u."updatedAt", COALESCE(u.disabled, false) AS disabled
           FROM "account" a
           JOIN "user" u ON u.id = a."userId"
           WHERE a."providerId" = 'onelink'
             AND a."accountId" = $1
           LIMIT 1`,
    values: [sub],
    query_timeout: 5000,
  };
  const result = await pool.query<BoundOneLinkUser>(query);
  return result.rows[0] ?? null;
}

export async function userHasOneLinkAccount(pool: Pool, userId: string): Promise<boolean> {
  const query = {
    text: `SELECT 1 FROM "account"
           WHERE "userId" = $1 AND "providerId" = 'onelink'
           LIMIT 1`,
    values: [userId],
    query_timeout: 5000,
  };
  const result = await pool.query(query);
  return Boolean(result.rowCount);
}

class OneLinkAlreadyBoundError extends Error {}

export function oneLinkCandidateTokensMatch(expected: string, supplied: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const suppliedBuf = Buffer.from(supplied, 'utf8');
  return expectedBuf.length === suppliedBuf.length && timingSafeEqual(expectedBuf, suppliedBuf);
}

async function lockOneLinkPendingByDigest(
  client: PoolClient,
  tokenDigest: string,
): Promise<OneLinkPendingRecord | null> {
  const result = await client.query<Omit<OneLinkPendingRecord, 'expired'>>(
    `SELECT id, "tokenDigest", intent, status,
            "initiatorUserId", "initiatorSessionId",
            "candidateSub", "candidateClientId", "candidateToken",
            "returnPath", "expiresAt", "createdAt", "updatedAt"
     FROM "mioOneLinkPending"
     WHERE "tokenDigest" = $1
     FOR UPDATE`,
    [tokenDigest],
  );
  const row = result.rows[0];
  if (!row) return null;
  const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  return { ...row, expired: row.expiresAt <= now };
}

type ValidatedLoginCandidate =
  | { readonly status: 'ok'; readonly id: string; readonly candidateSub: string }
  | { readonly status: 'not_found' }
  | { readonly status: 'already_completed' }
  | { readonly status: 'invalid' };

function validateLoginCandidatePending(
  row: OneLinkPendingRecord | null,
  candidateToken: string,
): ValidatedLoginCandidate {
  if (!row) return { status: 'not_found' };
  if (row.status === 'completed') return { status: 'already_completed' };
  if (
    row.status !== 'candidate_ready' ||
    row.intent !== 'login' ||
    row.expired ||
    !row.candidateSub ||
    !row.candidateToken ||
    !oneLinkCandidateTokensMatch(row.candidateToken, candidateToken)
  ) {
    return { status: 'invalid' };
  }
  return { status: 'ok', id: row.id, candidateSub: row.candidateSub };
}

export type CompleteOneLinkCreateResult =
  | { readonly status: 'ok'; readonly user: BoundOneLinkUser }
  | { readonly status: 'not_found' }
  | { readonly status: 'already_completed' }
  | { readonly status: 'invalid' }
  | { readonly status: 'already_bound' };

/** Atomically create a user, bind its OneLink account and complete the pending row; conflicts roll back entirely. */
export async function completeOneLinkCreate(
  pool: Pool,
  input: {
    readonly tokenDigest: string;
    readonly candidateToken: string;
    readonly placeholderDomain: string;
  },
): Promise<CompleteOneLinkCreateResult> {
  try {
    return await withAuthTransaction<CompleteOneLinkCreateResult>(pool, async (client) => {
      const row = await lockOneLinkPendingByDigest(client, input.tokenDigest);
      const pending = validateLoginCandidatePending(row, input.candidateToken);
      if (pending.status !== 'ok') return pending;

      const userId = createId();
      let user: BoundOneLinkUser | undefined;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const displayId = await generateUniqueDisplayId(async (candidate) => {
          const existing = await client.query(
            'SELECT 1 FROM "user" WHERE "displayId" = $1 LIMIT 1',
            [candidate],
          );
          return Boolean(existing.rowCount);
        });
        const email = `onelink-${createId()}@${input.placeholderDomain}`;
        await client.query('SAVEPOINT onelink_create_user');
        try {
          const inserted = await client.query<BoundOneLinkUser>(
            `INSERT INTO "user" (
               id, name, email, "emailVerified", image,
               "phoneNumber", "phoneNumberVerified", "displayId",
               disabled, "disabledAt", "createdAt", "updatedAt"
             ) VALUES (
               $1, '万联用户', $2, false, NULL,
               NULL, false, $3,
               false, NULL, clock_timestamp(), clock_timestamp()
             )
             RETURNING id, email, "emailVerified", name, image,
                       "createdAt", "updatedAt", COALESCE(disabled, false) AS disabled`,
            [userId, email, displayId],
          );
          await client.query('RELEASE SAVEPOINT onelink_create_user');
          user = inserted.rows[0]!;
          break;
        } catch (error) {
          if ((error as { code?: string }).code !== '23505') throw error;
          await client.query('ROLLBACK TO SAVEPOINT onelink_create_user');
        }
      }
      if (!user) throw new Error('AUTH_DISPLAY_ID_EXHAUSTED');

      try {
        await client.query(
          `INSERT INTO "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
           VALUES ($1, $2, 'onelink', $3, clock_timestamp(), clock_timestamp())`,
          [createId(), pending.candidateSub, user.id],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new OneLinkAlreadyBoundError();
        throw error;
      }

      await client.query(
        `UPDATE "mioOneLinkPending"
         SET status = 'completed', "updatedAt" = clock_timestamp()
         WHERE id = $1`,
        [pending.id],
      );
      return { status: 'ok', user };
    });
  } catch (error) {
    if (error instanceof OneLinkAlreadyBoundError) return { status: 'already_bound' };
    throw error;
  }
}

export type CompleteOneLinkLinkExistingResult =
  | { readonly status: 'ok'; readonly user: BoundOneLinkUser }
  | { readonly status: 'not_found' }
  | { readonly status: 'already_completed' }
  | { readonly status: 'invalid' }
  | { readonly status: 'existing_not_found' }
  | { readonly status: 'account_disabled' }
  | { readonly status: 'already_bound' };

/** Atomically link a staged OneLink login candidate to an existing verified, active phone user without creating users. */
export async function completeOneLinkLinkExisting(
  pool: Pool,
  input: {
    readonly tokenDigest: string;
    readonly candidateToken: string;
    readonly phone: string;
  },
): Promise<CompleteOneLinkLinkExistingResult> {
  try {
    return await withAuthTransaction<CompleteOneLinkLinkExistingResult>(pool, async (client) => {
      // Lock "user" before "mioOneLinkPending" to enforce global lock order ("user" -> "session" -> "mioOneLinkPending" -> "account").
      const userResult = await client.query<
        BoundOneLinkUser & { readonly phoneNumberVerified: boolean | null }
      >(
        `SELECT id, email, "emailVerified", name, image,
                "createdAt", "updatedAt",
                COALESCE(disabled, false) AS disabled,
                "phoneNumberVerified"
         FROM "user"
         WHERE "phoneNumber" = $1
         FOR UPDATE`,
        [input.phone],
      );
      const row = await lockOneLinkPendingByDigest(client, input.tokenDigest);
      const pending = validateLoginCandidatePending(row, input.candidateToken);
      if (pending.status !== 'ok') return pending;

      const userRow = userResult.rows[0];
      if (!userRow || !userRow.phoneNumberVerified) return { status: 'existing_not_found' };
      if (userRow.disabled) return { status: 'account_disabled' };

      try {
        await client.query(
          `INSERT INTO "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
           VALUES ($1, $2, 'onelink', $3, clock_timestamp(), clock_timestamp())`,
          [createId(), pending.candidateSub, userRow.id],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new OneLinkAlreadyBoundError();
        throw error;
      }

      await client.query(
        `UPDATE "mioOneLinkPending"
         SET status = 'completed', "updatedAt" = clock_timestamp()
         WHERE id = $1`,
        [pending.id],
      );
      const user: BoundOneLinkUser = {
        id: userRow.id,
        email: userRow.email,
        emailVerified: userRow.emailVerified,
        name: userRow.name,
        image: userRow.image,
        createdAt: userRow.createdAt,
        updatedAt: userRow.updatedAt,
        disabled: userRow.disabled,
      };
      return { status: 'ok', user };
    });
  } catch (error) {
    if (error instanceof OneLinkAlreadyBoundError) return { status: 'already_bound' };
    throw error;
  }
}

export type CompleteOneLinkBindCurrentResult =
  | { readonly status: 'ok'; readonly userId: string; readonly alreadyBound: boolean }
  | { readonly status: 'session_required' }
  | { readonly status: 'not_found' }
  | { readonly status: 'already_completed' }
  | { readonly status: 'invalid' }
  | { readonly status: 'already_bound' };

/** Atomically verify the initiating recent session, lock the staged bind candidate and write the OneLink account. */
export async function completeOneLinkBindCurrent(
  pool: Pool,
  input: {
    readonly tokenDigest: string;
    readonly candidateToken: string;
    readonly session: BindingIdentity;
  },
): Promise<CompleteOneLinkBindCurrentResult> {
  try {
    return await withAuthTransaction<CompleteOneLinkBindCurrentResult>(pool, async (client) => {
      const lockedUser = await client.query(
        'SELECT id FROM "user" WHERE id = $1 AND COALESCE(disabled, false) = false FOR SHARE',
        [input.session.userId],
      );
      if (!lockedUser.rowCount || !(await bindingSessionIsActive(client, input.session))) {
        return { status: 'session_required' };
      }

      const row = await lockOneLinkPendingByDigest(client, input.tokenDigest);
      if (!row) return { status: 'not_found' };
      if (row.intent !== 'bind') return { status: 'invalid' };
      if (
        row.initiatorUserId !== input.session.userId ||
        row.initiatorSessionId !== input.session.sessionId
      ) {
        return { status: 'session_required' };
      }
      if (row.status === 'completed') return { status: 'already_completed' };
      if (
        row.status !== 'candidate_ready' ||
        row.expired ||
        !row.candidateSub ||
        !row.candidateToken ||
        !oneLinkCandidateTokensMatch(row.candidateToken, input.candidateToken)
      ) {
        return { status: 'invalid' };
      }

      const existing = await client.query(
        `SELECT 1 FROM "account"
         WHERE "userId" = $1 AND "providerId" = 'onelink' AND "accountId" = $2
         LIMIT 1`,
        [input.session.userId, row.candidateSub],
      );
      let alreadyBound = Boolean(existing.rowCount);
      if (!alreadyBound) {
        await client.query('SAVEPOINT onelink_bind_account');
        try {
          await client.query(
            `INSERT INTO "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
             VALUES ($1, $2, 'onelink', $3, clock_timestamp(), clock_timestamp())`,
            [createId(), row.candidateSub, input.session.userId],
          );
          await client.query('RELEASE SAVEPOINT onelink_bind_account');
        } catch (error) {
          if ((error as { code?: string }).code !== '23505') throw error;
          await client.query('ROLLBACK TO SAVEPOINT onelink_bind_account');
          const sameOwner = await client.query(
            `SELECT 1 FROM "account"
             WHERE "userId" = $1 AND "providerId" = 'onelink' AND "accountId" = $2
             LIMIT 1`,
            [input.session.userId, row.candidateSub],
          );
          if (!sameOwner.rowCount) throw new OneLinkAlreadyBoundError();
          alreadyBound = true;
        }
      }

      await client.query(
        `UPDATE "mioOneLinkPending"
         SET status = 'completed', "updatedAt" = clock_timestamp()
         WHERE id = $1`,
        [row.id],
      );
      return { status: 'ok', userId: input.session.userId, alreadyBound };
    });
  } catch (error) {
    if (error instanceof OneLinkAlreadyBoundError) return { status: 'already_bound' };
    throw error;
  }
}
