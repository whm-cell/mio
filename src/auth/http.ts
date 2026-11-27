import { HttpError } from '@mio/foundation/errors';
import { isUuidV4 } from '@mio/foundation/identifiers';
import type { ProfileRecord } from './account.ts';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, readJsonBody } from '../http-request.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { parseProfilePatch } from './account.ts';
import { AUTH_BASE_PATH } from './config.ts';
import type { AuthConfig, AuthPolicyReader } from './config.ts';
import type { Authentication } from './service.ts';
import { wechatCallbackURL } from './wechat-input.ts';

type AvatarAssetStatus = 'ok' | 'not_found' | 'not_ready' | 'invalid_type' | 'unavailable';
type AvatarAssetVerifier = (
  identity: { userId: string; sessionId: string },
  assetId: string,
) => Promise<AvatarAssetStatus>;

interface AvatarCallbacks {
  accountDeleted?: (userId: string, finalizedAt: string) => void;
  avatarChanged?: (userId: string) => Promise<void>;
  avatarUrl?: (
    identity: { userId: string; sessionId: string },
    assetId: string,
  ) => Promise<string | null>;
  normalizeAvatar?: (
    identity: { userId: string; sessionId: string },
    sourceAssetId: string,
  ) => Promise<{ avatarAssetId: string }>;
}

async function profileResponse(
  profile: ProfileRecord,
  identity: { userId: string; sessionId: string },
  display: boolean,
  callbacks: AvatarCallbacks,
) {
  const { wechatNickname, ...legacy } = profile;
  if (!display) return legacy;
  let avatarUrl: string | null = null;
  if (profile.avatarAssetId) {
    try {
      avatarUrl = (await callbacks.avatarUrl?.(identity, profile.avatarAssetId)) ?? null;
    } catch {
      /* Media failures cannot block profile reads or a successful profile write. */
    }
  }
  const phone = profile.phoneNumber;
  return {
    userId: profile.userId,
    displayId: profile.displayId ?? profile.userId,
    name: profile.name,
    avatarAssetId: profile.avatarAssetId,
    avatarUrl,
    maskedPhoneNumber: phone
      ? /^\+86\d{11}$/.test(phone)
        ? `${phone.slice(0, -8)}****${phone.slice(-4)}`
        : '****'
      : null,
    phoneNumberVerified: profile.phoneNumberVerified,
    wechatBound: profile.wechatBound,
    wechatNickname: profile.wechatBound ? (wechatNickname ?? '已绑定') : null,
    onelinkBound: profile.onelinkBound,
  };
}

const AUTH_BODY_LIMIT_BYTES = 16 * 1024;
const WECHAT_BRIDGE_PARAM = 'mio_bridge';
const WECHAT_BRIDGE_STATE_MAX_LENGTH = 512;
const BRIDGE_SCRIPT =
  'const u=new URL(location.href);u.searchParams.set("mio_bridge","1");location.replace(u.href);';
const BRIDGE_BODY = Buffer.from(
  `<!doctype html><meta charset="utf-8"><script>${BRIDGE_SCRIPT}</script>`,
);
const BRIDGE_CSP = `default-src 'none'; script-src 'sha256-${createHash('sha256').update(BRIDGE_SCRIPT).digest('base64')}'; frame-ancestors 'self'`;

const emailPasswordPaths = new Set([
  `${AUTH_BASE_PATH}/sign-up/email`,
  `${AUTH_BASE_PATH}/sign-in/email`,
  `${AUTH_BASE_PATH}/change-password`,
]);

const routes = new Map([
  ['/sign-up/email', 'POST'],
  ['/sign-in/email', 'POST'],
  ['/phone-number/send-otp', 'POST'],
  ['/phone-number/verify', 'POST'],
  ['/phone-binding/send-otp', 'POST'],
  ['/phone-binding/confirm', 'POST'],
  ['/phone-rebind/send-otp', 'POST'],
  ['/phone-rebind/confirm', 'POST'],
  ['/account-deletion/send-otp', 'POST'],
  ['/sign-in/social', 'POST'],
  ['/link-social', 'POST'],
  ['/callback/wechat', 'GET'],
  ['/wechat/qr-session', 'POST'],
  ['/wechat/pending', 'GET'],
  ['/wechat/pending/send-otp', 'POST'],
  ['/wechat/pending/confirm', 'POST'],
  ['/onelink/start', 'POST'],
  ['/callback/onelink', 'GET'],
  ['/onelink/pending', 'GET'],
  ['/onelink/cancel', 'POST'],
  ['/onelink/existing/send-otp', 'POST'],
  ['/onelink/complete', 'POST'],
  ['/sign-out', 'POST'],
  ['/get-session', 'GET'],
  ['/change-password', 'POST'],
  ['/list-sessions', 'GET'],
  ['/revoke-session', 'POST'],
  ['/revoke-sessions', 'POST'],
  ['/revoke-other-sessions', 'POST'],
]);

function wechatStartBody(raw: string, origin: string) {
  try {
    const input: unknown = JSON.parse(raw);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    const body = input as Record<string, unknown>;
    if (
      body.provider !== 'wechat' ||
      Object.keys(body).some((key) => !['provider', 'callbackURL'].includes(key))
    )
      return;
    const callbackURL = wechatCallbackURL(body.callbackURL, origin, '/');
    if (!callbackURL) return;
    return JSON.stringify({
      provider: 'wechat',
      callbackURL,
      errorCallbackURL: callbackURL,
      disableRedirect: true,
    });
  } catch {
    return;
  }
}

function hasNonEmptyCookie(header: string | undefined, name: string): boolean {
  if (!header) return false;
  for (const segment of header.split(';')) {
    const trimmed = segment.trim();
    const separator = trimmed.indexOf('=');
    if (
      separator > 0 &&
      trimmed.slice(0, separator) === name &&
      trimmed.slice(separator + 1).length > 0
    )
      return true;
  }
  return false;
}

async function handleProfileRequest(
  request: IncomingMessage,
  response: ServerResponse,
  headers: Headers,
  auth: Authentication,
  fail: (status: number, code: string) => void,
  verifyAvatarAsset: AvatarAssetVerifier | undefined,
  callbacks: AvatarCallbacks,
): Promise<void> {
  const display =
    new URL(request.url ?? '/', 'http://mio.invalid').searchParams.get('view') === 'display';
  if (request.method === 'GET') {
    const identity = await auth.identity(headers);
    if (!identity) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
    const profile = await auth.profile(identity.userId);
    if (!profile) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
    response.writeHead(HTTP_STATUS.OK, { 'content-type': 'application/json' });
    response.end(JSON.stringify(await profileResponse(profile, identity, display, callbacks)));
    return;
  }
  const body = await readJsonBody(request, AUTH_BODY_LIMIT_BYTES);
  const identity = await auth.identity(headers);
  if (!identity) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
  const patch = parseProfilePatch(body);
  if (!patch) return fail(HTTP_STATUS.BAD_REQUEST, 'INVALID_INPUT');
  if (patch.avatarAssetId) {
    if (!verifyAvatarAsset) return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE');
    const assetStatus = await verifyAvatarAsset(identity, patch.avatarAssetId).catch(
      () => 'unavailable' as const,
    );
    if (assetStatus === 'not_found') return fail(HTTP_STATUS.NOT_FOUND, 'ASSET_NOT_FOUND');
    if (assetStatus === 'not_ready') return fail(HTTP_STATUS.CONFLICT, 'ASSET_NOT_READY');
    if (assetStatus === 'invalid_type') return fail(HTTP_STATUS.BAD_REQUEST, 'INVALID_INPUT');
    if (assetStatus === 'unavailable')
      return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE');
  }
  const updated = await auth.updateProfile(identity.userId, patch);
  if (!updated) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
  if (patch.avatarAssetId !== undefined) {
    // Auth commits independently. Background reconciliation recovers an unavailable media bridge.
    await callbacks.avatarChanged?.(identity.userId).catch(() => {});
  }
  response.writeHead(HTTP_STATUS.OK, { 'content-type': 'application/json' });
  response.end(JSON.stringify(await profileResponse(updated, identity, display, callbacks)));
}

function allowedMethodsFor(pathname: string, qrPoll: boolean): readonly string[] | undefined {
  if (pathname === '/api/v1/me') return ['GET', 'DELETE'];
  if (qrPoll) return ['GET'];
  if (pathname === '/api/v1/me/profile') return ['GET', 'PATCH'];
  if (pathname === '/api/v1/me/profile/avatar/normalize') return ['POST'];
  if (pathname === '/api/v1/me/wechat' || pathname === '/api/v1/me/onelink') return ['DELETE'];
  if (!pathname.startsWith(`${AUTH_BASE_PATH}/`)) return undefined;
  const method = routes.get(pathname.slice(AUTH_BASE_PATH.length));
  return method ? [method] : undefined;
}

/** Bound browser-facing auth endpoints; future provider/plugin routes are not exposed implicitly. */
export function createAuthHandler(
  config: AuthConfig,
  auth: Authentication,
  verifyAvatarAsset?: AvatarAssetVerifier,
  getPolicy?: AuthPolicyReader,
  avatarCallbacks: AvatarCallbacks = {},
) {
  const allowed = new Set(config.origins);
  const readPolicy: AuthPolicyReader =
    getPolicy ??
    (() => ({
      emailPasswordEnabled: config.emailPasswordEnabled,
      smsMode: 'live',
      smsBypassCode: null,
    }));
  const stateCookieName = config.baseURL.startsWith('https:') ? '__Secure-mio.state' : 'mio.state';
  const wechatCallbackPath = `${AUTH_BASE_PATH}/callback/wechat`;
  const oneLinkCallbackPath = `${AUTH_BASE_PATH}/callback/onelink`;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = startHttpResponse(response);
    const pathname = (request.url ?? '').split('?')[0]!;
    if (pathname === oneLinkCallbackPath) response.setHeader('referrer-policy', 'no-referrer');
    const fail = (status: number, code: string) => {
      writeApiError(response, status, { code, message: code, requestId }, 'application/json');
    };
    const origin = request.headers.origin;
    if (origin !== undefined && !allowed.has(origin))
      return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_DENIED');
    if (origin !== undefined) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('access-control-allow-credentials', 'true');
      response.setHeader('vary', 'Origin');
    }
    const qrCreate = pathname === `${AUTH_BASE_PATH}/wechat/qr-session`;
    const qrPoll =
      pathname.startsWith(`${AUTH_BASE_PATH}/`) &&
      /^\/wechat\/qr-session\/[0-9a-f-]{36}\/poll$/.test(pathname.slice(AUTH_BASE_PATH.length));
    const wechatRoute =
      [
        `${AUTH_BASE_PATH}/sign-in/social`,
        `${AUTH_BASE_PATH}/link-social`,
        wechatCallbackPath,
      ].includes(pathname) ||
      pathname.startsWith(`${AUTH_BASE_PATH}/wechat/pending`) ||
      qrCreate ||
      qrPoll;
    const allowedMethods = allowedMethodsFor(pathname, qrPoll);
    if (!allowedMethods) return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
    const allowHeader = `${allowedMethods.join(', ')}, OPTIONS`;
    if (request.method === 'OPTIONS') {
      if (!origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
      response.writeHead(HTTP_STATUS.NO_CONTENT, {
        'access-control-allow-methods': allowHeader,
        'access-control-allow-headers': 'Content-Type',
      });
      response.end();
      return;
    }
    const method = request.method;
    if (!method || !allowedMethods.includes(method)) {
      response.setHeader('allow', allowHeader);
      return fail(HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED');
    }
    const isMutation = method === 'POST' || method === 'PATCH' || method === 'DELETE';
    if (isMutation && !origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
    if (
      isMutation &&
      (method !== 'DELETE' || pathname === '/api/v1/me') &&
      request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json'
    )
      return fail(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, 'JSON_REQUIRED');
    if (emailPasswordPaths.has(pathname) && !readPolicy().emailPasswordEnabled)
      return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'EMAIL_PASSWORD_UNAVAILABLE');
    if (wechatRoute && !config.wechat)
      return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'WECHAT_UNAVAILABLE');
    try {
      let requestUrl = `${config.baseURL}${request.url}`;
      if (pathname === wechatCallbackPath) {
        const callbackUrl = new URL(request.url ?? '/', config.baseURL);
        const hasBridge = callbackUrl.searchParams.has(WECHAT_BRIDGE_PARAM);
        const state = callbackUrl.searchParams.get('state');
        if (
          !hasBridge &&
          request.headers['sec-fetch-dest'] === 'iframe' &&
          typeof state === 'string' &&
          state.length > 0 &&
          state.length <= WECHAT_BRIDGE_STATE_MAX_LENGTH &&
          !hasNonEmptyCookie(request.headers.cookie, stateCookieName)
        ) {
          response.writeHead(HTTP_STATUS.OK, {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': BRIDGE_CSP,
            'x-frame-options': 'SAMEORIGIN',
            'referrer-policy': 'no-referrer',
          });
          response.end(BRIDGE_BODY);
          return;
        }
        if (hasBridge) {
          callbackUrl.searchParams.delete(WECHAT_BRIDGE_PARAM);
          requestUrl = callbackUrl.href;
        }
      }
      const headers = new Headers();
      for (const name of ['cookie', 'origin', 'content-type', 'user-agent'] as const) {
        const value = request.headers[name];
        if (value !== undefined) headers.set(name, value);
      }
      headers.set('x-mio-client-ip', request.socket.remoteAddress ?? '127.0.0.1');
      if (pathname === '/api/v1/me/wechat' || pathname === '/api/v1/me/onelink') {
        const identity = await auth.identity(headers);
        if (!identity) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
        const result = await auth.unlinkLoginMethod(
          identity,
          pathname.endsWith('/wechat') ? 'wechat' : 'onelink',
        );
        if (result === 'session_required') return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
        if (result === 'last_login_method') return fail(HTTP_STATUS.CONFLICT, 'LAST_LOGIN_METHOD');
        response.writeHead(HTTP_STATUS.OK, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: true }));
        return;
      }
      if (pathname === '/api/v1/me') {
        const identity = await auth.identity(headers);
        if (!identity) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
        if (method === 'DELETE') {
          const body = await readJsonBody(request, AUTH_BODY_LIMIT_BYTES);
          const result = await auth.deleteAccount(identity, body);
          if (result.status === 'session_required')
            return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
          if (result.status !== 'ok')
            return fail(
              HTTP_STATUS.BAD_REQUEST,
              result.status === 'invalid_otp' ? 'INVALID_OTP' : 'INVALID_INPUT',
            );
          const secure = config.baseURL.startsWith('https:');
          response.setHeader(
            'set-cookie',
            `${secure ? '__Secure-' : ''}mio.session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
          );
          avatarCallbacks.accountDeleted?.(identity.userId, result.finalizedAt);
          response.writeHead(HTTP_STATUS.OK, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: true, finalizedAt: result.finalizedAt }));
          return;
        }
        response.writeHead(HTTP_STATUS.OK, { 'content-type': 'application/json' });
        response.end(JSON.stringify(identity));
        return;
      }
      if (pathname === '/api/v1/me/profile') {
        await handleProfileRequest(
          request,
          response,
          headers,
          auth,
          fail,
          verifyAvatarAsset,
          avatarCallbacks,
        );
        return;
      }
      if (pathname === '/api/v1/me/profile/avatar/normalize') {
        const body = await readJsonBody(request, AUTH_BODY_LIMIT_BYTES);
        const identity = await auth.identity(headers);
        if (!identity) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
        if (
          Object.keys(body).length !== 1 ||
          typeof body.sourceAssetId !== 'string' ||
          !isUuidV4(body.sourceAssetId)
        )
          return fail(HTTP_STATUS.BAD_REQUEST, 'INVALID_INPUT');
        if (!avatarCallbacks.normalizeAvatar)
          return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE');
        try {
          const result = await avatarCallbacks.normalizeAvatar(identity, body.sourceAssetId);
          response.writeHead(HTTP_STATUS.OK, { 'content-type': 'application/json' });
          response.end(JSON.stringify(result));
        } catch (error) {
          if (error instanceof HttpError) return fail(error.status, error.code);
          return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE');
        }
        return;
      }
      let body =
        method === 'POST'
          ? (await readBody(request, AUTH_BODY_LIMIT_BYTES)).toString('utf8')
          : undefined;
      if (
        [`${AUTH_BASE_PATH}/sign-in/social`, `${AUTH_BASE_PATH}/link-social`].includes(pathname) &&
        method === 'POST'
      ) {
        body = wechatStartBody(body!, config.baseURL);
        if (!body) return fail(HTTP_STATUS.BAD_REQUEST, 'INVALID_INPUT');
      }
      const result = await auth.handler(
        new Request(requestUrl, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      );
      const resultBody = Buffer.from(await result.arrayBuffer());
      for (const [name, value] of result.headers)
        if (!['set-cookie', 'cache-control'].includes(name)) response.setHeader(name, value);
      const cookies = result.headers.getSetCookie();
      if (cookies.length) response.setHeader('set-cookie', cookies);
      response.statusCode = result.status;
      response.end(resultBody);
    } catch (error) {
      if (response.writableEnded) return;
      const code = error instanceof Error ? error.message : '';
      fail(
        code === 'BODY_TOO_LARGE'
          ? HTTP_STATUS.PAYLOAD_TOO_LARGE
          : code === 'BODY_TIMEOUT'
            ? HTTP_STATUS.REQUEST_TIMEOUT
            : code === 'BODY_INVALID'
              ? HTTP_STATUS.BAD_REQUEST
              : HTTP_STATUS.SERVICE_UNAVAILABLE,
        code.startsWith('BODY_') ? code : 'AUTH_UNAVAILABLE',
      );
    }
  };
}
