import { randomInt } from 'node:crypto';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { epochMs } from '@mio/foundation/time';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx } from 'better-auth/api';
import { deleteSessionCookie } from 'better-auth/cookies';
import type { Pool, PoolClient } from 'pg';
import { withAuthTransaction } from './transaction.ts';

const DISPLAY_ID_PREFIX = 'miioo_';
const DISPLAY_ID_MAX_ATTEMPTS = 50;
const PROFILE_NAME_MAX_LENGTH = 50;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SESSION_GUARDED_PATHS = new Set([
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/change-password',
  '/link-social',
  '/phone-binding/send-otp',
  '/phone-binding/confirm',
]);

export interface UserProfile {
  userId: string;
  displayId: string | null;
  name: string;
  avatarAssetId: string | null;
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
  wechatBound: boolean;
  onelinkBound: boolean;
}

export interface UserProfilePatch {
  name?: string;
  avatarAssetId?: string | null;
}

export interface UserDisabledStatus {
  userId: string;
  disabled: boolean;
  disabledAt: string | null;
  revokedSessions: number;
}

interface ProfileRow {
  id: string;
  displayId: string | null;
  name: string;
  avatarAssetId: string | null;
  phoneNumber: string | null;
  phoneNumberVerified: boolean | null;
  wechatBound: boolean;
  onelinkBound: boolean;
}

const accountSchema = {
  user: {
    fields: {
      disabled: { type: 'boolean', required: false, defaultValue: false, input: false },
      disabledAt: { type: 'date', required: false, input: false },
      displayId: { type: 'string', required: false, unique: true, input: false },
      avatarAssetId: { type: 'string', required: false, input: false },
    },
  },
} as const;

export function isUserDisabled(user: unknown): boolean {
  return Boolean(
    user && typeof user === 'object' && (user as { disabled?: unknown }).disabled === true,
  );
}

export async function generateUniqueDisplayId(exists: (candidate: string) => Promise<boolean>) {
  for (let attempt = 0; attempt < DISPLAY_ID_MAX_ATTEMPTS; attempt += 1) {
    const candidate = `${DISPLAY_ID_PREFIX}${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('AUTH_DISPLAY_ID_EXHAUSTED');
}

/** Enforce disabled-account rejection across session creation/reads and assign displayId on signup. */
export function accountPlugin(): BetterAuthPlugin {
  return {
    id: 'mio-account',
    schema: accountSchema,
    init(authContext) {
      return {
        options: {
          databaseHooks: {
            user: {
              create: {
                async before(user, ctx) {
                  const adapter = ctx?.context.adapter ?? authContext.adapter;
                  const existing =
                    typeof user.displayId === 'string' && user.displayId.length > 0
                      ? user.displayId
                      : undefined;
                  const displayId =
                    existing ??
                    (await generateUniqueDisplayId(async (candidate) =>
                      Boolean(
                        await adapter.findOne({
                          model: 'user',
                          where: [{ field: 'displayId', value: candidate }],
                        }),
                      ),
                    ));
                  const disabled = isUserDisabled(user);
                  return {
                    data: {
                      ...user,
                      displayId,
                      disabled,
                      disabledAt: disabled ? (user.disabledAt ?? new Date(epochMs())) : null,
                    },
                  };
                },
              },
            },
            session: {
              create: {
                async before(session, ctx) {
                  const internalAdapter =
                    ctx?.context.internalAdapter ?? authContext.internalAdapter;
                  const user = await internalAdapter.findUserById(session.userId);
                  if (isUserDisabled(user)) {
                    throw new APIError('FORBIDDEN', {
                      code: 'ACCOUNT_DISABLED',
                      message: 'Account is disabled',
                    });
                  }
                },
              },
            },
          },
        },
      };
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => Boolean(ctx.path && SESSION_GUARDED_PATHS.has(ctx.path)),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getAuthoritativeSessionFromCtx(ctx);
            if (!session || !isUserDisabled(session.user)) return;
            await ctx.context.internalAdapter.deleteSession(session.session.token);
            ctx.responseHeaders?.delete('set-cookie');
            deleteSessionCookie(ctx);
            throw new APIError('UNAUTHORIZED', { code: 'UNAUTHORIZED', message: 'Unauthorized' });
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === '/get-session',
          handler: createAuthMiddleware(async (ctx) => {
            const session = ctx.context.session;
            if (!session || !isUserDisabled(session.user)) return;
            await ctx.context.internalAdapter.deleteSession(session.session.token);
            ctx.responseHeaders?.delete('set-cookie');
            deleteSessionCookie(ctx);
            return ctx.json(null);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

export function parseProfilePatch(body: Record<string, unknown>): UserProfilePatch | null {
  const keys = Object.keys(body);
  if (!keys.length || keys.some((key) => key !== 'name' && key !== 'avatarAssetId')) return null;
  const patch: UserProfilePatch = {};
  if ('name' in body) {
    if (typeof body.name !== 'string' || CONTROL_CHARS.test(body.name)) return null;
    const trimmed = body.name.trim();
    const length = [...trimmed].length;
    if (length < 1 || length > PROFILE_NAME_MAX_LENGTH) return null;
    patch.name = trimmed;
  }
  if ('avatarAssetId' in body) {
    if (
      body.avatarAssetId !== null &&
      (typeof body.avatarAssetId !== 'string' || !isUuidV4(body.avatarAssetId))
    )
      return null;
    patch.avatarAssetId = body.avatarAssetId;
  }
  return patch;
}

const PROFILE_SELECT = `
  SELECT u.id, u."displayId", u.name, u."avatarAssetId", u."phoneNumber", u."phoneNumberVerified",
         EXISTS (
           SELECT 1 FROM "account" a WHERE a."userId" = u.id AND a."providerId" = 'wechat'
         ) AS "wechatBound",
         EXISTS (
           SELECT 1 FROM "account" a WHERE a."userId" = u.id AND a."providerId" = 'onelink'
         ) AS "onelinkBound"
  FROM "user" u
  WHERE u.id = $1 AND COALESCE(u.disabled, false) = false
`;

function toProfile(row: ProfileRow): UserProfile {
  return {
    userId: row.id,
    displayId: row.displayId,
    name: row.name,
    avatarAssetId: row.avatarAssetId,
    phoneNumber: row.phoneNumber,
    phoneNumberVerified: Boolean(row.phoneNumberVerified),
    wechatBound: Boolean(row.wechatBound),
    onelinkBound: Boolean(row.onelinkBound),
  };
}

async function queryProfile(
  client: Pool | PoolClient,
  userId: string,
): Promise<UserProfile | null> {
  const result = await client.query<ProfileRow>(PROFILE_SELECT, [userId]);
  const row = result.rows[0];
  return row ? toProfile(row) : null;
}

export function readUserProfile(pool: Pool, userId: string): Promise<UserProfile | null> {
  return queryProfile(pool, userId);
}

export function updateUserProfile(
  pool: Pool,
  userId: string,
  patch: UserProfilePatch,
): Promise<UserProfile | null> {
  const sets: string[] = [];
  const values: unknown[] = [userId];
  if (patch.name !== undefined) {
    values.push(patch.name);
    sets.push(`name = $${values.length}`);
  }
  if (patch.avatarAssetId !== undefined) {
    values.push(patch.avatarAssetId);
    sets.push(`"avatarAssetId" = $${values.length}`);
  }
  if (!sets.length) return queryProfile(pool, userId);
  sets.push('"updatedAt" = now()');
  return withAuthTransaction(pool, async (client) => {
    const updated = await client.query(
      `UPDATE "user" SET ${sets.join(', ')}
       WHERE id = $1 AND COALESCE(disabled, false) = false RETURNING id`,
      values,
    );
    if (updated.rowCount !== 1) return null;
    return queryProfile(client, userId);
  });
}

/** Atomically toggle account disabled state and revoke all active sessions when disabling. */
export function setUserDisabled(
  pool: Pool,
  userId: string,
  disabled: boolean,
): Promise<UserDisabledStatus | null> {
  return withAuthTransaction(pool, async (client) => {
    const locked = await client.query<{ id: string }>(
      'SELECT id FROM "user" WHERE id = $1 FOR UPDATE',
      [userId],
    );
    if (!locked.rowCount) return null;
    if (disabled) {
      const updated = await client.query<{ disabledAt: Date }>(
        `UPDATE "user"
         SET disabled = true, "disabledAt" = COALESCE("disabledAt", now()), "updatedAt" = now()
         WHERE id = $1 RETURNING "disabledAt"`,
        [userId],
      );
      const revoked = await client.query('DELETE FROM "session" WHERE "userId" = $1', [userId]);
      return {
        userId,
        disabled: true,
        disabledAt: updated.rows[0]!.disabledAt.toISOString(),
        revokedSessions: revoked.rowCount ?? 0,
      };
    }
    await client.query(
      `UPDATE "user" SET disabled = false, "disabledAt" = NULL, "updatedAt" = now() WHERE id = $1`,
      [userId],
    );
    return { userId, disabled: false, disabledAt: null, revokedSessions: 0 };
  });
}
