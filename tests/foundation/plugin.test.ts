import { randomBytes } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Mio from '../../src/plugin.ts';

const contexts: Context[] = [];
const token = randomBytes(32).toString('hex');
const tokenEnv = 'MIO_TEST_ONLY_TOKEN';

beforeEach(() => {
  for (const key of [
    'MIO_AUTH_BASE_URL',
    'MIO_AUTH_SECRET',
    'MIO_AUTH_DATABASE_URL',
    'MIO_AUTH_ALLOWED_ORIGINS',
    'MIO_AUTH_RATE_LIMIT_BACKEND',
    'MIO_REDIS_URL',
    'MIO_REDIS_NAMESPACE',
  ])
    vi.stubEnv(key, undefined);
});

afterEach(async () => {
  delete process.env[tokenEnv];
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  vi.unstubAllEnvs();
});

async function setup() {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(NativeExecutor);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  process.env[tokenEnv] = token;
  return { ctx, origin: ctx.webServer.getOrigin() };
}

describe('foundation through actual DSH HTTP and tool services', () => {
  it('preserves foundation response headers, errors and Origin precedence at the registered entry', async () => {
    const { ctx, origin } = await setup();
    await ctx.plugin(Mio, { tokenEnv, allowedOrigins: ['https://frontend.example'] });
    const clientId = '11111111-1111-4111-8111-111111111111';
    const ids = new Set<string>();
    for (const scenario of [
      { path: '/healthz', status: 200 },
      { path: '/readyz', status: 200 },
      {
        path: '/api/v1/capabilities',
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'A valid service credential is required',
      },
      {
        path: '/api/v1/missing',
        method: 'OPTIONS',
        status: 404,
        code: 'NOT_FOUND',
        message: 'Unknown endpoint',
      },
      { path: '/api/v1/capabilities', method: 'OPTIONS', status: 204 },
      {
        path: '/api/v1/capabilities',
        method: 'OPTIONS',
        origin: 'https://frontend.example',
        status: 204,
      },
      {
        path: '/api/v1/capabilities',
        method: 'POST',
        origin: 'https://frontend.example',
        status: 405,
        code: 'METHOD_NOT_ALLOWED',
        message: 'Method is not allowed',
      },
      {
        path: '/api/v1/missing',
        method: 'OPTIONS',
        origin: 'https://evil.example',
        status: 403,
        code: 'ORIGIN_DENIED',
        message: 'Origin is not allowed',
      },
      {
        path: '/api/v1/capabilities',
        method: 'POST',
        origin: 'https://evil.example',
        status: 403,
        code: 'ORIGIN_DENIED',
        message: 'Origin is not allowed',
      },
    ]) {
      const response = await fetch(`${origin}${scenario.path}`, {
        method: scenario.method ?? 'GET',
        headers: {
          'x-request-id': clientId,
          ...(scenario.origin ? { origin: scenario.origin } : {}),
        },
      });
      expect(response.status, scenario.path).toBe(scenario.status);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      const id = response.headers.get('x-request-id')!;
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(id).not.toBe(clientId);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
      if (scenario.origin === 'https://frontend.example') {
        expect(response.headers.get('access-control-allow-origin')).toBe(scenario.origin);
        expect(response.headers.get('vary')).toBe('Origin');
      } else expect(response.headers.get('access-control-allow-origin')).toBeNull();
      if (scenario.status === 204) {
        expect(await response.text()).toBe('');
        expect(response.headers.get('access-control-allow-methods')).toBe('GET');
        expect(response.headers.get('access-control-allow-headers')).toBe('Authorization');
      } else if (scenario.code) {
        expect(await response.json()).toEqual({
          error: { code: scenario.code, message: scenario.message, requestId: id },
        });
      } else
        expect(await response.json()).toMatchObject({
          status: scenario.path === '/healthz' ? 'ok' : 'ready',
        });
      if (scenario.status === 401) expect(response.headers.get('www-authenticate')).toBe('Bearer');
      if (scenario.status === 405) expect(response.headers.get('allow')).toBe('GET, OPTIONS');
    }
    const capabilities = await fetch(`${origin}/api/v1/capabilities`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(capabilities.status).toBe(200);
    expect(capabilities.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(capabilities.headers.get('cache-control')).toBe('no-store');
    expect(capabilities.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await capabilities.json()).toEqual({
      apiVersion: 'v1',
      stage: 'foundation',
      tools: [],
      sessions: false,
    });
  });

  it('loads, authenticates requests, validates Origin/method, and unloads routes', async () => {
    const { ctx, origin } = await setup();
    const plugin = ctx.plugin(Mio, { tokenEnv, allowedOrigins: ['https://frontend.example'] });
    await plugin;
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    const ready = await fetch(`${origin}/readyz`);
    expect(await ready.json()).toMatchObject({ status: 'ready', instanceId: expect.any(String) });
    const unauthorized = await fetch(`${origin}/api/v1/capabilities`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'A valid service credential is required',
        requestId: unauthorized.headers.get('x-request-id'),
      },
    });
    expect(unauthorized.headers.get('cache-control')).toBe('no-store');
    for (const authorization of ['Bearer invalid', `Bearer ${'f'.repeat(token.length)}`, token]) {
      expect(
        (await fetch(`${origin}/api/v1/capabilities`, { headers: { authorization } })).status,
      ).toBe(401);
    }
    const authorized = await fetch(`${origin}/api/v1/capabilities`, {
      headers: { authorization: `Bearer ${token}`, origin: 'https://frontend.example' },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      apiVersion: 'v1',
      stage: 'foundation',
      tools: [],
      sessions: false,
    });
    expect(authorized.headers.get('access-control-allow-origin')).toBe('https://frontend.example');
    expect(
      (
        await fetch(`${origin}/api/v1/capabilities`, {
          headers: { authorization: `Bearer ${token}`, origin: 'https://other.example' },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(`${origin}/api/v1/capabilities`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${origin}/api/v1/sessions`)).status).toBe(404);
    expect(
      (
        await fetch(`${origin}/api/v1/capabilities`, {
          method: 'OPTIONS',
          headers: { origin: 'https://frontend.example' },
        })
      ).status,
    ).toBe(204);
    await plugin.dispose();
    expect((await fetch(`${origin}/readyz`)).status).toBe(404);
    expect((await fetch(`${origin}/api/v1/capabilities`)).status).toBe(404);
  });

  it('refuses missing/invalid configuration without reporting readiness', async () => {
    const { ctx, origin } = await setup();
    delete process.env[tokenEnv];
    await expect(ctx.plugin(Mio, { tokenEnv, allowedOrigins: [] }).await()).rejects.toThrow(
      'MIO_API_TOKEN',
    );
    expect((await fetch(`${origin}/readyz`)).status).toBe(404);
    process.env[tokenEnv] = token;
    await expect(ctx.plugin(Mio, { tokenEnv, allowedOrigins: ['*'] }).await()).rejects.toThrow();
    expect((await fetch(`${origin}/readyz`)).status).toBe(404);
  });

  it('blocks actual tool bodies even after an allow listener; disposal restores owner lifecycle', async () => {
    const { ctx } = await setup();
    let calls = 0;
    ctx.tools.register(
      defineTool({
        name: 'fixture_side_effect',
        description: 'Test-only counted operation',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async () => {
          calls++;
          return 'ran';
        },
      }),
    );
    const run = () =>
      ctx.tools.execute({
        calls: [
          {
            type: 'tool-call',
            id: ToolCallId('fixture-call'),
            name: 'fixture_side_effect',
            arguments: '{}',
          },
        ],
        signal: new AbortController().signal,
      });
    // Control proves this fixture reaches a real executable body before applying the guard.
    await run();
    expect(calls).toBe(1);
    const plugin = ctx.plugin(Mio, { tokenEnv, allowedOrigins: [] });
    await plugin;
    ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }));
    const denied = await run();
    expect(denied.results[0]?.result.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain('MIO_TOOL_DENIED');
    expect(calls).toBe(1);
    await plugin.dispose();
    await run();
    expect(calls).toBe(2);
  });
});
