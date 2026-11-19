import { createId } from '@mio/foundation/identifiers';
import type { Pool, PoolClient } from 'pg';

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
    },
  },
} as const;

type QRStatus = 'pending' | 'confirmed' | 'failed' | 'expired' | 'consumed';
interface QRRow {
  id: string;
  cookieHash: string;
  status: QRStatus;
  userId: string | null;
  expiresAt: Date;
}

async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>) {
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

/** Retain expired rows for ten minutes so expiry stays observable and old OAuth cannot bypass QR. */
export function reserveWechatQR(pool: Pool, cookieHash: string) {
  return transaction(pool, async (client) => {
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
  return transaction(pool, async (client) => {
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
  return transaction(pool, async (client) => {
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
    return { id: row.id };
  });
}

export function finishWechatQR(pool: Pool, id: string, userId?: string) {
  return transaction(pool, async (client) => {
    await client.query(
      `UPDATE "mioWechatQR" SET status = $2, "userId" = $3,
       "confirmedAt" = CASE WHEN $3::text IS NOT NULL THEN clock_timestamp() ELSE NULL END,
       "failureCode" = $4
       WHERE id = $1 AND status = 'pending' AND "expiresAt" > clock_timestamp()`,
      [id, userId ? 'confirmed' : 'failed', userId ?? null, userId ? null : 'OAUTH_FAILED'],
    );
  });
}

/** The QR row lock makes the first matching browser consume the success exactly once. */
export function pollWechatQR(pool: Pool, id: string, cookieHash: string, userId?: string) {
  return transaction(pool, async (client) => {
    const row = (
      await client.query<QRRow>('SELECT * FROM "mioWechatQR" WHERE id = $1 FOR UPDATE', [id])
    ).rows[0];
    if (!row) return { error: 'NOT_FOUND' } as const;
    if (row.cookieHash !== cookieHash) return { error: 'STATE_MISMATCH' } as const;
    const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    if (row.expiresAt <= now) {
      await client.query('UPDATE "mioWechatQR" SET status = \'expired\' WHERE id = $1', [id]);
      return { status: 'expired' } as const;
    }
    if (row.status === 'confirmed') {
      if (!userId || userId !== row.userId) return { error: 'UNAUTHORIZED' } as const;
      await client.query('UPDATE "mioWechatQR" SET status = \'consumed\' WHERE id = $1', [id]);
    }
    return { status: row.status };
  });
}
