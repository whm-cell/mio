import { sha256Utf8 } from '@mio/foundation/hash';
import { sealImageKey } from './image-credentials.ts';
import { ProviderError } from '../providers/contracts.ts';
import type { ProviderService } from '../providers/service.ts';
import {
  canonicalImageRouteConfig,
  imageCommandCredentialBinding,
  imageQueryCredentialBinding,
  isImageDriver,
  parseImageCommand,
  validateImageInputByRoute,
  validateImageRouteConfig,
} from '@mio/compute-contracts';
import type { ImageAssetRef, ImageInput, ImageRequestParameters } from '@mio/compute-contracts';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { epochMs } from '@mio/foundation/time';
import { createId, isUuidV4 } from '@mio/foundation/identifiers';
import { COMPUTE_MAX_MEDIA_BYTES, IMAGE_MAX_MESSAGE_BYTES } from '@mio/compute-contracts';
import type { ImageCommandV1 } from '@mio/compute-contracts';
import type { ComputeResultV1 } from '@mio/compute-contracts';
import type { AssetObjectStore, AssetPrincipal } from '../assets/contracts.ts';
import { ComputeBroker } from '../integrations/rabbitmq.ts';
import type { ComputeConfig } from './config.ts';
import { ComputeError } from './errors.ts';
import type { ComputeStore, JobRow } from './store.ts';

const log = createLogger('app', 'compute');

function view(job: JobRow) {
  return {
    jobId: job.id,
    requestId: job.request_id,
    inputAssetId: job.input_asset_id,
    status: job.state,
    attempt: job.attempt,
    resultAssetId: job.result_asset_id,
    errorCode: job.error_code,
    createdAt: job.created_at.toISOString(),
    updatedAt: job.updated_at.toISOString(),
  };
}

/** Admissions and result commits drain before the pool closes; a late COS HEAD cannot commit. */
export function createComputeService(
  store: ComputeStore,
  objects: AssetObjectStore,
  config: ComputeConfig,
  imageConfig?: { provider: () => ProviderService | undefined; keyId: string; publicKey: string },
) {
  if (imageConfig && !/^[A-Za-z0-9_-]{1,64}$/.test(imageConfig.keyId))
    throw new Error('IMAGE_CONFIG: invalid key ID');
  let stopping = false;
  let closing: Promise<void> | undefined;
  let broker: ComputeBroker | undefined;
  let polling: Promise<void> | undefined;
  let retryAt = 0;
  let retryDelay = 1000;
  const active = new Set<Promise<unknown>>();
  const stop = new AbortController();
  const admit = <T>(run: () => Promise<T>): Promise<T> => {
    if (stopping) throw new ComputeError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_UNAVAILABLE');
    const action = run();
    active.add(action);
    void action.then(
      () => active.delete(action),
      () => active.delete(action),
    );
    return action;
  };
  const head = (key: string) =>
    new Promise<Awaited<ReturnType<AssetObjectStore['head']>>>((resolve, reject) => {
      if (stop.signal.aborted) {
        reject(new Error('COMPUTE_STOPPED'));
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        stop.signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        finish();
        reject(new Error('COMPUTE_STOPPED'));
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error('COMPUTE_OBJECT_TIMEOUT'));
      }, 180_000);
      stop.signal.addEventListener('abort', abort, { once: true });
      void objects.head(key).then(
        (value) => {
          finish();
          resolve(value);
        },
        (error: unknown) => {
          finish();
          reject(error);
        },
      );
    });
  const receive = (result: ComputeResultV1) =>
    admit(async () => {
      const resultLog = log.child({
        jobId: result.jobId,
        attemptId: result.attemptId,
        messageId: result.messageId,
      });
      if (result.state === 'succeeded' && (await store.current(result))) {
        const object = await head(result.output.key);
        if (
          object.size !== result.output.sizeBytes ||
          object.etag !== result.output.etag ||
          object.sha256 !== result.output.sha256
        )
          throw Object.assign(new Error('RESULT_OBJECT_MISMATCH'), { permanent: true });
      }
      try {
        await store.accept(result);
        resultLog.info('RESULT_COMMITTED');
      } catch (error) {
        if (error instanceof ComputeError && error.code === 'RESULT_CONFLICT') {
          resultLog.warn('RESULT_CONFLICT');
          throw Object.assign(error, { permanent: true });
        }
        throw error;
      }
    });
  const disconnect = (instance: ComputeBroker) => {
    if (broker === instance) broker = undefined;
    void instance.close().catch(() => {});
  };
  const poll = () => {
    if (stopping || polling || epochMs() < retryAt) return;
    polling = admit(async () => {
      if (!broker) {
        const acquired = await ComputeBroker.connect(
          config.brokerURL,
          config.brokerUser,
          config.expectedResultUser,
        );
        if (stopping) {
          await acquired.close();
          return;
        }
        broker = acquired;
        retryDelay = 1000;
        acquired.onClose(() => disconnect(acquired));
        try {
          await acquired.consume(
            receive,
            () => disconnect(acquired),
            (result) =>
              admit(async () => {
                if (!store.imagesAvailable)
                  throw Object.assign(new Error('IMAGE_SCHEMA_UNAVAILABLE'), { permanent: true });
                for (const output of result.outputs) {
                  const found = await head(output.key);
                  if (
                    found.size !== output.sizeBytes ||
                    found.etag !== output.etag ||
                    found.sha256 !== output.sha256
                  )
                    throw Object.assign(new Error('IMAGE_OBJECT_MISMATCH'), {
                      permanent: true,
                    });
                }
                let accepted: Awaited<ReturnType<ComputeStore['imageAccept']>>;
                try {
                  accepted = await store.imageAccept(result);
                } catch (error) {
                  if (error instanceof ComputeError && error.code === 'RESULT_CONFLICT')
                    throw Object.assign(error, { permanent: true });
                  throw error;
                }
                if (accepted && result.state === 'completed') {
                  const provider = imageConfig?.provider();
                  const { admitted } = accepted;
                  if (
                    typeof provider?.recordVerification === 'function' &&
                    typeof admitted.providerConfigId === 'string' &&
                    typeof admitted.modelKey === 'string' &&
                    typeof admitted.credentialVersion === 'number' &&
                    typeof admitted.catalogVersion === 'number' &&
                    typeof admitted.adaptationVersion === 'number' &&
                    typeof admitted.profile === 'string'
                  ) {
                    await provider
                      .recordVerification(
                        { userId: accepted.ownerId },
                        {
                          providerConfigId: admitted.providerConfigId,
                          modelKey: admitted.modelKey,
                          credentialVersion: admitted.credentialVersion,
                          catalogVersion: admitted.catalogVersion,
                          adaptationVersion: admitted.adaptationVersion,
                          operation: 'image.generate',
                          profile: admitted.profile,
                        },
                        `image:${result.jobId}`,
                      )
                      .catch(() => log.error('PROVIDER_VERIFICATION_UNAVAILABLE'));
                  }
                }
              }),
          );
        } catch (error) {
          disconnect(acquired);
          throw error;
        }
      }
      const instance = broker;
      if (!instance || stopping) return;
      if (store.imagesAvailable) {
        const image = await store.imagePending();
        if (image) {
          let outgoing = image;
          if (image.type === 'image.query') {
            if (!image.queryDeadline) {
              await store.imageQueryUnavailable(
                image.jobId,
                image.messageId,
                'IMAGE_CREDENTIAL_UNAVAILABLE',
              );
              return;
            }
            let queryCredential = image.queryCredential;
            if (!queryCredential) {
              try {
                const provider = imageConfig?.provider();
                if (!provider || !imageConfig) throw new Error('IMAGE_CREDENTIAL_UNAVAILABLE');
                const apiKey = await provider.resolveImageTaskCredential(image.ownerId);
                queryCredential = sealImageKey(
                  apiKey,
                  imageQueryCredentialBinding(image),
                  imageConfig.keyId,
                  imageConfig.publicKey,
                );
              } catch {
                await store.imageQueryUnavailable(
                  image.jobId,
                  image.messageId,
                  'IMAGE_CREDENTIAL_UNAVAILABLE',
                );
                return;
              }
            }
            const prepared = await store.imagePrepareQuery(
              image.jobId,
              image.messageId,
              image.queryDeadline,
              queryCredential,
            );
            if (!prepared) return;
            outgoing = prepared;
            if (Buffer.byteLength(JSON.stringify(outgoing), 'utf8') > IMAGE_MAX_MESSAGE_BYTES) {
              await store.imageQueryUnavailable(image.jobId, image.messageId, 'IMAGE_QUERY_FAILED');
              return;
            }
          }
          await instance.publish(outgoing);
          await store.imageSent(image.jobId, image.messageId);
        }
      }
      const item = await store.claim();
      if (!item) return;
      try {
        await instance.publish(item.command);
        await store.sent(item.command, item.lease);
      } catch (error) {
        await store.release(item.command.messageId, item.lease);
        disconnect(instance);
        throw error;
      }
    })
      .catch(() => {
        if (!stopping) {
          log.error('COMPUTE_BROKER_RETRY');
          retryAt = epochMs() + retryDelay;
          retryDelay = Math.min(retryDelay * 2, 30_000);
        }
      })
      .finally(() => {
        polling = undefined;
      });
  };
  const timer = setInterval(poll, 1000);
  timer.unref();
  poll();
  return {
    createImage(
      actor: AssetPrincipal,
      requestId: string,
      modelRef: string,
      parameters: ImageRequestParameters,
    ) {
      return admit(async () => {
        if (!store.imagesAvailable)
          throw new ComputeError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'IMAGE_UNAVAILABLE');
        if (
          !isUuidV4(requestId) ||
          typeof modelRef !== 'string' ||
          !parameters ||
          typeof parameters.prompt !== 'string' ||
          !parameters.prompt.trim() ||
          parameters.prompt.length > 32000 ||
          Object.keys(parameters).some(
            (k) =>
              ![
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
              ].includes(k),
          )
        )
          throw new ComputeError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
        if (parameters.async !== undefined && typeof parameters.async !== 'boolean')
          throw new ComputeError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
        const normalized = Object.fromEntries(
          Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b)),
        );
        const hash = sha256Utf8(JSON.stringify([modelRef, normalized]));
        const previous = await store.imageRequest(actor.userId, requestId);
        if (previous) {
          if (previous.input_hash !== hash)
            throw new ComputeError(HTTP_STATUS.CONFLICT, 'REQUEST_CONFLICT');
          return store.imageGet(actor.userId, previous.id);
        }
        if (!imageConfig || !imageConfig.provider())
          throw new ComputeError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'IMAGE_UNAVAILABLE');
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
          !['generate', 'edit', 'outpaint'].includes(operation)
        )
          throw new ComputeError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
        const imageAsset = async (assetId: string, mask = false): Promise<ImageAssetRef> => {
          if (!isUuidV4(assetId))
            throw new ComputeError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
          const row = await store.imageInput(actor.userId, assetId);
          if (
            !row ||
            !row.raw_key.startsWith(`mio/raw/${assetId}/`) ||
            !isUuidV4(row.raw_key.slice(`mio/raw/${assetId}/`.length)) ||
            !['image/png', 'image/jpeg', 'image/webp'].includes(row.content_type) ||
            (mask && row.content_type !== 'image/png')
          )
            throw new ComputeError(HTTP_STATUS.NOT_FOUND, 'ASSET_NOT_FOUND');
          const size = Number(row.size_bytes);
          if (!Number.isSafeInteger(size) || size < 1)
            throw new ComputeError(HTTP_STATUS.CONFLICT, 'ASSET_SIZE_MISMATCH');
          let object: Awaited<ReturnType<AssetObjectStore['head']>>;
          try {
            object = await head(row.raw_key);
          } catch {
            throw new ComputeError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_STORAGE_UNAVAILABLE');
          }
          if (
            !object ||
            object.size !== size ||
            !object.etag ||
            object.etag.length > 256 ||
            /[\x00-\x1f\x7f]/.test(object.etag)
          )
            throw new ComputeError(HTTP_STATUS.CONFLICT, 'ASSET_SIZE_MISMATCH');
          return {
            assetId,
            key: row.raw_key,
            sizeBytes: size,
            etag: object.etag,
            contentType: row.content_type as ImageAssetRef['contentType'],
          };
        };
        const { imageAssetId, imageAssetIds, maskAssetId, geometry, ...providerParameters } =
          parameters;
        if (imageAssetId !== undefined && imageAssetIds !== undefined)
          throw new ComputeError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
        if (
          maskAssetId !== undefined &&
          (typeof maskAssetId !== 'string' || !isUuidV4(maskAssetId))
        )
          throw new ComputeError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
        const requestedImageIds =
          imageAssetIds ?? (imageAssetId !== undefined ? [imageAssetId] : []);
        if (
          !Array.isArray(requestedImageIds) ||
          requestedImageIds.some((assetId) => typeof assetId !== 'string') ||
          new Set(requestedImageIds).size !== requestedImageIds.length
        )
          throw new ComputeError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
        if ((operation === 'edit' || operation === 'outpaint') && requestedImageIds.length < 1)
          throw new ComputeError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
        const snapshot = await imageConfig.provider()!.resolveImage(actor, modelRef);
        if (
          !isImageDriver(snapshot.profile) ||
          !validateImageRouteConfig(snapshot.route) ||
          snapshot.route.driver !== snapshot.profile
        )
          throw new ProviderError(HTTP_STATUS.CONFLICT, 'ADAPTER_PENDING');
        const imageCapability = snapshot.capabilityMetadata?.image;
        const route = snapshot.route;
        if (
          operation === 'generate' &&
          requestedImageIds.length > 0 &&
          (!route.paramSpec.allowGenerateReferences || !imageCapability?.references)
        )
          throw new ComputeError(HTTP_STATUS.CONFLICT, 'IMAGE_OPERATION_UNSUPPORTED');
        if (
          (operation === 'edit' || operation === 'outpaint') &&
          (!route.paramSpec.supportedOperations.includes(operation) ||
            !imageCapability?.modes.includes(operation))
        )
          throw new ComputeError(HTTP_STATUS.CONFLICT, 'IMAGE_OPERATION_UNSUPPORTED');
        if (
          requestedImageIds.length > 0 &&
          (!imageCapability?.references ||
            requestedImageIds.length > imageCapability.references.maxImages ||
            requestedImageIds.length > route.paramSpec.maxReferenceImages)
        )
          throw new ComputeError(HTTP_STATUS.CONFLICT, 'IMAGE_OPERATION_UNSUPPORTED');
        if (
          operation === 'outpaint' &&
          (!imageCapability?.geometry || !route.paramSpec.allowOutpaintGeometry)
        )
          throw new ComputeError(HTTP_STATUS.CONFLICT, 'IMAGE_OPERATION_UNSUPPORTED');
        if (
          parameters.async === true &&
          (!imageCapability?.async || !imageCapability.async.operations.includes(operation))
        )
          throw new ComputeError(HTTP_STATUS.CONFLICT, 'IMAGE_OPERATION_UNSUPPORTED');
        if (maskAssetId !== undefined && (!imageCapability?.mask || !route.paramSpec.allowMaskPng))
          throw new ComputeError(HTTP_STATUS.CONFLICT, 'IMAGE_OPERATION_UNSUPPORTED');
        const images = await Promise.all(requestedImageIds.map((assetId) => imageAsset(assetId)));
        const mask = maskAssetId !== undefined ? await imageAsset(maskAssetId, true) : undefined;
        const effectiveRoute = canonicalImageRouteConfig({
          ...route,
          effectiveWatermark: route.paramSpec.allowWatermarkOverride
            ? (snapshot.defaultImageWatermark ?? route.requestDefaults.watermark ?? null)
            : (route.effectiveWatermark ?? route.requestDefaults.watermark ?? null),
        });
        const jobId = createId();
        const asyncMaxAgeSeconds =
          effectiveRoute.paramSpec.async?.maxAgeSeconds ?? imageCapability?.async?.maxAgeSeconds;
        const expiresAt =
          parameters.async === true
            ? epochMs() + Math.min(86_400_000, (asyncMaxAgeSeconds ?? 600) * 1000)
            : epochMs() + 10 * 60_000;
        const input: ImageInput = {
          ...providerParameters,
          model: snapshot.modelId,
          ...(parameters.async === true ? { async: true } : {}),
          ...(operation === 'edit' || operation === 'outpaint'
            ? {
                operation,
                ...(imageAssetId !== undefined && images.length === 1
                  ? { image: images[0]! }
                  : { images }),
                ...(mask ? { mask } : {}),
                ...(operation === 'outpaint' ? { geometry } : {}),
              }
            : images.length > 0
              ? { images }
              : {}),
        };
        if (!validateImageInputByRoute(input, effectiveRoute))
          throw new ComputeError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
        const commandBase = {
          jobId,
          ownerId: actor.userId,
          expiresAt,
          profile: snapshot.profile,
          route: effectiveRoute,
          input,
        };
        const binding = imageCommandCredentialBinding(commandBase);
        const credential = sealImageKey(
          snapshot.apiKey,
          binding,
          imageConfig.keyId,
          imageConfig.publicKey,
        );
        const command: ImageCommandV1 = {
          version: 1,
          type: 'image.request',
          messageId: createId(),
          ...commandBase,
          credential,
        };
        try {
          parseImageCommand(command);
        } catch {
          throw new ComputeError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'IMAGE_UNAVAILABLE');
        }
        if (Buffer.byteLength(JSON.stringify(command), 'utf8') > IMAGE_MAX_MESSAGE_BYTES)
          throw new ComputeError(HTTP_STATUS.BAD_REQUEST, 'IMAGE_INPUT_INVALID');
        const id = await store.imageCreate(actor.userId, requestId, hash, command, {
          providerConfigId: snapshot.providerConfigId,
          providerRevision: snapshot.providerRevision,
          credentialVersion: snapshot.credentialVersion,
          catalogVersion: snapshot.catalogVersion,
          adaptationVersion: snapshot.adaptationVersion,
          vendor: snapshot.vendor,
          ...(snapshot.modelKey ? { modelKey: snapshot.modelKey } : {}),
          ...(parameters.async === true && imageCapability?.async
            ? { async: imageCapability.async }
            : {}),
          modelRef,
          modelId: snapshot.modelId,
          operation:
            input.operation === 'outpaint'
              ? 'image.outpaint'
              : input.operation === 'edit'
                ? 'image.edit'
                : 'image.generate',
          profile: snapshot.profile,
        });
        return store.imageGet(actor.userId, id);
      });
    },
    getImage(actor: AssetPrincipal, id: string) {
      return admit(() => store.imageGet(actor.userId, id));
    },
    recoverImage(actor: AssetPrincipal, id: string) {
      return admit(async () => {
        if (!store.imagesAvailable)
          throw new ComputeError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'IMAGE_UNAVAILABLE');
        await store.imageRecover(actor.userId, id);
        return store.imageGet(actor.userId, id);
      });
    },
    create(actor: AssetPrincipal, requestId: string, assetId: string) {
      return admit(async () => {
        if (!isUuidV4(requestId) || !isUuidV4(assetId))
          throw new ComputeError(HTTP_STATUS.BAD_REQUEST, 'COMPUTE_INPUT_INVALID');
        const previous = await store.request(actor.userId, requestId);
        if (previous) {
          if (previous.input_asset_id !== assetId)
            throw new ComputeError(HTTP_STATUS.CONFLICT, 'REQUEST_CONFLICT');
          return { created: false, job: view(previous) };
        }
        const input = await store.input(actor.userId, assetId);
        if (
          !input ||
          !input.raw_key.startsWith(`mio/raw/${assetId}/`) ||
          !isUuidV4(input.raw_key.slice(`mio/raw/${assetId}/`.length))
        )
          throw new ComputeError(HTTP_STATUS.NOT_FOUND, 'ASSET_NOT_FOUND');
        let object: Awaited<ReturnType<AssetObjectStore['head']>>;
        try {
          object = await head(input.raw_key);
        } catch {
          throw new ComputeError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_STORAGE_UNAVAILABLE');
        }
        const size = Number(input.size_bytes);
        if (object.size !== size || size < 1 || size > COMPUTE_MAX_MEDIA_BYTES)
          throw new ComputeError(HTTP_STATUS.CONFLICT, 'ASSET_SIZE_MISMATCH');
        if (!object.etag || object.etag.length > 256 || /[\x00-\x1f\x7f]/.test(object.etag))
          throw new ComputeError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_STORAGE_UNAVAILABLE');
        const created = await store.create(
          actor.userId,
          requestId,
          assetId,
          input.raw_key,
          size,
          object.etag,
        );
        return { created: created.created, job: view(created.job) };
      });
    },
    get(actor: AssetPrincipal, id: string) {
      return admit(async () => {
        if (!isUuidV4(id)) throw new ComputeError(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
        const job = await store.owned(id, actor.userId);
        if (!job) throw new ComputeError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
        return view(job);
      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      stopping = true;
      clearInterval(timer);
      closing = (async () => {
        const deadline = setTimeout(() => stop.abort(), 5000);
        try {
          if (broker) await broker.close();
          await Promise.allSettled([...active]);
          await store.close();
        } finally {
          clearTimeout(deadline);
        }
      })();
      return closing;
    },
  };
}
