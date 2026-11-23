import { createProviderAudioService } from './audio.ts';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { utcISOString } from '@mio/foundation/time';
import { ProviderError, categories, supportsChatReasoning } from './contracts.ts';
import type {
  Category,
  Discovery,
  ProviderPrincipal,
  ProviderOperation,
  ChatReasoningEffort,
  ChatSelection,
  ChatRuntimeSnapshot,
  ImageAdmissionSnapshot,
  RouteRevisionActor,
  VerificationSnapshot,
  AccountCredentialSnapshot,
} from './contracts.ts';
import type { ProviderConfig } from './config.ts';
import type { ProviderStore, SettingsPatch, ModelPatch } from './store.ts';
import {
  decryptCredential,
  decryptCredentialSnapshot,
  decryptMaterialAuth,
  encryptMaterialAuth,
  serializeCredentialSnapshot,
} from './credentials.ts';
import {
  catalogView,
  findCatalogModel,
  findModel,
  indexEffectiveImageRoutes,
  membershipError,
  resolveEffectiveChat,
  resolveEffectiveImage,
  modelReference,
  legacyReference,
} from './catalog.ts';
import { deriveImageParameterView } from './onelink/router.ts';
import { discoverModels, DiscoveryError } from '../integrations/onelink/models.ts';
import type { ModelTransport, DiscoveredModel } from '../integrations/onelink/models.ts';

/** Discovery is explicit; reads and model admission never issue a supplier request. */
export function createProviderService(
  store: ProviderStore,
  config: ProviderConfig,
  transport?: ModelTransport,
) {
  const cancellation = new AbortController();
  const active = new Set<Promise<Discovery>>();
  let closing: Promise<void> | undefined;
  const assertOpen = () => {
    if (cancellation.signal.aborted)
      throw new ProviderError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'PROVIDER_UNAVAILABLE');
  };
  const whitelist = Boolean(config.catalogWhitelist);
  const chatState = async (actor: ProviderPrincipal, modelRef?: string) => {
    assertOpen();
    const row = await store.state(actor.userId, false);
    assertOpen();
    if (!row) throw new ProviderError(HTTP_STATUS.NOT_FOUND, 'PROVIDER_NOT_CONFIGURED');
    const preference = row.preferences.find((pref) => pref.usage === 'chat' && pref.is_default);
    const ref = modelRef ?? (preference && modelReference(preference.model_key));
    const model = ref ? findModel(row.models, ref) : undefined;
    const reason = membershipError(row, model, whitelist);
    // Auth and snapshot errors remain distinguishable even when selecting a default.
    if (reason && !['MODEL_NOT_FOUND', 'MODEL_REMOVED', 'MODEL_HIDDEN'].includes(reason))
      throw new ProviderError(HTTP_STATUS.CONFLICT, reason);
    if (!ref) throw new ProviderError(HTTP_STATUS.CONFLICT, 'MODEL_DEFAULT_NOT_SET');
    if (reason)
      throw new ProviderError(HTTP_STATUS.CONFLICT, modelRef ? reason : 'MODEL_DEFAULT_INVALID');
    const adaptation = resolveEffectiveChat(row, model!);
    const enabled =
      row.preferences.find((pref) => pref.model_key === model!.model_key && pref.usage === 'chat')
        ?.enabled ?? true;
    if (!adaptation || !enabled)
      throw new ProviderError(
        HTTP_STATUS.CONFLICT,
        !modelRef ? 'MODEL_DEFAULT_INVALID' : !adaptation ? 'ADAPTER_PENDING' : 'MODEL_DISABLED',
      );
    const selection: ChatSelection = Object.freeze({
      providerConfigId: row.id,
      modelRef: modelReference(model!.model_key),
      modelKey: model!.model_key,
      modelId: model!.raw_model_id!,
      protocol: adaptation.profile,
    });
    return { row, selection, adaptation };
  };
  const boundChatState = async (actor: ProviderPrincipal, selected: ChatSelection) => {
    const state = await chatState(actor, selected.modelRef);
    const { selection } = state;
    if (
      selection.providerConfigId !== selected.providerConfigId ||
      selection.modelId !== selected.modelId ||
      (selected.modelKey !== undefined && selected.modelKey !== selection.modelKey)
    )
      throw new ProviderError(HTTP_STATUS.CONFLICT, 'MODEL_NOT_FOUND');
    return state;
  };
  const selectChatRoute = async (
    actor: ProviderPrincipal,
    modelRef?: string,
    reasoningEffort?: ChatReasoningEffort,
  ) => {
    const { selection, adaptation } = await chatState(actor, modelRef);
    if (
      reasoningEffort !== undefined &&
      !supportsChatReasoning(adaptation.capabilityMetadata.reasoning, reasoningEffort)
    )
      throw new ProviderError(HTTP_STATUS.CONFLICT, 'MODEL_REASONING_UNSUPPORTED');
    return { selection, inputModalities: adaptation.inputModalities };
  };
  const discover = async (actor: ProviderPrincipal): Promise<Discovery> => {
    const row = await store.beginRefresh(actor.userId);
    const result: Discovery = {
      credentialVersion: row.credential_version,
      refreshSeq: row.latest_refresh_seq,
      checkedAt: utcISOString(),
      scope: 'models-only',
      status: 'failed',
      ids: [],
      error: null,
    };
    let models: DiscoveredModel[] = [];
    let credentialFailure: ProviderError | undefined;
    try {
      assertOpen();
      const apiKey = decryptCredential(
        row,
        { ownerId: actor.userId, providerId: row.id, credentialVersion: row.credential_version },
        config,
      );
      models = await discoverModels(apiKey, transport, 10_000, cancellation.signal);
      result.ids = models.map((model) => model.id);
      result.status = 'connected';
    } catch (error) {
      result.error =
        error instanceof DiscoveryError || error instanceof ProviderError
          ? error.code
          : 'UPSTREAM_UNAVAILABLE';
      if (error instanceof ProviderError) credentialFailure = error;
    }
    result.checkedAt = utcISOString();
    await store.finishRefresh(actor.userId, row, result, models);
    if (credentialFailure) throw credentialFailure;
    return result;
  };
  const imageState = async (actor: Pick<ProviderPrincipal, 'userId'>, modelRef: string) => {
    assertOpen();
    const row = await store.state(actor.userId, false);
    assertOpen();
    if (!row) throw new ProviderError(HTTP_STATUS.NOT_FOUND, 'PROVIDER_NOT_CONFIGURED');
    const model = findModel(row.models, modelRef);
    const reason = membershipError(row, model, whitelist);
    if (reason) throw new ProviderError(HTTP_STATUS.CONFLICT, reason);
    const adaptation = resolveEffectiveImage(row, model!);
    if (!adaptation) throw new ProviderError(HTTP_STATUS.CONFLICT, 'ADAPTER_PENDING');
    if (
      row.preferences.some(
        (pref) => pref.model_key === model!.model_key && pref.usage === 'image' && !pref.enabled,
      )
    )
      throw new ProviderError(HTTP_STATUS.CONFLICT, 'MODEL_DISABLED');
    return { row, model: model!, adaptation };
  };
  const audio = createProviderAudioService(store, config, assertOpen);
  return {
    ...audio,
    sealMaterialAuth(
      ownerId: string,
      sessionId: string,
      payload: { launchUrl: string; token: string },
    ) {
      assertOpen();
      return encryptMaterialAuth(payload, ownerId, sessionId, config);
    },
    openMaterialAuth(
      ownerId: string,
      sessionId: string,
      envelope: Parameters<typeof decryptMaterialAuth>[0],
    ) {
      assertOpen();
      return decryptMaterialAuth(envelope, ownerId, sessionId, config);
    },
    async snapshotAccount(ownerId: string): Promise<AccountCredentialSnapshot> {
      assertOpen();
      const row = await store.current(ownerId);
      assertOpen();
      if (!row || !row.enabled || row.credential_auth_state === 'rejected')
        throw new ProviderError(HTTP_STATUS.CONFLICT, 'PROVIDER_UNAVAILABLE');
      return serializeCredentialSnapshot(row);
    },
    openAccountSnapshot(ownerId: string, snapshot: AccountCredentialSnapshot): string {
      assertOpen();
      return decryptCredentialSnapshot(ownerId, snapshot, config);
    },
    async snapshotImage(
      actor: Pick<ProviderPrincipal, 'userId'>,
      modelRef: string,
    ): Promise<ImageAdmissionSnapshot> {
      const { row, model, adaptation } = await imageState(actor, modelRef);
      return {
        ...serializeCredentialSnapshot(row),
        modelId: model.raw_model_id!,
        modelKey: model.model_key,
        vendor: adaptation.vendor,
        profile: adaptation.profile,
        route: adaptation.route,
        defaultImageWatermark: row.default_image_watermark,
        capabilityMetadata: adaptation.capabilityMetadata,
        providerRevision: row.revision,
        catalogVersion: row.catalog_version!,
        adaptationVersion: adaptation.declarationVersion,
      };
    },
    openImageSnapshot(ownerId: string, snapshot: ImageAdmissionSnapshot): string {
      assertOpen();
      return decryptCredentialSnapshot(ownerId, snapshot, config);
    },
    /** Resolve only the current owner's credential for an already admitted task. */
    async resolveImageTaskCredential(ownerId: string) {
      assertOpen();
      const row = await store.current(ownerId);
      assertOpen();
      if (!row) throw new ProviderError(HTTP_STATUS.NOT_FOUND, 'PROVIDER_NOT_CONFIGURED');
      return decryptCredential(
        row,
        { ownerId, providerId: row.id, credentialVersion: row.credential_version },
        config,
      );
    },
    async listImageModels(actor: Pick<ProviderPrincipal, 'userId'>) {
      assertOpen();
      const row = await store.state(actor.userId, false);
      assertOpen();
      if (!row) throw new ProviderError(HTTP_STATUS.NOT_FOUND, 'PROVIDER_NOT_CONFIGURED');
      const providerReason = membershipError(row, undefined, whitelist);
      if (providerReason && providerReason !== 'MODEL_NOT_FOUND')
        throw new ProviderError(HTTP_STATUS.CONFLICT, providerReason);
      const indexedRoutes = indexEffectiveImageRoutes(row.routes);
      const disabledKeys = new Set(
        row.preferences
          .filter((pref) => pref.usage === 'image' && !pref.enabled)
          .map((pref) => pref.model_key),
      );
      const models = [];
      for (const model of row.models) {
        if (membershipError(row, model, whitelist) !== null || disabledKeys.has(model.model_key))
          continue;
        const adaptation = resolveEffectiveImage(row, model, indexedRoutes);
        if (!adaptation || !adaptation.asyncReady) continue;
        const parameters = deriveImageParameterView(adaptation.route);
        models.push({
          modelRef: modelReference(model.model_key),
          modelId: model.raw_model_id!,
          name:
            model.display_name ??
            findCatalogModel(row.catalog_models, model.raw_model_id)?.display_label ??
            model.raw_model_id!,
          vendor: adaptation.vendor,
          driver: adaptation.profile,
          supportedOperations: parameters.supportedOperations,
          requiresAsync: parameters.requiresAsync,
          maxN: parameters.maxN,
          allowExplicitN: parameters.allowExplicitN,
          allowedSizes: parameters.allowedSizes,
          defaultSize: parameters.defaultSize,
          allowCustomDimensions: parameters.allowCustomDimensions,
          allowedAspectRatios: parameters.allowedAspectRatios,
          maxReferenceImages: parameters.maxReferenceImages,
          allowGenerateReferences: parameters.allowGenerateReferences,
          allowMaskPng: parameters.allowMaskPng,
          allowedQualities: parameters.allowedQualities,
          allowedBackgrounds: parameters.allowedBackgrounds,
          allowedOutputFormats: parameters.allowedOutputFormats,
        });
      }
      return models;
    },
    async selectChat(
      actor: ProviderPrincipal,
      modelRef?: string,
      reasoningEffort?: ChatReasoningEffort,
    ): Promise<ChatSelection> {
      return (await selectChatRoute(actor, modelRef, reasoningEffort)).selection;
    },
    selectChatRoute,
    async chatContextWindow(
      actor: ProviderPrincipal,
      selected: ChatSelection,
    ): Promise<number | null> {
      const { adaptation } = await boundChatState(actor, selected);
      return adaptation.contextWindow ?? null;
    },
    async resolveChat(
      actor: ProviderPrincipal,
      selected: ChatSelection,
    ): Promise<ChatRuntimeSnapshot> {
      const { row, selection, adaptation } = await boundChatState(actor, selected);
      const apiKey = decryptCredential(
        row,
        { ownerId: actor.userId, providerId: row.id, credentialVersion: row.credential_version },
        config,
      );
      const { cacheRetention, reasoning, streamIdleTimeoutMs } = adaptation.capabilityMetadata;
      const frozenReasoning =
        reasoning?.supported && reasoning.efforts
          ? Object.freeze({ ...reasoning, efforts: Object.freeze([...reasoning.efforts]) })
          : reasoning && Object.freeze({ ...reasoning });
      return Object.freeze({
        ...selection,
        modelKey: selection.modelKey!,
        providerRevision: row.revision,
        credentialVersion: row.credential_version,
        catalogVersion: row.catalog_version!,
        adaptationVersion: adaptation.declarationVersion,
        vendor: adaptation.vendor,
        operation: 'chat',
        profile: adaptation.profile,
        submitPath: adaptation.submitPath,
        maxOutputTokens: adaptation.maxOutputTokens,
        capabilityVersion: `onelink-text:${adaptation.declarationVersion}`,
        inputModalities: Object.freeze([...adaptation.inputModalities]),
        imageBudget: Object.freeze({ ...adaptation.imageBudget }),
        ...(adaptation.contextWindow ? { contextWindow: adaptation.contextWindow } : {}),
        ...(cacheRetention !== undefined ? { cacheRetention } : {}),
        ...(frozenReasoning !== undefined ? { reasoning: frozenReasoning } : {}),
        ...(streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs } : {}),
        apiKey,
      });
    },
    async recordVerification(
      actor: Pick<ProviderPrincipal, 'userId'>,
      snapshot: VerificationSnapshot,
      evidence: string,
    ) {
      assertOpen();
      await store.recordVerification(actor.userId, snapshot, evidence);
    },
    importRoutes(input: unknown, actor?: RouteRevisionActor) {
      assertOpen();
      return store.importRoutes(input, actor);
    },
    deleteRoutes(rawModelId: string, actor: RouteRevisionActor, operation?: ProviderOperation) {
      assertOpen();
      return store.deleteRoutes(rawModelId, actor, operation);
    },
    get(actor: ProviderPrincipal) {
      assertOpen();
      return store.get(actor.userId);
    },
    save(actor: ProviderPrincipal, expected: number, apiKey: string) {
      assertOpen();
      if (!apiKey || Buffer.byteLength(apiKey) > 4096 || /\s|[\u0000-\u001f\u007f*•]/.test(apiKey))
        throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'PROVIDER_KEY_INVALID');
      try {
        new Headers({ authorization: `Bearer ${apiKey}` });
      } catch {
        throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'PROVIDER_KEY_INVALID');
      }
      return store.save(actor.userId, expected, apiKey);
    },
    settings(actor: ProviderPrincipal, expected: number, patch: SettingsPatch) {
      assertOpen();
      return store.settings(actor.userId, expected, patch);
    },
    preference(actor: ProviderPrincipal, expected: number, modelRef: string, patch: ModelPatch) {
      assertOpen();
      const usage = patch.usage ?? legacyReference(modelRef)?.usage;
      if (('enabled' in patch || 'isDefault' in patch) && (!usage || !categories.includes(usage)))
        throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'MODEL_USAGE_REQUIRED');
      return store.preference(actor.userId, expected, modelRef, usage, patch);
    },
    async catalog(actor: ProviderPrincipal, category?: string) {
      assertOpen();
      if (category !== undefined && !categories.includes(category as Category))
        throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'QUERY_INVALID');
      return catalogView(
        await store.state(actor.userId),
        category as Category | undefined,
        whitelist,
      );
    },
    async discover(actor: ProviderPrincipal) {
      assertOpen();
      const action = discover(actor);
      active.add(action);
      try {
        return await action;
      } finally {
        active.delete(action);
      }
    },
    close() {
      if (!closing) {
        cancellation.abort();
        closing = (async () => {
          await Promise.allSettled([...active, audio.voices.close()]);
          await store.close();
        })();
      }
      return closing;
    },
  };
}
export type ProviderService = ReturnType<typeof createProviderService>;
