import { expect, it } from 'vitest';
import { legacyVideoRouteEntries } from '../../scripts/service/legacy-video-routes.ts';
import {
  resolveVideoRoute,
  validateModelRouteEntry,
  validateRouteImportPayload,
} from '../../src/providers/onelink/router.ts';
import {
  validateVideoParameters,
  videoCapabilityModes,
  validateVideoRouteConfig,
  videoRouteRuntimeAvailable,
} from '../../src/providers/onelink/video-route.ts';
import type { VideoRequestParameters } from '../../src/generations/video/contracts.ts';
import type { PlatformRouteRecord, VideoRouteConfig } from '../../src/providers/contracts.ts';

const MODELS = [
  'doubao-seedance-1.5-pro',
  'doubao-seedance-2.0',
  'doubao-seedance-2-0',
  'doubao-seedance-2-0-260128',
  'doubao-seedance-2-5-260628',
  'doubao-seedance-2-0-mini-260615',
  'doubao-seedance-2-0-fast',
  'doubao-seedance-2-0-fast-260128',
  'doubao-seedance-2-0-fast-v1',
  'vega-1.5-pro',
  'vega-1.0-pro',
  'video-kling-v3',
  'video-kling-v3-omni',
  'kling-v2-5-turbo',
  'video-viduq3-pro',
  'video-vidu-q2',
  'veo-3.1',
  'veo-3.1-fast',
  'happyhorse-1.0-t2v',
  'happyhorse-1.0-i2v',
  'happyhorse-1.0-r2v',
  'happyhorse-1.0-video-edit',
  'happyhorse-1.1-t2v',
  'happyhorse-1.1-i2v',
  'happyhorse-1.1-r2v',
  'happyhorse-1.1-video-edit',
];

function route(model: string): VideoRouteConfig {
  const declaration = legacyVideoRouteEntries([model])[0]!;
  const result = validateVideoRouteConfig({
    ...declaration,
    editPath: null,
    requestDefaults: {},
    outputSpec: {},
  });
  expect(result).toBeDefined();
  return result!;
}

function input(patch: Partial<VideoRequestParameters> = {}): VideoRequestParameters {
  return { mode: 'text_to_video', prompt: 'A paper boat floats on a quiet lake.', ...patch };
}

function storedRoute(
  declaration: ReturnType<typeof legacyVideoRouteEntries>[number],
): PlatformRouteRecord {
  return {
    provider_type: 'onelink',
    raw_model_id: declaration.rawModelId,
    operation: declaration.operation,
    vendor: declaration.vendor,
    driver: declaration.driver,
    classification: declaration.classification,
    submit_path: declaration.submitPath,
    edit_path: null,
    query_path_template: declaration.queryPathTemplate,
    param_spec: { ...declaration.paramSpec },
    request_defaults: {},
    output_spec: {},
    capability_metadata: {
      video: { modes: declaration.paramSpec.supportedModes, cancellation: { supported: false } },
    },
    source_kind: declaration.sourceKind,
    source: declaration.source,
    source_version: declaration.sourceVersion,
    declaration_version: 1,
    enabled: true,
  };
}

it('migrates only 26 exact discovered identities with independently validated sourced declarations', () => {
  const declarations = legacyVideoRouteEntries([
    ...MODELS,
    'unknown',
    'kling-v2.5-turbo',
    'doubao-seedance-2.0-fast',
  ]);
  expect(declarations).toHaveLength(26);
  expect(new Set(declarations.map((item) => item.rawModelId)).size).toBe(26);
  for (const declaration of declarations) {
    expect(validateModelRouteEntry(declaration)).toMatchObject({
      operation: 'video.generate',
      rawModelId: declaration.rawModelId,
      capabilityMetadata: { video: { modes: declaration.paramSpec.supportedModes } },
    });
    expect(resolveVideoRoute(storedRoute(declaration))).toMatchObject({
      route: { paramSpec: { supportedModes: declaration.paramSpec.supportedModes } },
    });
    expect(declaration.sourceVersion).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(declaration.paramSpec.parameters).toBeDefined();
  }
  expect(legacyVideoRouteEntries(['future-Seedance', 'Vega 1.5 Pro', 'kling-v2.5-turbo'])).toEqual(
    [],
  );
});

it.each([
  ['doubao-seedance-1.5-pro', 'full'],
  ['vega-1.5-pro', 'last_frame'],
  ['doubao-seedance-2-0', 'reference_subjects'],
  ['video-kling-v3', 'video_ref'],
  ['video-kling-v3-omni', 'full'],
  ['kling-v2-5-turbo', 'start_end'],
  ['video-vidu-q2', 'first_frame'],
  ['video-vidu-q2', 'start_end'],
  ['video-viduq3-pro', 'full'],
  ['video-viduq3-pro', 'last_frame'],
  ['video-viduq3-pro', 'reference_subjects'],
  ['veo-3.1', 'video_ref'],
  ['happyhorse-1.0-i2v', 'reference_subjects'],
  ['happyhorse-1.1-r2v', 'video_edit'],
] as const)(
  'rejects %s declarations that include %s at import and live resolution',
  (model, mode) => {
    const seed = legacyVideoRouteEntries([model])[0]!;
    const declared = {
      ...seed,
      paramSpec: { ...seed.paramSpec, supportedModes: [...seed.paramSpec.supportedModes, mode] },
    };
    expect(() => validateRouteImportPayload({ routes: [declared] })).toThrow('ROUTE_INVALID');
    expect(resolveVideoRoute(storedRoute(declared))).toBeUndefined();
  },
);

it('allows a sourced dynamic Vidu model and binds Kling video_ref to exact Omni', () => {
  const dynamic = {
    ...legacyVideoRouteEntries(['video-vidu-q2'])[0]!,
    rawModelId: 'video-vidu-fixture_new-subject-model:v2.1',
  };
  expect(validateModelRouteEntry(dynamic).paramSpec.supportedModes).toEqual([
    'text_to_video',
    'reference_subjects',
  ]);
  expect(resolveVideoRoute(storedRoute(dynamic))?.route.paramSpec.supportedModes).toEqual([
    'text_to_video',
    'reference_subjects',
  ]);

  const omniAlias = {
    ...legacyVideoRouteEntries(['video-kling-v3-omni'])[0]!,
    rawModelId: 'video-kling-v3-omni-fixture-alias',
  };
  expect(() => validateModelRouteEntry(omniAlias)).toThrow('ROUTE_INVALID');
  expect(resolveVideoRoute(storedRoute(omniAlias))).toBeUndefined();
});

it.each(['video-vidu/fixture', 'video-vidu fixture', 'video-vidu-测试'])(
  'rejects an unconstructible video model ID at import and live resolution: %s',
  (rawModelId) => {
    const declared = { ...legacyVideoRouteEntries(['video-vidu-q2'])[0]!, rawModelId };
    expect.soft(() => validateRouteImportPayload(declared)).toThrow('ROUTE_INVALID');
    expect(resolveVideoRoute(storedRoute(declared))).toBeUndefined();
  },
);

it.each([
  ['video-vidu-q2', { resolutions: ['720p'] }],
  ['video-vidu-q2', { resolutions: ['720p'], requiresResolution: true }],
  ['video-vidu-q2', { watermark: true }],
  ['video-vidu-q2', { offPeak: true }],
  ['video-vidu-q2', { audioSettings: ['origin'] }],
  ['kling-v2-5-turbo', { generateAudio: true }],
  ['kling-v2-5-turbo', { watermark: true }],
  ['kling-v2-5-turbo', { audioSettings: ['origin'] }],
])('rejects %s live capabilities without corresponding wire fields: %j', (model, parameters) => {
  const seed = legacyVideoRouteEntries([model])[0]!;
  const declared = {
    ...seed,
    paramSpec: { ...seed.paramSpec, parameters: { ...seed.paramSpec.parameters!, ...parameters } },
  };
  expect.soft(() => validateRouteImportPayload(declared)).toThrow('ROUTE_INVALID');
  expect(resolveVideoRoute(storedRoute(declared))).toBeUndefined();
});

it.each([
  ['video-kling-v3-omni', 'video_ref', { maxAudios: 1 }],
  ['video-kling-v3-omni', 'video_ref', { maxVideos: 2 }],
  ['video-kling-v3-omni', 'video_ref', { maxVideos: 0 }],
  ['happyhorse-1.0-video-edit', 'video_edit', { maxAudios: 1 }],
] as const)(
  'rejects %s %s media limits %j at import and live resolution',
  (model, _mode, limits) => {
    const seed = legacyVideoRouteEntries([model])[0]!;
    const declared = {
      ...seed,
      paramSpec: {
        ...seed.paramSpec,
        parameters: { ...seed.paramSpec.parameters!, ...limits },
      },
    };
    expect(
      validateVideoRouteConfig({
        ...declared,
        editPath: null,
        requestDefaults: {},
        outputSpec: {},
      }),
    ).toBeDefined();
    expect(() => validateRouteImportPayload(declared)).toThrow('ROUTE_INVALID');
    expect(resolveVideoRoute(storedRoute(declared))).toBeUndefined();
  },
);

it.each(['video-kling-v3-omni', 'happyhorse-1.0-video-edit'])(
  'keeps incomplete %s declarations visible and pending',
  (model) => {
    const seed = legacyVideoRouteEntries([model])[0]!;
    const legacy = { ...seed, paramSpec: { supportedModes: seed.paramSpec.supportedModes } };
    const resolved = resolveVideoRoute(storedRoute(legacy));
    expect(resolved?.route.paramSpec.supportedModes).toEqual(seed.paramSpec.supportedModes);
    expect(videoRouteRuntimeAvailable(resolved!.route)).toBe(false);
  },
);

it('keeps incomplete V1 declarations visible but rejects their execution parameters', () => {
  const complete = route('doubao-seedance-1.5-pro');
  const legacy = { ...complete, paramSpec: { supportedModes: complete.paramSpec.supportedModes } };
  expect(validateVideoParameters(input(), legacy)).toBe(false);
  expect(videoRouteRuntimeAvailable(legacy)).toBe(false);
  expect(videoCapabilityModes(legacy, false)).toEqual(
    legacy.paramSpec.supportedModes.map((mode) => ({ mode, supported: false })),
  );
  expect(videoRouteRuntimeAvailable(complete)).toBe(true);
  expect(videoRouteRuntimeAvailable(route('veo-3.1'))).toBe(false);
});

it('rejects unknown or malformed route constraints and arbitrary upstream paths', () => {
  const complete = route('doubao-seedance-1.5-pro');
  const base = { ...complete, editPath: null };
  for (const patch of [
    { submitPath: 'https://attacker.test/tasks' },
    { queryPathTemplate: '/volc/api/v3/contents/generations/tasks/{unknown}' },
    {
      paramSpec: {
        ...complete.paramSpec,
        parameters: { ...complete.paramSpec.parameters, maxInputs: 100 },
      },
    },
    {
      paramSpec: {
        ...complete.paramSpec,
        parameters: { ...complete.paramSpec.parameters, generateAudio: 'yes' },
      },
    },
    {
      paramSpec: {
        ...complete.paramSpec,
        parameters: { ...complete.paramSpec.parameters, durations: [0, 5] },
      },
    },
    {
      paramSpec: {
        ...complete.paramSpec,
        parameters: { ...complete.paramSpec.parameters, endpoint: '/other' },
      },
    },
  ])
    expect(validateVideoRouteConfig({ ...base, ...patch })).toBeUndefined();
});

it('retains Kling 2.5 Turbo restrictions on tail frames and native sound', () => {
  const turbo = route('kling-v2-5-turbo');
  expect(validateVideoParameters(input({ durationSeconds: 5, resolution: '720p' }), turbo)).toBe(
    true,
  );
  for (const patch of [
    { mode: 'start_end' as const },
    { generateAudio: true },
    { generateAudio: false },
    { durationSeconds: 6 },
    { watermark: false },
    { multiShot: false },
    { resolution: '4k' },
  ])
    expect(validateVideoParameters(input(patch), turbo)).toBe(false);
  expect(
    validateVideoParameters(
      input({ generateAudio: false, durationSeconds: 6 }),
      route('video-kling-v3'),
    ),
  ).toBe(true);
});

it('keeps Vidu Q2 text and named subjects distinct from Q3 frame modes', () => {
  const q2 = route('video-vidu-q2');
  const subjects = [{ name: 'boat', images: [{ assetId: 'image-a' }] }];
  expect(validateVideoParameters(input({ durationSeconds: 4, generateAudio: true }), q2)).toBe(
    true,
  );
  expect(
    validateVideoParameters(
      input({ mode: 'reference_subjects', subjects, prompt: '[@boat] sails.', durationSeconds: 8 }),
      q2,
    ),
  ).toBe(true);
  expect(validateVideoParameters(input({ mode: 'reference_subjects', subjects }), q2)).toBe(false);
  for (const patch of [
    { resolution: '720p' },
    { watermark: false },
    { offPeak: false },
    { mode: 'first_frame' as const },
    { durationSeconds: 5 },
  ])
    expect(validateVideoParameters(input(patch), q2)).toBe(false);
  const q3 = route('video-viduq3-pro');
  expect(
    validateVideoParameters(input({ offPeak: true, generateAudio: true, durationSeconds: 1 }), q3),
  ).toBe(true);
  expect(validateVideoParameters(input({ offPeak: true, generateAudio: false }), q3)).toBe(false);
  expect(validateVideoParameters(input({ mode: 'reference_subjects', subjects }), q3)).toBe(false);
});

it('does not advertise Vidu ratios for modes where validation rejects them', () => {
  const q3 = route('video-viduq3-pro');
  const modes = videoCapabilityModes(q3, true);
  expect(modes.find(({ mode }) => mode === 'text_to_video')?.parameters?.ratios).toContain('16:9');
  expect(modes.find(({ mode }) => mode === 'first_frame')?.parameters).toBeDefined();
  expect(modes.find(({ mode }) => mode === 'first_frame')?.parameters).not.toHaveProperty('ratios');
  expect(
    validateVideoParameters(
      input({ mode: 'first_frame', ratio: '16:9', firstFrame: { assetId: 'image-a' } }),
      q3,
    ),
  ).toBe(false);
});

it('requires Vega resolution and preserves Seedance family duration and media differences', () => {
  const vega = route('vega-1.5-pro');
  expect(validateVideoParameters(input(), vega)).toBe(false);
  expect(validateVideoParameters(input({ resolution: '720p', durationSeconds: 4 }), vega)).toBe(
    true,
  );
  expect(validateVideoParameters(input({ resolution: '4k' }), vega)).toBe(false);
  const mixed = input({ mode: 'full', references: [{ assetId: 'audio-a', mediaType: 'audio' }] });
  expect(validateVideoParameters(mixed, route('doubao-seedance-2-0'))).toBe(false);
  expect(validateVideoParameters(mixed, route('doubao-seedance-2-5-260628'))).toBe(true);
  expect(
    validateVideoParameters(input({ durationSeconds: 30 }), route('doubao-seedance-2-5-260628')),
  ).toBe(true);
  expect(
    validateVideoParameters(input({ durationSeconds: 30 }), route('doubao-seedance-2-0')),
  ).toBe(false);
  expect(
    validateVideoParameters(
      input({
        mode: 'full',
        references: [{ assetId: 'image-a', mediaType: 'image', role: 'system' }],
      }),
      route('doubao-seedance-2-0'),
    ),
  ).toBe(false);
});

it('checks total and per-type media limits without dropping repeated positions', () => {
  const mixed = route('doubao-seedance-2-0');
  const references = Array.from({ length: 10 }, () => ({
    assetId: 'same-image',
    mediaType: 'image' as const,
  }));
  expect(validateVideoParameters(input({ mode: 'full', references }), mixed)).toBe(false);
  expect(
    validateVideoParameters(input({ mode: 'full', references: references.slice(0, 9) }), mixed),
  ).toBe(true);
  expect(validateVideoParameters(input({ prompt: '😀'.repeat(3001) }), mixed)).toBe(false);
});

it.each([
  ['happyhorse-1.1-t2v', input({ prompt: '海🌊' })],
  [
    'happyhorse-1.0-i2v',
    input({ mode: 'first_frame', prompt: '海🌊', firstFrame: { assetId: 'image-a' } }),
  ],
  [
    'happyhorse-1.0-video-edit',
    input({
      mode: 'video_edit',
      prompt: '海🌊',
      references: [{ assetId: 'video-a', mediaType: 'video' }],
    }),
  ],
  [
    'video-vidu-q2',
    input({
      mode: 'reference_subjects',
      prompt: '[@领队🐎] 看向海🌊',
      subjects: [{ name: '领队🐎', images: [{ assetId: 'image-a' }] }],
    }),
  ],
] as const)(
  'keeps the caller prompt limit for %s outside HappyHorse reference subjects',
  (model, request) => {
    const base = route(model);
    const current = {
      ...base,
      paramSpec: {
        ...base.paramSpec,
        parameters: {
          ...base.paramSpec.parameters!,
          maxPromptCodepoints: [...request.prompt].length,
        },
      },
    };
    expect(validateVideoParameters(request, current)).toBe(true);
    expect(validateVideoParameters({ ...request, prompt: request.prompt + '潮' }, current)).toBe(
      false,
    );
  },
);

it('restricts Veo to eight seconds and HappyHorse editing to its own parameters', () => {
  expect(
    validateVideoParameters(input({ durationSeconds: 8, resolution: '1080p' }), route('veo-3.1')),
  ).toBe(true);
  expect(validateVideoParameters(input({ durationSeconds: 4 }), route('veo-3.1'))).toBe(false);
  expect(validateVideoParameters(input({ generateAudio: true }), route('veo-3.1'))).toBe(false);
  const edit = route('happyhorse-1.0-video-edit');
  const request = input({
    mode: 'video_edit',
    references: [{ assetId: 'video-a', mediaType: 'video' }],
    audioSetting: 'origin',
  });
  expect(validateVideoParameters(request, edit)).toBe(true);
  expect(validateVideoParameters({ ...request, durationSeconds: 5 }, edit)).toBe(false);
  expect(validateVideoParameters({ ...request, ratio: '16:9' }, edit)).toBe(false);
  expect(validateVideoParameters({ ...request, audioSetting: 'invented' }, edit)).toBe(false);
});
