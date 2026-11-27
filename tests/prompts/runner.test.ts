import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callPromptModel } from '../../src/dsh/prompt-caller.ts';
import { UNTRUSTED_MATERIAL_DECLARATION } from '../../src/prompts/envelope.ts';
import { protocolResponse, protocolToolResponse } from '../onelink/fixture.ts';
import { fixture, profiles, system, thinkingResponse, validOutput } from './fixture.ts';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mio-prompt-no-sessions-'));
  vi.stubEnv('DSH_HOME', home);
});
afterEach(async () => {
  try {
    expect(await readdir(home, { recursive: true })).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

describe.each(profiles)('stateless prompt SDK boundary (%s)', (profile) => {
  it('succeeds once, persists one observation, preserves prefixes, and has no session/tools/files or JSON wire override', async () => {
    const f = fixture(profile);
    const result = await f.runtime.executeStructuredPrompt(f.request);
    expect(result).toMatchObject({
      status: 'succeeded',
      value: { characterId: 'business-character' },
      observations: [
        { status: 200, finish: 'stop', purpose: 'structured', usageStatus: 'reported' },
      ],
    });
    expect(result.observations).toHaveLength(1);
    expect(f.request.observe).toHaveBeenCalledOnce();
    expect(f.callModel.mock.calls[0]![0].snapshot).toBe(f.request.snapshot);
    expect(f.callModel.mock.calls[0]![0].ownerId).toBe(f.request.ownerId);
    expect(f.callModel.mock.calls[0]![0].signal).toBe(f.request.signal);
    expect(f.recordVerification).toHaveBeenCalledExactlyOnceWith(
      f.request.ownerId,
      f.request.snapshot,
      'fixture-task:fixture-request',
    );
    expect(f.requests).toHaveLength(1);
    const { request, body } = f.requests[0]!;
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-prompt-owner-key');
    expect(request.headers.has('x-api-key')).toBe(false);
    expect(request.redirect).toBe('error');
    expect(new URL(request.url).pathname).toBe(
      profile === 'openai-chat' ? '/v1/chat/completions' : '/v1/messages',
    );
    expect(body.max_tokens).toBe(1024);
    expect(body.model).toBe(f.request.snapshot.modelId);
    const encoded = JSON.stringify(body);
    expect(encoded).toContain(system);
    expect(encoded).toContain(UNTRUSTED_MATERIAL_DECLARATION);
    for (const absent of [
      'tools',
      'tool_choice',
      'response_format',
      'json_object',
      'session_id',
      'attachments',
      'reasoning_effort',
      'thinking',
    ])
      expect(body).not.toHaveProperty(absent);
    for (const header of [
      'x-session-id',
      'x-session-affinity',
      'session_id',
      'x-client-request-id',
    ])
      expect(request.headers.has(header)).toBe(false);
    const messages = body.messages as { role: string }[];
    expect(messages.map((message) => message.role)).toEqual(
      profile === 'openai-chat' ? ['system', 'user', 'user'] : ['user', 'user'],
    );
    await f.runtime.close();
  });

  it.each([0, 19])(
    'strips unsolicited thinking while keeping reasoningTokens=%s and default effort absent',
    async (tokens) => {
      const f = fixture(profile, (request) => thinkingResponse(request, validOutput, tokens));
      const result = await f.runtime.executeStructuredPrompt(f.request);
      expect(result).toMatchObject({
        status: 'succeeded',
        observations: [{ usage: { reasoningTokens: tokens } }],
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE THINKING');
      for (const field of ['reasoning_effort', 'thinking', 'output_config'])
        expect(f.requests[0]!.body).not.toHaveProperty(field);
      await f.runtime.close();
    },
  );

  it('passes only explicitly supported reasoning effort at the original output budget', async () => {
    const f = fixture(profile);
    await f.runtime.executeStructuredPrompt({
      ...f.request,
      reasoningEffort: 'high',
    });
    expect(f.requests[0]!.body).toMatchObject(
      profile === 'openai-chat'
        ? { reasoning_effort: 'high', thinking: { type: 'enabled' }, max_tokens: 1024 }
        : { thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, max_tokens: 1024 },
    );
    await f.runtime.close();
  });

  it.each(['minimum', 'effort'] as const)(
    'rejects %s in preflight with zero calls and observations',
    async (kind) => {
      const f = fixture(profile);
      const result = await f.runtime.executeStructuredPrompt({
        ...f.request,
        ...(kind === 'effort' ? { reasoningEffort: 'medium' as const } : {}),
        ...(kind === 'minimum' ? { spec: { ...f.request.spec, minOutputTokens: 1025 } } : {}),
      });
      expect(result).toEqual({
        status: 'failed',
        error: kind === 'minimum' ? 'MODEL_MAX_TOKENS_INSUFFICIENT' : 'MODEL_REASONING_UNSUPPORTED',
        observations: [],
      });
      expect(f.transport).not.toHaveBeenCalled();
      expect(f.request.observe).not.toHaveBeenCalled();
      expect(f.recordVerification).not.toHaveBeenCalled();
      await f.runtime.close();
    },
  );

  it.each(['{"character":7}', '{"character":"C99"}'])(
    'performs exactly one repair for invalid output %s, preserving system/shared prefix',
    async (bad) => {
      const f = fixture(profile, (request, index) =>
        protocolResponse(request, index === 1 ? bad : validOutput),
      );
      const current = f.request.spec;
      const repair = vi.fn(current.repair!);
      const result = await f.runtime.executeStructuredPrompt({
        ...f.request,
        spec: { ...current, repair },
      });
      expect(result).toMatchObject({
        status: 'succeeded',
        value: { characterId: 'business-character' },
      });
      expect(result.observations.map((value) => value.purpose)).toEqual([
        'structured',
        'structured-repair',
      ]);
      expect(repair).toHaveBeenCalledOnce();
      expect(f.requests).toHaveLength(2);
      expect(f.recordVerification).toHaveBeenCalledTimes(2);
      expect(f.requests.map(({ body }) => body.max_tokens)).toEqual([1024, 512]);
      const first = f.requests[0]!.body;
      const second = f.requests[1]!.body;
      expect(second.system).toEqual(first.system);
      const messages = (value: Record<string, unknown>) => value.messages as unknown[];
      expect(messages(second).slice(0, -1)).toEqual(messages(first).slice(0, -1));
      expect(JSON.stringify(messages(second).at(-1))).toContain('Repair exactly these issues');
      await f.runtime.close();
    },
  );

  it.each(['{"character":7}', '{"character":"C99"}'])(
    'fails after an invalid repair %s with no third dispatch',
    async (bad) => {
      const f = fixture(profile, (request) => protocolResponse(request, bad));
      const result = await f.runtime.executeStructuredPrompt(f.request);
      expect(result).toMatchObject({
        status: 'failed',
        error: 'MODEL_OUTPUT_INVALID',
        issues: [{ code: bad.includes('C99') ? 'UNKNOWN_REF_CODE' : 'INVALID_FIELD' }],
      });
      expect(result.observations).toHaveLength(2);
      expect(f.requests).toHaveLength(2);
      await f.runtime.close();
    },
  );

  it.each([undefined, 4096])(
    'uses snapshot budget for omitted or larger repair limit %s',
    async (limit) => {
      const f = fixture(profile, (request, index) =>
        protocolResponse(request, index === 1 ? 'bad' : validOutput),
      );
      const current = f.request.spec;
      await f.runtime.executeStructuredPrompt({
        ...f.request,
        spec: {
          ...current,
          repair: (...args) => {
            const repair = current.repair!(...args);
            return {
              prompt: repair.prompt,
              parse: repair.parse,
              ...(limit === undefined ? {} : { maxOutputTokens: limit }),
            };
          },
        },
      });
      expect(f.requests.map(({ body }) => body.max_tokens)).toEqual([1024, 1024]);
      expect(f.callModel.mock.calls.map(([request]) => request.maxOutputTokens)).toEqual([
        undefined,
        limit,
      ]);
      await f.runtime.close();
    },
  );

  it('fails max-tokens without parsing or repair and still verifies an actual 200 body call', async () => {
    const f = fixture(profile, (request) =>
      protocolResponse(request, validOutput, false, { ending: 'max-tokens' }),
    );
    const current = f.request.spec;
    const parse = vi.fn(current.parseAndValidate);
    const repair = vi.fn(current.repair!);
    const result = await f.runtime.executeStructuredPrompt({
      ...f.request,
      spec: { ...current, parseAndValidate: parse, repair },
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: 'MODEL_OUTPUT_TRUNCATED',
      observations: [{ finish: 'max-tokens' }],
    });
    expect(f.requests).toHaveLength(1);
    expect(parse).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
    expect(f.recordVerification).toHaveBeenCalledOnce();
    await f.runtime.close();
  });

  it('has a one-call plain text path with thinking filtered and empty shared context preserved', async () => {
    const f = fixture(profile, (request) => thinkingResponse(request, 'canvas plain text', 12));
    const result = await f.runtime.executeTextPrompt({
      ...f.request,
      input: { system, sharedContext: '', prompt: 'Transform upstream text' },
    });
    expect(result).toMatchObject({
      status: 'succeeded',
      value: 'canvas plain text',
      observations: [{ purpose: 'prompt-text', usage: { reasoningTokens: 12 } }],
    });
    expect(f.requests).toHaveLength(1);
    await f.runtime.close();
  });

  it.each([401, 402, 429, 504, 'overflow'] as const)(
    'sanitizes rejection %s, with one dispatch, zero repair and zero verification',
    async (code) => {
      const f = fixture(
        profile,
        () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'context_length_exceeded',
                message: 'synthetic-prompt-owner-key PRIVATE UPSTREAM DETAIL',
              },
            }),
            {
              status: code === 'overflow' ? 400 : code,
              headers: { 'content-type': 'application/json' },
            },
          ),
      );
      const result = await f.runtime.executeStructuredPrompt(f.request);
      const error = {
        401: 'MODEL_AUTH_FAILED',
        402: 'MODEL_QUOTA_EXCEEDED',
        429: 'MODEL_RATE_LIMITED',
        504: 'MODEL_TIMEOUT',
        overflow: 'MODEL_CONTEXT_OVERFLOW',
      }[code];
      expect(result).toMatchObject({ status: 'failed', error });
      expect(f.requests).toHaveLength(1);
      expect(f.request.observe).toHaveBeenCalledOnce();
      expect(f.recordVerification).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toMatch(
        /synthetic-prompt-owner-key|PRIVATE UPSTREAM DETAIL/,
      );
      await f.runtime.close();
    },
  );

  it('does not verify a non-200 success or unsolicited tool output', async () => {
    const f = fixture(profile, async (request, index) =>
      index === 1
        ? new Response(await protocolResponse(request, validOutput).text(), {
            status: 201,
            headers: { 'content-type': 'text/event-stream' },
          })
        : protocolToolResponse(profile === 'anthropic-messages'),
    );
    const first = await f.runtime.executeStructuredPrompt(f.request);
    expect(first.status).toBe('succeeded');
    const second = await f.runtime.executeStructuredPrompt(f.request);
    expect(second.status).toBe('failed');
    expect(f.requests).toHaveLength(2);
    expect(f.recordVerification).not.toHaveBeenCalled();
    await f.runtime.close();
  });
});

describe.each(profiles)('admission and terminal boundaries (%s)', (profile) => {
  it('cancels before entry with zero dispatch, observation and verification', async () => {
    const f = fixture(profile);
    const controller = new AbortController();
    controller.abort();
    expect(
      await f.runtime.executeStructuredPrompt({
        ...f.request,
        signal: controller.signal,
      }),
    ).toEqual({ status: 'cancelled', observations: [] });
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.request.observe).not.toHaveBeenCalled();
    expect(f.recordVerification).not.toHaveBeenCalled();
    await f.runtime.close();
  });

  it('cancels during SDK preparation without inventing an outbound observation', async () => {
    const f = fixture(profile);
    const controller = new AbortController();
    const pending = callPromptModel({
      ...f.request,
      signal: controller.signal,
      input: { system, prompt: 'text' },
      purpose: 'prompt-text',
    });
    controller.abort();
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.request.observe).not.toHaveBeenCalled();
    await f.runtime.close();
  });

  it('uses the route idle timeout and retains unknown without automatic resend', async () => {
    const f = fixture(profile, (request) => protocolResponse(request, 'partial', true));
    const selected = Object.freeze({ ...f.request.snapshot, streamIdleTimeoutMs: 25 });
    const result = await f.runtime.executeStructuredPrompt({
      ...f.request,
      snapshot: selected,
    });
    expect(result).toMatchObject({
      status: 'unknown',
      error: 'MODEL_STREAM_INTERRUPTED',
      observations: [{ finish: 'unknown', failureCode: 'TIMEOUT' }],
    });
    expect(f.requests).toHaveLength(1);
    expect(f.recordVerification).not.toHaveBeenCalled();
    await f.runtime.close();
  });

  it('persists aborted after active cancellation with zero repair or verification', async () => {
    const entered = Promise.withResolvers<void>();
    const controller = new AbortController();
    const f = fixture(profile, (request) => {
      entered.resolve();
      return protocolResponse(request, 'partial', true);
    });
    const pending = f.runtime.executeStructuredPrompt({
      ...f.request,
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({
      status: 'cancelled',
      observations: [{ finish: 'aborted', failureCode: 'ABORTED' }],
    });
    expect(f.requests).toHaveLength(1);
    expect(f.request.observe).toHaveBeenCalledOnce();
    expect(f.recordVerification).not.toHaveBeenCalled();
    await f.runtime.close();
  });

  it.each(['incomplete', 'network', 'body-drop'] as const)(
    'closes an unconfirmed %s drop as unknown and never resends',
    async (kind) => {
      const f = fixture(profile, async (request) => {
        if (kind === 'body-drop') {
          const prefix = await protocolResponse(request, validOutput, false, {
            ending: 'incomplete',
          }).text();
          let started = false;
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (!started) {
                  started = true;
                  controller.enqueue(new TextEncoder().encode(prefix));
                } else controller.error(new Error('PRIVATE BODY DROPPED'));
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        if (kind === 'network')
          throw new Error('synthetic-prompt-owner-key PRIVATE NETWORK DETAIL');
        return protocolResponse(request, validOutput, false, { ending: 'incomplete' });
      });
      const result = await f.runtime.executeStructuredPrompt(f.request);
      expect(result).toMatchObject({
        status: 'unknown',
        error: 'MODEL_STREAM_INTERRUPTED',
        observations: [{ finish: 'unknown' }],
      });
      expect(f.requests).toHaveLength(1);
      expect(f.recordVerification).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
      await f.runtime.close();
    },
  );

  it.each([false, true])(
    'observation failure has unknown priority even when active cancellation=%s',
    async (cancel) => {
      const entered = Promise.withResolvers<void>();
      const controller = new AbortController();
      const f = fixture(profile, (request) => {
        entered.resolve();
        return protocolResponse(request, validOutput, cancel);
      });
      const observe = vi.fn(async () => {
        throw new Error('PRIVATE OBSERVATION FAILURE');
      });
      const pending = f.runtime.executeStructuredPrompt({
        ...f.request,
        observe,
        signal: controller.signal,
      });
      await entered.promise;
      if (cancel) controller.abort();
      const result = await pending;
      expect(result).toMatchObject({ status: 'unknown', error: 'OBSERVATION_UNAVAILABLE' });
      expect(result.observations).toHaveLength(1);
      expect(observe).toHaveBeenCalledOnce();
      expect(f.requests).toHaveLength(1);
      expect(f.recordVerification).not.toHaveBeenCalled();
      await f.runtime.close();
    },
  );

  it.each(['structured', 'text'] as const)(
    'enforces the fixed cap of sixteen for %s without a FIFO',
    async (kind) => {
      const entered = Promise.withResolvers<void>();
      const f = fixture(profile, (request, index) => {
        if (index === 16) entered.resolve();
        return protocolResponse(request, validOutput, true);
      });
      const execute = (signal: AbortSignal) =>
        kind === 'structured'
          ? f.runtime.executeStructuredPrompt({ ...f.request, signal })
          : f.runtime.executeTextPrompt({
              ...f.request,
              signal,
              input: { system, prompt: 'text' },
            });
      const controllers = Array.from({ length: 16 }, () => new AbortController());
      const pending = controllers.map((controller) => execute(controller.signal));
      await entered.promise;
      expect(() => execute(new AbortController().signal)).toThrow(
        expect.objectContaining({ status: 503, code: 'PROMPT_RUNTIME_UNAVAILABLE' }),
      );
      expect(f.requests).toHaveLength(16);
      for (const controller of controllers) controller.abort();
      await Promise.all(pending);
      await f.runtime.close();
      expect(f.requests).toHaveLength(16);
    },
  );

  it('stops admission synchronously and drains observation, verification and the admitted repair', async () => {
    const f = fixture(profile, (request, index) =>
      protocolResponse(request, index === 1 ? 'invalid' : validOutput),
    );
    const observationEntered = Promise.withResolvers<void>();
    const resumeObservation = Promise.withResolvers<void>();
    const verificationEntered = Promise.withResolvers<void>();
    const resumeVerification = Promise.withResolvers<void>();
    const observe = vi
      .fn(async () => {})
      .mockImplementationOnce(async () => {
        observationEntered.resolve();
        await resumeObservation.promise;
      });
    f.recordVerification.mockImplementationOnce(async () => {
      verificationEntered.resolve();
      await resumeVerification.promise;
    });
    const request = { ...f.request, observe };
    const pending = f.runtime.executeStructuredPrompt(request);
    await observationEntered.promise;
    let closed = false;
    const closing = f.runtime.close();
    void closing.then(() => {
      closed = true;
    });
    expect(f.runtime.close()).toBe(closing);
    expect(() => f.runtime.executeStructuredPrompt(request)).toThrow(
      expect.objectContaining({ status: 503 }),
    );
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(f.recordVerification).not.toHaveBeenCalled();
    resumeObservation.resolve();
    await verificationEntered.promise;
    expect(closed).toBe(false);
    resumeVerification.resolve();
    expect((await pending).status).toBe('succeeded');
    await closing;
    expect(closed).toBe(true);
    expect(f.requests).toHaveLength(2);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(f.recordVerification).toHaveBeenCalledTimes(2);
  });

  it('keeps durable success when verification fails, with a sanitized diagnostic', async () => {
    const f = fixture(profile);
    f.recordVerification.mockRejectedValueOnce(new Error('PRIVATE VERIFICATION FAILURE'));
    const result = await f.runtime.executeTextPrompt({
      ...f.request,
      input: { system, prompt: 'text' },
    });
    expect(result.status).toBe('succeeded');
    expect(f.request.observe).toHaveBeenCalledOnce();
    expect(f.recordVerification).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    await f.runtime.close();
  });

  it('rejects invalid output without a declared repair, and text truncation without a second dispatch', async () => {
    const f = fixture(profile, (request, index) =>
      protocolResponse(
        request,
        'prefix ' + validOutput,
        false,
        index === 2 ? { ending: 'max-tokens' } : {},
      ),
    );
    const noRepair = { ...f.request.spec };
    delete noRepair.repair;
    const first = await f.runtime.executeStructuredPrompt({
      ...f.request,
      spec: noRepair,
    });
    expect(first).toMatchObject({
      status: 'failed',
      error: 'MODEL_OUTPUT_INVALID',
      issues: [{ code: 'INVALID_JSON' }],
    });
    const second = await f.runtime.executeTextPrompt({
      ...f.request,
      input: { system, prompt: 'text' },
    });
    expect(second).toMatchObject({ status: 'failed', error: 'MODEL_OUTPUT_TRUNCATED' });
    expect(f.requests).toHaveLength(2);
    await f.runtime.close();
  });
});
