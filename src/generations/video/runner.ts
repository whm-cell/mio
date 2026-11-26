import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@mio/foundation/logging';
import { epochMs } from '@mio/foundation/time';
import type { AccountCredentialSnapshot } from '../../providers/contracts.ts';
import type { ProviderService } from '../../providers/service.ts';
import type { VideoExecutionStore } from './execution-store.ts';
import type {
  VideoExecution,
  VideoMaterializer,
  VideoProtocolFactory,
  VideoQueryResult,
  VideoRecoveryQuery,
  VideoResultSource,
  VideoSubmissionReceipt,
} from './execution.ts';
import {
  hasVideoQueryBudget,
  hasVideoResultUrl,
  isVideoUpstreamTaskId,
  VIDEO_INVALID_OUTPUT_ERRORS,
  VIDEO_MATERIALIZATION_MAX_ATTEMPTS,
  VideoProtocolRouteInvalid,
  VideoResultUrlExpired,
} from './execution.ts';
import type { VideoSubmissionReceipts } from './submission-receipts.ts';

const log = createLogger('app', 'video-runner');
const MATERIALIZATION_ERRORS = new Set([
  ...VIDEO_INVALID_OUTPUT_ERRORS,
  'VIDEO_CHECKPOINT_INVALID',
  'VIDEO_DIRECTORY_INVALID',
  'VIDEO_DISK_FULL',
  'VIDEO_DOWNLOAD_FAILED',
  'VIDEO_DOWNLOAD_INCOMPLETE',
  'VIDEO_EXECUTION_TIMEOUT',
  'VIDEO_FILE_INVALID',
  'VIDEO_OBJECT_MISMATCH',
  'VIDEO_PROBE_BUSY',
  'VIDEO_PROBE_FAILED',
  'VIDEO_PROBE_PUBLISH_FAILED',
  'VIDEO_PROBE_TIMEOUT',
  'VIDEO_RESULT_INVALID',
  'VIDEO_SOURCE_CHANGED',
  'VIDEO_SOURCE_TOO_LARGE',
  'VIDEO_STORAGE_FAILED',
  'VIDEO_STORAGE_FAILURE',
  'VIDEO_STORAGE_UNAVAILABLE',
  'VIDEO_TOO_LARGE',
  'VIDEO_WORKER_INTERRUPTED',
]);

export type VideoExecutorProvider = Pick<
  ProviderService,
  'resolveImageTaskCredential' | 'recordVerification' | 'snapshotVideo'
> & {
  openImageSnapshot(ownerId: string, snapshot: AccountCredentialSnapshot): string;
};

export interface VideoTransports {
  protocol: VideoProtocolFactory;
  transport?: typeof fetch;
  cleanup?: (row: VideoExecution, signal: AbortSignal) => Promise<void>;
  references?: (row: VideoExecution, signal: AbortSignal) => Promise<Record<string, string>>;
}

export function createVideoRunner(
  store: VideoExecutionStore,
  provider: () => VideoExecutorProvider | undefined,
  materialize: VideoMaterializer,
  stop: AbortSignal,
  transports: VideoTransports,
  receipts: VideoSubmissionReceipts,
) {
  const receive = (receipt: VideoSubmissionReceipt, canReplay: boolean) =>
    store.receive(receipt, canReplay);
  const verify = async (row: VideoExecution) => {
    const admitted = row.admitted;
    if (
      typeof admitted.providerConfigId !== 'string' ||
      typeof admitted.modelKey !== 'string' ||
      typeof admitted.credentialVersion !== 'number' ||
      typeof admitted.catalogVersion !== 'number' ||
      typeof admitted.adaptationVersion !== 'number' ||
      typeof admitted.driver !== 'string'
    )
      return;
    await provider()
      ?.recordVerification(
        { userId: row.owner_id },
        {
          providerConfigId: admitted.providerConfigId,
          modelKey: admitted.modelKey,
          credentialVersion: admitted.credentialVersion,
          catalogVersion: admitted.catalogVersion,
          adaptationVersion: admitted.adaptationVersion,
          operation: 'video.generate',
          profile: admitted.driver,
        },
        'video:' + row.id,
      )
      .catch(() => log.error('VIDEO_VERIFICATION_UNAVAILABLE'));
  };

  const materializeOutput = async (
    row: VideoExecution,
    video: { url: string },
    index: number,
    freshResult: boolean,
  ) => {
    let errorCode = 'VIDEO_MATERIALIZATION_FAILED';
    try {
      const output = await materialize(row, video, index, stop, freshResult);
      const phase = await store.writeOutput(row, index, output, stop);
      return { phase, errorCode: null };
    } catch (error) {
      stop.throwIfAborted();
      if (error instanceof VideoResultUrlExpired) errorCode = 'VIDEO_RESULT_URL_EXPIRED';
      else if (error instanceof Error && MATERIALIZATION_ERRORS.has(error.message))
        errorCode = error.message;
    }
    const phase = await store.writeOutput(row, index, errorCode, stop);
    return { phase, errorCode };
  };

  const recoveryQuery = async (
    row: VideoExecution,
    taskId: string,
    key: string,
    dispatchBefore: Date,
  ) => {
    const bounded = AbortSignal.any([stop, AbortSignal.timeout(60_000)]);
    const { route, modelId } = row.route_snapshot;
    let sent = false;
    let dispatchExpired = false;
    try {
      const protocol = transports.protocol(route, modelId, async (url, options) => {
        if (sent || options?.method !== 'GET' || epochMs() >= dispatchBefore.getTime()) {
          dispatchExpired = true;
          throw new Error('VIDEO_RECOVERY_QUERY_DISPATCH_EXPIRED');
        }
        bounded.throwIfAborted();
        sent = true;
        return (transports.transport ?? fetch)(url, options);
      });
      const result = await protocol.query(taskId, key, bounded);
      stop.throwIfAborted();
      if (bounded.aborted) return { state: 'retry', code: 'VIDEO_QUERY_TIMEOUT' } as const;
      if (!dispatchExpired) return result;
    } catch (error) {
      stop.throwIfAborted();
      if (error instanceof VideoProtocolRouteInvalid)
        return { state: 'failed', code: 'VIDEO_TASK_INVALID' } as const;
      if (!dispatchExpired) return { state: 'retry', code: 'VIDEO_QUERY_NETWORK_ERROR' } as const;
    }
    return { state: 'failed', code: 'VIDEO_RECOVERY_QUERY_DISPATCH_EXPIRED' } as const;
  };

  const refreshExpired = async (
    row: VideoExecution,
    videos: VideoResultSource[],
    expired: Set<number>,
  ) => {
    const taskId = row.upstream_task_id;
    if (
      !expired.size ||
      row.checkpoint?.recoveryQuery?.state !== 'available' ||
      !isVideoUpstreamTaskId(taskId)
    )
      return false;
    const refreshAt = row.checkpoint.refreshAt;
    const wait = refreshAt ? Date.parse(refreshAt) - epochMs() + 1 : 0;
    if (wait > 0) await delay(wait, undefined, { signal: stop });
    stop.throwIfAborted();
    const key = await provider()
      ?.resolveImageTaskCredential(row.owner_id)
      .catch(() => undefined);
    stop.throwIfAborted();
    if (!key) return false;
    const dispatchBefore = await store.reserveRecoveryQuery(row, taskId);
    if (!dispatchBefore) return false;
    stop.throwIfAborted();
    const result: VideoQueryResult = await recoveryQuery(row, taskId, key, dispatchBefore);
    const nextVideos = [...videos];
    const recovery: VideoRecoveryQuery = { state: 'reserved' };
    if (result.state === 'processing') recovery.errorCode = 'VIDEO_RECOVERY_NOT_READY';
    else if (result.state !== 'returned') recovery.errorCode = result.code;
    else if (result.videos.length !== videos.length)
      recovery.errorCode = 'VIDEO_RECOVERY_RESULT_MISMATCH';
    else {
      for (const index of expired) {
        const previous = videos[index];
        const replacement = result.videos[index];
        if (
          hasVideoResultUrl(previous) &&
          hasVideoResultUrl(replacement) &&
          previous.url !== replacement.url
        ) {
          nextVideos[index] = replacement;
          (recovery.refreshed ??= {})[index] = 'pending';
        }
      }
      if (!recovery.refreshed) recovery.errorCode = 'VIDEO_RECOVERY_RESULT_UNCHANGED';
    }
    const saved = await store.finishRecoveryQuery(row, nextVideos, recovery);
    return saved && recovery.refreshed !== undefined;
  };

  const materializePass = async (
    row: VideoExecution,
    videos: VideoResultSource[],
    freshResult: boolean,
  ) => {
    const progress = await store.outputProgress(row.id);
    const refreshed = row.checkpoint?.recoveryQuery?.refreshed;
    const expired = new Set(Object.keys(row.checkpoint?.expired ?? {}).map(Number));
    const invalid = { ...row.checkpoint?.invalidOutputs };
    const needsPass = (video: VideoResultSource, index: number) =>
      hasVideoResultUrl(video) &&
      progress.get(index) !== 'registered' &&
      !refreshed?.[index] &&
      !expired.has(index) &&
      !invalid[index];
    const attempt = await store.beginMaterialization(row, videos.some(needsPass));
    if (!attempt) return;
    const freshPass = freshResult && attempt.reserved && attempt.attempts === 1;
    for (const [index, video] of videos.entries()) {
      stop.throwIfAborted();
      if (progress.get(index) === 'registered' || refreshed?.[index] === 'finished') continue;
      const hasUrl = hasVideoResultUrl(video);
      if (
        hasUrl &&
        (refreshed?.[index] === 'pending' || (attempt.reserved && needsPass(video, index)))
      ) {
        const output = await materializeOutput(row, video, index, freshPass);
        if (!output.phase) return;
        progress.set(index, output.phase);
        if (output.phase === 'failed' && output.errorCode !== null) {
          if (output.errorCode === 'VIDEO_RESULT_URL_EXPIRED') expired.add(index);
          else if (VIDEO_INVALID_OUTPUT_ERRORS.has(output.errorCode)) invalid[index] = true;
        }
      } else if (!progress.has(index)) {
        const code = hasUrl ? 'VIDEO_MATERIALIZATION_LIMIT' : 'VIDEO_RESULT_INVALID';
        const phase = await store.writeOutput(row, index, code, stop);
        if (!phase) return;
        progress.set(index, phase);
      }
    }
    if (
      (await refreshExpired(row, videos, expired)) ||
      (attempt.attempts < VIDEO_MATERIALIZATION_MAX_ATTEMPTS && videos.some(needsPass))
    ) {
      await store.release(row);
      return;
    }
    const registered = videos.filter(
      (_video, index) => progress.get(index) === 'registered',
    ).length;
    if (registered === videos.length) {
      if (await store.terminal(row, 'completed', null, stop)) await verify(row);
    } else if (registered > 0) await store.terminal(row, 'partial', null, stop);
    else await store.terminal(row, 'materialization_failed', 'VIDEO_MATERIALIZATION_FAILED', stop);
  };

  const materializeResult = async (row: VideoExecution, freshResult = false) => {
    try {
      stop.throwIfAborted();
      const videos = row.checkpoint?.videos;
      if (Array.isArray(videos) && videos.length > 0 && videos.length <= 16)
        await materializePass(row, videos, freshResult);
      else
        await store.terminal(row, 'materialization_failed', 'VIDEO_MATERIALIZATION_FAILED', stop);
    } catch {
      // Committed indices survive claim release. The next claim uses the existing checkpoints.
      await store.release(row);
      if (!stop.aborted) log.error('VIDEO_MATERIALIZATION_PENDING');
    }
  };

  const returned = async (row: VideoExecution, videos: VideoResultSource[]) => {
    if (!videos.length || videos.length > 16 || !videos.some(hasVideoResultUrl)) {
      await store.terminal(row, 'failed', 'VIDEO_RESULT_INVALID');
      return;
    }
    if (!(await store.returned(row, videos))) return;
    await materializeResult(
      {
        ...row,
        phase: 'materializing',
        checkpoint: { videos, materializationAttempts: 0 },
      },
      true,
    );
  };

  const submit = async (row: VideoExecution) => {
    const providers = provider();
    if (!providers || !row.snapshot.credential) {
      await store.terminal(row, 'rejected', 'VIDEO_CREDENTIAL_UNAVAILABLE');
      return;
    }
    const bounded = AbortSignal.any([stop, AbortSignal.timeout(180_000)]);
    const route = row.route_snapshot;
    const protocol = transports.protocol(route.route, route.modelId, async (url, options) => {
      bounded.throwIfAborted();
      return (transports.transport ?? fetch)(url, options);
    });
    let refs: Record<string, string>;
    let key: string;
    try {
      await receipts.prepare();
      bounded.throwIfAborted();
      refs = transports.references ? await transports.references(row, bounded) : {};
      bounded.throwIfAborted();
      if (row.command.inputSnapshot.some((input) => !refs[input.assetId]))
        throw new Error('VIDEO_INPUT_UNAVAILABLE');
      // Signing may wait on COS. Check the owner's current admission after it finishes.
      const current = await providers.snapshotVideo(
        { userId: row.owner_id },
        row.command.request.modelRef,
      );
      bounded.throwIfAborted();
      if (
        current.capabilitiesVersion !== row.command.request.expectedCapabilitiesVersion ||
        current.credentialVersion !== row.snapshot.credentialVersion
      )
        throw new Error('VIDEO_ADMISSION_CHANGED');
      key = providers.openImageSnapshot(row.owner_id, row.snapshot);
    } catch {
      if (stop.aborted) await store.release(row);
      else await store.terminal(row, 'rejected', 'VIDEO_INPUT_OR_CREDENTIAL_UNAVAILABLE');
      return;
    }
    if (stop.aborted) {
      await store.release(row);
      return;
    }
    // This transition commits before protocol.submit. A resumed intent only reconciles receipts.
    if (!(await store.submitting(row))) return;
    let result;
    try {
      bounded.throwIfAborted();
      result = await protocol.submit(row.command.request.parameters, refs, key, bounded);
    } catch {
      await store.terminal(row, 'unknown', 'VIDEO_SUBMISSION_UNKNOWN');
      return;
    }
    if (result.state === 'submitted') {
      if (
        !isVideoUpstreamTaskId(result.upstreamTaskId) ||
        !(await receipts.record(
          {
            version: 1,
            jobId: row.id,
            ownerId: row.owner_id,
            requestId: row.command.request.requestId,
            upstreamTaskId: result.upstreamTaskId,
          },
          receive,
        ))
      )
        await store.terminal(row, 'unknown', 'VIDEO_SUBMISSION_UNKNOWN');
    } else await store.terminal(row, result.state, result.code);
  };

  const query = async (claimed: VideoExecution) => {
    const taskId = claimed.upstream_task_id;
    if (taskId === null || !hasVideoQueryBudget(claimed)) {
      await store.queryLimit(claimed);
      return;
    }
    const key = await provider()
      ?.resolveImageTaskCredential(claimed.owner_id)
      .catch(() => undefined);
    if (stop.aborted) {
      await store.release(claimed);
      return;
    }
    if (!key) {
      await store.continueQuery(claimed, 'VIDEO_QUERY_CREDENTIAL_UNAVAILABLE');
      return;
    }
    const row = hasVideoQueryBudget(claimed) ? await store.beginQuery(claimed) : undefined;
    if (!row) {
      await store.queryLimit(claimed);
      return;
    }
    if (stop.aborted) {
      await store.release(row);
      return;
    }
    const deadline = row.async_deadline!.getTime();
    const remaining = deadline - epochMs();
    if (remaining <= 0) {
      await store.queryLimit(row);
      return;
    }
    const bounded = AbortSignal.any([stop, AbortSignal.timeout(Math.min(60_000, remaining))]);
    const route = row.route_snapshot;
    const dispatchBefore = row.next_query_at.getTime();
    const dispatch: { state: 'pending' | 'sent' | 'deadline' | 'reservation' } = {
      state: 'pending',
    };
    const protocol = transports.protocol(route.route, route.modelId, async (url, options) => {
      // Timers and lease loss notifications can be delayed. Guard the actual send
      // with both the absolute budget and the durable reservation's dispatch window.
      const now = epochMs();
      if (now >= deadline || now >= dispatchBefore) {
        dispatch.state = now >= deadline ? 'deadline' : 'reservation';
        throw new Error('VIDEO_QUERY_DISPATCH_EXPIRED');
      }
      bounded.throwIfAborted();
      dispatch.state = 'sent';
      return (transports.transport ?? fetch)(url, options);
    });
    const result = await protocol.query(taskId, key, bounded).catch((error: unknown) => {
      if (!stop.aborted && dispatch.state !== 'deadline' && dispatch.state !== 'reservation')
        throw error;
      return undefined;
    });
    const settledAt = epochMs();
    if (dispatch.state === 'deadline' || (dispatch.state !== 'sent' && settledAt >= deadline))
      await store.queryLimit(row);
    else if (
      !result ||
      dispatch.state === 'reservation' ||
      (dispatch.state === 'pending' && settledAt >= dispatchBefore)
    )
      await store.release(row);
    // An already classified reply may be the last permitted attempt even during shutdown.
    else if (result.state === 'returned') await returned(row, result.videos);
    else if (result.state === 'unknown') await store.terminal(row, 'unknown', result.code);
    else if (result.state === 'processing' || result.state === 'retry')
      await store.continueQuery(row, result.state === 'retry' ? result.code : null);
    else await store.terminal(row, 'failed', result.code);
  };

  return async (row: VideoExecution): Promise<void> => {
    if (stop.aborted) {
      await store.release(row);
      return;
    }
    if (row.phase === 'ready') await submit(row);
    else if (row.phase === 'waiting') await query(row);
    else if (row.phase === 'materializing') await materializeResult(row);
    else if (row.phase === 'submitting' && !(await receipts.recover(row.id, receive)))
      await store.terminal(row, 'unknown', 'VIDEO_SUBMISSION_UNKNOWN');
  };
}
