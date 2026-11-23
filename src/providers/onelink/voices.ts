import type { PlatformRouteRecord } from '../contracts.ts';

export const VOICE_OPERATION = 'audio.voices.list' as const;
export const VOICE_DRIVER = 'minimax-voices' as const;
export const VOICE_PATH = '/minimax/v1/get_voice' as const;

/** One implemented operation, independent of model name or discovery membership. */
export function validVoiceRoute(value: Record<string, unknown>): boolean {
  return (
    value.operation === VOICE_OPERATION &&
    value.driver === VOICE_DRIVER &&
    value.vendor === 'minimax' &&
    value.classification === 'voice' &&
    value.submitPath === VOICE_PATH &&
    (value.editPath === undefined || value.editPath === null) &&
    (value.queryPathTemplate === undefined || value.queryPathTemplate === null) &&
    ['paramSpec', 'requestDefaults', 'outputSpec', 'capabilityMetadata'].every((key) => {
      const item = value[key];
      return (
        item === undefined ||
        (item !== null &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          Object.keys(item).length === 0)
      );
    })
  );
}

export function resolveVoiceRoute(row: PlatformRouteRecord) {
  if (
    !row.enabled ||
    !validVoiceRoute({
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
    return undefined;
  return {
    operation: VOICE_OPERATION,
    profile: VOICE_DRIVER,
    vendor: 'minimax',
    classification: 'voice' as const,
    submitPath: VOICE_PATH,
    declarationVersion: row.declaration_version,
    source: row.source,
    sourceKind: row.source_kind,
    sourceVersion: row.source_version,
    capabilityMetadata: {},
  };
}
