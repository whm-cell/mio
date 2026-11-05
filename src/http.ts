import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiError, Capabilities } from './contracts.ts';

export interface HttpOptions {
  token: string;
  allowedOrigins: readonly string[];
  instanceId: string;
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
  const expected = Buffer.from(`Bearer ${options.token}`);
  const allowedOrigins = new Set(options.allowedOrigins);

  return (request: IncomingMessage, response: ServerResponse): void => {
    const requestId = randomUUID();
    const send = (status: number, value: unknown): void => {
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-request-id': requestId,
      });
      response.end(JSON.stringify(value));
    };
    const fail = (status: number, code: string, message: string): void => {
      const value: ApiError = { error: { code, message, requestId } };
      send(status, value);
    };
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      fail(403, 'ORIGIN_DENIED', 'Origin is not allowed');
      return;
    }
    if (origin !== undefined) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
    }

    const path = request.url?.split('?')[0];
    if (!['/healthz', '/readyz', '/api/v1/capabilities'].includes(path ?? '')) {
      fail(404, 'NOT_FOUND', 'Unknown endpoint');
      return;
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('access-control-allow-methods', 'GET');
      response.setHeader('access-control-allow-headers', 'Authorization');
      send(204, undefined);
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET, OPTIONS');
      fail(405, 'METHOD_NOT_ALLOWED', 'Method is not allowed');
      return;
    }
    if (path === '/healthz') {
      send(200, { status: 'ok', service: 'mio-foundation' });
      return;
    }
    if (path === '/readyz') {
      send(200, { status: 'ready', instanceId: options.instanceId });
      return;
    }
    const actual = Buffer.from(request.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      response.setHeader('www-authenticate', 'Bearer');
      fail(401, 'UNAUTHORIZED', 'A valid service credential is required');
      return;
    }
    const capabilities: Capabilities = {
      apiVersion: 'v1',
      stage: 'foundation',
      tools: [],
      sessions: false,
    };
    send(200, capabilities);
  };
}
