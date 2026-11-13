import { createHash } from 'node:crypto';
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import {
  APIError,
  addOAuthServerContext,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
  getOAuthState,
} from 'better-auth/api';
import { createWechatClient, wechatAccountId } from '../integrations/wechat.ts';
import type { WechatConfig } from '../integrations/wechat.ts';

const MAX_BINDING_AGE = 10 * 60_000;
const STATE_RESERVATION_AGE = 15 * 60_000;

function reject(code: string): never {
  throw new APIError('BAD_REQUEST', { code, message: 'WeChat authentication failed' });
}

/** Preserve the initial session in library-owned state and consume each browser-bound state once. */
export function wechatPlugin(config: WechatConfig | undefined, domain: string): BetterAuthPlugin {
  return {
    id: 'mio-wechat',
    schema: {
      account: {
        fields: {},
        indexes: [
          { fields: ['providerId', 'accountId'], unique: true },
          { fields: ['userId', 'providerId'], unique: true },
        ],
      },
    },
    init(context) {
      if (!config) return;
      const client = createWechatClient(config, domain);
      return {
        context: {
          socialProviders: context.socialProviders.map((provider) =>
            provider.id !== 'wechat'
              ? provider
              : {
                  ...provider,
                  validateAuthorizationCode: ({ code }) => client.exchangeCode(code),
                  getUserInfo: (tokens) => client.getUserInfo(tokens),
                  accountSubject: ({ tokens, profile }) => {
                    const openid = (tokens as { openid?: unknown }).openid;
                    if (
                      typeof openid !== 'string' ||
                      !openid ||
                      (profile as Record<string, unknown>).openid !== openid
                    )
                      throw new Error('WECHAT_UNAVAILABLE');
                    return wechatAccountId(config.appId, openid);
                  },
                },
          ),
        },
      };
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/link-social',
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getAuthoritativeSessionFromCtx(ctx);
            if (
              !session ||
              Date.now() - new Date(session.session.createdAt).getTime() >= MAX_BINDING_AGE
            )
              return reject('SESSION_REQUIRED');
            const accounts = await ctx.context.internalAdapter.findAccounts(session.user.id);
            if (accounts.some((account) => account.providerId === 'wechat'))
              return reject('WECHAT_ALREADY_BOUND');
            await addOAuthServerContext({
              mioWechatBinding: { userId: session.user.id, sessionId: session.session.id },
            });
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/callback/:id' && ctx.params?.id === 'wechat',
          handler: createAuthMiddleware(async (ctx) => {
            const state = ctx.query?.state;
            const cookie = ctx.context.createAuthCookie('state');
            const signedState = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
            if (typeof state !== 'string' || !state || state !== signedState)
              return reject('STATE_MISMATCH');
            const digest = createHash('sha256').update(state).digest('hex');
            const reserved = await ctx.context.internalAdapter.reserveVerificationValue({
              identifier: `mio-wechat-state:${digest}`,
              value: 'used',
              expiresAt: new Date(Date.now() + STATE_RESERVATION_AGE),
            });
            if (!reserved) return reject('STATE_REPLAY');
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

type ValidateUser = NonNullable<NonNullable<BetterAuthOptions['user']>['validateUserInfo']>;

/** A live initiating session is not enough if this browser switched to another session. */
export const validateWechatUser: ValidateUser = async ({ user, source }, ctx) => {
  if (source.method !== 'oauth' || source.oauth?.providerId !== 'wechat') return;
  const state = await getOAuthState();
  if (!state) return { error: 'STATE_MISMATCH' };
  if (!state.link) return;
  const binding = state.serverContext?.mioWechatBinding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding))
    return { error: 'SESSION_REQUIRED' };
  const expected = binding as { userId?: unknown; sessionId?: unknown };
  const current = await getAuthoritativeSessionFromCtx(ctx);
  if (
    !current ||
    current.user.id !== expected.userId ||
    current.session.id !== expected.sessionId ||
    current.user.id !== state.link.userId ||
    current.user.id !== user.id ||
    Date.now() - new Date(current.session.createdAt).getTime() >= MAX_BINDING_AGE
  )
    return { error: 'SESSION_REQUIRED' };
};
