import type { VideoMode } from '../../src/generations/video-contracts.ts';
import type { VideoParameterSpec, VideoRouteConfig } from '../../src/providers/contracts.ts';

// Frozen source observation; does not create catalog membership or verification.
export const LEGACY_VIDEO_SOURCE_VERSION =
  'sha256:0261230494cb2163d2d9362dbc977522f9a48a965b4160bfc8e2948dc02b30c4';
const RATIOS = ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'];
const FRAMES: readonly VideoMode[] = ['text_to_video', 'first_frame', 'start_end'];
const MIXED: readonly VideoMode[] = [
  'full',
  'text_to_video',
  'first_frame',
  'last_frame',
  'start_end',
  'video_ref',
];
const ARK_PATH = '/volc/api/v3/contents/generations/tasks';
const HAPPY_PATH = '/happyhorse/v1/services/aigc/video-generation/video-synthesis';

function seconds(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function limits(overrides: Partial<VideoParameterSpec>): VideoParameterSpec {
  return {
    ratios: RATIOS,
    resolutions: ['720p', '1080p'],
    durations: seconds(3, 15),
    maxPromptCodepoints: 3000,
    maxImages: 0,
    maxVideos: 0,
    maxAudios: 0,
    maxInputs: 0,
    maxSubjects: 0,
    maxSubjectImages: 0,
    generateAudio: false,
    watermark: false,
    offPeak: false,
    audioSettings: [],
    requiresResolution: false,
    referenceAudioRequiresVisual: false,
    referenceDurations: [],
    ...overrides,
  };
}

interface LegacyVideoEntry {
  rawModelId: string;
  operation: 'video.generate';
  classification: 'video';
  vendor: string;
  driver: VideoRouteConfig['driver'];
  submitPath: string;
  queryPathTemplate: string;
  paramSpec: VideoRouteConfig['paramSpec'];
  sourceKind: 'protocol-reference';
  source: string;
  sourceVersion: string;
  enabled: true;
}

function entry(
  model: string,
  driver: VideoRouteConfig['driver'],
  vendor: string,
  path: string,
  query: string,
  modes: readonly VideoMode[],
  parameters: VideoParameterSpec,
): LegacyVideoEntry {
  return {
    rawModelId: model,
    operation: 'video.generate',
    classification: 'video',
    vendor,
    driver,
    submitPath: path,
    queryPathTemplate: query,
    paramSpec: { supportedModes: [...modes], parameters: structuredClone(parameters) },
    sourceKind: 'protocol-reference',
    source: 'mio1.5.1/backend/app/services/model_capabilities.py + services/video_gen/',
    sourceVersion: LEGACY_VIDEO_SOURCE_VERSION,
    enabled: true,
  };
}

function ark(
  model: string,
  modes: readonly VideoMode[],
  parameters: VideoParameterSpec,
): LegacyVideoEntry {
  return entry(
    model,
    'volcengine-ark-videos',
    'volcengine',
    ARK_PATH,
    `${ARK_PATH}/{task_id}`,
    modes,
    parameters,
  );
}

const ARK_15 = limits({
  ratios: [...RATIOS, 'adaptive'],
  resolutions: ['480p', '720p', '1080p'],
  durations: seconds(4, 12),
  maxImages: 2,
  maxInputs: 2,
  generateAudio: true,
  watermark: true,
});
const ARK_2 = limits({
  ratios: [...RATIOS, 'adaptive'],
  resolutions: ['480p', '720p', '1080p', '4k'],
  durations: seconds(4, 15),
  maxImages: 9,
  maxVideos: 3,
  maxAudios: 3,
  maxInputs: 15,
  generateAudio: true,
  watermark: true,
  referenceAudioRequiresVisual: true,
});

/** Exact identities only; unknown IDs and display aliases deliberately remain absent. */
export function legacyVideoRouteEntries(discoveredIds: readonly string[]): LegacyVideoEntry[] {
  const entries: LegacyVideoEntry[] = [
    ark('doubao-seedance-1.5-pro', FRAMES, ARK_15),
    ark('vega-1.5-pro', FRAMES, { ...ARK_15, requiresResolution: true }),
    ark('vega-1.0-pro', MIXED, {
      ...ARK_2,
      resolutions: ['480p', '720p', '1080p'],
      requiresResolution: true,
    }),
    ...[
      'doubao-seedance-2.0',
      'doubao-seedance-2-0',
      'doubao-seedance-2-0-260128',
      'doubao-seedance-2-0-mini-260615',
      'doubao-seedance-2-0-fast',
      'doubao-seedance-2-0-fast-260128',
      'doubao-seedance-2-0-fast-v1',
    ].map((model) => ark(model, MIXED, ARK_2)),
    // The public parser currently caps all media items at 16. Larger 2.5 pools stay a documented gap.
    ark('doubao-seedance-2-5-260628', MIXED, {
      ...ARK_2,
      resolutions: ['480p', '720p'],
      durations: seconds(4, 30),
      maxImages: 16,
      maxVideos: 10,
      maxAudios: 10,
      maxInputs: 16,
      referenceAudioRequiresVisual: false,
    }),
    entry(
      'video-kling-v3',
      'kling-videos',
      'kling',
      '/kling/v1/videos/text2video',
      '/kling/v1/videos/text2video/{task_id}',
      FRAMES,
      limits({
        maxPromptCodepoints: 2500,
        durations: seconds(5, 15),
        maxImages: 2,
        maxInputs: 2,
        generateAudio: true,
      }),
    ),
    entry(
      'video-kling-v3-omni',
      'kling-videos',
      'kling',
      '/kling/v1/videos/omni-video',
      '/kling/v1/videos/omni-video/{task_id}',
      [...FRAMES, 'video_ref'],
      limits({
        maxPromptCodepoints: 2500,
        resolutions: ['720p', '1080p', '4k'],
        maxImages: 2,
        maxVideos: 1,
        maxInputs: 3,
        generateAudio: true,
      }),
    ),
    entry(
      'kling-v2-5-turbo',
      'kling-videos',
      'kling',
      '/kling/v1/videos/text2video',
      '/kling/v1/videos/text2video/{task_id}',
      ['text_to_video', 'first_frame'],
      limits({
        maxPromptCodepoints: 2500,
        ratios: ['16:9', '9:16', '1:1'],
        durations: [5, 10],
        maxImages: 1,
        maxInputs: 1,
      }),
    ),
    entry(
      'video-viduq3-pro',
      'vidu-videos',
      'vidu',
      '/vidu/ent/v2/text2video',
      '/vidu/ent/v2/tasks/{task_id}/creations',
      FRAMES,
      limits({
        maxPromptCodepoints: 5000,
        ratios: RATIOS.filter((ratio) => ratio !== '21:9'),
        resolutions: ['540p', '720p', '1080p'],
        durations: seconds(1, 16),
        maxImages: 2,
        maxInputs: 2,
        generateAudio: true,
        watermark: true,
        offPeak: true,
      }),
    ),
    entry(
      'video-vidu-q2',
      'vidu-videos',
      'vidu',
      '/vidu/ent/v2/text2video',
      '/vidu/ent/v2/tasks/{task_id}/creations',
      ['text_to_video', 'reference_subjects'],
      limits({
        maxPromptCodepoints: 5000,
        ratios: RATIOS.filter((ratio) => ratio !== '21:9'),
        resolutions: [],
        durations: [4, 8],
        maxImages: 7,
        maxInputs: 7,
        maxSubjects: 7,
        maxSubjectImages: 3,
        generateAudio: true,
      }),
    ),
    ...['veo-3.1', 'veo-3.1-fast'].map((model) =>
      entry(
        model,
        'veo-videos',
        'google',
        '/v1beta/models/{model}:predictLongRunning',
        '/v1beta/operations/{task_id}',
        [...FRAMES, 'reference_subjects'],
        limits({
          ratios: ['16:9', '9:16'],
          resolutions: ['720p', '1080p', '4k'],
          durations: [8],
          maxImages: 3,
          maxInputs: 3,
          maxSubjects: 3,
          maxSubjectImages: 3,
          referenceDurations: [8],
        }),
      ),
    ),
  ];
  for (const version of ['1.0', '1.1']) {
    const ratios = ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4'];
    const variants: [string, readonly VideoMode[], VideoParameterSpec][] = [
      ['t2v', ['text_to_video'], limits({ ratios, watermark: true })],
      ['i2v', ['first_frame'], limits({ ratios: [], maxImages: 1, maxInputs: 1, watermark: true })],
      [
        'r2v',
        ['reference_subjects'],
        limits({
          ratios,
          maxImages: 9,
          maxInputs: 9,
          maxSubjects: 9,
          maxSubjectImages: 9,
          watermark: true,
        }),
      ],
      [
        'video-edit',
        ['video_edit'],
        limits({
          ratios: [],
          durations: [],
          maxImages: 5,
          maxVideos: 1,
          maxInputs: 6,
          watermark: true,
          audioSettings: ['auto', 'origin'],
        }),
      ],
    ];
    for (const [variant, modes, parameters] of variants)
      entries.push(
        entry(
          `happyhorse-${version}-${variant}`,
          'happyhorse-videos',
          'happyhorse',
          HAPPY_PATH,
          '/happyhorse/v1/tasks/{task_id}',
          modes,
          parameters,
        ),
      );
  }
  const discovered = new Set(discoveredIds);
  return entries.filter((item) => discovered.has(item.rawModelId));
}
