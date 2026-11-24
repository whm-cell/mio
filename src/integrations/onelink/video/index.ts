import type { VideoRouteConfig } from '../../../providers/contracts.ts';
import {
  validateVideoParameters,
  validateVideoRouteConfig,
} from '../../../providers/onelink/video-route.ts';
import type {
  VideoProtocol,
  VideoQueryResult,
  VideoSubmitResult,
} from '../../../generations/video-execution.ts';
import { endpoint, operationPath, readJson, TASK_ID } from './shared.ts';
import { videoSubmission } from './payload.ts';
import { submissionTask, videoQueryResult } from './response.ts';

export type {
  VideoProtocol,
  VideoQueryResult,
  VideoSubmitResult,
} from '../../../generations/video-execution.ts';

const KLING_QUERY_PATHS = new Set([
  '/kling/v1/videos/text2video',
  '/kling/v1/videos/image2video',
  '/kling/v1/videos/omni-video',
]);

function queryPath(route: VideoRouteConfig, taskId: string): string | undefined {
  if (route.driver === 'veo-videos') return operationPath(taskId);
  if (route.driver === 'kling-videos') {
    try {
      const token: unknown = JSON.parse(taskId);
      if (!token || typeof token !== 'object' || Array.isArray(token)) return;
      const value = token as Record<string, unknown>;
      if (
        Object.keys(value).length !== 2 ||
        typeof value.path !== 'string' ||
        !KLING_QUERY_PATHS.has(value.path) ||
        typeof value.id !== 'string' ||
        !TASK_ID.test(value.id)
      )
        return;
      return value.path + '/' + encodeURIComponent(value.id);
    } catch {
      return;
    }
  }
  if (!TASK_ID.test(taskId)) return;
  return route.queryPathTemplate.replace('{task_id}', encodeURIComponent(taskId));
}

function rejection(status: number): string {
  if (status === 401 || status === 403) return 'VIDEO_AUTH';
  if (status === 429) return 'VIDEO_LIMITED';
  return 'VIDEO_REJECTED';
}

/** One POST per durable intent. Polling retains the exact task and protocol context. */
export function createVideoProtocol(
  route: VideoRouteConfig,
  modelId: string,
  transport: typeof fetch = fetch,
): VideoProtocol {
  const validated = validateVideoRouteConfig({ ...route, editPath: null });
  if (!validated || !/^[A-Za-z0-9._:-]{1,256}$/.test(modelId))
    throw new Error('VIDEO_ROUTE_INVALID');
  return {
    async submit(parameters, refs, key, signal): Promise<VideoSubmitResult> {
      if (!validateVideoParameters(parameters, validated))
        return { state: 'rejected', code: 'VIDEO_INPUT_INVALID' };
      let submission;
      try {
        submission = videoSubmission(validated, modelId, parameters, refs);
      } catch {
        return { state: 'rejected', code: 'VIDEO_INPUT_INVALID' };
      }
      try {
        signal.throwIfAborted();
        const response = await transport(endpoint(submission.path), {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + key,
            ...submission.headers,
          },
          body: JSON.stringify(submission.body),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return response.status >= 400 && response.status < 500 && response.status !== 408
            ? { state: 'rejected', code: rejection(response.status) }
            : { state: 'unknown', code: 'VIDEO_SUBMISSION_UNKNOWN' };
        }
        const data = await readJson(response);
        const id = submissionTask(validated.driver, data);
        if (!id) return { state: 'unknown', code: 'VIDEO_SUBMISSION_UNKNOWN' };
        const upstreamTaskId =
          validated.driver === 'kling-videos' ? JSON.stringify({ path: submission.path, id }) : id;
        return { state: 'submitted', upstreamTaskId };
      } catch {
        return { state: 'unknown', code: 'VIDEO_SUBMISSION_UNKNOWN' };
      }
    },
    async query(taskId, key, signal): Promise<VideoQueryResult> {
      const path = queryPath(validated, taskId);
      if (!path) return { state: 'failed', code: 'VIDEO_TASK_INVALID' };
      try {
        signal.throwIfAborted();
        const response = await transport(endpoint(path), {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: { Authorization: 'Bearer ' + key },
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status >= 500 || response.status === 429 || response.status === 408)
            return { state: 'processing' };
          return { state: 'failed', code: rejection(response.status) };
        }
        return videoQueryResult(validated.driver, await readJson(response));
      } catch {
        return { state: 'processing' };
      }
    },
  };
}
