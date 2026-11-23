import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type {
  ConversationEvent,
  ConversationImageJobView,
  ConversationImageTools,
  ConversationVision,
} from '../../src/conversations/contracts.ts';
import { applyConversationPolicies } from '../../src/dsh/conversation-checkpoints.ts';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import { createConversationVision } from '../../src/dsh/vision.ts';
import { protocolResponse } from '../onelink/fixture.ts';
import { kernelRuntime, ScriptedModel } from '../support/kernel-runtime.ts';

const sessionId = 'mio-checkpoint-fixture';
const ids = [
  'c9a4701e-d436-4d9a-940a-e0ac5fab93a1',
  'c9a4701e-d436-4d9a-940a-e0ac5fab93a2',
  'c9a4701e-d436-4d9a-940a-e0ac5fab93a3',
] as const;
const job: ConversationImageJobView = {
  jobId: ids[0],
  status: 'submitted',
  requestedCount: 1,
  errorCode: null,
  assetIds: [],
  outputs: [],
};
const snapshot = {
  providerConfigId: 'fixture-provider',
  providerRevision: 1,
  credentialVersion: 1,
  modelKey: 'fixture-model',
  catalogVersion: 1,
  adaptationVersion: 1,
  operation: 'chat',
  profile: 'openai-chat',
  modelRef: 'onelink:chat:fixture-model',
  modelId: 'fixture-model',
  protocol: 'openai-chat',
  capabilityVersion: 'onelink-text-v1',
  apiKey: 'synthetic-private-key',
} as const;

type ImageCall = {
  name: 'submit_image_job' | 'get_image_job' | 'inspect_image_asset';
  args: Record<string, string>;
};
const submit: ImageCall = {
  name: 'submit_image_job',
  args: { modelRef: 'onelink:image:fixture', prompt: 'fixture image' },
};

function toolResponse(turn: number, calls: readonly ImageCall[]): Response {
  const delta = {
    role: 'assistant',
    tool_calls: calls.map(({ name, args }, index) => ({
      index,
      id: `call_${turn}_${index}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    })),
  };
  const chunks = [
    { delta, finish_reason: null },
    { delta: {}, finish_reason: 'tool_calls' },
  ].map((choice) => ({
    id: `fixture_${turn}`,
    object: 'chat.completion.chunk',
    model: snapshot.modelId,
    choices: [{ index: 0, ...choice }],
  }));
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

const contexts: Context[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(
  respond: (request: Request, count: number) => Response | Promise<Response>,
  createImage = vi.fn<ConversationImageTools['createImage']>().mockResolvedValue(job),
  vision?: ConversationVision,
) {
  const root = await mkdtemp(join(tmpdir(), 'mio-checkpoints-'));
  roots.push(root);
  const ctx = await kernelRuntime(root, new ScriptedModel([]));
  contexts.push(ctx);
  await ctx.plugin({
    name: 'mio-conversation-policies',
    inject: ['mioKernel', 'sessions', 'tools'],
    apply: applyConversationPolicies,
  });
  const requests: { messages: unknown[] }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push((await request.clone().json()) as { messages: unknown[] });
    return respond(request, requests.length);
  });
  const getImage = vi.fn<ConversationImageTools['getImage']>(async (_actor, jobId) => ({
    ...job,
    jobId,
    status: 'completed',
  }));
  const engine = createDshConversationEngine(
    ctx,
    { databaseURL: 'unused', byok: true },
    {
      createImage,
      getImage,
      listModels: async () => [],
    },
    vision,
  );
  const selected = vision ? { ...snapshot, inputModalities: ['text', 'image'] as const } : snapshot;
  await engine.create(sessionId, selected);
  const published: ConversationEvent[] = [];
  return {
    ctx,
    requests,
    createImage,
    getImage,
    published,
    run: (requestId = 'turn-one') =>
      engine.run(
        sessionId,
        requestId,
        'fixture user input',
        async () => {},
        (event) => {
          published.push(event);
        },
        {
          userId: 'owner',
          conversationId: 'conversation',
          dshSessionId: sessionId,
          requestId,
          snapshot: selected,
          observe: async () => {},
        },
      ),
    async coldHistory() {
      const reader = await kernelRuntime(root, new ScriptedModel([]));
      try {
        expect(reader.agents.list()).toEqual([]);
        return await createDshConversationEngine(reader, { databaseURL: 'unused' }).history(
          sessionId,
          -1,
          100,
        );
      } finally {
        await reader.fiber.dispose();
      }
    },
  };
}

it.each([
  { eventType: 'request/header', failure: 'reject', modelCalls: 0 },
  { eventType: 'tool/call', failure: 'reject', modelCalls: 1 },
  { eventType: 'tool/call', failure: 'no listener', modelCalls: 1 },
] as const)(
  'stops at native $eventType checkpoint with $failure and allows a new turn',
  async ({ eventType, failure, modelCalls }) => {
    let manual = false;
    const run = await setup((request, count) =>
      !manual && count === 1
        ? toolResponse(count, [submit])
        : protocolResponse(request, 'fresh turn'),
    );
    let reached = false;
    let injected = false;
    run.ctx.on('session/event', (session, event) => {
      if (session.id === sessionId && event.type === eventType) reached = true;
    });
    run.ctx.on('session/flush', (session) => {
      if (failure !== 'reject' || session.id !== sessionId || !reached || injected) return;
      injected = true;
      throw new Error('synthetic private persistence diagnostic');
    });
    const flush = run.ctx.sessions.flush.bind(run.ctx.sessions);
    const spy = vi.spyOn(run.ctx.sessions, 'flush').mockImplementation((session) => {
      if (failure === 'no listener' && session.id === sessionId && reached && !injected) {
        injected = true;
        return Promise.resolve(false);
      }
      return flush(session);
    });
    try {
      expect(await run.run()).toBe('unknown');
      expect(injected).toBe(true);
      expect(run.requests).toHaveLength(modelCalls);
      expect(run.createImage).toHaveBeenCalledTimes(0);
      expect((await run.coldHistory()).items.some((item) => item.role === 'tool')).toBe(false);
      manual = true;
      expect(await run.run('manual-second')).toBe('completed');
      expect(run.requests).toHaveLength(modelCalls + 1);
      expect(run.createImage).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  },
);

it.each(['after tool result', 'before next model response'] as const)(
  'cold reads the successful card before cleanup when interrupted %s',
  async (boundary) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const run = await setup(async (_request, count) => {
      if (count === 1) return toolResponse(count, [submit]);
      if (boundary === 'before next model response') {
        entered.resolve();
        await release.promise;
      }
      return new Response('{"error":{"message":"private upstream"}}', { status: 504 });
    });
    let resultSeen = false;
    let cardCheckpointStarted = false;
    let faultArmed = false;
    run.ctx.on('session/event', (session, event) => {
      if (session.id === sessionId && event.type === 'tool/result') resultSeen = true;
    });
    run.ctx.on('session/flush', (session) => {
      if (session.id !== sessionId) return;
      if (resultSeen) cardCheckpointStarted = true;
      if (faultArmed) {
        faultArmed = false;
        throw new Error('synthetic step checkpoint refusal');
      }
    });
    run.ctx.on(
      'agent/pre-step',
      async ({ agent, step }, next) => {
        if (agent.id === sessionId && step === 2 && boundary === 'after tool result') {
          entered.resolve();
          await release.promise;
          faultArmed = true;
        }
        return next();
      },
      { prepend: true },
    );
    const running = run.run();
    try {
      await entered.promise;
      expect(cardCheckpointStarted).toBe(true);
      expect(run.createImage).toHaveBeenCalledOnce();
      expect(run.ctx.agents.list()).toHaveLength(1);
      const stored = await run.coldHistory();
      expect(stored.items.filter((item) => item.role === 'status')).toMatchObject([
        { status: 'interrupted' },
      ]);
      expect(stored.items.filter((item) => item.role === 'tool')).toMatchObject([
        { tool: 'submit_image_job', job },
      ]);
      expect(run.published.filter((event) => event.type === 'tool')).toMatchObject([
        { tool: 'submit_image_job', job },
      ]);
    } finally {
      release.resolve();
      expect(await running).toEqual(
        boundary === 'after tool result' ? 'unknown' : { status: 'failed', error: 'MODEL_TIMEOUT' },
      );
    }
    expect(run.requests).toHaveLength(boundary === 'after tool result' ? 1 : 2);
  },
);

it.each(['four identical calls', 'different arguments in parallel'] as const)(
  'continues and finishes with native tool reminder policy for %s',
  async (sequence) => {
    const repeated = sequence === 'four identical calls';
    const polls = (jobIds: readonly string[]): ImageCall[] =>
      jobIds.map((jobId) => ({ name: 'get_image_job', args: { jobId } }));
    const run = await setup((request, count) => {
      if (repeated && count <= 4) return toolResponse(count, polls([ids[0]]));
      if (!repeated && count === 1) return toolResponse(count, polls(ids));
      return protocolResponse(request, 'no more calls needed');
    });
    expect(await run.run()).toBe('completed');
    expect(run.getImage).toHaveBeenCalledTimes(repeated ? 4 : 3);
    expect(run.requests).toHaveLength(repeated ? 5 : 2);
    if (repeated) {
      expect(JSON.stringify(run.requests[1])).not.toContain('identical arguments');
      expect(JSON.stringify(run.requests[2])).toContain('identical arguments');
      expect(JSON.stringify(run.requests[4])).toContain('consecutive_calls: 4');
    } else {
      expect(JSON.stringify(run.requests)).not.toMatch(
        /identical arguments|Repeated tool call detected/,
      );
    }
    expect(JSON.stringify(await run.coldHistory())).not.toMatch(
      /identical arguments|Repeated tool call detected/,
    );
  },
);

it('passes the inspection deadline to its read and keeps the submitted job handle', async () => {
  const inspecting = Promise.withResolvers<AbortSignal>();
  const submitting = Promise.withResolvers<AbortSignal>();
  const releaseJob = Promise.withResolvers<ConversationImageJobView>();
  const vision = createConversationVision(async (_owner, _asset, _expected, signal) => {
    inspecting.resolve(signal);
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const createImage = vi.fn<ConversationImageTools['createImage']>(async (...args) => {
    submitting.resolve(args[4]);
    return releaseJob.promise;
  });
  const run = await setup(
    (request, count) => {
      if (count === 1) {
        return toolResponse(count, [{ name: 'inspect_image_asset', args: { assetId: ids[1] } }]);
      }
      if (count === 2) return toolResponse(count, [submit]);
      return protocolResponse(request, 'submitted');
    },
    createImage,
    vision,
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const running = run.run();
  try {
    const inspectionSignal = await inspecting.promise;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inspectionSignal.reason).toMatchObject({ code: 'TOOL_TIMEOUT' });
    const submissionSignal = await submitting.promise;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(submissionSignal.aborted).toBe(false);
  } finally {
    releaseJob.resolve(job);
  }
  expect(await running).toBe('completed');
  expect(JSON.stringify(run.requests[1])).toContain('tool call timed out');
  expect((await run.coldHistory()).items.filter((item) => item.role === 'tool')).toMatchObject([
    { tool: 'submit_image_job', job },
  ]);
});
