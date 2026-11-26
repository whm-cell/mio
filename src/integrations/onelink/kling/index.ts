import { validateImageInputByRoute } from '../../../generations/image/contracts.ts';
import type { ImageRouteConfig } from '../../../generations/image/contracts.ts';
import { withPublicHttps } from '../public-https.ts';
import {
  ASYNC_TASK_ID,
  asyncResponseObservation,
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

const KLING_IN_FLIGHT_STATUSES = new Set([
  'not_start',
  'submitted',
  'queued',
  'queueing',
  'in_progress',
  'processing',
]);
const KLING_FAILED_STATUSES = new Set(['failed', 'failure']);
const KLING_COMPLETED_STATUSES = new Set(['succeed', 'success']);

function normalizeKlingTaskStatus(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z_]+$/.test(raw)) return '';
  if (raw !== raw.toLowerCase() && raw !== raw.toUpperCase()) return '';
  return raw.toLowerCase();
}

export function createRoutedKlingImageProtocol(
  route: ImageRouteConfig,
  transport: typeof fetch = fetch,
  readImage?: ReadImage,
  download: typeof withPublicHttps = withPublicHttps,
  resultMode: ImageResultMode = 'buffer',
): AsyncImageTransport {
  return {
    async submit(input, apiKey, signal) {
      const endpoint = joinOneLinkPath(route.submitPath, 'kling-images');
      const refs = input.images ?? (input.image ? [input.image] : []);
      const refFormat = route.requestDefaults.referenceFormat ?? null;
      if (
        !endpoint ||
        input.async !== true ||
        !validateImageInputByRoute(input, route) ||
        !apiKey ||
        /[\r\n]/.test(apiKey) ||
        (refs.length > 0 &&
          (!readImage ||
            (refFormat !== 'image' && refFormat !== 'image_list') ||
            (refFormat === 'image' && refs.length > 1)))
      )
        return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
      try {
        const encodedRefs: string[] = [];
        for (const ref of refs) {
          const bytes = await readImage!(ref, signal);
          if (!matchesImageSignature(bytes, ref.contentType))
            return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
          encodedRefs.push(Buffer.from(bytes).toString('base64'));
        }
        const body: Record<string, unknown> = {
          model_name: input.model,
          prompt: input.prompt,
          n: input.n ?? 1,
        };
        if (input.aspect_ratio !== undefined) body.aspect_ratio = input.aspect_ratio;
        if (encodedRefs.length > 0) {
          if (refFormat === 'image_list') {
            body.image_list = encodedRefs.map((image) => ({ image }));
          } else if (refFormat === 'image' && encodedRefs.length === 1) {
            body.image = encodedRefs[0];
          } else {
            return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
          }
        }
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
        const data = payload ? jsonObject(payload.data) : null;
        const rawTaskId = data?.task_id;
        const validTaskId = typeof rawTaskId === 'string' && ASYNC_TASK_ID.test(rawTaskId);
        const accepted = !parsed.malformed && payload?.code === 0 && validTaskId;
        const errorCategory: AsyncImageErrorCategory = parsed.malformed
          ? 'malformed_response'
          : payload?.code !== 0
            ? 'upstream'
            : accepted
              ? 'none'
              : rawTaskId !== undefined && rawTaskId !== null
                ? 'invalid_task_id'
                : 'missing_task_id';
        const observation = asyncResponseObservation(response, payload, accepted, errorCategory);
        return accepted
          ? { state: 'submitted', upstreamTaskId: rawTaskId, observation }
          : { state: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN', observation };
      } catch {
        return {
          state: 'unknown',
          code: 'IMAGE_SUBMISSION_UNKNOWN',
          observation: { errorCategory: signal.aborted ? 'aborted' : 'transport' },
        };
      }
    },
    async query(input, apiKey, upstreamTaskId, _queryAttempt, signal) {
      const endpoint = substituteTaskId(route.queryPathTemplate, upstreamTaskId, 'kling-images');
      if (!endpoint || !apiKey || /[\r\n]/.test(apiKey))
        return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
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
        if (parsed.malformed || parsed.payload?.code !== 0)
          return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
        const data = jsonObject(parsed.payload.data);
        if (!data || typeof data.task_id !== 'string' || data.task_id !== upstreamTaskId)
          return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
        const status = normalizeKlingTaskStatus(data.task_status);
        if (KLING_IN_FLIGHT_STATUSES.has(status)) return { state: 'processing', upstreamTaskId };
        if (KLING_FAILED_STATUSES.has(status))
          return { state: 'failed', code: 'IMAGE_QUERY_FAILED' };
        const rawImages = jsonObject(data.task_result)?.images;
        if (
          !KLING_COMPLETED_STATUSES.has(status) ||
          !Array.isArray(rawImages) ||
          rawImages.length < 1 ||
          rawImages.length > (input.n ?? 1)
        )
          return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
        const images: ImageResult[] = [];
        for (const raw of rawImages) {
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
