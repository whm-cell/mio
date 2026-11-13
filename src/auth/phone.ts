import { randomUUID } from 'node:crypto';
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
  consumePhoneChallenge,
  reservePhoneChallenge,
} from './phone-store.ts';
import type { BindingIdentity, PhoneLimits, PhonePurpose } from './phone-store.ts';

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
  mioSmsBudget: {
    fields: {
      events: { type: 'string' },
      updatedAt: { type: 'date', index: true },
    },
  },
} as const;

function parseInput(body: unknown, needsCode: boolean) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new APIError('BAD_REQUEST', { code: 'INVALID_INPUT', message: 'Invalid input' });
  const input = body as Record<string, unknown>;
  const keys = needsCode ? ['phoneNumber', 'code'] : ['phoneNumber'];
  if (
    Object.keys(input).some((key) => !keys.includes(key)) ||
    typeof input.phoneNumber !== 'string' ||
    !/^(?:\+86)?1[3-9]\d{9}$/.test(input.phoneNumber) ||
    (needsCode && (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)))
  )
    throw new APIError('BAD_REQUEST', { code: 'INVALID_INPUT', message: 'Invalid input' });
  return {
    phone: input.phoneNumber.startsWith('+86') ? input.phoneNumber : `+86${input.phoneNumber}`,
    code: needsCode ? (input.code as string) : '',
  };
}

function failure(code: string): never {
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
  sender: SmsSender | undefined,
  domain: string,
) {
  const send = (purpose: PhonePurpose) =>
    createAuthEndpoint(
      purpose === 'login' ? '/phone-number/send-otp' : '/phone-binding/send-otp',
      { method: 'POST' },
      async (ctx) => {
        const { phone } = parseInput(ctx.body, false);
        if (!sender) return failure('SMS_UNAVAILABLE');
        let binding: BindingIdentity | undefined;
        if (purpose === 'bind') {
          const session = await getAuthoritativeSessionFromCtx(ctx);
          if (!session || Date.now() - session.session.createdAt.getTime() >= 600_000)
            return failure('SESSION_REQUIRED');
          binding = { userId: session.user.id, sessionId: session.session.id };
        }
        const ip = ctx.headers ? getIP(ctx.headers, ctx.context.options) : null;
        if (!ip) return failure('SMS_UNAVAILABLE');
        try {
          const challenge = await reservePhoneChallenge(
            pool,
            config.secret,
            config.smsLimits,
            purpose,
            phone,
            ip,
            binding,
          );
          await sender(phone, challenge.code);
          if (!(await activatePhoneChallenge(pool, challenge.id)))
            return failure('SMS_UNAVAILABLE');
        } catch (error) {
          return failure(error instanceof Error ? error.message : 'SMS_UNAVAILABLE');
        }
        return ctx.json({ status: true });
      },
    );
  const verify = (purpose: PhonePurpose) =>
    createAuthEndpoint(
      purpose === 'login' ? '/phone-number/verify' : '/phone-binding/confirm',
      { method: 'POST' },
      async (ctx) => {
        const { phone, code } = parseInput(ctx.body, true);
        if (!sender) return failure('SMS_UNAVAILABLE');
        let binding: BindingIdentity | undefined;
        if (purpose === 'bind') {
          const session = await getAuthoritativeSessionFromCtx(ctx);
          if (!session || Date.now() - session.session.createdAt.getTime() >= 600_000)
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
        let user = await ctx.context.adapter.findOne<{
          id: string;
          email: string;
          emailVerified: boolean;
          name: string;
          createdAt: Date;
          updatedAt: Date;
          phoneNumberVerified?: boolean | null;
        }>({ model: 'user', where: [{ field: 'phoneNumber', value: phone }] });
        if (user && !user.phoneNumberVerified) return failure('INVALID_OTP');
        if (!user)
          user = await ctx.context.internalAdapter.createUser(
            {
              email: `phone-${randomUUID()}@${domain}`,
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
