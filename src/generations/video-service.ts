import { HTTP_STATUS } from '@mio/foundation/http-status';
import { isUuidV4 } from '@mio/foundation/identifiers';
import type { ProviderPrincipal } from '../providers/contracts.ts';
import type { ProviderService } from '../providers/service.ts';
import type { VideoGenerationStore } from './video-store.ts';
import { GenerationError } from './errors.ts';
import { videoRequestHash } from './video-contracts.ts';
import { validateVideoParameters } from '../providers/onelink/video-route.ts';
import type { VideoAssetReference } from './video-contracts.ts';
import type { VideoCreateRequest, VideoCapabilitiesView } from './video-contracts.ts';
import type { VideoJobCommand } from './video-store.ts';
import type { VideoJobCursor } from './video-store.ts';

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
  for (const [index, segment] of (parameters.multiframeSegments ?? []).entries()) {
    inputs.push({
      assetId: segment.keyImage.assetId,
      mediaType: 'image',
      role: `segment:${index}`,
    });
  }
  return inputs;
}

function routeSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
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

/** Exposes video capability, durable job reads, and admission through the wired executor. */
export function createVideoGenerationService(
  store: VideoGenerationStore,
  provider: () => ProviderService | undefined,
  executor?: { wake(): void },
  validateInputs?: (
    ownerId: string,
    references: readonly VideoAssetReference[],
    signal: AbortSignal,
  ) => Promise<unknown>,
) {
  let stopping = false;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const admit = <T>(run: () => Promise<T>): Promise<T> => {
    if (stopping) throw new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'VIDEO_UNAVAILABLE');
    const action = run();
    active.add(action);
    void action.then(
      () => active.delete(action),
      () => active.delete(action),
    );
    return action;
  };

  const capabilities = (
    actor: Pick<ProviderPrincipal, 'userId'>,
    modelRef: string,
  ): Promise<VideoCapabilitiesView> =>
    admit(async () => {
      if (!/^onelink:model:[a-z0-9-]{1,256}$/.test(modelRef))
        throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'VIDEO_INPUT_INVALID');
      const current = provider();
      if (!current) throw new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'VIDEO_UNAVAILABLE');
      return current.videoCapabilities(actor, modelRef);
    });

  return {
    capabilities,
    create(actor: Pick<ProviderPrincipal, 'userId'>, request: VideoCreateRequest) {
      return admit(async () => {
        const hash = videoRequestHash(request);
        const previous = await store.byRequest(actor.userId, request.requestId);
        if (previous) {
          if (previous.inputHash !== hash)
            throw new GenerationError(HTTP_STATUS.CONFLICT, 'REQUEST_CONFLICT');
          return { created: false, job: await store.get(actor.userId, previous.jobId) };
        }
        const current = provider();
        if (!current)
          throw new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'VIDEO_UNAVAILABLE');
        const capability = await current.videoCapabilities(actor, request.modelRef);
        if (capability.capabilitiesVersion !== request.expectedCapabilitiesVersion)
          throw new GenerationError(HTTP_STATUS.CONFLICT, 'VIDEO_CAPABILITIES_STALE');
        if (!capability.available)
          throw new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'VIDEO_UNAVAILABLE');
        if (
          !capability.modes.some((mode) => mode.mode === request.parameters.mode && mode.supported)
        )
          throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'VIDEO_MODE_UNSUPPORTED');
        const snapshot = await current.snapshotVideo(actor, request.modelRef);
        if (snapshot.capabilitiesVersion !== request.expectedCapabilitiesVersion)
          throw new GenerationError(HTTP_STATUS.CONFLICT, 'VIDEO_CAPABILITIES_STALE');
        if (!executor)
          throw new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'VIDEO_UNAVAILABLE');
        if (!validateVideoParameters(request.parameters, snapshot.route))
          throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'VIDEO_INPUT_INVALID');
        const effective = { ...request.parameters };
        if (effective.watermark === undefined && snapshot.route.paramSpec.parameters?.watermark)
          effective.watermark = snapshot.defaultVideoWatermark;
        const snapshotRecord = snapshot as unknown as Record<string, unknown>;
        const route = snapshotRecord.route;
        const credential = snapshotRecord.credential;
        if (
          !route ||
          typeof route !== 'object' ||
          Array.isArray(route) ||
          !credential ||
          typeof credential !== 'object' ||
          Array.isArray(credential)
        )
          throw new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'VIDEO_UNAVAILABLE');
        const command: VideoJobCommand = {
          request: { ...request, parameters: effective },
          inputSnapshot: inputSnapshot(request),
        };
        if (command.inputSnapshot.length && !validateInputs)
          throw new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'VIDEO_UNAVAILABLE');
        try {
          await validateInputs?.(actor.userId, command.inputSnapshot, AbortSignal.timeout(30_000));
        } catch {
          throw new GenerationError(HTTP_STATUS.BAD_REQUEST, 'VIDEO_INPUT_INVALID');
        }
        const admitted = Object.fromEntries(
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
          ]
            .filter((key) => snapshotRecord[key] !== undefined)
            .map((key) => [key, snapshotRecord[key]]),
        );
        admitted.driver = admitted.profile;
        delete admitted.profile;
        const executionSnapshot = {
          providerConfigId: snapshotRecord.providerConfigId,
          credentialVersion: snapshotRecord.credentialVersion,
          credential,
        };
        const stored = await store.create(
          actor.userId,
          request,
          hash,
          command,
          admitted,
          executionSnapshot,
          routeSnapshot(snapshotRecord),
        );
        if (stored.created) executor.wake();
        return { created: stored.created, job: await store.get(actor.userId, stored.jobId) };
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
        if (!executor)
          throw new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'VIDEO_UNAVAILABLE');
        await store.recover(actor.userId, jobId);
        executor.wake();
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
      stopping = true;
      if (!closing)
        closing = (async () => {
          await Promise.allSettled([...active]);
        })();
      return closing;
    },
  };
}
