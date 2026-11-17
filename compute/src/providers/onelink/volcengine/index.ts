import type { ImageInput, ImageRouteConfig } from '@mio/compute-contracts';
import { withPublicHttps } from '../../../adapters/public-https.ts';
import {
  dataUrlFromBytes,
  downloadResultImage,
  extractRequestId,
  extractUsage,
  joinOneLinkPath,
  jsonObject,
  matchesImageSignature,
  readSyncJsonPayload,
  rejectSyncHttp,
  validBase64,
} from '../shared/index.ts';
import type { ImageObservation, ImageSubmission, ReadImage } from '../shared/index.ts';

async function encodeReferenceImages(
  input: ImageInput,
  bounded: AbortSignal,
  read?: ReadImage,
): Promise<string[] | null> {
  const refs = input.images ?? (input.image ? [input.image] : []);
  if (!refs.length) return [];
  if (!read) return null;
  const encoded: string[] = [];
  for (const ref of refs) {
    const bytes = await read(ref, bounded);
    if (!matchesImageSignature(bytes, ref.contentType)) return null;
    encoded.push(dataUrlFromBytes(bytes, ref.contentType));
  }
  return encoded;
}

export async function submitVolcengineImage(
  route: ImageRouteConfig,
  operation: string,
  input: ImageInput,
  apiKey: string,
  bounded: AbortSignal,
  transport: typeof fetch,
  read?: ReadImage,
  download: typeof withPublicHttps = withPublicHttps,
): Promise<ImageSubmission> {
  if (!route.paramSpec.supportedOperations.includes(operation as 'generate' | 'edit' | 'outpaint'))
    return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
  const endpoint = joinOneLinkPath(route.submitPath, 'volcengine-ark-images');
  if (!endpoint) return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
  const observation: ImageObservation = {};
  const observed = () => (Object.keys(observation).length ? { observation } : {});
  let body: string;
  try {
    const refs = await encodeReferenceImages(input, bounded, read);
    if (!refs) return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
    const requestedCount = input.n ?? 1;
    const effectiveSize = input.size ?? route.requestDefaults.defaultSize ?? undefined;
    const watermark = route.effectiveWatermark ?? route.requestDefaults.watermark;
    const requestBody: Record<string, unknown> = {
      model: input.model,
      prompt: input.prompt,
      ...(effectiveSize !== undefined ? { size: effectiveSize } : {}),
      response_format: route.requestDefaults.responseFormat ?? 'b64_json',
      sequential_image_generation:
        requestedCount > 1
          ? 'auto'
          : (route.requestDefaults.sequentialImageGeneration ?? 'disabled'),
      stream: route.requestDefaults.stream ?? false,
    };
    if (requestedCount > 1) {
      requestBody.sequential_image_generation_options = { max_images: requestedCount };
    }
    if (refs.length > 0) {
      requestBody.image = refs.length === 1 ? refs[0] : refs;
    }
    if (input.output_format !== undefined) {
      requestBody.output_format = input.output_format;
    }
    if (typeof watermark === 'boolean') {
      requestBody.watermark = watermark;
    }
    body = JSON.stringify(requestBody);
  } catch {
    return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
  }
  try {
    const response = await transport(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: bounded,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    extractRequestId(response, apiKey, observation);
    if (!response.ok) return await rejectSyncHttp(response, observation);
    const payload = await readSyncJsonPayload(response);
    const requestedCount = input.n ?? 1;
    if (!Array.isArray(payload.data) || payload.data.length > requestedCount)
      throw new Error('IMAGE_DATA_INVALID');
    const images: ({ base64: string; format?: 'png' | 'jpeg' | 'webp' } | null)[] = [];
    for (const raw of payload.data) {
      const item = jsonObject(raw);
      if (!item) {
        images.push(null);
        continue;
      }
      if (validBase64(item.b64_json) && !item.b64_json.includes(apiKey)) {
        let format: 'png' | 'jpeg' | 'webp' | undefined;
        if (!input.output_format && !route.outputSpec.fixedOutputFormat) {
          const prefix = Buffer.from(item.b64_json.slice(0, 16), 'base64');
          format = (['png', 'jpeg', 'webp'] as const).find((candidate) =>
            matchesImageSignature(prefix, `image/${candidate}`),
          );
        }
        images.push({ base64: item.b64_json, ...(format ? { format } : {}) });
        continue;
      }
      if (typeof item.url === 'string') {
        const downloaded = await downloadResultImage(item.url, download, bounded);
        images.push(downloaded);
        continue;
      }
      images.push(null);
    }
    extractUsage(payload, ['generated_images', 'generatedImages'], observation);
    return { state: 'returned', images, ...observed() };
  } catch {
    return { state: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN', ...observed() };
  }
}
