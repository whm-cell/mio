import { HTTP_STATUS } from '@mio/foundation/http-status';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AssetPrincipal } from '../assets/contracts.ts';
import { startHttpResponse, writeApiError } from '../http-response.ts';

const assets = new Map([
  ['/ops/compute', ['index.html', 'text/html; charset=utf-8']],
  ['/ops/compute/', ['index.html', 'text/html; charset=utf-8']],
  ['/ops/compute/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/ops/compute/styles.css', ['styles.css', 'text/css; charset=utf-8']],
] as const);
type AssetPath = Parameters<typeof assets.get>[0];
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export function createComputeOpsWebHandler(
  identity: (headers: Headers) => Promise<AssetPrincipal | null>,
  userIds: readonly string[],
) {
  const operators = new Set(userIds);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = startHttpResponse(response);
    const fail = (status: number, code: string) =>
      writeApiError(response, status, { code, message: code, requestId }, 'application/json');
    try {
      const url = new URL(request.url ?? '', 'http://mio.invalid');
      const asset = assets.get(url.pathname as AssetPath);
      if (!asset || url.search) return fail(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET');
        return fail(HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED');
      }
      response.setHeader('content-security-policy', csp);
      response.setHeader('referrer-policy', 'no-referrer');
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      const actor = await identity(headers);
      if (!actor || !operators.has(actor.userId)) {
        const status = actor ? HTTP_STATUS.FORBIDDEN : HTTP_STATUS.UNAUTHORIZED;
        if (asset[0] !== 'index.html')
          return fail(status, actor ? 'OPS_FORBIDDEN' : 'UNAUTHORIZED');
        const title = actor ? '无权访问计算运维控制台' : '请登录 Mio 后访问控制台';
        response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${title}</title><main><h1>${title}</h1><p>计算运维控制台仅向配置中的操作员开放。</p></main></html>`,
        );
        return;
      }
      const body = await readFile(new URL(`./ops-web/${asset[0]}`, import.meta.url));
      response.writeHead(HTTP_STATUS.OK, { 'content-type': asset[1] }).end(body);
    } catch {
      return fail(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_OPS_UNAVAILABLE');
    }
  };
}
