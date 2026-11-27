import { createId } from '@mio/foundation/identifiers';
import type { Pool } from 'pg';
import { withAuthTransaction } from './transaction.ts';

export const wechatQRSchema = {
  mioWechatQR: {
    fields: {
      stateHash: { type: 'string', required: false, unique: true },
      cookieHash: { type: 'string' },
      status: { type: 'string', index: true },
      userId: { type: 'string', required: false },
      confirmedAt: { type: 'date', required: false },
      expiresAt: { type: 'date', index: true },
      failureCode: { type: 'string', required: false },
      pendingId: { type: 'string', required: false, index: true },
    },
  },
} as const;

type QRStatus = 'pending' | 'pending_confirm' | 'confirmed' | 'failed' | 'expired' | 'consumed';
interface QRRow {
  id: string;
  cookieHash: string;
  status: QRStatus;
  userId: string | null;
  expiresAt: Date;
  pendingId: string | null;
}

interface SessionIdentity {
  userId: string;
  sessionId: string;
}

/** Retain expired rows for ten minutes so expiry stays observable and old OAuth cannot bypass QR. */
export function reserveWechatQR(pool: Pool, cookieHash: string) {
  return withAuthTransaction(pool, async (client) => {
    await client.query(
      `DELETE FROM "mioWechatQR" WHERE id IN
       (SELECT id FROM "mioWechatQR" WHERE "expiresAt" <= clock_timestamp() - interval '10 minutes'
        ORDER BY "expiresAt" LIMIT 100 FOR UPDATE SKIP LOCKED)`,
    );
    const id = createId();
    await client.query(
      `INSERT INTO "mioWechatQR" (id, "cookieHash", status, "expiresAt")
       VALUES ($1, $2, 'pending', clock_timestamp() + interval '5 minutes')`,
      [id, cookieHash],
    );
    return id;
  });
}

export function correlateWechatQR(pool: Pool, id: string, stateHash: string) {
  return withAuthTransaction(pool, async (client) => {
    const result = await client.query(
      `UPDATE "mioWechatQR" SET "stateHash" = $2
       WHERE id = $1 AND status = 'pending' AND "expiresAt" > clock_timestamp()`,
      [id, stateHash],
    );
    if (result.rowCount !== 1) throw new Error('QR_UNAVAILABLE');
  });
}

/** Called only after the existing signed-state check and atomic OAuth replay reservation. */
export function admitWechatQR(pool: Pool, stateHash: string) {
  return withAuthTransaction(pool, async (client) => {
    const row = (
      await client.query<QRRow>('SELECT * FROM "mioWechatQR" WHERE "stateHash" = $1 FOR UPDATE', [
        stateHash,
      ])
    ).rows[0];
    if (!row) return;
    const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    if (row.expiresAt <= now) {
      await client.query('UPDATE "mioWechatQR" SET status = \'expired\' WHERE id = $1', [row.id]);
      return { error: 'QR_EXPIRED' } as const;
    }
    if (row.status !== 'pending') return { error: 'QR_REPLAY' } as const;
    return { id: row.id, expiresAt: row.expiresAt };
  });
}

export function finishWechatQR(pool: Pool, id: string, userId?: string, pendingId?: string) {
  return withAuthTransaction(pool, async (client) => {
    await client.query(
      `UPDATE "mioWechatQR" SET status = $2, "userId" = $3,
       "confirmedAt" = CASE WHEN $3::text IS NOT NULL THEN clock_timestamp() ELSE NULL END,
       "failureCode" = $4, "pendingId" = $5
       WHERE id = $1 AND status IN ('pending', 'pending_confirm') AND "expiresAt" > clock_timestamp()`,
      [
        id,
        pendingId ? 'pending_confirm' : userId ? 'confirmed' : 'failed',
        userId ?? null,
        pendingId || userId ? null : 'OAUTH_FAILED',
        pendingId ?? null,
      ],
    );
  });
}

async function readWechatQRPoll(pool: Pool, id: string) {
  const query = {
    text: `SELECT "cookieHash",status,"userId","pendingId","expiresAt"<=statement_timestamp() AS expired
           FROM "mioWechatQR" WHERE id=$1`,
    values: [id],
    query_timeout: 8000,
  };
  return (
    await pool.query<
      Pick<QRRow, 'cookieHash' | 'status' | 'userId' | 'pendingId'> & { expired: boolean }
    >(query)
  ).rows[0];
}

function claimWechatQR(pool: Pool, id: string, cookieHash: string, identity: SessionIdentity) {
  const match = `id=$1 AND "cookieHash"=$2 AND "userId"=$3 AND status='confirmed'`;
  return withAuthTransaction(pool, async (client) => {
    // Lock the session before the QR row. The claim shares its ordering with other QR claims.
    const session = await client.query(
      'SELECT 1 FROM "session" WHERE id=$1 AND "userId"=$2 FOR SHARE',
      [identity.sessionId, identity.userId],
    );
    if (!session.rowCount) return;
    const values = [id, cookieHash, identity.userId];
    const locked = await client.query(
      `SELECT 1 FROM "mioWechatQR" WHERE ${match} FOR UPDATE`,
      values,
    );
    if (!locked.rowCount) return;
    const saved = (
      await client.query<{ status: 'expired' | 'consumed' }>(
        `UPDATE "mioWechatQR"
         SET status=CASE WHEN "expiresAt"<=statement_timestamp() THEN 'expired' ELSE 'consumed' END
         WHERE ${match} AND EXISTS (
           SELECT 1 FROM "session" s
           JOIN "user" u ON u.id = s."userId"
           WHERE s.id=$4 AND s."userId"=$3
             AND COALESCE(u.disabled, false) = false
             AND s."expiresAt">statement_timestamp()
         ) RETURNING status`,
        [...values, identity.sessionId],
      )
    ).rows[0];
    if (saved) return { status: saved.status === 'consumed' ? 'confirmed' : 'expired' } as const;
  });
}

export async function pollWechatQR(
  pool: Pool,
  id: string,
  cookieHash: string,
  loadIdentity: () => Promise<SessionIdentity | undefined>,
  pendingDigest?: string,
) {
  let row = await readWechatQRPoll(pool, id);
  if (row?.cookieHash === cookieHash && !row.expired && row.status === 'pending_confirm') {
    const pending = (
      await pool.query<{ status: string; expired: boolean }>(
        `SELECT status,"expiresAt"<=clock_timestamp() AS expired FROM "mioWechatPending"
       WHERE id=$1 AND "tokenDigest"=$2`,
        [row.pendingId, pendingDigest ?? ''],
      )
    ).rows[0];
    if (!pending) return { error: 'UNAUTHORIZED' } as const;
    if (pending.expired) return { status: 'expired' } as const;
    if (pending.status === 'candidate_ready') return { status: 'pending_confirm' } as const;
    row = await readWechatQRPoll(pool, id);
  }
  if (row?.cookieHash === cookieHash && !row.expired && row.status === 'confirmed') {
    const identity = await loadIdentity();
    if (identity && identity.userId === row.userId) {
      const claimed = await claimWechatQR(pool, id, cookieHash, identity);
      if (claimed) return claimed;
    }
    row = await readWechatQRPoll(pool, id);
  }
  if (!row) return { error: 'NOT_FOUND' } as const;
  if (row.cookieHash !== cookieHash) return { error: 'STATE_MISMATCH' } as const;
  if (row.expired) {
    if (row.status !== 'expired')
      await withAuthTransaction(pool, (client) =>
        client.query(
          `UPDATE "mioWechatQR" SET status='expired'
           WHERE id=$1 AND "cookieHash"=$2 AND status<>'expired' AND "expiresAt"<=clock_timestamp()`,
          [id, cookieHash],
        ),
      );
    return { status: 'expired' } as const;
  }
  if (row.status === 'confirmed') return { error: 'UNAUTHORIZED' } as const;
  return { status: row.status };
}
