import type { IncomingMessage, ServerResponse } from 'node:http';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { readJsonBody, RequestBodyError } from '../http-request.ts';
import { AssetError } from './contracts.ts';
import type { AssetPrincipal } from './contracts.ts';
import type { createAssetService } from './service.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Identity = (headers: Headers) => Promise<AssetPrincipal | null>;

export function createAssetHandler(
  service: ReturnType<typeof createAssetService>,
  identity: Identity,
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
      if (origin !== undefined) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('access-control-allow-credentials', 'true');
        response.setHeader('vary', 'Origin');
      }
      const url = new URL(request.url ?? '', 'http://mio.invalid');
      if (url.search) return fail(400, 'QUERY_INVALID');
      const parts = url.pathname.split('/').slice(4);
      const upload = parts.length === 1 && parts[0] === 'uploads';
      const id = parts[0];
      const complete = parts.length === 2 && id && uuid.test(id) && parts[1] === 'complete';
      const get = parts.length === 1 && id && uuid.test(id);
      if (!upload && !complete && !get) return fail(404, 'NOT_FOUND');
      const method = get ? 'GET' : 'POST';
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
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      let actor = await identity(headers);
      if (!actor) return fail(401, 'UNAUTHORIZED');
      const value = method === 'POST' ? await readJsonBody(request) : {};
      if (method === 'POST') {
        actor = await identity(headers);
        if (!actor) return fail(401, 'UNAUTHORIZED');
      }
      const expected = upload ? ['filename', 'contentType', 'size'] : [];
      if (Object.keys(value).some((key) => !expected.includes(key)))
        return fail(400, 'BODY_INVALID');
      let result: unknown;
      if (upload) {
        if (
          typeof value.filename !== 'string' ||
          typeof value.contentType !== 'string' ||
          typeof value.size !== 'number'
        )
          return fail(400, 'BODY_INVALID');
        result = await service.create(actor, value.filename, value.contentType, value.size);
      } else if (complete) result = await service.complete(actor, id!);
      else result = await service.get(actor, id!);
      response.writeHead(upload ? 201 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof AssetError || error instanceof RequestBodyError)
        return fail(error.status, error.code);
      return fail(503, 'ASSET_UNAVAILABLE');
    }
  };
}
