import { createId } from '@mio/foundation/identifiers';
import type { Pool, PoolClient } from 'pg';
import { bindingSessionIsActive, consumePendingPhoneChallenge } from './phone-store.ts';
import type { BindingIdentity } from './phone-store.ts';
import {
  candidateTokenMatches,
  createLoginUser,
  lockLoginIdentity,
  loginCallbackIsCurrent,
} from './login-methods.ts';
import type { LoginUser } from './login-methods.ts';
import { withAuthTransaction } from './transaction.ts';

export const wechatPendingSchema = {
  mioWechatPending: {
    fields: {
      tokenDigest: { type: 'string', unique: true },
      candidateToken: { type: 'string' },
      accountId: { type: 'string' },
      nickname: { type: 'string', required: false },
      image: { type: 'string', required: false },
      accessToken: { type: 'string' },
      refreshToken: { type: 'string', required: false },
      accessTokenExpiresAt: { type: 'date' },
      scope: { type: 'string' },
      status: { type: 'string', index: true },
      startedAt: { type: 'date' },
      expiresAt: { type: 'date', index: true },
      createdAt: { type: 'date' },
    },
  },
} as const;

export interface WechatCredentials {
  accountId: string;
  nickname: string | null;
  image: string | null;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date;
  scope: string;
}

export interface WechatPending extends WechatCredentials {
  id: string;
  tokenDigest: string;
  candidateToken: string;
  status: string;
  startedAt: Date;
  createdAt: Date;
  expiresAt: Date;
  expired: boolean;
}

class WechatStoreError extends Error {}
function reject(code: string): never {
  throw new WechatStoreError(code);
}

export async function readWechatPending(pool: Pool, tokenDigest: string) {
  const query = {
    text: 'SELECT *, "expiresAt"<=clock_timestamp() AS expired FROM "mioWechatPending" WHERE "tokenDigest"=$1',
    values: [tokenDigest],
    query_timeout: 5000,
  };
  return (await pool.query<WechatPending>(query)).rows[0] ?? null;
}

async function lockUser(client: PoolClient, field: 'id' | 'phoneNumber', value: string) {
  return (
    await client.query<LoginUser & { phoneNumberVerified: boolean }>(
      `SELECT id,email,"emailVerified",name,image,"createdAt","updatedAt","phoneNumberVerified",COALESCE(disabled,false) AS disabled
     FROM "user" WHERE "${field}"=$1 FOR UPDATE`,
      [value],
    )
  ).rows[0];
}

async function saveWechatAccount(
  client: PoolClient,
  userId: string,
  credentials: WechatCredentials,
) {
  const existing = (
    await client.query<{ id: string; userId: string }>(
      'SELECT id,"userId" FROM "account" WHERE "providerId"=\'wechat\' AND "accountId"=$1',
      [credentials.accountId],
    )
  ).rows[0];
  if (existing && existing.userId !== userId) return reject('WECHAT_ALREADY_BOUND');
  const fields = [
    credentials.accessToken,
    credentials.refreshToken,
    credentials.accessTokenExpiresAt,
    credentials.scope,
    credentials.nickname,
  ];
  if (existing) {
    await client.query(
      `UPDATE "account" SET "accessToken"=$2,"refreshToken"=$3,"accessTokenExpiresAt"=$4,
       scope=$5,"wechatNickname"=$6,"updatedAt"=clock_timestamp() WHERE id=$1`,
      [existing.id, ...fields],
    );
  } else {
    await client.query(
      `INSERT INTO "account" (id,"accountId","providerId","userId","accessToken","refreshToken","accessTokenExpiresAt",scope,"wechatNickname","createdAt","updatedAt")
       VALUES ($1,$2,'wechat',$3,$4,$5,$6,$7,$8,clock_timestamp(),clock_timestamp())`,
      [createId(), credentials.accountId, userId, ...fields],
    );
  }
}

type CallbackResult =
  | { user: LoginUser; subject: string; startedAt: Date; expiresAt: Date }
  | { pendingId: string }
  | { error: string };

/** Final callback mutation owns user/identity locks; an unbound login only writes a candidate. */
export async function finishWechatAuthorization(
  pool: Pool,
  input: {
    credentials: WechatCredentials;
    startedAt: Date;
    expiresAt: Date;
    tokenDigest: string;
    candidateToken: string;
    binding?: BindingIdentity;
  },
): Promise<CallbackResult> {
  const observed = (
    await pool.query<{ userId: string }>(
      'SELECT "userId" FROM "account" WHERE "providerId"=\'wechat\' AND "accountId"=$1',
      [input.credentials.accountId],
    )
  ).rows[0];
  try {
    return await withAuthTransaction<CallbackResult>(pool, async (client) => {
      const target = input.binding?.userId ?? observed?.userId;
      const user = target ? await lockUser(client, 'id', target) : undefined;
      if (target && (!user || user.disabled)) return reject('ACCOUNT_DISABLED');
      if (input.binding && !(await bindingSessionIsActive(client, input.binding)))
        return reject('SESSION_REQUIRED');
      await lockLoginIdentity(client, 'wechat', input.credentials.accountId);
      if (
        !(await loginCallbackIsCurrent(
          client,
          'wechat',
          input.credentials.accountId,
          input.startedAt,
        ))
      )
        return reject('STATE_REPLAY');
      const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!
        .now;
      if (input.expiresAt <= now) return reject('STATE_EXPIRED');
      const current = (
        await client.query<{ userId: string }>(
          'SELECT "userId" FROM "account" WHERE "providerId"=\'wechat\' AND "accountId"=$1',
          [input.credentials.accountId],
        )
      ).rows[0];
      if (input.binding || observed) {
        if (!user || (!input.binding && current?.userId !== observed?.userId))
          return reject('STATE_REPLAY');
        await saveWechatAccount(client, user.id, input.credentials);
        return {
          user,
          subject: input.credentials.accountId,
          startedAt: input.startedAt,
          expiresAt: input.expiresAt,
        };
      }
      if (current) return reject('WECHAT_ALREADY_BOUND');
      await client.query(`DELETE FROM "mioWechatPending" WHERE id IN (SELECT id FROM "mioWechatPending"
        WHERE "expiresAt"<=clock_timestamp()-interval '10 minutes' LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      const id = createId(),
        c = input.credentials;
      await client.query(
        `INSERT INTO "mioWechatPending" (id,"tokenDigest","candidateToken","accountId",nickname,image,"accessToken","refreshToken","accessTokenExpiresAt",scope,status,"startedAt","expiresAt","createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'candidate_ready',$11,$12,clock_timestamp())`,
        [
          id,
          input.tokenDigest,
          input.candidateToken,
          c.accountId,
          c.nickname,
          c.image,
          c.accessToken,
          c.refreshToken,
          c.accessTokenExpiresAt,
          c.scope,
          input.startedAt,
          input.expiresAt,
        ],
      );
      return { pendingId: id };
    });
  } catch (error) {
    if (error instanceof WechatStoreError) return { error: error.message };
    if ((error as { code?: string }).code === '23505') return { error: 'WECHAT_ALREADY_BOUND' };
    throw error;
  }
}

function assertPending(
  row: WechatPending | undefined,
  token: string,
): asserts row is WechatPending {
  if (!row) return reject('WECHAT_PENDING_NOT_FOUND');
  if (row.status === 'completed') return reject('WECHAT_PENDING_ALREADY_COMPLETED');
  if (
    row.expired ||
    row.status !== 'candidate_ready' ||
    !candidateTokenMatches(row.candidateToken, token)
  )
    return reject('WECHAT_PENDING_INVALID');
}

type ConfirmationResult =
  | { user: LoginUser; subject: string; startedAt: Date; expiresAt: Date; qrcodeId: string | null }
  | { error: string };

/** The challenge or same-flow target session and the candidate are consumed with the association. */
export async function confirmWechatPending(
  pool: Pool,
  input: {
    tokenDigest: string;
    candidateToken: string;
    domain: string;
    action: 'create' | 'link_existing';
    phone?: string;
    code?: string;
    secret: string;
    session?: BindingIdentity;
  },
): Promise<ConfirmationResult> {
  const observed = await readWechatPending(pool, input.tokenDigest);
  if (!observed) return { error: 'WECHAT_PENDING_NOT_FOUND' };
  try {
    assertPending(observed, input.candidateToken);
    return await withAuthTransaction<ConfirmationResult>(pool, async (client) => {
      if (
        input.phone &&
        (!input.code ||
          !(await consumePendingPhoneChallenge(
            client,
            input.secret,
            'wechat_existing',
            input.phone,
            input.code,
            { pendingId: observed.id, candidateToken: input.candidateToken },
          )))
      )
        return { error: 'INVALID_OTP' };
      const user =
        input.action === 'link_existing'
          ? await lockUser(
              client,
              input.session ? 'id' : 'phoneNumber',
              input.session?.userId ?? input.phone ?? '',
            )
          : undefined;
      if (input.session && !(await bindingSessionIsActive(client, input.session)))
        return reject('SESSION_REQUIRED');
      const row = (
        await client.query<WechatPending>(
          'SELECT *, "expiresAt"<=clock_timestamp() AS expired FROM "mioWechatPending" WHERE "tokenDigest"=$1 FOR UPDATE',
          [input.tokenDigest],
        )
      ).rows[0];
      assertPending(row, input.candidateToken);
      if (input.action === 'link_existing') {
        if (!user || (!input.session && !user.phoneNumberVerified))
          return reject('EXISTING_PHONE_NOT_FOUND');
        if (user.disabled) return reject('ACCOUNT_DISABLED');
        if (
          input.session &&
          !(
            await client.query(
              'SELECT 1 FROM "session" WHERE id=$1 AND "createdAt">=$2 AND "expiresAt">clock_timestamp()',
              [input.session.sessionId, row.startedAt],
            )
          ).rowCount
        )
          return reject('SESSION_REQUIRED');
      }
      await lockLoginIdentity(client, 'wechat', row.accountId);
      if (!(await loginCallbackIsCurrent(client, 'wechat', row.accountId, row.startedAt)))
        return reject('WECHAT_PENDING_INVALID');
      const owned = await client.query(
        'SELECT 1 FROM "account" WHERE "providerId"=\'wechat\' AND "accountId"=$1',
        [row.accountId],
      );
      if (owned.rowCount) return reject('WECHAT_ALREADY_BOUND');
      const confirmedUser =
        user ??
        (await createLoginUser(
          client,
          'wechat',
          input.domain,
          Array.from(row.nickname ?? '微信用户')
            .slice(0, 50)
            .join(''),
          row.image,
        ));
      await saveWechatAccount(client, confirmedUser.id, row);
      const completed = await client.query(
        'UPDATE "mioWechatPending" SET status=\'completed\' WHERE id=$1 AND "expiresAt">clock_timestamp() RETURNING id',
        [row.id],
      );
      if (!completed.rowCount) return reject('WECHAT_PENDING_INVALID');
      const qr = (
        await client.query<{ id: string }>(
          'SELECT id FROM "mioWechatQR" WHERE "pendingId"=$1 AND status=\'pending_confirm\'',
          [row.id],
        )
      ).rows[0];
      return {
        user: confirmedUser,
        subject: row.accountId,
        startedAt: row.startedAt,
        expiresAt: row.expiresAt,
        qrcodeId: qr?.id ?? null,
      };
    });
  } catch (error) {
    if (error instanceof WechatStoreError) return { error: error.message };
    if ((error as { code?: string }).code === '23505') return { error: 'WECHAT_ALREADY_BOUND' };
    throw error;
  }
}
