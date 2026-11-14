import { isImageProfile, validImageInput } from '@mio/compute-contracts';
import type { ImageInput } from '@mio/compute-contracts';
export interface ImageObservation {
  requestId?: string;
  generatedImages?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}
export type ImageSubmission =
  | { state: 'returned'; images: ({ base64: string } | null)[]; observation?: ImageObservation }
  | { state: 'unknown'; code: 'IMAGE_SUBMISSION_UNKNOWN'; observation?: ImageObservation }
  | {
      state: 'rejected';
      code: 'IMAGE_INPUT_INVALID' | 'IMAGE_AUTH' | 'IMAGE_LIMITED' | 'IMAGE_REJECTED';
      observation?: ImageObservation;
    };

/** B-only transport. Caller must persist submission intent BEFORE calling this once.
 * No response here establishes durable completion or permits another paid POST.
 * Base64 remains untrusted until the materializer validates actual image contents.
 */
export function createImageProtocol(
  profile: string,
  operation: string,
  transport: typeof fetch = fetch,
) {
  if (!isImageProfile(profile) || operation !== 'generate')
    throw new Error('IMAGE_PROTOCOL_UNSUPPORTED');
  return {
    async submit(
      input: ImageInput,
      apiKey: string,
      signal?: AbortSignal,
    ): Promise<ImageSubmission> {
      if (!validImageInput(input, profile) || !apiKey || /[\r\n]/.test(apiKey))
        return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
      const seedream = profile === 'seedream-4-images-v1';
      const body = seedream
        ? {
            model: input.model,
            prompt: input.prompt,
            size: input.size ?? '1024x1024',
            response_format: 'b64_json',
            sequential_image_generation: 'disabled',
            stream: false,
            watermark: true,
          }
        : input;
      const deadline = AbortSignal.timeout(180_000);
      const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      if (bounded.aborted) return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const observation: ImageObservation = {};
      const observed = () => (Object.keys(observation).length ? { observation } : {});
      try {
        const response = await transport(
          seedream
            ? 'https://api.onelinkai.cloud/volc/api/v3/images/generations'
            : 'https://api.onelinkai.cloud/v1/images/generations',
          {
            method: 'POST',
            redirect: 'error',
            signal: bounded,
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
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
        // Explicit local capacity policy, not a claim about provider limits.
        const maximum = 64 * 1024 * 1024;
        reader = response.body?.getReader();
        if (Number(response.headers.get('content-length')) > maximum || !reader) throw new Error();
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > maximum) throw new Error();
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
            typeof item.b64_json !== 'string' ||
            !item.b64_json ||
            item.b64_json.length % 4 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
              item.b64_json,
            ) ||
            item.b64_json.includes(apiKey)
          )
            images.push(null);
          else images.push({ base64: item.b64_json });
        }
        if ('usage' in payload && payload.usage && typeof payload.usage === 'object') {
          const usage = payload.usage as Record<string, unknown>;
          const fields = [
            ...(seedream
              ? ([['generated_images', 'generatedImages']] as const)
              : ([['input_tokens', 'inputTokens']] as const)),
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
        // A timeout, malformed response, or dropped connection cannot prove no charge.
        return { state: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN', ...observed() };
      } finally {
        await reader?.cancel().catch(() => {});
      }
    },
  };
}
