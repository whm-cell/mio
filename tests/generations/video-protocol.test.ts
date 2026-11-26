import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  VideoDriver,
  VideoMode,
  VideoRequestParameters,
} from '../../src/generations/video/contracts.ts';
import type { VideoParameterSpec, VideoRouteConfig } from '../../src/providers/contracts.ts';
import { createVideoProtocol } from '../../src/integrations/onelink/video/index.ts';

const first = randomUUID();
const last = randomUUID();
const audio = randomUUID();
const video = randomUUID();
const refs = {
  [first]: 'https://media.fixture/first.png',
  [last]: 'https://media.fixture/last.png',
  [audio]: 'https://media.fixture/audio.mp3',
  [video]: 'https://media.fixture/input.mp4',
};
const signal = new AbortController().signal;
const key = 'fixture-video-key';

function route(
  driver: VideoDriver,
  modes: VideoMode[] = ['text_to_video'],
  limits: Partial<VideoParameterSpec> = {},
): VideoRouteConfig {
  const submitPath = {
    'volcengine-ark-videos': '/volc/api/v3/contents/generations/tasks',
    'kling-videos': '/kling/v1/videos/text2video',
    'vidu-videos': '/vidu/ent/v2/text2video',
    'veo-videos': '/v1beta/models/{model}:predictLongRunning',
    'happyhorse-videos': '/happyhorse/v1/services/aigc/video-generation/video-synthesis',
  }[driver];
  const queryPathTemplate = {
    'volcengine-ark-videos': '/volc/api/v3/contents/generations/tasks/{task_id}',
    'kling-videos': submitPath + '/{task_id}',
    'vidu-videos': '/vidu/ent/v2/tasks/{task_id}/creations',
    'veo-videos': '/v1beta/operations/{task_id}',
    'happyhorse-videos': '/happyhorse/v1/tasks/{task_id}',
  }[driver];
  return {
    driver,
    vendor: 'fixture',
    submitPath,
    queryPathTemplate,
    paramSpec: {
      supportedModes: modes,
      parameters: {
        ratios: ['16:9', '9:16'],
        resolutions: ['480P', '720P', '1080P', '4K'],
        durations: [4, 8],
        maxPromptCodepoints: 5000,
        maxImages: 9,
        maxVideos: 3,
        maxAudios: 3,
        maxInputs: 15,
        maxSubjects: 7,
        maxSubjectImages: 3,
        generateAudio: true,
        watermark: true,
        offPeak: true,
        audioSettings: ['auto', 'origin'],
        requiresResolution: false,
        referenceAudioRequiresVisual: true,
        referenceDurations: [],
        ...limits,
      },
    },
    requestDefaults: {},
    outputSpec: {},
  };
}

function transport(submission: unknown, result: unknown) {
  return vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
    expect(new URL(String(url)).origin).toBe('https://api.onelinkai.cloud');
    return Response.json(options?.method === 'POST' ? submission : result);
  });
}

function body(fetcher: ReturnType<typeof transport>): Record<string, unknown> {
  return JSON.parse(String(fetcher.mock.calls[0]![1]?.body)) as Record<string, unknown>;
}

describe('bounded OneLink video protocol', () => {
  it('retains ordered Ark frame/media roles and polls one original task', async () => {
    const firstFrameUrl = 'https://MEDIA.fixture:443/first.png?token=fixture%2F+value';
    const fetcher = transport(
      { id: 'ark-task-1' },
      {
        id: 'ark-task-1',
        status: 'succeeded',
        content: { video_url: 'https://CDN.fixture:443/output.mp4' },
      },
    );
    const protocol = createVideoProtocol(
      route('volcengine-ark-videos', ['start_end', 'full']),
      'doubao-seedance-2-0-fast',
      fetcher,
    );
    const submitted = await protocol.submit(
      {
        mode: 'start_end',
        prompt: 'frames',
        durationSeconds: 4,
        ratio: '16:9',
        resolution: '480P',
        generateAudio: false,
        watermark: true,
        firstFrame: { assetId: first },
        lastFrame: { assetId: last },
      },
      { ...refs, [first]: firstFrameUrl },
      key,
      signal,
    );
    expect(submitted).toEqual({ state: 'submitted', upstreamTaskId: 'ark-task-1' });
    expect(body(fetcher)).toMatchObject({
      model: 'doubao-seedance-2-0-fast',
      content: [
        { type: 'text', text: 'frames' },
        { type: 'image_url', image_url: { url: firstFrameUrl }, role: 'first_frame' },
        { type: 'image_url', image_url: { url: refs[last] }, role: 'last_frame' },
      ],
      duration: 4,
      resolution: '480p',
      generate_audio: false,
      watermark: true,
    });
    expect(await protocol.query('ark-task-1', key, signal)).toEqual({
      state: 'returned',
      videos: [{ url: 'https://cdn.fixture/output.mp4' }],
    });
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      'https://api.onelinkai.cloud/volc/api/v3/contents/generations/tasks/ark-task-1',
    );
    expect(
      fetcher.mock.calls.every(
        ([, options]) =>
          options?.redirect === 'error' &&
          (options.headers as Record<string, string>).Authorization === 'Bearer ' + key,
      ),
    ).toBe(true);
    await protocol.submit(
      {
        mode: 'full',
        prompt: 'ordered',
        references: [
          { assetId: video, mediaType: 'video' },
          { assetId: first },
          { assetId: audio, mediaType: 'audio' },
        ],
      },
      refs,
      key,
      signal,
    );
    const fullPayload = JSON.parse(String(fetcher.mock.calls[2]![1]?.body)) as {
      content: { role?: string }[];
    };
    expect(fullPayload.content.map((item) => item.role)).toEqual([
      undefined,
      'reference_video',
      'reference_image',
      'reference_audio',
    ]);
    expect(fullPayload).not.toHaveProperty('generate_audio');
  });

  it('persists the original Kling image endpoint in its task token', async () => {
    const fetcher = transport(
      { code: 0, data: { task_id: 'kling-1' } },
      {
        code: 0,
        data: {
          task_id: 'kling-1',
          task_status: 'succeed',
          task_result: { videos: [{ url: 'https://cdn.fixture/kling.mp4' }] },
        },
      },
    );
    const protocol = createVideoProtocol(
      route('kling-videos', ['start_end']),
      'video-kling-v3',
      fetcher,
    );
    const submitted = await protocol.submit(
      {
        mode: 'start_end',
        prompt: 'transition',
        firstFrame: { assetId: first },
        lastFrame: { assetId: last },
        durationSeconds: 8,
        generateAudio: true,
      },
      refs,
      key,
      signal,
    );
    expect(submitted.state).toBe('submitted');
    expect(body(fetcher)).toMatchObject({
      image: refs[first],
      image_tail: refs[last],
      model_name: 'video-kling-v3',
      duration: '8',
      sound: 'on',
      mode: 'std',
    });
    if (submitted.state !== 'submitted') throw new Error('not submitted');
    expect(JSON.parse(submitted.upstreamTaskId)).toEqual({
      path: '/kling/v1/videos/image2video',
      id: 'kling-1',
    });
    expect((await protocol.query(submitted.upstreamTaskId, key, signal)).state).toBe('returned');
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      'https://api.onelinkai.cloud/kling/v1/videos/image2video/kling-1',
    );
    expect(
      await protocol.query(
        JSON.stringify({ path: 'https://evil.fixture', id: 'kling-1' }),
        key,
        signal,
      ),
    ).toEqual({ state: 'failed', code: 'VIDEO_TASK_INVALID' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('encodes Omni video_ref as feature_video with its own settings', async () => {
    const fetcher = transport({ code: 0, data: { task_id: 'omni-1' } }, {});
    const protocol = createVideoProtocol(
      route('kling-videos', ['video_ref']),
      'video-kling-v3-omni',
      fetcher,
    );
    await protocol.submit(
      {
        mode: 'video_ref',
        prompt: 'motion',
        durationSeconds: 4,
        ratio: '16:9',
        resolution: '1080P',
        generateAudio: false,
        references: [{ assetId: video, mediaType: 'video' }],
      },
      refs,
      key,
      signal,
    );
    expect(body(fetcher)).toEqual({
      model_name: 'video-kling-v3-omni',
      contents: [
        { type: 'prompt', text: 'motion' },
        { type: 'feature_video', url: refs[video], id: 'video_1' },
      ],
      settings: { duration: 4, aspect_ratio: '16:9', resolution: '1080p', audio: 'off' },
    });
  });

  it.each([
    ['video-kling-v3', '/kling/v1/videos/text2video'],
    ['video-kling-v3-omni', '/kling/v1/videos/omni-video'],
  ])('encodes omitted and frozen native audio for %s', async (model, path) => {
    const fetcher = transport({ code: 0, data: { task_id: 'kling-audio' } }, {});
    for (const canOverride of [true, false]) {
      const protocol = createVideoProtocol(
        route('kling-videos', ['text_to_video'], {
          generateAudio: canOverride,
          offPeak: false,
        }),
        model,
        fetcher,
      );
      for (const generateAudio of [undefined, true, false]) {
        const testInput = {
          mode: 'text_to_video' as const,
          prompt: 'Listen to the wind.',
          ...(generateAudio !== undefined ? { generateAudio } : {}),
        };
        fetcher.mockClear();
        const result = await protocol.submit(testInput, {}, key, signal);
        if (!canOverride && generateAudio === false) {
          expect(result).toEqual({ state: 'rejected', code: 'VIDEO_INPUT_INVALID' });
          expect(fetcher).not.toHaveBeenCalled();
          continue;
        }
        expect(result).toMatchObject({ state: 'submitted' });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(new URL(String(fetcher.mock.calls[0]![0])).pathname).toBe(path);
        expect(body(fetcher)).toHaveProperty(
          'settings.audio',
          generateAudio === false ? 'off' : 'native',
        );
        if (model === 'video-kling-v3')
          expect(body(fetcher)).toHaveProperty('sound', generateAudio === false ? 'off' : 'on');
        else expect(body(fetcher)).not.toHaveProperty('sound');
      }
    }
  });

  it('retains Kling supplier ordinals for mixed results and rejects invalid envelopes', async () => {
    const taskId = JSON.stringify({ path: '/kling/v1/videos/image2video', id: 'old-task' });
    const result = (videos: unknown) => ({
      code: 0,
      data: {
        task_id: 'old-task',
        task_status: 'succeed',
        task_result: { videos },
      },
    });
    const good = { url: 'https://cdn.fixture/video.mp4' };
    const last = { url: 'https://cdn.fixture/another.mp4?token=fixture' };
    const invalidUrls = [
      'http://cdn.fixture/insecure.mp4',
      'https://cdn.fixture:8443/video.mp4',
      'https://cdn.fixture/video.mp4#fragment',
      `https://cdn.fixture/video.mp4?token=${'x'.repeat(8192)}`,
    ];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(result([good, null, ...invalidUrls.map((url) => ({ url })), last])),
      );
    const protocol = createVideoProtocol(route('kling-videos'), 'fixture-model', fetcher);
    await expect(protocol.query(taskId, key, signal)).resolves.toEqual({
      state: 'returned',
      videos: [
        good,
        { errorCode: 'VIDEO_RESULT_INVALID' },
        ...invalidUrls.map(() => ({ errorCode: 'VIDEO_RESULT_INVALID' })),
        last,
      ],
    });
    const full = Array.from({ length: 16 }, () => good);
    fetcher.mockResolvedValueOnce(Response.json(result(full)));
    await expect(protocol.query(taskId, key, signal)).resolves.toEqual({
      state: 'returned',
      videos: full,
    });
    for (const bad of [
      null,
      { 0: good },
      [],
      [{ url: 'https://user:pass@cdn.fixture/video.mp4' }, 'https://cdn.fixture/not-a-slot.mp4'],
      Array.from({ length: 17 }, () => good),
    ]) {
      fetcher.mockResolvedValueOnce(Response.json(result(bad)));
      await expect(protocol.query(taskId, key, signal)).resolves.toEqual({
        state: 'failed',
        code: 'VIDEO_RESPONSE_INVALID',
      });
    }
    expect(
      fetcher.mock.calls.map(([url, options]) => [new URL(String(url)).pathname, options?.method]),
    ).toEqual(Array.from({ length: 7 }, () => ['/kling/v1/videos/image2video/old-task', 'GET']));
  });

  it('rejects turbo tail frames and explicit sound and omits audio on valid POST', async () => {
    const fetcher = transport({ code: 0, data: { task_id: 'kling-turbo' } }, {});
    const protocol = createVideoProtocol(
      route('kling-videos', ['text_to_video', 'first_frame'], {
        generateAudio: false,
        offPeak: false,
        maxImages: 1,
      }),
      'kling-v2-5-turbo',
      fetcher,
    );
    expect(
      (
        await protocol.submit(
          {
            mode: 'start_end',
            prompt: 'invalid',
            firstFrame: { assetId: first },
            lastFrame: { assetId: last },
          },
          refs,
          key,
          signal,
        )
      ).state,
    ).toBe('rejected');
    expect(
      (
        await protocol.submit(
          { mode: 'text_to_video', prompt: 'invalid', generateAudio: false },
          refs,
          key,
          signal,
        )
      ).state,
    ).toBe('rejected');
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await protocol.submit({ mode: 'text_to_video', prompt: 'A boat.' }, {}, key, signal),
    ).toMatchObject({ state: 'submitted' });
    expect(body(fetcher)).not.toHaveProperty('sound');
    expect(body(fetcher)).not.toHaveProperty('settings.audio');
  });

  it('encodes Vidu q2 named subjects without q3-only fields', async () => {
    const fetcher = transport(
      { task_id: 'vidu-1' },
      {
        state: 'success',
        creations: [{ id: 'vidu-work-1', watermarked_url: 'https://cdn.fixture/vidu.mp4' }],
      },
    );
    const protocol = createVideoProtocol(
      route('vidu-videos', ['reference_subjects'], {
        resolutions: [],
        watermark: false,
        offPeak: false,
      }),
      'video-vidu-q2',
      fetcher,
    );
    const submitted = await protocol.submit(
      {
        mode: 'reference_subjects',
        prompt: '[@cat] walks',
        durationSeconds: 8,
        generateAudio: true,
        subjects: [{ name: 'cat', images: [{ assetId: first }, { assetId: last }] }],
      },
      refs,
      key,
      signal,
    );
    expect(submitted).toEqual({ state: 'submitted', upstreamTaskId: 'vidu-1' });
    expect(body(fetcher)).toEqual({
      model: 'video-vidu-q2',
      prompt: '[@cat] walks',
      duration: 8,
      audio: true,
      subjects: [{ name: 'cat', images: [refs[first], refs[last]] }],
    });
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'https://api.onelinkai.cloud/vidu/ent/v2/reference2video',
    );
    expect(await protocol.query('vidu-1', key, signal)).toMatchObject({ state: 'returned' });
  });

  it('routes q3 ordered frames to start-end2video and preserves audio/off_peak', async () => {
    const fetcher = transport({ task_id: 'q3-1' }, { state: 'processing' });
    const protocol = createVideoProtocol(
      route('vidu-videos', ['start_end']),
      'video-viduq3-pro',
      fetcher,
    );
    await protocol.submit(
      {
        mode: 'start_end',
        prompt: 'frames',
        firstFrame: { assetId: first },
        lastFrame: { assetId: last },
        generateAudio: true,
        offPeak: true,
      },
      refs,
      key,
      signal,
    );
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'https://api.onelinkai.cloud/vidu/ent/v2/start-end2video',
    );
    expect(body(fetcher)).toMatchObject({
      images: [refs[first], refs[last]],
      audio: true,
      off_peak: true,
    });
    expect(await protocol.query('q3-1', key, signal)).toEqual({ state: 'processing' });
  });

  it('uses the original Vidu query path for a frozen route that declared full mode', async () => {
    const fetcher = transport({ task_id: 'new-vidu' }, { state: 'processing' });
    const protocol = createVideoProtocol(
      route('vidu-videos', ['text_to_video', 'full']),
      'video-viduq3-pro',
      fetcher,
    );
    expect(
      await protocol.submit({ mode: 'text_to_video', prompt: 'A boat.' }, {}, key, signal),
    ).toMatchObject({ state: 'submitted' });
    expect(body(fetcher)).not.toHaveProperty('audio');
    expect(await protocol.query('legacy-vidu-full', key, signal)).toEqual({ state: 'processing' });
    expect(new URL(String(fetcher.mock.calls[1]![0])).pathname).toBe(
      '/vidu/ent/v2/tasks/legacy-vidu-full/creations',
    );
    expect(fetcher.mock.calls.map(([, options]) => options?.method)).toEqual(['POST', 'GET']);
  });

  it('retains the Veo full operation path and waits for done=true', async () => {
    const name = 'models/veo-3.1/operations/veo-1';
    const fetcher = transport(
      { name },
      {
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{ video: { uri: 'https://cdn.fixture/veo.mp4' } }],
          },
        },
      },
    );
    const protocol = createVideoProtocol(route('veo-videos', ['start_end']), 'veo-3.1', fetcher);
    const submitted = await protocol.submit(
      {
        mode: 'start_end',
        prompt: 'veo',
        durationSeconds: 8,
        firstFrame: { assetId: first },
        lastFrame: { assetId: last },
      },
      refs,
      key,
      signal,
    );
    expect(submitted).toEqual({ state: 'submitted', upstreamTaskId: '/v1beta/' + name });
    expect(body(fetcher)).toMatchObject({
      instances: [
        { prompt: 'veo', image: { imageUrl: refs[first] }, lastFrame: { imageUrl: refs[last] } },
      ],
      parameters: { durationSeconds: 8, numberOfVideos: 1 },
    });
    expect((await protocol.query('/v1beta/' + name, key, signal)).state).toBe('returned');
    expect(String(fetcher.mock.calls[1]![0])).toBe('https://api.onelinkai.cloud/v1beta/' + name);
    expect(
      (await protocol.query('https://evil.fixture/operations/stolen', key, signal)).state,
    ).toBe('failed');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('treats a named Veo operation with omitted done=false as still processing', async () => {
    const fetcher = transport({}, { name: 'operations/veo-1' });
    const protocol = createVideoProtocol(route('veo-videos'), 'veo-3.1', fetcher);
    expect(await protocol.query('operations/veo-1', key, signal)).toEqual({ state: 'processing' });
  });

  it('refuses mode-specific fields that an upstream would silently ignore', async () => {
    const fetcher = transport({}, {});
    const vidu = createVideoProtocol(
      route('vidu-videos', ['first_frame']),
      'video-viduq3-pro',
      fetcher,
    );
    expect(
      (
        await vidu.submit(
          { mode: 'first_frame', prompt: 'image', firstFrame: { assetId: first }, ratio: '16:9' },
          refs,
          key,
          signal,
        )
      ).state,
    ).toBe('rejected');
    const horse = createVideoProtocol(
      route('happyhorse-videos', ['video_edit']),
      'happyhorse-1.1-video-edit',
      fetcher,
    );
    expect(
      (
        await horse.submit(
          {
            mode: 'video_edit',
            prompt: 'edit',
            references: [{ assetId: video, mediaType: 'video' }],
            durationSeconds: 4,
          },
          refs,
          key,
          signal,
        )
      ).state,
    ).toBe('rejected');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not pretend protected or inline Veo media are public downloads', async () => {
    for (const output of [
      { uri: 'https://api.onelinkai.cloud/v1beta/files/private:download' },
      { bytesBase64Encoded: 'AAAA' },
    ]) {
      const fetcher = transport(
        {},
        {
          done: true,
          response: { generateVideoResponse: { generatedSamples: [{ video: output }] } },
        },
      );
      const protocol = createVideoProtocol(route('veo-videos'), 'veo-3.1', fetcher);
      expect((await protocol.query('operations/veo-1', key, signal)).state).toBe('failed');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('maps every HappyHorse subject name to its own ordered image slots', async () => {
    const fetcher = transport({ output: { task_id: 'horse-1' } }, {});
    const protocol = createVideoProtocol(
      route('happyhorse-videos', ['reference_subjects']),
      'happyhorse-1.1-r2v',
      fetcher,
    );
    const prompt = '领队看向旅人和[Image 3]后方。';
    for (const [lead, traveler] of [
      ['领队', '旅人'],
      ['旅人', '领队'],
    ] as const) {
      expect(
        await protocol.submit(
          {
            mode: 'reference_subjects',
            prompt,
            subjects: [
              { name: lead, images: [{ assetId: first }, { assetId: last }] },
              { name: traveler, images: [{ assetId: first }] },
            ],
          },
          refs,
          key,
          signal,
        ),
      ).toEqual({ state: 'submitted', upstreamTaskId: 'horse-1' });
    }
    const media = [
      { type: 'reference_image', url: refs[first] },
      { type: 'reference_image', url: refs[last] },
      { type: 'reference_image', url: refs[first] },
    ];
    expect(fetcher.mock.calls.map(([, request]) => JSON.parse(String(request?.body)))).toEqual([
      {
        model: 'happyhorse-1.1-r2v',
        input: {
          prompt: '[Image 1]、[Image 2] 为 "领队"；[Image 3] 为 "旅人"。\n' + prompt,
          media,
        },
        parameters: {},
      },
      {
        model: 'happyhorse-1.1-r2v',
        input: {
          prompt: '[Image 1]、[Image 2] 为 "旅人"；[Image 3] 为 "领队"。\n' + prompt,
          media,
        },
        parameters: {},
      },
    ]);
  });

  it('escapes HappyHorse names and applies the exact wire prompt limit to frozen submissions', async () => {
    const fetcher = transport({ output: { task_id: 'horse-1' } }, {});
    const name = '阿"岚\\车\n[Image 9]\u2028🐎';
    const quotedName = '"阿\\"岚\\\\车\\n\\u005bImage 9\\u005d\\u2028🐎"';
    expect(JSON.parse(quotedName)).toBe(name);
    const prompt = '追上云🚀\n转身';
    const expected = '[Image 1] 为 ' + quotedName + '。\n' + prompt;
    const protocol = createVideoProtocol(
      route('happyhorse-videos', ['reference_subjects'], {
        maxPromptCodepoints: [...expected].length,
      }),
      'happyhorse-1.0-r2v',
      fetcher,
    );
    const input: VideoRequestParameters = {
      mode: 'reference_subjects',
      prompt,
      subjects: [{ name, images: [{ assetId: first }] }],
    };
    expect(await protocol.submit({ ...input, prompt: prompt + '😀' }, refs, key, signal)).toEqual({
      state: 'rejected',
      code: 'VIDEO_INPUT_INVALID',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await protocol.submit(input, refs, key, signal)).toEqual({
      state: 'submitted',
      upstreamTaskId: 'horse-1',
    });
    expect(body(fetcher).input).toEqual({
      prompt: expected,
      media: [{ type: 'reference_image', url: refs[first] }],
    });
  });

  it('encodes HappyHorse video-edit media and the async header', async () => {
    const fetcher = transport(
      { output: { task_id: 'horse-1' } },
      {
        output: {
          task_id: 'horse-1',
          task_status: 'SUCCEEDED',
          video_url: 'https://cdn.fixture/horse.mp4',
        },
      },
    );
    const protocol = createVideoProtocol(
      route('happyhorse-videos', ['video_edit']),
      'happyhorse-1.1-video-edit',
      fetcher,
    );
    const submitted = await protocol.submit(
      {
        mode: 'video_edit',
        prompt: 'edit',
        resolution: '720P',
        audioSetting: 'origin',
        references: [{ assetId: video, mediaType: 'video' }, { assetId: first }],
      },
      refs,
      key,
      signal,
    );
    expect(submitted).toEqual({ state: 'submitted', upstreamTaskId: 'horse-1' });
    expect(body(fetcher)).toEqual({
      model: 'happyhorse-1.1-video-edit',
      input: {
        prompt: 'edit',
        media: [
          { type: 'video', url: refs[video] },
          { type: 'reference_image', url: refs[first] },
        ],
      },
      parameters: { resolution: '720P', audio_setting: 'origin' },
    });
    expect(
      (fetcher.mock.calls[0]![1]?.headers as Record<string, string>)['X-DashScope-Async'],
    ).toBe('enable');
    expect((await protocol.query('horse-1', key, signal)).state).toBe('returned');
  });

  it.each([
    {
      driver: 'volcengine-ark-videos',
      success: {
        data: { id: 'original', status: 'succeeded', content: { video_url: refs[video] } },
      },
      suspicious: [
        { id: 'another', status: 'succeeded', content: { video_url: refs[video] } },
        { id: null, status: 'failed' },
        { status: 'running' },
        { id: 'original', data: { status: 'succeeded', content: { video_url: refs[video] } } },
        { id: 'original', data: { task_id: 'another', status: 'running' } },
        { id: 'another', data: { id: 'original', status: 'failed' } },
      ],
    },
    {
      driver: 'kling-videos',
      success: {
        code: 0,
        data: {
          task_id: 'original',
          task_status: 'succeed',
          task_result: { videos: [{ id: 'kling-work-1', url: refs[video] }] },
        },
      },
      suspicious: [
        {
          code: 0,
          data: {
            task_id: 'another',
            task_status: 'succeed',
            task_result: { videos: [{ url: refs[video] }] },
          },
        },
        { code: 0, data: { task_id: {}, task_status: 'failed' } },
        { code: 0 },
        { code: 0, data: { task_status: 'processing' } },
        { code: 0, data: { task_id: 'another', task_status: 'awaiting_worker' } },
        { code: 0, data: { task_status: 'awaiting_worker' } },
        { code: 17, data: { task_id: 'another' } },
        { code: 17, data: { task_status: 'failed' } },
        { data: { task_result: { videos: [{ url: refs[video] }] } } },
        { code: '17', data: { task_info: {} } },
        { code: 17, data: { created_at: 1722769557708 } },
        { code: null, data: { task_id: null } },
        { code: 17, task_id: 'another', data: { task_id: 'original' } },
      ],
    },
    {
      driver: 'vidu-videos',
      success: {
        id: 'original',
        state: 'success',
        creations: [{ id: 'vidu-work-3', url: refs[video] }],
      },
      suspicious: [
        { id: 'another', state: 'success', creations: [{ id: 'original', url: refs[video] }] },
        { id: 47, state: 'failed' },
        { id: 'original', task_id: 'another', state: 'processing' },
        { task_id: '', state: 'processing' },
      ],
    },
    {
      driver: 'happyhorse-videos',
      success: { task_id: 'original', task_status: 'SUCCEEDED', video_url: refs[video] },
      suspicious: [
        { output: { task_id: 'another', task_status: 'SUCCEEDED', video_url: refs[video] } },
        { output: { task_id: false, task_status: 'FAILED' } },
        { output: { task_status: 'RUNNING' } },
        { task_id: 'original', output: { task_status: 'SUCCEEDED', video_url: refs[video] } },
        { task_id: 'another', output: { task_id: 'original', task_status: 'FAILED' } },
        { task_id: 'original', output: { task_id: 'another', task_status: 'RUNNING' } },
        { task_id: 'another', output: { task_id: 'original', task_status: 'UNKNOWN' } },
        { output: { task_status: 'UNKNOWN' } },
      ],
    },
  ] as const)('$driver validates task identity before status and media', async (fixture) => {
    const config = route(fixture.driver);
    const taskId =
      fixture.driver === 'kling-videos'
        ? JSON.stringify({ path: '/kling/v1/videos/image2video', id: 'original' })
        : 'original';
    const expectedPath =
      fixture.driver === 'kling-videos'
        ? '/kling/v1/videos/image2video/original'
        : config.queryPathTemplate.replace('{task_id}', taskId);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixture.success));
    for (const response of fixture.suspicious)
      fetcher.mockResolvedValueOnce(Response.json(response));
    const protocol = createVideoProtocol(config, 'fixture-model', fetcher);
    expect(await protocol.query(taskId, key, signal)).toEqual({
      state: 'returned',
      videos: [{ url: refs[video] }],
    });
    for (const response of fixture.suspicious) {
      expect(await protocol.query(taskId, key, signal), JSON.stringify(response)).toEqual({
        state: 'unknown',
        code: 'VIDEO_QUERY_IDENTITY_INVALID',
      });
    }
    expect(
      fetcher.mock.calls.map(([url, options]) => [new URL(String(url)).pathname, options?.method]),
    ).toEqual(Array.from({ length: fixture.suspicious.length + 1 }, () => [expectedPath, 'GET']));
  });

  it('requires an integer gateway code for a taskless Kling rejection', async () => {
    const task = JSON.stringify({ path: '/kling/v1/videos/text2video', id: 'original' });
    for (const body of [{ code: 17 }, { code: 17, request_id: 'trace-id', data: null }]) {
      const protocol = createVideoProtocol(
        route('kling-videos'),
        'fixture-model',
        transport({}, body),
      );
      expect(await protocol.query(task, key, signal)).toEqual({
        state: 'failed',
        code: 'VIDEO_UPSTREAM_FAILED',
      });
    }
    for (const body of [{}, { code: '17' }, { code: null }, { code: 1.7 }, { code: false }]) {
      const protocol = createVideoProtocol(
        route('kling-videos'),
        'fixture-model',
        transport({}, body),
      );
      expect(await protocol.query(task, key, signal), JSON.stringify(body)).toEqual({
        state: 'failed',
        code: 'VIDEO_RESPONSE_INVALID',
      });
    }
  });

  it.each([
    {
      driver: 'kling-videos',
      taskId: JSON.stringify({ path: '/kling/v1/videos/image2video', id: 'original' }),
      path: '/kling/v1/videos/image2video/original',
      response: (status: unknown) => ({
        code: 0,
        data: { task_id: 'original', task_status: status },
      }),
      processing: 'processing',
      unknown: ['awaiting worker'],
      failed: ['failed', 'cancelled'],
    },
    {
      driver: 'happyhorse-videos',
      taskId: 'original',
      path: '/happyhorse/v1/tasks/original',
      response: (status: unknown) => ({
        task_id: 'original',
        output: { task_id: 'original', task_status: status },
      }),
      processing: 'RUNNING',
      unknown: ['UNKNOWN', 'AWAITING_WORKER'],
      failed: ['FAILED', 'CANCELED'],
    },
  ] as const)(
    '$driver distinguishes unknown task states from failure and malformed states',
    async ({ driver, taskId, path, response, processing, unknown, failed }) => {
      const cases = [
        { statuses: [processing], result: { state: 'processing' } },
        { statuses: unknown, result: { state: 'unknown', code: 'VIDEO_QUERY_STATUS_UNKNOWN' } },
        { statuses: failed, result: { state: 'failed', code: 'VIDEO_UPSTREAM_FAILED' } },
        {
          statuses: [undefined, null, '', '  ', 0, [processing], { status: processing }],
          result: { state: 'failed', code: 'VIDEO_RESPONSE_INVALID' },
        },
      ];
      const fetcher = vi.fn<typeof fetch>();
      const protocol = createVideoProtocol(route(driver), 'fixture-model', fetcher);
      for (const { statuses, result } of cases) {
        for (const status of statuses) {
          fetcher.mockResolvedValueOnce(Response.json(response(status)));
          expect(await protocol.query(taskId, key, signal), JSON.stringify(status)).toEqual(result);
        }
      }
      expect(
        fetcher.mock.calls.map(([url, options]) => [
          new URL(String(url)).pathname,
          options?.method,
        ]),
      ).toEqual(cases.flatMap(({ statuses }) => statuses.map(() => [path, 'GET'])));
    },
  );

  it('reads HappyHorse output from the same layer as its task identity and status', async () => {
    const happyhorse = createVideoProtocol(
      route('happyhorse-videos'),
      'fixture-model',
      transport(
        {},
        {
          output: { task_id: 'original', task_status: 'SUCCEEDED' },
          video_url: refs[video],
        },
      ),
    );
    expect(await happyhorse.query('original', key, signal)).toEqual({
      state: 'failed',
      code: 'VIDEO_RESPONSE_INVALID',
    });
  });

  it('makes a transport-unknown submission exactly once and hides upstream secrets', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('secret token and provider text'));
    const protocol = createVideoProtocol(route('volcengine-ark-videos'), 'vega-1.5-pro', fetcher);
    expect(
      await protocol.submit({ mode: 'text_to_video', prompt: 'test' }, {}, key, signal),
    ).toEqual({ state: 'unknown', code: 'VIDEO_SUBMISSION_UNKNOWN' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('distinguishes 4xx rejection from unknown submission', async () => {
    for (const [status, state] of [
      [401, 'rejected'],
      [429, 'rejected'],
      [500, 'unknown'],
      [408, 'unknown'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret', { status }));
      const protocol = createVideoProtocol(route('volcengine-ark-videos'), 'vega-1.5-pro', fetcher);
      expect(
        (await protocol.submit({ mode: 'text_to_video', prompt: 'test' }, {}, key, signal)).state,
      ).toBe(state);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    [401, 'retry', 'VIDEO_QUERY_AUTH'],
    [403, 'retry', 'VIDEO_QUERY_AUTH'],
    [429, 'retry', 'VIDEO_QUERY_RATE_LIMITED'],
    [408, 'retry', 'VIDEO_QUERY_TIMEOUT'],
    [500, 'retry', 'VIDEO_QUERY_UPSTREAM_UNAVAILABLE'],
    [503, 'retry', 'VIDEO_QUERY_UPSTREAM_UNAVAILABLE'],
    [404, 'failed', 'VIDEO_REJECTED'],
  ] as const)('classifies HTTP %i during one original GET', async (status, state, code) => {
    const cancel = vi.fn().mockRejectedValue(new Error('fixture response cleanup failed'));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
    const protocol = createVideoProtocol(route('volcengine-ark-videos'), 'vega-1.5-pro', fetcher);
    expect(await protocol.query('task-1', key, signal)).toEqual({ state, code });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      new URL('https://api.onelinkai.cloud/volc/api/v3/contents/generations/tasks/task-1'),
      { method: 'GET', redirect: 'error', signal, headers: { Authorization: 'Bearer ' + key } },
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(['headers', 'body'] as const)(
    'identifies an expiring GET budget while reading %s',
    async (stage) => {
      const budget = AbortSignal.timeout(10);
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
        expect(options?.signal).toBe(budget);
        if (stage === 'headers') {
          return new Promise<Response>((_resolve, reject) => {
            budget.addEventListener('abort', () => reject(budget.reason), { once: true });
          });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              budget.addEventListener('abort', () => controller.error(budget.reason), {
                once: true,
              });
            },
          }),
        );
      });
      const protocol = createVideoProtocol(route('volcengine-ark-videos'), 'vega-1.5-pro', fetcher);
      expect(await protocol.query('task-1', key, budget)).toEqual({
        state: 'retry',
        code: 'VIDEO_QUERY_TIMEOUT',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('propagates service stop without treating it as an upstream result', async () => {
    const stop = new AbortController();
    const stopping = new Error('fixture stopping');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      stop.abort(stopping);
      options?.signal?.throwIfAborted();
      return Response.json({ id: 'task-1', status: 'running' });
    });
    const protocol = createVideoProtocol(route('volcengine-ark-videos'), 'vega-1.5-pro', fetcher);
    await expect(protocol.query('task-1', key, stop.signal)).rejects.toBe(stopping);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('distinguishes network and response stream errors from malformed JSON and processing', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError('fixture response connection lost'));
        },
      }),
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fixture connection lost'))
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response('{"id":'))
      .mockResolvedValueOnce(new Response(new Uint8Array([0xff])))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1)))
      .mockResolvedValueOnce(Response.json({ id: 'task-1', status: 'running' }));
    const protocol = createVideoProtocol(route('volcengine-ark-videos'), 'vega-1.5-pro', fetcher);
    for (const code of [
      'VIDEO_QUERY_NETWORK_ERROR',
      'VIDEO_QUERY_NETWORK_ERROR',
      'VIDEO_QUERY_RESPONSE_INVALID',
      'VIDEO_QUERY_RESPONSE_INVALID',
      'VIDEO_QUERY_RESPONSE_INVALID',
      'VIDEO_QUERY_RESPONSE_INVALID',
      'VIDEO_QUERY_RESPONSE_INVALID',
    ]) {
      expect(await protocol.query('task-1', key, signal)).toEqual({ state: 'retry', code });
    }
    expect(await protocol.query('task-1', key, signal)).toEqual({ state: 'processing' });
    expect(fetcher.mock.calls.map(([, options]) => options?.method)).toEqual(Array(8).fill('GET'));
  });

  it('rejects untrusted route/task identity and never accepts success without media', async () => {
    expect(() =>
      createVideoProtocol(
        { ...route('volcengine-ark-videos'), submitPath: 'https://evil.fixture' },
        'model',
      ),
    ).toThrow('VIDEO_ROUTE_INVALID');
    const fetcher = transport({}, { id: 'task-1', status: 'succeeded', content: {} });
    const protocol = createVideoProtocol(route('volcengine-ark-videos'), 'vega-1.5-pro', fetcher);
    expect(await protocol.query('../task', key, signal)).toEqual({
      state: 'failed',
      code: 'VIDEO_TASK_INVALID',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await protocol.query('task-1', key, signal)).state).toBe('failed');
  });

  it('bounds untrusted response bytes before JSON decoding', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1)));
    const protocol = createVideoProtocol(route('volcengine-ark-videos'), 'vega-1.5-pro', fetcher);
    expect(
      await protocol.submit({ mode: 'text_to_video', prompt: 'test' }, {}, key, signal),
    ).toEqual({ state: 'unknown', code: 'VIDEO_SUBMISSION_UNKNOWN' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
