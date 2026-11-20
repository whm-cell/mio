import type { ImageRouteConfig } from '../../../generations/contracts.ts';
import { withPublicHttps } from '../public-https.ts';
import {
  ASYNC_TASK_ID,
  asyncResponseObservation,
  dataUrlFromBytes,
  downloadResultImage,
  joinOneLinkPath,
  jsonObject,
  matchesImageSignature,
  readAsyncJson,
  rejectAsyncSubmissionHttp,
  substituteTaskId,
} from '../shared/index.ts';
import type {
  AsyncImageErrorCategory,
  AsyncImageTransport,
  ImageResult,
  ImageResultMode,
  ReadImage,
} from '../shared/index.ts';

export function createRoutedViduImageProtocol(
  route: ImageRouteConfig,
  transport: typeof fetch = fetch,
  readImage?: ReadImage,
  download: typeof withPublicHttps = withPublicHttps,
  resultMode: ImageResultMode = 'buffer',
): AsyncImageTransport {
  return {
    async submit(input, apiKey, signal) {
      const refs = input.images ?? (input.image ? [input.image] : []);
      const endpoint = joinOneLinkPath(route.submitPath, 'vidu-images');
      if (
        !endpoint ||
        input.async !== true ||
        refs.length > route.paramSpec.maxReferenceImages ||
        (refs.length > 0 && !readImage)
      )
        return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
      try {
        const images: string[] = [];
        for (const ref of refs) {
          const bytes = await readImage!(ref, signal);
          if (!matchesImageSignature(bytes, ref.contentType))
            return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
          images.push(dataUrlFromBytes(bytes, ref.contentType));
        }
        const body: Record<string, unknown> = { model: input.model, prompt: input.prompt };
        if (images.length) body.images = images.length === 1 ? images[0] : images;
        if (
          input.size &&
          (route.paramSpec.allowedSizes === null ||
            route.paramSpec.allowedSizes.includes(input.size))
        )
          body.resolution = input.size;
        if (input.aspect_ratio && route.paramSpec.allowedAspectRatios.includes(input.aspect_ratio))
          body.aspect_ratio = input.aspect_ratio;
        const response = await transport(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const parsed = await readAsyncJson(response);
        const payload = parsed.payload;
        if (!response.ok) return rejectAsyncSubmissionHttp(response, payload);
        const taskId = payload?.task_id;
        const taskIdPresent = typeof taskId === 'string' && ASYNC_TASK_ID.test(taskId);
        const errorCategory: AsyncImageErrorCategory = parsed.malformed
          ? 'malformed_response'
          : taskIdPresent
            ? 'none'
            : typeof taskId === 'string'
              ? 'invalid_task_id'
              : 'missing_task_id';
        const observation = asyncResponseObservation(
          response,
          payload,
          taskIdPresent,
          errorCategory,
        );
        return taskIdPresent
          ? { state: 'submitted', upstreamTaskId: taskId, observation }
          : { state: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN', observation };
      } catch {
        return {
          state: 'unknown',
          code: 'IMAGE_SUBMISSION_UNKNOWN',
          observation: { errorCategory: 'transport' },
        };
      }
    },
    async query(input, apiKey, upstreamTaskId, _queryAttempt, signal) {
      const endpoint = substituteTaskId(route.queryPathTemplate, upstreamTaskId, 'vidu-images');
      if (!endpoint) return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
      try {
        const response = await transport(endpoint, {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (response.status === 404) {
          await response.body?.cancel().catch(() => {});
          return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return response.status === 401 || response.status === 403
            ? { state: 'failed', code: 'IMAGE_QUERY_FAILED' }
            : { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
        }
        const parsed = await readAsyncJson(response);
        const payload = parsed.payload;
        if (
          parsed.malformed ||
          !payload ||
          ('id' in payload && (typeof payload.id !== 'string' || payload.id !== upstreamTaskId))
        )
          return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
        const state = payload.state;
        if (state === 'created' || state === 'queueing' || state === 'processing')
          return { state: 'processing', upstreamTaskId };
        if (state === 'failed') return { state: 'failed', code: 'IMAGE_QUERY_FAILED' };
        if (
          state !== 'success' ||
          !Array.isArray(payload?.creations) ||
          !payload.creations.length ||
          payload.creations.length > (input.n ?? 1)
        )
          return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
        const images: ImageResult[] = [];
        for (const raw of payload.creations) {
          const image = await downloadResultImage(
            jsonObject(raw)?.url,
            download,
            signal,
            resultMode,
          );
          if (!image) return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
          images.push(image);
        }
        return { state: 'returned', upstreamTaskId, images };
      } catch {
        return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
      }
    },
  };
}
