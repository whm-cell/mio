import { sha256Utf8 } from '@mio/foundation/hash';
import { createId } from '@mio/foundation/identifiers';
import { timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { generateUniqueDisplayId } from './account.ts';
import type { BindingIdentity } from './phone-store.ts';
import { withAuthTransaction } from './transaction.ts';

export type LoginProvider = 'wechat' | 'onelink';

export interface LoginUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
  disabled: boolean;
}

export function candidateTokenMatches(expected: string, supplied: string) {
  const left = Buffer.from(expected),
    right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Both explicit provider signup paths share display-ID collision handling and atomic user creation. */
export async function createLoginUser(
  client: PoolClient,
  provider: LoginProvider,
  domain: string,
  name: string,
  image: string | null = null,
): Promise<LoginUser> {
  const id = createId();
  for (let attempt = 0; attempt < 5; attempt++) {
    const displayId = await generateUniqueDisplayId(async (candidate) =>
      Boolean(
        (await client.query('SELECT 1 FROM "user" WHERE "displayId"=$1 LIMIT 1', [candidate]))
          .rowCount,
      ),
    );
    await client.query('SAVEPOINT provider_create_user');
    try {
      const user = (
        await client.query<LoginUser>(
          `INSERT INTO "user" (id,name,email,"emailVerified",image,"phoneNumber","phoneNumberVerified","displayId",disabled,"disabledAt","createdAt","updatedAt")
         VALUES ($1,$2,$3,false,$4,NULL,false,$5,false,NULL,clock_timestamp(),clock_timestamp())
         RETURNING id,email,"emailVerified",name,image,"createdAt","updatedAt",COALESCE(disabled,false) AS disabled`,
          [id, name, `${provider}-${createId()}@${domain}`, image, displayId],
        )
      ).rows[0]!;
      await client.query('RELEASE SAVEPOINT provider_create_user');
      return user;
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
      await client.query('ROLLBACK TO SAVEPOINT provider_create_user');
    }
  }
  throw new Error('AUTH_DISPLAY_ID_EXHAUSTED');
}

/** Every final provider write takes this lock after its user/session/pending locks. */
export async function lockLoginIdentity(
  client: PoolClient,
  provider: LoginProvider,
  subject: string,
) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `mio-auth:${provider}:${subject}`,
  ]);
}

const invalidationId = (provider: LoginProvider, subject: string) =>
  `mio-unbound:${provider}:${sha256Utf8(subject)}`;

/** Only invalidate callbacks that were already in flight; expired markers carry no historical state. */
export async function loginCallbackIsCurrent(
  client: PoolClient,
  provider: LoginProvider,
  subject: string,
  startedAt: Date,
) {
  const invalidated = await client.query(
    `SELECT 1 FROM "verification" WHERE identifier=$1 AND "expiresAt">clock_timestamp()
     AND "createdAt">=$2 LIMIT 1`,
    [invalidationId(provider, subject), startedAt],
  );
  return !invalidated.rowCount;
}

async function invalidateLoginCallbacks(
  client: PoolClient,
  provider: LoginProvider,
  subject: string,
) {
  const identifier = invalidationId(provider, subject);
  await client.query('DELETE FROM "verification" WHERE identifier=$1', [identifier]);
  await client.query(
    `INSERT INTO "verification" (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
     VALUES ($1,$2,'invalidated',clock_timestamp()+interval '10 minutes',clock_timestamp(),clock_timestamp())`,
    [createId(), identifier],
  );
  await client.query(
    `DELETE FROM "verification" WHERE id IN (SELECT id FROM "verification"
     WHERE identifier LIKE 'mio-unbound:%' AND "expiresAt"<=clock_timestamp() LIMIT 100 FOR UPDATE SKIP LOCKED)`,
  );
}

export interface AvailableLoginMethods {
  sms: boolean;
  emailPassword: boolean;
  wechat: boolean;
  onelink: boolean;
}

/** A just-issued session is delivered only if its original provider authorization still owns the user. */
export function validateNewProviderSession(
  pool: Pool,
  input: BindingIdentity & {
    provider: LoginProvider;
    subject: string;
    startedAt: Date;
    expiresAt: Date;
  },
) {
  return withAuthTransaction(pool, async (client) => {
    await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [input.userId]);
    await client.query('SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 FOR UPDATE', [
      input.sessionId,
      input.userId,
    ]);
    await lockLoginIdentity(client, input.provider, input.subject);
    const owned = await client.query(
      `SELECT 1 FROM "user" u JOIN "session" s ON s."userId"=u.id
       JOIN "account" a ON a."userId"=u.id
       WHERE u.id=$1 AND s.id=$2 AND s."expiresAt">clock_timestamp() AND COALESCE(u.disabled,false)=false
       AND a."providerId"=$3 AND a."accountId"=$4 AND $5::timestamptz>clock_timestamp()`,
      [input.userId, input.sessionId, input.provider, input.subject, input.expiresAt],
    );
    if (
      owned.rowCount &&
      (await loginCallbackIsCurrent(client, input.provider, input.subject, input.startedAt))
    )
      return true;
    await client.query('DELETE FROM "session" WHERE id=$1 AND "userId"=$2', [
      input.sessionId,
      input.userId,
    ]);
    return false;
  });
}

/** User locking serializes both unbinds and provider binds; existing sessions are deliberately retained. */
export function unlinkLoginMethod(
  pool: Pool,
  identity: BindingIdentity,
  provider: LoginProvider,
  available: AvailableLoginMethods,
): Promise<'ok' | 'session_required' | 'last_login_method'> {
  return withAuthTransaction(pool, async (client) => {
    const user = await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [
      identity.userId,
    ]);
    if (!user.rowCount) return 'session_required';
    await client.query('SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 FOR UPDATE', [
      identity.sessionId,
      identity.userId,
    ]);
    const active = await client.query(
      `SELECT 1 FROM "user" u JOIN "session" s ON s."userId"=u.id
       WHERE u.id=$1 AND s.id=$2 AND COALESCE(u.disabled,false)=false AND s."expiresAt">clock_timestamp()`,
      [identity.userId, identity.sessionId],
    );
    if (!active.rowCount) return 'session_required';
    const account = (
      await client.query<{ accountId: string }>(
        'SELECT "accountId" FROM "account" WHERE "userId"=$1 AND "providerId"=$2',
        [identity.userId, provider],
      )
    ).rows[0];
    if (!account) return 'ok';
    await lockLoginIdentity(client, provider, account.accountId);
    const usable = await client.query(
      `SELECT 1 FROM "user" u WHERE u.id=$1 AND (
        ($2::boolean AND u."phoneNumber" IS NOT NULL AND u."phoneNumberVerified"=true) OR
        ($3::boolean AND u.email NOT LIKE '%@auth.mio.invalid' AND u.email LIKE '%_@_%._%' AND EXISTS (SELECT 1 FROM "account" a WHERE a."userId"=u.id
          AND a."providerId"='credential' AND a.password IS NOT NULL AND a.password<>'')) OR
        ($4::boolean AND $6<>'wechat' AND EXISTS (SELECT 1 FROM "account" a WHERE a."userId"=u.id AND a."providerId"='wechat')) OR
        ($5::boolean AND $6<>'onelink' AND EXISTS (SELECT 1 FROM "account" a WHERE a."userId"=u.id AND a."providerId"='onelink'))
      )`,
      [
        identity.userId,
        available.sms,
        available.emailPassword,
        available.wechat,
        available.onelink,
        provider,
      ],
    );
    if (!usable.rowCount) return 'last_login_method';
    await client.query('DELETE FROM "account" WHERE "userId"=$1 AND "providerId"=$2', [
      identity.userId,
      provider,
    ]);
    await invalidateLoginCallbacks(client, provider, account.accountId);
    return 'ok';
  });
}
