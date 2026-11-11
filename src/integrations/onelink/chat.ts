import { ONELINK_ORIGIN } from './models.ts';

export interface ChatResponseFacts {
  status?: number;
  providerRequestId?: string;
}

/** A request-owned transport. No credentials, redirects or retries escape this destination. */
export function chatTransport(
  apiKey: string,
  path: string,
  facts: ChatResponseFacts,
  transport: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
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
      await response.body?.cancel();
      // SDKs flatten error bodies into strings; do not let upstream echoes enter Session failures.
      return new Response(JSON.stringify({ error: { message: 'ONELINK_REQUEST_FAILED' } }), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return response;
  };
}
