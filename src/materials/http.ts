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
type MaterialAction =
  | { kind: 'listGroups'; method: 'GET' }
  | { kind: 'createGroup'; method: 'POST' }
  | {
      kind: 'getGroup' | 'listMaterials' | 'getMaterial' | 'getOperation';
      method: 'GET';
      id: string;
    }
  | { kind: 'renameGroup'; method: 'PATCH'; id: string }
  | {
      kind: 'syncGroup' | 'registerMaterial' | 'refreshMaterial' | 'deleteGroup' | 'deleteMaterial';
      method: 'POST';
      id: string;
    }
  | { kind: 'authCreate'; method: 'POST'; authentication: MaterialAuthService }
  | { kind: 'authGet'; method: 'GET'; id: string; authentication: MaterialAuthService }
  | { kind: 'authRefresh'; method: 'POST'; id: string; authentication: MaterialAuthService };

const bodyKeys: Record<Exclude<MaterialAction, { method: 'GET' }>['kind'], readonly string[]> = {
  authCreate: ['requestId', 'source', 'returnTarget'],
  authRefresh: [],
  createGroup: ['requestId', 'type', 'name'],
  renameGroup: ['revision', 'name'],
  syncGroup: ['cursor'],
  registerMaterial: ['requestId', 'assetId', 'name'],
  refreshMaterial: [],
  deleteGroup: ['requestId', 'revision', 'scope', 'confirmCascade'],
  deleteMaterial: ['requestId', 'revision', 'scope'],
};

function route(path: string, authentication?: MaterialAuthService): MaterialAction[] | undefined {
  if (authentication) {
    if (path === `${BASE}/auth-sessions`)
      return [{ kind: 'authCreate', method: 'POST', authentication }];
    const session = path.match(/^\/api\/v1\/materials\/auth-sessions\/([^/]+)(\/refresh)?$/);
    if (session?.[1] && isUuidV4(session[1])) {
      const id = session[1];
      return session[2]
        ? [{ kind: 'authRefresh', method: 'POST', id, authentication }]
        : [{ kind: 'authGet', method: 'GET', id, authentication }];
    }
  }
  if (path === `${BASE}/groups`)
    return [
      { kind: 'listGroups', method: 'GET' },
      { kind: 'createGroup', method: 'POST' },
    ];
  const match = path.match(
    /^\/api\/v1\/materials\/(groups|items|operations)\/([^/]+)(?:\/(sync|materials|refresh|delete))?$/,
  );
  if (!match || !match[2] || !isUuidV4(match[2])) return;
  const [, entity, , action] = match;
  const id = match[2];
  if (entity === 'groups' && !action)
    return [
      { kind: 'getGroup', method: 'GET', id },
      { kind: 'renameGroup', method: 'PATCH', id },
    ];
  if (entity === 'groups' && action === 'materials')
    return [
      { kind: 'listMaterials', method: 'GET', id },
      { kind: 'registerMaterial', method: 'POST', id },
    ];
  if (entity === 'groups' && action === 'sync') return [{ kind: 'syncGroup', method: 'POST', id }];
  if (entity === 'items' && !action) return [{ kind: 'getMaterial', method: 'GET', id }];
  if (entity === 'items' && action === 'refresh')
    return [{ kind: 'refreshMaterial', method: 'POST', id }];
  if ((entity === 'groups' || entity === 'items') && action === 'delete')
    return [{ kind: entity === 'groups' ? 'deleteGroup' : 'deleteMaterial', method: 'POST', id }];
  if (entity === 'operations' && !action) return [{ kind: 'getOperation', method: 'GET', id }];
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

/** Authenticated material routes share this entry with the exact public mobile paths. */
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
      if (status === 429)
        response.setHeader('retry-after', code === 'AUTH_QUERY_LIMITED' ? '3' : '4');
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
      const actions = route(url.pathname, authentication);
      if (!actions) return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      const action = actions.find(({ method }) => method === request.method);
      if (!action) {
        const methods = [...actions.map(({ method }) => method), 'OPTIONS'].join(', ');
        if (request.method !== 'OPTIONS') {
          response.setHeader('allow', methods);
          return fail(HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED');
        }
        if (!origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
        response
          .writeHead(HTTP_STATUS.NO_CONTENT, {
            'access-control-allow-methods': methods,
            'access-control-allow-headers': 'Content-Type',
          })
          .end();
        return;
      }
      const writing = action.method !== 'GET';
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
      const list = action.kind === 'listGroups' || action.kind === 'listMaterials';
      const queryKeys = list
        ? action.kind === 'listGroups'
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
      if (action.method !== 'GET') {
        const keys = bodyKeys[action.kind];
        if (Object.keys(body).some((key) => !keys.includes(key)))
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      }
      const send = (result: unknown, status: number = HTTP_STATUS.OK) => {
        response
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(result));
      };
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const mutationId =
        typeof body.requestId === 'string' && isUuidV4(body.requestId) ? body.requestId : undefined;
      switch (action.kind) {
        case 'authGet':
          return send(await action.authentication.get(actor, action.id));
        case 'listGroups':
          return send(await service.groups(actor, type, limit, cursor));
        case 'listMaterials':
          return send(await service.materials(actor, action.id, limit, cursor));
        case 'getGroup':
          return send(await service.group(actor, action.id));
        case 'getMaterial':
          return send(await service.material(actor, action.id));
        case 'getOperation':
          return send(await service.operation(actor, action.id));
        case 'authRefresh':
          return send(await action.authentication.refresh(actor, action.id));
        case 'syncGroup': {
          const syncCursor = body.cursor;
          if (syncCursor !== undefined && typeof syncCursor !== 'string')
            return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
          return send(await service.sync(actor, action.id, syncCursor));
        }
        case 'refreshMaterial':
          return send(await service.refresh(actor, action.id));
        case 'renameGroup':
          if (!revision(body.revision) || !validName(body.name))
            return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
          return send(await service.rename(actor, action.id, body.revision, body.name));
        case 'authCreate': {
          if (!mutationId || body.source !== 'materials' || body.returnTarget !== 'materials')
            return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
          const result = await action.authentication.create(
            actor,
            mutationId,
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
        case 'registerMaterial': {
          const { assetId, name } = body;
          if (
            !mutationId ||
            typeof assetId !== 'string' ||
            !isUuidV4(assetId) ||
            (name !== undefined && !validName(name))
          )
            return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
          const result = await service.register(actor, action.id, mutationId, assetId, name);
          return send(
            result,
            result.operation.state === 'succeeded' ? HTTP_STATUS.CREATED : HTTP_STATUS.ACCEPTED,
          );
        }
        case 'createGroup': {
          if (!mutationId || body.type !== 'aigc' || !validName(body.name))
            return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
          const result = await service.createGroup(actor, mutationId, body.name);
          return send(
            result,
            result.operation.state === 'succeeded' ? HTTP_STATUS.CREATED : HTTP_STATUS.ACCEPTED,
          );
        }
        case 'deleteGroup':
        case 'deleteMaterial': {
          if (
            !mutationId ||
            !revision(body.revision) ||
            (body.scope !== 'local' && body.scope !== 'upstream')
          )
            return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
          if (
            'confirmCascade' in body &&
            (body.scope !== 'upstream' || typeof body.confirmCascade !== 'boolean')
          )
            return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
          const result = await service.remove(
            actor,
            action.kind === 'deleteGroup' ? 'group' : 'material',
            action.id,
            mutationId,
            body.revision,
            body.scope,
            body.confirmCascade === true,
          );
          return send(
            result,
            'operation' in result && result.operation.state !== 'succeeded'
              ? HTTP_STATUS.ACCEPTED
              : HTTP_STATUS.OK,
          );
        }
      }
      return action satisfies never;
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
