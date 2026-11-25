import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { VideoDriver, VideoMode } from '../../src/generations/video/contracts.ts';
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
    const fetcher = transport(
      { id: 'ark-task-1' },
      { status: 'succeeded', content: { video_url: 'https://cdn.fixture/output.mp4' } },
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
      refs,
      key,
      signal,
    );
    expect(submitted).toEqual({ state: 'submitted', upstreamTaskId: 'ark-task-1' });
    expect(body(fetcher)).toMatchObject({
      model: 'doubao-seedance-2-0-fast',
      content: [
        { type: 'text', text: 'frames' },
        { type: 'image_url', image_url: { url: refs[first] }, role: 'first_frame' },
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
    expect(
      JSON.parse(String(fetcher.mock.calls[2]![1]?.body)).content.map(
        (item: { role?: string }) => item.role,
      ),
    ).toEqual([undefined, 'reference_video', 'reference_image', 'reference_audio']);
  });

  it('persists the original Kling image endpoint in its task token', async () => {
    const fetcher = transport(
      { code: 0, data: { task_id: 'kling-1' } },
      {
        code: 0,
        data: {
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

  it('uses Omni contents/settings and never flattens a reference video', async () => {
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

  it('rejects turbo tail frames and explicit sound before POST', async () => {
    const fetcher = transport({}, {});
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
  });

  it('encodes Vidu q2 named subjects without q3-only fields', async () => {
    const fetcher = transport(
      { task_id: 'vidu-1' },
      { state: 'success', creations: [{ watermarked_url: 'https://cdn.fixture/vidu.mp4' }] },
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

  it('encodes HappyHorse exact i2v and video-edit media forms with async header', async () => {
    const fetcher = transport(
      { output: { task_id: 'horse-1' } },
      { output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.fixture/horse.mp4' } },
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

  it('distinguishes 4xx rejection from unknown submission and transient query errors', async () => {
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
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    expect(
      await createVideoProtocol(route('volcengine-ark-videos'), 'vega-1.5-pro', fetcher).query(
        'task-1',
        key,
        signal,
      ),
    ).toEqual({ state: 'processing' });
  });

  it('rejects untrusted route/task identity and never accepts success without media', async () => {
    expect(() =>
      createVideoProtocol(
        { ...route('volcengine-ark-videos'), submitPath: 'https://evil.fixture' },
        'model',
      ),
    ).toThrow('VIDEO_ROUTE_INVALID');
    const fetcher = transport({}, { status: 'succeeded', content: {} });
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
