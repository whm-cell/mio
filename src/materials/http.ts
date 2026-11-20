import type { IncomingMessage, ServerResponse } from 'node:http';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { readJsonBody, RequestBodyError } from '../http-request.ts';
import { AssetError } from '../assets/contracts.ts';
import { ProviderError } from '../providers/contracts.ts';
import { MaterialError } from './contracts.ts';
import type { MaterialPrincipal } from './contracts.ts';
import type { MaterialAuthService } from './auth-service.ts';
import { createMaterialAuthPublicHandler } from './auth-http.ts';
import type { MaterialService } from './service.ts';

const BASE = '/api/v1/materials';
function route(path: string): { kind: string; id?: string; methods: string[] } | undefined {
  if (path === `${BASE}/auth-sessions`) return { kind: 'authCreate', methods: ['POST'] };
  const refresh = path.match(/^\/api\/v1\/materials\/auth-sessions\/([^/]+)\/refresh$/);
  if (refresh?.[1] && isUuidV4(refresh[1]))
    return { kind: 'authRefresh', id: refresh[1], methods: ['POST'] };
  const session = path.match(/^\/api\/v1\/materials\/auth-sessions\/([^/]+)$/);
  if (session?.[1] && isUuidV4(session[1]))
    return { kind: 'authGet', id: session[1], methods: ['GET'] };
  if (path === `${BASE}/groups`) return { kind: 'groups', methods: ['GET', 'POST'] };
  const match = path.match(
    /^\/api\/v1\/materials\/(groups|items|operations)\/([^/]+)(?:\/(sync|materials|refresh|delete))?$/,
  );
  if (!match || !match[2] || !isUuidV4(match[2])) return;
  const [, entity, , action] = match;
  const id = match[2];
  if (entity === 'groups' && !action) return { kind: 'group', id, methods: ['GET', 'PATCH'] };
  if (entity === 'groups' && action === 'materials')
    return { kind: 'materials', id, methods: ['GET', 'POST'] };
  if (entity === 'groups' && action === 'sync') return { kind: 'sync', id, methods: ['POST'] };
  if (entity === 'items' && !action) return { kind: 'material', id, methods: ['GET'] };
  if (entity === 'items' && action === 'refresh') return { kind: 'refresh', id, methods: ['POST'] };
  if ((entity === 'groups' || entity === 'items') && action === 'delete')
    return { kind: entity === 'groups' ? 'deleteGroup' : 'deleteMaterial', id, methods: ['POST'] };
  if (entity === 'operations' && !action) return { kind: 'operation', id, methods: ['GET'] };
}
function validName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.isWellFormed() &&
    value.trim().length > 0 &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    Array.from(value).length <= 100
  );
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) < 2147483647;
}

/** Unit 1 exposes only authenticated account endpoints; no public callback bypass exists yet. */
export function createMaterialHandler(
  service: MaterialService,
  identity: (headers: Headers) => Promise<MaterialPrincipal | null>,
  origins: readonly string[],
  authentication?: MaterialAuthService,
) {
  const allowed = new Set(origins);
  const publicHandler = authentication
    ? createMaterialAuthPublicHandler(authentication)
    : undefined;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (publicHandler && (await publicHandler(request, response))) return;
    const requestId = startHttpResponse(response);
    const fail = (status: number, code: string) => {
      if (status === 429) response.setHeader('retry-after', '4');
      return writeApiError(
        response,
        status,
        { code, message: code, requestId },
        'application/json',
      );
    };
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
      const endpoint = route(url.pathname);
      if (!endpoint || (endpoint.kind.startsWith('auth') && !authentication))
        return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      if (request.method === 'OPTIONS') {
        if (!origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
        response
          .writeHead(HTTP_STATUS.NO_CONTENT, {
            'access-control-allow-methods': [...endpoint.methods, 'OPTIONS'].join(', '),
            'access-control-allow-headers': 'Content-Type',
          })
          .end();
        return;
      }
      if (!endpoint.methods.includes(request.method ?? '')) {
        response.setHeader('allow', [...endpoint.methods, 'OPTIONS'].join(', '));
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
      const body = writing ? await readJsonBody(request) : {};
      if (writing) {
        actor = await identity(headers);
        if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      }
      const list = request.method === 'GET' && ['groups', 'materials'].includes(endpoint.kind);
      const queryKeys = list
        ? endpoint.kind === 'groups'
          ? ['cursor', 'limit', 'type']
          : ['cursor', 'limit']
        : [];
      if (
        [...url.searchParams.keys()].some(
          (key) => !queryKeys.includes(key) || url.searchParams.getAll(key).length !== 1,
        )
      )
        return fail(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
      const limitText = url.searchParams.get('limit');
      const limit = limitText === null ? 20 : Number(limitText);
      if (
        list &&
        ((limitText !== null && !/^[1-9][0-9]{0,2}$/.test(limitText)) || limit < 1 || limit > 100)
      )
        return fail(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
      const type = url.searchParams.get('type') ?? undefined;
      if (type !== undefined && type !== 'aigc' && type !== 'real')
        return fail(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
      const keys =
        endpoint.kind === 'authCreate'
          ? ['requestId', 'source', 'returnTarget']
          : endpoint.kind === 'groups'
            ? ['requestId', 'type', 'name']
            : endpoint.kind === 'group'
              ? ['revision', 'name']
              : endpoint.kind === 'materials'
                ? ['requestId', 'assetId', 'name']
                : endpoint.kind === 'sync'
                  ? ['cursor']
                  : endpoint.kind.startsWith('delete')
                    ? ['requestId', 'revision', 'scope']
                    : [];
      if (Object.keys(body).some((key) => !keys.includes(key)))
        return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      const send = (result: unknown, status: number = HTTP_STATUS.OK) => {
        response
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(result));
      };
      const id = endpoint.id!;
      if (!writing) {
        const cursor = url.searchParams.get('cursor') ?? undefined;
        if (endpoint.kind === 'authGet') return send(await authentication!.get(actor, id));
        if (endpoint.kind === 'groups')
          return send(await service.groups(actor, type, limit, cursor));
        if (endpoint.kind === 'materials')
          return send(await service.materials(actor, id, limit, cursor));
        if (endpoint.kind === 'group') return send(await service.group(actor, id));
        if (endpoint.kind === 'material') return send(await service.material(actor, id));
        return send(await service.operation(actor, id));
      }
      if (endpoint.kind === 'authRefresh') return send(await authentication!.refresh(actor, id));
      if (endpoint.kind === 'sync') {
        if ('cursor' in body && typeof body.cursor !== 'string')
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        return send(await service.sync(actor, id, body.cursor as string | undefined));
      }
      if (endpoint.kind === 'refresh') return send(await service.refresh(actor, id));
      if (endpoint.kind === 'group') {
        if (!revision(body.revision) || !validName(body.name))
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        return send(await service.rename(actor, id, body.revision, body.name));
      }
      if (typeof body.requestId !== 'string' || !isUuidV4(body.requestId))
        return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      if (endpoint.kind === 'authCreate') {
        if (body.source !== 'materials' || body.returnTarget !== 'materials')
          return fail(400, 'BODY_INVALID');
        const result = await authentication!.create(
          actor,
          body.requestId,
          'materials',
          'materials',
        );
        return send(
          result,
          ['pending', 'completed'].includes(result.state)
            ? HTTP_STATUS.CREATED
            : HTTP_STATUS.ACCEPTED,
        );
      }
      if (endpoint.kind === 'materials') {
        if (
          typeof body.assetId !== 'string' ||
          !isUuidV4(body.assetId) ||
          ('name' in body && !validName(body.name))
        )
          return fail(400, 'BODY_INVALID');
        const result = await service.register(
          actor,
          id,
          body.requestId,
          body.assetId,
          body.name as string | undefined,
        );
        return send(
          result,
          result.operation.state === 'succeeded' ? HTTP_STATUS.CREATED : HTTP_STATUS.ACCEPTED,
        );
      }
      if (endpoint.kind === 'groups') {
        if (body.type !== 'aigc' || !validName(body.name))
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        const result = await service.createGroup(actor, body.requestId, body.name);
        return send(
          result,
          result.operation.state === 'succeeded' ? HTTP_STATUS.CREATED : HTTP_STATUS.ACCEPTED,
        );
      }
      if (!revision(body.revision) || (body.scope !== 'local' && body.scope !== 'upstream'))
        return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      const result = await service.remove(
        actor,
        endpoint.kind === 'deleteGroup' ? 'group' : 'material',
        id,
        body.requestId,
        body.revision,
        body.scope,
      );
      return send(
        result,
        'operation' in result && result.operation.state !== 'succeeded'
          ? HTTP_STATUS.ACCEPTED
          : HTTP_STATUS.OK,
      );
    } catch (error) {
      if (
        error instanceof AssetError ||
        error instanceof MaterialError ||
        error instanceof ProviderError ||
        error instanceof RequestBodyError
      )
        return fail(error.status, error.code);
      return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'MATERIAL_UNAVAILABLE');
    }
  };
}
