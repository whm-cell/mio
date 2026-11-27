import { HTTP_STATUS } from '@mio/foundation/http-status';
import { isUuidV4 } from '@mio/foundation/identifiers';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, RequestBodyError } from '../http-request.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { NotificationError } from './contracts.ts';
import { announcementPagination } from './service.ts';
import type { NotificationService } from './service.ts';

export function createNotificationHandler(
  service: NotificationService,
  identity: (headers: Headers) => Promise<{ userId: string } | null>,
  origins: readonly string[],
) {
  const allowed = new Set(origins);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = startHttpResponse(response);
    const fail = (status: number, code: string) =>
      writeApiError(response, status, { code, message: code, requestId }, 'application/json');
    try {
      const origin = request.headers.origin;
      if (origin !== undefined && !allowed.has(origin))
        return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_DENIED');
      if (origin !== undefined) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Credentials', 'true');
        response.setHeader('Vary', 'Origin');
      }
      const url = new URL(request.url ?? '/', 'http://mio.invalid');
      const base = '/api/v1/announcements';
      const list = url.pathname === base;
      const popup = url.pathname === `${base}/latest-popup`;
      const match = /^\/api\/v1\/announcements\/([^/]+)\/read$/.exec(url.pathname);
      const id = match?.[1];
      if (!list && !popup && !(id && isUuidV4(id))) return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      const method = id ? 'POST' : 'GET';
      if (request.method === 'OPTIONS') {
        if (!origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
        response.writeHead(HTTP_STATUS.NO_CONTENT, {
          'Access-Control-Allow-Methods': `${method}, OPTIONS`,
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        response.end();
        return;
      }
      if (request.method !== method) {
        response.setHeader('Allow', `${method}, OPTIONS`);
        return fail(HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED');
      }
      if (id && !origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
      if (
        id &&
        request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
      )
        return fail(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, 'JSON_REQUIRED');
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      let actor = await identity(headers);
      if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      let result: unknown;
      if (list) {
        const { page, pageSize } = announcementPagination(url);
        result = await service.list(actor.userId, page, pageSize);
      } else {
        if (url.search) return fail(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
        if (popup) result = { announcement: await service.latestPopup(actor.userId) };
        else {
          const body = await readJsonBody(request);
          actor = await identity(headers);
          if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
          if (Object.keys(body).length) return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
          await service.markRead(actor.userId, id!);
          result = { ok: true };
        }
      }
      response.writeHead(HTTP_STATUS.OK, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (error) {
      if (response.writableEnded) return;
      if (error instanceof NotificationError || error instanceof RequestBodyError)
        return fail(error.status, error.code);
      fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'NOTIFICATIONS_UNAVAILABLE');
    }
  };
}
