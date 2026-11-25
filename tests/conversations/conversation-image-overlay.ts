import { Readable } from 'node:stream';
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
  const cosUrl = new URL(process.env.MIO_TEST_COS_ORIGIN ?? '');
  if (cosUrl.protocol !== 'http:' || cosUrl.hostname !== '127.0.0.1')
    throw new Error('COS_FIXTURE_REQUIRES_LOOPBACK');
  const cosOrigin = cosUrl.origin;
  let countedFixtureExecutions = 0;
  const negativeToolErrors: { toolCallId: string; code: string | null }[] = [];

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
  const originalRequest = COS.prototype.request;

  const copyObject = async (target: string, copySource: string, ifMatch?: string) => {
    const slashIndex = copySource.indexOf('/');
    const source = slashIndex >= 0 ? decodeURIComponent(copySource.slice(slashIndex + 1)) : '';
    const response = await originalFetch(`${cosOrigin}/copy`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, target, ifMatch: ifMatch ?? null }),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`COS_COPY_${response.status}`), {
        statusCode: response.status,
      });
    }
    return { statusCode: 200, ETag: response.headers.get('etag') ?? '"copied"' };
  };
  const deleteObject = (key: string) =>
    originalFetch(`${cosOrigin}/object/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      redirect: 'error',
    });

  const requestObject = async ({
    Key,
    Method,
    Body,
    Headers: sentHeaders,
  }: COS.RequestParams): Promise<COS.RequestResult> => {
    if (Method !== 'PUT' && Method !== 'DELETE') throw new Error('COS_FIXTURE_UNSUPPORTED_REQUEST');
    if (!Key) throw new Error('COS_FIXTURE_REQUEST_KEY_REQUIRED');
    // SDK requests carry a zero-length stream. Consume it within the stub as the SDK would.
    if (Body instanceof Readable) {
      for await (const chunk of Body) {
        if (chunk.length) throw new Error('COS_FIXTURE_REQUEST_BODY_NOT_EMPTY');
      }
    }
    if (Method === 'PUT') {
      const headers = new Headers(sentHeaders);
      const source = headers.get('x-cos-copy-source');
      const ifMatch = headers.get('x-cos-copy-source-if-match');
      if (!source || !ifMatch || headers.get('x-cos-forbid-overwrite') !== 'true')
        throw new Error('COS_FIXTURE_EXPECTED_CONDITIONAL_COPY');
      const copied = await copyObject(Key, source, ifMatch);
      return { statusCode: copied.statusCode, CopyObjectResult: { ETag: copied.ETag } };
    }
    const deleted = await deleteObject(Key);
    if (!deleted.ok) {
      throw Object.assign(new Error(`COS_DELETE_${deleted.status}`), {
        statusCode: deleted.status,
      });
    }
    return { statusCode: deleted.status, headers: {} };
  };

  type RequestCallback = (error: COS.CosError, result: COS.RequestResult) => void;

  function request(params: COS.RequestParams, callback: RequestCallback): void;
  function request(params: COS.RequestParams): Promise<COS.RequestResult>;
  function request(params: COS.RequestParams, callback?: RequestCallback) {
    const pending = requestObject(params);
    if (!callback) return pending;
    void pending.then(
      (result) => callback(null, result),
      (error: unknown) => Reflect.apply(callback, undefined, [error]),
    );
  }

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
          redirect: 'error',
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

    COS.prototype.putObjectCopy = function (params: {
      Key: string;
      CopySource: string;
      CopySourceIfMatch?: string;
    }) {
      return copyObject(params.Key, params.CopySource, params.CopySourceIfMatch);
    } as unknown as typeof COS.prototype.putObjectCopy;

    COS.prototype.deleteObject = async function (params: { Key: string }) {
      await deleteObject(params.Key);
      return { statusCode: 204, headers: {} };
    } as unknown as typeof COS.prototype.deleteObject;
    COS.prototype.request = request;

    return () => {
      if (globalThis.fetch === interceptedFetch) globalThis.fetch = originalFetch;
      COS.prototype.getObjectUrl = originalGetObjectUrl;
      COS.prototype.headObject = originalHeadObject;
      COS.prototype.putObjectCopy = originalPutObjectCopy;
      COS.prototype.deleteObject = originalDeleteObject;
      COS.prototype.request = originalRequest;
    };
  });

  ctx.inject(['tools', 'webServer'], (subCtx) => {
    subCtx.on('tools/result', (exec, result) => {
      if (result.isError && exec.callId.startsWith('neg_')) {
        negativeToolErrors.push({
          toolCallId: exec.callId,
          code: result.error.info?.code ?? null,
        });
      }
    });
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
              negativeToolErrors,
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
