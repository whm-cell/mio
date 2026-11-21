import { sha256Utf8 } from '@mio/foundation/hash';
import { isUuidV4 } from '@mio/foundation/identifiers';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, getSession, signInSocial } from 'better-auth/api';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { wechatCallbackURL } from './wechat-input.ts';
import {
  correlateWechatQR,
  pollWechatQR,
  reserveWechatQR,
  wechatQRSchema,
} from './wechat-qr-store.ts';
import { wechatUnavailable } from './wechat.ts';

function fail(code: 'NOT_FOUND' | 'STATE_MISMATCH' | 'UNAUTHORIZED' | 'INVALID_INPUT'): never {
  throw new APIError(
    code === 'NOT_FOUND' ? 'NOT_FOUND' : code === 'UNAUTHORIZED' ? 'UNAUTHORIZED' : 'BAD_REQUEST',
    { code, message: code },
  );
}

/** QR endpoints observe the ordinary OAuth session; they never issue their own login credentials. */
export function wechatQRPlugin(baseURL: string, pool: Pool): BetterAuthPlugin {
  return {
    id: 'mio-wechat-qr',
    schema: wechatQRSchema,
    endpoints: {
      createWechatQR: createAuthEndpoint('/wechat/qr-session', { method: 'POST' }, async (ctx) => {
        if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body))
          return fail('INVALID_INPUT');
        const body = ctx.body as Record<string, unknown>;
        const callbackURL = wechatCallbackURL(
          body.callbackURL,
          baseURL,
          '/auth/wechat/qr-complete',
        );
        if (
          Object.keys(body).some((key) => key !== 'callbackURL') ||
          !callbackURL ||
          ('callbackURL' in body && typeof body.callbackURL !== 'string')
        )
          return fail('INVALID_INPUT');
        const cookieValue = randomBytes(32).toString('hex');
        try {
          const id = await reserveWechatQR(pool, sha256Utf8(cookieValue));
          const { headers, response } = await signInSocial()({
            context: ctx.context,
            headers: ctx.headers ?? new Headers(),
            body: {
              provider: 'wechat',
              callbackURL,
              errorCallbackURL: callbackURL,
              disableRedirect: true,
            },
            asResponse: false,
            returnHeaders: true,
            returnStatus: false,
          });
          const state = response.url && new URL(response.url).searchParams.get('state');
          if (!state) throw new Error('QR_UNAVAILABLE');
          await correlateWechatQR(pool, id, sha256Utf8(state));
          for (const cookie of headers.getSetCookie())
            ctx.responseHeaders.append('set-cookie', cookie);
          const cookie = ctx.context.createAuthCookie('wechat_qr', {
            maxAge: 900,
            path: `${new URL(ctx.context.baseURL).pathname}/wechat/qr-session/${id}/poll`,
          });
          ctx.setCookie(cookie.name, cookieValue, cookie.attributes);
          ctx.setStatus(201);
          return ctx.json({ qrcode_id: id, authorization_url: response.url!, expire_seconds: 300 });
        } catch {
          return wechatUnavailable();
        }
      }),
      pollWechatQR: createAuthEndpoint(
        '/wechat/qr-session/:qrcodeId/poll',
        { method: 'GET' },
        async (ctx) => {
          const id = ctx.params.qrcodeId;
          if (!isUuidV4(id)) return fail('NOT_FOUND');
          const cookie = ctx.context.createAuthCookie('wechat_qr');
          const cookieValue = ctx.getCookie(cookie.name);
          const result = await pollWechatQR(pool, id, sha256Utf8(cookieValue ?? ''), async () => {
            const identity = await getSession()({
              context: ctx.context,
              headers: ctx.headers ?? new Headers(),
              query: { disableCookieCache: true, disableRefresh: true },
              asResponse: false,
            });
            return identity
              ? { userId: identity.user.id, sessionId: identity.session.id }
              : undefined;
          }).catch(wechatUnavailable);
          if ('error' in result) return fail(result.error);
          return ctx.json(result);
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
