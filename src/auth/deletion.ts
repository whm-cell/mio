import type { Pool, PoolClient } from 'pg';
import { createId } from '@mio/foundation/identifiers';
import type { BindingIdentity } from './phone-store.ts';
import { bindingSessionIsActive, consumeAccountDeletionChallenge } from './phone-store.ts';
import { withAuthTransaction } from './transaction.ts';
import { sha256Utf8 } from '@mio/foundation/hash';
import { invalidateLoginCallbacks, lockLoginIdentity } from './login-methods.ts';
import type { LoginProvider } from './login-methods.ts';
import { parseAccountDeletionTombstone } from '../account-deletion/tombstone.ts';

type DeletionResult =
  | { status: 'ok'; userId: string; finalizedAt: string }
  | { status: 'session_required' | 'invalid_input' | 'invalid_otp' };

interface DeletionUser {
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
  deletedAt: Date | null;
  email: string;
}
async function finalizeIdentity(client: PoolClient, userId: string, user: DeletionUser, at?: Date) {
  const accounts = await client.query<{ providerId: LoginProvider; accountId: string }>(
    'SELECT "providerId","accountId" FROM "account" WHERE "userId"=$1 AND "providerId" IN (\'wechat\',\'onelink\') ORDER BY "providerId","accountId"',
    [userId],
  );
  await client.query('DELETE FROM "mioOneLinkPending" WHERE "initiatorUserId"=$1', [userId]);
  await client.query('DELETE FROM "mioWechatPending" WHERE "accountId"=ANY($1::text[])', [
    accounts.rows.filter((a) => a.providerId === 'wechat').map((a) => a.accountId),
  ]);
  for (const account of accounts.rows) {
    await lockLoginIdentity(client, account.providerId, account.accountId);
    await invalidateLoginCallbacks(client, account.providerId, account.accountId);
  }
  const finalizedAt =
    at ??
    (
      await client.query<{ now: Date }>(
        "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
      )
    ).rows[0]!.now;
  await client.query(
    `UPDATE "user" SET disabled=true,"disabledAt"=$2,"deletedAt"=$2,
      email=$3,"emailVerified"=false,
      "phoneNumber"=NULL,"phoneNumberVerified"=false,"updatedAt"=$2 WHERE id=$1`,
    [userId, finalizedAt, user.deletedAt ? user.email : `deleted-${createId()}@auth.mio.invalid`],
  );
  await client.query('DELETE FROM "session" WHERE "userId"=$1', [userId]);
  await client.query('DELETE FROM "account" WHERE "userId"=$1', [userId]);
  await client.query(
    'DELETE FROM "mioPhoneChallenge" WHERE "userId"=$1 OR "subjectUserId"=$1 OR "phoneDigest"=$2',
    [userId, user.phoneNumber ? sha256Utf8(user.phoneNumber) : null],
  );
  await client.query('DELETE FROM "verification" WHERE identifier=$1 OR "scopeUserId"=$2', [
    user.email,
    userId,
  ]);
  await client.query('DELETE FROM "mioWechatQR" WHERE "userId"=$1', [userId]);
  return finalizedAt;
}

/** Same user lock as U2/admin/final OAuth writes; no external I/O in this transaction. */
export function deleteAccount(
  pool: Pool,
  secret: string,
  identity: BindingIdentity,
  body: Record<string, unknown>,
  domains: readonly string[] = ['auth', 'archive'],
): Promise<DeletionResult> {
  return withAuthTransaction(pool, async (client) => {
    const user = (
      await client.query<{
        phoneNumber: string | null;
        phoneNumberVerified: boolean;
        deletedAt: Date | null;
        email: string;
      }>(
        'SELECT "phoneNumber","phoneNumberVerified","deletedAt",email FROM "user" WHERE id=$1 FOR UPDATE',
        [identity.userId],
      )
    ).rows[0];
    if (!user || user.deletedAt || !(await bindingSessionIsActive(client, identity)))
      return { status: 'session_required' };
    if (user.phoneNumber && user.phoneNumberVerified) {
      if (
        Object.keys(body).length !== 1 ||
        typeof body.code !== 'string' ||
        !/^\d{6}$/.test(body.code)
      )
        return { status: 'invalid_input' };
      if (
        !(await consumeAccountDeletionChallenge(
          client,
          secret,
          identity,
          user.phoneNumber,
          body.code,
        ))
      )
        return { status: 'invalid_otp' };
    } else if (Object.keys(body).length) return { status: 'invalid_input' };
    const finalizedAt = await finalizeIdentity(client, identity.userId, user);
    await client.query(
      `INSERT INTO mio_account_cleanup_jobs(user_id,finalized_at,deadline_at,required_domains)
      VALUES($1,$2,$2::timestamptz+interval '24 hours',$3)`,
      [identity.userId, finalizedAt, domains],
    );
    return { status: 'ok', userId: identity.userId, finalizedAt: finalizedAt.toISOString() };
  });
}

export function cleanupAuthAccount(pool: Pool, userId: string) {
  return withAuthTransaction(pool, async (client) => {
    const user = (
      await client.query<{ deletedAt: Date | null }>(
        'SELECT "deletedAt" FROM "user" WHERE id=$1 FOR UPDATE',
        [userId],
      )
    ).rows[0];
    if (user && !user.deletedAt) throw new Error('ACCOUNT_DELETION_NOT_FINALIZED');
    if (user) {
      await client.query(
        `UPDATE "user" SET name='Deleted account',image=NULL,"avatarAssetId"=NULL,"displayId"=NULL,
        "createdAt"="deletedAt","updatedAt"="deletedAt" WHERE id=$1`,
        [userId],
      );
      await client.query('DELETE FROM "session" WHERE "userId"=$1', [userId]);
      await client.query('DELETE FROM "account" WHERE "userId"=$1', [userId]);
      await client.query(
        'DELETE FROM "mioPhoneChallenge" WHERE "userId"=$1 OR "subjectUserId"=$1',
        [userId],
      );
      await client.query('DELETE FROM "verification" WHERE "scopeUserId"=$1', [userId]);
    }
    return { done: true, remaining: 0 };
  });
}

/** Restore only the immutable old ID; a reused phone or provider identity is never a lookup key. */
export function replayAccountDeletion(
  pool: Pool,
  tombstone: { userId: string; finalizedAt: string },
  domains: readonly string[],
) {
  tombstone = parseAccountDeletionTombstone(tombstone);
  return withAuthTransaction(pool, async (client) => {
    const userId = tombstone.userId,
      at = new Date(tombstone.finalizedAt);
    let user = (
      await client.query<DeletionUser>(
        'SELECT "phoneNumber","phoneNumberVerified","deletedAt",email FROM "user" WHERE id=$1 FOR UPDATE',
        [userId],
      )
    ).rows[0];
    if (user?.deletedAt && user.deletedAt.getTime() !== at.getTime())
      throw new Error('ACCOUNT_TOMBSTONE_TIMESTAMP_CONFLICT');
    if (!user)
      user = (
        await client.query<DeletionUser>(
          `INSERT INTO "user"(id,name,email,"emailVerified",image,"createdAt","updatedAt",
      disabled,"disabledAt","deletedAt","phoneNumber","phoneNumberVerified","displayId","avatarAssetId")
      VALUES($1,'Deleted account',$2,false,NULL,$3,$3,true,$3,$3,NULL,false,NULL,NULL)
      RETURNING email,"deletedAt","phoneNumber","phoneNumberVerified"`,
          [userId, `deleted-${createId()}@auth.mio.invalid`, at],
        )
      ).rows[0]!;
    await finalizeIdentity(client, userId, user, at);
    await client.query(
      `INSERT INTO mio_account_cleanup_jobs(user_id,finalized_at,deadline_at,required_domains,replayed_at)
      VALUES($1,$2,$2::timestamptz+interval '24 hours',$3,clock_timestamp())
      ON CONFLICT(user_id) DO UPDATE SET
      prior_completed_at=COALESCE(mio_account_cleanup_jobs.prior_completed_at,mio_account_cleanup_jobs.completed_at),
      replayed_at=clock_timestamp(),completed_at=NULL,progress='{}',remaining='{}',lease_id=NULL,lease_until=NULL,
      next_attempt_at=clock_timestamp(),last_attempt_at=NULL,attempts=0,failed_step=NULL,error_code=NULL,
      required_domains=ARRAY(SELECT DISTINCT d FROM unnest(mio_account_cleanup_jobs.required_domains||EXCLUDED.required_domains) d ORDER BY d)`,
      [userId, at, domains],
    );
  });
}
