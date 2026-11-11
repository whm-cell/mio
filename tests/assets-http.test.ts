import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createAssetHandler } from '../src/assets/http.ts';
import type { createAssetService } from '../src/assets/service.ts';

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function listen(
  identity: (headers: Headers) => Promise<{ userId: string; sessionId: string } | null>,
) {
  const create = vi.fn();
  const service = { create } as unknown as ReturnType<typeof createAssetService>;
  server = createServer(createAssetHandler(service, identity, ['http://127.0.0.1:4173']));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listener missing');
  return { url: `http://127.0.0.1:${address.port}/api/v1/assets/uploads`, create };
}
const actor = { userId: 'owner', sessionId: 'session' };
const headers = {
  origin: 'http://127.0.0.1:4173',
  cookie: 'session=example',
  'content-type': 'application/json',
};

it('rechecks identity after reading the asset request before invoking the service', async () => {
  const identity = vi.fn().mockResolvedValueOnce(actor).mockResolvedValueOnce(null);
  const { url, create } = await listen(identity);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ filename: 'x', contentType: 'video/mp4', size: 1 }),
  });
  expect(response.status).toBe(401);
  expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  expect(identity).toHaveBeenCalledTimes(2);
  expect(create).not.toHaveBeenCalled();
});

it('preserves asset Origin, malformed JSON and body size errors', async () => {
  const identity = vi.fn().mockResolvedValue(actor);
  const { url, create } = await listen(identity);
  expect(
    (
      await fetch(url, {
        method: 'POST',
        headers: { ...headers, origin: 'https://other.invalid' },
        body: '{}',
      })
    ).status,
  ).toBe(403);
  const malformed = await fetch(url, { method: 'POST', headers, body: '{' });
  expect(malformed.status).toBe(400);
  expect((await malformed.json()).error.code).toBe('BODY_INVALID');
  const large = await fetch(url, { method: 'POST', headers, body: `{"x":"${'x'.repeat(8192)}"}` });
  expect(large.status).toBe(413);
  expect((await large.json()).error.code).toBe('BODY_TOO_LARGE');
  expect(create).not.toHaveBeenCalled();
});

it('times out a partial asset request and never creates an asset', async () => {
  const { url, create } = await listen(async () => actor);
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request(url, { method: 'POST', headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (part: string) => {
        body += part;
      });
      response.on('end', () => {
        outgoing.destroy();
        resolve({ status: response.statusCode!, body });
      });
    });
    outgoing.on('error', reject);
    outgoing.write('{"filename":');
  });
  expect(result.status).toBe(408);
  expect(JSON.parse(result.body).error.code).toBe('BODY_TIMEOUT');
  expect(create).not.toHaveBeenCalled();
}, 15000);
