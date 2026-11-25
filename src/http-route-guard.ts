import { HTTP_STATUS } from '@mio/foundation/http-status';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody } from './http-request.ts';

type RejectRequest = (status: number, code: string) => void;

export function applyAllowedOrigin(
  request: IncomingMessage,
  response: ServerResponse,
  allowed: ReadonlySet<string>,
  reject: RejectRequest,
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (!allowed.has(origin)) {
    reject(HTTP_STATUS.FORBIDDEN, 'ORIGIN_DENIED');
    return false;
  }
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-credentials', 'true');
  response.setHeader('vary', 'Origin');
  return true;
}

function advertisedMethods(methods: readonly string[]): string {
  return [...methods, 'OPTIONS'].join(', ');
}

export function replyToPreflight(
  request: IncomingMessage,
  response: ServerResponse,
  methods: readonly string[],
  reject: RejectRequest,
): void {
  if (!request.headers.origin) return reject(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
  response
    .writeHead(HTTP_STATUS.NO_CONTENT, {
      'access-control-allow-methods': advertisedMethods(methods),
      'access-control-allow-headers': 'Content-Type',
    })
    .end();
}

export function allowRouteMethod(
  request: IncomingMessage,
  response: ServerResponse,
  methods: readonly string[],
  reject: RejectRequest,
): boolean {
  if (methods.includes(request.method ?? '')) return true;
  response.setHeader('allow', advertisedMethods(methods));
  reject(HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED');
  return false;
}

export function allowJsonWrite(request: IncomingMessage, reject: RejectRequest): boolean {
  if (!request.headers.origin) {
    reject(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
    return false;
  }
  const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType === 'application/json') return true;
  reject(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, 'JSON_REQUIRED');
  return false;
}

export function requestCookieHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
  return headers;
}

export async function readJsonAndRecheck<Actor>(
  request: IncomingMessage,
  limit: number,
  resolveActor: () => Promise<Actor | null>,
  strictUtf8 = false,
): Promise<{ body: Record<string, unknown>; actor: Actor | null }> {
  const body = await readJsonBody(request, limit, strictUtf8);
  const actor = await resolveActor();
  return { body, actor };
}
