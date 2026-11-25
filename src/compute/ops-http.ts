import { parseWorkerInstanceId, parseWorkerLimits } from '@mio/compute-contracts';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { epochMs } from '@mio/foundation/time';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, RequestBodyError } from '../http-request.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { WorkerOpsError } from './worker-observability-control.ts';
import type { WorkerControlStore } from './worker-observability-control.ts';
import { workerExecutionStates } from './worker-observability-queries.ts';
import type {
  WorkerExecutionFilters,
  WorkerObservabilityQueries,
} from './worker-observability-queries.ts';

const base = '/api/v1/admin/compute';
const prefix = `${base}/`;
const maxHistoryMs = 7 * 24 * 60 * 60_000;
const hourMs = 60 * 60_000;
const routes = new Set(['summary', 'workers', 'executions', 'history', 'limits']);
interface ComputeAdminActor {
  readonly id: string;
  readonly username: string;
  readonly sessionId: string;
}
type AdminIdentity = (headers: Headers) => Promise<ComputeAdminActor | null>;
type Readings = Pick<
  WorkerObservabilityQueries,
  'summary' | 'workers' | 'worker' | 'executions' | 'execution' | 'history' | 'limits'
>;

function queryInvalid(): never {
  throw new WorkerOpsError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
}

function page(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) return queryInvalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) return queryInvalid();
  return number;
}

function checkQuery(params: URLSearchParams, keys: string[]): void {
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (!keys.includes(key) || !value || seen.has(key)) queryInvalid();
    seen.add(key);
  }
}

function queryInstance(value: string | null) {
  if (value === null) return undefined;
  try {
    return parseWorkerInstanceId(value);
  } catch {
    return queryInvalid();
  }
}

function utcTime(value: string | null, fallback: number): Date {
  if (value === null) return new Date(fallback);
  const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.exec(value);
  const timestamp = new Date(value);
  if (
    !utc ||
    !Number.isFinite(timestamp.getTime()) ||
    timestamp.toISOString() !== (utc[1] ? value : value.slice(0, -1) + '.000Z')
  )
    return queryInvalid();
  return timestamp;
}

function readRoute(
  service: Readings,
  section: string,
  id: string | undefined,
  params: URLSearchParams,
) {
  if (id || section === 'summary') {
    checkQuery(params, []);
    if (section === 'summary') return service.summary();
    return section === 'workers' ? service.worker(id!) : service.execution(id!);
  }
  if (section === 'workers') {
    checkQuery(params, ['limit', 'offset']);
    return service.workers(
      page(params.get('limit'), 32, 1, 64),
      page(params.get('offset'), 0, 0, 64),
    );
  }
  if (section === 'history') {
    checkQuery(params, ['instanceId', 'since', 'until', 'limit']);
    const now = epochMs();
    const until = utcTime(params.get('until'), now);
    const since = utcTime(params.get('since'), until.getTime() - hourMs);
    if (since >= until || until.getTime() - since.getTime() > maxHistoryMs) return queryInvalid();
    return service.history(
      queryInstance(params.get('instanceId')),
      since,
      until,
      page(params.get('limit'), 720, 1, 1000),
    );
  }
  if (section === 'limits') {
    checkQuery(params, ['instanceId', 'limit']);
    return service.limits(
      queryInstance(params.get('instanceId')),
      page(params.get('limit'), 40, 1, 100),
    );
  }
  checkQuery(params, ['instanceId', 'jobId', 'state', 'limit']);
  const instanceId = queryInstance(params.get('instanceId'));
  const jobId = params.get('jobId');
  const rawState = params.get('state');
  const state = workerExecutionStates.find((candidate) => candidate === rawState);
  if ((rawState !== null && !state) || (jobId !== null && !isUuidV4(jobId))) return queryInvalid();
  const filters: WorkerExecutionFilters = { limit: page(params.get('limit'), 40, 1, 100) };
  if (instanceId) filters.instanceId = instanceId;
  if (jobId) filters.jobId = jobId;
  if (state) filters.state = state;
  return service.executions(filters);
}

function instanceIdValid(value: string): boolean {
  try {
    parseWorkerInstanceId(value);
    return true;
  } catch {
    return false;
  }
}

function limitBody(value: Record<string, unknown>) {
  const { expectedRevision, ...limits } = value;
  try {
    if (
      typeof expectedRevision !== 'number' ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    )
      throw new Error();
    return { expectedRevision, limits: parseWorkerLimits(limits) };
  } catch {
    throw new WorkerOpsError(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
  }
}

export function createComputeOpsHandler(
  service: Readings,
  control: Pick<WorkerControlStore, 'request'>,
  identity: AdminIdentity,
  origins: readonly string[],
  wake: () => void,
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
      if (url.pathname !== base && !url.pathname.startsWith(prefix))
        return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      if (request.method === 'OPTIONS') {
        if (!origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
        response
          .writeHead(HTTP_STATUS.NO_CONTENT, {
            'access-control-allow-methods': 'GET, PUT, OPTIONS',
            'access-control-allow-headers': 'Content-Type',
          })
          .end();
        return;
      }
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      const actor = await identity(headers);
      if (!actor?.sessionId) return fail(HTTP_STATUS.UNAUTHORIZED, 'ADMIN_UNAUTHORIZED');

      if (!url.pathname.startsWith(prefix)) return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      const parts = url.pathname.slice(prefix.length).split('/');
      const [section, id, action] = parts;
      const write = parts.length === 3 && section === 'workers' && id && action === 'limits';
      const detail =
        parts.length === 2 &&
        id &&
        ((section === 'workers' && instanceIdValid(id)) ||
          (section === 'executions' && isUuidV4(id)));
      if (
        !(parts.length === 1 && section && routes.has(section)) &&
        !detail &&
        !(write && instanceIdValid(id))
      )
        return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      const method = write ? 'PUT' : 'GET';

      if (request.method !== method) {
        response.setHeader('allow', method + ', OPTIONS');
        return fail(HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED');
      }
      if (write) {
        checkQuery(url.searchParams, []);
        if (!origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
        if (
          request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !==
          'application/json'
        )
          return fail(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, 'JSON_REQUIRED');
        const body = await readJsonBody(request, 4096, true);
        const confirmed = await identity(headers);
        if (
          !confirmed?.sessionId ||
          confirmed.id !== actor.id ||
          confirmed.sessionId !== actor.sessionId
        )
          return fail(HTTP_STATUS.UNAUTHORIZED, 'ADMIN_UNAUTHORIZED');
        const { expectedRevision, limits } = limitBody(body);
        const pending = await control.request(id, confirmed.username, expectedRevision, limits);
        wake();
        response
          .writeHead(HTTP_STATUS.ACCEPTED, { 'content-type': 'application/json' })
          .end(JSON.stringify(pending));
        return;
      }
      const result = await readRoute(service, section!, id, url.searchParams);
      if (result === null) return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      response
        .writeHead(HTTP_STATUS.OK, { 'content-type': 'application/json' })
        .end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof WorkerOpsError || error instanceof RequestBodyError)
        return fail(error.status, error.code);
      return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_OPS_UNAVAILABLE');
    }
  };
}
