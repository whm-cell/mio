import { HTTP_STATUS } from '@mio/foundation/http-status';
import { isUuidV4 } from '@mio/foundation/identifiers';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, RequestBodyError } from '../http-request.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import type { AssetPrincipal } from '../assets/contracts.ts';
import { ComputeError } from './errors.ts';
import type { createComputeService } from './service.ts';

type Identity = (headers: Headers) => Promise<AssetPrincipal | null>;

export function createComputeHandler(
  service: ReturnType<typeof createComputeService>,
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
      const create = parts.length === 1 && parts[0] === 'jobs';
      const id = parts[1];
      const get = parts.length === 2 && parts[0] === 'jobs' && id && isUuidV4(id);
      if (!create && !get) return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      const method = create ? 'POST' : 'GET';
      if (request.method === 'OPTIONS') {
        if (!origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
        response
          .writeHead(HTTP_STATUS.NO_CONTENT, {
            'access-control-allow-methods': `${method}, OPTIONS`,
            'access-control-allow-headers': 'Content-Type',
          })
          .end();
        return;
      }
      if (request.method !== method) {
        response.setHeader('allow', `${method}, OPTIONS`);
        return fail(HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED');
      }
      if (create && !origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
      if (create && request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
        return fail(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, 'JSON_REQUIRED');
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      let actor = await identity(headers);
      if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      if (create) {
        const value = await readJsonBody(request);
        actor = await identity(headers);
        if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
        if (
          Object.keys(value).length !== 2 ||
          typeof value.requestId !== 'string' ||
          typeof value.assetId !== 'string'
        )
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        const result = await service.create(actor, value.requestId, value.assetId);
        response
          .writeHead(result.created ? HTTP_STATUS.ACCEPTED : HTTP_STATUS.OK, {
            'content-type': 'application/json',
          })
          .end(JSON.stringify(result.job));
      } else {
        const result = await service.get(actor, id!);
        response
          .writeHead(HTTP_STATUS.OK, { 'content-type': 'application/json' })
          .end(JSON.stringify(result));
      }
    } catch (error) {
      if (error instanceof ComputeError || error instanceof RequestBodyError)
        return fail(error.status, error.code);
      return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_UNAVAILABLE');
    }
  };
}
