import { isUuidV4 } from '@mio/foundation/identifiers';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, RequestBodyError } from '../http-request.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { NotificationError } from './contracts.ts';
import type { CreationCursor } from './creation-contracts.ts';
import type { CreationLogStore } from './creation-store.ts';

function pagination(url: URL) {
  const query = url.searchParams;
  const page = query.get('page') ?? '1';
  const pageSize = query.get('pageSize') ?? '10';
  if (
    [...query.keys()].some((key) => !['type', 'page', 'pageSize', 'cursor'].includes(key)) ||
    new Set(query.keys()).size !== query.size ||
    query.get('type') !== 'creation_log' ||
    !/^[1-9]\d*$/.test(page) ||
    Number(page) > 1000000 ||
    !/^[1-9]\d*$/.test(pageSize) ||
    Number(pageSize) > 100
  )
    throw new NotificationError(400, 'QUERY_INVALID');
  let cursor: CreationCursor | undefined;
  const raw = query.get('cursor');
  if (raw !== null) {
    try {
      if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString());
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 2
      )
        throw new Error();
      const c = value as CreationCursor;
      if (
        !isUuidV4(c.id) ||
        typeof c.occurredAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(c.occurredAt) ||
        !Number.isFinite(Date.parse(c.occurredAt)) ||
        c.occurredAt.startsWith('0000-') ||
        new Date(c.occurredAt).toISOString().slice(0, 19) !== c.occurredAt.slice(0, 19)
      )
        throw new Error();
      cursor = c;
    } catch {
      throw new NotificationError(400, 'QUERY_INVALID');
    }
  }
  if (Number(page) > 1 && !cursor) throw new NotificationError(400, 'CURSOR_REQUIRED');
  return { page: Number(page), pageSize: Number(pageSize), cursor };
}

export function createCreationLogHandler(
  store: CreationLogStore,
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
      if (origin !== undefined && !allowed.has(origin)) return fail(403, 'ORIGIN_DENIED');
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Credentials', 'true');
        response.setHeader('Vary', 'Origin');
      }
      const url = new URL(request.url ?? '/', 'http://mio.invalid');
      const list = url.pathname === '/api/v1/notifications';
      const id = /^\/api\/v1\/notifications\/([^/]+)\/read$/.exec(url.pathname)?.[1];
      if (!list && !(id && isUuidV4(id))) return fail(404, 'NOT_FOUND');
      const method = list ? 'GET' : 'PATCH';
      if (request.method === 'OPTIONS') {
        if (!origin) return fail(403, 'ORIGIN_REQUIRED');
        response.writeHead(204, {
          'Access-Control-Allow-Methods': `${method}, OPTIONS`,
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        response.end();
        return;
      }
      if (request.method !== method) {
        response.setHeader('Allow', `${method}, OPTIONS`);
        return fail(405, 'METHOD_NOT_ALLOWED');
      }
      if (!list && !origin) return fail(403, 'ORIGIN_REQUIRED');
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      let actor = await identity(headers);
      if (!actor) return fail(401, 'UNAUTHORIZED');
      let result: unknown;
      if (list) {
        const p = pagination(url);
        result = await store.list(actor.userId, p.page, p.pageSize, p.cursor);
      } else {
        if (url.search) return fail(400, 'QUERY_INVALID');
        if (
          request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !==
          'application/json'
        )
          return fail(415, 'JSON_REQUIRED');
        const body = await readJsonBody(request);
        actor = await identity(headers);
        if (!actor) return fail(401, 'UNAUTHORIZED');
        if (Object.keys(body).length) return fail(400, 'BODY_INVALID');
        await store.markRead(actor.userId, id!);
        result = { ok: true };
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (error) {
      if (response.writableEnded) return;
      if (error instanceof NotificationError || error instanceof RequestBodyError)
        return fail(error.status, error.code);
      fail(503, 'NOTIFICATIONS_UNAVAILABLE');
    }
  };
}
