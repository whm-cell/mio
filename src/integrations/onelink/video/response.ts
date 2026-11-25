import type { VideoDriver } from '../../../generations/video/contracts.ts';
import type { VideoQueryResult } from '../../../generations/video/execution.ts';
import { object, operationPath, resultUrls, TASK_ID, ONELINK_ORIGIN } from './shared.ts';

const invalid: VideoQueryResult = { state: 'failed', code: 'VIDEO_RESPONSE_INVALID' };
const failed: VideoQueryResult = { state: 'failed', code: 'VIDEO_UPSTREAM_FAILED' };
const identityInvalid: VideoQueryResult = {
  state: 'unknown',
  code: 'VIDEO_QUERY_IDENTITY_INVALID',
};
const statusUnknown: VideoQueryResult = { state: 'unknown', code: 'VIDEO_QUERY_STATUS_UNKNOWN' };
const KLING_TASK_FIELDS = [
  'task_id',
  'task_status',
  'task_status_msg',
  'task_info',
  'task_result',
  'watermark_info',
  'final_unit_deduction',
  'final_balance_deduction',
  'created_at',
  'updated_at',
];

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

function identityConflicts(expectedId: string, ids: unknown[]): boolean {
  return ids.some((id) => id !== undefined && id !== expectedId);
}

function ark(data: Record<string, unknown>, expectedId: string): VideoQueryResult {
  const inner = object(data.data);
  const task = typeof data.status === 'string' ? data : inner;
  if (
    (task.id ?? task.task_id) !== expectedId ||
    identityConflicts(expectedId, [data.id, data.task_id, inner.id, inner.task_id])
  )
    return identityInvalid;
  if (['queued', 'pending', 'running', 'processing'].includes(String(task.status)))
    return { state: 'processing' };
  if (['failed', 'cancelled', 'canceled', 'expired'].includes(String(task.status))) return failed;
  if (task.status !== 'succeeded') return invalid;
  return returned([object(task.content).video_url]);
}

function kling(data: Record<string, unknown>, expectedId: string): VideoQueryResult {
  const task = object(data.data);
  const { code, task_id: envelopeId } = data;
  const hasTask = KLING_TASK_FIELDS.some(
    (field) =>
      Object.hasOwn(task, field) || (field.startsWith('task_') && Object.hasOwn(data, field)),
  );
  if (
    ((code === 0 || hasTask) && task.task_id !== expectedId) ||
    (envelopeId !== undefined && envelopeId !== expectedId)
  )
    return identityInvalid;
  if (!Number.isInteger(code)) return invalid;
  if (code !== 0) return failed;
  const status = task.task_status;
  if (typeof status !== 'string' || !status.trim()) return invalid;
  if (['submitted', 'processing', 'running'].includes(status)) return { state: 'processing' };
  if (['failed', 'cancelled', 'canceled'].includes(status)) return failed;
  if (status !== 'succeed') return statusUnknown;
  const videos = object(task.task_result).videos;
  return Array.isArray(videos) ? returned(videos.map((video) => object(video).url)) : invalid;
}

function vidu(data: Record<string, unknown>, expectedId: string): VideoQueryResult {
  // Vidu may omit the task ID. IDs inside creations are scoped to the output.
  if (identityConflicts(expectedId, [data.id, data.task_id])) return identityInvalid;
  if (['created', 'queueing', 'queued', 'processing', 'running'].includes(String(data.state)))
    return { state: 'processing' };
  if (['failed', 'cancelled', 'canceled'].includes(String(data.state))) return failed;
  if (data.state !== 'success' || !Array.isArray(data.creations)) return invalid;
  return returned(
    data.creations.map((creation) => object(creation).url ?? object(creation).watermarked_url),
  );
}

function happyhorse(data: Record<string, unknown>, expectedId: string): VideoQueryResult {
  const output = object(data.output);
  const task = output.task_status === undefined || output.task_status === null ? data : output;
  if (task.task_id !== expectedId || identityConflicts(expectedId, [output.task_id, data.task_id]))
    return identityInvalid;
  if (typeof task.task_status !== 'string' || !task.task_status.trim()) return invalid;
  const status = task.task_status.toUpperCase();
  if (['PENDING', 'RUNNING', 'QUEUED', 'PROCESSING'].includes(status))
    return { state: 'processing' };
  if (['FAILED', 'CANCELED', 'CANCELLED'].includes(status)) return failed;
  if (status !== 'SUCCEEDED') return statusUnknown;
  return returned([task.video_url]);
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
  expectedId: string,
): VideoQueryResult {
  if (driver === 'volcengine-ark-videos') return ark(data, expectedId);
  if (driver === 'kling-videos') return kling(data, expectedId);
  if (driver === 'vidu-videos') return vidu(data, expectedId);
  if (driver === 'veo-videos') return veo(data);
  return happyhorse(data, expectedId);
}
