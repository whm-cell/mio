import type { BetterAuthOptions } from 'better-auth';
import type { Pool } from 'pg';

export const AUTH_BASE_PATH = '/api/auth';

export interface AuthConfig {
  baseURL: string;
  secret: string;
  databaseURL: string;
  origins: readonly string[];
}

/** Runtime selection is separate so the explicit PostgreSQL migration never consumes Redis. */
export function readAuthRateLimitBackend(env: NodeJS.ProcessEnv = process.env) {
  const backend = env.MIO_AUTH_RATE_LIMIT_BACKEND ?? 'database';
  if (backend !== 'database' && backend !== 'redis')
    throw new Error('AUTH_CONFIG: rate limit backend must be database or redis');
  return backend;
}

/** The public URL is deployment configuration, never derived from Host or forwarded headers. */
export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig | undefined {
  const keys = ['MIO_AUTH_BASE_URL', 'MIO_AUTH_SECRET', 'MIO_AUTH_DATABASE_URL'] as const;
  if (!keys.some((key) => env[key] !== undefined)) return undefined;
  if (keys.some((key) => !env[key]))
    throw new Error('AUTH_CONFIG: base URL, secret and database URL are required');
  let base: URL;
  let database: URL;
  let extra: unknown;
  try {
    base = new URL(env.MIO_AUTH_BASE_URL!);
    database = new URL(env.MIO_AUTH_DATABASE_URL!);
    extra = JSON.parse(env.MIO_AUTH_ALLOWED_ORIGINS ?? '[]');
    if (
      !Array.isArray(extra) ||
      extra.some(
        (origin) =>
          typeof origin !== 'string' ||
          new URL(origin).origin !== origin ||
          !['https:', 'http:'].includes(new URL(origin).protocol),
      )
    )
      throw new Error('origins');
  } catch {
    throw new Error('AUTH_CONFIG: invalid URL or origin list');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (
    base.origin !== env.MIO_AUTH_BASE_URL ||
    base.username ||
    base.password ||
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))
  )
    throw new Error('AUTH_CONFIG: use an exact HTTPS origin (HTTP allowed on loopback only)');
  if (env.MIO_AUTH_SECRET!.length < 32)
    throw new Error('AUTH_CONFIG: secret must have at least 32 characters');
  if (!['postgres:', 'postgresql:'].includes(database.protocol))
    throw new Error('AUTH_CONFIG: PostgreSQL URL required');
  return {
    baseURL: base.origin,
    secret: env.MIO_AUTH_SECRET!,
    databaseURL: env.MIO_AUTH_DATABASE_URL!,
    origins: [base.origin, ...(extra as string[])],
  };
}

/** Shared by runtime and the explicit migration command so their schemas cannot diverge. */
export function authOptions(config: AuthConfig, pool: Pool): BetterAuthOptions {
  return {
    appName: 'Mio',
    baseURL: config.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    database: pool,
    trustedOrigins: [...config.origins],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    account: { accountLinking: { enabled: false } },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: config.baseURL.startsWith('https:'),
      cookiePrefix: 'mio',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
      ipAddress: { ipAddressHeaders: ['x-mio-client-ip'] },
    },
    telemetry: { enabled: false },
    logger: { disabled: true },
  };
}
