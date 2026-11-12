import { HTTP_STATUS } from '@mio/foundation/http-status';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, RequestBodyError } from '../http-request.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { ProviderError, categories } from './contracts.ts';
import type { ProviderPrincipal } from './contracts.ts';
import type { ProviderService } from './service.ts';
const BASE = '/api/v1/providers/onelink';
export function createProviderHandler(
  service: ProviderService,
  identity: (headers: Headers) => Promise<ProviderPrincipal | null>,
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
      const methods: Record<string, string[]> = {
        [BASE]: ['GET', 'PATCH'],
        [`${BASE}/credential`]: ['PUT'],
        [`${BASE}/test`]: ['POST'],
        [`${BASE}/models`]: ['GET', 'PATCH'],
      };
      const supported = methods[url.pathname];
      if (!supported) return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      if (request.method === 'OPTIONS') {
        if (!origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
        response.writeHead(HTTP_STATUS.NO_CONTENT, {
          'access-control-allow-methods': [...supported, 'OPTIONS'].join(', '),
          'access-control-allow-headers': 'Content-Type',
        });
        response.end();
        return;
      }
      if (!supported.includes(request.method ?? '')) {
        response.setHeader('allow', [...supported, 'OPTIONS'].join(', '));
        return fail(HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED');
      }
      const writing = request.method !== 'GET';
      if (writing && !origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
      if (writing && request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
        return fail(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, 'JSON_REQUIRED');
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      let actor = await identity(headers);
      if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      const value = writing ? await readJsonBody(request) : {};
      if (writing) {
        actor = await identity(headers);
        if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      }
      const credential = url.pathname.endsWith('/credential');
      const models = url.pathname.endsWith('/models');
      const test = url.pathname.endsWith('/test');
      const keys = credential
        ? ['apiKey', 'expectedRevision']
        : test
          ? []
          : models
            ? ['modelRef', 'usage', 'enabled', 'isDefault', 'expectedRevision']
            : ['enabled', 'defaultImageWatermark', 'defaultVideoWatermark', 'expectedRevision'];
      if (Object.keys(value).some((k) => !keys.includes(k)))
        return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      if (
        [...url.searchParams.keys()].some(
          (k) => !models || request.method !== 'GET' || k !== 'category',
        ) ||
        url.searchParams.getAll('category').length > 1
      )
        return fail(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
      const send = (result: unknown) => {
        response.writeHead(HTTP_STATUS.OK, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
      };
      if (request.method === 'GET')
        return send(
          models
            ? await service.catalog(actor, url.searchParams.get('category') ?? undefined)
            : await service.get(actor),
        );
      if (test) return send(await service.discover(actor));
      if (
        !Number.isSafeInteger(value.expectedRevision) ||
        Number(value.expectedRevision) < 0 ||
        Number(value.expectedRevision) >= 2147483647
      )
        return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      const expected = value.expectedRevision as number;
      for (const key of ['enabled', 'isDefault', 'defaultImageWatermark', 'defaultVideoWatermark'])
        if (key in value && typeof value[key] !== 'boolean')
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      if (credential) {
        if (typeof value.apiKey !== 'string') return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        return send(await service.save(actor, expected, value.apiKey));
      }
      const { expectedRevision: _revision, modelRef, ...patch } = value;
      void _revision;
      if (!Object.keys(patch).length) return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      if (models) {
        if (typeof modelRef !== 'string') return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        if ('usage' in patch && !categories.includes(patch.usage as never))
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        if (!('enabled' in patch) && !('isDefault' in patch))
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        return send(await service.preference(actor, expected, modelRef, patch));
      }
      return send(await service.settings(actor, expected, patch));
    } catch (error) {
      return error instanceof ProviderError || error instanceof RequestBodyError
        ? fail(error.status, error.code)
        : fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'PROVIDER_UNAVAILABLE');
    }
  };
}
