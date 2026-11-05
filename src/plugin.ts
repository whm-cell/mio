import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { createHandler } from './http.ts';

export const name = 'mio-foundation';
export const inject = ['webServer', 'tools'];

export interface Config {
  tokenEnv: string;
  allowedOrigins: string[];
}

export const Config = z.object({
  tokenEnv: z.string().default('MIO_API_TOKEN'),
  allowedOrigins: z.array(z.string()).default([]),
});

/** Mount only foundation routes. No model-facing capability is authorized at this stage. */
export function apply(ctx: Context, config: Config): void {
  const handler = createHandler({
    token: process.env[config.tokenEnv] ?? '',
    allowedOrigins: config.allowedOrigins,
    instanceId: randomUUID(),
  });

  // Registered on this fiber, so the guard and routes are removed together on disposal.
  ctx.tools.guard(
    () => 'MIO_TOOL_DENIED: no business tool is authorized in the foundation profile',
  );
  for (const path of ['/healthz', '/readyz']) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }));
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/v1', handler }));
}
