import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import type { AudioJobView } from '../../src/audio/contracts.ts';
import type { FrozenAudioContext } from '../../src/audio/jobs/service.ts';
import type {
  Conversation,
  ConversationAudioTools,
  HistoryPage,
  Receipt,
} from '../../src/conversations/contracts.ts';
import { createConversationHandler } from '../../src/conversations/http.ts';
import { checkConversationSchema, conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { createConversationService } from '../../src/conversations/service.ts';
import { createConversationStore } from '../../src/conversations/store.ts';
import { authorizeConversationAudioTools } from '../../src/dsh/policy.ts';
import { parseAudioJobPresentationMeta } from '../../src/dsh/audio-tools.ts';
import { installConversationTitles } from '../../src/dsh/conversation-titles.ts';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import { authDatabase } from '../support/auth-database.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { ONELINK_ORIGIN } from '../../src/integrations/onelink/models.ts';
import { protocolResponse } from '../onelink/fixture.ts';
import { makeChatRouteFixture } from '../providers/fixtures/onelink-routes-fixture.ts';
import { kernelRuntime, ScriptedModel, textResponse } from '../support/kernel-runtime.ts';

const base = '/api/v1/conversations';
const voiceA = randomUUID();
const voiceB = randomUUID();
const sourceAsset = randomUUID();
const ttsModel = 'onelink:model:' + randomUUID();
const cloneModel = 'onelink:model:' + randomUUID();
const sample = {
  assetId: sourceAsset,
  authorized: true,
  name: '测试样本',
  auditionText: '试听测试',
} as const;
const fingerprint = 'fixture-asset-fingerprint';

function job(kind: 'tts' | 'clone' = 'tts'): AudioJobView {
  return {
    jobId: randomUUID(),
    kind,
    status: 'queued',
    errorCode: null,
    recordId: null,
    voiceRef: null,
    text: '公开卡片正文',
    parameters: null,
    recoverable: false,
    cancelRequested: false,
    assetIds: [],
    outputs: [],
  };
}

const chatModelId = 'audio-conversation-chat-fixture';
const chatKey = 'synthetic-owner-only-chat-key';

function tool(name: string, args: Record<string, unknown>) {
  return () => {
    const chunk = { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', model: chatModelId };
    const open = {
      ...chunk,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${randomUUID()}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    const close = {
      ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    };
    return new Response(
      `data: ${JSON.stringify(open)}\n\ndata: ${JSON.stringify(close)}\n\ndata: [DONE]\n\n`,
      {
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-audio-chat' },
      },
    );
  };
}

function fixtureAudio() {
  const create = vi.fn<ConversationAudioTools['create']>(async () => ({
    created: true,
    job: job(),
  }));
  const clone = vi.fn<ConversationAudioTools['clone']>(async () => ({
    created: true,
    job: job('clone'),
  }));
  const freeze = vi.fn<ConversationAudioTools['freezeContext']>(async (_actor, raw) => {
    const value = structuredClone(raw as FrozenAudioContext);
    if (value.sample) value.sample.fingerprint = fingerprint;
    return value;
  });
  return {
    create,
    clone,
    freezeContext: freeze,
    async listModels() {
      return [];
    },
    async listVoices() {
      return { items: [] };
    },
    async get() {
      return job();
    },
    async resolveVoice(_actor, voiceRef) {
      return { voiceRef, name: voiceRef === voiceA ? 'A' : 'B' };
    },
  } satisfies ConversationAudioTools;
}

async function openEvents(origin: string, id: string) {
  const abort = new AbortController();
  const response = await fetch(`${origin}${base}/${id}/events`, {
    headers: { origin, cookie: 'synthetic=owner' },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const received: Record<string, unknown>[] = [];
  const reading = (async () => {
    let pending = '';
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        for (let end = pending.indexOf('\n\n'); end >= 0; end = pending.indexOf('\n\n')) {
          const data = pending
            .slice(0, end)
            .split('\n')
            .find((line) => line.startsWith('data: '));
          if (data) received.push(JSON.parse(data.slice(6)) as Record<string, unknown>);
          pending = pending.slice(end + 2);
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    received,
    close: () => {
      abort.abort();
      return reading;
    },
  };
}

it('runs the audio conversation through HTTP, PostgreSQL, native DSH tools, durable cards and fork/reconnect', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  const root = await mkdtemp(join(tmpdir(), 'mio-audio-conversation-'));
  const script: ((request: Request) => Response)[] = [
    tool('select_audio_voice', { voiceRef: voiceB }),
    (request) => protocolResponse(request, '已选 B'),
    tool('submit_audio_job', { text: '原正文', voiceRef: voiceB }),
    tool('clone_audio_voice', {}),
    tool('clone_audio_voice', { modelRef: cloneModel }),
    (request) => protocolResponse(request, '请在本轮提供授权样本'),
    tool('select_audio_voice', { voiceRef: voiceB }),
    tool('submit_audio_job', { text: '分叉后重配', voiceRef: voiceB }),
  ];
  const legacyModel = new ScriptedModel([textResponse('普通 legacy 回复')]);
  const audio = fixtureAudio();
  const ctx = await kernelRuntime(root, legacyModel);
  const realFetch = globalThis.fetch;
  const advertised: { name?: string }[][] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    if (target.origin !== ONELINK_ORIGIN) {
      if (target.hostname !== '127.0.0.1') throw new Error('Unexpected fixture network target');
      return realFetch(request);
    }
    expect(target.pathname).toBe('/v1/chat/completions');
    expect(request.headers.get('authorization')).toBe(`Bearer ${chatKey}`);
    const body = (await request.clone().json()) as {
      model: string;
      tools?: { function?: { name?: string } }[];
    };
    expect(body.model).toBe(chatModelId);
    advertised.push(body.tools?.map((entry) => entry.function ?? {}) ?? []);
    const next = script.shift();
    if (!next) throw new Error('Unexpected OneLink call');
    return next(request);
  });
  await ctx.inject(['sessions', 'sessionProjections', 'agents'], async (titleCtx) => {
    await installConversationTitles(titleCtx);
  });
  const server = createServer();
  await pool.query(conversationSchemaSQL);
  const legacyId = randomUUID();
  const actor = { userId: randomUUID(), sessionId: 'fixture-session' };
  await pool.query(`ALTER TABLE mio_conversations DROP CONSTRAINT mio_conversations_purpose_check,
    ADD CONSTRAINT mio_conversations_purpose_check CHECK(purpose IN ('general','drama-script'))`);
  await pool.query(
    `INSERT INTO mio_conversations(id,owner_id,dsh_session_id,state) VALUES($1,$2,$3,'ready')`,
    [legacyId, actor.userId, `mio-${legacyId}`],
  );
  await expect(checkConversationSchema(pool)).rejects.toThrow('conversation purpose constraint');
  await pool.query(conversationSchemaSQL);
  await pool.query(conversationSchemaSQL);
  await pool.query(providerSchemaSQL);
  const providerConfig = {
    databaseURL: database.url,
    masterKey: randomBytes(32),
    masterKeyId: 'audio-conversation-fixture',
  };
  const providerStore = await createProviderStore(providerConfig);
  const providers = createProviderService(providerStore, providerConfig, async () =>
    Response.json({ data: [{ id: chatModelId }] }),
  );
  await providers.save(actor, 0, chatKey);
  await providers.discover(actor);
  await providerStore.importRoutes(makeChatRouteFixture(chatModelId, 'openai'));
  const chatModelRef = (await providers.catalog(actor, 'chat')).items[0]!.modelRef;
  const config = { databaseURL: database.url, byok: true };
  const engine = createDshConversationEngine(ctx, config, undefined, undefined, audio);
  const legacyEngine = createDshConversationEngine(
    ctx,
    { databaseURL: database.url, provider: 'mio-test-only', model: 'scripted' },
    undefined,
    undefined,
    audio,
  );
  const store = await createConversationStore(database.url);
  const service = createConversationService(store, engine, providers, undefined, undefined, audio);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  const handler = createConversationHandler(
    service,
    async (headers) => {
      if (headers.get('cookie') === 'synthetic=owner') return actor;
      return { userId: 'other-fixture', sessionId: 'other-fixture' };
    },
    [origin],
  );
  server.on('request', handler.handler);
  const call = (path: string, method = 'GET', input?: unknown, owner = true) =>
    fetch(`${origin}${base}${path}`, {
      method,
      headers: {
        origin,
        cookie: owner ? 'synthetic=owner' : 'synthetic=stranger',
        'content-type': 'application/json',
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  const create = async (purpose?: 'audio' | 'drama-script') => {
    const response = await call('', 'POST', { purpose, modelRef: chatModelRef });
    expect(response.status).toBe(201);
    return response.json() as Promise<Conversation>;
  };
  const terminal = async (id: string, requestId: string) =>
    vi.waitFor(
      async () => {
        const response = await call(`/${id}/requests/${requestId}`);
        expect(response.status).toBe(200);
        expect(((await response.json()) as Receipt).status, requestId).toBe('completed');
      },
      { timeout: 5000, interval: 25 },
    );
  const streams: Awaited<ReturnType<typeof openEvents>>[] = [];
  try {
    const general = await create();
    const drama = await create('drama-script');
    const recording = await create('audio');
    const id = recording.id;
    const legacy = createConversationService(
      store,
      legacyEngine,
      undefined,
      undefined,
      undefined,
      audio,
    );
    await expect(legacy.create(actor, undefined, 'audio')).rejects.toMatchObject({
      code: 'AUDIO_UNAVAILABLE',
    });
    await expect(
      Promise.resolve().then(() => legacy.send(actor, id, 'legacy-unbound', '尝试无绑定工具')),
    ).rejects.toMatchObject({ code: 'AUDIO_UNAVAILABLE' });
    await legacyEngine.create('legacy-direct');
    expect(
      await legacyEngine.run(
        'legacy-direct',
        'legacy-audio-attempt',
        '尝试无绑定工具',
        async () => {},
        () => {},
        undefined,
        [],
        undefined,
        undefined,
        {
          purpose: 'audio',
          audio: {
            userId: actor.userId,
            conversationId: id,
            requestId: 'legacy-audio-attempt',
            audioContext: {},
            audioSelection: { voiceRef: voiceA, name: 'A', revision: 1 },
            selectAudioVoice: vi.fn(),
          },
        },
      ),
    ).toBe('completed');
    expect((legacyModel.requests[0]?.tools ?? []).some(({ name }) => name.includes('audio'))).toBe(
      false,
    );
    expect(audio.create).not.toHaveBeenCalled();
    expect(recording).toMatchObject({
      purpose: 'audio',
      audioSelection: { voiceRef: null, name: null, revision: 0 },
    });
    const ordinary = ((await (await call('')).json()) as { items: Conversation[] }).items;
    expect(new Set(ordinary.map((item) => item.id))).toEqual(
      new Set([general.id, drama.id, legacyId]),
    );
    expect(
      ((await (await call('?purpose=audio')).json()) as { items: Conversation[] }).items.map(
        (item) => item.id,
      ),
    ).toEqual([id]);
    expect(
      (
        await call(`/${general.id}/messages`, 'POST', {
          requestId: 'wrong-purpose',
          text: 'no',
          audioContext: {},
        })
      ).status,
    ).toBe(400);
    const patch = (voiceRef: string, expectedRevision: number, owner = true) =>
      call(`/${id}/audio-selection`, 'PATCH', { voiceRef, expectedRevision }, owner);
    expect((await patch(voiceA, 0, false)).status).toBe(404);
    const competing = await Promise.all([patch(voiceA, 0), patch(voiceB, 0)]);
    expect(competing.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await competing.find((r) => r.status === 409)!.json()).toMatchObject({
      error: { code: 'AUDIO_SELECTION_CONFLICT' },
    });
    const selectedA = (await (await patch(voiceA, 1)).json()) as {
      revision: number;
      voiceRef: string;
    };
    expect(selectedA.voiceRef).toBe(voiceA);

    const live = await openEvents(origin, id);
    streams.push(live);
    await vi.waitFor(() =>
      expect(live.received).toContainEqual(
        expect.objectContaining({ type: 'snapshot', audioSelection: selectedA }),
      ),
    );
    expect(
      (await call(`/${id}/messages`, 'POST', { requestId: 'voice-switch', text: '换成 B' })).status,
    ).toBe(202);
    await terminal(id, 'voice-switch');
    expect(audio.create).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(live.received).toContainEqual(
        expect.objectContaining({
          type: 'audio-selection',
          selection: { voiceRef: voiceB, name: 'B', revision: selectedA.revision + 1 },
        }),
      ),
    );
    const firstHistory = (await (await call(`/${id}/history`)).json()) as HistoryPage;
    const cutoff = firstHistory.items.findLast((item) => item.role === 'status')!.seq;

    const input = {
      requestId: 'voice-redo',
      text: '用 B 重配上一条',
      audioContext: { modelRef: ttsModel },
    };
    expect((await call(`/${id}/messages`, 'POST', input)).status).toBe(202);
    await vi.waitFor(() =>
      expect(live.received).toContainEqual(
        expect.objectContaining({
          type: 'tool',
          tool: 'submit_audio_job',
          requestId: input.requestId,
          job: expect.objectContaining({ status: 'queued' }),
        }),
      ),
    );
    await live.close();
    await terminal(id, input.requestId);
    expect(audio.create).toHaveBeenCalledExactlyOnceWith(
      { userId: actor.userId },
      expect.objectContaining({ modelRef: ttsModel, voiceRef: voiceB, text: '原正文' }),
    );
    const reconnected = await openEvents(origin, id);
    streams.push(reconnected);
    await vi.waitFor(() =>
      expect(reconnected.received).toContainEqual(
        expect.objectContaining({
          type: 'snapshot',
          receipt: expect.objectContaining({ requestId: input.requestId, status: 'completed' }),
        }),
      ),
    );
    const pendingLookups = audio.freezeContext.mock.calls.length;
    expect(await (await call(`/${id}/messages`, 'POST', input)).json()).toMatchObject({
      requestId: input.requestId,
      status: 'completed',
    });
    expect(
      (await call(`/${id}/messages`, 'POST', { ...input, audioContext: { modelRef: cloneModel } }))
        .status,
    ).toBe(409);
    expect(audio.freezeContext).toHaveBeenCalledTimes(pendingLookups);
    const history = (await (await call(`/${id}/history`)).json()) as HistoryPage;
    expect(history.items).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        tool: 'submit_audio_job',
        job: expect.objectContaining({ text: '公开卡片正文' }),
      }),
    );

    const clone = {
      requestId: 'voice-clone',
      text: '使用授权样本复刻',
      audioContext: { modelRef: cloneModel, sample },
    };
    expect((await call(`/${id}/messages`, 'POST', clone)).status).toBe(202);
    await terminal(id, 'voice-clone');
    expect(audio.clone).toHaveBeenCalledExactlyOnceWith(
      { userId: actor.userId },
      expect.objectContaining({
        modelRef: cloneModel,
        sampleAssetId: sourceAsset,
        sampleAuthorization: true,
      }),
      fingerprint,
    );
    const frozen = await pool.query(
      'SELECT audio_context FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2',
      [id, clone.requestId],
    );
    expect(frozen.rows[0]!.audio_context).toMatchObject({
      sample: { assetId: sourceAsset, fingerprint },
    });

    const forkResponse = await call(`/${id}/forks`, 'POST', {
      requestId: 'audio-fork',
      turnEndSeq: cutoff,
    });
    expect(forkResponse.status).toBe(201);
    const fork = (await forkResponse.json()) as Conversation;
    expect(fork).toMatchObject({
      purpose: 'audio',
      forkedFromConversationId: id,
      forkedUntilSeq: cutoff,
      audioSelection: { voiceRef: null, name: null, revision: 0 },
    });
    const forkHistory = (await (await call(`/${fork.id}/history`)).json()) as HistoryPage;
    expect(forkHistory.items.filter((item) => item.role === 'tool')).toEqual([]);
    const verifyOldVoice = await call(`/${fork.id}/messages`, 'POST', {
      requestId: 'fork-old-voice',
      text: '使用原来的音色',
      audioContext: { modelRef: ttsModel, voiceRef: voiceB },
    });
    expect(verifyOldVoice.status).toBe(409);
    expect(await verifyOldVoice.json()).toMatchObject({
      error: { code: 'AUDIO_SELECTION_CONFLICT' },
    });
    expect(audio.create).toHaveBeenCalledTimes(1);
    expect(
      (
        await call(`/${fork.id}/messages`, 'POST', {
          requestId: 'fork-clone',
          text: '复刻上次样本',
        })
      ).status,
    ).toBe(202);
    await terminal(fork.id, 'fork-clone');
    expect(audio.clone).toHaveBeenCalledTimes(1);
    expect(
      (
        await call(`/${fork.id}/messages`, 'POST', {
          requestId: 'fork-confirm-voice',
          text: '换 B 并配音',
          audioContext: { modelRef: ttsModel },
        })
      ).status,
    ).toBe(202);
    await terminal(fork.id, 'fork-confirm-voice');
    expect(audio.create).toHaveBeenCalledTimes(2);
    expect(audio.create).toHaveBeenLastCalledWith(
      { userId: actor.userId },
      expect.objectContaining({ voiceRef: voiceB, text: '分叉后重配' }),
    );

    expect(script).toHaveLength(0);
    expect(
      advertised.every(
        (tools) =>
          tools.some((item) => item.name === 'submit_audio_job') &&
          !tools.some((item) => item.name === 'submit_image_job'),
      ),
    ).toBe(true);
  } finally {
    await Promise.all(streams.map((stream) => stream.close()));
    await handler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
    await legacyEngine.close();
    await providers.close();
    vi.unstubAllGlobals();
    await ctx.fiber.dispose();
    await pool.end();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);

it('authorizes one audio submit across tool names and only for the active audio agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mio-audio-guard-'));
  const ctx = await kernelRuntime(root, new ScriptedModel([]));
  const other = await ctx.mioKernel.create('ordinary', {});
  let revoke: (() => void) | undefined;
  const handle = await ctx.mioKernel.create('audio', {}, (agentCtx, agent) => {
    revoke = authorizeConversationAudioTools(agentCtx, agent);
  });
  const exec = (name: string, agent = handle.agent) =>
    Object.freeze({
      name,
      agent,
      signal: new AbortController().signal,
    }) as unknown as ToolExecution;
  try {
    expect(ctx.tools.checkGuards(exec('submit_audio_job', other.agent))).toContain(
      'MIO_TOOL_DENIED',
    );
    expect(ctx.tools.checkGuards(exec('submit_image_job'))).toContain('MIO_TOOL_DENIED');
    const first = exec('submit_audio_job');
    expect(ctx.tools.checkGuards(first)).toBeUndefined();
    expect(ctx.tools.checkGuards(first)).toBeUndefined();
    expect(ctx.tools.checkGuards(exec('clone_audio_voice'))).toContain('one audio submission');
    expect(ctx.tools.checkGuards(exec('get_audio_job'))).toBeUndefined();
    revoke?.();
    expect(ctx.tools.checkGuards(exec('get_audio_job'))).toContain('MIO_TOOL_DENIED');
  } finally {
    await other.dispose();
    await handle.dispose();
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('validates durable audio cards without leaking provider metadata or sample identity', () => {
  const confirmed = {
    ...job('clone'),
    status: 'failed',
    errorCode: 'AUDIO_AUDITION_MISSING',
    upstreamConfirmed: true,
  };
  const metadata = { kind: 'mio.audio-job', tool: 'clone_audio_voice', job: confirmed };
  expect(parseAudioJobPresentationMeta(metadata)).toMatchObject({
    job: { upstreamConfirmed: true },
  });
  expect(
    parseAudioJobPresentationMeta({
      ...metadata,
      job: { ...confirmed, sample, providerKey: 'invalid' },
    }),
  ).toBeNull();
});
