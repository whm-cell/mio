import { isUuidV4 } from '@mio/foundation/identifiers';
import { VoiceError } from '../audio/voices/contracts.ts';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import type { AudioAdmission, AudioOperation } from '../audio/contracts.ts';
import { createVoiceService } from '../audio/voices/service.ts';
import { catalogMembershipError, modelReference } from './catalog.ts';
import { resolveProviderAudioRouteDefinition, selectAudioModel } from './audio-admission.ts';
import type { AudioRouteOperation } from './audio-admission.ts';
import { ProviderError } from './contracts.ts';
import type { ProviderPrincipal } from './contracts.ts';
import type { ProviderConfig } from './config.ts';
import { decryptCredentialSnapshot, serializeCredentialSnapshot } from './credentials.ts';
import { AUDIO_ROUTES } from './onelink/audio.ts';
import { resolveVerificationView } from './onelink/router.ts';
import { VOICE_OPERATION } from './onelink/voices.ts';
import type { ProviderState } from './state.ts';
import type { ProviderStore } from './store.ts';

function listModels(state: ProviderState, operation: AudioRouteOperation, whitelist: boolean) {
  const models = new Map(state.models.map((model) => [model.raw_model_id, model]));
  const catalog = new Map(state.catalog_models?.map((item) => [item.raw_model_id, item]));
  const unselected = new Set(
    state.preferences.filter((p) => p.usage === 'voice' && !p.enabled).map((p) => p.model_key),
  );
  const verifications = new Map(
    state.verifications?.filter((v) => v.operation === operation).map((v) => [v.model_key, v]),
  );
  return (state.routes ?? []).flatMap((route) => {
    if (route.operation !== operation) return [];
    const model = models.get(route.raw_model_id);
    const platformModel = catalog.get(route.raw_model_id);
    if (
      !model ||
      unselected.has(model.model_key) ||
      catalogMembershipError(state, model, platformModel, whitelist, false)
    )
      return [];
    const adaptation = resolveProviderAudioRouteDefinition(route, operation);
    if (!adaptation) return [];
    return [
      {
        item: {
          modelRef: modelReference(model.model_key),
          modelId: route.raw_model_id,
          name: model.display_name ?? platformModel?.display_label ?? route.raw_model_id,
        },
        adaptation,
        verification: resolveVerificationView({
          verification: verifications.get(model.model_key),
          operation,
          declarationVersion: adaptation.declarationVersion,
          profile: adaptation.profile,
          credentialVersion: state.credential_version,
          catalogVersion: state.catalog_version,
        }),
      },
    ];
  });
}

export function createProviderAudioService(
  store: ProviderStore,
  config: ProviderConfig,
  assertOpen: () => void,
) {
  const whitelist = Boolean(config.catalogWhitelist);
  async function currentState(owner: string, includeVerifications = true, modelRef?: string) {
    assertOpen();
    const state =
      modelRef === undefined
        ? await store.state(owner, includeVerifications)
        : await store.modelState(owner, modelRef);
    assertOpen();
    return state;
  }
  return {
    voices: createVoiceService(store.voices),
    audioStore: store.audio,
    async listVoiceModels(actor: Pick<ProviderPrincipal, 'userId'>) {
      const state = await currentState(actor.userId);
      if (!state) return [];
      const generating = new Set(
        listModels(state, 'audio.tts', whitelist).map(({ item }) => item.modelId),
      );
      return listModels(state, VOICE_OPERATION, whitelist).map(
        ({ item, adaptation, verification }) => ({
          ...item,
          voice: {
            enabled: true,
            runnable: true,
            unavailableReason: null,
            generationAvailable: generating.has(item.modelId),
            adaptation: {
              operation: adaptation.operation,
              profile: adaptation.profile,
              vendor: 'minimax',
              implementation: 'implemented' as const,
              declarationVersion: adaptation.declarationVersion,
              source: adaptation.source,
              sourceKind: adaptation.sourceKind,
              sourceVersion: adaptation.sourceVersion,
              metadata: {},
              verification,
            },
          },
        }),
      );
    },
    async listAudioModels(actor: Pick<ProviderPrincipal, 'userId'>, operation: AudioOperation) {
      const state = await currentState(actor.userId);
      return state
        ? listModels(state, AUDIO_ROUTES[operation].operation, whitelist).flatMap(
            ({ item, adaptation, verification }) =>
              'capabilities' in adaptation
                ? [{ ...item, parameters: adaptation.capabilities, verification }]
                : [],
          )
        : [];
    },
    async snapshotAudio(
      actor: Pick<ProviderPrincipal, 'userId'>,
      modelRef: string,
      operation: AudioOperation,
    ): Promise<AudioAdmission> {
      const state = await currentState(actor.userId, false, modelRef);
      if (!state) throw new ProviderError(HTTP_STATUS.NOT_FOUND, 'PROVIDER_NOT_CONFIGURED');
      const { model, adaptation } = selectAudioModel(state, modelRef, operation, whitelist);
      return {
        ...serializeCredentialSnapshot(state),
        modelRef: modelReference(model.model_key),
        modelId: model.raw_model_id!,
        modelKey: model.model_key,
        operation,
        profile: adaptation.profile,
        catalogVersion: state.catalog_version!,
        adaptationVersion: adaptation.declarationVersion,
        submitPath: adaptation.submitPath,
        capabilities: adaptation.capabilities,
      };
    },
    resolveAudioVoice(ownerId: string, voiceRef: string, admission: AudioAdmission) {
      assertOpen();
      if (admission.operation !== 'tts' || !admission.modelKey || !isUuidV4(voiceRef))
        throw new VoiceError(HTTP_STATUS.NOT_FOUND, 'VOICE_NOT_FOUND');
      return store.voices.owned(ownerId, voiceRef, admission);
    },
    openAudioSnapshot(ownerId: string, snapshot: AudioAdmission) {
      assertOpen();
      return decryptCredentialSnapshot(ownerId, snapshot, config);
    },
    async recordAudioVerification(ownerId: string, snapshot: AudioAdmission, evidence: string) {
      assertOpen();
      if (!snapshot.modelKey || !snapshot.profile) return;
      await store.recordVerification(
        ownerId,
        {
          providerConfigId: snapshot.providerConfigId,
          credentialVersion: snapshot.credentialVersion,
          catalogVersion: snapshot.catalogVersion,
          adaptationVersion: snapshot.adaptationVersion,
          modelKey: snapshot.modelKey,
          operation: AUDIO_ROUTES[snapshot.operation].operation,
          profile: snapshot.profile,
        },
        evidence,
      );
    },
  };
}
