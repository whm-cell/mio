import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { ApiError } from './contracts.ts';

type JsonContentType = 'application/json' | 'application/json; charset=utf-8';

/** Start once per request; each adapter retains its own routing, CORS and response policy. */
export function startHttpResponse(response: ServerResponse): string {
  const requestId = randomUUID();
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-request-id', requestId);
  return requestId;
}

/** Serialize only service-defined errors; upstream responses and successful bodies stay with adapters. */
export function writeApiError(
  response: ServerResponse,
  status: number,
  detail: ApiError['error'],
  contentType: JsonContentType,
): void {
  response.writeHead(status, { 'content-type': contentType });
  response.end(JSON.stringify({ error: detail } satisfies ApiError));
}
