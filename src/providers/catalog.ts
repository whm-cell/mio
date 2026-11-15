import { HTTP_STATUS } from '@mio/foundation/http-status';
import { IMAGE_GEOMETRY_EDGES, IMAGE_OPERATIONS, isImageProfile } from '@mio/compute-contracts';
import { ProviderError, categories } from './contracts.ts';
import type {
  Category,
  ModelRecord,
  ModelPreference,
  AdaptationRecord,
  AdaptationDeclaration,
} from './contracts.ts';
import type { ProviderRow, ProviderState } from './state.ts';
import { providerView } from './state.ts';

export const modelReference = (key: string) => `onelink:model:${key}`;
const membershipSources = new Set(['onelink-v1-models', 'legacy-complete-discovery']);
export function legacyReference(ref: string): { usage: Category; id: string } | null {
  const match = /^onelink:(chat|image|video|voice|music):(.+)$/s.exec(ref);
  return match ? { usage: match[1] as Category, id: match[2]! } : null;
}
export function findModel(models: ModelRecord[], ref: string): ModelRecord | undefined {
  const legacy = legacyReference(ref);
  return models.find((model) =>
    legacy
      ? model.raw_model_id === legacy.id
      : modelReference(model.model_key) === ref || model.legacy_ref === ref,
  );
}
export function membershipError(row: ProviderRow, model?: ModelRecord): string | null {
  if (!row.enabled) return 'PROVIDER_DISABLED';
  if (row.credential_auth_state === 'rejected') return 'PROVIDER_AUTH_REJECTED';
  if (row.catalog_version === null || row.catalog_credential_version !== row.credential_version)
    return 'MODEL_CATALOG_NOT_DISCOVERED';
  if (!model) return 'MODEL_NOT_FOUND';
  if (model.unavailable_reason) return model.unavailable_reason;
  if (
    model.membership_state !== 'current' ||
    model.credential_version !== row.credential_version ||
    model.catalog_version !== row.catalog_version
  )
    return 'MODEL_REMOVED';
  return null;
}
/** Deployment input is data selecting implemented profiles, never executable code or membership. */
export function validateDeclaration(value: unknown): AdaptationDeclaration {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
  const entry = value as Record<string, unknown>;
  if (
    Object.keys(entry).some(
      (key) =>
        ![
          'modelRef',
          'operation',
          'profile',
          'sourceKind',
          'source',
          'sourceVersion',
          'metadata',
          'classification',
        ].includes(key),
    ) ||
    typeof entry.modelRef !== 'string' ||
    typeof entry.profile !== 'string' ||
    !['protocol-reference', 'runtime-observation'].includes(String(entry.sourceKind)) ||
    !(
      (entry.operation === 'chat' &&
        ['openai-chat', 'anthropic-messages'].includes(String(entry.profile))) ||
      (entry.operation === 'image.generate' && isImageProfile(entry.profile))
    ) ||
    [entry.source, entry.sourceVersion].some(
      (item) => typeof item !== 'string' || !item.trim() || item.length > 512,
    ) ||
    membershipSources.has(String(entry.source))
  )
    throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
  if (entry.classification !== undefined && !categories.includes(entry.classification as Category))
    throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
  if (entry.metadata !== undefined) {
    if (!entry.metadata || typeof entry.metadata !== 'object' || Array.isArray(entry.metadata))
      throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
    const metadata = entry.metadata as Record<string, unknown>;
    if (
      Object.keys(metadata).some((key) => !['contextWindow', 'image'].includes(key)) ||
      ('contextWindow' in metadata &&
        (!Number.isSafeInteger(metadata.contextWindow) || Number(metadata.contextWindow) < 1))
    )
      throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
    if ('image' in metadata) {
      if (entry.operation !== 'image.generate' || !isImageProfile(entry.profile))
        throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
      const image = metadata.image;
      if (!image || typeof image !== 'object' || Array.isArray(image))
        throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
      const capability = image as Record<string, unknown>;
      if (
        Object.keys(capability).some(
          (key) => !['modes', 'mask', 'references', 'geometry', 'async'].includes(key),
        ) ||
        !Array.isArray(capability.modes) ||
        capability.modes.length < 1 ||
        !capability.modes.includes('generate') ||
        capability.modes.some(
          (mode) => typeof mode !== 'string' || !IMAGE_OPERATIONS.some((item) => item === mode),
        ) ||
        new Set(capability.modes).size !== capability.modes.length
      )
        throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
      if (capability.modes.includes('edit') && entry.profile !== 'gpt-images-v1')
        throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
      if (capability.modes.includes('outpaint') && entry.profile !== 'gpt-images-v1')
        throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
      if ('mask' in capability) {
        if (!capability.modes.includes('edit'))
          throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
        const mask = capability.mask;
        if (!mask || typeof mask !== 'object' || Array.isArray(mask))
          throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
        const value = mask as Record<string, unknown>;
        if (Object.keys(value).length !== 1 || value.format !== 'png')
          throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
      }
      if ('references' in capability) {
        const references = capability.references;
        if (
          !references ||
          typeof references !== 'object' ||
          Array.isArray(references) ||
          Object.keys(references).length !== 1 ||
          !Number.isSafeInteger((references as Record<string, unknown>).maxImages) ||
          Number((references as Record<string, unknown>).maxImages) < 2 ||
          Number((references as Record<string, unknown>).maxImages) > 16
        )
          throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
      }
      if ('geometry' in capability) {
        if (!capability.modes.includes('outpaint'))
          throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
        const geometry = capability.geometry;
        if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry))
          throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
        const value = geometry as Record<string, unknown>;
        if (
          Object.keys(value).length !== 2 ||
          value.unit !== 'pixels' ||
          !Array.isArray(value.edges) ||
          value.edges.length !== IMAGE_GEOMETRY_EDGES.length ||
          value.edges.some(
            (edge) =>
              typeof edge !== 'string' ||
              !IMAGE_GEOMETRY_EDGES.includes(edge as (typeof IMAGE_GEOMETRY_EDGES)[number]),
          ) ||
          new Set(value.edges).size !== value.edges.length
        )
          throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
      }
      if (capability.modes.includes('outpaint') && !('geometry' in capability))
        throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
      if ('async' in capability) {
        const asyncCapability = capability.async;
        if (
          !asyncCapability ||
          typeof asyncCapability !== 'object' ||
          Array.isArray(asyncCapability)
        )
          throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
        const value = asyncCapability as Record<string, unknown>;
        const modes = capability.modes as string[];
        if (
          Object.keys(value).length !== 3 ||
          !Array.isArray(value.operations) ||
          value.operations.length < 1 ||
          value.operations.some(
            (operation) =>
              typeof operation !== 'string' ||
              !IMAGE_OPERATIONS.includes(operation as (typeof IMAGE_OPERATIONS)[number]) ||
              !modes.includes(operation),
          ) ||
          new Set(value.operations).size !== value.operations.length ||
          !Number.isSafeInteger(value.maxQueries) ||
          Number(value.maxQueries) < 1 ||
          Number(value.maxQueries) > 16 ||
          !Number.isSafeInteger(value.maxAgeSeconds) ||
          Number(value.maxAgeSeconds) < 1 ||
          Number(value.maxAgeSeconds) > 86_400
        )
          throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ADAPTATION_INVALID');
      }
    }
  }
  return entry as unknown as AdaptationDeclaration;
}
export function chatAdaptation(
  adaptations: AdaptationRecord[],
  key: string,
):
  | (AdaptationRecord & { operation: 'chat'; profile: 'openai-chat' | 'anthropic-messages' })
  | undefined {
  return adaptations.find(
    (entry) =>
      entry.model_key === key &&
      entry.operation === 'chat' &&
      ['openai-chat', 'anthropic-messages'].includes(entry.profile),
  ) as
    | (AdaptationRecord & { operation: 'chat'; profile: 'openai-chat' | 'anthropic-messages' })
    | undefined;
}
function adaptationView(adaptation?: AdaptationRecord) {
  return adaptation
    ? {
        operation: adaptation.operation,
        profile: adaptation.profile,
        implementation: 'implemented',
        declarationVersion: adaptation.declaration_version,
        source: adaptation.source,
        sourceKind: adaptation.source_kind,
        sourceVersion: adaptation.source_version,
        metadata: adaptation.capability_metadata,
        verification: {
          status: adaptation.verification_status,
          at: adaptation.verified_at,
          evidence: adaptation.verification_evidence,
          testedTuple: adaptation.tested_tuple,
        },
      }
    : null;
}
/** O(models + adaptations + preferences); no supplier I/O, decryption or product model list. */
export function catalogView(state: ProviderState | null, category?: Category) {
  const byModel = new Map(
    (state?.adaptations ?? [])
      .filter((item) => item.operation === 'chat')
      .map((item) => [item.model_key, item]),
  );
  const imagesByModel = new Map(
    (state?.adaptations ?? [])
      .filter((item) => item.operation === 'image.generate' && isImageProfile(item.profile))
      .map((item) => [item.model_key, item]),
  );
  const prefs = new Map<string, ModelPreference[]>();
  for (const item of state?.preferences ?? []) {
    const list = prefs.get(item.model_key) ?? [];
    list.push(item);
    prefs.set(item.model_key, list);
  }
  const items = (state?.models ?? [])
    .filter((model) => !category || model.classification === category)
    .map((model) => {
      const adaptation = byModel.get(model.model_key);
      const preferences = (prefs.get(model.model_key) ?? []).map((pref) => ({
        usage: pref.usage,
        enabled: pref.enabled,
        isDefault: pref.is_default,
        effectiveDefault:
          pref.is_default &&
          pref.enabled &&
          !membershipError(state!, model) &&
          pref.usage === 'chat' &&
          !!adaptation,
      }));
      const chat = preferences.find((pref) => pref.usage === 'chat');
      const image = preferences.find((pref) => pref.usage === 'image');
      const imageAdaptation = imagesByModel.get(model.model_key);
      const imageAsyncReady =
        imageAdaptation?.profile !== 'vidu-image-v1' ||
        imageAdaptation.capability_metadata.image?.async?.operations.includes('generate');
      const imageReason =
        membershipError(state!, model) ??
        (!imageAdaptation || !imageAsyncReady
          ? 'ADAPTER_PENDING'
          : image?.enabled === false
            ? 'MODEL_DISABLED'
            : null);
      const reason =
        membershipError(state!, model) ??
        (!adaptation ? 'ADAPTER_PENDING' : chat?.enabled === false ? 'MODEL_DISABLED' : null);
      return {
        modelRef: modelReference(model.model_key),
        modelKey: model.model_key,
        modelId: model.raw_model_id,
        name: model.display_name ?? model.raw_model_id,
        description:
          model.description_override ??
          (typeof model.supplier_metadata.description === 'string'
            ? model.supplier_metadata.description
            : null),
        nameOverride: model.display_name,
        descriptionOverride: model.description_override,
        category: model.classification,
        classificationSource: model.classification_source,
        supplierMetadata: model.supplier_metadata,
        supplierMetadataSource: model.metadata_source,
        membership: model.membership_state,
        credentialVersion: model.credential_version,
        catalogVersion: model.catalog_version,
        firstSeenAt: model.first_seen_at,
        lastSeenAt: model.last_seen_at,
        legacyRef: model.legacy_ref,
        discovered:
          model.membership_state === 'current' &&
          model.credential_version === state!.credential_version &&
          model.catalog_version === state!.catalog_version,
        adaptation: adaptationView(adaptation),
        image: {
          adaptation: adaptationView(imageAdaptation),
          enabled: image?.enabled ?? true,
          runnable: imageReason === null,
          unavailableReason: imageReason,
        },
        preferences,
        enabled: chat?.enabled ?? true,
        isDefault: chat?.isDefault ?? false,
        protocol: adaptation?.profile ?? null,
        runnable: reason === null,
        unavailableReason: reason,
      };
    });
  return {
    provider: state ? providerView(state) : null,
    items,
    defaults: categories.map((usage) => {
      const preference = state?.preferences.find((pref) => pref.usage === usage && pref.is_default);
      const model =
        preference && state?.models.find((item) => item.model_key === preference.model_key);
      const reason = !preference
        ? 'MODEL_DEFAULT_NOT_SET'
        : (membershipError(state!, model) ??
          (!preference.enabled
            ? 'MODEL_DISABLED'
            : usage !== 'chat'
              ? 'MODEL_USAGE_UNSUPPORTED'
              : !byModel.has(preference.model_key)
                ? 'ADAPTER_PENDING'
                : null));
      return {
        usage,
        modelRef: preference ? modelReference(preference.model_key) : null,
        effective: reason === null,
        unavailableReason: reason,
      };
    }),
  };
}
