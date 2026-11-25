import { HTTP_STATUS } from '@mio/foundation/http-status';
import type { AudioOperation } from '../audio/contracts.ts';
import { findModel, membershipError } from './catalog.ts';
import { ProviderError } from './contracts.ts';
import type { ModelRecord, PlatformRouteRecord } from './contracts.ts';
import { AUDIO_ROUTES, resolveAudioRoute } from './onelink/audio.ts';
import { resolveVoiceRoute, VOICE_OPERATION } from './onelink/voices.ts';
import type { ProviderState } from './state.ts';

export type AudioRouteOperation =
  (typeof AUDIO_ROUTES)[AudioOperation]['operation'] | typeof VOICE_OPERATION;

export function resolveProviderAudioRouteDefinition(
  route: PlatformRouteRecord,
  operation: AudioRouteOperation,
) {
  switch (operation) {
    case VOICE_OPERATION:
      return resolveVoiceRoute(route);
    case 'audio.tts':
      return resolveAudioRoute(route, 'tts');
    case 'audio.clone':
      return resolveAudioRoute(route, 'clone');
  }
}

export function resolveProviderAudioRoute(
  state: ProviderState,
  model: ModelRecord,
  operation: AudioRouteOperation,
  whitelist: boolean,
) {
  if (
    membershipError(state, model, whitelist, false) ||
    state.preferences.some(
      (p) => p.model_key === model.model_key && p.usage === 'voice' && !p.enabled,
    )
  )
    return undefined;
  const route = state.routes?.find(
    (r) => r.raw_model_id === model.raw_model_id && r.operation === operation,
  );
  return route && resolveProviderAudioRouteDefinition(route, operation);
}

export function selectAudioModel(
  state: ProviderState,
  ref: string,
  operation: AudioOperation,
  whitelist: boolean,
) {
  const model = findModel(state.models, ref);
  const reason = membershipError(state, model, whitelist, false);
  if (reason) throw new ProviderError(HTTP_STATUS.CONFLICT, reason);
  if (
    state.preferences.some(
      (p) => p.model_key === model!.model_key && p.usage === 'voice' && !p.enabled,
    )
  )
    throw new ProviderError(HTTP_STATUS.CONFLICT, 'MODEL_DISABLED');
  const route = state.routes?.find(
    (r) =>
      r.raw_model_id === model!.raw_model_id && r.operation === AUDIO_ROUTES[operation].operation,
  );
  const adaptation = route && resolveAudioRoute(route, operation);
  if (!adaptation) throw new ProviderError(HTTP_STATUS.CONFLICT, 'AUDIO_OPERATION_UNAVAILABLE');
  return { model: model!, adaptation };
}
