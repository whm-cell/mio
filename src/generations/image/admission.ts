import { sha256Utf8 } from '@mio/foundation/hash';
import { createId, isUuidV4 } from '@mio/foundation/identifiers';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { epochMs } from '@mio/foundation/time';
import {
  IMAGE_GEOMETRY_EDGES,
  IMAGE_MAX_MESSAGE_BYTES,
  canonicalImageRouteConfig,
  canonicalImageValue,
  isImageDriver,
  isValidImageAssetObjectKey,
  imageReferencesWithinBudget,
  validImageGeometry,
  validateImageInputByRoute,
  validateImageRouteConfig,
} from './contracts.ts';
import type {
  ImageAssetRef,
  ImageGeometryEdge,
  ImageInput,
  ImageOperation,
  ImageRequestParameters,
} from './contracts.ts';
import { ProviderError } from '../../providers/contracts.ts';
import type { ImageAdmissionSnapshot } from '../../providers/contracts.ts';
import type { ProviderService } from '../../providers/service.ts';
import type { AssetObjectStore } from '../../assets/contracts.ts';
import type { GenerationRequest } from './execution.ts';
import type { GenerationStore, ImageInputAsset, ImageRequestRecord } from './store.ts';
import type { GenerationFiles } from './files.ts';
import { GenerationError } from '../errors.ts';

const parameterKinds = {
  prompt: 'string',
  async: 'boolean',
  operation: 'string',
  imageAssetId: 'string',
  imageAssetIds: 'assetIds',
  maskAssetId: 'string',
  geometry: 'geometry',
  n: 'number',
  background: 'string',
  moderation: 'string',
  quality: 'string',
  size: 'string',
  aspect_ratio: 'string',
  output_format: 'string',
  output_compression: 'number',
  user: 'string',
} as const satisfies Record<keyof ImageRequestParameters, string>;

function inputError(): never {
  throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
}

function validateRequest(requestId: string, modelRef: string, parameters: ImageRequestParameters) {
  if (
    !isUuidV4(requestId) ||
    typeof modelRef !== 'string' ||
    !parameters ||
    typeof parameters.prompt !== 'string' ||
    !parameters.prompt.trim() ||
    parameters.prompt.length > 32000
  )
    inputError();
  // Check the input shape before hashing. Routing and asset checks still run
  // only after looking for an already admitted request.
  let replayOnly = false;
  for (const [key, value] of Object.entries(parameters)) {
    if (!Object.hasOwn(parameterKinds, key)) inputError();
    if (value === undefined) continue;
    // Prior releases could save these null values in the request hash.
    if (
      value === null &&
      (key === 'operation' || (key === 'imageAssetIds' && parameters.operation === 'generate'))
    ) {
      replayOnly = true;
      continue;
    }
    const kind = parameterKinds[key as keyof ImageRequestParameters];
    if (kind === 'geometry') {
      if (!validImageGeometry(value)) inputError();
    } else if (kind === 'assetIds') {
      if (!Array.isArray(value) || value.some((id: unknown) => typeof id !== 'string'))
        inputError();
    } else if (typeof value !== kind) inputError();
  }
  return replayOnly;
}

function requestHash(modelRef: string, parameters: ImageRequestParameters): string {
  return sha256Utf8(JSON.stringify([modelRef, canonicalImageValue(parameters)]));
}

function geometryKeyOrders(edges: readonly ImageGeometryEdge[]): ImageGeometryEdge[][] {
  if (edges.length === 0) return [[]];
  return edges.flatMap((edge) =>
    geometryKeyOrders(edges.filter((other) => other !== edge)).map((rest) => [edge, ...rest]),
  );
}

const LEGACY_GEOMETRY_ORDERS = geometryKeyOrders(IMAGE_GEOMETRY_EDGES);

function matchesRequestHash(
  savedHash: string,
  modelRef: string,
  parameters: ImageRequestParameters,
  hash = requestHash(modelRef, parameters),
): boolean {
  if (savedHash === hash) return true;
  const { geometry } = parameters;
  if (geometry === undefined) return false;
  // Older hashes sorted only the top-level keys. Geometry has four keys and
  // is the only nested object in accepted inputs, so at most 24 orders can match.
  const normalized = canonicalImageValue(parameters) as ImageRequestParameters;
  return LEGACY_GEOMETRY_ORDERS.some((order) => {
    const ordered = Object.fromEntries(order.map((edge) => [edge, geometry[edge]]));
    return (
      savedHash === sha256Utf8(JSON.stringify([modelRef, { ...normalized, geometry: ordered }]))
    );
  });
}

function toolParameters(
  parameters: ImageRequestParameters,
  defaults: Pick<ImageRequestRecord, 'requiresAsync' | 'supportsEdit' | 'allowGenerateReferences'>,
): ImageRequestParameters {
  const async = parameters.async ?? (defaults.requiresAsync ? true : undefined);
  let operation = parameters.operation;
  if (operation === undefined) {
    if (parameters.maskAssetId !== undefined) operation = 'edit';
    else if (parameters.imageAssetIds?.length)
      operation = defaults.supportsEdit || !defaults.allowGenerateReferences ? 'edit' : 'generate';
  }
  return {
    ...parameters,
    ...(async !== undefined ? { async } : {}),
    ...(operation !== undefined ? { operation } : {}),
  };
}

function references(parameters: ImageRequestParameters) {
  const operation =
    parameters.operation ??
    (parameters.geometry !== undefined
      ? 'outpaint'
      : parameters.imageAssetId !== undefined ||
          parameters.imageAssetIds !== undefined ||
          parameters.maskAssetId !== undefined
        ? 'edit'
        : 'generate');
  if (
    (operation === 'generate' &&
      (parameters.maskAssetId !== undefined || parameters.geometry !== undefined)) ||
    ((operation === 'edit' || operation === 'outpaint') &&
      parameters.imageAssetId === undefined &&
      parameters.imageAssetIds === undefined) ||
    (operation === 'outpaint' && parameters.geometry === undefined) ||
    (operation !== 'outpaint' && parameters.geometry !== undefined) ||
    !['generate', 'edit', 'outpaint'].includes(operation) ||
    (parameters.imageAssetId !== undefined && parameters.imageAssetIds !== undefined) ||
    (parameters.maskAssetId !== undefined && !isUuidV4(parameters.maskAssetId))
  )
    inputError();
  const ids =
    parameters.imageAssetIds ??
    (parameters.imageAssetId !== undefined ? [parameters.imageAssetId] : []);
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string') ||
    new Set(ids).size !== ids.length ||
    ((operation === 'edit' || operation === 'outpaint') && ids.length < 1)
  )
    inputError();
  return { operation: operation as ImageOperation, ids };
}

function capability(
  snapshot: ImageAdmissionSnapshot,
  parameters: ImageRequestParameters,
  operation: ImageOperation,
  imageCount: number,
) {
  const route = snapshot.route;
  if (
    !isImageDriver(snapshot.profile) ||
    !validateImageRouteConfig(route) ||
    route.driver !== snapshot.profile
  )
    throw new ProviderError(HTTP_STATUS.CONFLICT, 'ADAPTER_PENDING');
  const image = snapshot.capabilityMetadata?.image;
  if (
    (operation === 'generate' &&
      imageCount > 0 &&
      (!route.paramSpec.allowGenerateReferences || !image?.references)) ||
    ((operation === 'edit' || operation === 'outpaint') &&
      (!route.paramSpec.supportedOperations.includes(operation) ||
        !image?.modes.includes(operation))) ||
    (imageCount > 0 &&
      (!image?.references ||
        imageCount > image.references.maxImages ||
        imageCount > route.paramSpec.maxReferenceImages)) ||
    (operation === 'outpaint' && (!image?.geometry || !route.paramSpec.allowOutpaintGeometry)) ||
    (parameters.async === true && (!image?.async || !image.async.operations.includes(operation))) ||
    (parameters.maskAssetId !== undefined && (!image?.mask || !route.paramSpec.allowMaskPng))
  )
    throw new GenerationError(HTTP_STATUS.CONFLICT, 'IMAGE_OPERATION_UNSUPPORTED');
  return canonicalImageRouteConfig({
    ...route,
    effectiveWatermark: route.paramSpec.allowWatermarkOverride
      ? (snapshot.defaultImageWatermark ?? route.requestDefaults.watermark ?? null)
      : (route.effectiveWatermark ?? route.requestDefaults.watermark ?? null),
  });
}

async function inputAsset(
  head: AssetObjectStore['head'],
  id: string,
  asset: ImageInputAsset | undefined,
  mask = false,
  signal?: AbortSignal,
): Promise<ImageAssetRef> {
  if (
    !asset ||
    !asset.raw_key.startsWith(
      asset.asset_kind === 'derived' ? 'mio/derived/' : 'mio/raw/' + id + '/',
    ) ||
    !isValidImageAssetObjectKey(id, asset.raw_key, asset.content_type) ||
    (mask && asset.content_type !== 'image/png')
  )
    throw new GenerationError(HTTP_STATUS.NOT_FOUND, 'ASSET_NOT_FOUND');
  const size = Number(asset.size_bytes);
  if (!Number.isSafeInteger(size) || size < 1)
    throw new GenerationError(HTTP_STATUS.CONFLICT, 'ASSET_SIZE_MISMATCH');
  let object: Awaited<ReturnType<AssetObjectStore['head']>>;
  try {
    object = await head(asset.raw_key, signal);
    signal?.throwIfAborted();
  } catch {
    throw new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_STORAGE_UNAVAILABLE');
  }
  if (
    !object ||
    object.size !== size ||
    !object.etag ||
    object.etag.length > 256 ||
    /[\x00-\x1f\x7f]/.test(object.etag)
  )
    throw new GenerationError(HTTP_STATUS.CONFLICT, 'ASSET_SIZE_MISMATCH');
  return {
    assetId: id,
    key: asset.raw_key,
    sizeBytes: size,
    etag: object.etag,
    contentType: asset.content_type as ImageAssetRef['contentType'],
  };
}

export function createGenerationAdmission(
  store: GenerationStore,
  files: GenerationFiles,
  head: AssetObjectStore['head'],
  provider: () => ProviderService | undefined,
) {
  return async (
    actor: { readonly userId: string; readonly sessionId?: string },
    requestId: string,
    modelRef: string,
    intent: ImageRequestParameters,
    tool?: { signal: AbortSignal },
  ) => {
    const replayOnly = validateRequest(requestId, modelRef, intent);
    tool?.signal.throwIfAborted();
    if (replayOnly && references(intent).ids.some((id) => !isUuidV4(id))) inputError();
    const httpHash = tool ? undefined : requestHash(modelRef, intent);
    // Tool retries use the winning job's defaults, including jobs admitted before this lookup.
    const existingRequest = {
      includeToolDefaults: Boolean(tool),
      matches(record: ImageRequestRecord) {
        const parameters = tool ? toolParameters(intent, record) : intent;
        return matchesRequestHash(record.input_hash, modelRef, parameters, httpHash);
      },
    };
    const replay = async () => {
      const previous = await store.imageRequest(
        actor.userId,
        requestId,
        existingRequest.includeToolDefaults,
      );
      tool?.signal.throwIfAborted();
      if (!previous) return;
      if (!existingRequest.matches(previous))
        throw new GenerationError(HTTP_STATUS.CONFLICT, 'REQUEST_CONFLICT');
      return store.imageGet(actor.userId, previous.id);
    };
    const previous = await replay();
    if (previous) return previous;
    if (replayOnly) inputError();
    try {
      if (await store.storageBlocked())
        throw new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_STORAGE_UNAVAILABLE');
      await files.admit();
      const providers = provider();
      if (!providers)
        throw new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'IMAGE_UNAVAILABLE');
      const httpReferences = tool ? undefined : references(intent);
      tool?.signal.throwIfAborted();
      const snapshot = await providers.snapshotImage(actor, modelRef);
      tool?.signal.throwIfAborted();
      const parameters = tool
        ? toolParameters(intent, {
            requiresAsync: snapshot.route.requiresAsync,
            supportsEdit: snapshot.route.paramSpec.supportedOperations.includes('edit'),
            allowGenerateReferences: snapshot.route.paramSpec.allowGenerateReferences,
          })
        : intent;
      const { operation, ids } = httpReferences ?? references(parameters);
      const route = capability(snapshot, parameters, operation, ids.length);
      // Apply the multipart restriction to new admissions. Frozen jobs retain their wire behavior.
      if (
        route.driver === 'openai-images' &&
        operation !== 'generate' &&
        parameters.aspect_ratio !== undefined
      )
        inputError();
      if (ids.some((id) => !isUuidV4(id))) inputError();
      const maskId = parameters.maskAssetId;
      const assetIds = maskId === undefined || ids.includes(maskId) ? ids : [...ids, maskId];
      const assets = await store.imageInputs(actor.userId, assetIds);
      const images = await Promise.all(
        ids.map((id) => inputAsset(head, id, assets.get(id), false, tool?.signal)),
      );
      const mask =
        maskId === undefined
          ? undefined
          : await inputAsset(head, maskId, assets.get(maskId), true, tool?.signal);
      const {
        imageAssetId,
        imageAssetIds: _imageAssetIds,
        maskAssetId: _maskAssetId,
        geometry,
        ...rest
      } = parameters;
      void _imageAssetIds;
      void _maskAssetId;
      const input: ImageInput = {
        ...rest,
        model: snapshot.modelId,
        ...(operation === 'edit' || operation === 'outpaint'
          ? {
              operation,
              ...(imageAssetId !== undefined && images.length === 1
                ? { image: images[0]! }
                : { images }),
              ...(mask ? { mask } : {}),
              ...(operation === 'outpaint' ? { geometry } : {}),
            }
          : images.length
            ? { images }
            : {}),
      };
      if (!validateImageInputByRoute(input, route)) inputError();
      if (!imageReferencesWithinBudget(input))
        throw new GenerationError(HTTP_STATUS.PAYLOAD_TOO_LARGE, 'IMAGE_REFERENCE_LIMIT');
      const async = snapshot.capabilityMetadata.image?.async;
      const command: GenerationRequest = {
        version: 1,
        type: 'image.request',
        messageId: createId(),
        jobId: createId(),
        ownerId: actor.userId,
        profile: snapshot.profile,
        route,
        input,
        expiresAt:
          epochMs() +
          (parameters.async === true
            ? Math.min(
                86_400_000,
                (route.paramSpec.async?.maxAgeSeconds ?? async?.maxAgeSeconds ?? 600) * 1000,
              )
            : 10 * 60_000),
      };
      if (Buffer.byteLength(JSON.stringify(command), 'utf8') > IMAGE_MAX_MESSAGE_BYTES)
        inputError();
      const admitted = {
        providerConfigId: snapshot.providerConfigId,
        providerRevision: snapshot.providerRevision,
        credentialVersion: snapshot.credentialVersion,
        catalogVersion: snapshot.catalogVersion,
        adaptationVersion: snapshot.adaptationVersion,
        vendor: snapshot.vendor,
        modelKey: snapshot.modelKey,
        ...(parameters.async === true && async ? { async } : {}),
        modelRef,
        modelId: snapshot.modelId,
        profile: snapshot.profile,
        operation:
          input.operation === 'outpaint'
            ? 'image.outpaint'
            : input.operation === 'edit'
              ? 'image.edit'
              : 'image.generate',
      };
      tool?.signal.throwIfAborted();
      const hash = httpHash ?? requestHash(modelRef, parameters);
      const id = await store.imageCreate(
        actor.userId,
        requestId,
        hash,
        command,
        admitted,
        snapshot,
        existingRequest,
      );
      return store.imageGet(actor.userId, id);
    } catch (error) {
      // Another submit can commit between the first lookup and a failing fresh preflight.
      if (
        tool &&
        !tool.signal.aborted &&
        (error instanceof ProviderError ||
          (error instanceof GenerationError && error.code !== 'REQUEST_CONFLICT'))
      ) {
        const concurrent = await replay();
        if (concurrent) return concurrent;
      }
      throw error;
    }
  };
}
