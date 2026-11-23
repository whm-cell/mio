import { HTTP_STATUS } from '@mio/foundation/http-status';
import { isUuidV4 } from '@mio/foundation/identifiers';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, readBody, readJsonBody, RequestBodyError } from '../http-request.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { isChatReasoningEffort } from '../providers/contracts.ts';
import { ConversationError, MAX_CONVERSATION_TITLE_BYTES } from './contracts.ts';
import type { Principal, ConversationEvent, ConversationSnapshot } from './contracts.ts';
import { parseConversationCursor } from './cursor.ts';
import type { ConversationService } from './service.ts';
import { createSseRegistry } from './sse-registry.ts';

const MAX_CONTROL_BODY = 16 * 1024;
const MAX_MESSAGE_BODY = 256 * 1024;
const MAX_STREAM_BUFFER = 64 * 1024;
const requestIdPattern = /^[A-Za-z0-9_-]{1,80}$/;
type Identity = (headers: Headers) => Promise<Principal | null>;

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && requestIdPattern.test(value);
}

type StateEvent = Extract<ConversationEvent, { type: 'state' }>;
function coveredBySnapshot(
  baseline: ConversationSnapshot | undefined,
  { receipt, contextUsage }: StateEvent,
): boolean {
  const previous = baseline?.receipt;
  if (previous?.requestId !== receipt.requestId || (contextUsage && !baseline?.contextUsage))
    return false;
  if (previous.status === receipt.status) {
    return (
      (receipt.error === undefined || previous.error !== undefined) &&
      (receipt.truncation === undefined ||
        previous.truncation?.reason === receipt.truncation.reason)
    );
  }
  return (
    receipt.status === 'accepted' ||
    (receipt.status === 'input-persisted' && previous.status !== 'accepted')
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
  let baseline: ConversationSnapshot | undefined;
  const queued: { data: string; state?: StateEvent }[] = [];
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
    if (event.type === 'state' && coveredBySnapshot(baseline, event)) return;
    const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    const bytes = Buffer.byteLength(data);
    if (bytes > MAX_STREAM_BUFFER) return overflow();
    if (!started) {
      queuedBytes += bytes;
      if (queuedBytes > MAX_STREAM_BUFFER) return overflow();
      queued.push(event.type === 'state' ? { data, state: event } : { data });
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
    baseline = installed.snapshot;
    write({ type: 'snapshot', ...installed.snapshot });
    for (const { data, state } of queued) {
      if (!state || !coveredBySnapshot(baseline, state)) sendFrame(data);
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
      const validId = id !== undefined && isUuidV4(id);
      let methods: string[] | undefined;
      if (base) methods = ['GET', 'POST'];
      else if (validId && parts.length === 1) methods = ['PATCH', 'DELETE'];
      else if (validId && parts.length === 2 && action === 'model') methods = ['PUT'];
      else if (validId && parts.length === 2 && ['history', 'events'].includes(action ?? ''))
        methods = ['GET'];
      else if (
        validId &&
        parts.length === 2 &&
        ['messages', 'cancel', 'compact', 'forks'].includes(action ?? '')
      )
        methods = ['POST'];
      else if (validId && action === 'requests' && validRequestId(receiptId) && parts.length === 3)
        methods = ['GET'];
      if (!methods) return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      const method = request.method ?? '';
      const allow = [...methods, 'OPTIONS'].join(', ');
      if (method === 'OPTIONS') {
        if (!origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
        response.writeHead(HTTP_STATUS.NO_CONTENT, {
          'access-control-allow-methods': allow,
          'access-control-allow-headers': 'Content-Type',
        });
        response.end();
        return;
      }
      if (!methods.includes(method)) {
        response.setHeader('allow', allow);
        return fail(HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED');
      }
      const writing = method !== 'GET';
      const json = request.headers['content-type']?.split(';')[0]?.trim() === 'application/json';
      if (writing && !origin) return fail(HTTP_STATUS.FORBIDDEN, 'ORIGIN_REQUIRED');
      if (writing && method !== 'DELETE' && !json)
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
      let value: Record<string, unknown> = {};
      if (writing) {
        if (method === 'DELETE') {
          const bytes = await readBody(request, MAX_CONTROL_BODY);
          if (bytes.length) {
            if (!json) return fail(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, 'JSON_REQUIRED');
            value = parseJsonBody(bytes);
          }
        } else {
          value = await readJsonBody(
            request,
            action === 'messages' ? MAX_MESSAGE_BODY : MAX_CONTROL_BODY,
          );
        }
        actor = await identity(headers);
        if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      }
      const creating = base && method === 'POST';
      const expected =
        action === 'messages'
          ? ['requestId', 'text', 'imageAssetIds', 'reasoningEffort']
          : action === 'compact'
            ? ['requestId']
            : action === 'forks'
              ? ['requestId', 'turnEndSeq']
              : creating
                ? ['modelRef', 'purpose', 'reasoningEffort']
                : action === 'model'
                  ? ['modelRef']
                  : method === 'PATCH'
                    ? ['title']
                    : [];
      if (Object.keys(value).some((key) => !expected.includes(key)))
        return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      const reasoningEffort = value.reasoningEffort;
      if (reasoningEffort !== undefined && !isChatReasoningEffort(reasoningEffort))
        return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      const send = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (
        (creating || action === 'model') &&
        value.modelRef !== undefined &&
        (typeof value.modelRef !== 'string' ||
          !value.modelRef ||
          Buffer.byteLength(value.modelRef) > 512)
      )
        return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
      if (creating) {
        const { purpose } = value;
        if (purpose !== undefined && purpose !== 'general' && purpose !== 'drama-script')
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        return send(
          HTTP_STATUS.CREATED,
          await service.create(
            actor,
            value.modelRef as string | undefined,
            purpose,
            reasoningEffort,
          ),
        );
      }
      if (action === 'model') {
        if (typeof value.modelRef !== 'string')
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        return send(HTTP_STATUS.OK, await service.selectModel(actor, id!, value.modelRef));
      }
      if (method === 'PATCH') {
        if (
          typeof value.title !== 'string' ||
          !value.title.isWellFormed() ||
          !value.title.trim() ||
          Buffer.byteLength(value.title) > MAX_CONVERSATION_TITLE_BYTES
        )
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        return send(HTTP_STATUS.OK, await service.rename(actor, id!, value.title));
      }
      if (method === 'DELETE') return send(HTTP_STATUS.OK, await service.archive(actor, id!));
      if (base) {
        const after = parseConversationCursor(url.searchParams.get('after') ?? undefined);
        return send(
          HTTP_STATUS.OK,
          await service.list(actor, after, integer(url.searchParams.get('limit'), 20, 1, 100)),
        );
      }
      if (action === 'history') {
        const stop = new AbortController();
        const abort = () => stop.abort();
        request.once('aborted', abort);
        response.once('close', abort);
        if (request.aborted || response.destroyed) abort();
        try {
          return send(
            HTTP_STATUS.OK,
            await service.history(
              actor,
              id!,
              integer(url.searchParams.get('afterSeq'), -1, -1, Number.MAX_SAFE_INTEGER),
              integer(url.searchParams.get('limit'), 20, 1, 100),
              stop.signal,
            ),
          );
        } finally {
          request.removeListener('aborted', abort);
          response.removeListener('close', abort);
        }
      }
      if (action === 'requests')
        return send(HTTP_STATUS.OK, await service.request(actor, id!, receiptId!));
      if (action === 'forks') {
        const { requestId, turnEndSeq } = value;
        if (
          !validRequestId(requestId) ||
          (turnEndSeq !== undefined &&
            (typeof turnEndSeq !== 'number' || !Number.isSafeInteger(turnEndSeq) || turnEndSeq < 0))
        )
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        const { conversation, created } = await service.fork(actor, id!, requestId, turnEndSeq);
        return send(created ? HTTP_STATUS.CREATED : HTTP_STATUS.OK, conversation);
      }
      if (action === 'compact') {
        if (!validRequestId(value.requestId)) return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        return send(HTTP_STATUS.ACCEPTED, await service.compact(actor, id!, value.requestId));
      }
      if (action === 'messages') {
        if (
          !validRequestId(value.requestId) ||
          typeof value.text !== 'string' ||
          !value.text.trim() ||
          (value.imageAssetIds !== undefined &&
            (!Array.isArray(value.imageAssetIds) ||
              value.imageAssetIds.length > 4 ||
              value.imageAssetIds.some(
                (assetId: unknown) => typeof assetId !== 'string' || !isUuidV4(assetId),
              ) ||
              new Set(value.imageAssetIds).size !== value.imageAssetIds.length))
        )
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        if (Buffer.byteLength(value.text) > MAX_MESSAGE_BODY)
          return fail(HTTP_STATUS.PAYLOAD_TOO_LARGE, 'BODY_TOO_LARGE');
        return send(
          HTTP_STATUS.ACCEPTED,
          await service.send(
            actor,
            id!,
            value.requestId,
            value.text,
            value.imageAssetIds as string[] | undefined,
            reasoningEffort,
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
