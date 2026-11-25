import { ToolArgsError } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import { expect, it, vi } from 'vitest';
import type {
  ConversationRun,
  ConversationVideoJobView,
  ConversationVideoTools,
} from '../../src/conversations/contracts.ts';
import type { VideoCapabilitiesView, VideoJobView } from '../../src/generations/video-contracts.ts';
import {
  parseVideoJobPresentationMeta,
  registerConversationVideoTools,
} from '../../src/dsh/video-tools.ts';

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

function caps(available = true, textToVideo = true): VideoCapabilitiesView {
  return {
    modelRef: MODEL_REF,
    capabilitiesVersion: 'caps-v1',
    available,
    unavailableReason: available ? null : 'ADAPTER_PENDING',
    modes: [{ mode: 'text_to_video', supported: textToVideo }],
    cancellation: { supported: false },
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
    capabilities: vi.fn(async () => caps()),
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

it('submits only a current text-to-video capability, then defers same-turn polling and supports later history reads', async () => {
  const service = bridge();
  const firstTurn = setup(service, run('turn-1'));
  const submitted = (await firstTurn.get('submit_video_job')!.execute(
    {
      modelRef: MODEL_REF,
      prompt: 'A quiet mountain lake at dawn.',
      ratio: '16:9',
      durationSeconds: 4,
      generateAudio: false,
    },
    exec('call-submit-1'),
  )) as ConversationVideoJobView;

  expect(service.capabilities).toHaveBeenCalledWith({ userId: USER_ID }, MODEL_REF);
  expect(service.createVideo).toHaveBeenCalledTimes(1);
  const request = vi.mocked(service.createVideo).mock.calls[0]![1];
  expect(request).toMatchObject({
    modelRef: MODEL_REF,
    expectedCapabilitiesVersion: 'caps-v1',
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

it('fails closed on unavailable modes, invalid parameters and forged presentation metadata', async () => {
  const unavailable = bridge();
  vi.mocked(unavailable.capabilities).mockResolvedValueOnce(caps(false));
  const unavailableTools = setup(unavailable);
  await expect(
    unavailableTools
      .get('submit_video_job')!
      .execute({ modelRef: MODEL_REF, prompt: 'A valid prompt.' }, exec()),
  ).rejects.toMatchObject({ code: 'VIDEO_UNAVAILABLE' });
  expect(unavailable.createVideo).not.toHaveBeenCalled();

  const unsupported = bridge();
  vi.mocked(unsupported.capabilities).mockResolvedValueOnce(caps(true, false));
  const unsupportedTools = setup(unsupported);
  await expect(
    unsupportedTools
      .get('submit_video_job')!
      .execute({ modelRef: MODEL_REF, prompt: 'A valid prompt.' }, exec()),
  ).rejects.toMatchObject({ code: 'VIDEO_MODE_UNSUPPORTED' });
  expect(unsupported.createVideo).not.toHaveBeenCalled();

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
