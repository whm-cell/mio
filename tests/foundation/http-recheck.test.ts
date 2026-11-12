import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createProviderHandler } from '../../src/providers/http.ts';
import { createConversationHandler } from '../../src/conversations/http.ts';
import { createComputeHandler } from '../../src/compute/http.ts';
import { createHandler } from '../../src/http.ts';

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

it.each(['provider', 'conversation', 'compute'] as const)(
  'rejects a revoked identity after reading a %s request',
  async (domain) => {
    const identity = vi
      .fn()
      .mockResolvedValueOnce({ userId: 'owner', sessionId: 'session' })
      .mockResolvedValueOnce(null);
    const action = vi.fn();
    const origin = 'http://client.test';
    const handler =
      domain === 'provider'
        ? createProviderHandler({ save: action } as never, identity, [origin])
        : domain === 'conversation'
          ? createConversationHandler({ create: action } as never, identity, [origin]).handler
          : createComputeHandler({ create: action } as never, identity, [origin]);
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const path =
      domain === 'provider'
        ? '/api/v1/providers/onelink/credential'
        : domain === 'conversation'
          ? '/api/v1/conversations'
          : '/api/v1/compute/jobs';
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: domain === 'provider' ? 'PUT' : 'POST',
      headers: { origin, cookie: 'session=secret', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
    expect(identity).toHaveBeenCalledTimes(2);
    expect(action).not.toHaveBeenCalled();
  },
);

it('correlates an HTTP failure with the response ID without logging request data', async () => {
  server = createServer(
    createHandler({ token: 'a'.repeat(32), allowedOrigins: [], instanceId: 'instance' }),
  );
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  let output = '';
  const sink = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/capabilities`, {
      headers: { cookie: 'password=secret', authorization: 'Bearer secret' },
    });
    expect(response.status).toBe(401);
    expect(JSON.parse(output)).toMatchObject({
      event: 'HTTP_REQUEST_FAILED',
      requestId: response.headers.get('x-request-id'),
    });
    expect(output).not.toMatch(/password|secret|cookie|Bearer/);
  } finally {
    sink.mockRestore();
  }
});
