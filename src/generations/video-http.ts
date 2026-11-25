import { HTTP_STATUS } from '@mio/foundation/http-status';
import { isUuidV4 } from '@mio/foundation/identifiers';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AssetPrincipal } from '../assets/contracts.ts';
import { ProviderError } from '../providers/contracts.ts';
import { RequestBodyError } from '../http-request.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import {
  allowJsonWrite,
  allowRouteMethod,
  applyAllowedOrigin,
  readJsonAndRecheck,
  replyToPreflight,
  requestCookieHeaders,
} from '../http-route-guard.ts';
import { GenerationError } from './errors.ts';
import { decodeVideoCreateRequest, VIDEO_MAX_HTTP_BODY_BYTES } from './video-contracts.ts';
import type { createVideoGenerationService } from './video-service.ts';

type Identity = (headers: Headers) => Promise<AssetPrincipal | null>;
const CAPABILITIES = '/api/v1/compute/video-capabilities/';
const VIDEOS = '/api/v1/compute/videos';

/** Video reads and writes share the same authenticated HTTP boundary as image jobs. */
export function createVideoGenerationHandler(
  service: ReturnType<typeof createVideoGenerationService>,
  identity: Identity,
  origins: readonly string[],
) {
  const allowed = new Set(origins);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = startHttpResponse(response);
    response.setHeader('cache-control', 'no-store');
    const fail = (status: number, code: string) =>
      writeApiError(response, status, { code, message: code, requestId }, 'application/json');
    try {
      if (!applyAllowedOrigin(request, response, allowed, fail)) return;
      const url = new URL(request.url ?? '', 'http://mio.invalid');
      const capabilityPath = url.pathname.startsWith(CAPABILITIES)
        ? url.pathname.slice(CAPABILITIES.length)
        : '';
      const capability =
        capabilityPath.length > 0 && !capabilityPath.includes('/') ? capabilityPath : '';
      const jobPath = url.pathname.startsWith(`${VIDEOS}/`)
        ? url.pathname.slice(VIDEOS.length + 1)
        : '';
      const collection = url.pathname === VIDEOS;
      const get = jobPath.length > 0 && !jobPath.includes('/') && isUuidV4(jobPath);
      const route = capability ? 'capabilities' : collection ? 'collection' : get ? 'get' : null;
      if (!route) return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      const allowedMethods = route === 'collection' ? ['GET', 'POST'] : ['GET'];
      if (request.method === 'OPTIONS')
        return replyToPreflight(request, response, allowedMethods, fail);
      if (!allowRouteMethod(request, response, allowedMethods, fail)) return;
      const write = route === 'collection' && request.method === 'POST';
      const list = route === 'collection' && request.method === 'GET';
      const queryKeys = list ? new Set(['cursor', 'limit']) : new Set<string>();
      const seenQueryKeys = new Set<string>();
      for (const key of url.searchParams.keys()) {
        if (!queryKeys.has(key) || seenQueryKeys.has(key))
          return fail(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
        seenQueryKeys.add(key);
      }
      if (write && !allowJsonWrite(request, fail)) return;
      const headers = requestCookieHeaders(request);
      const actor = await identity(headers);
      if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      if (write) {
        const { body, actor: confirmed } = await readJsonAndRecheck(
          request,
          VIDEO_MAX_HTTP_BODY_BYTES,
          () => identity(headers),
        );
        if (!confirmed) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
        const result = await service.create(confirmed, decodeVideoCreateRequest(body));
        response
          .writeHead(result.created ? HTTP_STATUS.ACCEPTED : HTTP_STATUS.OK, {
            'content-type': 'application/json',
          })
          .end(JSON.stringify(result.job));
        return;
      }
      const payload =
        route === 'capabilities'
          ? await service.capabilities(actor, decodeModelRef(capability))
          : route === 'get'
            ? await service.get(actor, jobPath)
            : await service.list(
                actor,
                url.searchParams.has('limit') ? parseLimit(url.searchParams.get('limit')) : 20,
                url.searchParams.get('cursor') ?? undefined,
              );
      response.writeHead(HTTP_STATUS.OK, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    } catch (error) {
      if (
        error instanceof GenerationError ||
        error instanceof ProviderError ||
        error instanceof RequestBodyError
      )
        return fail(error.status, error.code);
      return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'VIDEO_UNAVAILABLE');
    }
  };
}

function parseLimit(value: string | null): number {
  if (!value || !/^(?:[1-9][0-9]{0,2})$/.test(value))
    throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'VIDEO_INPUT_INVALID');
  const limit = Number(value);
  if (limit > 100) throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'VIDEO_INPUT_INVALID');
  return limit;
}

function decodeModelRef(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'VIDEO_INPUT_INVALID');
  }
}
