import { HTTP_STATUS } from '@mio/foundation/http-status';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody } from '../http-request.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { AUTH_BASE_PATH } from './config.ts';
import type { AuthConfig } from './config.ts';
import type { Authentication } from './service.ts';
import { wechatCallbackURL } from './wechat-input.ts';

const AUTH_BODY_LIMIT_BYTES = 16 * 1024;

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

/** Bound browser-facing auth endpoints; future provider/plugin routes are not exposed implicitly. */
export function createAuthHandler(config: AuthConfig, auth: Authentication) {
  const allowed = new Set(config.origins);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = startHttpResponse(response);
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
    const pathname = (request.url ?? '').split('?')[0]!;
    const qrCreate = pathname === `${AUTH_BASE_PATH}/wechat/qr-session`;
    const qrPoll = /^\/api\/auth\/wechat\/qr-session\/[0-9a-f-]{36}\/poll$/.test(pathname);
    const wechatRoute =
      [
        `${AUTH_BASE_PATH}/sign-in/social`,
        `${AUTH_BASE_PATH}/link-social`,
        `${AUTH_BASE_PATH}/callback/wechat`,
      ].includes(pathname) ||
      qrCreate ||
      qrPoll;
    const method =
      pathname === '/api/v1/me' || qrPoll
        ? 'GET'
        : routes.get(pathname.slice(AUTH_BASE_PATH.length));
    if (!method) return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
    if (request.method === 'OPTIONS') {
      if (!origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
      response.writeHead(HTTP_STATUS.NO_CONTENT, {
        'access-control-allow-methods': `${method}, OPTIONS`,
        'access-control-allow-headers': 'Content-Type',
      });
      response.end();
      return;
    }
    if (request.method !== method) {
      response.setHeader('allow', `${method}, OPTIONS`);
      return fail(HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED');
    }
    if (method === 'POST' && !origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
    if (
      method === 'POST' &&
      request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json'
    )
      return fail(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, 'JSON_REQUIRED');
    if (wechatRoute && !config.wechat)
      return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'WECHAT_UNAVAILABLE');
    try {
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
      let body =
        method === 'POST'
          ? (await readBody(request, AUTH_BODY_LIMIT_BYTES)).toString('utf8')
          : undefined;
      if (wechatRoute && !qrCreate && method === 'POST') {
        body = wechatStartBody(body!, config.baseURL);
        if (!body) return fail(HTTP_STATUS.BAD_REQUEST, 'INVALID_INPUT');
      }
      const result = await auth.handler(
        new Request(`${config.baseURL}${request.url}`, {
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
