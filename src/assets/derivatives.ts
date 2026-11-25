import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { ComputeError } from '../compute/errors.ts';
import { MediaError } from '../compute/media-model.ts';
import type { AssetPrincipal } from './contracts.ts';
import type { AssetStore } from './store.ts';

const log = createLogger('app', 'asset-derivatives');

interface DerivativeAdmission {
  create(
    owner: AssetPrincipal,
    request: {
      requestId: string;
      operation: 'video.derivatives';
      inputs: [{ assetId: string }];
      parameters: { profile: 'ordinary' };
    },
  ): Promise<{ job: { jobId: string } }>;
}

/** The stable request ID recovers an admission committed before the link update. */
export function startAssetDerivatives(
  store: Pick<AssetStore, 'claimDerivative' | 'linkDerivative' | 'rejectDerivative'>,
  media: DerivativeAdmission,
) {
  let stopping = false;
  let active: Promise<void> | undefined;
  const poll = () => {
    if (stopping || active) return;
    active = (async () => {
      for (let index = 0; index < 10 && !stopping; index++) {
        const intent = await store.claimDerivative();
        if (!intent || stopping) return;
        try {
          const result = await media.create(
            { userId: intent.owner_id, sessionId: 'asset-derivative-intent' },
            {
              requestId: intent.request_id,
              operation: 'video.derivatives',
              inputs: [{ assetId: intent.asset_id }],
              parameters: { profile: intent.profile },
            },
          );
          await store.linkDerivative(intent, result.job.jobId);
        } catch (error) {
          if (
            error instanceof MediaError &&
            (error.status === HTTP_STATUS.BAD_REQUEST ||
              error.status === HTTP_STATUS.NOT_FOUND ||
              error.status === HTTP_STATUS.CONFLICT)
          ) {
            await store.rejectDerivative(intent, error.code);
          } else if (!(
            error instanceof ComputeError && error.status === HTTP_STATUS.TOO_MANY_REQUESTS
          )) {
            log.warn('DERIVATIVE_ADMISSION_PENDING');
          }
        }
      }
    })()
      .catch(() => log.error('DERIVATIVE_SCHEDULER_ERROR'))
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(poll, 5000);
  timer.unref();
  poll();
  return {
    async close(): Promise<void> {
      stopping = true;
      clearInterval(timer);
      await active;
    },
  };
}
