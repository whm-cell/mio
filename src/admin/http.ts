import { HTTP_STATUS } from '@mio/foundation/http-status';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RequestBodyError, readJsonBody } from '../http-request.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { AdminError } from './contracts.ts';
import type { AdminPrincipal } from './contracts.ts';
import type { AdminService } from './service.ts';
import { announcementMethods, handleAnnouncementRequest } from './announcements.ts';
import { NotificationError } from '../notifications/contracts.ts';
import type { NotificationService } from '../notifications/service.ts';

const ADMIN_BASE = '/api/v1/admin';
const COOKIE_NAME = 'mio.admin_session';
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_BODY_LIMIT = 16_384;
const ROUTE_IMPORT_BODY_LIMIT = 65_536;
const MODEL_IMPORT_BODY_LIMIT = 262_144;

const ERROR_MESSAGES: Record<string, string> = {
  ADMIN_UNAUTHORIZED: 'Administrator session is required',
  ADMIN_INVALID_CREDENTIALS: 'Invalid administrator username or password',
  ADMIN_PASSWORD_MISMATCH: 'Current password is incorrect',
  ADMIN_USERNAME_TAKEN: 'Username is already taken',
  ADMIN_INPUT_INVALID: 'Administrator request input is invalid',
  ADMIN_UNAVAILABLE: 'Administrator service is unavailable',
  COMPUTE_OPS_UNAVAILABLE: 'Compute worker observability service is unavailable',
  MODEL_ALREADY_EXISTS: 'Model ID already exists in platform catalog',
  MODEL_NOT_FOUND: 'Target model was not found in platform catalog',
  TEMPLATE_KEY_TAKEN: 'Template key already exists',
  TEMPLATE_NOT_FOUND: 'Target route template was not found',
  SETTINGS_CONFLICT: 'Global settings were modified concurrently; reload and retry',
  ONELINK_SSO_NOT_CONFIGURED: 'OneLink SSO environment configuration is incomplete',
  ONELINK_REGISTER_IN_PROGRESS: 'A OneLink SSO client registration is already in progress',
  ONELINK_SSO_UNAVAILABLE: 'OneLink SSO is not configured on this server',
  PROBE_KEY_REQUIRED: 'Provide an API key or save a probe key first',
  PROBE_CREDENTIAL_UNAVAILABLE: 'Saved probe credential cannot be decrypted',
  PROVIDER_KEY_INVALID: 'OneLink API key format is invalid',
  ROUTE_INVALID: 'Model route specification is invalid',
  ROUTE_NOT_FOUND: 'Target model route was not found',
  REVISION_NOT_FOUND: 'Target route revision was not found',
  REVISION_NOT_RESTORABLE: 'Delete revision has no restorable route snapshot',
  QUERY_INVALID: 'Query parameters are invalid',
  BODY_INVALID: 'Request body must be a JSON object',
  BODY_TOO_LARGE: 'Request body exceeds the allowed size',
  BODY_TIMEOUT: 'Request body read timed out',
  JSON_REQUIRED: 'Content-Type must be application/json',
  ORIGIN_DENIED: 'Request origin is not permitted',
  ORIGIN_REQUIRED: 'Origin header is required',
  METHOD_NOT_ALLOWED: 'HTTP method is not allowed for this endpoint',
  NOT_FOUND: 'Endpoint not found',
};

function parseCookie(header: string | undefined, targetName: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== targetName) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function readAdminSessionCookie(header: string | null | undefined): string | null {
  return parseCookie(header ?? undefined, COOKIE_NAME);
}

function shouldSetSecureCookie(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function formatSessionCookie(token: string, maxAge: number, secure: boolean): string {
  const attributes = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/api/v1/admin',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const mediaType = value.split(';')[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

function setCorsHeaders(response: ServerResponse, origin: string | undefined): void {
  if (!origin) return;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Vary', 'Origin');
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function assertExactKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'ADMIN_INPUT_INVALID');
    }
  }
}

function assertAllowedQuery(url: URL, allowed: readonly string[]): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) {
      throw new AdminError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
    }
  }
}

const KNOWN_ROUTES: Record<string, readonly string[]> = {
  '/auth/login': ['POST'],
  '/auth/logout': ['POST'],
  '/auth/me': ['GET'],
  '/account': ['PATCH'],
  '/onelink/probe': ['GET', 'DELETE'],
  '/onelink/discover': ['POST'],
  '/onelink/candidates': ['GET'],
  '/onelink/sso': ['GET', 'PATCH'],
  '/onelink/sso/register': ['POST'],
  '/models': ['GET', 'POST', 'PATCH', 'DELETE'],
  '/models/import': ['POST'],
  '/routes': ['POST', 'DELETE'],
  '/routes/rollback': ['POST'],
  '/templates': ['GET', 'POST', 'PUT', 'DELETE'],
  '/revisions': ['GET'],
  '/monitoring': ['GET'],
  '/settings/global': ['GET', 'PATCH'],
  '/settings/creation-logs': ['GET', 'PATCH'],
  '/settings/storage': ['GET', 'PATCH'],
};

interface RouteContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly rawOrigin: string | undefined;
  readonly service: AdminService;
  readonly requireAdmin: () => Promise<AdminPrincipal>;
  readonly readAuthJson: (
    allowedKeys: readonly string[],
    maxBytes?: number,
  ) => Promise<{ principal: AdminPrincipal; body: Record<string, unknown> }>;
}

const MODEL_MUTATION_KEYS = [
  'rawModelId',
  'displayLabel',
  'vendorLabel',
  'category',
  'description',
  'userVisible',
  'allowUndiscovered',
  'callNotes',
] as const;

const TEMPLATE_CREATE_KEYS = [
  'templateKey',
  'label',
  'description',
  'sortOrder',
  'routeTemplate',
  'uiHints',
] as const;

const TEMPLATE_UPDATE_KEYS = ['id', ...TEMPLATE_CREATE_KEYS] as const;

const ROUTE_HANDLERS: Record<string, (ctx: RouteContext) => Promise<void>> = {
  'POST /auth/login': async ({ request, response, rawOrigin, service }) => {
    if (!isJsonContentType(request.headers['content-type'])) {
      throw new AdminError(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, 'JSON_REQUIRED');
    }
    const body = await readJsonBody(request, DEFAULT_BODY_LIMIT);
    assertExactKeys(body, ['username', 'password']);
    const { admin, sessionToken } = await service.login(body.username, body.password);
    response.setHeader(
      'Set-Cookie',
      formatSessionCookie(sessionToken, SESSION_MAX_AGE_SECONDS, shouldSetSecureCookie(rawOrigin)),
    );
    sendJson(response, HTTP_STATUS.OK, { admin });
  },

  'POST /auth/logout': async ({ request, response, rawOrigin, service }) => {
    if (!isJsonContentType(request.headers['content-type'])) {
      throw new AdminError(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, 'JSON_REQUIRED');
    }
    const body = await readJsonBody(request, DEFAULT_BODY_LIMIT);
    assertExactKeys(body, []);
    const token = readAdminSessionCookie(request.headers.cookie);
    await service.logout(token);
    response.setHeader('Set-Cookie', formatSessionCookie('', 0, shouldSetSecureCookie(rawOrigin)));
    sendJson(response, HTTP_STATUS.OK, { ok: true });
  },

  'GET /auth/me': async ({ response, url, requireAdmin }) => {
    assertAllowedQuery(url, []);
    const principal = await requireAdmin();
    sendJson(response, HTTP_STATUS.OK, { admin: principal.admin });
  },

  'PATCH /account': async ({ response, service, readAuthJson }) => {
    const { principal, body } = await readAuthJson(['username', 'currentPassword', 'newPassword']);
    const admin = await service.updateAccount(principal, body);
    sendJson(response, HTTP_STATUS.OK, { admin });
  },

  'GET /onelink/probe': async ({ response, url, service, requireAdmin }) => {
    assertAllowedQuery(url, []);
    await requireAdmin();
    sendJson(response, HTTP_STATUS.OK, await service.getProbeStatus());
  },

  'DELETE /onelink/probe': async ({ response, service, requireAdmin }) => {
    const principal = await requireAdmin();
    await service.clearProbeKey(principal);
    sendJson(response, HTTP_STATUS.OK, { ok: true });
  },

  'POST /onelink/discover': async ({ response, service, readAuthJson }) => {
    const { principal, body } = await readAuthJson(['apiKey', 'saveKey']);
    sendJson(response, HTTP_STATUS.OK, await service.discoverOneLink(principal, body));
  },

  'GET /onelink/candidates': async ({ response, url, service, requireAdmin }) => {
    assertAllowedQuery(url, []);
    await requireAdmin();
    sendJson(response, HTTP_STATUS.OK, await service.listDiscoveryCandidates());
  },

  'GET /onelink/sso': async ({ response, url, service, requireAdmin }) => {
    assertAllowedQuery(url, []);
    await requireAdmin();
    sendJson(response, HTTP_STATUS.OK, await service.getOneLinkSso());
  },

  'PATCH /onelink/sso': async ({ response, service, readAuthJson }) => {
    const { principal, body } = await readAuthJson([
      'expectedRevision',
      'enabled',
      'expectedClientId',
    ]);
    sendJson(response, HTTP_STATUS.OK, await service.updateOneLinkSso(principal, body));
  },

  'POST /onelink/sso/register': async ({ response, service, readAuthJson }) => {
    const { principal } = await readAuthJson([]);
    sendJson(response, HTTP_STATUS.OK, await service.registerOneLinkSso(principal));
  },

  'GET /models': async ({ response, url, service, requireAdmin }) => {
    assertAllowedQuery(url, ['q', 'category', 'status', 'visibility']);
    await requireAdmin();
    const result = await service.listModels({
      ...(url.searchParams.has('q') ? { q: url.searchParams.get('q')! } : {}),
      ...(url.searchParams.has('category') ? { category: url.searchParams.get('category')! } : {}),
      ...(url.searchParams.has('status') ? { status: url.searchParams.get('status')! } : {}),
      ...(url.searchParams.has('visibility')
        ? { visibility: url.searchParams.get('visibility')! }
        : {}),
    });
    sendJson(response, HTTP_STATUS.OK, result);
  },

  'POST /models': async ({ response, service, readAuthJson }) => {
    const { principal, body } = await readAuthJson(MODEL_MUTATION_KEYS);
    sendJson(response, HTTP_STATUS.CREATED, await service.createModel(principal, body));
  },

  'PATCH /models': async ({ response, service, readAuthJson }) => {
    const { principal, body } = await readAuthJson(MODEL_MUTATION_KEYS);
    sendJson(response, HTTP_STATUS.OK, await service.updateModel(principal, body));
  },

  'DELETE /models': async ({ response, service, readAuthJson }) => {
    const { principal, body } = await readAuthJson([
      'rawModelId',
      'ignoreFutureImports',
      'summary',
    ]);
    sendJson(response, HTTP_STATUS.OK, await service.deleteModel(principal, body));
  },

  'POST /models/import': async ({ response, service, readAuthJson }) => {
    const { principal, body } = await readAuthJson(
      ['items', 'overwriteMetadata'],
      MODEL_IMPORT_BODY_LIMIT,
    );
    sendJson(response, HTTP_STATUS.OK, await service.importModels(principal, body));
  },

  'POST /routes': async ({ response, service, readAuthJson }) => {
    const { principal, body } = await readAuthJson(
      ['route', 'routes', 'summary'],
      ROUTE_IMPORT_BODY_LIMIT,
    );
    sendJson(response, HTTP_STATUS.OK, await service.publishRoutes(principal, body));
  },

  'DELETE /routes': async ({ response, service, readAuthJson }) => {
    const { principal, body } = await readAuthJson(['rawModelId', 'operation', 'summary']);
    sendJson(response, HTTP_STATUS.OK, await service.deleteRoute(principal, body));
  },

  'POST /routes/rollback': async ({ response, service, readAuthJson }) => {
    const { principal, body } = await readAuthJson(['revisionId', 'summary']);
    sendJson(response, HTTP_STATUS.OK, await service.rollbackRoute(principal, body));
  },

  'GET /templates': async ({ response, url, service, requireAdmin }) => {
    assertAllowedQuery(url, []);
    await requireAdmin();
    sendJson(response, HTTP_STATUS.OK, await service.listTemplates());
  },

  'POST /templates': async ({ response, service, readAuthJson }) => {
    const { principal, body } = await readAuthJson(TEMPLATE_CREATE_KEYS, ROUTE_IMPORT_BODY_LIMIT);
    sendJson(response, HTTP_STATUS.CREATED, await service.createTemplate(principal, body));
  },

  'PUT /templates': async ({ response, service, readAuthJson }) => {
    const { principal, body } = await readAuthJson(TEMPLATE_UPDATE_KEYS, ROUTE_IMPORT_BODY_LIMIT);
    sendJson(response, HTTP_STATUS.OK, await service.updateTemplate(principal, body));
  },

  'DELETE /templates': async ({ response, service, readAuthJson }) => {
    const { principal, body } = await readAuthJson(['id']);
    sendJson(response, HTTP_STATUS.OK, await service.deleteTemplate(principal, body));
  },

  'GET /revisions': async ({ response, url, service, requireAdmin }) => {
    assertAllowedQuery(url, ['rawModelId', 'limit']);
    await requireAdmin();
    sendJson(
      response,
      HTTP_STATUS.OK,
      await service.listRevisions(
        url.searchParams.get('rawModelId') ?? undefined,
        url.searchParams.get('limit') ?? undefined,
      ),
    );
  },

  'GET /monitoring': async ({ response, url, service, requireAdmin }) => {
    assertAllowedQuery(url, ['window']);
    await requireAdmin();
    sendJson(
      response,
      HTTP_STATUS.OK,
      await service.readMonitoring(url.searchParams.get('window') ?? undefined),
    );
  },

  'GET /settings/creation-logs': async ({ response, url, service, requireAdmin }) => {
    assertAllowedQuery(url, []);
    await requireAdmin();
    sendJson(response, HTTP_STATUS.OK, await service.getCreationLogSettings());
  },
  'PATCH /settings/creation-logs': async ({ response, service, readAuthJson }) => {
    const { principal, body } = await readAuthJson(['expectedRevision', 'retentionDays']);
    sendJson(response, HTTP_STATUS.OK, await service.updateCreationLogSettings(principal, body));
  },

  'GET /settings/storage': async ({ response, url, service, requireAdmin }) => {
    assertAllowedQuery(url, []);
    await requireAdmin();
    sendJson(response, HTTP_STATUS.OK, await service.getStorageSettings());
  },
  'PATCH /settings/storage': async ({ response, url, service, readAuthJson }) => {
    assertAllowedQuery(url, []);
    const { principal, body } = await readAuthJson([
      'expectedRevision',
      'quotaBytes',
      'warningAvailableBytes',
    ]);
    sendJson(response, HTTP_STATUS.OK, await service.updateStorageSettings(principal, body));
  },

  'GET /settings/global': async ({ response, url, service, requireAdmin }) => {
    assertAllowedQuery(url, []);
    await requireAdmin();
    sendJson(response, HTTP_STATUS.OK, await service.getGlobalSettings());
  },

  'PATCH /settings/global': async ({ response, service, readAuthJson }) => {
    const { principal, body } = await readAuthJson(['auth', 'expectedRevision']);
    sendJson(response, HTTP_STATUS.OK, await service.updateGlobalSettings(principal, body));
  },
};

export function createAdminHandler(
  service: AdminService,
  allowedOrigins: readonly string[],
  computeHandler?: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  notifications?: NotificationService,
) {
  const origins = new Set(allowedOrigins);

  return async function handleAdminRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let url: URL | null = null;
    try {
      url = new URL(request.url ?? '/', 'http://mio.local');
    } catch {
      url = null;
    }

    const subPath = !url
      ? null
      : url.pathname === ADMIN_BASE
        ? '/'
        : url.pathname.startsWith(`${ADMIN_BASE}/`)
          ? url.pathname.slice(ADMIN_BASE.length)
          : null;
    if (computeHandler && (subPath === '/compute' || subPath?.startsWith('/compute/'))) {
      await computeHandler(request, response);
      return;
    }

    const requestId = startHttpResponse(response);
    const fail = (status: number, code: string) => {
      writeApiError(
        response,
        status,
        { code, message: ERROR_MESSAGES[code] ?? 'Request failed', requestId },
        'application/json; charset=utf-8',
      );
    };

    const rawOrigin =
      typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
    if (rawOrigin !== undefined && !origins.has(rawOrigin)) {
      fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_DENIED');
      return;
    }

    if (!url) {
      fail(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
      return;
    }

    const requireAdmin = async (): Promise<AdminPrincipal> => {
      const token = readAdminSessionCookie(request.headers.cookie);
      const principal = await service.authenticate(token);
      if (!principal) throw new AdminError(HTTP_STATUS.UNAUTHORIZED, 'ADMIN_UNAUTHORIZED');
      return principal;
    };

    if (subPath === '/compute' || subPath?.startsWith('/compute/')) {
      const method = request.method ?? 'GET';
      if (method === 'OPTIONS') {
        if (!rawOrigin) {
          fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
          return;
        }
        setCorsHeaders(response, rawOrigin);
        response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        response.statusCode = HTTP_STATUS.NO_CONTENT;
        response.end();
        return;
      }
      setCorsHeaders(response, rawOrigin);
      try {
        await requireAdmin();
      } catch (error) {
        if (response.writableEnded) return;
        if (error instanceof AdminError) {
          fail(error.status, error.code);
          return;
        }
        fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ADMIN_UNAVAILABLE');
        return;
      }
      if (method !== 'GET' && !rawOrigin) {
        fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
        return;
      }
      fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_OPS_UNAVAILABLE');
      return;
    }
    const notificationMethods = subPath ? announcementMethods(subPath) : undefined;
    const methods = notificationMethods ?? (subPath ? KNOWN_ROUTES[subPath] : undefined);
    if (!methods) {
      fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      return;
    }

    const method = request.method ?? 'GET';
    if (method === 'OPTIONS') {
      if (!rawOrigin) {
        fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
        return;
      }
      setCorsHeaders(response, rawOrigin);
      response.setHeader('Access-Control-Allow-Methods', [...methods, 'OPTIONS'].join(', '));
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.statusCode = HTTP_STATUS.NO_CONTENT;
      response.end();
      return;
    }

    if (!methods.includes(method)) {
      fail(HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED');
      return;
    }

    if (method !== 'GET' && !rawOrigin) {
      fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
      return;
    }
    setCorsHeaders(response, rawOrigin);

    const readAuthJson = async (
      allowedKeys: readonly string[],
      maxBytes = DEFAULT_BODY_LIMIT,
    ): Promise<{ principal: AdminPrincipal; body: Record<string, unknown> }> => {
      if (!isJsonContentType(request.headers['content-type'])) {
        throw new AdminError(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, 'JSON_REQUIRED');
      }
      await requireAdmin();
      const body = await readJsonBody(request, maxBytes);
      const principal = await requireAdmin();
      assertExactKeys(body, allowedKeys);
      return { principal, body };
    };

    try {
      if (notificationMethods) {
        sendJson(
          response,
          method === 'POST' && subPath === '/announcements' ? HTTP_STATUS.CREATED : HTTP_STATUS.OK,
          await handleAnnouncementRequest(notifications, {
            url,
            method,
            requireAdmin,
            readAuthJson,
          }),
        );
        return;
      }
      const routeHandler = ROUTE_HANDLERS[`${method} ${subPath}`];
      if (!routeHandler) {
        fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
        return;
      }
      await routeHandler({
        request,
        response,
        url,
        rawOrigin,
        service,
        requireAdmin,
        readAuthJson,
      });
    } catch (error) {
      if (response.writableEnded) return;
      if (
        error instanceof RequestBodyError ||
        error instanceof AdminError ||
        error instanceof NotificationError
      ) {
        fail(error.status, error.code);
        return;
      }
      fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'ADMIN_UNAVAILABLE');
    }
  };
}
