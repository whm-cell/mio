import { randomBytes } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it } from 'vitest';
import * as Mio from '../src/plugin.ts';

const contexts: Context[] = [];
const token = randomBytes(32).toString('hex');
const tokenEnv = 'MIO_TEST_ONLY_TOKEN';

afterEach(async () => {
  delete process.env[tokenEnv];
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
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
