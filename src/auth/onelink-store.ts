import { createId } from '@mio/foundation/identifiers';
import type { Pool } from 'pg';
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
