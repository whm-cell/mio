import type { ImageInput, ImageRouteConfig } from '../../../generations/contracts.ts';
import {
  extractRequestId,
  extractUsage,
  imageExtension,
  joinOneLinkPath,
  jsonObject,
  matchesImageSignature,
  readSyncJsonPayload,
  rejectSyncHttp,
  validBase64,
} from '../shared/index.ts';
import type { ImageObservation, ImageSubmission, ReadImage } from '../shared/index.ts';

const OPENAI_IMAGE_OPTIONAL_FIELDS = [
  'n',
  'background',
  'moderation',
  'quality',
  'size',
  'output_format',
  'output_compression',
  'user',
] as const;
const OPENAI_IMAGE_GENERATE_FIELDS = [...OPENAI_IMAGE_OPTIONAL_FIELDS, 'aspect_ratio'] as const;

async function buildOpenAiEditFormData(
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
  for (const key of OPENAI_IMAGE_OPTIONAL_FIELDS) {
    const value = input[key];
    if (value !== undefined) form.set(key, String(value));
  }
  return form;
}

export async function submitOpenAiImage(
  route: ImageRouteConfig,
  operation: string,
  input: ImageInput,
  apiKey: string,
  bounded: AbortSignal,
  transport: typeof fetch,
  read?: ReadImage,
): Promise<ImageSubmission> {
  const observation: ImageObservation = {};
  const observed = () => (Object.keys(observation).length ? { observation } : {});
  let endpoint: string | null;
  let headers: Record<string, string>;
  let body: BodyInit;
  try {
    if (operation === 'edit' || operation === 'outpaint') {
      endpoint = route.editPath ? joinOneLinkPath(route.editPath, 'openai-images') : null;
      if (!endpoint) return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
      const form = await buildOpenAiEditFormData(input, operation, bounded, read);
      if (!form) return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
      body = form;
      headers = { Authorization: `Bearer ${apiKey}` };
    } else {
      endpoint = joinOneLinkPath(route.submitPath, 'openai-images');
      if (!endpoint) return { state: 'rejected', code: 'IMAGE_INPUT_INVALID' };
      headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      const payload: Record<string, string | number> = { model: input.model, prompt: input.prompt };
      for (const key of OPENAI_IMAGE_GENERATE_FIELDS) {
        const value = input[key];
        if (value !== undefined) payload[key] = value;
      }
      body = JSON.stringify(payload);
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
    extractRequestId(response, apiKey, observation);
    if (!response.ok) return await rejectSyncHttp(response, observation);
    const payload = await readSyncJsonPayload(response);
    if (!Array.isArray(payload.data) || payload.data.length > (input.n ?? 1))
      throw new Error('IMAGE_DATA_INVALID');
    const images: ({ base64: string } | null)[] = [];
    for (const raw of payload.data) {
      const item = jsonObject(raw);
      if (!item || !validBase64(item.b64_json) || item.b64_json.includes(apiKey)) images.push(null);
      else images.push({ base64: item.b64_json });
    }
    extractUsage(payload, ['input_tokens', 'inputTokens'], observation);
    return { state: 'returned', images, ...observed() };
  } catch {
    return { state: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN', ...observed() };
  }
}
