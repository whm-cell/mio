import type { BetterAuthOptions } from 'better-auth';
import type { Pool } from 'pg';
import type { TencentSmsConfig } from '../integrations/tencent-sms.ts';
import type { WechatConfig } from '../integrations/wechat.ts';
import { accountPlugin, isUserDisabled } from './account.ts';
import { phonePlugin } from './phone.ts';
import type { AuthSmsMode, PhoneSmsPolicy, PhoneSmsRuntime } from './phone.ts';
import type { PhoneLimits } from './phone-budget.ts';
import { validateWechatUser, wechatPlugin } from './wechat.ts';
import { wechatQRPlugin } from './wechat-qr.ts';
import { AuthPostgresDialect } from './database.ts';

export const AUTH_BASE_PATH = '/api/auth';
export const AUTH_PLACEHOLDER_EMAIL_DOMAIN = 'auth.mio.invalid';

export type { AuthSmsMode };

export interface AuthRuntimePolicy extends PhoneSmsPolicy {
  readonly emailPasswordEnabled: boolean;
}

export type AuthPolicyReader = () => AuthRuntimePolicy;

export interface AuthConfig {
  baseURL: string;
  secret: string;
  databaseURL: string;
  origins: readonly string[];
  emailPasswordEnabled: boolean;
  sms?: TencentSmsConfig;
  smsLimits: PhoneLimits;
  wechat?: WechatConfig;
}

function readEmailPasswordEnabled(env: NodeJS.ProcessEnv): boolean {
  const enabled = env.MIO_AUTH_EMAIL_PASSWORD_ENABLED ?? 'true';
  if (enabled !== 'true' && enabled !== 'false')
    throw new Error('AUTH_CONFIG: invalid email/password switch');
  return enabled === 'true';
}

function readWechatConfig(env: NodeJS.ProcessEnv) {
  const enabled = env.MIO_AUTH_WECHAT_ENABLED ?? 'false';
  if (enabled !== 'true' && enabled !== 'false')
    throw new Error('AUTH_CONFIG: invalid WeChat switch');
  if (enabled === 'false') return undefined;
  const appId = env.MIO_AUTH_WECHAT_APP_ID?.trim();
  const appSecret = env.MIO_AUTH_WECHAT_APP_SECRET?.trim();
  if (!appId || !/^[a-zA-Z0-9_-]{1,128}$/.test(appId) || !appSecret)
    throw new Error('AUTH_CONFIG: incomplete WeChat configuration');
  return { appId, appSecret };
}

function readSmsConfig(env: NodeJS.ProcessEnv) {
  const enabled = env.MIO_AUTH_SMS_ENABLED ?? 'false';
  if (enabled !== 'true' && enabled !== 'false') throw new Error('AUTH_CONFIG: invalid SMS switch');
  const bounded = (key: string, maximum: number) => {
    const value = env[key] === undefined ? maximum : Number(env[key]);
    if (!Number.isInteger(value) || value < 1 || value > maximum)
      throw new Error(`AUTH_CONFIG: invalid ${key}`);
    return value;
  };
  const smsLimits = {
    phoneHour: bounded('MIO_AUTH_SMS_PHONE_HOUR_LIMIT', 5),
    phoneDay: bounded('MIO_AUTH_SMS_PHONE_DAY_LIMIT', 10),
    ipHour: bounded('MIO_AUTH_SMS_IP_HOUR_LIMIT', 20),
    ipDay: bounded('MIO_AUTH_SMS_IP_DAY_LIMIT', 100),
    globalDay: bounded('MIO_AUTH_SMS_GLOBAL_DAY_LIMIT', 1000),
  };
  if (enabled === 'false') return { smsLimits };
  const keys = [
    'MIO_TENCENT_SMS_SECRET_ID',
    'MIO_TENCENT_SMS_SECRET_KEY',
    'MIO_TENCENT_SMS_APP_ID',
    'MIO_TENCENT_SMS_SIGN_NAME',
    'MIO_TENCENT_SMS_TEMPLATE_ID',
    'MIO_TENCENT_SMS_REGION',
  ] as const;
  if (keys.some((key) => !env[key]?.trim()))
    throw new Error('AUTH_CONFIG: incomplete SMS configuration');
  return {
    smsLimits,
    sms: {
      secretId: env.MIO_TENCENT_SMS_SECRET_ID!,
      secretKey: env.MIO_TENCENT_SMS_SECRET_KEY!,
      appId: env.MIO_TENCENT_SMS_APP_ID!,
      signName: env.MIO_TENCENT_SMS_SIGN_NAME!,
      templateId: env.MIO_TENCENT_SMS_TEMPLATE_ID!,
      region: env.MIO_TENCENT_SMS_REGION!,
    },
  };
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
  if (!keys.some((key) => env[key] !== undefined)) {
    if (
      (env.MIO_AUTH_SMS_ENABLED && env.MIO_AUTH_SMS_ENABLED !== 'false') ||
      (env.MIO_AUTH_WECHAT_ENABLED && env.MIO_AUTH_WECHAT_ENABLED !== 'false') ||
      (env.MIO_AUTH_EMAIL_PASSWORD_ENABLED && env.MIO_AUTH_EMAIL_PASSWORD_ENABLED !== 'false')
    )
      throw new Error('AUTH_CONFIG: provider requires authentication configuration');
    return undefined;
  }
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
  const emailPasswordEnabled = readEmailPasswordEnabled(env);
  const wechat = readWechatConfig(env);
  return {
    baseURL: base.origin,
    secret: env.MIO_AUTH_SECRET!,
    databaseURL: env.MIO_AUTH_DATABASE_URL!,
    origins: [base.origin, ...(extra as string[])],
    emailPasswordEnabled,
    ...readSmsConfig(env),
    ...(wechat ? { wechat } : {}),
  };
}

/** Shared by runtime and the explicit migration command so their schemas cannot diverge. */
export function authOptions(
  config: AuthConfig,
  pool: Pool,
  sms?: PhoneSmsRuntime,
  getPolicy?: AuthPolicyReader,
): BetterAuthOptions {
  return {
    appName: 'Mio',
    baseURL: config.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    database: { dialect: new AuthPostgresDialect({ pool }), type: 'postgres', transaction: true },
    trustedOrigins: [...config.origins],
    plugins: [
      accountPlugin(),
      phonePlugin(config, pool, sms, AUTH_PLACEHOLDER_EMAIL_DOMAIN, getPolicy),
      wechatPlugin(config.wechat, AUTH_PLACEHOLDER_EMAIL_DOMAIN, pool),
      wechatQRPlugin(config.baseURL, pool),
    ],
    user: {
      async validateUserInfo(data, context) {
        const { user, source } = data;
        if (
          source.method === 'email-password' &&
          source.action === 'create-user' &&
          user.email?.toLowerCase().endsWith(`@${AUTH_PLACEHOLDER_EMAIL_DOMAIN}`)
        )
          return { error: 'RESERVED_EMAIL_DOMAIN' };
        if (source.action !== 'create-user' && isUserDisabled(user))
          return { error: 'ACCOUNT_DISABLED' };
        return validateWechatUser(data, context);
      },
    },
    ...(config.wechat
      ? {
          socialProviders: {
            wechat: { clientId: config.wechat.appId, clientSecret: config.wechat.appSecret },
          },
        }
      : {}),
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
    account: {
      encryptOAuthTokens: true,
      storeStateStrategy: 'database',
      skipStateCookieCheck: false,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        trustedProviders: ['wechat'],
        allowDifferentEmails: true,
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 5 },
        '/phone-number/verify': { window: 60, max: 10 },
        '/phone-binding/confirm': { window: 60, max: 10 },
        '/sign-in/social': { window: 60, max: 10 },
        '/link-social': { window: 60, max: 10 },
        '/wechat/qr-session': { window: 60, max: 20 },
        '/wechat/qr-session/*/poll': { window: 60, max: 300 },
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
