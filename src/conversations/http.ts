import { HTTP_STATUS } from '@mio/foundation/http-status';
import { isUuidV4 } from '@mio/foundation/identifiers';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, RequestBodyError } from '../http-request.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { ConversationError } from './contracts.ts';
import type { Principal, ConversationEvent, ConversationSnapshot, Receipt } from './contracts.ts';
import type { ConversationService } from './service.ts';
import { createSseRegistry } from './sse-registry.ts';

const MAX_BODY = 16 * 1024;
const MAX_STREAM_BUFFER = 64 * 1024;
const requestIdPattern = /^[A-Za-z0-9_-]{1,80}$/;
type Identity = (headers: Headers) => Promise<Principal | null>;

function coveredBySnapshot(baseline: Receipt | null, receipt: Receipt): boolean {
  if (baseline?.requestId !== receipt.requestId) return false;
  if (baseline.status === receipt.status) {
    return receipt.error === undefined || baseline.error !== undefined;
  }
  return (
    receipt.status === 'accepted' ||
    (receipt.status === 'input-persisted' && baseline.status !== 'accepted')
  );
}

function integer(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  if (
    !/^-?\d+$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < min ||
    Number(raw) > max
  )
    throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
  return Number(raw);
}

/** Install cleanup before authentication or storage can suspend a stream open. */
async function streamConversation({
  service,
  registry,
  streams,
  request,
  response,
  id,
  headers,
  fail,
}: {
  service: ConversationService;
  registry: ReturnType<typeof createSseRegistry>;
  streams: Set<() => void>;
  request: IncomingMessage;
  response: ServerResponse;
  id: string;
  headers: Headers;
  fail: (status: number, code: string) => void;
}) {
  const stop = new AbortController();
  let reservation: ReturnType<typeof registry.reserve> | undefined;
  let subscription: Awaited<ReturnType<ConversationService['subscribe']>> | undefined;
  let closed = false;
  let started = false;
  let errored = false;
  let baseline: Receipt | null = null;
  const queued: { data: string; receipt?: Receipt }[] = [];
  let queuedBytes = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    stop.abort();
    subscription?.close();
    reservation?.release();
    queued.length = 0;
    streams.delete(close);
    response.removeListener('close', close);
    request.removeListener('aborted', close);
    if (!response.destroyed && !response.writableEnded) response.end();
  };
  const overflow = () => {
    response.destroy();
    close();
  };
  const sendFrame = (data: string) => {
    if (closed || response.destroyed || response.writableEnded) return close();
    response.write(data);
    if (response.writableLength > MAX_STREAM_BUFFER) overflow();
  };
  const write = (event: ConversationEvent | ({ type: 'snapshot' } & ConversationSnapshot)) => {
    if (closed || response.destroyed || response.writableEnded) return close();
    if (event.type === 'state' && coveredBySnapshot(baseline, event.receipt)) return;
    const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    const bytes = Buffer.byteLength(data);
    if (bytes > MAX_STREAM_BUFFER) return overflow();
    if (!started) {
      queuedBytes += bytes;
      if (queuedBytes > MAX_STREAM_BUFFER) return overflow();
      queued.push(event.type === 'state' ? { data, receipt: event.receipt } : { data });
      if (event.type === 'error') errored = true;
      return;
    }
    sendFrame(data);
    if (event.type === 'error') close();
  };
  const authFailure = (code: 'UNAUTHORIZED' | 'AUTH_UNAVAILABLE') => {
    if (closed) return;
    try {
      if (response.headersSent) write({ type: 'error', code });
      else
        fail(
          code === 'UNAUTHORIZED' ? HTTP_STATUS.UNAUTHORIZED : HTTP_STATUS.SERVICE_UNAVAILABLE,
          code,
        );
    } finally {
      close();
    }
  };
  try {
    reservation = registry.reserve(headers, authFailure);
    streams.add(close);
    response.once('close', close);
    request.once('aborted', close);
    if (response.destroyed || request.aborted) return close();
    const actor = await reservation.identify(stop.signal);
    if (closed) return;
    if (!actor) throw new ConversationError(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
    reservation.bind(actor);
    // Events during snapshot/ownership awaits retain the existing bounded snapshot buffer.
    const installed = await service.subscribe(actor, id, write, stop.signal);
    subscription = installed;
    if (closed || response.destroyed) {
      installed.close();
      close();
      return;
    }
    response.writeHead(HTTP_STATUS.OK, {
      'content-type': 'text/event-stream',
      'x-accel-buffering': 'no',
    });
    response.flushHeaders();
    started = true;
    baseline = installed.snapshot.receipt;
    write({ type: 'snapshot', ...installed.snapshot });
    for (const { data, receipt } of queued) {
      if (!receipt || !coveredBySnapshot(baseline, receipt)) sendFrame(data);
    }
    queued.length = 0;
    if (response.destroyed || response.writableEnded || closed || errored) close();
  } catch (error) {
    if (!closed && !response.destroyed && !response.writableEnded && !response.headersSent) {
      const known = error instanceof ConversationError;
      fail(
        known ? error.status : HTTP_STATUS.SERVICE_UNAVAILABLE,
        known ? error.code : 'CONVERSATION_UNAVAILABLE',
      );
    }
    close();
  }
}

/** HTTP owns identity rechecks, browser policy and bounded transient stream resources. */
export function createConversationHandler(
  service: ConversationService,
  identity: Identity,
  origins: readonly string[],
) {
  const allowed = new Set(origins);
  const streams = new Set<() => void>();
  const registry = createSseRegistry(identity);
  let stopping = false;
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const transportRequestId = startHttpResponse(response);
    const fail = (status: number, code: string) =>
      writeApiError(
        response,
        status,
        { code, message: code, requestId: transportRequestId },
        'application/json',
      );
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
      const parts = url.pathname.split('/').slice(4);
      const base = url.pathname === '/api/v1/conversations';
      const id = parts[0];
      const action = parts[1];
      const receiptId = parts[2];
      let method: string | undefined;
      if (base) method = request.method === 'POST' ? 'POST' : 'GET';
      else if (id && isUuidV4(id) && parts.length === 2 && action === 'model') method = 'PUT';
      else if (
        id &&
        isUuidV4(id) &&
        parts.length === 2 &&
        ['history', 'events'].includes(action ?? '')
      )
        method = 'GET';
      else if (
        id &&
        isUuidV4(id) &&
        parts.length === 2 &&
        ['messages', 'cancel'].includes(action ?? '')
      )
        method = 'POST';
      else if (
        id &&
        isUuidV4(id) &&
        action === 'requests' &&
        receiptId &&
        requestIdPattern.test(receiptId) &&
        parts.length === 3
      )
        method = 'GET';
      if (!method) return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      if (request.method === 'OPTIONS') {
        if (!origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
        response.writeHead(HTTP_STATUS.NO_CONTENT, {
          'access-control-allow-methods': base ? 'GET, POST, OPTIONS' : `${method}, OPTIONS`,
          'access-control-allow-headers': 'Content-Type',
        });
        response.end();
        return;
      }
      if (request.method !== method) {
        response.setHeader('allow', base ? 'GET, POST, OPTIONS' : `${method}, OPTIONS`);
        return fail(HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED');
      }
      if (method !== 'GET' && !origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
      if (
        method !== 'GET' &&
        request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json'
      )
        return fail(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, 'JSON_REQUIRED');
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      if (action === 'events') {
        if (stopping) return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'CONVERSATION_UNAVAILABLE');
        return streamConversation({
          service,
          registry,
          streams,
          request,
          response,
          id: id!,
          headers,
          fail,
        });
      }
      let actor = await identity(headers);
      if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      const value = method !== 'GET' ? await readJsonBody(request, MAX_BODY) : {};
      if (method !== 'GET') {
        actor = await identity(headers);
        if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      }
      const expected =
        action === 'messages'
          ? ['requestId', 'text', 'imageAssetIds']
          : (base && method === 'POST') || action === 'model'
            ? ['modelRef']
            : [];
      if (Object.keys(value).some((key) => !expected.includes(key)))
        return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      const send = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (
        ((base && method === 'POST') || action === 'model') &&
        value.modelRef !== undefined &&
        (typeof value.modelRef !== 'string' ||
          !value.modelRef ||
          Buffer.byteLength(value.modelRef) > 512)
      )
        return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      if (base && method === 'POST')
        return send(
          HTTP_STATUS.CREATED,
          await service.create(actor, value.modelRef as string | undefined),
        );
      if (action === 'model') {
        if (typeof value.modelRef !== 'string')
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        return send(HTTP_STATUS.OK, await service.bind(actor, id!, value.modelRef));
      }
      if (base) {
        const after = url.searchParams.get('after') ?? undefined;
        if (after && !isUuidV4(after)) return fail(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
        return send(
          HTTP_STATUS.OK,
          await service.list(actor, after, integer(url.searchParams.get('limit'), 20, 1, 100)),
        );
      }
      if (action === 'history')
        return send(
          HTTP_STATUS.OK,
          await service.history(
            actor,
            id!,
            integer(url.searchParams.get('afterSeq'), -1, -1, Number.MAX_SAFE_INTEGER),
            integer(url.searchParams.get('limit'), 20, 1, 100),
          ),
        );
      if (action === 'requests')
        return send(HTTP_STATUS.OK, await service.request(actor, id!, receiptId!));
      if (action === 'messages') {
        if (
          typeof value.requestId !== 'string' ||
          !requestIdPattern.test(value.requestId) ||
          typeof value.text !== 'string' ||
          !value.text.trim() ||
          Buffer.byteLength(value.text) > MAX_BODY ||
          (value.imageAssetIds !== undefined &&
            (!Array.isArray(value.imageAssetIds) ||
              value.imageAssetIds.length > 4 ||
              value.imageAssetIds.some(
                (assetId: unknown) => typeof assetId !== 'string' || !isUuidV4(assetId),
              ) ||
              new Set(value.imageAssetIds).size !== value.imageAssetIds.length))
        )
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        return send(
          HTTP_STATUS.ACCEPTED,
          await service.send(
            actor,
            id!,
            value.requestId,
            value.text,
            value.imageAssetIds as string[] | undefined,
          ),
        );
      }
      if (action === 'cancel') return send(HTTP_STATUS.ACCEPTED, await service.cancel(actor, id!));
    } catch (error) {
      if (response.writableEnded || response.destroyed) return;
      if (response.headersSent) {
        response.end();
        return;
      }
      const known = error instanceof ConversationError || error instanceof RequestBodyError;
      fail(
        known ? error.status : HTTP_STATUS.SERVICE_UNAVAILABLE,
        known ? error.code : 'CONVERSATION_UNAVAILABLE',
      );
    }
  };
  return {
    handler,
    close: () => {
      stopping = true;
      for (const close of streams) close();
    },
  };
}
