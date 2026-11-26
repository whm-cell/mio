import { HTTP_STATUS } from '@mio/foundation/http-status';
import { isUuidV4 } from '@mio/foundation/identifiers';
import { ProviderError } from '../../providers/contracts.ts';
import type { ProviderPrincipal, VideoAdmissionSnapshot } from '../../providers/contracts.ts';
import type { ProviderService } from '../../providers/service.ts';
import type { VideoGenerationStore } from './store.ts';
import { GenerationError } from '../errors.ts';
import { videoRequestHash } from './contracts.ts';
import { defaultVideoGenerateAudio } from './driver-capabilities.ts';
import { validateVideoParameters } from '../../providers/onelink/video-route.ts';
import type { createVideoInputResolver } from './inputs.ts';
import type { VideoCreateRequest, VideoCapabilitiesView, VideoMode } from './contracts.ts';
import type { VideoJobCommand } from './execution.ts';
import type { VideoJobCursor } from './store.ts';

function parseCursor(value: string | undefined): VideoJobCursor | undefined {
  if (value === undefined) return;
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value))
    throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'VIDEO_CURSOR_INVALID');
  try {
    const json = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(json).toString('base64url') !== value) throw new Error();
    const decoded: unknown = JSON.parse(json);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();
    const cursor = decoded as Record<string, unknown>;
    if (
      Object.keys(cursor).length !== 2 ||
      typeof cursor.createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.createdAt) ||
      !Number.isFinite(Date.parse(cursor.createdAt)) ||
      typeof cursor.id !== 'string' ||
      !isUuidV4(cursor.id)
    )
      throw new Error();
    const timestamp = cursor.createdAt.slice(0, 23);
    if (new Date(cursor.createdAt).toISOString().slice(0, 23) !== timestamp) throw new Error();
    return { createdAt: cursor.createdAt, id: cursor.id };
  } catch {
    throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'VIDEO_CURSOR_INVALID');
  }
}

function inputSnapshot(request: VideoCreateRequest): VideoJobCommand['inputSnapshot'] {
  const { parameters } = request;
  const inputs: VideoJobCommand['inputSnapshot'] = [];
  if (parameters.firstFrame)
    inputs.push({
      assetId: parameters.firstFrame.assetId,
      mediaType: 'image',
      role: 'first_frame',
    });
  if (parameters.lastFrame)
    inputs.push({ assetId: parameters.lastFrame.assetId, mediaType: 'image', role: 'last_frame' });
  for (const reference of parameters.references ?? []) {
    inputs.push({
      assetId: reference.assetId,
      ...(reference.mediaType ? { mediaType: reference.mediaType } : {}),
      ...(reference.role ? { role: reference.role } : {}),
    });
  }
  for (const subject of parameters.subjects ?? []) {
    for (const image of subject.images)
      inputs.push({ assetId: image.assetId, mediaType: 'image', role: `subject:${subject.name}` });
  }
  return inputs;
}

function routeSnapshot(snapshot: VideoAdmissionSnapshot): Record<string, unknown> {
  const allowed = new Set([
    'providerConfigId',
    'providerRevision',
    'credentialVersion',
    'catalogVersion',
    'adaptationVersion',
    'modelRef',
    'modelId',
    'profile',
    'route',
    'defaultVideoWatermark',
    'capabilitiesVersion',
  ]);
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => allowed.has(key)));
}

function videoUnavailable(): GenerationError {
  return new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'VIDEO_UNAVAILABLE');
}

function requireVideoMode(
  admission: Awaited<ReturnType<ProviderService['videoAdmission']>>,
  mode: VideoMode,
): void {
  if (!admission.available) throw videoUnavailable();
  if (!admission.supportedModes.includes(mode))
    throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'VIDEO_MODE_UNSUPPORTED');
}

/** Exposes video capability, durable job reads, and admission through the wired executor. */
export function createVideoGenerationService(
  store: VideoGenerationStore,
  provider: () => ProviderService | undefined,
  executor?: { readonly signal: AbortSignal; wake(): void },
  inspectInputs?: ReturnType<typeof createVideoInputResolver>['inspect'],
) {
  let closing: Promise<void> | undefined;
  const stop = new AbortController();
  const executorStop = new AbortController();
  // Normalize the executor's stop reason without interrupting durable reads or replay.
  const stopExecutorAdmission = () => executorStop.abort(videoUnavailable());
  if (!executor || executor.signal.aborted) stopExecutorAdmission();
  else
    executor.signal.addEventListener('abort', stopExecutorAdmission, {
      once: true,
      signal: stop.signal,
    });
  const writable = AbortSignal.any([stop.signal, executorStop.signal]);
  const active = new Set<Promise<unknown>>();
  const admit = <T>(run: () => Promise<T>): Promise<T> => {
    stop.signal.throwIfAborted();
    const action = run();
    active.add(action);
    void action.then(
      () => active.delete(action),
      () => active.delete(action),
    );
    return action;
  };

  const currentProvider = () => {
    const current = provider();
    if (!current) throw videoUnavailable();
    return current;
  };

  const capabilities = (
    actor: Pick<ProviderPrincipal, 'userId'>,
    modelRef: string,
  ): Promise<VideoCapabilitiesView> =>
    admit(async () => {
      if (!/^onelink:model:[a-z0-9-]{1,256}$/.test(modelRef))
        throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'VIDEO_INPUT_INVALID');
      return currentProvider().videoCapabilities(actor, modelRef);
    });

  const create = async (
    actor: Pick<ProviderPrincipal, 'userId'>,
    request: VideoCreateRequest,
    turnSignal?: AbortSignal,
    toolSnapshot?: () => VideoAdmissionSnapshot,
  ) => {
    const readSignal = turnSignal ? AbortSignal.any([turnSignal, stop.signal]) : stop.signal;
    readSignal.throwIfAborted();
    const hash = videoRequestHash(request);
    const replay = async () => {
      const previous = await store.byRequest(actor.userId, request.requestId);
      readSignal.throwIfAborted();
      if (!previous) return;
      if (previous.inputHash !== hash)
        throw new GenerationError(HTTP_STATUS.CONFLICT, 'REQUEST_CONFLICT');
      const job = await store.get(actor.userId, previous.jobId);
      readSignal.throwIfAborted();
      return { created: false, job };
    };
    const previous = await replay();
    if (previous) return previous;

    const signal = turnSignal ? AbortSignal.any([turnSignal, writable]) : writable;
    signal.throwIfAborted();
    let snapshot: VideoAdmissionSnapshot;
    try {
      if (toolSnapshot) snapshot = toolSnapshot();
      else {
        const admission = await currentProvider().videoAdmission(actor, request.modelRef);
        signal.throwIfAborted();
        if (admission.capabilitiesVersion !== request.expectedCapabilitiesVersion)
          throw new GenerationError(HTTP_STATUS.CONFLICT, 'VIDEO_CAPABILITIES_STALE');
        requireVideoMode(admission, request.parameters.mode);
        snapshot = admission.snapshot();
      }
    } catch (error) {
      readSignal.throwIfAborted();
      // A concurrent admission may commit before the fresh provider preflight fails.
      if (error instanceof ProviderError || error instanceof GenerationError) {
        const concurrent = await replay();
        if (concurrent) return concurrent;
      }
      signal.throwIfAborted();
      throw error;
    }
    if (!validateVideoParameters(request.parameters, snapshot.route))
      throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'VIDEO_INPUT_INVALID');
    const effective = { ...request.parameters };
    if (effective.watermark === undefined && snapshot.route.paramSpec.parameters?.watermark)
      effective.watermark = snapshot.defaultVideoWatermark;
    const audioDefault = defaultVideoGenerateAudio(snapshot.route.driver, snapshot.modelId);
    if (effective.generateAudio === undefined && audioDefault !== undefined)
      effective.generateAudio = audioDefault;
    const command: VideoJobCommand = {
      request: { ...request, parameters: effective },
      inputSnapshot: inputSnapshot(request),
    };
    const admitted: Record<string, unknown> = Object.fromEntries(
      (
        [
          'providerConfigId',
          'providerRevision',
          'credentialVersion',
          'catalogVersion',
          'adaptationVersion',
          'modelRef',
          'modelId',
          'modelKey',
          'profile',
          'capabilitiesVersion',
          'defaultVideoWatermark',
        ] as const
      )
        .filter((key) => snapshot[key] !== undefined)
        .map((key) => [key, snapshot[key]]),
    );
    admitted.driver = admitted.profile;
    delete admitted.profile;
    const executionSnapshot = {
      providerConfigId: snapshot.providerConfigId,
      credentialVersion: snapshot.credentialVersion,
      credential: snapshot.credential,
    };
    let stored;
    try {
      if (command.inputSnapshot.length) {
        if (!inspectInputs) throw videoUnavailable();
        try {
          command.inputObjects = await inspectInputs(
            actor.userId,
            command.inputSnapshot,
            AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          );
        } catch (error) {
          readSignal.throwIfAborted();
          if (error instanceof GenerationError && (!signal.aborted || error === signal.reason))
            throw error;
          throw videoUnavailable();
        }
      }
      signal.throwIfAborted();
      stored = await store.create(
        actor.userId,
        request,
        hash,
        command,
        admitted,
        executionSnapshot,
        routeSnapshot(snapshot),
        signal,
      );
    } catch (error) {
      // The losing write was stopped, but another admission may have committed its request.
      if (!executorStop.signal.aborted || error !== executorStop.signal.reason) throw error;
      readSignal.throwIfAborted();
      const concurrent = await replay();
      if (!concurrent) throw error;
      return concurrent;
    }
    if (stored.created && !writable.aborted) executor?.wake();
    return { created: stored.created, job: await store.get(actor.userId, stored.jobId) };
  };

  return {
    capabilities,
    create(
      actor: Pick<ProviderPrincipal, 'userId'>,
      request: VideoCreateRequest,
      turnSignal?: AbortSignal,
    ) {
      return admit(() => create(actor, request, turnSignal));
    },
    createFromTool(
      actor: Pick<ProviderPrincipal, 'userId'>,
      intent: Omit<VideoCreateRequest, 'expectedCapabilitiesVersion'>,
      turnSignal?: AbortSignal,
    ) {
      return admit(async () => {
        turnSignal?.throwIfAborted();
        const admission = await currentProvider().videoAdmission(actor, intent.modelRef);
        turnSignal?.throwIfAborted();
        // The tool checks availability and mode before looking up its durable request.
        requireVideoMode(admission, intent.parameters.mode);
        // Property order is part of the stored video request hash.
        const request: VideoCreateRequest = {
          requestId: intent.requestId,
          modelRef: intent.modelRef,
          expectedCapabilitiesVersion: admission.capabilitiesVersion,
          parameters: intent.parameters,
        };
        return create(actor, request, turnSignal, admission.snapshot);
      });
    },
    get(actor: Pick<ProviderPrincipal, 'userId'>, jobId: string) {
      return admit(async () => {
        if (!isUuidV4(jobId)) throw new GenerationError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
        return store.get(actor.userId, jobId);
      });
    },
    recover(actor: Pick<ProviderPrincipal, 'userId'>, jobId: string) {
      return admit(async () => {
        if (!isUuidV4(jobId)) throw new GenerationError(HTTP_STATUS.NOT_FOUND, 'JOB_NOT_FOUND');
        writable.throwIfAborted();
        await store.recover(actor.userId, jobId, writable);
        if (!writable.aborted) executor?.wake();
        return store.get(actor.userId, jobId);
      });
    },
    list(actor: Pick<ProviderPrincipal, 'userId'>, limit: number, cursor?: string) {
      return admit(async () => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'VIDEO_INPUT_INVALID');
        return store.list(actor.userId, limit, parseCursor(cursor));
      });
    },
    close() {
      if (!closing) {
        stop.abort(videoUnavailable());
        closing = (async () => {
          await Promise.allSettled([...active]);
        })();
      }
      return closing;
    },
  };
}
