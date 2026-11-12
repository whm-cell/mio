import { HTTP_STATUS } from '@mio/foundation/http-status';
import { isUuidV4 } from '@mio/foundation/identifiers';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { readJsonBody, RequestBodyError } from '../http-request.ts';
import { AssetError } from './contracts.ts';
import type { AssetPrincipal } from './contracts.ts';
import type { createAssetService } from './service.ts';

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
      if (origin !== undefined && !allowed.has(origin))
        return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_DENIED');
      if (origin !== undefined) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('access-control-allow-credentials', 'true');
        response.setHeader('vary', 'Origin');
      }
      const url = new URL(request.url ?? '', 'http://mio.invalid');
      if (url.search) return fail(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
      const parts = url.pathname.split('/').slice(4);
      const upload = parts.length === 1 && parts[0] === 'uploads';
      const id = parts[0];
      const complete = parts.length === 2 && id && isUuidV4(id) && parts[1] === 'complete';
      const get = parts.length === 1 && id && isUuidV4(id);
      if (!upload && !complete && !get) return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      const method = get ? 'GET' : 'POST';
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
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      let actor = await identity(headers);
      if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      const value = method === 'POST' ? await readJsonBody(request) : {};
      if (method === 'POST') {
        actor = await identity(headers);
        if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      }
      const expected = upload ? ['filename', 'contentType', 'size'] : [];
      if (Object.keys(value).some((key) => !expected.includes(key)))
        return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      let result: unknown;
      if (upload) {
        if (
          typeof value.filename !== 'string' ||
          typeof value.contentType !== 'string' ||
          typeof value.size !== 'number'
        )
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        result = await service.create(actor, value.filename, value.contentType, value.size);
      } else if (complete) result = await service.complete(actor, id!);
      else result = await service.get(actor, id!);
      response.writeHead(upload ? HTTP_STATUS.CREATED : HTTP_STATUS.OK, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof AssetError || error instanceof RequestBodyError)
        return fail(error.status, error.code);
      return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ASSET_UNAVAILABLE');
    }
  };
}
