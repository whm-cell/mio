import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createVideoGenerationHandler } from '../../src/generations/video-http.ts';
import type { createVideoGenerationService } from '../../src/generations/video-service.ts';

const actor = { userId: randomUUID(), sessionId: 'video-http-test' };
const origin = 'https://demo.fixture';
const jobId = randomUUID();
const requestId = randomUUID();

type ResponseFixture = {
  status: number;
  headers: Map<string, string | number | readonly string[]>;
  body: string;
};

async function send(
  handler: ReturnType<typeof createVideoGenerationHandler>,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<ResponseFixture> {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  Object.assign(request, { method, url, headers });
  const response: ResponseFixture & {
    setHeader(name: string, value: string | number | readonly string[]): void;
    writeHead(status: number, headers?: Record<string, string>): typeof response;
    end(body?: string): typeof response;
  } = {
    status: 200,
    headers: new Map(),
    body: '',
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    writeHead(status, responseHeaders) {
      this.status = status;
      for (const [name, value] of Object.entries(responseHeaders ?? {}))
        this.headers.set(name.toLowerCase(), value);
      return this;
    },
    end(value = '') {
      this.body = value;
      return this;
    },
  };
  await handler(request as IncomingMessage, response as unknown as ServerResponse);
  return response;
}

describe('video generation HTTP boundary', () => {
  it('supports owner scoped reads, keyset query parameters, and a single explicit create request', async () => {
    const service = {
      capabilities: vi.fn().mockResolvedValue({ available: false, modes: [] }),
      create: vi.fn().mockResolvedValue({ created: true, job: { id: jobId } }),
      get: vi.fn().mockResolvedValue({ id: jobId }),
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof createVideoGenerationService>;
    const identity = vi.fn(async () => actor);
    const handler = createVideoGenerationHandler(service, identity, [origin]);
    const base = '/api/v1/compute';

    const cursor = Buffer.from(
      JSON.stringify({ createdAt: '2026-11-23T12:00:00.123456Z', id: randomUUID() }),
    ).toString('base64url');
    const listResponse = await send(handler, 'GET', `${base}/videos?limit=2&cursor=${cursor}`);
    expect(listResponse.status).toBe(200);
    expect(service.list).toHaveBeenCalledWith(actor, 2, cursor);

    const duplicateQuery = await send(handler, 'GET', `${base}/videos?limit=2&limit=3`);
    expect(duplicateQuery.status).toBe(400);
    expect(service.list).toHaveBeenCalledTimes(1);

    const jobResponse = await send(handler, 'GET', `${base}/videos/${jobId}`);
    expect(jobResponse.status).toBe(200);
    expect(service.get).toHaveBeenCalledWith(actor, jobId);

    const options = await send(handler, 'OPTIONS', `${base}/videos`, { origin });
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');

    const body = {
      requestId,
      modelRef: `onelink:model:${randomUUID()}`,
      expectedCapabilitiesVersion: 'cap-v1',
      parameters: { mode: 'text_to_video', prompt: 'one explicit request' },
    };
    const created = await send(
      handler,
      'POST',
      `${base}/videos`,
      { origin, 'content-type': 'application/json' },
      JSON.stringify(body),
    );
    expect(created.status).toBe(202);
    expect(JSON.parse(created.body)).toEqual({ id: jobId });
    expect(service.create).toHaveBeenCalledWith(actor, body);
    expect(identity).toHaveBeenCalledTimes(4);
  });

  it('rejects untrusted origins, unsupported methods, and unknown query parameters', async () => {
    const service = {
      capabilities: vi.fn(),
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      close: vi.fn(),
    } as unknown as ReturnType<typeof createVideoGenerationService>;
    const handler = createVideoGenerationHandler(service, async () => actor, [origin]);
    const base = '/api/v1/compute/videos';

    expect((await send(handler, 'GET', base, { origin: 'https://untrusted.fixture' })).status).toBe(
      403,
    );
    expect((await send(handler, 'GET', `${base}?ownerId=${randomUUID()}`)).status).toBe(400);
    expect((await send(handler, 'DELETE', base)).status).toBe(405);
    expect(service.list).not.toHaveBeenCalled();
    expect(service.create).not.toHaveBeenCalled();
  });
});
