export const IMAGE_OPERATIONS = ['generate', 'edit', 'outpaint'] as const;
export type ImageOperation = (typeof IMAGE_OPERATIONS)[number];

export const IMAGE_GEOMETRY_EDGES = ['left', 'top', 'right', 'bottom'] as const;
export type ImageGeometryEdge = (typeof IMAGE_GEOMETRY_EDGES)[number];

export interface ImageGeometry {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Immutable owner-scoped input snapshot carried to the isolated worker. */
export interface ImageAssetRef {
  assetId: string;
  key: string;
  sizeBytes: number;
  etag: string;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface ImageRequestParameters {
  prompt: string;
  async?: boolean;
  operation?: ImageOperation;
  imageAssetId?: string;
  imageAssetIds?: string[];
  maskAssetId?: string;
  geometry?: ImageGeometry;
  n?: number;
  background?: 'transparent' | 'opaque' | 'auto';
  moderation?: 'low' | 'auto';
  quality?: 'high' | 'medium' | 'low' | 'auto';
  size?: string;
  aspect_ratio?: string;
  output_format?: 'png' | 'jpeg' | 'webp';
  output_compression?: number;
  user?: string;
}

export interface ImageInput {
  model: string;
  prompt: string;
  async?: boolean;
  operation?: ImageOperation;
  image?: ImageAssetRef;
  images?: ImageAssetRef[];
  mask?: ImageAssetRef;
  geometry?: ImageGeometry;
  n?: number;
  background?: 'transparent' | 'opaque' | 'auto';
  moderation?: 'low' | 'auto';
  quality?: 'high' | 'medium' | 'low' | 'auto';
  size?: string;
  aspect_ratio?: string;
  output_format?: 'png' | 'jpeg' | 'webp';
  output_compression?: number;
  user?: string;
}

export const IMAGE_DRIVERS = [
  'openai-images',
  'volcengine-ark-images',
  'vidu-images',
  'kling-images',
] as const;
export type ImageDriver = (typeof IMAGE_DRIVERS)[number];

export function isImageDriver(value: unknown): value is ImageDriver {
  return typeof value === 'string' && IMAGE_DRIVERS.some((driver) => driver === value);
}

export const IMAGE_DRIVER_PATH_PREFIX = {
  'openai-images': '/v1/',
  'volcengine-ark-images': '/volc/',
  'vidu-images': '/vidu/',
  'kling-images': '/kling/',
} as const satisfies Record<ImageDriver, string>;

export function isSafeRouteIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value);
}

export interface ImageRouteAsyncSpec {
  readonly operations: readonly ImageOperation[];
  readonly maxQueries: number;
  readonly maxAgeSeconds: number;
}

export interface ImageRouteParamSpec {
  readonly supportedOperations: readonly ImageOperation[];
  readonly requiresAsync: boolean;
  readonly maxN: number;
  readonly allowExplicitN?: boolean;
  readonly allowedSizes: readonly string[] | null;
  readonly allowCustomDimensions: boolean;
  readonly maxReferenceImages: number;
  readonly allowGenerateReferences: boolean;
  readonly allowMaskPng: boolean;
  readonly allowOutpaintGeometry: boolean;
  readonly allowedQualities: readonly ('high' | 'medium' | 'low' | 'auto')[];
  readonly allowedBackgrounds: readonly ('transparent' | 'opaque' | 'auto')[];
  readonly allowedModerations: readonly ('low' | 'auto')[];
  readonly allowedOutputFormats: readonly ('png' | 'jpeg' | 'webp')[];
  readonly allowOutputCompression?: boolean;
  readonly allowUserField?: boolean;
  readonly allowedAspectRatios: readonly string[];
  readonly allowWatermarkOverride: boolean;
  readonly async: ImageRouteAsyncSpec | null;
}

export type KlingReferenceFormat = 'image' | 'image_list';

export interface ImageRouteRequestDefaults {
  readonly watermark?: boolean | null;
  readonly sequentialImageGeneration?: 'disabled' | 'auto' | null;
  readonly responseFormat?: 'b64_json' | 'url' | null;
  readonly stream?: boolean | null;
  readonly defaultSize?: string | null;
  readonly referenceFormat?: KlingReferenceFormat | null;
}

export interface ImageRouteOutputSpec {
  readonly fixedOutputFormat: 'png' | 'jpeg' | 'webp' | null;
}

export interface ImageRouteConfig {
  readonly driver: ImageDriver;
  readonly vendor: string;
  readonly submitPath: string;
  readonly editPath?: string | null;
  readonly queryPathTemplate?: string | null;
  readonly requiresAsync: boolean;
  readonly effectiveWatermark?: boolean | null;
  readonly paramSpec: ImageRouteParamSpec;
  readonly requestDefaults: ImageRouteRequestDefaults;
  readonly outputSpec: ImageRouteOutputSpec;
}

const routePathPattern = /^\/[A-Za-z0-9._/{}-]+$/;
const uuidText = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const uuidPattern = new RegExp(`^${uuidText}$`);
const derivedImageKeyPattern = new RegExp(
  `^mio/derived/${uuidText}/images/(?:[0-9]|1[0-5])-${uuidText}\\.(png|jpeg|webp)$`,
);

const routeFields = new Set([
  'driver',
  'vendor',
  'submitPath',
  'editPath',
  'queryPathTemplate',
  'requiresAsync',
  'effectiveWatermark',
  'paramSpec',
  'requestDefaults',
  'outputSpec',
]);

const paramSpecFields = new Set([
  'supportedOperations',
  'requiresAsync',
  'maxN',
  'allowExplicitN',
  'allowedSizes',
  'allowCustomDimensions',
  'maxReferenceImages',
  'allowGenerateReferences',
  'allowMaskPng',
  'allowOutpaintGeometry',
  'allowedQualities',
  'allowedBackgrounds',
  'allowedModerations',
  'allowedOutputFormats',
  'allowOutputCompression',
  'allowUserField',
  'allowedAspectRatios',
  'allowWatermarkOverride',
  'async',
]);

const requestDefaultFields = new Set([
  'watermark',
  'sequentialImageGeneration',
  'responseFormat',
  'stream',
  'defaultSize',
  'referenceFormat',
]);

export const IMAGE_INPUT_FIELDS = new Set([
  'model',
  'prompt',
  'async',
  'operation',
  'image',
  'images',
  'mask',
  'geometry',
  'n',
  'background',
  'moderation',
  'quality',
  'size',
  'aspect_ratio',
  'output_format',
  'output_compression',
  'user',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isValidImageRoutePath(
  path: unknown,
  driver: ImageDriver,
  template = false,
): path is string {
  if (typeof path !== 'string' || path.length < 2 || path.length > 256) return false;
  if (!routePathPattern.test(path) || path.includes('..') || path.includes('//')) return false;
  if (!path.startsWith(IMAGE_DRIVER_PATH_PREFIX[driver])) return false;
  if (!template) return !path.includes('{') && !path.includes('}');
  if (!path.includes('{task_id}')) return false;
  const stripped = path.replaceAll('{task_id}', 'task');
  return !stripped.includes('{') && !stripped.includes('}');
}

function validEnumList(value: unknown, allowed: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((item) => typeof item === 'string' && allowed.includes(item))
  );
}

function validTokenList(value: unknown, allowEmpty: boolean, maxItemLength = 64): boolean {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.length <= 32 &&
    new Set(value).size === value.length &&
    value.every(
      (item) =>
        typeof item === 'string' &&
        item.trim().length > 0 &&
        item.length <= maxItemLength &&
        !/[\x00-\x1f\x7f]/.test(item),
    )
  );
}

function validAsyncSpec(
  value: unknown,
  supportedOperations: readonly ImageOperation[],
): value is ImageRouteAsyncSpec {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.every((key) => ['operations', 'maxQueries', 'maxAgeSeconds'].includes(key))
  )
    return false;
  return (
    Array.isArray(value.operations) &&
    value.operations.length > 0 &&
    new Set(value.operations).size === value.operations.length &&
    value.operations.every(
      (op) => typeof op === 'string' && supportedOperations.includes(op as ImageOperation),
    ) &&
    Number.isInteger(value.maxQueries) &&
    Number(value.maxQueries) >= 1 &&
    Number(value.maxQueries) <= 16 &&
    Number.isInteger(value.maxAgeSeconds) &&
    Number(value.maxAgeSeconds) >= 1 &&
    Number(value.maxAgeSeconds) <= 86_400
  );
}

function validParamSpec(
  value: unknown,
  driver: ImageDriver,
  editPath: unknown,
  queryPathTemplate: unknown,
): value is ImageRouteParamSpec {
  if (!isRecord(value) || !hasOnlyFields(value, paramSpecFields)) return false;
  if (
    !validEnumList(value.supportedOperations, IMAGE_OPERATIONS) ||
    !(value.supportedOperations as string[]).includes('generate') ||
    typeof value.requiresAsync !== 'boolean' ||
    !Number.isInteger(value.maxN) ||
    Number(value.maxN) < 1 ||
    Number(value.maxN) > 16 ||
    (value.allowExplicitN !== undefined && typeof value.allowExplicitN !== 'boolean') ||
    (value.allowedSizes !== null && !validTokenList(value.allowedSizes, false)) ||
    typeof value.allowCustomDimensions !== 'boolean' ||
    !Number.isInteger(value.maxReferenceImages) ||
    Number(value.maxReferenceImages) < 0 ||
    Number(value.maxReferenceImages) > 16 ||
    typeof value.allowGenerateReferences !== 'boolean' ||
    typeof value.allowMaskPng !== 'boolean' ||
    typeof value.allowOutpaintGeometry !== 'boolean' ||
    !validEnumList(value.allowedQualities, ['high', 'medium', 'low', 'auto']) ||
    !validEnumList(value.allowedBackgrounds, ['transparent', 'opaque', 'auto']) ||
    !validEnumList(value.allowedModerations, ['low', 'auto']) ||
    !validEnumList(value.allowedOutputFormats, ['png', 'jpeg', 'webp']) ||
    (value.allowOutputCompression !== undefined &&
      typeof value.allowOutputCompression !== 'boolean') ||
    (value.allowUserField !== undefined && typeof value.allowUserField !== 'boolean') ||
    !validTokenList(value.allowedAspectRatios, true, 32) ||
    typeof value.allowWatermarkOverride !== 'boolean'
  )
    return false;

  const ops = value.supportedOperations as readonly ImageOperation[];
  const maxRef = Number(value.maxReferenceImages);
  if (value.allowGenerateReferences && maxRef < 1) return false;
  if ((ops.includes('edit') || ops.includes('outpaint')) && maxRef < 1) return false;
  if (ops.includes('outpaint') && !value.allowOutpaintGeometry) return false;
  if (
    driver === 'openai-images' &&
    (ops.includes('edit') || ops.includes('outpaint')) &&
    !isValidImageRoutePath(editPath, driver, false)
  )
    return false;
  if (value.async !== null && !validAsyncSpec(value.async, ops)) return false;
  if (value.requiresAsync && (value.async === null || typeof queryPathTemplate !== 'string'))
    return false;
  return true;
}

function validRequestDefaults(value: unknown): value is ImageRouteRequestDefaults {
  if (!isRecord(value) || !hasOnlyFields(value, requestDefaultFields)) return false;
  return (
    (value.watermark === undefined ||
      value.watermark === null ||
      typeof value.watermark === 'boolean') &&
    (value.sequentialImageGeneration === undefined ||
      value.sequentialImageGeneration === null ||
      value.sequentialImageGeneration === 'disabled' ||
      value.sequentialImageGeneration === 'auto') &&
    (value.responseFormat === undefined ||
      value.responseFormat === null ||
      value.responseFormat === 'b64_json' ||
      value.responseFormat === 'url') &&
    (value.stream === undefined || value.stream === null || typeof value.stream === 'boolean') &&
    (value.defaultSize === undefined ||
      value.defaultSize === null ||
      (typeof value.defaultSize === 'string' &&
        value.defaultSize.trim().length > 0 &&
        value.defaultSize.length <= 64 &&
        !/[\x00-\x1f\x7f]/.test(value.defaultSize))) &&
    (value.referenceFormat === undefined ||
      value.referenceFormat === null ||
      value.referenceFormat === 'image' ||
      value.referenceFormat === 'image_list')
  );
}

function validDriverRequestDefaults(
  driver: ImageDriver,
  paramSpec: ImageRouteParamSpec,
  requestDefaults: ImageRouteRequestDefaults,
): boolean {
  const format = requestDefaults.referenceFormat ?? null;
  if (driver !== 'kling-images') return format === null;
  if (paramSpec.maxReferenceImages > 0 && format === null) return false;
  if (format === 'image' && paramSpec.maxReferenceImages > 1) return false;
  return true;
}

function validOutputSpec(value: unknown): value is ImageRouteOutputSpec {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === 'fixedOutputFormat' &&
    (value.fixedOutputFormat === null ||
      ['png', 'jpeg', 'webp'].includes(String(value.fixedOutputFormat)))
  );
}

export function validateImageRouteConfig(value: unknown): value is ImageRouteConfig {
  if (!isRecord(value) || !hasOnlyFields(value, routeFields)) return false;
  if (!isImageDriver(value.driver) || !isSafeRouteIdentifier(value.vendor)) return false;
  if (!isValidImageRoutePath(value.submitPath, value.driver, false)) return false;
  if (
    value.editPath !== undefined &&
    value.editPath !== null &&
    !isValidImageRoutePath(value.editPath, value.driver, false)
  )
    return false;
  if (
    value.queryPathTemplate !== undefined &&
    value.queryPathTemplate !== null &&
    !isValidImageRoutePath(value.queryPathTemplate, value.driver, true)
  )
    return false;
  if (typeof value.requiresAsync !== 'boolean') return false;
  if (
    value.effectiveWatermark !== undefined &&
    value.effectiveWatermark !== null &&
    typeof value.effectiveWatermark !== 'boolean'
  )
    return false;
  return (
    validParamSpec(value.paramSpec, value.driver, value.editPath, value.queryPathTemplate) &&
    value.paramSpec.requiresAsync === value.requiresAsync &&
    validRequestDefaults(value.requestDefaults) &&
    validDriverRequestDefaults(value.driver, value.paramSpec, value.requestDefaults) &&
    validOutputSpec(value.outputSpec)
  );
}

export function isValidImageAssetObjectKey(
  assetId: string,
  key: string,
  contentType: string,
): boolean {
  if (!uuidPattern.test(assetId)) return false;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) return false;
  const rawPrefix = `mio/raw/${assetId}/`;
  if (key.startsWith(rawPrefix)) {
    return uuidPattern.test(key.slice(rawPrefix.length));
  }
  const derivedMatch = derivedImageKeyPattern.exec(key);
  return derivedMatch !== null && contentType === `image/${derivedMatch[1]}`;
}

function validImageAssetRef(value: unknown, mask = false): value is ImageAssetRef {
  if (!isRecord(value) || Object.keys(value).length !== 5) return false;
  return (
    typeof value.assetId === 'string' &&
    typeof value.key === 'string' &&
    typeof value.contentType === 'string' &&
    isValidImageAssetObjectKey(value.assetId, value.key, value.contentType) &&
    Number.isSafeInteger(value.sizeBytes) &&
    Number(value.sizeBytes) > 0 &&
    typeof value.etag === 'string' &&
    value.etag.length > 0 &&
    value.etag.length <= 256 &&
    !/[\x00-\x1f\x7f]/.test(value.etag) &&
    (!mask || value.contentType === 'image/png')
  );
}

function validImageGeometry(value: unknown): value is ImageGeometry {
  if (!isRecord(value) || Object.keys(value).length !== IMAGE_GEOMETRY_EDGES.length) return false;
  if (IMAGE_GEOMETRY_EDGES.some((edge) => !Object.hasOwn(value, edge))) return false;
  const values = IMAGE_GEOMETRY_EDGES.map((edge) => value[edge]);
  return (
    values.every((item) => Number.isSafeInteger(item) && Number(item) >= 0) &&
    values.some((item) => Number(item) > 0)
  );
}

function validCustomImageDimensions(size: string): boolean {
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(size);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return Boolean(
    width &&
    height &&
    width % 16 === 0 &&
    height % 16 === 0 &&
    width <= 3840 &&
    height <= 2160 &&
    width / height >= 1 / 3 &&
    width / height <= 3,
  );
}

export function validateImageInputByRoute(input: ImageInput, route: ImageRouteConfig): boolean {
  if (!validateImageRouteConfig(route)) return false;
  if (
    !isRecord(input) ||
    !hasOnlyFields(input as unknown as Record<string, unknown>, IMAGE_INPUT_FIELDS)
  )
    return false;
  if (
    typeof input.model !== 'string' ||
    !input.model.trim() ||
    input.model.length > 256 ||
    /[\x00-\x1f\x7f]/.test(input.model) ||
    typeof input.prompt !== 'string' ||
    !input.prompt.trim() ||
    input.prompt.length > 32_000
  )
    return false;
  if (input.async !== undefined && typeof input.async !== 'boolean') return false;
  const operation = input.operation ?? 'generate';
  const spec = route.paramSpec;
  if (!spec.supportedOperations.includes(operation)) return false;
  if (route.requiresAsync && input.async !== true) return false;
  if (!route.requiresAsync && input.async !== undefined) {
    if (spec.async === null) return false;
    if (input.async === true && !spec.async.operations.includes(operation)) return false;
  }
  if (input.image !== undefined && input.images !== undefined) return false;
  if (input.image !== undefined && !validImageAssetRef(input.image)) return false;
  if (
    input.images !== undefined &&
    (!Array.isArray(input.images) ||
      input.images.length < 1 ||
      input.images.some((item) => !validImageAssetRef(item)) ||
      new Set(input.images.map((item) => item.assetId)).size !== input.images.length)
  )
    return false;
  const refs = input.images ?? (input.image ? [input.image] : []);
  if (refs.length > spec.maxReferenceImages) return false;
  if (
    operation === 'generate' &&
    (input.image !== undefined ||
      input.mask !== undefined ||
      input.geometry !== undefined ||
      (!spec.allowGenerateReferences && refs.length > 0))
  )
    return false;
  if ((operation === 'edit' || operation === 'outpaint') && refs.length < 1) return false;
  if (
    input.mask !== undefined &&
    (operation === 'generate' || !spec.allowMaskPng || !validImageAssetRef(input.mask, true))
  )
    return false;
  if (
    operation === 'outpaint' &&
    (!spec.allowOutpaintGeometry ||
      input.geometry === undefined ||
      !validImageGeometry(input.geometry))
  )
    return false;
  if (operation !== 'outpaint' && input.geometry !== undefined) return false;
  if (
    input.n !== undefined &&
    (spec.allowExplicitN === false ||
      !Number.isInteger(input.n) ||
      input.n < 1 ||
      input.n > spec.maxN)
  )
    return false;
  if (input.size !== undefined) {
    if (typeof input.size !== 'string') return false;
    const inEnum = spec.allowedSizes !== null && spec.allowedSizes.includes(input.size);
    const inCustom = spec.allowCustomDimensions && validCustomImageDimensions(input.size);
    if (!inEnum && !inCustom) return false;
  }
  if (
    input.aspect_ratio !== undefined &&
    (typeof input.aspect_ratio !== 'string' ||
      !spec.allowedAspectRatios.includes(input.aspect_ratio))
  )
    return false;
  if (input.quality !== undefined && !spec.allowedQualities.includes(input.quality)) return false;
  if (input.background !== undefined && !spec.allowedBackgrounds.includes(input.background))
    return false;
  if (input.moderation !== undefined && !spec.allowedModerations.includes(input.moderation))
    return false;
  if (input.output_format !== undefined && !spec.allowedOutputFormats.includes(input.output_format))
    return false;
  if (input.background === 'transparent' && input.output_format === 'jpeg') return false;
  if (
    input.output_compression !== undefined &&
    (!spec.allowOutputCompression ||
      !Number.isInteger(input.output_compression) ||
      input.output_compression < 0 ||
      input.output_compression > 100 ||
      !['jpeg', 'webp'].includes(input.output_format ?? 'png'))
  )
    return false;
  return (
    input.user === undefined ||
    (Boolean(spec.allowUserField) &&
      typeof input.user === 'string' &&
      input.user.length <= 256 &&
      !/[\x00-\x1f\x7f]/.test(input.user))
  );
}

export function canonicalImageValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalImageValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalImageValue(item)]),
  );
}

export function canonicalImageRouteConfig(route: ImageRouteConfig): ImageRouteConfig {
  return canonicalImageValue(route) as ImageRouteConfig;
}
