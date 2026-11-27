import { sha256Utf8 } from '@mio/foundation/hash';
import { epochMs } from '@mio/foundation/time';
import { randomBytes } from 'node:crypto';
import { parseState } from 'better-auth';
import type { BetterAuthOptions, BetterAuthPlugin, GenericEndpointContext } from 'better-auth';
import {
  APIError,
  addOAuthServerContext,
  createAuthEndpoint,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { setTokenUtil } from 'better-auth/oauth2';
import type { Pool } from 'pg';
import { createWechatClient, wechatAccountId } from '../integrations/wechat.ts';
import type { WechatConfig } from '../integrations/wechat.ts';
import { admitWechatQR, finishWechatQR } from './wechat-qr-store.ts';
import { setWechatPendingCookie, wechatFailure } from './wechat-pending.ts';
import { validateNewProviderSession } from './login-methods.ts';
import { finishWechatAuthorization } from './wechat-store.ts';
import type { BindingIdentity } from './phone-store.ts';

export function wechatUnavailable(): never {
  return wechatFailure('AUTH_UNAVAILABLE');
}

function redirect(ctx: GenericEndpointContext, url: string, error?: string, pending = false) {
  const target = new URL(url);
  if (error) target.searchParams.set('error', error);
  if (pending) target.searchParams.set('wechat_result', 'choose_account');
  throw ctx.redirect(target.href);
}

async function originalBinding(
  ctx: GenericEndpointContext,
  state: Awaited<ReturnType<typeof parseState>>,
) {
  if (!state.link) return undefined;
  const expected = state.serverContext?.mioWechatBinding as Partial<BindingIdentity> | undefined;
  const current = await getAuthoritativeSessionFromCtx(ctx);
  if (
    !current ||
    !expected ||
    expected.userId !== current.user.id ||
    expected.sessionId !== current.session.id ||
    state.link.userId !== current.user.id ||
    epochMs() - current.session.createdAt.getTime() >= 600_000
  )
    return wechatFailure('SESSION_REQUIRED');
  return { userId: current.user.id, sessionId: current.session.id };
}

/** Library-owned authorization state, with explicit app-owned final account transactions. */
export function wechatPlugin(config: WechatConfig | undefined, pool: Pool): BetterAuthPlugin {
  const client = config && createWechatClient(config);
  return {
    id: 'mio-wechat',
    schema: {
      account: {
        fields: {
          wechatNickname: { type: 'string', required: false, input: false, returned: false },
        },
        indexes: [
          { fields: ['providerId', 'accountId'], unique: true },
          { fields: ['userId', 'providerId'], unique: true },
        ],
      },
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/sign-in/social' || ctx.path === '/link-social',
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.body?.provider !== 'wechat') return;
            const started = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now'))
              .rows[0]!.now;
            await addOAuthServerContext({ mioWechatStartedAt: started.toISOString() });
            if (ctx.path !== '/link-social') return;
            const current = await getAuthoritativeSessionFromCtx(ctx);
            if (!current || epochMs() - current.session.createdAt.getTime() >= 600_000)
              return wechatFailure('SESSION_REQUIRED');
            const accounts = await ctx.context.internalAdapter.findAccounts(current.user.id);
            if (accounts.some((account) => account.providerId === 'wechat'))
              return wechatFailure('WECHAT_ALREADY_BOUND');
            await addOAuthServerContext({
              mioWechatBinding: { userId: current.user.id, sessionId: current.session.id },
            });
          }),
        },
      ],
    },
    endpoints: {
      callbackWechat: createAuthEndpoint('/callback/wechat', { method: 'GET' }, async (ctx) => {
        if (!client || !config) return wechatFailure('WECHAT_UNAVAILABLE');
        const stateValue = ctx.query?.state,
          stateCookie = ctx.context.createAuthCookie('state');
        const signed = await ctx.getSignedCookie(stateCookie.name, ctx.context.secret);
        if (typeof stateValue !== 'string' || !stateValue || stateValue !== signed)
          return wechatFailure('STATE_MISMATCH');
        const digest = sha256Utf8(stateValue);
        const reserved = await ctx.context.internalAdapter.reserveVerificationValue({
          identifier: `mio-wechat-state:${digest}`,
          value: 'used',
          expiresAt: new Date(epochMs() + 900_000),
        });
        if (!reserved) return wechatFailure('STATE_REPLAY');
        const qr = await admitWechatQR(pool, digest).catch(wechatUnavailable);
        if (qr && 'error' in qr) return wechatFailure(qr.error);
        const state = await parseState(ctx);
        const rawStart = state.serverContext?.mioWechatStartedAt;
        const startedAt = typeof rawStart === 'string' ? new Date(rawStart) : null;
        if (!startedAt || !Number.isFinite(startedAt.getTime()))
          return wechatFailure('STATE_MISMATCH');
        const expiresAt = new Date(
          Math.min(state.expiresAt, qr ? qr.expiresAt.getTime() : Infinity),
        );
        if (ctx.query?.error || typeof ctx.query?.code !== 'string' || !ctx.query.code) {
          if (qr) await finishWechatQR(pool, qr.id);
          return redirect(ctx, state.errorURL ?? state.callbackURL, 'WECHAT_AUTH_FAILED');
        }
        let binding: BindingIdentity | undefined;
        try {
          binding = await originalBinding(ctx, state);
        } catch (error) {
          if (error instanceof APIError) {
            if (qr) await finishWechatQR(pool, qr.id);
            return redirect(ctx, state.errorURL ?? state.callbackURL, 'SESSION_REQUIRED');
          }
          throw error;
        }
        let result: Awaited<ReturnType<typeof finishWechatAuthorization>>;
        const cookieValue = randomBytes(32).toString('hex');
        try {
          const tokens = await client.exchangeCode(ctx.query.code),
            profile = await client.getUserInfo(tokens);
          const rawName = profile.data.nickname;
          const nickname =
            typeof rawName === 'string' && rawName.trim() && !/[\u0000-\u001f\u007f]/.test(rawName)
              ? rawName.trim()
              : null;
          result = await finishWechatAuthorization(pool, {
            credentials: {
              accountId: wechatAccountId(config.appId, tokens.openid),
              nickname,
              image: profile.user.image ?? null,
              accessToken: (await setTokenUtil(tokens.accessToken, ctx.context))!,
              refreshToken: (await setTokenUtil(tokens.refreshToken, ctx.context)) ?? null,
              accessTokenExpiresAt: tokens.accessTokenExpiresAt,
              scope: tokens.scopes.join(','),
            },
            startedAt,
            expiresAt,
            tokenDigest: sha256Utf8(cookieValue),
            candidateToken: randomBytes(24).toString('hex'),
            ...(binding ? { binding } : {}),
          });
        } catch (error) {
          if (error instanceof APIError) throw error;
          if (qr) await finishWechatQR(pool, qr.id);
          return redirect(ctx, state.errorURL ?? state.callbackURL, 'WECHAT_AUTH_FAILED');
        }
        if ('error' in result) {
          if (qr) await finishWechatQR(pool, qr.id);
          return redirect(ctx, state.errorURL ?? state.callbackURL, result.error);
        }
        if ('pendingId' in result) {
          setWechatPendingCookie(ctx, cookieValue);
          if (qr) await finishWechatQR(pool, qr.id, undefined, result.pendingId);
          return redirect(ctx, state.callbackURL, undefined, true);
        }
        if (!binding) {
          const session = await ctx.context.internalAdapter.createSession(result.user.id);
          if (!session) return wechatUnavailable();
          if (
            !(await validateNewProviderSession(pool, {
              userId: result.user.id,
              sessionId: session.id,
              provider: 'wechat',
              subject: result.subject,
              startedAt: result.startedAt,
              expiresAt: result.expiresAt,
            }))
          ) {
            if (qr) await finishWechatQR(pool, qr.id);
            return redirect(ctx, state.errorURL ?? state.callbackURL, 'STATE_REPLAY');
          }
          await setSessionCookie(ctx, { session, user: result.user });
        }
        if (qr) await finishWechatQR(pool, qr.id, result.user.id);
        return redirect(ctx, state.callbackURL);
      }),
    },
  };
}

type ValidateUser = NonNullable<NonNullable<BetterAuthOptions['user']>['validateUserInfo']>;
/** No library provisioning shortcut may bypass the explicit WeChat callback and confirmation. */
export const validateWechatUser: ValidateUser = async ({ source }) =>
  source.method === 'oauth' && source.oauth?.providerId === 'wechat'
    ? { error: 'WECHAT_CALLBACK_REQUIRED' }
    : undefined;
