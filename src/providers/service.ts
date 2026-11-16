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
  VerificationSnapshot,
} from './contracts.ts';
import type { ProviderConfig } from './config.ts';
import type { ProviderStore, SettingsPatch, ModelPatch } from './store.ts';
import { decryptCredential } from './credentials.ts';
import {
  catalogView,
  findModel,
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
    const row = await store.state(actor.userId);
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
  return {
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
    async resolveImage(actor: ProviderPrincipal, modelRef: string): Promise<ImageRuntimeSnapshot> {
      assertOpen();
      const row = await store.state(actor.userId);
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
      return {
        modelId: model!.raw_model_id!,
        modelKey: model!.model_key,
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
        apiKey: decryptCredential(
          row,
          { ownerId: actor.userId, providerId: row.id, credentialVersion: row.credential_version },
          config,
        ),
      };
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
