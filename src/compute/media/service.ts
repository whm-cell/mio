import { sha256Bytes } from '@mio/foundation/hash';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { MAX_ASSET_BYTES, waitForObjectHead } from '../../assets/contracts.ts';
import type { AssetObjectStore, AssetPrincipal } from '../../assets/contracts.ts';
import {
  MEDIA_AVAILABLE_OPERATIONS,
  MEDIA_MAX_FILES,
  MEDIA_MAX_MANIFEST_BYTES,
  mediaObjectPrefix,
  parseMediaManifest,
  parseMediaRequest,
  parseMediaResult,
} from '@mio/compute-contracts';
import type {
  MediaInputSnapshot,
  MediaManifest,
  MediaObject,
  MediaResult,
} from '@mio/compute-contracts';
import type { ComputeConfig } from '../config.ts';
import { MediaError, mediaRequestHash } from './model.ts';
import type { MediaJobRow, MediaJobViewRow } from './model.ts';
import type { MediaStore } from './store.ts';
import { mediaDispatch } from './dispatch.ts';
import { mediaHls } from './hls.ts';

export function createMediaService(
  store: MediaStore,
  objects: AssetObjectStore,
  config: ComputeConfig,
) {
  if (!objects.readMedia) throw new Error('MEDIA_STORAGE_READ_REQUIRED');
  let stopping = false;
  let closing: Promise<void> | undefined;
  const stop = new AbortController();
  const active = new Set<Promise<unknown>>();
  const admit = <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (stopping)
      return Promise.reject(new MediaError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_UNAVAILABLE'));
    const action = run(AbortSignal.any([stop.signal, AbortSignal.timeout(180_000)]));
    active.add(action);
    void action.then(
      () => active.delete(action),
      () => active.delete(action),
    );
    return action;
  };
  const view = (job: MediaJobViewRow) => ({
    jobId: job.id,
    requestId: job.request_id,
    operation: job.operation,
    profile: job.profile,
    inputs: job.inputs.map((input) => ({ assetId: input.assetId })),
    parameters: job.parameters,
    status: job.state,
    attempt: job.attempt,
    stage: job.stage,
    progress: job.progress,
    errorCode: job.error_code,
    cancelRequested: job.cancel_requested,
    data: job.data,
    outputs: job.outputs,
    createdAt: job.created_at.toISOString(),
    updatedAt: job.updated_at.toISOString(),
  });
  const owned = async (actor: AssetPrincipal, id: string) => {
    if (!isUuidV4(id)) throw new MediaError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
    const job = await store.ownerView(id, actor.userId);
    if (!job) throw new MediaError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
    return view(job);
  };
  const receive = (value: MediaResult) =>
    admit(async (signal) => {
      let result: MediaResult;
      try {
        result = parseMediaResult(value);
      } catch {
        throw Object.assign(new MediaError(HTTP_STATUS.BAD_REQUEST, 'MEDIA_RESULT_INVALID'), {
          permanent: true,
        });
      }
      const job = await store.current(result);
      let manifest: MediaManifest | undefined;
      let verificationError: string | undefined;
      if (result.state === 'succeeded' && job && !job.cancel_requested) {
        try {
          manifest = await verifyMediaManifest(objects, job, result.manifest, signal);
        } catch (error) {
          signal.throwIfAborted();
          verificationError =
            error instanceof MediaError ? error.code : 'COMPUTE_STORAGE_UNAVAILABLE';
        }
      }
      signal.throwIfAborted();
      try {
        await store.accept(result, manifest, verificationError);
      } catch (error) {
        if (error instanceof MediaError) Object.assign(error, { permanent: true });
        throw error;
      }
      dispatch.wake();
    });
  const dispatch = mediaDispatch(store, config, receive);
  return {
    create(actor: AssetPrincipal, value: unknown) {
      return admit(async (signal) => {
        let request: ReturnType<typeof parseMediaRequest>;
        try {
          request = parseMediaRequest(value);
        } catch {
          throw new MediaError(HTTP_STATUS.BAD_REQUEST, 'MEDIA_INPUT_INVALID');
        }
        if (!MEDIA_AVAILABLE_OPERATIONS.includes(request.operation))
          throw new MediaError(HTTP_STATUS.BAD_REQUEST, 'MEDIA_OPERATION_UNAVAILABLE');
        const previous = await store.request(actor.userId, request.requestId);
        if (previous) {
          if (previous.request_hash !== mediaRequestHash(request))
            throw new MediaError(HTTP_STATUS.CONFLICT, 'REQUEST_CONFLICT');
          return { created: false, job: await owned(actor, previous.id) };
        }
        const ids = request.inputs.map((input) => input.assetId);
        const assets = await store.inputs(actor.userId, ids);
        if (assets.length !== ids.length)
          throw new MediaError(HTTP_STATUS.NOT_FOUND, 'ASSET_NOT_FOUND');
        const byId = new Map(assets.map((asset) => [asset.id, asset]));
        const inputs: MediaInputSnapshot[] = [];
        for (const id of ids) {
          const asset = byId.get(id)!;
          const size = Number(asset.size_bytes);
          const head = await waitForObjectHead(
            () => objects.head(asset.raw_key, signal),
            signal,
          ).catch(() => {
            signal.throwIfAborted();
            throw new MediaError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_STORAGE_UNAVAILABLE');
          });
          signal.throwIfAborted();
          if (head.size !== size || size < 1 || size > MAX_ASSET_BYTES)
            throw new MediaError(HTTP_STATUS.CONFLICT, 'ASSET_SIZE_MISMATCH');
          if (
            !asset.raw_key.startsWith('mio/raw/') &&
            asset.source_etag &&
            asset.source_etag !== head.etag
          )
            throw new MediaError(HTTP_STATUS.CONFLICT, 'ASSET_SOURCE_CHANGED');
          if (!head.etag || head.etag.length > 256 || /[\x00-\x1f\x7f]/.test(head.etag))
            throw new MediaError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_STORAGE_UNAVAILABLE');
          inputs.push({
            assetId: id,
            key: asset.raw_key,
            sizeBytes: size,
            etag: head.etag,
          });
        }
        signal.throwIfAborted();
        const created = await store.create(actor.userId, request, inputs);
        dispatch.wake();
        return { created: created.created, job: await owned(actor, created.job.id) };
      });
    },
    get(actor: AssetPrincipal, id: string) {
      return admit(() => owned(actor, id));
    },
    hls(actor: AssetPrincipal, id: string, assetId?: string) {
      return admit((signal) => {
        const sign = objects.hlsSegmentUrl;
        if (!sign)
          throw new MediaError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_STORAGE_UNAVAILABLE');
        return mediaHls(
          store,
          objects,
          (key, expiresIn) => sign.call(objects, key, expiresIn),
          actor.userId,
          id,
          assetId,
          signal,
        );
      });
    },
    list(actor: AssetPrincipal) {
      return admit(async () => ({
        jobs: (await store.list(actor.userId)).map(view),
      }));
    },
    cancel(actor: AssetPrincipal, id: string) {
      return admit(async (signal) => {
        if (!isUuidV4(id)) throw new MediaError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
        signal.throwIfAborted();
        await store.control(actor.userId, id, 'cancel');
        dispatch.wake();
        return owned(actor, id);
      });
    },
    retry(actor: AssetPrincipal, id: string, requestId: string) {
      return admit(async (signal) => {
        if (!isUuidV4(requestId))
          throw new MediaError(HTTP_STATUS.BAD_REQUEST, 'MEDIA_INPUT_INVALID');
        if (!isUuidV4(id)) throw new MediaError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
        signal.throwIfAborted();
        await store.retry(actor.userId, id, requestId);
        dispatch.wake();
        return owned(actor, id);
      });
    },
    recover(actor: AssetPrincipal, id: string) {
      return admit(async (signal) => {
        if (!isUuidV4(id)) throw new MediaError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
        signal.throwIfAborted();
        const job = await store.control(actor.userId, id, 'recover');
        dispatch.wake();
        if (job.state === 'reconciling' && !job.cancel_requested) {
          const original = await store.recoveryResult(job);
          if (original) await receive(original);
        }
        return owned(actor, id);
      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      stopping = true;
      closing = (async () => {
        const deadline = setTimeout(() => stop.abort(), 5000);
        try {
          await dispatch.close();
        } finally {
          try {
            await Promise.allSettled([...active]);
            await store.close();
          } finally {
            clearTimeout(deadline);
          }
        }
      })();
      return closing;
    },
  };
}

async function verifyMediaManifest(
  objects: AssetObjectStore,
  job: MediaJobRow,
  object: MediaObject,
  signal: AbortSignal,
): Promise<MediaManifest> {
  if (
    object.sizeBytes > MEDIA_MAX_MANIFEST_BYTES ||
    !object.key.startsWith(mediaObjectPrefix(job.id, job.attempt_id))
  )
    throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_MANIFEST_MISMATCH');
  const meta = await waitForObjectHead(() => objects.head(object.key, signal), signal);
  signal.throwIfAborted();
  if (meta.size !== object.sizeBytes || meta.etag !== object.etag || meta.sha256 !== object.sha256)
    throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_MANIFEST_MISMATCH');
  const bytes = await objects.readMedia!(object.key, object.etag, object.sizeBytes, signal);
  signal.throwIfAborted();
  if (bytes.length !== object.sizeBytes || sha256Bytes(bytes) !== object.sha256)
    throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_MANIFEST_MISMATCH');
  let manifest: MediaManifest;
  try {
    manifest = parseMediaManifest(bytes);
  } catch {
    throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_MANIFEST_INVALID');
  }
  if (
    manifest.jobId !== job.id ||
    manifest.attemptId !== job.attempt_id ||
    manifest.operation !== job.operation ||
    manifest.profile !== job.profile ||
    manifest.files.length > MEDIA_MAX_FILES
  )
    throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_MANIFEST_MISMATCH');
  // Sequential HEADs keep memory, socket use and shutdown work bounded even at 4096 entries.
  for (const file of manifest.files) {
    signal.throwIfAborted();
    if (file.key === object.key || !file.key.startsWith(mediaObjectPrefix(job.id, job.attempt_id)))
      throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_MANIFEST_MISMATCH');
    const head = await waitForObjectHead(() => objects.head(file.key, signal), signal);
    signal.throwIfAborted();
    if (head.size !== file.sizeBytes || head.etag !== file.etag || head.sha256 !== file.sha256)
      throw new MediaError(HTTP_STATUS.CONFLICT, 'MEDIA_FILE_MISMATCH');
  }
  return manifest;
}
