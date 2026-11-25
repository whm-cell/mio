import { createHash, randomBytes } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import Tools, { ToolArgsError } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { Pool } from 'pg';
import { expect, it, onTestFinished, vi } from 'vitest';
import { legacyVideoRouteEntries } from '../../scripts/service/legacy-video-routes.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import type {
  ConversationRun,
  ConversationVideoJobView,
  ConversationVideoTools,
} from '../../src/conversations/contracts.ts';
import type { VideoJobView } from '../../src/generations/video/contracts.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { createVideoGenerationService } from '../../src/generations/video/service.ts';
import { VideoGenerationStore } from '../../src/generations/video/store.ts';
import {
  parseVideoJobPresentationMeta,
  registerConversationVideoTools,
} from '../../src/dsh/video-tools.ts';
import type { VideoAdmissionSnapshot, VideoRouteConfig } from '../../src/providers/contracts.ts';
import {
  validateVideoRouteConfig,
  videoModeParameters,
  videoRouteRuntimeAvailable,
} from '../../src/providers/onelink/video-route.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { createProviderService } from '../../src/providers/service.ts';
import type { ProviderService } from '../../src/providers/service.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { authDatabase } from '../support/auth-database.ts';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CONVERSATION_ID = '00000000-0000-4000-8000-000000000002';
const MODEL_REF = 'onelink:model:vega-1-5-pro';
const JOB_ID = '00000000-0000-4000-8000-000000000003';
const ASSET_ID = '00000000-0000-4000-8000-000000000004';

function run(requestId = 'turn-1'): ConversationRun {
  return {
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    dshSessionId: 'session-1',
    requestId,
    snapshot: {} as ConversationRun['snapshot'],
    observe: async () => undefined,
  };
}

function admissionState(
  available = true,
  textToVideo = true,
): Awaited<ReturnType<ProviderService['videoAdmission']>> {
  return {
    capabilitiesVersion: 'caps-v1',
    available,
    supportedModes: textToVideo ? ['text_to_video'] : ['first_frame'],
    snapshot: vi.fn(),
  };
}

function job(state: VideoJobView['state'] = 'submitted'): VideoJobView {
  return {
    id: JOB_ID,
    requestId: '00000000-0000-4000-8000-000000000005',
    modelRef: MODEL_REF,
    mode: 'text_to_video',
    state,
    stage: state === 'completed' ? 'done' : 'waiting',
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:01.000Z',
    completedAt: state === 'completed' ? '2026-11-24T00:00:02.000Z' : null,
    effectiveParameters: { mode: 'text_to_video', prompt: 'A quiet mountain lake at dawn.' },
    inputSnapshot: [],
    outputs:
      state === 'completed'
        ? [
            {
              index: 0,
              assetId: ASSET_ID,
              mediaType: 'video',
              status: 'registered',
              errorCode: null,
              sizeBytes: 128,
              sha256: '0'.repeat(64),
              width: 1280,
              height: 720,
              durationSeconds: 4,
              hasAudio: false,
            },
          ]
        : [],
    error: null,
    cancellation: { requested: false, supported: false, status: null },
    recovery: { available: false, reason: null },
  };
}

function setup(bridge: ConversationVideoTools, turn = run()) {
  const definitions = new Map<string, ToolDefinition>();
  const context = {
    tools: {
      register(definition: ToolDefinition) {
        definitions.set(definition.name, definition);
        return () => definitions.delete(definition.name);
      },
    },
  } as unknown as Context;
  registerConversationVideoTools(context, turn, bridge);
  return definitions;
}

function exec(callId = 'call-1'): Parameters<ToolDefinition['execute']>[1] {
  return { callId, signal: new AbortController().signal } as Parameters<
    ToolDefinition['execute']
  >[1];
}

function bridge(): ConversationVideoTools {
  return {
    listModels: vi.fn(async () => [
      {
        modelRef: MODEL_REF,
        modelId: 'vega-1.5-pro',
        name: 'Vega 1.5 Pro',
        vendor: 'Volcengine',
        available: true,
        unavailableReason: null,
        supportedModes: [
          { mode: 'text_to_video' as const, supported: true, parameters: { duration: [5] } },
        ],
      },
      {
        modelRef: 'onelink:model:pending-model',
        modelId: 'pending-model',
        name: 'Pending model',
        vendor: 'Other',
        available: false,
        unavailableReason: 'ADAPTER_PENDING',
        supportedModes: [{ mode: 'text_to_video' as const, supported: false }],
      },
    ]),
    createVideo: vi.fn(async () => job()),
    getVideo: vi.fn(async () => job('completed')),
    recoverVideo: vi.fn(async () => job('processing')),
  };
}

it('registers the current-user video tools and exposes unavailable models without making them runnable', async () => {
  const service = bridge();
  const definitions = setup(service);
  expect([...definitions.keys()]).toEqual([
    'list_video_models',
    'submit_video_job',
    'recover_video_job',
    'get_video_job',
  ]);
  for (const definition of definitions.values()) {
    expect(definition.parameters).toMatchObject({ additionalProperties: false });
  }

  const list = definitions.get('list_video_models')!;
  const result = (await list.execute({}, exec())) as {
    models: {
      modelRef: string;
      available: boolean;
      unavailableReason: string | null;
      supportedModes: unknown[];
    }[];
  };
  expect(result.models[0]!.supportedModes).toEqual([{ mode: 'text_to_video', supported: true }]);
  expect(
    result.models.map(({ modelRef, available, unavailableReason }) => ({
      modelRef,
      available,
      unavailableReason,
    })),
  ).toEqual([
    { modelRef: MODEL_REF, available: true, unavailableReason: null },
    {
      modelRef: 'onelink:model:pending-model',
      available: false,
      unavailableReason: 'ADAPTER_PENDING',
    },
  ]);
  expect(service.listModels).toHaveBeenCalledWith({ userId: USER_ID });
  const recovered = await definitions.get('recover_video_job')!.execute({ jobId: JOB_ID }, exec());
  expect(recovered).toMatchObject({ jobId: JOB_ID, status: 'processing' });
  expect(service.recoverVideo).toHaveBeenCalledWith({ userId: USER_ID }, JOB_ID);
  await expect(list.execute({ extra: true }, exec())).rejects.toBeInstanceOf(ToolArgsError);
});

it('publishes distinct seeded submit options through DSH and admits the selected Vega values', async () => {
  const vegaId = 'vega-1.5-pro';
  const klingId = 'kling-v2-5-turbo';
  const routes = new Map(
    legacyVideoRouteEntries([vegaId, klingId]).map((declaration) => [
      declaration.rawModelId,
      validateVideoRouteConfig({
        ...declaration,
        editPath: null,
        requestDefaults: {},
        outputSpec: {},
      })!,
    ]),
  );
  const catalogModes = (route: VideoRouteConfig) => {
    const supported = videoRouteRuntimeAvailable(route);
    return route.paramSpec.supportedModes.map((mode) => ({
      mode,
      supported,
      parameters: videoModeParameters(route, mode)!,
    }));
  };
  const route = routes.get(vegaId)!;
  const modes = catalogModes(route);
  const snapshot: VideoAdmissionSnapshot = {
    modelRef: MODEL_REF,
    modelId: vegaId,
    modelKey: 'vega-1-5-pro',
    vendor: route.vendor,
    profile: route.driver,
    route,
    defaultVideoWatermark: true,
    providerRevision: 1,
    catalogVersion: 1,
    adaptationVersion: 1,
    capabilitiesVersion: 'caps-v1',
    providerConfigId: 'private-provider-config',
    credentialVersion: 1,
    credential: {
      cipherFormat: 1,
      masterKeyId: 'private-master-key',
      nonce: 'private-nonce',
      ciphertext: 'private-ciphertext',
      authTag: 'private-auth-tag',
    },
  };
  const freezeSnapshot = vi.fn(() => snapshot);
  const provider = {
    videoAdmission: vi.fn(async () => ({
      ...admissionState(),
      supportedModes: route.paramSpec.supportedModes,
      snapshot: freezeSnapshot,
    })),
  };
  const create = vi.fn<VideoGenerationStore['create']>(async () => ({
    created: true,
    jobId: JOB_ID,
  }));
  const store = {
    byRequest: vi.fn(async () => undefined),
    create,
    get: vi.fn(async () => job()),
  };
  const wake = vi.fn();
  const admission = createVideoGenerationService(
    store as unknown as VideoGenerationStore,
    () => provider as unknown as ProviderService,
    { signal: new AbortController().signal, wake },
  );
  const model = {
    modelRef: MODEL_REF,
    modelId: vegaId,
    name: 'Vega 1.5 Pro',
    vendor: route.vendor,
    available: true,
    unavailableReason: null,
  };
  const catalogModel = {
    ...model,
    credential: snapshot.credential,
    capabilitiesVersion: snapshot.capabilitiesVersion,
    supportedModes: modes.map(({ parameters, ...entry }) => ({
      ...entry,
      submitPath: route.submitPath,
      parameters: { ...parameters, privateOptions: { token: 'private-route-token' } },
    })),
  };
  const klingRoute = routes.get(klingId)!;
  const klingModel = {
    ...model,
    modelRef: `onelink:model:${klingId}`,
    modelId: klingId,
    name: 'Kling 2.5 Turbo',
    vendor: klingRoute.vendor,
    available: videoRouteRuntimeAvailable(klingRoute),
  };
  const disabled = {
    ...model,
    modelRef: 'onelink:model:disabled-model',
    modelId: 'disabled-model',
    name: 'Disabled model',
    available: false,
    unavailableReason: 'MODEL_DISABLED',
  };
  const service: ConversationVideoTools = {
    ...bridge(),
    listModels: vi.fn(async () => [
      catalogModel,
      { ...klingModel, supportedModes: catalogModes(klingRoute) },
      { ...catalogModel, ...disabled },
    ]),
    createVideo: (actor, request, signal) =>
      admission.createFromTool(actor, request, signal).then((result) => result.job),
  };
  const expectedVega = {
    ...model,
    supportedModes: [
      {
        mode: 'text_to_video',
        supported: true,
        submitParameters: {
          required: ['modelRef', 'prompt', 'resolution'],
          maxPromptCodepoints: 3000,
          ratios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive'],
          resolutions: ['480p', '720p', '1080p'],
          durationSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12],
          supportsGenerateAudio: true,
          supportsWatermark: true,
        },
      },
      { mode: 'first_frame', supported: true },
      { mode: 'start_end', supported: true },
    ] as const,
  };

  const ctx = new Context();
  const signal = new AbortController().signal;
  const invoke = async (name: string, args: object, callId = name) => {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId(callId), name, arguments: JSON.stringify(args) }],
      signal,
    });
    return batch.results[0]!.result;
  };
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Tools);
    await ctx.plugin(NativeExecutor);
    registerConversationVideoTools(ctx, run(), service);
    const listed = await invoke('list_video_models', {});
    expect(listed.isError).toBe(false);
    expect(listed.meta).toBeUndefined();
    expect(service.listModels).toHaveBeenCalledOnce();
    expect(provider.videoAdmission).not.toHaveBeenCalled();
    expect(freezeSnapshot).not.toHaveBeenCalled();
    const content = listed.content[0];
    if (content?.type !== 'text') throw new Error('Expected rendered model list text');
    const result = JSON.parse(content.text) as { models: [typeof expectedVega, unknown, unknown] };
    expect(result).toEqual({
      models: [
        expectedVega,
        {
          ...klingModel,
          available: true,
          supportedModes: [
            {
              mode: 'text_to_video',
              supported: true,
              submitParameters: {
                required: ['modelRef', 'prompt'],
                maxPromptCodepoints: 2500,
                ratios: ['16:9', '9:16', '1:1'],
                resolutions: ['720p', '1080p'],
                durationSeconds: [5, 10],
                supportsGenerateAudio: false,
                supportsWatermark: false,
              },
            },
            { mode: 'first_frame', supported: true },
          ],
        },
        {
          ...disabled,
          supportedModes: expectedVega.supportedModes.map(({ mode, supported }) => ({
            mode,
            supported,
          })),
        },
      ],
    });

    const [vega] = result.models;
    const options = vega.supportedModes[0].submitParameters;
    const submit = {
      modelRef: vega.modelRef,
      prompt: '🌄'.repeat(options.maxPromptCodepoints),
      ratio: options.ratios[0],
      durationSeconds: options.durationSeconds[0],
      ...(options.supportsGenerateAudio ? { generateAudio: false } : {}),
      ...(options.supportsWatermark ? { watermark: false } : {}),
    };
    expect(options.required.includes('resolution')).toBe(true);
    const valid = { ...submit, resolution: options.resolutions[1] };
    const invalid = [
      submit,
      { ...valid, resolution: '4k' },
      { ...valid, ratio: '2:1' },
      { ...valid, durationSeconds: 13 },
      { ...valid, prompt: `${valid.prompt}🌄` },
    ];
    for (const [index, args] of invalid.entries()) {
      const rejected = await invoke('submit_video_job', args, `invalid-${index}`);
      expect(rejected).toMatchObject({
        isError: true,
        error: { info: { code: 'VIDEO_INPUT_INVALID' } },
      });
    }
    expect(provider.videoAdmission).toHaveBeenCalledTimes(invalid.length);
    expect(freezeSnapshot).toHaveBeenCalledTimes(invalid.length);
    expect(create).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();

    const accepted = await invoke('submit_video_job', valid);
    expect(accepted.isError).toBe(false);
    expect(parseVideoJobPresentationMeta(accepted.meta)).toMatchObject({
      job: { jobId: JOB_ID, status: 'submitted' },
    });
    expect(create).toHaveBeenCalledOnce();
    expect(provider.videoAdmission).toHaveBeenCalledTimes(invalid.length + 1);
    expect(freezeSnapshot).toHaveBeenCalledTimes(invalid.length + 1);
    const { modelRef, ...parameters } = valid;
    expect(create.mock.calls[0]![3].request).toMatchObject({
      modelRef,
      parameters: { ...parameters, mode: 'text_to_video' },
    });
    expect(wake).toHaveBeenCalledOnce();
  } finally {
    await Promise.all([ctx.fiber.dispose(), admission.close()]);
  }
});

it('submits only a current text-to-video capability, then defers same-turn polling and supports later history reads', async () => {
  const service = bridge();
  const firstTurn = setup(service, run('turn-1'));
  const submission = exec('call-submit-1');
  const submitted = (await firstTurn.get('submit_video_job')!.execute(
    {
      modelRef: MODEL_REF,
      prompt: 'A quiet mountain lake at dawn.',
      ratio: '16:9',
      durationSeconds: 4,
      generateAudio: false,
    },
    submission,
  )) as ConversationVideoJobView;

  expect(service.createVideo).toHaveBeenCalledTimes(1);
  const request = vi.mocked(service.createVideo).mock.calls[0]![1];
  expect(vi.mocked(service.createVideo).mock.calls[0]![2]).toBe(submission.signal);
  expect(request).toMatchObject({
    modelRef: MODEL_REF,
    parameters: {
      mode: 'text_to_video',
      prompt: 'A quiet mountain lake at dawn.',
      ratio: '16:9',
      durationSeconds: 4,
      generateAudio: false,
    },
  });
  expect(request.requestId).toBe('7f6b32ee-a8cd-4129-aa3e-c865877a3bbb');
  const submitMeta = firstTurn.get('submit_video_job')!.output.presentationMeta!(
    {},
    submitted as never,
  );
  expect(parseVideoJobPresentationMeta(submitMeta)).toMatchObject({
    tool: 'submit_video_job',
    job: { jobId: JOB_ID, status: 'submitted' },
  });

  await expect(
    firstTurn.get('get_video_job')!.execute({ jobId: JOB_ID }, exec('call-poll-1')),
  ).rejects.toMatchObject({ code: 'VIDEO_JOB_POLL_DEFERRED' });
  expect(service.getVideo).not.toHaveBeenCalled();

  vi.mocked(service.getVideo).mockResolvedValueOnce(job());
  const nextTurn = setup(service, run('turn-2'));
  const pending = await nextTurn
    .get('get_video_job')!
    .execute({ jobId: JOB_ID }, exec('call-poll-2'));
  const pendingMeta = nextTurn.get('get_video_job')!.output.presentationMeta!({}, pending as never);
  expect(parseVideoJobPresentationMeta(pendingMeta)).toMatchObject({
    tool: 'get_video_job',
    job: { jobId: JOB_ID, status: 'submitted' },
  });
  await expect(
    nextTurn.get('get_video_job')!.execute({ jobId: JOB_ID }, exec('call-poll-2-again')),
  ).rejects.toMatchObject({ code: 'VIDEO_JOB_POLL_DEFERRED' });
  expect(service.getVideo).toHaveBeenCalledTimes(1);

  const laterTurn = setup(service, run('turn-3'));
  const completed = await laterTurn
    .get('get_video_job')!
    .execute({ jobId: JOB_ID }, exec('call-poll-3'));
  const getMeta = laterTurn.get('get_video_job')!.output.presentationMeta!({}, completed as never);
  expect(parseVideoJobPresentationMeta(getMeta)).toMatchObject({
    tool: 'get_video_job',
    job: { jobId: JOB_ID, status: 'completed', outputs: [{ assetId: ASSET_ID }] },
  });
  expect(service.getVideo).toHaveBeenLastCalledWith({ userId: USER_ID }, JOB_ID);
});

it('uses one owner state statement per DSH submit and preserves the persisted tool request hash', async () => {
  const database = await authDatabase();
  onTestFinished(() => database.close());
  const pool = new Pool({ connectionString: database.url });
  onTestFinished(() => pool.end());
  await pool.query(providerSchemaSQL);
  await pool.query(assetSchemaSQL);
  await pool.query(generationSchemaSQL);
  const config = {
    databaseURL: database.url,
    masterKey: randomBytes(32),
    masterKeyId: 'video-tool-fixture',
  };
  const modelId = 'vega-1.5-pro';
  const providerStore = await createProviderStore(config);
  const provider = createProviderService(
    providerStore,
    config,
    async () => Response.json({ data: [{ id: modelId }] }),
    true,
  );
  onTestFinished(provider.close);
  const actor = { userId: USER_ID, sessionId: 'fixture' };
  await provider.save(actor, 0, 'synthetic-video-tool-key');
  await provider.discover(actor);
  await providerStore.importRoutes(legacyVideoRouteEntries([modelId]));
  const { modelRef } = (await provider.catalog(actor, 'video')).items[0]!;
  const capability = await provider.videoCapabilities(actor, modelRef);
  const store = new VideoGenerationStore(pool);
  const stop = new AbortController();
  const wake = vi.fn();
  const admission = createVideoGenerationService(store, () => provider, {
    signal: stop.signal,
    wake,
  });
  onTestFinished(admission.close);
  const tools = setup({
    ...bridge(),
    createVideo: (owner, request, signal) =>
      admission.createFromTool(owner, request, signal).then((result) => result.job),
  });
  const submit = () =>
    tools.get('submit_video_job')!.execute(
      {
        modelRef,
        prompt: 'A lake at dawn',
        ratio: '16:9',
        resolution: '480p',
        durationSeconds: 4,
        generateAudio: false,
        watermark: false,
      },
      exec('call-submit-1'),
    ) as Promise<ConversationVideoJobView>;
  const legacyRequest = {
    requestId: '7f6b32ee-a8cd-4129-aa3e-c865877a3bbb',
    modelRef,
    expectedCapabilitiesVersion: capability.capabilitiesVersion,
    parameters: {
      mode: 'text_to_video',
      prompt: 'A lake at dawn',
      ratio: '16:9',
      resolution: '480p',
      durationSeconds: 4,
      generateAudio: false,
      watermark: false,
    },
  };
  const hash = createHash('sha256').update(JSON.stringify(legacyRequest)).digest('hex');
  const queries = vi.spyOn(Pool.prototype, 'query');
  onTestFinished(() => {
    queries.mockRestore();
  });
  const expectOneStateStatement = () => {
    const reads = queries.mock.calls.filter(
      ([sql]) =>
        typeof sql === 'string' && sql.includes('FROM mio_provider_configs c WHERE c.owner_id=$1'),
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]![1]).toEqual([USER_ID]);
    expect(reads[0]![0]).not.toContain('mio_provider_model_verifications');
    queries.mockClear();
  };

  const accepted = await submit();
  expect(accepted).toMatchObject({ status: 'accepted', modelRef });
  expectOneStateStatement();
  expect(await store.byRequest(USER_ID, legacyRequest.requestId)).toEqual({
    jobId: accepted.jobId,
    inputHash: hash,
  });

  stop.abort();
  expect(await submit()).toEqual(accepted);
  expectOneStateStatement();
  const current = (await provider.get(actor))!;
  await provider.settings(actor, current.revision, {
    defaultVideoWatermark: !current.defaultVideoWatermark,
  });
  await expect(submit()).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  expectOneStateStatement();

  await provider.settings(actor, (await provider.get(actor))!.revision, { enabled: false });
  const byRequest = vi.spyOn(store, 'byRequest');
  await expect(submit()).rejects.toMatchObject({ code: 'VIDEO_UNAVAILABLE' });
  expectOneStateStatement();
  expect(byRequest).not.toHaveBeenCalled();
  expect(wake).toHaveBeenCalledOnce();
  expect((await pool.query('SELECT id FROM mio_video_jobs')).rows).toEqual([
    { id: accepted.jobId },
  ]);
});

it.each(['tool policy', 'provider state', 'admission bridge'] as const)(
  'honors real DSH turn cancellation during %s',
  async (stage) => {
    const ctx = new Context();
    const service = bridge();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const pause = async () => {
      entered.resolve();
      await resume.promise;
    };
    const controller = new AbortController();
    const provider = {
      videoAdmission: vi.fn(async () => {
        await pause();
        return admissionState();
      }),
    };
    const byRequest = vi.fn();
    const admission = createVideoGenerationService(
      { byRequest } as unknown as VideoGenerationStore,
      () => provider as unknown as ProviderService,
      { signal: new AbortController().signal, wake: vi.fn() },
    );
    let admissionSignal: AbortSignal | undefined;
    try {
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(Tools);
      await ctx.plugin(NativeExecutor);
      registerConversationVideoTools(ctx, run(), service);
      if (stage === 'tool policy') {
        ctx.on('tools/pre-execute', async () => {
          await pause();
          return { kind: 'allow' };
        });
      } else if (stage === 'provider state') {
        vi.mocked(service.createVideo).mockImplementationOnce((actor, request, signal) =>
          admission.createFromTool(actor, request, signal).then((result) => result.job),
        );
      } else {
        vi.mocked(service.createVideo).mockImplementationOnce(async (_actor, _request, signal) => {
          admissionSignal = signal;
          await pause();
          signal?.throwIfAborted();
          return job();
        });
      }

      const pending = ctx.tools.execute({
        calls: [
          {
            type: 'tool-call',
            id: ToolCallId('cancel-video-submit'),
            name: 'submit_video_job',
            arguments: JSON.stringify({ modelRef: MODEL_REF, prompt: 'A quiet dawn' }),
          },
        ],
        signal: controller.signal,
      });
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('DSH tool settled before the cancellation barrier');
        }),
      ]);

      controller.abort();
      resume.resolve();
      const result = (await pending).results[0]?.result;
      expect(result?.isError).toBe(true);
      expect(result?.meta).toBeUndefined();
      expect(provider.videoAdmission).toHaveBeenCalledTimes(stage === 'provider state' ? 1 : 0);
      expect(service.createVideo).toHaveBeenCalledTimes(stage === 'tool policy' ? 0 : 1);
      expect(byRequest).not.toHaveBeenCalled();
      if (stage === 'admission bridge') expect(admissionSignal?.aborted).toBe(true);
    } finally {
      resume.resolve();
      await Promise.all([ctx.fiber.dispose(), admission.close()]);
    }
  },
);

it.each([
  [false, 'VIDEO_UNAVAILABLE'],
  [true, 'VIDEO_MODE_UNSUPPORTED'],
] as const)(
  'checks DSH capability before durable replay when available=%s',
  async (ready, code) => {
    const byRequest = vi.fn();
    const state = admissionState(ready, false);
    const videoAdmission = vi.fn(async () => state);
    const admission = createVideoGenerationService(
      { byRequest } as unknown as VideoGenerationStore,
      () => ({ videoAdmission }) as unknown as ProviderService,
      { signal: new AbortController().signal, wake: vi.fn() },
    );
    const tools = setup({
      ...bridge(),
      createVideo: (actor, request, signal) =>
        admission.createFromTool(actor, request, signal).then((result) => result.job),
    });
    try {
      await expect(
        tools
          .get('submit_video_job')!
          .execute({ modelRef: MODEL_REF, prompt: 'A valid prompt.' }, exec()),
      ).rejects.toMatchObject({ code });
      expect(videoAdmission).toHaveBeenCalledExactlyOnceWith({ userId: USER_ID }, MODEL_REF);
      expect(state.snapshot).not.toHaveBeenCalled();
      expect(byRequest).not.toHaveBeenCalled();
    } finally {
      await admission.close();
    }
  },
);

it('fails closed on invalid parameters and forged presentation metadata', async () => {
  const invalid = bridge();
  const invalidTools = setup(invalid);
  await expect(
    invalidTools
      .get('submit_video_job')!
      .execute({ modelRef: MODEL_REF, prompt: 'A valid prompt.', durationSeconds: 0 }, exec()),
  ).rejects.toMatchObject({ code: 'VIDEO_INPUT_INVALID' });
  await expect(
    invalidTools
      .get('submit_video_job')!
      .execute({ modelRef: MODEL_REF, prompt: 'A valid prompt.', unknown: true }, exec()),
  ).rejects.toBeInstanceOf(ToolArgsError);
  await expect(
    invalidTools
      .get('submit_video_job')!
      .execute({ modelRef: 'not-an-exact-model-ref', prompt: 'A valid prompt.' }, exec()),
  ).rejects.toMatchObject({ code: 'VIDEO_INPUT_INVALID' });
  expect(invalid.createVideo).not.toHaveBeenCalled();

  expect(
    parseVideoJobPresentationMeta({
      kind: 'mio.video-job',
      tool: 'submit_video_job',
      job: { jobId: JOB_ID, status: 'invented', mode: 'text_to_video' },
    }),
  ).toBeNull();
  expect(
    parseVideoJobPresentationMeta({
      kind: 'mio.video-job',
      tool: 'submit_video_job',
      job: {
        jobId: JOB_ID,
        status: 'completed',
        mode: 'text_to_video',
        modelRef: MODEL_REF,
        createdAt: '2026-11-24T00:00:00.000Z',
        errorCode: null,
        outputs: [
          {
            index: 0,
            assetId: 'not-a-uuid',
            status: 'registered',
            errorCode: null,
            width: 1280,
            height: 720,
            durationSeconds: 4,
            hasAudio: false,
          },
        ],
      },
    }),
  ).toBeNull();
  expect(
    invalidTools.get('submit_video_job')!.output.presentationMeta!({}, {} as never),
  ).toMatchObject({
    kind: 'mio.video-job',
    tool: 'submit_video_job',
  });
});
