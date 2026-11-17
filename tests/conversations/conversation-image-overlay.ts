import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import COS from 'cos-nodejs-sdk-v5';

/**
 * Temporary child-Profile overlay installed only in conversation-image-tools.test.ts.
 * Production @mio/plugin, PiAi, DSH agent loop, and compute admission remain untouched.
 */
export function apply(ctx: Context) {
  const onelinkOrigin = process.env.MIO_TEST_ONELINK_ORIGIN ?? '';
  const cosOrigin = process.env.MIO_TEST_COS_ORIGIN ?? '';
  let countedFixtureExecutions = 0;

  const originalFetch = globalThis.fetch;
  const interceptedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const parsed = new URL(request.url);
    if (parsed.origin === 'https://api.onelinkai.cloud') {
      const target = `${onelinkOrigin}${parsed.pathname}${parsed.search}`;
      const body =
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : new Uint8Array(await request.arrayBuffer());
      return originalFetch(target, {
        method: request.method,
        headers: request.headers,
        ...(body !== undefined ? { body } : {}),
        signal: request.signal,
      });
    }
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      throw new Error(`EXTERNAL_NETWORK_FORBIDDEN:${parsed.origin}`);
    }
    return originalFetch(input, init);
  };

  const originalGetObjectUrl = COS.prototype.getObjectUrl;
  const originalHeadObject = COS.prototype.headObject;
  const originalPutObjectCopy = COS.prototype.putObjectCopy;
  const originalDeleteObject = COS.prototype.deleteObject;

  ctx.effect(() => {
    globalThis.fetch = interceptedFetch;
    COS.prototype.getObjectUrl = function (params: { Key: string; Method?: string }) {
      return `${cosOrigin}/object/${encodeURIComponent(params.Key)}?method=${encodeURIComponent(params.Method ?? 'GET')}`;
    } as typeof COS.prototype.getObjectUrl;

    COS.prototype.headObject = async function (params: { Key: string }) {
      const response = await originalFetch(
        `${cosOrigin}/object/${encodeURIComponent(params.Key)}`,
        {
          method: 'HEAD',
        },
      );
      if (response.status === 404) {
        throw Object.assign(new Error('COS_NOT_FOUND'), { statusCode: 404 });
      }
      if (!response.ok) {
        throw Object.assign(new Error(`COS_HEAD_${response.status}`), {
          statusCode: response.status,
        });
      }
      const sha256 = response.headers.get('x-cos-meta-sha256');
      return {
        statusCode: 200,
        ETag: response.headers.get('etag') ?? '',
        headers: {
          'content-length': response.headers.get('content-length') ?? '0',
          ...(sha256 ? { 'x-cos-meta-sha256': sha256 } : {}),
        },
      };
    } as unknown as typeof COS.prototype.headObject;

    COS.prototype.putObjectCopy = async function (params: {
      Key: string;
      CopySource: string;
      CopySourceIfMatch?: string;
    }) {
      const slashIndex = params.CopySource.indexOf('/');
      const source =
        slashIndex >= 0 ? decodeURIComponent(params.CopySource.slice(slashIndex + 1)) : '';
      const response = await originalFetch(`${cosOrigin}/copy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source,
          target: params.Key,
          ifMatch: params.CopySourceIfMatch ?? null,
        }),
      });
      if (!response.ok) {
        throw Object.assign(new Error(`COS_COPY_${response.status}`), {
          statusCode: response.status,
        });
      }
      return { statusCode: 200, ETag: response.headers.get('etag') ?? '"copied"' };
    } as unknown as typeof COS.prototype.putObjectCopy;

    COS.prototype.deleteObject = async function (params: { Key: string }) {
      await originalFetch(`${cosOrigin}/object/${encodeURIComponent(params.Key)}`, {
        method: 'DELETE',
      });
      return { statusCode: 204, headers: {} };
    } as unknown as typeof COS.prototype.deleteObject;

    return () => {
      if (globalThis.fetch === interceptedFetch) globalThis.fetch = originalFetch;
      COS.prototype.getObjectUrl = originalGetObjectUrl;
      COS.prototype.headObject = originalHeadObject;
      COS.prototype.putObjectCopy = originalPutObjectCopy;
      COS.prototype.deleteObject = originalDeleteObject;
    };
  });

  ctx.inject(['tools', 'webServer'], (subCtx) => {
    subCtx.tools.register(
      defineTool({
        name: 'counted_fixture',
        description: 'Test-only non-whitelisted global tool',
        parameters: {
          value: { type: 'number' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async () => {
          countedFixtureExecutions += 1;
          return 'ran';
        },
      }),
    );

    subCtx.effect(() =>
      subCtx.webServer.register({
        kind: 'exact',
        path: '/__test/tools',
        handler: (_request, response) => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              countedFixtureExecutions,
              rootToolNames: subCtx.tools.definitions().map((item) => item.name),
            }),
          );
        },
      }),
    );

    subCtx.effect(() =>
      subCtx.webServer.register({
        kind: 'exact',
        path: '/__test/root-execute',
        handler: async (request, response) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
            name?: string;
            args?: Record<string, unknown>;
          };
          const settled = await subCtx.tools.execute({
            calls: [
              {
                type: 'tool-call',
                id: ToolCallId('root-direct-call'),
                name: payload.name ?? 'counted_fixture',
                arguments: JSON.stringify(payload.args ?? {}),
              },
            ],
            signal: new AbortController().signal,
          });
          const entry = settled.results[0]?.result;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              isError: entry?.isError ?? true,
              output: JSON.stringify(entry),
              countedFixtureExecutions,
            }),
          );
        },
      }),
    );
  });
}
