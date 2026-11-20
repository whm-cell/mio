import { createServer, request as requestHttp } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

export const materialAuthProxyPath =
  /^\/api\/v1\/materials\/auth-sessions\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(launch|complete)$/;
/** Task-owned tunnel target. It cannot forward login, metadata, health or arbitrary app paths. */
export function createMaterialAuthProxy(upstreamOrigin: string) {
  const origin = new URL(upstreamOrigin);
  if (
    origin.origin !== upstreamOrigin ||
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    !origin.port
  )
    throw new Error('MATERIAL_AUTH_PROXY_TARGET');
  let active = 0;
  return (request: IncomingMessage, response: ServerResponse): void => {
    const fail = (status: number, code: string) => {
      response
        .writeHead(status, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        .end(code);
    };
    const raw = request.url ?? '',
      path = raw.split('?')[0] ?? '';
    if (raw.length > 8192 || !materialAuthProxyPath.test(path) || request.method !== 'GET') {
      fail(404, 'NOT_FOUND');
      return;
    }
    if (
      request.headers['transfer-encoding'] ||
      Number(request.headers['content-length'] ?? 0) !== 0
    ) {
      fail(400, 'BODY_INVALID');
      return;
    }
    if (active >= 4) {
      response.setHeader('retry-after', '3');
      fail(429, 'AUTH_QUERY_LIMITED');
      return;
    }
    active++;
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      active--;
    };
    const proxy = requestHttp(
      new URL(raw, origin),
      { method: 'GET', headers: { accept: 'text/html' }, timeout: 65_000 },
      (upstream) => {
        const headers: Record<string, string | string[]> = {};
        for (const key of [
          'content-type',
          'cache-control',
          'referrer-policy',
          'content-security-policy',
          'location',
          'x-content-type-options',
          'x-request-id',
          'retry-after',
          'allow',
        ]) {
          const value = upstream.headers[key];
          if (value !== undefined) headers[key] = value;
        }
        response.writeHead(upstream.statusCode ?? 502, headers);
        upstream.pipe(response);
        upstream.once('error', () => {
          if (!response.destroyed) response.destroy();
        });
      },
    );
    proxy.once('timeout', () => proxy.destroy(new Error('MATERIAL_AUTH_PROXY_TIMEOUT')));
    proxy.once('error', () => {
      if (!response.headersSent) fail(502, 'MATERIAL_UNAVAILABLE');
      else response.destroy();
      finish();
    });
    response.once('close', () => {
      proxy.destroy();
      finish();
    });
    response.once('finish', finish);
    proxy.end();
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2],
    port = Number(process.argv[3] ?? '0');
  if (!target || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Usage: material-auth-proxy <http://127.0.0.1:port> [local-port]');
  const server = createServer(createMaterialAuthProxy(target));
  server.maxConnections = 16;
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('MATERIAL_AUTH_PROXY_LISTENER');
    console.log(
      JSON.stringify({
        event: 'MATERIAL_AUTH_PROXY_READY',
        origin: `http://127.0.0.1:${address.port}`,
        publicPaths: 'GET /api/v1/materials/auth-sessions/{UUID}/launch|complete',
      }),
    );
  });
  const stop = () => {
    server.close();
    server.closeAllConnections();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
