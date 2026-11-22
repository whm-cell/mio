import { createLogger } from '@mio/foundation/logging';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { authOptions } from './config.ts';
import type { AuthConfig, AuthPolicyReader } from './config.ts';
import { isUserDisabled, readUserProfile, setUserDisabled, updateUserProfile } from './account.ts';
import type { UserProfilePatch } from './account.ts';
import { readSmsBudgetSchema } from './phone-budget-schema.ts';
import type { AuthRateLimitStorage } from './rate-limit.ts';
import { createTencentSmsSender } from '../integrations/tencent-sms.ts';
import type { SmsSender } from '../integrations/tencent-sms.ts';

const log = createLogger('app', 'auth');

/** Runtime only checks schema; applying migrations is a separate, explicit service operation. */
export async function createAuthentication(
  config: AuthConfig,
  rateLimit?: AuthRateLimitStorage,
  sender?: SmsSender,
  getPolicy?: AuthPolicyReader,
) {
  const pool = new Pool({
    connectionString: config.databaseURL,
    max: 5,
    connectionTimeoutMillis: 5000,
    application_name: 'mio-auth',
  });
  pool.on('error', () => log.error('AUTH_DATABASE_CONNECTION_ERROR'));
  try {
    const smsBudget = await readSmsBudgetSchema(pool);
    if (smsBudget.layout === 'empty' || ((config.sms || sender) && smsBudget.layout !== 'indexed'))
      throw new Error('AUTH_SCHEMA: run auth:migrate --apply before enabling authentication');
    const smsSender = sender ?? (config.sms ? createTencentSmsSender(config.sms) : undefined);
    const sms = smsSender ? { sender: smsSender, tables: smsBudget.tables } : undefined;
    const options = authOptions(config, pool, sms, getPolicy);
    if (rateLimit) options.rateLimit = { ...options.rateLimit, customStorage: rateLimit };
    const migration = await getMigrations(options);
    if (
      migration.toBeCreated.length ||
      migration.toBeAdded.length ||
      migration.toBeAddedIndexes.length ||
      migration.schemaProblems.length
    )
      throw new Error('AUTH_SCHEMA: run auth:migrate before enabling authentication');
    if (config.wechat) {
      const namespace = `${JSON.stringify([config.wechat.appId]).slice(0, -1)},`;
      const mismatched = await pool.query(
        `SELECT 1 FROM "account" WHERE "providerId" = 'wechat'
         AND left("accountId", length($1)) <> $1 LIMIT 1`,
        [namespace],
      );
      if (mismatched.rowCount) throw new Error('AUTH_WECHAT_APP_CHANGED: migration required');
    }
    const auth = betterAuth(options);
    await auth.$context;
    return {
      handler: auth.handler,
      /** Business services receive this verified identity, never a userId supplied in a body. */
      async identity(headers: Headers) {
        const session = await auth.api.getSession({ headers, query: { disableRefresh: true } });
        if (!session || isUserDisabled(session.user)) return null;
        return { userId: session.user.id, sessionId: session.session.id };
      },
      profile: (userId: string) => readUserProfile(pool, userId),
      updateProfile: (userId: string, patch: UserProfilePatch) =>
        updateUserProfile(pool, userId, patch),
      setUserDisabled: (userId: string, disabled: boolean) =>
        setUserDisabled(pool, userId, disabled),
      close: () => pool.end(),
    };
  } catch (error) {
    await pool.end();
    throw error instanceof Error &&
      (error.message.startsWith('AUTH_SCHEMA') ||
        error.message.startsWith('AUTH_WECHAT_APP_CHANGED'))
      ? error
      : new Error('AUTH_STARTUP: authentication database is unavailable or incompatible');
  }
}

export type Authentication = Awaited<ReturnType<typeof createAuthentication>>;
