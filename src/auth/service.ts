import { createLogger } from '@mio/foundation/logging';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { authOptions } from './config.ts';
import type { AuthConfig } from './config.ts';
import type { AuthRateLimitStorage } from './rate-limit.ts';

const log = createLogger('app', 'auth');

/** Runtime only checks schema; applying migrations is a separate, explicit service operation. */
export async function createAuthentication(config: AuthConfig, rateLimit?: AuthRateLimitStorage) {
  const pool = new Pool({
    connectionString: config.databaseURL,
    max: 5,
    connectionTimeoutMillis: 5000,
    application_name: 'mio-auth',
  });
  pool.on('error', () => log.error('AUTH_DATABASE_CONNECTION_ERROR'));
  try {
    const options = authOptions(config, pool);
    if (rateLimit) options.rateLimit = { ...options.rateLimit, customStorage: rateLimit };
    const migration = await getMigrations(options);
    if (
      migration.toBeCreated.length ||
      migration.toBeAdded.length ||
      migration.toBeAddedIndexes.length ||
      migration.schemaProblems.length
    )
      throw new Error('AUTH_SCHEMA: run auth:migrate before enabling authentication');
    const auth = betterAuth(options);
    await auth.$context;
    return {
      handler: auth.handler,
      /** Business services receive this verified identity, never a userId supplied in a body. */
      async identity(headers: Headers) {
        const session = await auth.api.getSession({ headers, query: { disableRefresh: true } });
        return session ? { userId: session.user.id, sessionId: session.session.id } : null;
      },
      close: () => pool.end(),
    };
  } catch (error) {
    await pool.end();
    throw error instanceof Error && error.message.startsWith('AUTH_SCHEMA')
      ? error
      : new Error('AUTH_STARTUP: authentication database is unavailable or incompatible');
  }
}

export type Authentication = Awaited<ReturnType<typeof createAuthentication>>;
