import { HTTP_STATUS } from '@mio/foundation/http-status';
import { isUuidV4 } from '@mio/foundation/identifiers';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, RequestBodyError } from '../http-request.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';
import { ConversationError } from './contracts.ts';
import type { Principal, ConversationEvent } from './contracts.ts';
import type { ConversationService } from './service.ts';

const MAX_BODY = 16 * 1024;
const MAX_STREAM_BUFFER = 64 * 1024;
const requestIdPattern = /^[A-Za-z0-9_-]{1,80}$/;
type Identity = (headers: Headers) => Promise<Principal | null>;

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

/** HTTP owns identity rechecks, browser policy and bounded transient stream resources. */
export function createConversationHandler(
  service: ConversationService,
  identity: Identity,
  origins: readonly string[],
) {
  const allowed = new Set(origins);
  const streams = new Set<() => void>();
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
      let actor = await identity(headers);
      if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      const value = method !== 'GET' ? await readJsonBody(request, MAX_BODY) : {};
      if (method !== 'GET') {
        actor = await identity(headers);
        if (!actor) return fail(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
      }
      const expected =
        action === 'messages'
          ? ['requestId', 'text']
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
          Buffer.byteLength(value.text) > MAX_BODY
        )
          return fail(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
        return send(
          HTTP_STATUS.ACCEPTED,
          await service.send(actor, id!, value.requestId, value.text),
        );
      }
      if (action === 'cancel') return send(HTTP_STATUS.ACCEPTED, await service.cancel(actor, id!));
      // Subscribe before sending the baseline. Events arriving while authorization/storage await
      // are buffered within the same bound as the socket and never reinterpreted as durable replay.
      let started = false;
      let queued: string[] = [];
      let queuedBytes = 0;
      let checking = false;
      let errored = false;
      const resources: {
        subscription?: Awaited<ReturnType<ConversationService['subscribe']>>;
        interval?: ReturnType<typeof setInterval>;
      } = {};
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        if (resources.interval) clearInterval(resources.interval);
        resources.subscription?.close();
        streams.delete(close);
        if (!response.writableEnded) response.end();
      };
      const write = (
        event:
          | ConversationEvent
          | { type: 'snapshot'; conversationId: string; activeRequestId: string | null },
      ) => {
        if (event.type === 'error') errored = true;
        const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        if (response.destroyed || response.writableEnded) return close();
        if (Buffer.byteLength(data) > MAX_STREAM_BUFFER) {
          response.destroy();
          close();
          return;
        }
        if (!started) {
          queuedBytes += Buffer.byteLength(data);
          if (queuedBytes > MAX_STREAM_BUFFER) {
            response.destroy();
            close();
          } else queued.push(data);
          return;
        }
        response.write(data);
        if (response.writableLength > MAX_STREAM_BUFFER) {
          response.destroy();
          close();
        } else if (event.type === 'error') close();
      };
      const subscription = await service.subscribe(actor, id!, write);
      resources.subscription = subscription;
      if (response.destroyed) {
        subscription.close();
        return;
      }
      response.writeHead(HTTP_STATUS.OK, {
        'content-type': 'text/event-stream',
        'x-accel-buffering': 'no',
      });
      response.flushHeaders();
      started = true;
      write({ type: 'snapshot', ...subscription.snapshot });
      for (const data of queued) {
        response.write(data);
        if (response.writableLength > MAX_STREAM_BUFFER) {
          response.destroy();
          close();
          break;
        }
      }
      queued = [];
      queuedBytes = 0;
      if (response.destroyed || response.writableEnded || closed || errored) {
        close();
        return;
      }
      streams.add(close);
      response.once('close', close);
      const sessionId = actor.sessionId;
      const interval = setInterval(() => {
        if (checking) return;
        checking = true;
        void identity(headers)
          .then(
            (current) => {
              if (!current || current.sessionId !== sessionId) {
                write({ type: 'error', code: 'UNAUTHORIZED' });
                close();
              }
            },
            () => {
              write({ type: 'error', code: 'AUTH_UNAVAILABLE' });
              close();
            },
          )
          .finally(() => {
            checking = false;
          });
      }, 1000);
      resources.interval = interval;
      interval.unref();
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
      for (const close of streams) close();
    },
  };
}
