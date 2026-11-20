import type { IncomingMessage, ServerResponse } from 'node:http';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { startHttpResponse } from '../http-response.ts';
import { MaterialError } from './contracts.ts';
import { ProviderError } from '../providers/contracts.ts';
import type { MaterialAuthService } from './auth-service.ts';

/** Exact public mobile entry selection runs before common Cookie/Origin guards, never a prefix bypass. */
export function createMaterialAuthPublicHandler(service: MaterialAuthService) {
  let active = 0;
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    let url: URL;
    try {
      url = new URL(request.url ?? '', 'http://mio.invalid');
    } catch {
      return false;
    }
    const match = url.pathname.match(
      /^\/api\/v1\/materials\/auth-sessions\/([^/]+)\/(launch|complete)$/,
    );
    if (!match || !match[1] || !isUuidV4(match[1])) return false;
    startHttpResponse(response);
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader(
      'content-security-policy',
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    const html = (status: number, code: string) => {
      const message =
        code === 'AUTH_COMPLETED'
          ? '认证已完成，请返回电脑查看真人素材组。'
          : '请返回电脑查看当前认证会话的状态。';
      response
        .writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          `<!doctype html><html lang="zh"><meta charset="utf-8"><title>素材认证</title><p>${message}</p><p>${code}</p><a href="/materials">返回素材库</a></html>`,
        );
    };
    if (active >= 4) {
      response.setHeader('retry-after', '3');
      html(429, 'AUTH_QUERY_LIMITED');
      return true;
    }
    active++;
    try {
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET');
        html(405, 'METHOD_NOT_ALLOWED');
        return true;
      }
      try {
        if ((request.url ?? '').length > 8192) throw new MaterialError(400, 'AUTH_QUERY_INVALID');
        if (match[2] === 'launch') {
          if (url.search) throw new MaterialError(400, 'AUTH_QUERY_INVALID');
          const target = await service.launch(match[1]);
          response.writeHead(302, { location: target }).end();
          return true;
        }
        if (
          [...url.searchParams.keys()].some(
            (key) =>
              !['bytedToken', 'resultCode'].includes(key) ||
              url.searchParams.getAll(key).length !== 1,
          )
        )
          throw new MaterialError(400, 'AUTH_QUERY_INVALID');
        const token = url.searchParams.get('bytedToken');
        if (!token || token.length < 16 || token.length > 512 || /[\x00-\x20\x7f]/.test(token))
          throw new MaterialError(400, 'AUTH_PROOF_INVALID');
        const resultCode = url.searchParams.get('resultCode') ?? undefined;
        if (resultCode !== undefined && !/^[0-9]{1,10}$/.test(resultCode))
          throw new MaterialError(400, 'AUTH_QUERY_INVALID');
        const result = await service.complete(match[1], token, resultCode);
        html(200, result.state === 'completed' ? 'AUTH_COMPLETED' : 'AUTH_RESULT_UNCONFIRMED');
      } catch (error) {
        const status =
          error instanceof MaterialError || error instanceof ProviderError ? error.status : 503;
        if (status === 429) response.setHeader('retry-after', '3');
        html(
          status,
          error instanceof MaterialError || error instanceof ProviderError
            ? error.code
            : 'MATERIAL_UNAVAILABLE',
        );
      }
      return true;
    } finally {
      active--;
    }
  };
}
