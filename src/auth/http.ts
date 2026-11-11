import type { IncomingMessage, ServerResponse } from 'node:http';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { AUTH_BASE_PATH } from './config.ts';
import type { AuthConfig } from './config.ts';
import type { Authentication } from './service.ts';

const AUTH_BODY_LIMIT_BYTES = 16 * 1024;
const AUTH_BODY_TIMEOUT_MS = 10_000;

const routes = new Map([
  ['/sign-up/email', 'POST'],
  ['/sign-in/email', 'POST'],
  ['/sign-out', 'POST'],
  ['/get-session', 'GET'],
  ['/change-password', 'POST'],
  ['/list-sessions', 'GET'],
  ['/revoke-session', 'POST'],
  ['/revoke-sessions', 'POST'],
  ['/revoke-other-sessions', 'POST'],
]);

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('error', fail);
      request.off('aborted', aborted);
      if (error) {
        request.resume();
        reject(error);
      } else resolve(Buffer.concat(chunks));
    };
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > AUTH_BODY_LIMIT_BYTES) finish(new Error('BODY_TOO_LARGE'));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const fail = () => finish(new Error('BODY_INVALID'));
    const aborted = () => finish(new Error('BODY_INVALID'));
    const timer = setTimeout(() => finish(new Error('BODY_TIMEOUT')), AUTH_BODY_TIMEOUT_MS);
    request.on('data', data).once('end', end).once('error', fail).once('aborted', aborted);
  });
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
    if (origin !== undefined && !allowed.has(origin)) return fail(403, 'ORIGIN_DENIED');
    if (origin !== undefined) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('access-control-allow-credentials', 'true');
      response.setHeader('vary', 'Origin');
    }
    const pathname = (request.url ?? '').split('?')[0]!;
    const method =
      pathname === '/api/v1/me' ? 'GET' : routes.get(pathname.slice(AUTH_BASE_PATH.length));
    if (!method) return fail(404, 'NOT_FOUND');
    if (request.method === 'OPTIONS') {
      if (!origin) return fail(403, 'ORIGIN_REQUIRED');
      response.writeHead(204, {
        'access-control-allow-methods': `${method}, OPTIONS`,
        'access-control-allow-headers': 'Content-Type',
      });
      response.end();
      return;
    }
    if (request.method !== method) {
      response.setHeader('allow', `${method}, OPTIONS`);
      return fail(405, 'METHOD_NOT_ALLOWED');
    }
    if (method === 'POST' && !origin) return fail(403, 'ORIGIN_REQUIRED');
    if (
      method === 'POST' &&
      request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json'
    )
      return fail(415, 'JSON_REQUIRED');
    try {
      const headers = new Headers();
      for (const name of ['cookie', 'origin', 'content-type', 'user-agent'] as const) {
        const value = request.headers[name];
        if (value !== undefined) headers.set(name, value);
      }
      headers.set('x-mio-client-ip', request.socket.remoteAddress ?? '127.0.0.1');
      if (pathname === '/api/v1/me') {
        const identity = await auth.identity(headers);
        if (!identity) return fail(401, 'UNAUTHORIZED');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(identity));
        return;
      }
      const body = method === 'POST' ? (await readBody(request)).toString('utf8') : undefined;
      const result = await auth.handler(
        new Request(`${config.baseURL}${request.url}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      );
      for (const [name, value] of result.headers)
        if (!['set-cookie', 'cache-control'].includes(name)) response.setHeader(name, value);
      const cookies = result.headers.getSetCookie();
      if (cookies.length) response.setHeader('set-cookie', cookies);
      response.statusCode = result.status;
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      if (response.writableEnded) return;
      const code = error instanceof Error ? error.message : '';
      fail(
        code === 'BODY_TOO_LARGE'
          ? 413
          : code === 'BODY_TIMEOUT'
            ? 408
            : code === 'BODY_INVALID'
              ? 400
              : 503,
        code.startsWith('BODY_') ? code : 'AUTH_UNAVAILABLE',
      );
    }
  };
}
