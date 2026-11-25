import { createLogger } from '@mio/foundation/logging';
import { epochMs } from '@mio/foundation/time';
import type { AccountCredentialSnapshot } from '../../providers/contracts.ts';
import type { ProviderService } from '../../providers/service.ts';
import type { VideoExecutionStore } from './execution-store.ts';
import type {
  VideoExecution,
  VideoMaterializer,
  VideoProtocolFactory,
  VideoResultSource,
  VideoSubmissionReceipt,
} from './execution.ts';
import { hasVideoQueryBudget, isVideoUpstreamTaskId } from './execution.ts';
import type { VideoSubmissionReceipts } from './submission-receipts.ts';

const log = createLogger('app', 'video-runner');

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

  const materializeResult = async (row: VideoExecution) => {
    if (!row.checkpoint?.videos.length || !(await store.beginMaterialization(row))) {
      await store.terminal(row, 'materialization_failed', 'VIDEO_MATERIALIZATION_FAILED');
      return;
    }
    const bounded = AbortSignal.any([stop, AbortSignal.timeout(180_000)]);
    try {
      const outputs = await materialize(row, row.checkpoint.videos, bounded);
      bounded.throwIfAborted();
      if (await store.complete(row, outputs)) await verify(row);
    } catch {
      // The persisted URL checkpoint survives restarts; the store limits attempts to three.
      await store.release(row);
      if (!stop.aborted) log.error('VIDEO_MATERIALIZATION_PENDING');
    }
  };

  const returned = async (row: VideoExecution, videos: VideoResultSource[]) => {
    if (
      !videos.length ||
      videos.length > 16 ||
      videos.some((video) => typeof video.url !== 'string')
    ) {
      await store.terminal(row, 'failed', 'VIDEO_RESULT_INVALID');
      return;
    }
    if (!(await store.returned(row, videos))) return;
    await materializeResult({
      ...row,
      phase: 'materializing',
      checkpoint: { videos, materializationAttempts: 0 },
    });
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
