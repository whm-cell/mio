import { sha256Utf8 } from '@mio/foundation/hash';
import { createId, isUuidV4 } from '@mio/foundation/identifiers';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { epochMs } from '@mio/foundation/time';
import {
  IMAGE_MAX_MESSAGE_BYTES,
  canonicalImageRouteConfig,
  isImageDriver,
  isValidImageAssetObjectKey,
  imageReferencesWithinBudget,
  validateImageInputByRoute,
  validateImageRouteConfig,
} from './contracts.ts';
import type {
  ImageAssetRef,
  ImageInput,
  ImageOperation,
  ImageRequestParameters,
} from './contracts.ts';
import { ProviderError } from '../providers/contracts.ts';
import type { ImageAdmissionSnapshot } from '../providers/contracts.ts';
import type { ProviderService } from '../providers/service.ts';
import type { AssetObjectStore } from '../assets/contracts.ts';
import type { GenerationRequest } from './execution.ts';
import type { GenerationStore, ImageRequestRecord } from './store.ts';
import type { GenerationFiles } from './files.ts';
import { GenerationError } from './errors.ts';

function inputError(): never {
  throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
}

function validateRequest(requestId: string, modelRef: string, parameters: ImageRequestParameters) {
  const fields = [
    'prompt',
    'async',
    'operation',
    'imageAssetId',
    'imageAssetIds',
    'maskAssetId',
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
  ];
  if (
    !isUuidV4(requestId) ||
    typeof modelRef !== 'string' ||
    !parameters ||
    typeof parameters.prompt !== 'string' ||
    !parameters.prompt.trim() ||
    parameters.prompt.length > 32000 ||
    Object.keys(parameters).some((key) => !fields.includes(key)) ||
    (parameters.async !== undefined && typeof parameters.async !== 'boolean')
  )
    inputError();
}

function requestHash(modelRef: string, parameters: ImageRequestParameters): string {
  const normalized = Object.fromEntries(
    Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b)),
  );
  return sha256Utf8(JSON.stringify([modelRef, normalized]));
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
  store: GenerationStore,
  head: AssetObjectStore['head'],
  owner: string,
  id: string,
  mask = false,
): Promise<ImageAssetRef> {
  if (!isUuidV4(id)) inputError();
  const asset = await store.imageInput(owner, id);
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
    object = await head(asset.raw_key);
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
    validateRequest(requestId, modelRef, intent);
    tool?.signal.throwIfAborted();
    const httpHash = tool ? undefined : requestHash(modelRef, intent);
    // Tool retries use the winning job's defaults, including jobs admitted before this lookup.
    const matchesTool = tool
      ? (record: ImageRequestRecord) =>
          record.input_hash === requestHash(modelRef, toolParameters(intent, record))
      : undefined;
    const replay = async () => {
      const previous = await store.imageRequest(actor.userId, requestId, Boolean(matchesTool));
      tool?.signal.throwIfAborted();
      if (!previous) return;
      if (matchesTool ? !matchesTool(previous) : previous.input_hash !== httpHash)
        throw new GenerationError(HTTP_STATUS.CONFLICT, 'REQUEST_CONFLICT');
      return store.imageGet(actor.userId, previous.id);
    };
    const previous = await replay();
    if (previous) return previous;
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
      const images = await Promise.all(ids.map((id) => inputAsset(store, head, actor.userId, id)));
      const mask =
        parameters.maskAssetId !== undefined
          ? await inputAsset(store, head, actor.userId, parameters.maskAssetId, true)
          : undefined;
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
        matchesTool,
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
