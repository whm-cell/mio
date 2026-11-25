import type { VideoDriver } from '../../../generations/video/contracts.ts';
import type { VideoQueryResult } from '../../../generations/video/execution.ts';
import { object, operationPath, resultUrls, TASK_ID, ONELINK_ORIGIN } from './shared.ts';

const invalid: VideoQueryResult = { state: 'failed', code: 'VIDEO_RESPONSE_INVALID' };
const failed: VideoQueryResult = { state: 'failed', code: 'VIDEO_UPSTREAM_FAILED' };

export function submissionTask(
  driver: VideoDriver,
  data: Record<string, unknown>,
): string | undefined {
  if (driver === 'veo-videos') return operationPath(data.name);
  const inner = object(data.data);
  const output = object(data.output);
  const id =
    driver === 'kling-videos'
      ? inner.task_id
      : driver === 'happyhorse-videos'
        ? (output.task_id ?? data.task_id)
        : (data.id ?? data.task_id ?? inner.id ?? inner.task_id);
  if (driver === 'kling-videos' && data.code !== 0) return;
  return typeof id === 'string' && TASK_ID.test(id) ? id : undefined;
}

function returned(values: unknown[]): VideoQueryResult {
  const videos = resultUrls(values);
  return videos ? { state: 'returned', videos } : invalid;
}

function ark(data: Record<string, unknown>): VideoQueryResult {
  const task = typeof data.status === 'string' ? data : object(data.data);
  if (['queued', 'pending', 'running', 'processing'].includes(String(task.status)))
    return { state: 'processing' };
  if (['failed', 'cancelled', 'canceled', 'expired'].includes(String(task.status))) return failed;
  if (task.status !== 'succeeded') return invalid;
  return returned([object(task.content).video_url]);
}

function kling(data: Record<string, unknown>): VideoQueryResult {
  if (data.code !== 0) return failed;
  const task = object(data.data);
  if (['submitted', 'processing', 'running'].includes(String(task.task_status)))
    return { state: 'processing' };
  if (['failed', 'cancelled', 'canceled'].includes(String(task.task_status))) return failed;
  if (task.task_status !== 'succeed') return invalid;
  const videos = object(task.task_result).videos;
  return Array.isArray(videos) ? returned(videos.map((video) => object(video).url)) : invalid;
}

function vidu(data: Record<string, unknown>): VideoQueryResult {
  if (['created', 'queueing', 'queued', 'processing', 'running'].includes(String(data.state)))
    return { state: 'processing' };
  if (['failed', 'cancelled', 'canceled'].includes(String(data.state))) return failed;
  if (data.state !== 'success' || !Array.isArray(data.creations)) return invalid;
  return returned(
    data.creations.map((creation) => object(creation).url ?? object(creation).watermarked_url),
  );
}

function happyhorse(data: Record<string, unknown>): VideoQueryResult {
  const output = object(data.output);
  const status = output.task_status ?? data.task_status;
  if (['PENDING', 'RUNNING', 'QUEUED', 'PROCESSING'].includes(String(status).toUpperCase()))
    return { state: 'processing' };
  if (['FAILED', 'CANCELED', 'CANCELLED', 'UNKNOWN'].includes(String(status).toUpperCase()))
    return failed;
  if (String(status).toUpperCase() !== 'SUCCEEDED') return invalid;
  return returned([output.video_url ?? data.video_url]);
}

function veo(data: Record<string, unknown>): VideoQueryResult {
  if (data.done === false || (data.done === undefined && operationPath(data.name)))
    return { state: 'processing' };
  if (data.done !== true) return invalid;
  if (data.error !== undefined) return failed;
  const response = object(data.response);
  const generation = object(response.generateVideoResponse);
  const samples = generation.generatedSamples ?? response.generatedVideos ?? response.videos;
  if (!Array.isArray(samples)) return invalid;
  const urls = samples.map((sample) => {
    const value = object(sample);
    return object(value.video).uri ?? value.uri;
  });
  // Private files and inline bytes require a distinct credential-aware media consumer.
  // A plain URL checkpoint must never pretend that such a result is publicly downloadable.
  if (urls.some((url) => typeof url !== 'string'))
    return { state: 'failed', code: 'VIDEO_INLINE_RESULT_UNSUPPORTED' };
  if (
    urls.some((url) => {
      try {
        return new URL(String(url)).origin === ONELINK_ORIGIN;
      } catch {
        return false;
      }
    })
  )
    return { state: 'failed', code: 'VIDEO_AUTHENTICATED_RESULT_UNSUPPORTED' };
  return returned(urls);
}

export function videoQueryResult(
  driver: VideoDriver,
  data: Record<string, unknown>,
): VideoQueryResult {
  if (driver === 'volcengine-ark-videos') return ark(data);
  if (driver === 'kling-videos') return kling(data);
  if (driver === 'vidu-videos') return vidu(data);
  if (driver === 'veo-videos') return veo(data);
  return happyhorse(data);
}
