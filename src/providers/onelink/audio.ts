import { AUDIO_SAMPLE_BYTES, AUDIO_TEXT_BYTES, AUDIO_TEXT_POINTS } from '../../audio/contracts.ts';
import type { AudioCapabilities, AudioOperation, AudioRange } from '../../audio/contracts.ts';
import type { PlatformRouteRecord } from '../contracts.ts';
export const AUDIO_ROUTES = {
  tts: { operation: 'audio.tts', driver: 'minimax-tts', path: '/minimax/v1/t2a_v2' },
  clone: {
    operation: 'audio.clone',
    driver: 'minimax-clone',
    path: '/minimax/v1/t2a_pro/voice_clone',
  },
} as const;
function range(value: unknown, min: number, max: number, integral = false): value is AudioRange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as AudioRange;
  return (
    Object.keys(v).length === 3 &&
    ['min', 'max', 'default'].every(
      (key) =>
        typeof v[key as keyof AudioRange] === 'number' &&
        Number.isFinite(v[key as keyof AudioRange]),
    ) &&
    v.min >= min &&
    v.max <= max &&
    v.min <= v.default &&
    v.default <= v.max &&
    (!integral || [v.min, v.max, v.default].every(Number.isInteger))
  );
}
export function audioCapabilities(value: unknown): AudioCapabilities | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as AudioCapabilities;
  const keys = [
    'speed',
    'volume',
    'pitch',
    'formats',
    'defaultFormat',
    'textMaxCodePoints',
    'textMaxBytes',
    'sampleMaxBytes',
    'sampleMinSeconds',
    'sampleMaxSeconds',
  ];
  if (
    Object.keys(v).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(v, key)) ||
    !range(v.speed, 0.5, 2) ||
    !range(v.volume, 0.01, 10) ||
    !range(v.pitch, -12, 12, true) ||
    !Array.isArray(v.formats) ||
    !v.formats.length ||
    v.formats.some((f) => !['mp3', 'wav', 'flac'].includes(f)) ||
    new Set(v.formats).size !== v.formats.length ||
    !v.formats.includes(v.defaultFormat)
  )
    return;
  for (const [key, max] of [
    ['textMaxCodePoints', AUDIO_TEXT_POINTS],
    ['textMaxBytes', AUDIO_TEXT_BYTES],
    ['sampleMaxBytes', AUDIO_SAMPLE_BYTES],
  ] as const)
    if (!Number.isSafeInteger(v[key]) || v[key] < 1 || v[key] > max) return;
  if (
    !Number.isFinite(v.sampleMinSeconds) ||
    !Number.isFinite(v.sampleMaxSeconds) ||
    v.sampleMinSeconds < 10 ||
    v.sampleMaxSeconds > 300 ||
    v.sampleMinSeconds > v.sampleMaxSeconds
  )
    return;
  return structuredClone(v);
}
export function validAudioRoute(v: Record<string, unknown>): boolean {
  const spec = Object.values(AUDIO_ROUTES).find((r) => r.operation === v.operation);
  return (
    !!spec &&
    v.driver === spec.driver &&
    v.submitPath === spec.path &&
    v.vendor === 'minimax' &&
    v.classification === 'voice' &&
    (v.editPath === undefined || v.editPath === null) &&
    (v.queryPathTemplate === undefined || v.queryPathTemplate === null) &&
    ['requestDefaults', 'outputSpec', 'capabilityMetadata'].every(
      (key) =>
        v[key] === undefined ||
        (!!v[key] &&
          typeof v[key] === 'object' &&
          !Array.isArray(v[key]) &&
          Object.keys(v[key] as object).length === 0),
    ) &&
    !!audioCapabilities(v.paramSpec)
  );
}
export function resolveAudioRoute(row: PlatformRouteRecord, operation: AudioOperation) {
  if (
    !row.enabled ||
    row.operation !== AUDIO_ROUTES[operation].operation ||
    !validAudioRoute({
      operation: row.operation,
      driver: row.driver,
      vendor: row.vendor,
      classification: row.classification,
      submitPath: row.submit_path,
      editPath: row.edit_path,
      queryPathTemplate: row.query_path_template,
      paramSpec: row.param_spec,
      requestDefaults: row.request_defaults,
      outputSpec: row.output_spec,
      capabilityMetadata: row.capability_metadata,
    })
  )
    return;
  return {
    operation: AUDIO_ROUTES[operation].operation,
    profile: AUDIO_ROUTES[operation].driver,
    submitPath: row.submit_path,
    capabilities: audioCapabilities(row.param_spec)!,
    declarationVersion: row.declaration_version,
    source: row.source,
    sourceKind: row.source_kind,
    sourceVersion: row.source_version,
  };
}
