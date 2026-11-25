import { HTTP_STATUS } from '@mio/foundation/http-status';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, RequestBodyError } from '../http-request.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { AudioError } from './contracts.ts';
import type { AudioJobService } from './jobs/service.ts';
import { VoiceError } from './voices/contracts.ts';
import { ProviderError } from '../providers/contracts.ts';
import type { ProviderPrincipal } from '../providers/contracts.ts';
import type { ProviderService } from '../providers/service.ts';

const BASE = '/api/v1/audio';
export function createAudioHandler(
  service: ProviderService,
  identity: (headers: Headers) => Promise<ProviderPrincipal | null>,
  origins: readonly string[],
  jobs?: AudioJobService,
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
      const create = url.pathname === `${BASE}/jobs`;
      const clone = url.pathname === `${BASE}/voices/clone`;
      const records = url.pathname === `${BASE}/records`;
      const job = /^\/api\/v1\/audio\/jobs\/([0-9a-f-]{36})(?:\/(recover|cancel))?$/.exec(
        url.pathname,
      );
      const record = /^\/api\/v1\/audio\/records\/([0-9a-f-]{36})$/.exec(url.pathname);
      const model = url.pathname === `${BASE}/models`;
      const list = url.pathname === `${BASE}/voices`;
      const refresh = url.pathname === `${BASE}/voices/refresh`;
      const match = /^\/api\/v1\/audio\/voices\/([0-9a-f-]{36})$/.exec(url.pathname);
      const methods =
        model || list || records || record || (job && !job[2])
          ? ['GET']
          : refresh || create || clone || job
            ? ['POST']
            : match
              ? ['GET', 'PATCH']
              : null;
      if (!methods) return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      if (request.method === 'OPTIONS') {
        if (!origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
        response.writeHead(HTTP_STATUS.NO_CONTENT, {
          'access-control-allow-methods': [...methods, 'OPTIONS'].join(', '),
          'access-control-allow-headers': 'Content-Type',
        });
        response.end();
        return;
      }
      if (!methods.includes(request.method ?? '')) {
        response.setHeader('allow', [...methods, 'OPTIONS'].join(', '));
        return fail(HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED');
      }
      if (!(list || records || model) && url.searchParams.size)
        return fail(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
      const writing = request.method !== 'GET';
      if (writing && !origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
      if (writing && request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
        return fail(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, 'JSON_REQUIRED');
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      const actor = await identity(headers);
      if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      const body = writing ? await readJsonBody(request, 160 * 1024) : {};
      if (writing) {
        const current = await identity(headers);
        if (!current || current.userId !== actor.userId || current.sessionId !== actor.sessionId)
          return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      }
      const send = (value: unknown, status: number = HTTP_STATUS.OK) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (model) {
        if (!url.searchParams.size) return send({ items: await service.listVoiceModels(actor) });
        const operation = url.searchParams.get('operation');
        if (url.searchParams.size !== 1 || (operation !== 'tts' && operation !== 'clone'))
          return fail(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
        return send({ items: jobs ? await jobs.listModels(actor, operation) : [] });
      }
      if (create || clone || job || records || record) {
        if (!jobs) return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'AUDIO_UNAVAILABLE');
        if (create || clone) {
          const result = await (create ? jobs.create(actor, body) : jobs.clone(actor, body));
          return send(result.job, result.created ? HTTP_STATUS.ACCEPTED : HTTP_STATUS.OK);
        }
        if (job) {
          if (job[2] && Object.keys(body).length)
            return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
          return send(
            job[2] === 'recover'
              ? await jobs.recover(actor, job[1]!)
              : job[2] === 'cancel'
                ? await jobs.cancel(actor, job[1]!)
                : await jobs.get(actor, job[1]!),
          );
        }
        return send(
          records
            ? await jobs.records(actor, url.searchParams)
            : await jobs.record(actor, record![1]!),
        );
      }
      if (list) return send(await service.voices.list(actor.userId, url.searchParams));
      if (refresh) {
        if (
          Object.keys(body).some((key) => key !== 'modelRef') ||
          (body.modelRef !== undefined && typeof body.modelRef !== 'string')
        )
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        return send(await service.voices.refresh(actor.userId));
      }
      if (request.method === 'GET') return send(await service.voices.get(actor.userId, match![1]!));
      if (Object.keys(body).length !== 1 || typeof body.favorite !== 'boolean')
        return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      return send(await service.voices.favorite(actor.userId, match![1]!, body.favorite));
    } catch (error) {
      return error instanceof AudioError ||
        error instanceof VoiceError ||
        error instanceof ProviderError ||
        error instanceof RequestBodyError
        ? fail(error.status, error.code)
        : fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'VOICE_UNAVAILABLE');
    }
  };
}
