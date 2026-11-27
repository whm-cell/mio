import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, RequestBodyError } from '../http-request.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { StorageError } from './storage.ts';
import type { StorageAccounting } from './storage-store.ts';

export function createStorageUsageHandler(
  store: () => Pick<StorageAccounting, 'usage' | 'acknowledge'> | undefined,
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
      const ack = url.pathname === '/api/v1/me/storage-usage/reminders/ack';
      if (!ack && url.pathname !== '/api/v1/me/storage-usage') return fail(404, 'NOT_FOUND');
      const method = ack ? 'POST' : 'GET';
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
      if (url.search) return fail(400, 'QUERY_INVALID');
      if (ack && !origin) return fail(403, 'ORIGIN_REQUIRED');
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      let actor = await identity(headers);
      if (!actor) return fail(401, 'UNAUTHORIZED');
      const accounting = store();
      if (!accounting) return fail(503, 'STORAGE_UNAVAILABLE');
      if (!ack) {
        const usage = await accounting.usage(actor.userId);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(usage));
        return;
      }
      if (
        request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
      )
        return fail(415, 'JSON_REQUIRED');
      const body = await readJsonBody(request);
      actor = await identity(headers);
      if (!actor) return fail(401, 'UNAUTHORIZED');
      if (
        Object.keys(body).length !== 1 ||
        typeof body.reminderVersion !== 'string' ||
        !/^storage:v1:(safe|warning|full):\d{1,16}:\d{1,20}$/.test(body.reminderVersion)
      )
        return fail(400, 'BODY_INVALID');
      await accounting.acknowledge(actor.userId, body.reminderVersion);
      response.writeHead(204);
      response.end();
    } catch (error) {
      if (response.writableEnded) return;
      if (error instanceof StorageError || error instanceof RequestBodyError)
        return fail(error.status, error.code);
      fail(503, 'STORAGE_UNAVAILABLE');
    }
  };
}
