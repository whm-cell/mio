import { timingSafeEqual } from 'node:crypto';
import { sha256Utf8 } from '@mio/foundation/hash';
import { epochMs } from '@mio/foundation/time';
import type { BetterAuthPlugin, GenericEndpointContext } from 'better-auth';
import {
  APIError,
  createAuthEndpoint,
  getAuthoritativeSessionFromCtx,
  getIP,
} from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { Pool } from 'pg';
import { isSixDigitCode, normalizeMainlandPhone, parsePhoneInput } from './phone.ts';
import type { PhoneSmsPolicy, PhoneSmsRuntime } from './phone.ts';
import type { PhoneLimits } from './phone-budget.ts';
import { activatePhoneChallenge, reserveWechatExistingPhoneChallenge } from './phone-store.ts';
import { validateNewProviderSession } from './login-methods.ts';
import { finishWechatQR } from './wechat-qr-store.ts';
import { confirmWechatPending, readWechatPending, wechatPendingSchema } from './wechat-store.ts';

export function wechatFailure(code: string): never {
  const status = ['AUTH_UNAVAILABLE', 'SMS_UNAVAILABLE', 'WECHAT_UNAVAILABLE'].includes(code)
    ? 'SERVICE_UNAVAILABLE'
    : code === 'ACCOUNT_DISABLED'
      ? 'FORBIDDEN'
      : code === 'SESSION_REQUIRED'
        ? 'UNAUTHORIZED'
        : code.endsWith('NOT_FOUND')
          ? 'NOT_FOUND'
          : code === 'SMS_RATE_LIMITED'
            ? 'TOO_MANY_REQUESTS'
            : code === 'WECHAT_ALREADY_BOUND' || code === 'WECHAT_PENDING_ALREADY_COMPLETED'
              ? 'CONFLICT'
              : 'BAD_REQUEST';
  throw new APIError(status, { code, message: code });
}

export function readWechatPendingCookie(ctx: GenericEndpointContext) {
  return ctx.getCookie(ctx.context.createAuthCookie('wechat_pending').name);
}

export function setWechatPendingCookie(ctx: GenericEndpointContext, value: string) {
  const cookie = ctx.context.createAuthCookie('wechat_pending', {
    path: new URL(ctx.context.baseURL).pathname,
    maxAge: value ? 900 : 0,
  });
  ctx.setCookie(cookie.name, value, cookie.attributes);
}

async function pending(ctx: GenericEndpointContext, pool: Pool) {
  const cookie = readWechatPendingCookie(ctx);
  const row = cookie ? await readWechatPending(pool, sha256Utf8(cookie)) : null;
  if (!row || row.expired || row.status !== 'candidate_ready')
    return wechatFailure('WECHAT_PENDING_NOT_FOUND');
  return row;
}

function completeInput(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return wechatFailure('INVALID_INPUT');
  const input = body as Record<string, unknown>;
  if (
    (input.action !== 'create' && input.action !== 'link_existing') ||
    typeof input.candidateToken !== 'string' ||
    !input.candidateToken
  )
    return wechatFailure('INVALID_INPUT');
  const withPhone = input.action === 'link_existing' && ('phoneNumber' in input || 'code' in input);
  const keys = withPhone
    ? ['action', 'candidateToken', 'phoneNumber', 'code']
    : ['action', 'candidateToken'];
  if (
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    return wechatFailure('INVALID_INPUT');
  const phone = withPhone ? normalizeMainlandPhone(input.phoneNumber) : undefined;
  if (withPhone && (!phone || !isSixDigitCode(input.code))) return wechatFailure('INVALID_INPUT');
  return {
    action: input.action as 'create' | 'link_existing',
    candidateToken: input.candidateToken,
    ...(phone ? { phone, code: input.code as string } : {}),
  };
}

/** Pending ownership survives a normal target-account login, but never establishes an identity by itself. */
export function wechatPendingPlugin(
  config: { secret: string; smsLimits: PhoneLimits },
  pool: Pool,
  sms: PhoneSmsRuntime | undefined,
  domain: string,
  getPolicy?: () => PhoneSmsPolicy,
): BetterAuthPlugin {
  const policy = getPolicy ?? (() => ({ smsMode: 'live' as const, smsBypassCode: null }));
  return {
    id: 'mio-wechat-pending',
    schema: wechatPendingSchema,
    endpoints: {
      pendingWechat: createAuthEndpoint('/wechat/pending', { method: 'GET' }, async (ctx) => {
        const row = await pending(ctx, pool);
        return ctx.json({
          status: 'candidate_ready',
          candidateToken: row.candidateToken,
          wechatNickname: row.nickname,
          expiresAt: row.expiresAt.toISOString(),
        });
      }),
      sendWechatExistingOTP: createAuthEndpoint(
        '/wechat/pending/send-otp',
        { method: 'POST' },
        async (ctx) => {
          const { phone } = parsePhoneInput(ctx.body, false),
            row = await pending(ctx, pool),
            current = policy();
          if (
            current.smsMode === 'disabled' ||
            (current.smsMode === 'live' && !sms) ||
            (current.smsMode === 'bypass' && !isSixDigitCode(current.smsBypassCode))
          )
            return wechatFailure('SMS_UNAVAILABLE');
          const ip = ctx.headers ? getIP(ctx.headers, ctx.context.options) : null;
          if (!ip) return wechatFailure('SMS_UNAVAILABLE');
          try {
            const challenge = await reserveWechatExistingPhoneChallenge(
              pool,
              sms?.tables,
              config.secret,
              config.smsLimits,
              phone,
              ip,
              { pendingId: row.id, candidateToken: row.candidateToken },
              current.smsMode === 'bypass' ? current.smsBypassCode! : undefined,
            );
            if (current.smsMode === 'live') await sms!.sender(phone, challenge.code);
            if (!(await activatePhoneChallenge(pool, challenge.id)))
              return wechatFailure('SMS_UNAVAILABLE');
          } catch (error) {
            return wechatFailure(
              error instanceof Error && error.message === 'SMS_RATE_LIMITED'
                ? error.message
                : 'SMS_UNAVAILABLE',
            );
          }
          return ctx.json({ status: true, expiresIn: 300 });
        },
      ),
      confirmWechat: createAuthEndpoint(
        '/wechat/pending/confirm',
        { method: 'POST' },
        async (ctx) => {
          const input = completeInput(ctx.body),
            cookie = readWechatPendingCookie(ctx);
          if (!cookie) return wechatFailure('WECHAT_PENDING_NOT_FOUND');
          let session: { userId: string; sessionId: string } | undefined;
          if (input.action === 'link_existing' && !input.phone) {
            const current = await getAuthoritativeSessionFromCtx(ctx);
            if (!current || epochMs() - current.session.createdAt.getTime() >= 600_000)
              return wechatFailure('SESSION_REQUIRED');
            session = { userId: current.user.id, sessionId: current.session.id };
          }
          if (input.phone) {
            const current = policy();
            if (
              current.smsMode === 'disabled' ||
              (current.smsMode === 'live' && !sms) ||
              (current.smsMode === 'bypass' && !isSixDigitCode(current.smsBypassCode))
            )
              return wechatFailure('SMS_UNAVAILABLE');
            if (
              current.smsMode === 'bypass' &&
              !timingSafeEqual(Buffer.from(input.code!), Buffer.from(current.smsBypassCode!))
            )
              return wechatFailure('INVALID_OTP');
          }
          const result = await confirmWechatPending(pool, {
            ...input,
            tokenDigest: sha256Utf8(cookie),
            secret: config.secret,
            domain,
            ...(session ? { session } : {}),
          });
          if ('error' in result) return wechatFailure(result.error);
          let issued;
          try {
            issued = await ctx.context.internalAdapter.createSession(result.user.id);
            if (!issued) return wechatFailure('AUTH_UNAVAILABLE');
            if (
              !(await validateNewProviderSession(pool, {
                userId: result.user.id,
                sessionId: issued.id,
                provider: 'wechat',
                subject: result.subject,
                startedAt: result.startedAt,
                expiresAt: result.expiresAt,
              }))
            )
              return wechatFailure('WECHAT_PENDING_INVALID');
          } catch (error) {
            if (result.qrcodeId) await finishWechatQR(pool, result.qrcodeId);
            if (error instanceof APIError) throw error;
            return wechatFailure('AUTH_UNAVAILABLE');
          }
          if (result.qrcodeId) await finishWechatQR(pool, result.qrcodeId, result.user.id);
          await setSessionCookie(ctx, { session: issued, user: result.user });
          setWechatPendingCookie(ctx, '');
          return ctx.json({ status: true, action: input.action, userId: result.user.id });
        },
      ),
    },
  };
}
