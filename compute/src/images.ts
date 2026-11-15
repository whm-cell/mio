import { isImageProfile, validImageInput } from '@mio/compute-contracts';
import type { ImageAssetRef, ImageInput } from '@mio/compute-contracts';
import { withPublicHttps } from './adapters/public-https.ts';
export interface ImageObservation {
  requestId?: string;
  generatedImages?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}
export type AsyncImageObservationPath = 'task_id' | 'state' | 'creations' | 'error' | 'other';
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
  | { state: 'returned'; images: ({ base64: string } | null)[]; observation?: ImageObservation }
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

const VIDU_ENDPOINT = 'https://api.onelinkai.cloud/vidu/ent/v2/reference2image';
const VIDU_TASK_ID = /^[A-Za-z0-9._:-]{1,256}$/;
// Submission responses are observed only for bounded, sanitized diagnostics.
const VIDU_SUBMISSION_BODY_LIMIT = 1024 * 1024;
const ASYNC_OBSERVATION_PATHS = [
  'task_id',
  'state',
  'creations',
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

function safeViduResultUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

function viduDataUrl(bytes: Uint8Array, contentType: ImageAssetRef['contentType']): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
}

function viduJson(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function asyncResponseObservation(
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

function sanitizeAsyncObservation(value: unknown): AsyncImageObservation | undefined {
  const input = viduJson(value);
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
    for (const value of input.responsePaths) {
      if (
        typeof value === 'string' &&
        ASYNC_OBSERVATION_PATHS.includes(value as AsyncImageObservationPath)
      ) {
        const path = value as AsyncImageObservationPath;
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

async function readViduSubmissionJson(
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
      if (total > VIDU_SUBMISSION_BODY_LIMIT)
        return { payload: null, malformed: true, readFailed: false };
      chunks.push(part.value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return { payload: null, malformed: true, readFailed: false };
    try {
      const payload = viduJson(JSON.parse(text));
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

async function readViduResult(response: Response): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
    }
    return Uint8Array.from(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Protocol-neutral Vidu adapter. It only uses the documented OneLink paths and an owner-scoped reader. */
export function createViduAsyncImageTransport(
  transport: typeof fetch = fetch,
  readImage?: ReadImage,
  download: typeof withPublicHttps = withPublicHttps,
): AsyncImageTransport {
  return {
    async submit(input, apiKey, signal) {
      const refs = input.images ?? [];
      if (input.async !== true || refs.length > 7 || !readImage)
        return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
      try {
        const images = [] as string[];
        for (const ref of refs) {
          const bytes = await readImage(ref, signal);
          if (!matchesImageSignature(bytes, ref.contentType))
            return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
          images.push(viduDataUrl(bytes, ref.contentType));
        }
        const body: Record<string, unknown> = { model: input.model, prompt: input.prompt };
        if (images.length) body.images = images.length === 1 ? images[0] : images;
        if (input.size && ['1080p', '2K', '4K'].includes(input.size)) body.resolution = input.size;
        const response = await transport(VIDU_ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const parsed = await readViduSubmissionJson(response);
        const payload = parsed.payload;
        if (!response.ok) {
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
          if (response.status === 429)
            return { state: 'rejected', code: 'IMAGE_LIMITED', observation };
          if (response.status === 400 || response.status === 422)
            return { state: 'rejected', code: 'IMAGE_REJECTED', observation };
          return { state: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN', observation };
        }
        const taskId = payload?.task_id;
        const taskIdPresent = typeof taskId === 'string' && VIDU_TASK_ID.test(taskId);
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
    async query(_input, apiKey, upstreamTaskId, _queryAttempt, signal) {
      if (!VIDU_TASK_ID.test(upstreamTaskId))
        return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
      try {
        const response = await transport(
          `https://api.onelinkai.cloud/vidu/ent/v2/tasks/${encodeURIComponent(upstreamTaskId)}/creations`,
          {
            method: 'GET',
            redirect: 'error',
            signal,
            headers: { Authorization: `Bearer ${apiKey}` },
          },
        );
        if (response.status === 404) return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
        if (!response.ok) {
          await response.body?.cancel();
          return response.status === 401 || response.status === 403
            ? { state: 'failed', code: 'IMAGE_QUERY_FAILED' }
            : { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
        }
        const payload = viduJson(await response.json());
        const state = payload?.state;
        if (state === 'created' || state === 'queueing' || state === 'processing')
          return { state: 'processing', upstreamTaskId };
        if (state === 'failed') return { state: 'failed', code: 'IMAGE_QUERY_FAILED' };
        if (state !== 'success' || !Array.isArray(payload?.creations) || !payload.creations.length)
          return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
        const images: { base64: string; format: 'png' | 'jpeg' | 'webp' }[] = [];
        for (const raw of payload.creations) {
          const creation = viduJson(raw);
          const url = safeViduResultUrl(creation?.url);
          if (!url) return { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' };
          const image = await download(url, signal, async (result) => {
            if (!result.ok) {
              await result.body?.cancel().catch(() => {});
              return null;
            }
            const bytes = await readViduResult(result);
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

function imageExtension(contentType: ImageAssetRef['contentType']): string {
  return contentType === 'image/jpeg' ? 'jpg' : contentType.slice('image/'.length);
}

function matchesImageSignature(
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
function validBase64(value: unknown): value is string {
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

async function buildGptEditFormData(
  input: ImageInput,
  operation: string,
  bounded: AbortSignal,
  read?: ReadImage,
): Promise<FormData | null> {
  const refs = input.images ?? (input.image ? [input.image] : []);
  if (!refs.length) return null;
  const form = new FormData();
  form.set('model', input.model);
  form.set('prompt', input.prompt);
  form.set('response_format', 'b64_json');
  for (const ref of refs) {
    const source = await read?.(ref, bounded);
    if (!source || !matchesImageSignature(source, ref.contentType)) return null;
    const sourceBytes = Uint8Array.from(source);
    form.append(
      'image',
      new Blob([sourceBytes.buffer as ArrayBuffer], { type: ref.contentType }),
      `image.${imageExtension(ref.contentType)}`,
    );
  }
  if (operation === 'outpaint' && input.geometry)
    form.set('geometry', JSON.stringify(input.geometry));
  if (input.mask) {
    const mask = await read?.(input.mask, bounded);
    if (!mask || !matchesImageSignature(mask, input.mask.contentType)) return null;
    const maskBytes = Uint8Array.from(mask);
    form.append(
      'mask',
      new Blob([maskBytes.buffer as ArrayBuffer], { type: input.mask.contentType }),
      'mask.png',
    );
  }
  const optional = [
    'n',
    'background',
    'moderation',
    'quality',
    'size',
    'output_format',
    'output_compression',
    'user',
  ] as const;
  for (const key of optional) {
    const value = input[key];
    if (value !== undefined) form.set(key, String(value));
  }
  return form;
}

/** B-only transport. Caller must persist submission intent BEFORE calling this once.
 * No response here establishes durable completion or permits another POST.
 * Base64 remains untrusted until the materializer validates actual image contents.
 */
export function createImageProtocol(
  profile: string,
  operation: string,
  transport: typeof fetch = fetch,
  readImage?: ReadImage,
  asyncTransport?: AsyncImageTransport,
) {
  if (!isImageProfile(profile) || !['generate', 'edit', 'outpaint'].includes(operation))
    throw new Error('IMAGE_PROTOCOL_UNSUPPORTED');
  return {
    async submitAsync(
      input: ImageInput,
      apiKey: string,
      signal?: AbortSignal,
    ): Promise<AsyncImageSubmission> {
      if (
        input.async !== true ||
        !validImageInput(input, profile) ||
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
        if (result.state === 'submitted' && !/^[A-Za-z0-9._:-]{1,256}$/.test(result.upstreamTaskId))
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
        !validImageInput(input, profile) ||
        (input.operation ?? 'generate') !== operation ||
        !apiKey ||
        /[\r\n]/.test(apiKey) ||
        !asyncTransport ||
        !/^[A-Za-z0-9._:-]{1,256}$/.test(upstreamTaskId) ||
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
          (result.upstreamTaskId !== upstreamTaskId ||
            !/^[A-Za-z0-9._:-]{1,256}$/.test(result.upstreamTaskId))
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
        !validImageInput(input, profile) ||
        (input.operation ?? 'generate') !== operation ||
        !apiKey ||
        /[\r\n]/.test(apiKey)
      )
        return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
      const deadline = AbortSignal.timeout(180_000);
      const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      if (bounded.aborted) return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const observation: ImageObservation = {};
      const observed = () => (Object.keys(observation).length ? { observation } : {});
      let body: BodyInit;
      let endpoint: string;
      let headers: Record<string, string>;
      let primaryUsageField:
        readonly ['generated_images', 'generatedImages'] | readonly ['input_tokens', 'inputTokens'];
      try {
        switch (profile) {
          case 'vidu-image-v1':
            return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
          case 'seedream-4-images-v1':
            if (operation !== 'generate') return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
            primaryUsageField = ['generated_images', 'generatedImages'];
            endpoint = 'https://api.onelinkai.cloud/volc/api/v3/images/generations';
            headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
            body = JSON.stringify({
              model: input.model,
              prompt: input.prompt,
              size: input.size ?? '1024x1024',
              response_format: 'b64_json',
              sequential_image_generation: 'disabled',
              stream: false,
              watermark: true,
            });
            break;
          case 'gpt-images-v1':
            primaryUsageField = ['input_tokens', 'inputTokens'];
            if (operation === 'edit' || operation === 'outpaint') {
              const form = await buildGptEditFormData(input, operation, bounded, read ?? readImage);
              if (!form) return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
              body = form;
              endpoint = 'https://api.onelinkai.cloud/v1/images/edits';
              headers = { Authorization: `Bearer ${apiKey}` };
            } else {
              endpoint = 'https://api.onelinkai.cloud/v1/images/generations';
              headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
              body = JSON.stringify(input);
            }
            break;
          default: {
            const exhaustive: never = profile;
            void exhaustive;
            return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
          }
        }
      } catch {
        return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
      }
      try {
        const response = await transport(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: bounded,
          headers,
          body,
        });
        const requestId = response.headers.get('x-request-id');
        if (requestId && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) && !requestId.includes(apiKey))
          observation.requestId = requestId;
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 401 || response.status === 403)
            return { state: 'rejected', code: 'IMAGE_AUTH', ...observed() };
          if (response.status === 429)
            return { state: 'rejected', code: 'IMAGE_LIMITED', ...observed() };
          if (response.status === 400 || response.status === 422)
            return { state: 'rejected', code: 'IMAGE_REJECTED', ...observed() };
          return { state: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN', ...observed() };
        }
        reader = response.body?.getReader();
        if (!reader) throw new Error();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          chunks.push(part.value);
        }
        const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          !payload ||
          typeof payload !== 'object' ||
          !('data' in payload) ||
          !Array.isArray(payload.data) ||
          payload.data.length > (input.n ?? 1)
        )
          throw new Error();
        const images: ({ base64: string } | null)[] = [];
        for (const item of payload.data) {
          if (
            !item ||
            typeof item !== 'object' ||
            !validBase64(item.b64_json) ||
            item.b64_json.includes(apiKey)
          )
            images.push(null);
          else images.push({ base64: item.b64_json });
        }
        if ('usage' in payload && payload.usage && typeof payload.usage === 'object') {
          const usage = payload.usage as Record<string, unknown>;
          const fields = [
            primaryUsageField,
            ['output_tokens', 'outputTokens'],
            ['total_tokens', 'totalTokens'],
          ] as const;
          for (const [field, target] of fields) {
            const value = usage[field];
            if (Number.isSafeInteger(value) && Number(value) >= 0)
              observation[target] = Number(value);
          }
        }
        return {
          state: 'returned',
          images,
          ...observed(),
        };
      } catch {
        // A timeout, malformed response, or dropped connection leaves the upstream outcome unknown.
        return { state: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN', ...observed() };
      } finally {
        await reader?.cancel().catch(() => {});
      }
    },
  };
}
