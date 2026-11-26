import { timingSafeEqual } from 'node:crypto';
import { epochMs } from '@mio/foundation/time';
import type { BetterAuthPlugin, GenericEndpointContext } from 'better-auth';
import {
  APIError,
  createAuthEndpoint,
  getAuthoritativeSessionFromCtx,
  getIP,
} from 'better-auth/api';
import type { Pool } from 'pg';
import { isSixDigitCode, parsePhoneInput } from './phone.ts';
import type { PhoneSmsPolicy, PhoneSmsRuntime } from './phone.ts';
import type { PhoneLimits } from './phone-budget.ts';
import {
  activatePhoneChallenge,
  consumePhoneRebindChallenge,
  reservePhoneRebindChallenge,
} from './phone-store.ts';

function fail(code: string): never {
  const status =
    code === 'SESSION_REQUIRED'
      ? 'UNAUTHORIZED'
      : code === 'PHONE_CONFLICT' || code === 'PHONE_REQUIRED'
        ? 'CONFLICT'
        : code === 'SMS_RATE_LIMITED'
          ? 'TOO_MANY_REQUESTS'
          : code === 'INVALID_OTP'
            ? 'BAD_REQUEST'
            : 'SERVICE_UNAVAILABLE';
  const exposed = [
    'SESSION_REQUIRED',
    'PHONE_CONFLICT',
    'PHONE_REQUIRED',
    'SMS_RATE_LIMITED',
    'INVALID_OTP',
  ].includes(code)
    ? code
    : 'SMS_UNAVAILABLE';
  throw new APIError(status, { code: exposed, message: exposed });
}

async function recentSession(ctx: GenericEndpointContext) {
  const current = await getAuthoritativeSessionFromCtx(ctx);
  if (!current || epochMs() - current.session.createdAt.getTime() >= 600_000)
    return fail('SESSION_REQUIRED');
  return { userId: current.user.id, sessionId: current.session.id };
}

/** Account operations require a stored, session-scoped challenge even in bypass mode. */
export function phoneRebindPlugin(
  config: { secret: string; smsLimits: PhoneLimits },
  pool: Pool,
  sms: PhoneSmsRuntime | undefined,
  getPolicy: (() => PhoneSmsPolicy) | undefined,
): BetterAuthPlugin {
  const policy = getPolicy ?? (() => ({ smsMode: 'live' as const, smsBypassCode: null }));
  return {
    id: 'mio-phone-rebind',
    endpoints: {
      sendPhoneRebindOTP: createAuthEndpoint(
        '/phone-rebind/send-otp',
        { method: 'POST' },
        async (ctx) => {
          const { phone } = parsePhoneInput(ctx.body, false);
          const binding = await recentSession(ctx);
          const current = policy();
          if (
            current.smsMode === 'disabled' ||
            (current.smsMode === 'live' && !sms) ||
            (current.smsMode === 'bypass' && !isSixDigitCode(current.smsBypassCode))
          )
            return fail('SMS_UNAVAILABLE');
          const ip = ctx.headers ? getIP(ctx.headers, ctx.context.options) : null;
          if (!ip) return fail('SMS_UNAVAILABLE');
          try {
            const challenge = await reservePhoneRebindChallenge(
              pool,
              sms?.tables,
              config.secret,
              config.smsLimits,
              phone,
              ip,
              binding,
              current.smsMode === 'bypass' ? current.smsBypassCode! : undefined,
            );
            if (current.smsMode === 'live') await sms!.sender(phone, challenge.code);
            if (!(await activatePhoneChallenge(pool, challenge.id))) return fail('SMS_UNAVAILABLE');
          } catch (error) {
            return fail(error instanceof Error ? error.message : 'SMS_UNAVAILABLE');
          }
          return ctx.json({ status: true, expiresIn: 300 });
        },
      ),
      confirmPhoneRebind: createAuthEndpoint(
        '/phone-rebind/confirm',
        { method: 'POST' },
        async (ctx) => {
          const { phone, code } = parsePhoneInput(ctx.body, true);
          const binding = await recentSession(ctx);
          const current = policy();
          if (
            current.smsMode === 'disabled' ||
            (current.smsMode === 'live' && !sms) ||
            (current.smsMode === 'bypass' && !isSixDigitCode(current.smsBypassCode))
          )
            return fail('SMS_UNAVAILABLE');
          if (
            current.smsMode === 'bypass' &&
            !timingSafeEqual(Buffer.from(code), Buffer.from(current.smsBypassCode!))
          )
            return fail('INVALID_OTP');
          try {
            const result = await consumePhoneRebindChallenge(
              pool,
              config.secret,
              phone,
              code,
              binding,
            );
            if (result !== 'ok')
              return fail(
                result === 'session'
                  ? 'SESSION_REQUIRED'
                  : result === 'conflict'
                    ? 'PHONE_CONFLICT'
                    : 'INVALID_OTP',
              );
          } catch (error) {
            if (error instanceof APIError) throw error;
            return fail('SMS_UNAVAILABLE');
          }
          return ctx.json({ status: true });
        },
      ),
    },
  };
}
