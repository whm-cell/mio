import { isUuidV4 } from '@mio/foundation/identifiers';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MEDIA_MAX_MESSAGE_BYTES } from '@mio/compute-contracts';
import type { AssetPrincipal } from '../assets/contracts.ts';
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
import { HLS_PLAYLIST_CONTENT_TYPE } from './media-hls.ts';
import { MediaError } from './media-model.ts';
import { ComputeError } from './errors.ts';
import type { createMediaService } from './media-service.ts';

export function createMediaHandler(
  service: ReturnType<typeof createMediaService>,
  identity: (headers: Headers) => Promise<AssetPrincipal | null>,
  origins: readonly string[],
) {
  const allowed = new Set(origins);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = startHttpResponse(response);
    const fail = (status: number, code: string) =>
      writeApiError(response, status, { code, message: code, requestId }, 'application/json');
    try {
      if (!applyAllowedOrigin(request, response, allowed, fail)) return;
      response.setHeader('cache-control', 'private, no-store');
      const url = new URL(request.url ?? '', 'http://mio.invalid');
      if (url.search) return fail(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
      const match =
        /^\/api\/v1\/compute\/media(?:\/([a-f0-9-]+)(?:\/(cancel|retry|recover|hls)(?:\/([a-f0-9-]+))?)?)?$/.exec(
          url.pathname,
        );
      if (!match || (match[1] && !isUuidV4(match[1])))
        return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      const [, id, action, assetId] = match;
      if (assetId && (action !== 'hls' || !isUuidV4(assetId)))
        return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      const collection = !id;
      const hls = action === 'hls';
      const methods = collection ? ['GET', 'POST'] : [action && !hls ? 'POST' : 'GET'];
      if (request.method === 'OPTIONS') return replyToPreflight(request, response, methods, fail);
      if (!allowRouteMethod(request, response, methods, fail)) return;
      const write = request.method === 'POST';
      if (write && !allowJsonWrite(request, fail)) return;
      const headers = requestCookieHeaders(request);
      const actor = await identity(headers);
      if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      if (hls) {
        const text = await service.hls(actor, id!, assetId);
        response.writeHead(HTTP_STATUS.OK, { 'content-type': HLS_PLAYLIST_CONTENT_TYPE }).end(text);
        return;
      }
      let result: unknown;
      let status: number = HTTP_STATUS.OK;
      if (write) {
        const { body, actor: confirmed } = await readJsonAndRecheck(
          request,
          MEDIA_MAX_MESSAGE_BYTES,
          () => identity(headers),
          true,
        );
        if (!confirmed) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
        if (collection) {
          const created = await service.create(confirmed, body);
          result = created.job;
          status = created.created ? HTTP_STATUS.ACCEPTED : HTTP_STATUS.OK;
        } else if (action === 'retry') {
          if (Object.keys(body).length !== 1 || typeof body.requestId !== 'string')
            return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
          result = await service.retry(confirmed, id!, body.requestId);
        } else {
          if (Object.keys(body).length) return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
          result =
            action === 'cancel'
              ? await service.cancel(confirmed, id!)
              : await service.recover(confirmed, id!);
        }
      } else result = collection ? await service.list(actor) : await service.get(actor, id!);
      response
        .writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify(result));
    } catch (error) {
      if (
        error instanceof MediaError ||
        error instanceof ComputeError ||
        error instanceof RequestBodyError
      )
        return fail(error.status, error.code);
      return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_UNAVAILABLE');
    }
  };
}
