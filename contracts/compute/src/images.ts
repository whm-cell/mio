export const IMAGE_PROFILES = ['gpt-images-v1', 'seedream-4-images-v1'] as const;
export type ImageProfile = (typeof IMAGE_PROFILES)[number];
export function isImageProfile(value: unknown): value is ImageProfile {
  return typeof value === 'string' && IMAGE_PROFILES.some((profile) => profile === value);
}

export interface ImageInput {
  model: string;
  prompt: string;
  n?: number;
  background?: 'transparent' | 'opaque' | 'auto';
  moderation?: 'low' | 'auto';
  quality?: 'high' | 'medium' | 'low' | 'auto';
  size?: string;
  output_format?: 'png' | 'jpeg' | 'webp';
  output_compression?: number;
  user?: string;
}
export interface ImageEnvelope {
  version: 1;
  keyId: string;
  wrappedKey: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}
export interface ImageCommandV1 {
  version: 1;
  type: 'image.request';
  messageId: string;
  jobId: string;
  ownerId: string;
  expiresAt: number;
  profile: ImageProfile;
  input: ImageInput;
  credential: ImageEnvelope;
}
export interface ImageRecoveryCommandV1 {
  version: 1;
  type: 'image.recover';
  messageId: string;
  commandId: string;
  jobId: string;
  sequence: number;
}
export interface ImageOutput {
  key: string;
  sizeBytes: number;
  sha256: string;
  etag: string;
  contentType: string;
}
export type ImageErrorCode =
  | 'IMAGE_INPUT_INVALID'
  | 'IMAGE_AUTH'
  | 'IMAGE_LIMITED'
  | 'IMAGE_REJECTED'
  | 'IMAGE_SUBMISSION_UNKNOWN'
  | 'IMAGE_CREDENTIAL_UNAVAILABLE'
  | 'IMAGE_HANDLER_UNAVAILABLE';
export interface ImageResultV1 {
  version: 1;
  type: 'image.result';
  messageId: string;
  commandId: string;
  jobId: string;
  state:
    'completed' | 'partial' | 'unknown' | 'rejected' | 'materializing' | 'materialization_failed';
  outputs: ImageOutput[];
  errorCode?: ImageErrorCode;
  recoveryId?: string;
}
const uuidText = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const uuid = new RegExp(`^${uuidText}$`);
const imageKey = new RegExp(`^([0-9])-(${uuidText})\\.(png|jpeg|webp)$`);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('IMAGE_MESSAGE_INVALID');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).length !== names.length || names.some((name) => !(name in value)))
    throw new Error('IMAGE_MESSAGE_INVALID');
}
export function parseImageCommand(value: unknown): ImageCommandV1 {
  const v = object(value);
  fields(v, [
    'version',
    'type',
    'messageId',
    'jobId',
    'ownerId',
    'expiresAt',
    'profile',
    'input',
    'credential',
  ]);
  const c = object(v.credential);
  fields(c, ['version', 'keyId', 'wrappedKey', 'nonce', 'ciphertext', 'tag']);
  const input = object(v.input);
  if (
    v.version !== 1 ||
    v.type !== 'image.request' ||
    !uuid.test(String(v.messageId)) ||
    !uuid.test(String(v.jobId)) ||
    typeof v.ownerId !== 'string' ||
    !v.ownerId ||
    v.ownerId.length > 256 ||
    !Number.isSafeInteger(v.expiresAt) ||
    !isImageProfile(v.profile) ||
    c.version !== 1 ||
    ['keyId', 'wrappedKey', 'nonce', 'ciphertext', 'tag'].some(
      (k) => typeof c[k] !== 'string' || !c[k] || String(c[k]).length > 8192,
    ) ||
    typeof input.model !== 'string' ||
    typeof input.prompt !== 'string' ||
    input.prompt.length > 32000 ||
    Object.keys(input).some(
      (k) =>
        ![
          'model',
          'prompt',
          'n',
          'background',
          'moderation',
          'quality',
          'size',
          'output_format',
          'output_compression',
          'user',
        ].includes(k),
    )
  )
    throw new Error('IMAGE_MESSAGE_INVALID');
  return v as unknown as ImageCommandV1;
}
export function parseImageRecovery(value: unknown): ImageRecoveryCommandV1 {
  const v = object(value);
  fields(v, ['version', 'type', 'messageId', 'commandId', 'jobId', 'sequence']);
  if (
    v.version !== 1 ||
    v.type !== 'image.recover' ||
    ![v.messageId, v.commandId, v.jobId].every((id) => typeof id === 'string' && uuid.test(id)) ||
    !Number.isInteger(v.sequence) ||
    Number(v.sequence) < 1 ||
    Number(v.sequence) > 2147483647
  )
    throw new Error('IMAGE_MESSAGE_INVALID');
  return v as unknown as ImageRecoveryCommandV1;
}
export function imageOutputIndex(jobId: string, key: string, contentType: string): number | null {
  const prefix = `mio/derived/${jobId}/images/`;
  if (!key.startsWith(prefix)) return null;
  // The index remains part of the logical output identity for partial
  // results; the UUID is the physical file identity for each write attempt.
  const match = imageKey.exec(key.slice(prefix.length));
  return match && contentType === `image/${match[3]}` ? Number(match[1]) : null;
}
export function imageOutputKey(
  jobId: string,
  index: number,
  fileId: string,
  format: string,
): string {
  if (
    !uuid.test(jobId) ||
    !uuid.test(fileId) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index > 9 ||
    !['png', 'jpeg', 'webp'].includes(format)
  )
    throw new Error('IMAGE_OUTPUT_INVALID');
  return `mio/derived/${jobId}/images/${index}-${fileId}.${format}`;
}
export function parseImageResult(value: unknown): ImageResultV1 {
  const v = object(value);
  fields(v, [
    'version',
    'type',
    'messageId',
    'commandId',
    'jobId',
    'state',
    'outputs',
    ...('errorCode' in v ? ['errorCode'] : []),
    ...('recoveryId' in v ? ['recoveryId'] : []),
  ]);
  if (
    v.version !== 1 ||
    v.type !== 'image.result' ||
    ![v.messageId, v.commandId, v.jobId].every((id) => typeof id === 'string' && uuid.test(id)) ||
    ![
      'completed',
      'partial',
      'unknown',
      'rejected',
      'materializing',
      'materialization_failed',
    ].includes(String(v.state)) ||
    !Array.isArray(v.outputs) ||
    v.outputs.length > 10 ||
    (v.state === 'completed' && v.outputs.length < 1) ||
    (['unknown', 'rejected'].includes(String(v.state)) && v.outputs.length !== 0)
  )
    throw new Error('IMAGE_MESSAGE_INVALID');
  if (v.recoveryId !== undefined && (typeof v.recoveryId !== 'string' || !uuid.test(v.recoveryId)))
    throw new Error('IMAGE_MESSAGE_INVALID');
  if (
    v.errorCode !== undefined &&
    !(
      (v.state === 'unknown' && v.errorCode === 'IMAGE_SUBMISSION_UNKNOWN') ||
      (v.state === 'rejected' &&
        [
          'IMAGE_INPUT_INVALID',
          'IMAGE_AUTH',
          'IMAGE_LIMITED',
          'IMAGE_REJECTED',
          'IMAGE_CREDENTIAL_UNAVAILABLE',
          'IMAGE_HANDLER_UNAVAILABLE',
        ].includes(String(v.errorCode)))
    )
  )
    throw new Error('IMAGE_MESSAGE_INVALID');
  let previousIndex = -1;
  v.outputs.forEach((raw) => {
    const out = object(raw);
    fields(out, ['key', 'sizeBytes', 'sha256', 'etag', 'contentType']);
    const index =
      typeof out.key === 'string' && typeof out.contentType === 'string'
        ? imageOutputIndex(String(v.jobId), out.key, out.contentType)
        : null;
    if (
      index === null ||
      index <= previousIndex ||
      !Number.isSafeInteger(out.sizeBytes) ||
      Number(out.sizeBytes) < 1 ||
      Number(out.sizeBytes) > 48 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(String(out.sha256)) ||
      typeof out.etag !== 'string' ||
      !out.etag ||
      out.etag.length > 256
    )
      throw new Error('IMAGE_MESSAGE_INVALID');
    previousIndex = index;
  });
  return v as unknown as ImageResultV1;
}

const inputFields = new Set([
  'model',
  'prompt',
  'n',
  'background',
  'moderation',
  'quality',
  'size',
  'output_format',
  'output_compression',
  'user',
]);

export function validImageInput(input: ImageInput, profile: ImageProfile): boolean {
  if (!isImageProfile(profile)) return false;
  if (Object.keys(input).some((key) => !inputFields.has(key))) return false;
  if (
    typeof input.model !== 'string' ||
    !input.model.trim() ||
    input.model.length > 256 ||
    /[\x00-\x1f\x7f]/.test(input.model)
  )
    return false;
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32_000)
    return false;
  if (profile === 'seedream-4-images-v1') {
    return (
      Object.keys(input).every((key) => ['model', 'prompt', 'n', 'size'].includes(key)) &&
      (input.n === undefined || input.n === 1) &&
      (input.size === undefined || input.size === '1024x1024')
    );
  }
  if (input.n !== undefined && (!Number.isInteger(input.n) || input.n < 1 || input.n > 10))
    return false;
  const enums = {
    background: ['transparent', 'opaque', 'auto'],
    moderation: ['low', 'auto'],
    quality: ['high', 'medium', 'low', 'auto'],
    output_format: ['png', 'jpeg', 'webp'],
  };
  for (const key of Object.keys(enums) as (keyof typeof enums)[]) {
    if (input[key] !== undefined && !enums[key].includes(input[key])) return false;
  }
  if (
    input.output_compression !== undefined &&
    (!Number.isInteger(input.output_compression) ||
      input.output_compression < 0 ||
      input.output_compression > 100 ||
      !['jpeg', 'webp'].includes(input.output_format ?? 'png'))
  )
    return false;
  if (input.background === 'transparent' && input.output_format === 'jpeg') return false;
  if (
    input.size !== undefined &&
    !['auto', '1024x1024', '1536x1024', '1024x1536'].includes(input.size)
  ) {
    // The documented maximum's portrait interpretation is unspecified; accept only
    // dimensions individually within the published landscape bounds for now.
    const match = /^(\d{1,4})x(\d{1,4})$/.exec(input.size);
    if (!match) return false;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (
      !width ||
      !height ||
      width % 16 ||
      height % 16 ||
      width > 3840 ||
      height > 2160 ||
      width / height < 1 / 3 ||
      width / height > 3
    )
      return false;
  }
  return (
    input.user === undefined ||
    (typeof input.user === 'string' &&
      input.user.length <= 256 &&
      !/[\x00-\x1f\x7f]/.test(input.user))
  );
}
