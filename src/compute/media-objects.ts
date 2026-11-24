import type { AssetObjectStore } from '../assets/contracts.ts';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { MediaError } from './media-model.ts';

/** HEAD has no SDK abort API; losing the race detaches its result and forbids later commits. */
export function mediaHead(
  objects: AssetObjectStore,
  key: string,
  signal: AbortSignal,
): ReturnType<AssetObjectStore['head']> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void objects
      .head(key)
      .then(resolve, () => {
        reject(new MediaError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_STORAGE_UNAVAILABLE'));
      })
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
