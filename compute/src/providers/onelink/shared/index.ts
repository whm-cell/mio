import { isValidImageRoutePath } from '@mio/compute-contracts';
import type { ImageAssetRef, ImageDriver, ImageInput } from '@mio/compute-contracts';
import type { withPublicHttps } from '../../../adapters/public-https.ts';

const ONELINK_ORIGIN = 'https://api.onelinkai.cloud';
export const ASYNC_TASK_ID = /^[A-Za-z0-9._:-]{1,256}$/;

export interface ImageObservation {
  requestId?: string;
  generatedImages?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type AsyncImageObservationPath =
  'task_id' | 'state' | 'creations' | 'data' | 'code' | 'error' | 'other';

export type AsyncImageErrorCategory =
  | 'none'
  | 'auth'
  | 'rate_limit'
  | 'rejected'
  | 'upstream'
  | 'missing_task_id'
  | 'invalid_task_id'
  | 'malformed_response'
  | 'transport'
  | 'aborted';

export interface AsyncImageObservation {
  statusCode?: number;
  requestIdPresent?: boolean;
  responsePaths?: AsyncImageObservationPath[];
  taskIdPresent?: boolean;
  errorCategory?: AsyncImageErrorCategory;
}

export type ImageSubmission =
  | {
      state: 'returned';
      images: ({ base64: string; format?: 'png' | 'jpeg' | 'webp' } | null)[];
      observation?: ImageObservation;
    }
  | { state: 'unknown'; code: 'IMAGE_SUBMISSION_UNKNOWN'; observation?: ImageObservation }
  | {
      state: 'rejected';
      code: 'IMAGE_INPUT_INVALID' | 'IMAGE_AUTH' | 'IMAGE_LIMITED' | 'IMAGE_REJECTED';
      observation?: ImageObservation;
    };

export type AsyncImageSubmission =
  | { state: 'submitted'; upstreamTaskId: string; observation?: AsyncImageObservation }
  | {
      state: 'unknown';
      code: 'IMAGE_SUBMISSION_UNKNOWN';
      observation?: AsyncImageObservation;
    }
  | {
      state: 'rejected';
      code:
        | 'IMAGE_INPUT_INVALID'
        | 'IMAGE_AUTH'
        | 'IMAGE_LIMITED'
        | 'IMAGE_REJECTED'
        | 'IMAGE_HANDLER_UNAVAILABLE';
      observation?: AsyncImageObservation;
    };

export type AsyncImageQuery =
  | { state: 'processing'; upstreamTaskId: string }
  | {
      state: 'returned';
      upstreamTaskId: string;
      images: ({ base64: string; format?: 'png' | 'jpeg' | 'webp' } | null)[];
    }
  | { state: 'failed'; code: 'IMAGE_QUERY_FAILED' | 'IMAGE_QUERY_LIMIT' }
  | { state: 'unknown'; code: 'IMAGE_QUERY_UNKNOWN' };

export interface AsyncImageTransport {
  submit(input: ImageInput, apiKey: string, signal: AbortSignal): Promise<AsyncImageSubmission>;
  query(
    input: ImageInput,
    apiKey: string,
    upstreamTaskId: string,
    queryAttempt: number,
    signal: AbortSignal,
  ): Promise<AsyncImageQuery>;
}

export type ReadImage = (ref: ImageAssetRef, signal: AbortSignal) => Promise<Uint8Array>;

const ASYNC_JSON_BODY_LIMIT = 1024 * 1024;
const SYNC_JSON_BODY_LIMIT = 128 * 1024 * 1024;

const ASYNC_OBSERVATION_PATHS = [
  'task_id',
  'state',
  'creations',
  'data',
  'code',
  'error',
  'other',
] as const satisfies readonly AsyncImageObservationPath[];

const ASYNC_ERROR_CATEGORIES = [
  'none',
  'auth',
  'rate_limit',
  'rejected',
  'upstream',
  'missing_task_id',
  'invalid_task_id',
  'malformed_response',
  'transport',
  'aborted',
] as const satisfies readonly AsyncImageErrorCategory[];

export function joinOneLinkPath(path: string, driver: ImageDriver): string | null {
  if (!isValidImageRoutePath(path, driver, false)) return null;
  return `${ONELINK_ORIGIN}${path}`;
}

export function substituteTaskId(
  template: string | null | undefined,
  taskId: string,
  driver: ImageDriver,
): string | null {
  if (!template || !ASYNC_TASK_ID.test(taskId) || !isValidImageRoutePath(template, driver, true))
    return null;
  if (template.split('{task_id}').length !== 2) return null;
  const resolved = template.replace('{task_id}', encodeURIComponent(taskId));
  if (
    resolved.includes('..') ||
    resolved.includes('//') ||
    resolved.includes('{') ||
    resolved.includes('}')
  )
    return null;
  return `${ONELINK_ORIGIN}${resolved}`;
}

export function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function imageExtension(contentType: ImageAssetRef['contentType']): string {
  return contentType === 'image/jpeg' ? 'jpg' : contentType.slice('image/'.length);
}

export function dataUrlFromBytes(
  bytes: Uint8Array,
  contentType: ImageAssetRef['contentType'],
): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
}

export function matchesImageSignature(
  bytes: Uint8Array,
  contentType: ImageAssetRef['contentType'],
): boolean {
  if (contentType === 'image/png')
    return Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (contentType === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return (
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  );
}

// Validate without a repeated-group regexp: large image bodies can overflow its stack.
export function validBase64(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  for (let index = 0; index < value.length - padding; index++) {
    const code = value.charCodeAt(index);
    if (!(
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47
    ))
      return false;
  }
  return true;
}

function safeResultUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

async function readResultBytes(response: Response): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > SYNC_JSON_BODY_LIMIT) return null;
      chunks.push(part.value);
    }
    return Uint8Array.from(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function downloadResultImage(
  rawUrl: unknown,
  download: typeof withPublicHttps,
  signal: AbortSignal,
): Promise<{ base64: string; format: 'png' | 'jpeg' | 'webp' } | null> {
  const url = safeResultUrl(rawUrl);
  if (!url) return null;
  return download(url, signal, async (result) => {
    if (!result.ok) {
      await result.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = await readResultBytes(result);
    if (!bytes) return null;
    const contentType = (['image/png', 'image/jpeg', 'image/webp'] as const).find((type) =>
      matchesImageSignature(bytes, type),
    );
    if (!contentType) return null;
    return {
      base64: Buffer.from(bytes).toString('base64'),
      format: contentType.slice('image/'.length) as 'png' | 'jpeg' | 'webp',
    };
  });
}

export async function readAsyncJson(
  response: Response,
): Promise<{ payload: Record<string, unknown> | null; malformed: boolean; readFailed: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { payload: null, malformed: true, readFailed: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > ASYNC_JSON_BODY_LIMIT)
        return { payload: null, malformed: true, readFailed: false };
      chunks.push(part.value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return { payload: null, malformed: true, readFailed: false };
    try {
      const payload = jsonObject(JSON.parse(text));
      return { payload, malformed: payload === null, readFailed: false };
    } catch {
      return { payload: null, malformed: true, readFailed: false };
    }
  } catch {
    return { payload: null, malformed: true, readFailed: true };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function readSyncJsonPayload(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('IMAGE_BODY_MISSING');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > SYNC_JSON_BODY_LIMIT) throw new Error('IMAGE_BODY_TOO_LARGE');
      chunks.push(part.value);
    }
    const parsed = jsonObject(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!parsed) throw new Error('IMAGE_BODY_INVALID');
    return parsed;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function extractRequestId(
  response: Response,
  apiKey: string,
  observation: ImageObservation,
): void {
  const requestId = response.headers.get('x-request-id');
  if (requestId && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) && !requestId.includes(apiKey))
    observation.requestId = requestId;
}

export function extractUsage(
  payload: Record<string, unknown>,
  primaryField:
    readonly ['generated_images', 'generatedImages'] | readonly ['input_tokens', 'inputTokens'],
  observation: ImageObservation,
): void {
  const usage = jsonObject(payload.usage);
  if (!usage) return;
  const fields = [
    primaryField,
    ['output_tokens', 'outputTokens'],
    ['total_tokens', 'totalTokens'],
  ] as const;
  for (const [field, target] of fields) {
    const value = usage[field];
    if (Number.isSafeInteger(value) && Number(value) >= 0) observation[target] = Number(value);
  }
}

export async function rejectSyncHttp(
  response: Response,
  observation: ImageObservation,
): Promise<ImageSubmission> {
  await response.body?.cancel().catch(() => {});
  const observed = Object.keys(observation).length ? { observation } : {};
  if (response.status === 401 || response.status === 403)
    return { state: 'rejected', code: 'IMAGE_AUTH', ...observed };
  if (response.status === 429) return { state: 'rejected', code: 'IMAGE_LIMITED', ...observed };
  if (response.status === 400 || response.status === 422)
    return { state: 'rejected', code: 'IMAGE_REJECTED', ...observed };
  return { state: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN', ...observed };
}

function asyncResponsePaths(payload: Record<string, unknown> | null): AsyncImageObservationPath[] {
  if (!payload) return [];
  const paths: AsyncImageObservationPath[] = [];
  for (const key of Object.keys(payload)) {
    const path: AsyncImageObservationPath = ASYNC_OBSERVATION_PATHS.includes(
      key as AsyncImageObservationPath,
    )
      ? (key as AsyncImageObservationPath)
      : 'other';
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

export function asyncResponseObservation(
  response: Response,
  payload: Record<string, unknown> | null,
  taskIdPresent: boolean,
  errorCategory: AsyncImageErrorCategory,
): AsyncImageObservation {
  return {
    statusCode: response.status,
    requestIdPresent: response.headers.has('x-request-id'),
    responsePaths: asyncResponsePaths(payload),
    taskIdPresent,
    errorCategory,
  };
}

export function rejectAsyncSubmissionHttp(
  response: Response,
  payload: Record<string, unknown> | null,
): AsyncImageSubmission {
  const errorCategory: AsyncImageErrorCategory =
    response.status === 401 || response.status === 403
      ? 'auth'
      : response.status === 429
        ? 'rate_limit'
        : response.status === 400 || response.status === 422
          ? 'rejected'
          : 'upstream';
  const observation = asyncResponseObservation(response, payload, false, errorCategory);
  if (response.status === 401 || response.status === 403)
    return { state: 'rejected', code: 'IMAGE_AUTH', observation };
  if (response.status === 429) return { state: 'rejected', code: 'IMAGE_LIMITED', observation };
  if (response.status === 400 || response.status === 422)
    return { state: 'rejected', code: 'IMAGE_REJECTED', observation };
  return { state: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN', observation };
}

export function sanitizeAsyncObservation(value: unknown): AsyncImageObservation | undefined {
  const input = jsonObject(value);
  if (!input) return undefined;
  const result: AsyncImageObservation = {};
  if (
    typeof input.statusCode === 'number' &&
    Number.isSafeInteger(input.statusCode) &&
    input.statusCode >= 100 &&
    input.statusCode <= 599
  )
    result.statusCode = input.statusCode;
  if (typeof input.requestIdPresent === 'boolean') result.requestIdPresent = input.requestIdPresent;
  if (Array.isArray(input.responsePaths)) {
    const paths: AsyncImageObservationPath[] = [];
    for (const item of input.responsePaths) {
      if (
        typeof item === 'string' &&
        ASYNC_OBSERVATION_PATHS.includes(item as AsyncImageObservationPath)
      ) {
        const path = item as AsyncImageObservationPath;
        if (!paths.includes(path)) paths.push(path);
      }
      if (paths.length === ASYNC_OBSERVATION_PATHS.length) break;
    }
    result.responsePaths = paths;
  }
  if (typeof input.taskIdPresent === 'boolean') result.taskIdPresent = input.taskIdPresent;
  if (
    typeof input.errorCategory === 'string' &&
    ASYNC_ERROR_CATEGORIES.includes(input.errorCategory as AsyncImageErrorCategory)
  )
    result.errorCategory = input.errorCategory as AsyncImageErrorCategory;
  return Object.keys(result).length ? result : undefined;
}
