import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, RequestBodyError } from '../http-request.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import type { AssetPrincipal } from '../assets/contracts.ts';
import { ComputeError } from './store.ts';
import type { createComputeService } from './service.ts';

type Identity = (headers: Headers) => Promise<AssetPrincipal | null>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
      if (origin !== undefined && !allowed.has(origin)) return fail(403, 'ORIGIN_DENIED');
      if (origin !== undefined) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('access-control-allow-credentials', 'true');
        response.setHeader('vary', 'Origin');
      }
      const url = new URL(request.url ?? '', 'http://mio.invalid');
      if (url.search) return fail(400, 'QUERY_INVALID');
      const parts = url.pathname.split('/').slice(4);
      const create = parts.length === 1 && parts[0] === 'jobs';
      const id = parts[1];
      const get = parts.length === 2 && parts[0] === 'jobs' && id && uuid.test(id);
      if (!create && !get) return fail(404, 'NOT_FOUND');
      const method = create ? 'POST' : 'GET';
      if (request.method === 'OPTIONS') {
        if (!origin) return fail(403, 'ORIGIN_REQUIRED');
        response
          .writeHead(204, {
            'access-control-allow-methods': `${method}, OPTIONS`,
            'access-control-allow-headers': 'Content-Type',
          })
          .end();
        return;
      }
      if (request.method !== method) {
        response.setHeader('allow', `${method}, OPTIONS`);
        return fail(405, 'METHOD_NOT_ALLOWED');
      }
      if (create && !origin) return fail(403, 'ORIGIN_REQUIRED');
      if (create && request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
        return fail(415, 'JSON_REQUIRED');
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      let actor = await identity(headers);
      if (!actor) return fail(401, 'UNAUTHORIZED');
      if (create) {
        const value = await readJsonBody(request);
        actor = await identity(headers);
        if (!actor) return fail(401, 'UNAUTHORIZED');
        if (
          Object.keys(value).length !== 2 ||
          typeof value.requestId !== 'string' ||
          typeof value.assetId !== 'string'
        )
          return fail(400, 'BODY_INVALID');
        const result = await service.create(actor, value.requestId, value.assetId);
        response
          .writeHead(result.created ? 202 : 200, { 'content-type': 'application/json' })
          .end(JSON.stringify(result.job));
      } else {
        const result = await service.get(actor, id!);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      }
    } catch (error) {
      if (error instanceof ComputeError || error instanceof RequestBodyError)
        return fail(error.status, error.code);
      return fail(503, 'COMPUTE_UNAVAILABLE');
    }
  };
}
