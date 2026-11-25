import { VIDEO_DRIVERS, VIDEO_MODES } from '../../generations/video-contracts.ts';
import type {
  VideoDriver,
  VideoMode,
  VideoRequestParameters,
} from '../../generations/video-contracts.ts';
import { isSafeRouteIdentifier } from '../../generations/contracts.ts';
import type { VideoParameterSpec, VideoRouteConfig } from '../contracts.ts';

/** Enabled only when the matching executor and result materializer have been assembled. */
export const VIDEO_RUNTIME_SUPPORTED_DRIVERS: ReadonlySet<VideoDriver> = new Set([
  'volcengine-ark-videos',
  'kling-videos',
  'vidu-videos',
  'happyhorse-videos',
]);

const SUBMIT_PATHS: Readonly<Record<VideoDriver, readonly string[]>> = {
  'volcengine-ark-videos': ['/volc/api/v3/contents/generations/tasks'],
  'kling-videos': [
    '/kling/v1/videos/text2video',
    '/kling/v1/videos/image2video',
    '/kling/v1/videos/multi-image2video',
    '/kling/v1/videos/omni-video',
  ],
  'vidu-videos': [
    '/vidu/ent/v2/text2video',
    '/vidu/ent/v2/img2video',
    '/vidu/ent/v2/start-end2video',
    '/vidu/ent/v2/reference2video',
  ],
  'veo-videos': ['/v1beta/models/{model}:predictLongRunning'],
  'happyhorse-videos': ['/happyhorse/v1/services/aigc/video-generation/video-synthesis'],
};
const PARAMETER_FIELDS = new Set([
  'ratios',
  'resolutions',
  'durations',
  'maxPromptCodepoints',
  'maxImages',
  'maxVideos',
  'maxAudios',
  'maxInputs',
  'maxSubjects',
  'maxSubjectImages',
  'generateAudio',
  'watermark',
  'offPeak',
  'audioSettings',
  'requiresResolution',
  'referenceAudioRequiresVisual',
  'referenceDurations',
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown, maximum = 32): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((item) => typeof item === 'string' && /^[A-Za-z0-9:_-]{1,32}$/.test(item)) &&
    new Set(value).size === value.length
  );
}

function durations(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= 120 &&
    value.every((item) => Number.isSafeInteger(item) && item >= 1 && item <= 120) &&
    new Set(value).size === value.length
  );
}

function parameterSpec(value: unknown): VideoParameterSpec | undefined {
  if (
    !object(value) ||
    Object.keys(value).length !== PARAMETER_FIELDS.size ||
    Object.keys(value).some((key) => !PARAMETER_FIELDS.has(key))
  )
    return;
  if (
    !strings(value.ratios) ||
    !strings(value.resolutions) ||
    !strings(value.audioSettings) ||
    !durations(value.durations) ||
    !durations(value.referenceDurations)
  )
    return;
  for (const name of [
    'generateAudio',
    'watermark',
    'offPeak',
    'requiresResolution',
    'referenceAudioRequiresVisual',
  ])
    if (typeof value[name] !== 'boolean') return;
  for (const name of [
    'maxImages',
    'maxVideos',
    'maxAudios',
    'maxInputs',
    'maxSubjects',
    'maxSubjectImages',
  ])
    if (!Number.isSafeInteger(value[name]) || Number(value[name]) < 0 || Number(value[name]) > 50)
      return;
  if (
    !Number.isSafeInteger(value.maxPromptCodepoints) ||
    Number(value.maxPromptCodepoints) < 1 ||
    Number(value.maxPromptCodepoints) > 5000 ||
    Number(value.maxInputs) > 16 ||
    Number(value.maxImages) > Number(value.maxInputs) ||
    Number(value.maxVideos) > Number(value.maxInputs) ||
    Number(value.maxAudios) > Number(value.maxInputs) ||
    (value.requiresResolution && value.resolutions.length === 0) ||
    (value.offPeak && !value.generateAudio)
  )
    return;
  return structuredClone(value) as unknown as VideoParameterSpec;
}

function queryPath(driver: VideoDriver, path: string): string {
  if (driver === 'volcengine-ark-videos')
    return '/volc/api/v3/contents/generations/tasks/{task_id}';
  if (driver === 'kling-videos') return `${path}/{task_id}`;
  if (driver === 'vidu-videos') return '/vidu/ent/v2/tasks/{task_id}/creations';
  if (driver === 'veo-videos') return '/v1beta/operations/{task_id}';
  return '/happyhorse/v1/tasks/{task_id}';
}

export function validateVideoRouteConfig(value: {
  driver: unknown;
  vendor: unknown;
  submitPath: unknown;
  editPath: unknown;
  queryPathTemplate: unknown;
  paramSpec: unknown;
  requestDefaults: unknown;
  outputSpec: unknown;
}): VideoRouteConfig | undefined {
  if (
    typeof value.driver !== 'string' ||
    !VIDEO_DRIVERS.includes(value.driver as VideoDriver) ||
    !isSafeRouteIdentifier(value.vendor)
  )
    return;
  const driver = value.driver as VideoDriver;
  if (
    typeof value.submitPath !== 'string' ||
    !SUBMIT_PATHS[driver].includes(value.submitPath) ||
    (value.editPath !== undefined && value.editPath !== null) ||
    value.queryPathTemplate !== queryPath(driver, value.submitPath)
  )
    return;
  if (
    !object(value.paramSpec) ||
    Object.keys(value.paramSpec).some((key) => key !== 'supportedModes' && key !== 'parameters')
  )
    return;
  const modes = value.paramSpec.supportedModes;
  if (
    !Array.isArray(modes) ||
    modes.length < 1 ||
    modes.length > VIDEO_MODES.length ||
    modes.some((mode) => !VIDEO_MODES.includes(mode as VideoMode) || mode === 'multiframe') ||
    new Set(modes).size !== modes.length
  )
    return;
  const parameters =
    value.paramSpec.parameters === undefined
      ? undefined
      : parameterSpec(value.paramSpec.parameters);
  if (value.paramSpec.parameters !== undefined && !parameters) return;
  const defaults = value.requestDefaults ?? {};
  const output = value.outputSpec ?? {};
  if (
    !object(defaults) ||
    Object.keys(defaults).length ||
    !object(output) ||
    Object.keys(output).length
  )
    return;
  return {
    driver,
    vendor: value.vendor,
    submitPath: value.submitPath,
    queryPathTemplate: value.queryPathTemplate as string,
    paramSpec: { supportedModes: [...modes] as VideoMode[], ...(parameters ? { parameters } : {}) },
    requestDefaults: {},
    outputSpec: {},
  };
}

/** Legacy declarations without complete limits remain discoverable, but cannot admit requests. */
export function videoRouteRuntimeAvailable(route: VideoRouteConfig): boolean {
  return (
    VIDEO_RUNTIME_SUPPORTED_DRIVERS.has(route.driver) && route.paramSpec.parameters !== undefined
  );
}

/** Project only the parameters that validation accepts for this exact mode. */
export function videoModeParameters(
  route: VideoRouteConfig,
  mode: VideoMode,
): Record<string, unknown> | undefined {
  const parameters = route.paramSpec.parameters;
  if (!parameters) return undefined;
  const result: Record<string, unknown> = { ...parameters };
  if (route.driver === 'vidu-videos' && mode !== 'text_to_video') delete result.ratios;
  return result;
}

export function validateVideoParameters(
  input: VideoRequestParameters,
  route: VideoRouteConfig,
): boolean {
  const spec = route.paramSpec.parameters;
  if (!spec || !route.paramSpec.supportedModes.includes(input.mode)) return false;
  if (Array.from(input.prompt).length > spec.maxPromptCodepoints) return false;
  if (
    input.ratio !== undefined &&
    (!spec.ratios.includes(input.ratio) ||
      (route.driver === 'vidu-videos' && input.mode !== 'text_to_video'))
  )
    return false;
  if (input.resolution !== undefined && !spec.resolutions.includes(input.resolution)) return false;
  if (spec.requiresResolution && input.resolution === undefined) return false;
  if (input.durationSeconds !== undefined && !spec.durations.includes(input.durationSeconds))
    return false;
  if (input.generateAudio !== undefined && !spec.generateAudio) return false;
  if (input.watermark !== undefined && !spec.watermark) return false;
  if (
    input.audioType !== undefined ||
    input.multiShot !== undefined ||
    input.shots?.length ||
    input.multiframeSegments?.length
  )
    return false;
  if (input.audioSetting !== undefined && !spec.audioSettings.includes(input.audioSetting))
    return false;
  if (
    input.offPeak !== undefined &&
    (!spec.offPeak || (input.offPeak && input.generateAudio !== true))
  )
    return false;
  const refs = input.references ?? [];
  let images = Number(Boolean(input.firstFrame)) + Number(Boolean(input.lastFrame));
  let videos = 0;
  let audios = 0;
  for (const ref of refs) {
    const media = ref.mediaType ?? 'image';
    if (ref.role !== undefined && ref.role !== `reference_${media}`) return false;
    if (media === 'image') images++;
    else if (media === 'video') videos++;
    else audios++;
  }
  const subjects = input.subjects ?? [];
  if (
    subjects.length > spec.maxSubjects ||
    subjects.some((subject) => subject.images.length > spec.maxSubjectImages)
  )
    return false;
  if (
    route.driver === 'vidu-videos' &&
    subjects.some((subject) => !input.prompt.includes(`[@${subject.name}]`))
  )
    return false;
  images += subjects.reduce((count, subject) => count + subject.images.length, 0);
  if (
    images > spec.maxImages ||
    videos > spec.maxVideos ||
    audios > spec.maxAudios ||
    images + videos + audios > spec.maxInputs
  )
    return false;
  if (spec.referenceAudioRequiresVisual && audios > 0 && images + videos === 0) return false;
  if (
    images + videos + audios > 0 &&
    input.durationSeconds !== undefined &&
    spec.referenceDurations.length > 0 &&
    !spec.referenceDurations.includes(input.durationSeconds)
  )
    return false;
  return true;
}
