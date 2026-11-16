import {
  IMAGE_OPERATIONS,
  validateImageInputByRoute,
  validateImageRouteConfig,
} from '@mio/compute-contracts';
import type { ImageInput, ImageOperation, ImageRouteConfig } from '@mio/compute-contracts';
import { withPublicHttps } from '../../adapters/public-https.ts';
import { createRoutedKlingImageProtocol } from './kling/index.ts';
import { submitOpenAiImage } from './openai/index.ts';
import { ASYNC_TASK_ID, sanitizeAsyncObservation, validBase64 } from './shared/index.ts';
import type {
  AsyncImageQuery,
  AsyncImageSubmission,
  AsyncImageTransport,
  ImageSubmission,
  ReadImage,
} from './shared/index.ts';
import { createRoutedViduImageProtocol } from './vidu/index.ts';
import { submitVolcengineImage } from './volcengine/index.ts';

export function defaultRouteAsyncTransport(
  route: ImageRouteConfig,
  transport: typeof fetch,
  readImage?: ReadImage,
  download: typeof withPublicHttps = withPublicHttps,
): AsyncImageTransport | undefined {
  switch (route.driver) {
    case 'vidu-images':
      return createRoutedViduImageProtocol(route, transport, readImage, download);
    case 'kling-images':
      return createRoutedKlingImageProtocol(route, transport, readImage, download);
    case 'openai-images':
    case 'volcengine-ark-images':
      return undefined;
    default: {
      const exhaustive: never = route.driver;
      void exhaustive;
      return undefined;
    }
  }
}

export function createRoutedImageProtocol(
  route: ImageRouteConfig,
  operation: string,
  transport: typeof fetch = fetch,
  readImage?: ReadImage,
  asyncTransport?: AsyncImageTransport,
  download: typeof withPublicHttps = withPublicHttps,
) {
  if (!validateImageRouteConfig(route) || !IMAGE_OPERATIONS.includes(operation as ImageOperation))
    throw new Error('IMAGE_PROTOCOL_UNSUPPORTED');
  return {
    async submitAsync(
      input: ImageInput,
      apiKey: string,
      signal?: AbortSignal,
    ): Promise<AsyncImageSubmission> {
      if (
        input.async !== true ||
        !validateImageInputByRoute(input, route) ||
        (input.operation ?? 'generate') !== operation ||
        !apiKey ||
        /[\r\n]/.test(apiKey)
      )
        return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
      if (!asyncTransport) return { state: 'rejected', code: 'IMAGE_HANDLER_UNAVAILABLE' };
      const bounded = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(180_000)])
        : AbortSignal.timeout(180_000);
      if (bounded.aborted)
        return {
          state: 'unknown',
          code: 'IMAGE_SUBMISSION_UNKNOWN',
          observation: { errorCategory: 'aborted' },
        };
      try {
        const result = await asyncTransport.submit(input, apiKey, bounded);
        const { observation: rawObservation, ...withoutObservation } = result;
        const observation = sanitizeAsyncObservation(rawObservation);
        const observed = observation ? { observation } : {};
        if (result.state === 'submitted' && !ASYNC_TASK_ID.test(result.upstreamTaskId))
          return { state: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN', ...observed };
        return { ...withoutObservation, ...observed };
      } catch {
        return {
          state: 'unknown',
          code: 'IMAGE_SUBMISSION_UNKNOWN',
          observation: { errorCategory: 'transport' },
        };
      }
    },
    async queryAsync(
      input: ImageInput,
      apiKey: string,
      upstreamTaskId: string,
      queryAttempt: number,
      signal?: AbortSignal,
    ): Promise<AsyncImageQuery> {
      if (
        input.async !== true ||
        !validateImageInputByRoute(input, route) ||
        (input.operation ?? 'generate') !== operation ||
        !apiKey ||
        /[\r\n]/.test(apiKey) ||
        !asyncTransport ||
        !ASYNC_TASK_ID.test(upstreamTaskId) ||
        !Number.isSafeInteger(queryAttempt) ||
        queryAttempt < 1 ||
        queryAttempt > 16
      )
        return { state: 'failed', code: 'IMAGE_QUERY_FAILED' };
      const bounded = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(180_000)])
        : AbortSignal.timeout(180_000);
      if (bounded.aborted) return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
      try {
        const result = await asyncTransport.query(
          input,
          apiKey,
          upstreamTaskId,
          queryAttempt,
          bounded,
        );
        if (
          (result.state === 'processing' || result.state === 'returned') &&
          (result.upstreamTaskId !== upstreamTaskId || !ASYNC_TASK_ID.test(result.upstreamTaskId))
        )
          return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
        if (
          result.state === 'returned' &&
          (!Array.isArray(result.images) ||
            result.images.length > (input.n ?? 1) ||
            result.images.some(
              (image) =>
                image !== null &&
                (!validBase64(image.base64) ||
                  (image.format !== undefined &&
                    !['png', 'jpeg', 'webp'].includes(String(image.format)))),
            ))
        )
          return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
        return result;
      } catch {
        return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
      }
    },
    async submit(
      input: ImageInput,
      apiKey: string,
      signal?: AbortSignal,
      read?: ReadImage,
    ): Promise<ImageSubmission> {
      if (
        !validateImageInputByRoute(input, route) ||
        (input.operation ?? 'generate') !== operation ||
        !apiKey ||
        /[\r\n]/.test(apiKey)
      )
        return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
      const deadline = AbortSignal.timeout(180_000);
      const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      if (bounded.aborted) return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
      switch (route.driver) {
        case 'openai-images':
          return submitOpenAiImage(
            route,
            operation,
            input,
            apiKey,
            bounded,
            transport,
            read ?? readImage,
          );
        case 'volcengine-ark-images':
          return submitVolcengineImage(
            route,
            operation,
            input,
            apiKey,
            bounded,
            transport,
            read ?? readImage,
            download,
          );
        case 'vidu-images':
        case 'kling-images':
          return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
        default: {
          const exhaustive: never = route.driver;
          void exhaustive;
          return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
        }
      }
    },
  };
}
