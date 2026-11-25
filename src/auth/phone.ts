import { createId } from '@mio/foundation/identifiers';
import { epochMs } from '@mio/foundation/time';
import { timingSafeEqual } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import {
  APIError,
  createAuthEndpoint,
  getAuthoritativeSessionFromCtx,
  getIP,
} from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { Pool } from 'pg';
import type { SmsSender } from '../integrations/tencent-sms.ts';
import {
  activatePhoneChallenge,
  bindPhoneWithoutChallenge,
  consumePhoneChallenge,
  reservePhoneChallenge,
} from './phone-store.ts';
import type { BindingIdentity } from './phone-store.ts';
import type { PhoneLimits } from './phone-budget.ts';
import type { SmsBudgetTables } from './phone-budget-schema.ts';

export type AuthSmsMode = 'live' | 'bypass' | 'disabled';

export interface PhoneSmsPolicy {
  readonly smsMode: AuthSmsMode;
  readonly smsBypassCode: string | null;
}

export interface PhoneSmsRuntime {
  sender: SmsSender;
  tables: SmsBudgetTables;
}

const MAINLAND_PHONE = /^(?:\+86)?1[3-9]\d{9}$/;
const SIX_DIGIT_CODE = /^\d{6}$/;

export function normalizeMainlandPhone(value: unknown): string | null {
  if (typeof value !== 'string' || !MAINLAND_PHONE.test(value)) return null;
  return value.startsWith('+86') ? value : `+86${value}`;
}

export function isSixDigitCode(value: unknown): value is string {
  return typeof value === 'string' && SIX_DIGIT_CODE.test(value);
}

const schema = {
  user: {
    fields: {
      phoneNumber: { type: 'string', required: false, unique: true, sortable: true, input: false },
      phoneNumberVerified: { type: 'boolean', required: false, input: false },
    },
  },
  mioPhoneChallenge: {
    fields: {
      challengeKey: { type: 'string', unique: true, sortable: true },
      codeHash: { type: 'string' },
      purpose: { type: 'string' },
      userId: { type: 'string', required: false },
      sessionId: { type: 'string', required: false },
      status: { type: 'string' },
      attempts: { type: 'number' },
      expiresAt: { type: 'date', index: true },
    },
  },
  // The legacy field remains a schema-compatible write fence after the event cutover.
  mioSmsBudget: {
    fields: {
      events: { type: 'string' },
      updatedAt: { type: 'date', index: true },
    },
  },
} as const;

export function parsePhoneInput(body: unknown, needsCode: boolean) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new APIError('BAD_REQUEST', { code: 'INVALID_INPUT', message: 'Invalid input' });
  const input = body as Record<string, unknown>;
  const keys = needsCode ? ['phoneNumber', 'code'] : ['phoneNumber'];
  const phone = normalizeMainlandPhone(input.phoneNumber);
  if (
    Object.keys(input).some((key) => !keys.includes(key)) ||
    !phone ||
    (needsCode && !isSixDigitCode(input.code))
  )
    throw new APIError('BAD_REQUEST', { code: 'INVALID_INPUT', message: 'Invalid input' });
  return {
    phone,
    code: needsCode ? (input.code as string) : '',
  };
}

function failure(code: string): never {
  if (code === 'ACCOUNT_DISABLED')
    throw new APIError('FORBIDDEN', { code, message: 'Account is disabled' });
  if (code === 'SMS_RATE_LIMITED')
    throw new APIError('TOO_MANY_REQUESTS', { code, message: 'SMS rate limit reached' });
  if (code === 'PHONE_CONFLICT')
    throw new APIError('CONFLICT', { code, message: 'Phone number cannot be bound' });
  if (code === 'INVALID_OTP')
    throw new APIError('BAD_REQUEST', { code, message: 'Invalid verification code' });
  if (code === 'SESSION_REQUIRED')
    throw new APIError('UNAUTHORIZED', { code, message: 'Recent session required' });
  throw new APIError('SERVICE_UNAVAILABLE', {
    code: 'SMS_UNAVAILABLE',
    message: 'SMS unavailable',
  });
}

/** Narrow endpoints own OTP purpose and DB races; Better Auth still owns sessions and cookies. */
export function phonePlugin(
  config: { secret: string; smsLimits: PhoneLimits },
  pool: Pool,
  sms: PhoneSmsRuntime | undefined,
  domain: string,
  getPolicy?: () => PhoneSmsPolicy,
) {
  const readPolicy: () => PhoneSmsPolicy =
    getPolicy ?? (() => ({ smsMode: 'live', smsBypassCode: null }));
  const send = (purpose: 'login' | 'bind') =>
    createAuthEndpoint(
      purpose === 'login' ? '/phone-number/send-otp' : '/phone-binding/send-otp',
      { method: 'POST' },
      async (ctx) => {
        const { phone } = parsePhoneInput(ctx.body, false);
        const policy = readPolicy();
        if (policy.smsMode === 'disabled') return failure('SMS_UNAVAILABLE');
        if (policy.smsMode === 'bypass') {
          if (!isSixDigitCode(policy.smsBypassCode)) return failure('SMS_UNAVAILABLE');
          if (purpose === 'bind') {
            const session = await getAuthoritativeSessionFromCtx(ctx);
            if (!session || epochMs() - session.session.createdAt.getTime() >= 600_000)
              return failure('SESSION_REQUIRED');
          }
          const ip = ctx.headers ? getIP(ctx.headers, ctx.context.options) : null;
          if (!ip) return failure('SMS_UNAVAILABLE');
          return ctx.json({ status: true });
        }
        if (!sms) return failure('SMS_UNAVAILABLE');
        let binding: BindingIdentity | undefined;
        if (purpose === 'bind') {
          const session = await getAuthoritativeSessionFromCtx(ctx);
          if (!session || epochMs() - session.session.createdAt.getTime() >= 600_000)
            return failure('SESSION_REQUIRED');
          binding = { userId: session.user.id, sessionId: session.session.id };
        }
        const ip = ctx.headers ? getIP(ctx.headers, ctx.context.options) : null;
        if (!ip) return failure('SMS_UNAVAILABLE');
        try {
          const challenge = await reservePhoneChallenge(
            pool,
            sms.tables,
            config.secret,
            config.smsLimits,
            purpose,
            phone,
            ip,
            binding,
          );
          await sms.sender(phone, challenge.code);
          if (!(await activatePhoneChallenge(pool, challenge.id)))
            return failure('SMS_UNAVAILABLE');
        } catch (error) {
          return failure(error instanceof Error ? error.message : 'SMS_UNAVAILABLE');
        }
        return ctx.json({ status: true });
      },
    );
  const verify = (purpose: 'login' | 'bind') =>
    createAuthEndpoint(
      purpose === 'login' ? '/phone-number/verify' : '/phone-binding/confirm',
      { method: 'POST' },
      async (ctx) => {
        const { phone, code } = parsePhoneInput(ctx.body, true);
        const policy = readPolicy();
        if (policy.smsMode === 'disabled') return failure('SMS_UNAVAILABLE');
        if (policy.smsMode === 'bypass') {
          const expected = policy.smsBypassCode;
          if (!isSixDigitCode(expected)) return failure('SMS_UNAVAILABLE');
          if (purpose === 'bind') {
            const session = await getAuthoritativeSessionFromCtx(ctx);
            if (!session || epochMs() - session.session.createdAt.getTime() >= 600_000)
              return failure('SESSION_REQUIRED');
            if (!timingSafeEqual(Buffer.from(code, 'utf8'), Buffer.from(expected, 'utf8')))
              return failure('INVALID_OTP');
            const bound = await bindPhoneWithoutChallenge(pool, phone, {
              userId: session.user.id,
              sessionId: session.session.id,
            });
            if (bound !== 'ok')
              return failure(bound === 'conflict' ? 'PHONE_CONFLICT' : 'SESSION_REQUIRED');
            return ctx.json({ status: true });
          }
          if (!timingSafeEqual(Buffer.from(code, 'utf8'), Buffer.from(expected, 'utf8')))
            return failure('INVALID_OTP');
        } else {
          if (!sms) return failure('SMS_UNAVAILABLE');
          let binding: BindingIdentity | undefined;
          if (purpose === 'bind') {
            const session = await getAuthoritativeSessionFromCtx(ctx);
            if (!session || epochMs() - session.session.createdAt.getTime() >= 600_000)
              return failure('SESSION_REQUIRED');
            binding = { userId: session.user.id, sessionId: session.session.id };
          }
          const consumed = await consumePhoneChallenge(
            pool,
            config.secret,
            purpose,
            phone,
            code,
            binding,
          );
          if (consumed !== 'ok')
            return failure(
              consumed === 'conflict'
                ? 'PHONE_CONFLICT'
                : consumed === 'session'
                  ? 'SESSION_REQUIRED'
                  : 'INVALID_OTP',
            );
          if (binding) return ctx.json({ status: true });
        }
        let user = await ctx.context.adapter.findOne<{
          id: string;
          email: string;
          emailVerified: boolean;
          name: string;
          createdAt: Date;
          updatedAt: Date;
          phoneNumberVerified?: boolean | null;
          disabled?: boolean | null;
        }>({ model: 'user', where: [{ field: 'phoneNumber', value: phone }] });
        if (user && !user.phoneNumberVerified) return failure('INVALID_OTP');
        if (user && user.disabled) return failure('ACCOUNT_DISABLED');
        if (!user)
          user = await ctx.context.internalAdapter.createUser(
            {
              email: `phone-${createId()}@${domain}`,
              emailVerified: false,
              name: '用户',
              phoneNumber: phone,
              phoneNumberVerified: true,
            },
            { method: 'phone-number' },
          );
        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session) return failure('SMS_UNAVAILABLE');
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ status: true });
      },
    );
  return {
    id: 'mio-phone',
    schema,
    endpoints: {
      sendMioPhoneOTP: send('login'),
      verifyMioPhone: verify('login'),
      sendMioPhoneBindingOTP: send('bind'),
      confirmMioPhoneBinding: verify('bind'),
    },
  } satisfies BetterAuthPlugin;
}
