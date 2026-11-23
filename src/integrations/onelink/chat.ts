import { HTTP_STATUS } from '@mio/foundation/http-status';
import { ONELINK_ORIGIN } from './models.ts';

export interface ChatResponseFacts {
  status?: number;
  providerRequestId?: string;
  contextOverflow?: true;
}

const SAFE_CHAT_PATH = /^\/[A-Za-z0-9._/-]+$/;
const ERROR_BODY_LIMIT = 8 * 1024;
const ERROR_BODY_TIMEOUT_MS = 1000;
const CONTEXT_ERROR_CODE =
  /^(?:context_length_exceeded|context_window_exceeded|model_context_window_exceeded|context_overflow)$/i;
const CONTEXT_ERROR_MESSAGES = [
  /^prompt (?:is )?too long:\s*[\d,]+ tokens?\s*>\s*[\d,]+ maximum\b/i,
  /^context (?:length|window) exceeded\b/i,
  /^(?:(?:your|the) )?(?:input|prompt|request(?:ed token count)?|messages?)\b[^.!?\n]{0,40}\bexceeds? (?:the )?(?:model['’]s )?(?:maximum )?context (?:length|window)\b/i,
  /^this model['’]s maximum context length is [\d,]+ tokens?\. However, (?:you requested|your messages resulted in) [\d,]+ tokens?\b/i,
];

function isContextCode(value: unknown): boolean {
  return typeof value === 'string' && CONTEXT_ERROR_CODE.test(value);
}

function isContextMessage(value: unknown): boolean {
  return typeof value === 'string' && CONTEXT_ERROR_MESSAGES.some((pattern) => pattern.test(value));
}

/** Classify a provider diagnostic in memory without forwarding its untrusted detail. */
export function isChatContextOverflow(detail: string): boolean {
  if (detail.length > ERROR_BODY_LIMIT) return false;
  const text = detail.trim();
  if (!text.startsWith('{'))
    return isContextCode(text.replace(/^Provider finish_reason: /, '')) || isContextMessage(text);
  try {
    type ErrorFields = { code?: unknown; type?: unknown; message?: unknown };
    const payload = JSON.parse(text) as (ErrorFields & { error?: ErrorFields }) | null;
    const error = payload?.error ?? payload;
    return (
      isContextCode(error?.code) || isContextCode(error?.type) || isContextMessage(error?.message)
    );
  } catch {
    return false;
  }
}

async function readContextOverflow(response: Response, signal: AbortSignal): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  let incomplete = false;
  const cancel = () => {
    incomplete = true;
    void reader.cancel().catch(() => {});
  };
  const timer = setTimeout(cancel, ERROR_BODY_TIMEOUT_MS);
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > ERROR_BODY_LIMIT) return false;
      if (value.byteLength > 0) chunks.push(value);
    }
    return !incomplete && isChatContextOverflow(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

/** A request-owned transport. No credentials, redirects or retries escape this destination. */
export function chatTransport(
  apiKey: string,
  path: string,
  facts: ChatResponseFacts,
  transport: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    if (!SAFE_CHAT_PATH.test(path) || path.includes('..') || path.includes('//'))
      throw new Error('ONELINK_DESTINATION_DENIED');
    const request = new Request(input, init);
    const endpoint = `${ONELINK_ORIGIN}${path}`;
    // The fixed Anthropic SDK uses its beta Messages entry point. No other query is allowed.
    if (
      (request.url !== endpoint &&
        !(path === '/v1/messages' && request.url === `${endpoint}?beta=true`)) ||
      request.method !== 'POST'
    )
      throw new Error('ONELINK_DESTINATION_DENIED');
    const headers = new Headers(request.headers);
    headers.delete('x-api-key');
    headers.set('authorization', `Bearer ${apiKey}`);
    let response: Response;
    try {
      response = await transport(new Request(request, { headers, redirect: 'error' }));
    } catch {
      throw new Error('ONELINK_TRANSPORT_FAILED');
    }
    facts.status = response.status;
    const id = response.headers.get('x-request-id') ?? response.headers.get('request-id');
    if (id && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id) && !id.includes(apiKey))
      facts.providerRequestId = id;
    if (!response.ok) {
      if (
        response.status === HTTP_STATUS.BAD_REQUEST ||
        response.status === HTTP_STATUS.PAYLOAD_TOO_LARGE ||
        response.status === 422
      ) {
        if (await readContextOverflow(response, request.signal)) facts.contextOverflow = true;
      } else void response.body?.cancel().catch(() => {});
      // SDKs flatten error bodies into strings; do not let upstream echoes enter Session failures.
      return new Response(JSON.stringify({ error: { message: 'ONELINK_REQUEST_FAILED' } }), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return response;
  };
}
