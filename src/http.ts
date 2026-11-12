import { HTTP_STATUS } from '@mio/foundation/http-status';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '@mio/foundation/logging';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Capabilities } from './contracts.ts';
import { startHttpResponse, writeApiError } from './http-response.ts';

export interface HttpOptions {
  token: string;
  allowedOrigins: readonly string[];
  instanceId: string;
  sessions?: boolean;
}

/** Validate deployment configuration before claiming routes or reporting readiness. */
export function validateOptions(options: HttpOptions): void {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(options.token)) {
    throw new Error('MIO_API_TOKEN must contain at least 32 URL-safe characters');
  }
  for (const origin of options.allowedOrigins) {
    const url = new URL(origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error('allowedOrigins entries must be exact HTTP(S) origins');
    }
  }
}

/** Product HTTP boundary. Authentication does not come from model or request-body identity. */
export function createHandler(options: HttpOptions) {
  validateOptions(options);
  const log = createLogger('app', 'http');
  const expected = Buffer.from(`Bearer ${options.token}`);
  const allowedOrigins = new Set(options.allowedOrigins);

  return (request: IncomingMessage, response: ServerResponse): void => {
    const requestId = startHttpResponse(response);
    const send = (status: number, value: unknown): void => {
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify(value));
    };
    const fail = (status: number, code: string, message: string): void => {
      log.warn('HTTP_REQUEST_FAILED', { requestId });
      writeApiError(
        response,
        status,
        { code, message, requestId },
        'application/json; charset=utf-8',
      );
    };
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_DENIED', 'Origin is not allowed');
      return;
    }
    if (origin !== undefined) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
    }

    const path = request.url?.split('?')[0];
    if (!['/healthz', '/readyz', '/api/v1/capabilities'].includes(path ?? '')) {
      fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND', 'Unknown endpoint');
      return;
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('access-control-allow-methods', 'GET');
      response.setHeader('access-control-allow-headers', 'Authorization');
      send(HTTP_STATUS.NO_CONTENT, undefined);
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET, OPTIONS');
      fail(HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED', 'Method is not allowed');
      return;
    }
    if (path === '/healthz') {
      send(HTTP_STATUS.OK, { status: 'ok', service: 'mio-foundation' });
      return;
    }
    if (path === '/readyz') {
      send(HTTP_STATUS.OK, { status: 'ready', instanceId: options.instanceId });
      return;
    }
    const actual = Buffer.from(request.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      response.setHeader('www-authenticate', 'Bearer');
      fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED', 'A valid service credential is required');
      return;
    }
    const capabilities: Capabilities = {
      apiVersion: 'v1',
      stage: 'foundation',
      tools: [],
      sessions: options.sessions ?? false,
    };
    send(HTTP_STATUS.OK, capabilities);
  };
}
