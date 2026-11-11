import type { IncomingMessage, ServerResponse } from 'node:http';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { ProviderError, categories } from './contracts.ts';
import type { ProviderPrincipal } from './contracts.ts';
import type { ProviderService } from './service.ts';
const BASE = '/api/v1/providers/onelink';
const MAX_BODY = 8192;

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (code?: string) => {
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('error', fail);
      request.off('aborted', fail);
      if (code) {
        request.resume();
        reject(
          new ProviderError(
            code === 'BODY_TOO_LARGE' ? 413 : code === 'BODY_TIMEOUT' ? 408 : 400,
            code,
          ),
        );
      } else resolve(Buffer.concat(chunks));
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) finish('BODY_TOO_LARGE');
      else chunks.push(chunk);
    };
    const end = () => finish();
    const fail = () => finish('BODY_INVALID');
    const timer = setTimeout(() => finish('BODY_TIMEOUT'), 10_000);
    request.on('data', data).once('end', end).once('error', fail).once('aborted', fail);
  });
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ProviderError(400, 'BODY_INVALID');
  }
}

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
      if (origin !== undefined && !allowed.has(origin)) return fail(403, 'ORIGIN_DENIED');
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
      if (!supported) return fail(404, 'NOT_FOUND');
      if (request.method === 'OPTIONS') {
        if (!origin) return fail(403, 'ORIGIN_REQUIRED');
        response.writeHead(204, {
          'access-control-allow-methods': [...supported, 'OPTIONS'].join(', '),
          'access-control-allow-headers': 'Content-Type',
        });
        response.end();
        return;
      }
      if (!supported.includes(request.method ?? '')) {
        response.setHeader('allow', [...supported, 'OPTIONS'].join(', '));
        return fail(405, 'METHOD_NOT_ALLOWED');
      }
      const writing = request.method !== 'GET';
      if (writing && !origin) return fail(403, 'ORIGIN_REQUIRED');
      if (writing && request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
        return fail(415, 'JSON_REQUIRED');
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      let actor = await identity(headers);
      if (!actor) return fail(401, 'UNAUTHORIZED');
      const value = writing ? await body(request) : {};
      if (writing) {
        actor = await identity(headers);
        if (!actor) return fail(401, 'UNAUTHORIZED');
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
      if (Object.keys(value).some((k) => !keys.includes(k))) return fail(400, 'BODY_INVALID');
      if (
        [...url.searchParams.keys()].some(
          (k) => !models || request.method !== 'GET' || k !== 'category',
        ) ||
        url.searchParams.getAll('category').length > 1
      )
        return fail(400, 'QUERY_INVALID');
      const send = (result: unknown) => {
        response.writeHead(200, { 'content-type': 'application/json' });
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
        return fail(400, 'BODY_INVALID');
      const expected = value.expectedRevision as number;
      for (const key of ['enabled', 'isDefault', 'defaultImageWatermark', 'defaultVideoWatermark'])
        if (key in value && typeof value[key] !== 'boolean') return fail(400, 'BODY_INVALID');
      if (credential) {
        if (typeof value.apiKey !== 'string') return fail(400, 'BODY_INVALID');
        return send(await service.save(actor, expected, value.apiKey));
      }
      const { expectedRevision: _revision, modelRef, ...patch } = value;
      void _revision;
      if (!Object.keys(patch).length) return fail(400, 'BODY_INVALID');
      if (models) {
        if (typeof modelRef !== 'string') return fail(400, 'BODY_INVALID');
        if ('usage' in patch && !categories.includes(patch.usage as never))
          return fail(400, 'BODY_INVALID');
        if (!('enabled' in patch) && !('isDefault' in patch)) return fail(400, 'BODY_INVALID');
        return send(await service.preference(actor, expected, modelRef, patch));
      }
      return send(await service.settings(actor, expected, patch));
    } catch (error) {
      return error instanceof ProviderError
        ? fail(error.status, error.code)
        : fail(503, 'PROVIDER_UNAVAILABLE');
    }
  };
}
