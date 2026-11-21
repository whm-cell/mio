import { HTTP_STATUS } from '@mio/foundation/http-status';
import { utcISOString } from '@mio/foundation/time';
import { ProviderError, categories } from './contracts.ts';
import type {
  Category,
  Discovery,
  ProviderPrincipal,
  ChatSelection,
  ChatRuntimeSnapshot,
  ImageRuntimeSnapshot,
  ImageAdmissionSnapshot,
  VerificationSnapshot,
  AccountCredentialSnapshot,
} from './contracts.ts';
import type { ProviderConfig } from './config.ts';
import type { ProviderStore, SettingsPatch, ModelPatch } from './store.ts';
import { decryptCredential, encryptMaterialAuth, decryptMaterialAuth } from './credentials.ts';
import {
  catalogView,
  findModel,
  indexEffectiveImageRoutes,
  membershipError,
  resolveEffectiveChat,
  resolveEffectiveImage,
  modelReference,
  legacyReference,
} from './catalog.ts';
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
  const chatState = async (actor: ProviderPrincipal, modelRef?: string) => {
    assertOpen();
    const row = await store.state(actor.userId, false);
    assertOpen();
    if (!row) throw new ProviderError(HTTP_STATUS.NOT_FOUND, 'PROVIDER_NOT_CONFIGURED');
    const preference = row.preferences.find((pref) => pref.usage === 'chat' && pref.is_default);
    const ref = modelRef ?? (preference && modelReference(preference.model_key));
    const model = ref ? findModel(row.models, ref) : undefined;
    const reason = membershipError(row, model);
    // Auth and snapshot errors remain distinguishable even when selecting a default.
    if (reason && !['MODEL_NOT_FOUND', 'MODEL_REMOVED'].includes(reason))
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
    const reason = membershipError(row, model);
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
  const snapshotImage = async (
    actor: Pick<ProviderPrincipal, 'userId'>,
    modelRef: string,
  ): Promise<ImageAdmissionSnapshot> => {
    const { row, model, adaptation } = await imageState(actor, modelRef);
    return {
      modelId: model.raw_model_id!,
      modelKey: model.model_key,
      vendor: adaptation.vendor,
      profile: adaptation.profile,
      route: adaptation.route,
      defaultImageWatermark: row.default_image_watermark,
      capabilityMetadata: adaptation.capabilityMetadata,
      providerRevision: row.revision,
      providerConfigId: row.id,
      credentialVersion: row.credential_version,
      catalogVersion: row.catalog_version!,
      adaptationVersion: adaptation.declarationVersion,
      credential: {
        cipherFormat: row.cipher_format,
        masterKeyId: row.master_key_id,
        nonce: row.nonce.toString('base64'),
        ciphertext: row.ciphertext.toString('base64'),
        authTag: row.auth_tag.toString('base64'),
      },
    };
  };
  const openImageSnapshot = (ownerId: string, snapshot: ImageAdmissionSnapshot): string =>
    decryptCredential(
      {
        cipher_format: snapshot.credential.cipherFormat,
        master_key_id: snapshot.credential.masterKeyId,
        nonce: Buffer.from(snapshot.credential.nonce, 'base64'),
        ciphertext: Buffer.from(snapshot.credential.ciphertext, 'base64'),
        auth_tag: Buffer.from(snapshot.credential.authTag, 'base64'),
      },
      {
        ownerId,
        providerId: snapshot.providerConfigId,
        credentialVersion: snapshot.credentialVersion,
      },
      config,
    );
  return {
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
      return {
        providerConfigId: row.id,
        credentialVersion: row.credential_version,
        credential: {
          cipherFormat: row.cipher_format,
          masterKeyId: row.master_key_id,
          nonce: row.nonce.toString('base64'),
          ciphertext: row.ciphertext.toString('base64'),
          authTag: row.auth_tag.toString('base64'),
        },
      };
    },
    openAccountSnapshot(ownerId: string, snapshot: AccountCredentialSnapshot): string {
      assertOpen();
      return decryptCredential(
        {
          cipher_format: snapshot.credential.cipherFormat,
          master_key_id: snapshot.credential.masterKeyId,
          nonce: Buffer.from(snapshot.credential.nonce, 'base64'),
          ciphertext: Buffer.from(snapshot.credential.ciphertext, 'base64'),
          auth_tag: Buffer.from(snapshot.credential.authTag, 'base64'),
        },
        {
          ownerId,
          providerId: snapshot.providerConfigId,
          credentialVersion: snapshot.credentialVersion,
        },
        config,
      );
    },
    snapshotImage,
    openImageSnapshot(ownerId: string, snapshot: ImageAdmissionSnapshot) {
      assertOpen();
      return openImageSnapshot(ownerId, snapshot);
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
      const providerReason = membershipError(row, undefined);
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
        if (membershipError(row, model) !== null || disabledKeys.has(model.model_key)) continue;
        const adaptation = resolveEffectiveImage(row, model, indexedRoutes);
        if (!adaptation || !adaptation.asyncReady) continue;
        const { paramSpec, requestDefaults, requiresAsync } = adaptation.route;
        models.push({
          modelRef: modelReference(model.model_key),
          modelId: model.raw_model_id!,
          name: model.display_name ?? model.raw_model_id!,
          vendor: adaptation.vendor,
          driver: adaptation.profile,
          supportedOperations: [...paramSpec.supportedOperations],
          requiresAsync,
          maxN: paramSpec.maxN,
          allowExplicitN: paramSpec.allowExplicitN !== false,
          allowedSizes: paramSpec.allowedSizes ? [...paramSpec.allowedSizes] : null,
          defaultSize: requestDefaults.defaultSize ?? null,
          allowCustomDimensions: paramSpec.allowCustomDimensions,
          allowedAspectRatios: [...paramSpec.allowedAspectRatios],
          maxReferenceImages: paramSpec.maxReferenceImages,
          allowGenerateReferences: paramSpec.allowGenerateReferences,
          allowMaskPng: paramSpec.allowMaskPng,
          allowedQualities: [...paramSpec.allowedQualities],
          allowedBackgrounds: [...paramSpec.allowedBackgrounds],
          allowedOutputFormats: [...paramSpec.allowedOutputFormats],
        });
      }
      return models;
    },
    async resolveImage(
      actor: { readonly userId: string; readonly sessionId?: string },
      modelRef: string,
    ): Promise<ImageRuntimeSnapshot> {
      const frozen = await snapshotImage(actor, modelRef);
      const { credential: _credential, ...snapshot } = frozen;
      void _credential;
      return { ...snapshot, apiKey: openImageSnapshot(actor.userId, frozen) };
    },
    async selectChat(actor: ProviderPrincipal, modelRef?: string): Promise<ChatSelection> {
      return (await chatState(actor, modelRef)).selection;
    },
    async resolveChat(
      actor: ProviderPrincipal,
      selected: ChatSelection,
    ): Promise<ChatRuntimeSnapshot> {
      const { row, selection, adaptation } = await chatState(actor, selected.modelRef);
      if (
        selection.providerConfigId !== selected.providerConfigId ||
        selection.modelId !== selected.modelId ||
        (selected.modelKey !== undefined && selected.modelKey !== selection.modelKey)
      )
        throw new ProviderError(HTTP_STATUS.CONFLICT, 'MODEL_NOT_FOUND');
      const apiKey = decryptCredential(
        row,
        { ownerId: actor.userId, providerId: row.id, credentialVersion: row.credential_version },
        config,
      );
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
      return catalogView(await store.state(actor.userId), category as Category | undefined);
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
          await Promise.allSettled([...active]);
          await store.close();
        })();
      }
      return closing;
    },
  };
}
export type ProviderService = ReturnType<typeof createProviderService>;
