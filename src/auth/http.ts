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

export type AvatarAssetStatus = 'ok' | 'not_found' | 'not_ready' | 'invalid_type' | 'unavailable';
export type AvatarAssetVerifier = (
  identity: { userId: string; sessionId: string },
  assetId: string,
) => Promise<AvatarAssetStatus>;

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
  ['/sign-in/social', 'POST'],
  ['/link-social', 'POST'],
  ['/callback/wechat', 'GET'],
  ['/wechat/qr-session', 'POST'],
  ['/onelink/start', 'POST'],
  ['/callback/onelink', 'GET'],
  ['/onelink/pending', 'GET'],
  ['/onelink/cancel', 'POST'],
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
  verifyAvatarAsset?: AvatarAssetVerifier,
): Promise<void> {
  if (request.method === 'GET') {
    const identity = await auth.identity(headers);
    if (!identity) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
    const profile = await auth.profile(identity.userId);
    if (!profile) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
    response.writeHead(HTTP_STATUS.OK, { 'content-type': 'application/json' });
    response.end(JSON.stringify(profile));
    return;
  }
  const body = await readJsonBody(request, AUTH_BODY_LIMIT_BYTES);
  const identity = await auth.identity(headers);
  if (!identity) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
  const patch = parseProfilePatch(body);
  if (!patch) return fail(HTTP_STATUS.BAD_REQUEST, 'INVALID_INPUT');
  if (patch.avatarAssetId) {
    if (!verifyAvatarAsset) return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE');
    const assetStatus = await verifyAvatarAsset(identity, patch.avatarAssetId);
    if (assetStatus === 'not_found') return fail(HTTP_STATUS.NOT_FOUND, 'ASSET_NOT_FOUND');
    if (assetStatus === 'not_ready') return fail(HTTP_STATUS.CONFLICT, 'ASSET_NOT_READY');
    if (assetStatus === 'invalid_type') return fail(HTTP_STATUS.BAD_REQUEST, 'INVALID_INPUT');
    if (assetStatus === 'unavailable')
      return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE');
  }
  const updated = await auth.updateProfile(identity.userId, patch);
  if (!updated) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
  response.writeHead(HTTP_STATUS.OK, { 'content-type': 'application/json' });
  response.end(JSON.stringify(updated));
}

function allowedMethodsFor(pathname: string, qrPoll: boolean): readonly string[] | undefined {
  if (pathname === '/api/v1/me' || qrPoll) return ['GET'];
  if (pathname === '/api/v1/me/profile') return ['GET', 'PATCH'];
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
    const isMutation = method === 'POST' || method === 'PATCH';
    if (isMutation && !origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
    if (isMutation && request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
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
      if (pathname === '/api/v1/me') {
        const identity = await auth.identity(headers);
        if (!identity) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
        response.writeHead(HTTP_STATUS.OK, { 'content-type': 'application/json' });
        response.end(JSON.stringify(identity));
        return;
      }
      if (pathname === '/api/v1/me/profile') {
        await handleProfileRequest(request, response, headers, auth, fail, verifyAvatarAsset);
        return;
      }
      let body =
        method === 'POST'
          ? (await readBody(request, AUTH_BODY_LIMIT_BYTES)).toString('utf8')
          : undefined;
      if (wechatRoute && !qrCreate && method === 'POST') {
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
