import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch as undiciFetch, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callPromptModel } from '../../src/dsh/prompt-caller.ts';
import { ONELINK_ORIGIN } from '../../src/integrations/onelink/models.ts';
import { protocolResponse } from '../onelink/fixture.ts';
import { execution, profiles, snapshot, thinkingResponse } from './fixture.ts';
import { createLivePromptAudit, runLivePrompt } from './prompts-live.ts';

const originalDispatcher = getGlobalDispatcher();
let transport: MockAgent;
let home: string;
beforeEach(async () => {
  transport = new MockAgent();
  transport.disableNetConnect();
  setGlobalDispatcher(transport);
  home = await mkdtemp(join(tmpdir(), 'mio-live-prompt-offline-'));
  vi.stubEnv('DSH_HOME', home);
  vi.stubEnv('MIO_RUN_LIVE_PROMPT', 'yes');
});
afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  vi.unstubAllEnvs();
  try {
    expect(await readdir(home, { recursive: true })).toEqual([]);
  } finally {
    await transport.close();
    await rm(home, { recursive: true, force: true });
  }
});

it.each([undefined, '', 'YES', 'true', '1', 'yes '])(
  'rejects gate=%s before prerequisites or any transport',
  async (gate) => {
    vi.stubEnv('MIO_RUN_LIVE_PROMPT', gate);
    const prepare = vi.fn(async () => {
      throw new Error('must not read credentials');
    });
    expect(await runLivePrompt(prepare, vi.fn())).toEqual({
      status: 'blocked',
      reason: 'MIO_RUN_LIVE_PROMPT_REQUIRED',
      upstreamPosts: 0,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(getGlobalDispatcher()).toBe(transport);
  },
);

it('keeps the executable entry offline without the exact opt-in', () => {
  const child = spawnSync(process.execPath, ['tests/prompts/prompts-live.ts'], {
    encoding: 'utf8',
    env: { ...process.env, MIO_RUN_LIVE_PROMPT: 'YES' },
    timeout: 10_000,
  });
  expect(child.status).toBe(1);
  expect(JSON.parse(child.stdout)).toEqual({
    status: 'blocked',
    reason: 'MIO_RUN_LIVE_PROMPT_REQUIRED',
    upstreamPosts: 0,
  });
  expect(child.stderr).toBe('');
});

it.each([
  'LIVE_PROMPT_DEV_ENVIRONMENT_UNAVAILABLE',
  'LIVE_PROMPT_OWNER_CREDENTIAL_OR_ROUTE_UNAVAILABLE',
  'MODEL_DEFAULT_NOT_SET',
])('reports prerequisite %s with zero POSTs', async (reason) => {
  expect(await runLivePrompt(async () => ({ ready: false, reason }), vi.fn())).toEqual({
    status: 'prerequisite-failed',
    reason,
    upstreamPosts: 0,
    blockedPosts: 0,
  });
  expect(getGlobalDispatcher()).toBe(transport);
});

it('sanitizes an unexpected prerequisite error with zero POSTs', async () => {
  const result = await runLivePrompt(async () => {
    throw new Error('private credential');
  }, vi.fn());
  expect(result).toEqual({
    status: 'prerequisite-failed',
    reason: 'LIVE_PROMPT_PREREQUISITE_UNAVAILABLE',
    upstreamPosts: 0,
    blockedPosts: 0,
  });
  expect(JSON.stringify(result)).not.toContain('private credential');
});

it('shares the hard fuse across native and undici fetch, blocking the third before transport', async () => {
  let reachedTransport = 0;
  const pool = transport.get(ONELINK_ORIGIN);
  for (let index = 0; index < 3; index++)
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(() => {
      reachedTransport++;
      return { statusCode: 200, data: 'ok' };
    });
  const audit = createLivePromptAudit(transport, vi.fn());
  setGlobalDispatcher(audit.dispatcher);
  const url = ONELINK_ORIGIN + '/v1/chat/completions';
  await (await fetch(url, { method: 'POST' })).text();
  await (await undiciFetch(url, { method: 'POST' })).text();
  const third = await callPromptModel({
    ...execution('openai-chat'),
    purpose: 'structured',
    input: { system: 'synthetic system', prompt: 'synthetic prompt' },
  });
  expect(third).toMatchObject({ status: 'unknown', error: 'MODEL_STREAM_INTERRUPTED' });
  expect(audit.counts()).toEqual({ upstreamPosts: 2, blockedPosts: 1 });
  expect(reachedTransport).toBe(2);
  // Undici 8 mirrors interceptors into an HTTP/1-only shadow pool for Node's fetch.
  expect(
    transport.pendingInterceptors().filter((item) => item.origin === ONELINK_ORIGIN),
  ).toHaveLength(1);
});

describe.each(profiles)('live entry through actual SDK transport (%s)', (profile) => {
  const path = profile === 'openai-chat' ? '/v1/chat/completions' : '/v1/messages?beta=true';
  const setup = (maxOutputTokens = 1024) => ({
    ready: true as const,
    ownerId: 'existing-fixture-owner',
    snapshot: snapshot(profile, { maxOutputTokens }),
    recordVerification: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  });
  async function reply(text: string, bodies: Record<string, unknown>[], reasoning = false) {
    const request = new Request(ONELINK_ORIGIN + path, { method: 'POST' });
    const response = reasoning
      ? await thinkingResponse(request, text, 19)
      : protocolResponse(request, text);
    const data = await response.text();
    transport
      .get(ONELINK_ORIGIN)
      .intercept({ path, method: 'POST' })
      .reply(async (options) => {
        const body = await new Response(options.body as BodyInit).text();
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        return {
          statusCode: 200,
          data,
          responseOptions: { headers: Object.fromEntries(response.headers) },
        };
      });
  }

  it('performs exactly one controlled repair, records tokens, and exposes no raw text or tools', async () => {
    const bodies: Record<string, unknown>[] = [];
    await reply('{"probe":"initial"}', bodies, true);
    await reply('{"probe":"repaired"}', bodies, true);
    const context = setup();
    const events: Record<string, unknown>[] = [];
    const result = await runLivePrompt(
      async () => context,
      (event) => events.push(event),
    );
    expect(result).toEqual({
      status: 'succeeded',
      observations: 2,
      upstreamPosts: 2,
      blockedPosts: 0,
    });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.max_tokens).toBe(1024);
      for (const key of [
        'tools',
        'tool_choice',
        'response_format',
        'reasoning_effort',
        'thinking',
        'output_config',
      ])
        expect(body).not.toHaveProperty(key);
    }
    const observations = events.filter((event) => event.event === 'observation');
    expect(observations).toMatchObject([
      { purpose: 'structured', finish: 'stop', usage: { reasoningTokens: 19 } },
      { purpose: 'structured-repair', finish: 'stop', usage: { reasoningTokens: 19 } },
    ]);
    expect(observations[0]).not.toHaveProperty('providerRequestId');
    const evidence = JSON.stringify(events);
    for (const privateValue of [
      'synthetic-prompt-owner-key',
      'PRIVATE THINKING',
      '{"probe":',
      'fixture-request-id',
    ])
      expect(evidence).not.toContain(privateValue);
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.recordVerification).toHaveBeenCalledTimes(2);
    expect(getGlobalDispatcher()).toBe(transport);
    transport.assertNoPendingInterceptors();
  });

  it('counts a transport-unknown attempt once and never retries or repairs', async () => {
    transport
      .get(ONELINK_ORIGIN)
      .intercept({ path, method: 'POST' })
      .replyWithError(new Error('private drop detail'));
    const bodies: Record<string, unknown>[] = [];
    await reply('{"probe":"repaired"}', bodies);
    const result = await runLivePrompt(async () => setup(), vi.fn());
    expect(result).toEqual({
      status: 'unknown',
      error: 'MODEL_STREAM_INTERRUPTED',
      observations: 1,
      upstreamPosts: 1,
      blockedPosts: 0,
    });
    expect(bodies).toEqual([]);
    expect(
      transport.pendingInterceptors().filter((item) => item.origin === ONELINK_ORIGIN),
    ).toHaveLength(1);
  });

  it('does not repair after the durable observation fails', async () => {
    const bodies: Record<string, unknown>[] = [];
    await reply('{"probe":"initial"}', bodies);
    const result = await runLivePrompt(
      async () => setup(),
      (event) => {
        if (event.event === 'observation') throw new Error('private disk failure');
      },
    );
    expect(result).toEqual({
      status: 'unknown',
      error: 'OBSERVATION_UNAVAILABLE',
      observations: 1,
      upstreamPosts: 1,
      blockedPosts: 0,
    });
    expect(bodies).toHaveLength(1);
    transport.assertNoPendingInterceptors();
  });

  it('enforces the minimum output budget before SDK dispatch', async () => {
    const result = await runLivePrompt(async () => setup(32), vi.fn());
    expect(result).toEqual({
      status: 'failed',
      error: 'MODEL_MAX_TOKENS_INSUFFICIENT',
      observations: 0,
      upstreamPosts: 0,
      blockedPosts: 0,
    });
    transport.assertNoPendingInterceptors();
  });
});
