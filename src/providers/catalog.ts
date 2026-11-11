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
export function legacyReference(ref: string): { usage: Category; id: string } | null {
  const match = /^onelink:(chat|image|video|voice|music):(.+)$/.exec(ref);
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
    throw new ProviderError(400, 'ADAPTATION_INVALID');
  const entry = value as Record<string, unknown>;
  if (
    Object.keys(entry).some(
      (key) =>
        ![
          'modelRef',
          'operation',
          'profile',
          'source',
          'sourceVersion',
          'metadata',
          'classification',
        ].includes(key),
    ) ||
    typeof entry.modelRef !== 'string' ||
    entry.operation !== 'chat' ||
    typeof entry.profile !== 'string' ||
    !['openai-chat', 'anthropic-messages'].includes(entry.profile) ||
    [entry.source, entry.sourceVersion].some(
      (item) => typeof item !== 'string' || !item.trim() || item.length > 512,
    )
  )
    throw new ProviderError(400, 'ADAPTATION_INVALID');
  if (entry.classification !== undefined && !categories.includes(entry.classification as Category))
    throw new ProviderError(400, 'ADAPTATION_INVALID');
  if (entry.metadata !== undefined) {
    if (!entry.metadata || typeof entry.metadata !== 'object' || Array.isArray(entry.metadata))
      throw new ProviderError(400, 'ADAPTATION_INVALID');
    const metadata = entry.metadata as Record<string, unknown>;
    if (
      Object.keys(metadata).some((key) => key !== 'contextWindow') ||
      ('contextWindow' in metadata &&
        (!Number.isSafeInteger(metadata.contextWindow) || Number(metadata.contextWindow) < 1))
    )
      throw new ProviderError(400, 'ADAPTATION_INVALID');
  }
  return entry as unknown as AdaptationDeclaration;
}
export function chatAdaptation(
  adaptations: AdaptationRecord[],
  key: string,
): AdaptationRecord | undefined {
  return adaptations.find((entry) => entry.model_key === key && entry.operation === 'chat');
}
/** O(models + adaptations + preferences); no supplier I/O, decryption or product model list. */
export function catalogView(state: ProviderState | null, category?: Category) {
  const byModel = new Map((state?.adaptations ?? []).map((item) => [item.model_key, item]));
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
      const reason =
        membershipError(state!, model) ??
        (!adaptation ? 'ADAPTER_PENDING' : chat?.enabled === false ? 'MODEL_DISABLED' : null);
      return {
        modelRef: modelReference(model.model_key),
        modelKey: model.model_key,
        modelId: model.raw_model_id,
        name: model.raw_model_id,
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
        adaptation: adaptation
          ? {
              operation: adaptation.operation,
              profile: adaptation.profile,
              implementation: 'implemented',
              declarationVersion: adaptation.declaration_version,
              source: adaptation.source,
              sourceVersion: adaptation.source_version,
              metadata: adaptation.capability_metadata,
              verification: {
                status: adaptation.verification_status,
                at: adaptation.verified_at,
                evidence: adaptation.verification_evidence,
                testedTuple: adaptation.tested_tuple,
              },
            }
          : null,
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
