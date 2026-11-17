import { categories } from './contracts.ts';
import type {
  Category,
  ModelRecord,
  ModelPreference,
  PlatformRouteRecord,
  VerificationRecord,
} from './contracts.ts';
import type { ProviderRow, ProviderState } from './state.ts';
import { providerView } from './state.ts';
import { resolveChatRoute, resolveImageRoute, resolveVerificationView } from './onelink/router.ts';
import type { ResolvedChatRoute, ResolvedImageRoute } from './onelink/router.ts';

export const modelReference = (key: string) => `onelink:model:${key}`;

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

export function resolveEffectiveChat(
  state: ProviderState,
  model: ModelRecord,
): ResolvedChatRoute | undefined {
  if (!model.raw_model_id) return undefined;
  const route = (state.routes ?? []).find(
    (item) => item.raw_model_id === model.raw_model_id && item.operation === 'chat',
  );
  return route ? resolveChatRoute(route) : undefined;
}

export function indexEffectiveImageRoutes(
  routes: readonly PlatformRouteRecord[] | undefined,
): Map<string, ResolvedImageRoute> {
  const byRawId = new Map<string, ResolvedImageRoute>();
  for (const route of routes ?? []) {
    if (route.operation !== 'image.generate') continue;
    const resolved = resolveImageRoute(route);
    if (resolved) byRawId.set(route.raw_model_id, resolved);
  }
  return byRawId;
}

export function resolveEffectiveImage(
  state: ProviderState,
  model: ModelRecord,
  indexed?: ReadonlyMap<string, ResolvedImageRoute>,
): ResolvedImageRoute | undefined {
  if (!model.raw_model_id) return undefined;
  if (indexed) return indexed.get(model.raw_model_id);
  const route = (state.routes ?? []).find(
    (item) => item.raw_model_id === model.raw_model_id && item.operation === 'image.generate',
  );
  return route ? resolveImageRoute(route) : undefined;
}

function buildAdaptationView(
  state: ProviderState,
  verifications: ReadonlyMap<string, VerificationRecord>,
  modelKey: string,
  route: ResolvedChatRoute | ResolvedImageRoute | undefined,
) {
  if (!route) return null;
  const verification = resolveVerificationView({
    verification: verifications.get(`${modelKey}\0${route.operation}`),
    operation: route.operation,
    declarationVersion: route.declarationVersion,
    profile: route.profile,
    credentialVersion: state.credential_version,
    catalogVersion: state.catalog_version,
  });
  return {
    operation: route.operation,
    vendor: route.vendor,
    profile: route.profile,
    implementation: 'implemented' as const,
    declarationVersion: route.declarationVersion,
    source: route.source,
    sourceKind: route.sourceKind,
    sourceVersion: route.sourceVersion,
    metadata: route.capabilityMetadata,
    verification,
  };
}

/** O(models + routes + preferences + verifications); no supplier I/O, decryption or bundled product model list. */
export function catalogView(state: ProviderState | null, category?: Category) {
  const chatByRawId = new Map<string, ResolvedChatRoute>();
  const imageByRawId = indexEffectiveImageRoutes(state?.routes);
  for (const route of state?.routes ?? []) {
    if (route.operation === 'chat') {
      const resolved = resolveChatRoute(route);
      if (resolved) chatByRawId.set(route.raw_model_id, resolved);
    }
  }
  const prefs = new Map<string, ModelPreference[]>();
  for (const item of state?.preferences ?? []) {
    const list = prefs.get(item.model_key) ?? [];
    list.push(item);
    prefs.set(item.model_key, list);
  }
  const verifications = new Map<string, VerificationRecord>();
  for (const item of state?.verifications ?? []) {
    verifications.set(`${item.model_key}\0${item.operation}`, item);
  }

  const effectiveChatByKey = new Map<string, ResolvedChatRoute>();
  for (const model of state?.models ?? []) {
    const resolved = model.raw_model_id ? chatByRawId.get(model.raw_model_id) : undefined;
    if (resolved) effectiveChatByKey.set(model.model_key, resolved);
  }

  const items = (state?.models ?? [])
    .map((model) => {
      const chatRoute = model.raw_model_id ? chatByRawId.get(model.raw_model_id) : undefined;
      const imageRoute = model.raw_model_id ? imageByRawId.get(model.raw_model_id) : undefined;
      const matchedRoute = chatRoute ?? imageRoute;
      const effectiveCategory = model.classification ?? matchedRoute?.classification ?? null;
      const effectiveClassificationSource = model.classification
        ? model.classification_source
        : matchedRoute
          ? `route:${matchedRoute.source}@${matchedRoute.sourceVersion}`
          : model.classification_source;
      return { model, chatRoute, imageRoute, effectiveCategory, effectiveClassificationSource };
    })
    .filter((entry) => !category || entry.effectiveCategory === category)
    .map(({ model, chatRoute, imageRoute, effectiveCategory, effectiveClassificationSource }) => {
      const preferences = (prefs.get(model.model_key) ?? []).map((pref) => ({
        usage: pref.usage,
        enabled: pref.enabled,
        isDefault: pref.is_default,
        effectiveDefault:
          pref.is_default &&
          pref.enabled &&
          !membershipError(state!, model) &&
          pref.usage === 'chat' &&
          !!chatRoute,
      }));
      const chat = preferences.find((pref) => pref.usage === 'chat');
      const image = preferences.find((pref) => pref.usage === 'image');
      const imageReason =
        membershipError(state!, model) ??
        (!imageRoute || !imageRoute.asyncReady
          ? 'ADAPTER_PENDING'
          : image?.enabled === false
            ? 'MODEL_DISABLED'
            : null);
      const reason =
        membershipError(state!, model) ??
        (!chatRoute ? 'ADAPTER_PENDING' : chat?.enabled === false ? 'MODEL_DISABLED' : null);
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
        category: effectiveCategory,
        classificationSource: effectiveClassificationSource,
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
        adaptation: buildAdaptationView(state!, verifications, model.model_key, chatRoute),
        image: {
          adaptation: buildAdaptationView(state!, verifications, model.model_key, imageRoute),
          enabled: image?.enabled ?? true,
          runnable: imageReason === null,
          unavailableReason: imageReason,
        },
        preferences,
        enabled: chat?.enabled ?? true,
        isDefault: chat?.isDefault ?? false,
        protocol: chatRoute?.profile ?? null,
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
              : !effectiveChatByKey.has(preference.model_key)
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
