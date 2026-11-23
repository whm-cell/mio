import { HTTP_STATUS } from '@mio/foundation/http-status';
import {
  IMAGE_GEOMETRY_EDGES,
  canonicalImageRouteConfig,
  isImageDriver,
  isSafeRouteIdentifier,
  isValidImageRoutePath,
  validateImageRouteConfig,
} from '../../generations/contracts.ts';
import type {
  ImageDriver,
  ImageOperation,
  ImageRouteConfig,
  ImageRouteParamSpec,
} from '../../generations/contracts.ts';
import {
  CHAT_PROFILES,
  DEFAULT_CHAT_IMAGE_BUDGET,
  ProviderError,
  categories,
  isChatReasoningEffort,
} from '../contracts.ts';
import type {
  AdaptationCapabilityMetadata,
  AdaptationSourceKind,
  Category,
  ChatProfile,
  ChatReasoningCapability,
  ImageCapabilityMetadata,
  ImageParameterView,
  ChatImageBudget,
  PlatformRouteRecord,
  VerificationRecord,
} from '../contracts.ts';

const MEMBERSHIP_SOURCES = new Set(['onelink-v1-models', 'legacy-complete-discovery']);
const CHAT_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;

function isChatProfile(value: unknown): value is ChatProfile {
  return typeof value === 'string' && CHAT_PROFILES.some((item) => item === value);
}

function isValidChatSubmitPath(path: unknown, driver: ChatProfile): path is string {
  if (typeof path !== 'string' || path.length < 2 || path.length > 256) return false;
  if (!CHAT_PATH_PATTERN.test(path) || path.includes('..') || path.includes('//')) return false;
  if (driver === 'anthropic-messages') return path === '/v1/messages';
  return path.startsWith('/v1/') && path.endsWith('/chat/completions');
}

export function deriveImageCapabilityMetadata(
  paramSpec: ImageRouteParamSpec,
): ImageCapabilityMetadata {
  const modes: ImageOperation[] = [...paramSpec.supportedOperations];
  const hasRefs =
    paramSpec.maxReferenceImages >= 1 &&
    (paramSpec.allowGenerateReferences || modes.includes('edit') || modes.includes('outpaint'));
  return {
    modes,
    ...(paramSpec.allowMaskPng && modes.includes('edit')
      ? { mask: { format: 'png' as const } }
      : {}),
    ...(hasRefs ? { references: { maxImages: paramSpec.maxReferenceImages } } : {}),
    ...(paramSpec.allowOutpaintGeometry && modes.includes('outpaint')
      ? { geometry: { unit: 'pixels' as const, edges: [...IMAGE_GEOMETRY_EDGES] } }
      : {}),
    ...(paramSpec.async
      ? {
          async: {
            operations: [...paramSpec.async.operations],
            maxQueries: paramSpec.async.maxQueries,
            maxAgeSeconds: paramSpec.async.maxAgeSeconds,
          },
        }
      : {}),
  };
}

export function deriveImageParameterView(route: ImageRouteConfig): ImageParameterView {
  const { paramSpec, requestDefaults, outputSpec, requiresAsync } = route;
  return {
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
    allowOutpaintGeometry: paramSpec.allowOutpaintGeometry,
    allowedQualities: [...paramSpec.allowedQualities],
    allowedBackgrounds: [...paramSpec.allowedBackgrounds],
    allowedModerations: [...paramSpec.allowedModerations],
    allowedOutputFormats: [...paramSpec.allowedOutputFormats],
    fixedOutputFormat: outputSpec.fixedOutputFormat ?? null,
    allowOutputCompression: Boolean(paramSpec.allowOutputCompression),
    allowWatermarkOverride: paramSpec.allowWatermarkOverride,
    defaultWatermark: requestDefaults.watermark ?? null,
  };
}

export interface ValidatedModelRoute {
  readonly providerType: 'onelink';
  readonly rawModelId: string;
  readonly operation: 'chat' | 'image.generate';
  readonly vendor: string;
  readonly driver: ChatProfile | ImageDriver;
  readonly classification: Category;
  readonly submitPath: string;
  readonly editPath: string | null;
  readonly queryPathTemplate: string | null;
  readonly paramSpec: Record<string, unknown>;
  readonly requestDefaults: Record<string, unknown>;
  readonly outputSpec: Record<string, unknown>;
  readonly capabilityMetadata: AdaptationCapabilityMetadata;
  readonly sourceKind: AdaptationSourceKind;
  readonly source: string;
  readonly sourceVersion: string;
  readonly enabled: boolean;
}

const ROUTE_INPUT_FIELDS = new Set([
  'providerType',
  'rawModelId',
  'operation',
  'vendor',
  'driver',
  'classification',
  'submitPath',
  'editPath',
  'queryPathTemplate',
  'paramSpec',
  'requestDefaults',
  'outputSpec',
  'capabilityMetadata',
  'sourceKind',
  'source',
  'sourceVersion',
  'enabled',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidRoute(): never {
  throw new ProviderError(HTTP_STATUS.BAD_REQUEST, 'ROUTE_INVALID');
}

function validateChatReasoning(value: unknown): ChatReasoningCapability | undefined {
  if (value === undefined) return;
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => key !== 'supported' && key !== 'efforts')
  )
    invalidRoute();
  const { supported, efforts } = value;
  if (supported === false && efforts === undefined) return { supported: false };
  if (supported !== true) invalidRoute();
  if (efforts === undefined) return { supported };
  if (
    !Array.isArray(efforts) ||
    efforts.length === 0 ||
    efforts.length > 3 ||
    !efforts.every(isChatReasoningEffort) ||
    new Set(efforts).size !== efforts.length
  )
    invalidRoute();
  return { supported, efforts: [...efforts] };
}

function validateChatMetadata(value: unknown): AdaptationCapabilityMetadata {
  if (value === undefined) return {};
  if (!isPlainObject(value)) invalidRoute();
  for (const key of Object.keys(value)) {
    if (
      ![
        'contextWindow',
        'maxOutputTokens',
        'cacheRetention',
        'reasoning',
        'streamIdleTimeoutMs',
        'inputModalities',
        'maxRequestImages',
        'maxRequestImageBytes',
        'requestImagePixelBudget',
        'requestImageMaxBytes',
      ].includes(key)
    )
      invalidRoute();
  }
  if (
    'contextWindow' in value &&
    (!Number.isSafeInteger(value.contextWindow) || Number(value.contextWindow) < 1)
  )
    invalidRoute();
  if (
    'maxOutputTokens' in value &&
    (!Number.isSafeInteger(value.maxOutputTokens) ||
      Number(value.maxOutputTokens) < 1 ||
      Number(value.maxOutputTokens) > 65_536)
  )
    invalidRoute();
  const { cacheRetention } = value;
  if (
    cacheRetention !== undefined &&
    cacheRetention !== 'none' &&
    cacheRetention !== 'short' &&
    cacheRetention !== 'long'
  )
    invalidRoute();
  const reasoning = validateChatReasoning(value.reasoning);
  const { streamIdleTimeoutMs } = value;
  if (
    streamIdleTimeoutMs !== undefined &&
    (reasoning?.supported !== true ||
      typeof streamIdleTimeoutMs !== 'number' ||
      !Number.isSafeInteger(streamIdleTimeoutMs) ||
      streamIdleTimeoutMs < 1 ||
      streamIdleTimeoutMs > 120_000)
  )
    invalidRoute();
  if (
    value.inputModalities !== undefined &&
    (!Array.isArray(value.inputModalities) ||
      !value.inputModalities.includes('text') ||
      value.inputModalities.some((item: unknown) => item !== 'text' && item !== 'image') ||
      new Set(value.inputModalities).size !== value.inputModalities.length)
  )
    invalidRoute();
  for (const [key, maximum] of [
    ['maxRequestImages', 16],
    ['maxRequestImageBytes', 20 * 1024 * 1024],
    ['requestImagePixelBudget', 16_777_216],
    ['requestImageMaxBytes', 10 * 1024 * 1024],
  ] as const) {
    if (
      value[key] !== undefined &&
      (!Array.isArray(value.inputModalities) ||
        !value.inputModalities.includes('image') ||
        !Number.isSafeInteger(value[key]) ||
        Number(value[key]) < 1 ||
        Number(value[key]) > maximum)
    )
      invalidRoute();
  }
  return {
    ...(typeof value.contextWindow === 'number' ? { contextWindow: value.contextWindow } : {}),
    ...(typeof value.maxOutputTokens === 'number'
      ? { maxOutputTokens: value.maxOutputTokens }
      : {}),
    ...(cacheRetention !== undefined ? { cacheRetention } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs } : {}),
    ...(Array.isArray(value.inputModalities)
      ? { inputModalities: value.inputModalities.includes('image') ? ['text', 'image'] : ['text'] }
      : {}),
    ...(typeof value.maxRequestImages === 'number'
      ? { maxRequestImages: value.maxRequestImages }
      : {}),
    ...(typeof value.maxRequestImageBytes === 'number'
      ? { maxRequestImageBytes: value.maxRequestImageBytes }
      : {}),
    ...(typeof value.requestImagePixelBudget === 'number'
      ? { requestImagePixelBudget: value.requestImagePixelBudget }
      : {}),
    ...(typeof value.requestImageMaxBytes === 'number'
      ? { requestImageMaxBytes: value.requestImageMaxBytes }
      : {}),
  };
}

export function validateModelRouteEntry(value: unknown): ValidatedModelRoute {
  if (!isPlainObject(value)) invalidRoute();
  for (const key of Object.keys(value)) {
    if (!ROUTE_INPUT_FIELDS.has(key)) invalidRoute();
  }
  const providerType = value.providerType ?? 'onelink';
  if (providerType !== 'onelink') invalidRoute();
  const rawModelId = value.rawModelId;
  if (
    typeof rawModelId !== 'string' ||
    !rawModelId ||
    Buffer.byteLength(rawModelId, 'utf8') > 256 ||
    /[\x00-\x1f\x7f]/.test(rawModelId)
  )
    invalidRoute();
  if (!isSafeRouteIdentifier(value.vendor)) invalidRoute();
  if (!categories.includes(value.classification as Category)) invalidRoute();
  if (!['protocol-reference', 'runtime-observation'].includes(String(value.sourceKind)))
    invalidRoute();
  const source = typeof value.source === 'string' ? value.source.trim() : '';
  const sourceVersion = typeof value.sourceVersion === 'string' ? value.sourceVersion.trim() : '';
  if (
    !source ||
    source.length > 500 ||
    MEMBERSHIP_SOURCES.has(source) ||
    !sourceVersion ||
    sourceVersion.length > 200
  )
    invalidRoute();
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') invalidRoute();
  const enabled = value.enabled ?? true;

  if (value.operation === 'chat') {
    if (value.classification !== 'chat' || !isChatProfile(value.driver)) invalidRoute();
    if (!isValidChatSubmitPath(value.submitPath, value.driver)) invalidRoute();
    if (value.editPath !== undefined && value.editPath !== null) invalidRoute();
    if (value.queryPathTemplate !== undefined && value.queryPathTemplate !== null) invalidRoute();
    if (
      value.paramSpec !== undefined &&
      (!isPlainObject(value.paramSpec) || Object.keys(value.paramSpec).length > 0)
    )
      invalidRoute();
    if (
      value.requestDefaults !== undefined &&
      (!isPlainObject(value.requestDefaults) || Object.keys(value.requestDefaults).length > 0)
    )
      invalidRoute();
    if (
      value.outputSpec !== undefined &&
      (!isPlainObject(value.outputSpec) || Object.keys(value.outputSpec).length > 0)
    )
      invalidRoute();
    return {
      providerType: 'onelink',
      rawModelId,
      operation: 'chat',
      vendor: value.vendor,
      driver: value.driver,
      classification: 'chat',
      submitPath: value.submitPath,
      editPath: null,
      queryPathTemplate: null,
      paramSpec: {},
      requestDefaults: {},
      outputSpec: {},
      capabilityMetadata: validateChatMetadata(value.capabilityMetadata),
      sourceKind: value.sourceKind as AdaptationSourceKind,
      source,
      sourceVersion,
      enabled,
    };
  }

  if (value.operation !== 'image.generate' || value.classification !== 'image') invalidRoute();
  if (!isImageDriver(value.driver) || !isPlainObject(value.paramSpec)) invalidRoute();
  const editPath = value.editPath ?? null;
  const queryPathTemplate = value.queryPathTemplate ?? null;
  const requestDefaults = value.requestDefaults ?? {};
  const outputSpec = value.outputSpec ?? { fixedOutputFormat: null };
  const candidateRoute = {
    driver: value.driver,
    vendor: value.vendor,
    submitPath: value.submitPath,
    editPath,
    queryPathTemplate,
    requiresAsync: value.paramSpec.requiresAsync,
    paramSpec: value.paramSpec,
    requestDefaults,
    outputSpec,
  };
  if (!validateImageRouteConfig(candidateRoute)) invalidRoute();
  if (candidateRoute.driver === 'openai-images' && candidateRoute.paramSpec.allowGenerateReferences)
    invalidRoute();
  if (
    candidateRoute.paramSpec.async !== null &&
    !isValidImageRoutePath(queryPathTemplate, value.driver, true)
  )
    invalidRoute();
  if (value.capabilityMetadata !== undefined && !isPlainObject(value.capabilityMetadata))
    invalidRoute();
  if (
    value.capabilityMetadata !== undefined &&
    Object.keys(value.capabilityMetadata).some((key) => key !== 'image')
  )
    invalidRoute();
  const canonical = canonicalImageRouteConfig(candidateRoute);
  const derivedImage = deriveImageCapabilityMetadata(canonical.paramSpec);
  return {
    providerType: 'onelink',
    rawModelId,
    operation: 'image.generate',
    vendor: canonical.vendor,
    driver: canonical.driver,
    classification: 'image',
    submitPath: canonical.submitPath,
    editPath: canonical.editPath ?? null,
    queryPathTemplate: canonical.queryPathTemplate ?? null,
    paramSpec: canonical.paramSpec as unknown as Record<string, unknown>,
    requestDefaults: canonical.requestDefaults as unknown as Record<string, unknown>,
    outputSpec: canonical.outputSpec as unknown as Record<string, unknown>,
    capabilityMetadata: { image: derivedImage },
    sourceKind: value.sourceKind as AdaptationSourceKind,
    source,
    sourceVersion,
    enabled,
  };
}

export function validateRouteImportPayload(input: unknown): ValidatedModelRoute[] {
  const rawList = Array.isArray(input)
    ? input
    : isPlainObject(input) && Array.isArray(input.routes) && Object.keys(input).length === 1
      ? input.routes
      : isPlainObject(input)
        ? [input]
        : null;
  if (!rawList || rawList.length < 1 || rawList.length > 500) invalidRoute();
  const seen = new Set<string>();
  return rawList.map((item) => {
    const validated = validateModelRouteEntry(item);
    const key = `${validated.providerType}\0${validated.rawModelId}\0${validated.operation}`;
    if (seen.has(key)) invalidRoute();
    seen.add(key);
    return validated;
  });
}

function canonicalSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalSort(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonicalSort(v)]),
  );
}

export function canonicalRouteComparable(entry: ValidatedModelRoute | PlatformRouteRecord): string {
  const normalized =
    'rawModelId' in entry
      ? {
          providerType: entry.providerType,
          rawModelId: entry.rawModelId,
          operation: entry.operation,
          vendor: entry.vendor,
          driver: entry.driver,
          classification: entry.classification,
          submitPath: entry.submitPath,
          editPath: entry.editPath,
          queryPathTemplate: entry.queryPathTemplate,
          paramSpec: entry.paramSpec,
          requestDefaults: entry.requestDefaults,
          outputSpec: entry.outputSpec,
          capabilityMetadata: entry.capabilityMetadata,
          sourceKind: entry.sourceKind,
          source: entry.source,
          sourceVersion: entry.sourceVersion,
          enabled: entry.enabled,
        }
      : {
          providerType: entry.provider_type,
          rawModelId: entry.raw_model_id,
          operation: entry.operation,
          vendor: entry.vendor,
          driver: entry.driver,
          classification: entry.classification,
          submitPath: entry.submit_path,
          editPath: entry.edit_path,
          queryPathTemplate: entry.query_path_template,
          paramSpec: entry.param_spec,
          requestDefaults: entry.request_defaults,
          outputSpec: entry.output_spec,
          capabilityMetadata: entry.capability_metadata,
          sourceKind: entry.source_kind,
          source: entry.source,
          sourceVersion: entry.source_version,
          enabled: entry.enabled,
        };
  return JSON.stringify(canonicalSort(normalized));
}

export function serializeRouteInputSnapshot(
  entry: ValidatedModelRoute | PlatformRouteRecord,
): Record<string, unknown> {
  const isValidated = 'rawModelId' in entry;
  const operation = entry.operation;
  const base: Record<string, unknown> = {
    providerType: isValidated ? entry.providerType : entry.provider_type,
    rawModelId: isValidated ? entry.rawModelId : entry.raw_model_id,
    operation,
    vendor: entry.vendor,
    driver: entry.driver,
    classification: entry.classification,
    submitPath: isValidated ? entry.submitPath : entry.submit_path,
    sourceKind: isValidated ? entry.sourceKind : entry.source_kind,
    source: entry.source,
    sourceVersion: isValidated ? entry.sourceVersion : entry.source_version,
    enabled: entry.enabled,
  };
  if (operation === 'chat') {
    const capabilityMetadata = isValidated ? entry.capabilityMetadata : entry.capability_metadata;
    if (Object.keys(capabilityMetadata).length > 0) base.capabilityMetadata = capabilityMetadata;
    return canonicalSort(base) as Record<string, unknown>;
  }
  const editPath = isValidated ? entry.editPath : entry.edit_path;
  const queryPathTemplate = isValidated ? entry.queryPathTemplate : entry.query_path_template;
  if (editPath !== null) base.editPath = editPath;
  if (queryPathTemplate !== null) base.queryPathTemplate = queryPathTemplate;
  base.paramSpec = isValidated ? entry.paramSpec : entry.param_spec;
  base.requestDefaults = isValidated ? entry.requestDefaults : entry.request_defaults;
  base.outputSpec = isValidated ? entry.outputSpec : entry.output_spec;
  return canonicalSort(base) as Record<string, unknown>;
}

export interface ResolvedChatRoute {
  readonly operation: 'chat';
  readonly vendor: string;
  readonly profile: ChatProfile;
  readonly classification: Category;
  readonly submitPath: string;
  readonly maxOutputTokens: number;
  readonly contextWindow?: number;
  readonly inputModalities: readonly ('text' | 'image')[];
  readonly imageBudget: ChatImageBudget;
  readonly declarationVersion: number;
  readonly sourceKind: AdaptationSourceKind;
  readonly source: string;
  readonly sourceVersion: string;
  readonly capabilityMetadata: AdaptationCapabilityMetadata;
}

export interface ResolvedImageRoute {
  readonly operation: 'image.generate';
  readonly vendor: string;
  readonly profile: ImageDriver;
  readonly classification: Category;
  readonly route: ImageRouteConfig;
  readonly asyncReady: boolean;
  readonly declarationVersion: number;
  readonly sourceKind: AdaptationSourceKind;
  readonly source: string;
  readonly sourceVersion: string;
  readonly capabilityMetadata: AdaptationCapabilityMetadata;
}

export function resolveChatRoute(row: PlatformRouteRecord): ResolvedChatRoute | undefined {
  if (
    !row.enabled ||
    row.operation !== 'chat' ||
    !isSafeRouteIdentifier(row.vendor) ||
    !isChatProfile(row.driver) ||
    !isValidChatSubmitPath(row.submit_path, row.driver)
  )
    return undefined;
  let metadata: AdaptationCapabilityMetadata;
  try {
    metadata = validateChatMetadata(row.capability_metadata ?? {});
  } catch {
    return undefined;
  }
  const maxTokens = row.capability_metadata?.maxOutputTokens;
  const maxOutputTokens =
    typeof maxTokens === 'number' &&
    Number.isSafeInteger(maxTokens) &&
    maxTokens >= 1 &&
    maxTokens <= 65_536
      ? maxTokens
      : 1024;
  const contextWindow =
    typeof row.capability_metadata?.contextWindow === 'number' &&
    Number.isSafeInteger(row.capability_metadata.contextWindow) &&
    row.capability_metadata.contextWindow >= 1
      ? row.capability_metadata.contextWindow
      : undefined;
  return {
    operation: 'chat',
    vendor: row.vendor,
    profile: row.driver,
    classification: row.classification,
    submitPath: row.submit_path,
    maxOutputTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    inputModalities: metadata.inputModalities ?? ['text'],
    imageBudget: {
      maxRequestImages: metadata.maxRequestImages ?? DEFAULT_CHAT_IMAGE_BUDGET.maxRequestImages,
      maxRequestImageBytes:
        metadata.maxRequestImageBytes ?? DEFAULT_CHAT_IMAGE_BUDGET.maxRequestImageBytes,
      requestImagePixelBudget:
        metadata.requestImagePixelBudget ?? DEFAULT_CHAT_IMAGE_BUDGET.requestImagePixelBudget,
      requestImageMaxBytes:
        metadata.requestImageMaxBytes ?? DEFAULT_CHAT_IMAGE_BUDGET.requestImageMaxBytes,
    },
    declarationVersion: row.declaration_version,
    sourceKind: row.source_kind,
    source: row.source,
    sourceVersion: row.source_version,
    capabilityMetadata: metadata,
  };
}

export function resolveImageRoute(row: PlatformRouteRecord): ResolvedImageRoute | undefined {
  if (!row.enabled || row.operation !== 'image.generate' || !isImageDriver(row.driver))
    return undefined;
  const candidate = {
    driver: row.driver,
    vendor: row.vendor,
    submitPath: row.submit_path,
    editPath: row.edit_path,
    queryPathTemplate: row.query_path_template,
    requiresAsync: row.param_spec?.requiresAsync,
    paramSpec: row.param_spec,
    requestDefaults: row.request_defaults ?? {},
    outputSpec: row.output_spec ?? { fixedOutputFormat: null },
  };
  if (!validateImageRouteConfig(candidate)) return undefined;
  if (
    candidate.paramSpec.async !== null &&
    !isValidImageRoutePath(candidate.queryPathTemplate, row.driver, true)
  )
    return undefined;
  const legacyGenerateReferences =
    candidate.driver === 'openai-images' && candidate.paramSpec.allowGenerateReferences;
  const route = canonicalImageRouteConfig(
    legacyGenerateReferences
      ? { ...candidate, paramSpec: { ...candidate.paramSpec, allowGenerateReferences: false } }
      : candidate,
  );
  const storedImageCapability = legacyGenerateReferences
    ? undefined
    : row.capability_metadata?.image;
  const imageCapability = storedImageCapability ?? deriveImageCapabilityMetadata(route.paramSpec);
  const asyncReady =
    !route.requiresAsync || Boolean(imageCapability.async?.operations.includes('generate'));
  return {
    operation: 'image.generate',
    vendor: route.vendor,
    profile: row.driver,
    classification: row.classification,
    route,
    asyncReady,
    declarationVersion: row.declaration_version,
    sourceKind: row.source_kind,
    source: row.source,
    sourceVersion: row.source_version,
    capabilityMetadata: { ...row.capability_metadata, image: imageCapability },
  };
}

export function resolveVerificationView(options: {
  verification: VerificationRecord | undefined;
  operation: 'chat' | 'image.generate';
  declarationVersion: number;
  profile: string;
  credentialVersion: number;
  catalogVersion: number | null;
}) {
  const row = options.verification;
  if (!row) {
    return {
      status: 'unverified' as const,
      at: null,
      evidence: null,
      testedTuple: null,
    };
  }
  const tuple = row.tested_tuple;
  const matches =
    row.verification_status === 'verified' &&
    row.declaration_version === options.declarationVersion &&
    row.driver === options.profile &&
    options.catalogVersion !== null &&
    isPlainObject(tuple) &&
    tuple.credentialVersion === options.credentialVersion &&
    tuple.catalogVersion === options.catalogVersion &&
    tuple.adaptationVersion === options.declarationVersion &&
    tuple.operation === options.operation &&
    tuple.profile === options.profile;
  return {
    status: (matches ? 'verified' : 'unverified') as 'unverified' | 'verified',
    at: row.verified_at,
    evidence: row.verification_evidence,
    testedTuple: row.tested_tuple,
  };
}
