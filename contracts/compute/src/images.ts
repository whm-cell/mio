export const IMAGE_PROFILES = ['gpt-images-v1', 'seedream-4-images-v1', 'vidu-image-v1'] as const;
export type ImageProfile = (typeof IMAGE_PROFILES)[number];
export function isImageProfile(value: unknown): value is ImageProfile {
  return typeof value === 'string' && IMAGE_PROFILES.some((profile) => profile === value);
}

export const IMAGE_OPERATIONS = ['generate', 'edit', 'outpaint'] as const;
export type ImageOperation = (typeof IMAGE_OPERATIONS)[number];

export interface ImageProfileRule {
  readonly supportedOperations: readonly ImageOperation[];
  readonly requiresAsync: boolean;
  readonly allowGenerateReferences: boolean;
  readonly fixedOutputFormat: 'jpeg' | null;
}

export const IMAGE_PROFILE_RULES = {
  'gpt-images-v1': {
    supportedOperations: ['generate', 'edit', 'outpaint'],
    requiresAsync: false,
    allowGenerateReferences: false,
    fixedOutputFormat: null,
  },
  'seedream-4-images-v1': {
    supportedOperations: ['generate'],
    requiresAsync: false,
    allowGenerateReferences: false,
    fixedOutputFormat: 'jpeg',
  },
  'vidu-image-v1': {
    supportedOperations: ['generate'],
    requiresAsync: true,
    allowGenerateReferences: true,
    fixedOutputFormat: null,
  },
} as const satisfies Record<ImageProfile, ImageProfileRule>;

export const IMAGE_GEOMETRY_EDGES = ['left', 'top', 'right', 'bottom'] as const;
export type ImageGeometryEdge = (typeof IMAGE_GEOMETRY_EDGES)[number];

export interface ImageGeometry {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Immutable owner-scoped input snapshot carried to the isolated worker. */
export interface ImageAssetRef {
  assetId: string;
  key: string;
  sizeBytes: number;
  etag: string;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface ImageRequestParameters {
  prompt: string;
  async?: boolean;
  operation?: ImageOperation;
  imageAssetId?: string;
  imageAssetIds?: string[];
  maskAssetId?: string;
  geometry?: ImageGeometry;
  n?: number;
  background?: 'transparent' | 'opaque' | 'auto';
  moderation?: 'low' | 'auto';
  quality?: 'high' | 'medium' | 'low' | 'auto';
  size?: string;
  output_format?: 'png' | 'jpeg' | 'webp';
  output_compression?: number;
  user?: string;
}

export interface ImageInput {
  model: string;
  prompt: string;
  async?: boolean;
  operation?: ImageOperation;
  image?: ImageAssetRef;
  images?: ImageAssetRef[];
  mask?: ImageAssetRef;
  geometry?: ImageGeometry;
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
export interface ImageQueryCommandV1 {
  version: 1;
  type: 'image.query';
  messageId: string;
  commandId: string;
  jobId: string;
  ownerId: string;
  expiresAt: number;
  profile: ImageProfile;
  operation: ImageOperation;
  input: ImageInput;
  upstreamTaskId: string;
  queryAttempt: number;
  credential: ImageEnvelope;
  queryCredential?: ImageEnvelope;
  queryDeadline?: number;
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
  | 'IMAGE_QUERY_UNKNOWN'
  | 'IMAGE_QUERY_FAILED'
  | 'IMAGE_QUERY_LIMIT'
  | 'IMAGE_CREDENTIAL_UNAVAILABLE'
  | 'IMAGE_HANDLER_UNAVAILABLE';
export interface ImageResultV1 {
  version: 1;
  type: 'image.result';
  messageId: string;
  commandId: string;
  jobId: string;
  state:
    | 'completed'
    | 'partial'
    | 'unknown'
    | 'rejected'
    | 'submitted'
    | 'processing'
    | 'failed'
    | 'materializing'
    | 'materialization_failed';
  outputs: ImageOutput[];
  errorCode?: ImageErrorCode;
  recoveryId?: string;
  upstreamTaskId?: string;
  queryAttempt?: number;
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

function validImageCredential(value: Record<string, unknown>): boolean {
  return (
    value.version === 1 &&
    ['keyId', 'wrappedKey', 'nonce', 'ciphertext', 'tag'].every(
      (key) =>
        typeof value[key] === 'string' && Boolean(value[key]) && String(value[key]).length <= 8192,
    )
  );
}

function validAssetRef(value: unknown, mask = false): value is ImageAssetRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  const prefix = typeof ref.assetId === 'string' ? `mio/raw/${ref.assetId}/` : '';
  const key = typeof ref.key === 'string' ? ref.key : '';
  return (
    Object.keys(ref).length === 5 &&
    typeof ref.assetId === 'string' &&
    uuid.test(ref.assetId) &&
    key.startsWith(prefix) &&
    uuid.test(key.slice(prefix.length)) &&
    Number.isSafeInteger(ref.sizeBytes) &&
    Number(ref.sizeBytes) > 0 &&
    typeof ref.etag === 'string' &&
    ref.etag.length > 0 &&
    ref.etag.length <= 256 &&
    !/[\x00-\x1f\x7f]/.test(ref.etag) &&
    ['image/png', 'image/jpeg', 'image/webp'].includes(String(ref.contentType)) &&
    (!mask || ref.contentType === 'image/png')
  );
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
    !validImageCredential(c) ||
    typeof input.model !== 'string' ||
    typeof input.prompt !== 'string' ||
    input.prompt.length > 32000 ||
    Object.keys(input).some(
      (k) =>
        ![
          'model',
          'prompt',
          'async',
          'operation',
          'image',
          'images',
          'mask',
          'geometry',
          'n',
          'background',
          'moderation',
          'quality',
          'size',
          'output_format',
          'output_compression',
          'user',
        ].includes(k),
    ) ||
    !validImageInput(input as unknown as ImageInput, v.profile as ImageProfile)
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
export function parseImageQuery(value: unknown): ImageQueryCommandV1 {
  const v = object(value);
  fields(v, [
    'version',
    'type',
    'messageId',
    'commandId',
    'jobId',
    'ownerId',
    'expiresAt',
    'profile',
    'operation',
    'input',
    'upstreamTaskId',
    'queryAttempt',
    'credential',
    ...(v.queryCredential === undefined ? [] : ['queryCredential']),
    ...(v.queryDeadline === undefined ? [] : ['queryDeadline']),
  ]);
  const input = object(v.input);
  const credential = object(v.credential);
  fields(credential, ['version', 'keyId', 'wrappedKey', 'nonce', 'ciphertext', 'tag']);
  const queryCredential = v.queryCredential === undefined ? undefined : object(v.queryCredential);
  if (queryCredential)
    fields(queryCredential, ['version', 'keyId', 'wrappedKey', 'nonce', 'ciphertext', 'tag']);
  if (
    v.version !== 1 ||
    v.type !== 'image.query' ||
    !uuid.test(String(v.messageId)) ||
    !uuid.test(String(v.commandId)) ||
    !uuid.test(String(v.jobId)) ||
    typeof v.ownerId !== 'string' ||
    !v.ownerId ||
    v.ownerId.length > 256 ||
    !Number.isSafeInteger(v.expiresAt) ||
    !isImageProfile(v.profile) ||
    !IMAGE_OPERATIONS.includes(v.operation as ImageOperation) ||
    typeof v.upstreamTaskId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(v.upstreamTaskId) ||
    !Number.isSafeInteger(v.queryAttempt) ||
    Number(v.queryAttempt) < 1 ||
    Number(v.queryAttempt) > 16 ||
    !validImageCredential(credential) ||
    (queryCredential !== undefined && !validImageCredential(queryCredential)) ||
    (v.queryDeadline !== undefined &&
      (!Number.isSafeInteger(v.queryDeadline) ||
        Number(v.queryDeadline) < 1 ||
        Number(v.queryDeadline) > Number(v.expiresAt))) ||
    !validImageInput(input as unknown as ImageInput, v.profile as ImageProfile) ||
    input.async !== true ||
    v.operation !== (input.operation ?? 'generate')
  )
    throw new Error('IMAGE_MESSAGE_INVALID');
  return v as unknown as ImageQueryCommandV1;
}
export function imageQueryCredentialBinding(command: ImageQueryCommandV1): string {
  if (!Number.isSafeInteger(command.queryDeadline) || !command.queryDeadline)
    throw new Error('IMAGE_MESSAGE_INVALID');
  return JSON.stringify([
    'mio:image-query:1',
    command.jobId,
    command.ownerId,
    command.profile,
    canonicalImageInput(command.input),
    command.commandId,
    command.upstreamTaskId,
    command.queryAttempt,
    command.messageId,
    command.queryDeadline,
    command.expiresAt,
  ]);
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
    ...('upstreamTaskId' in v ? ['upstreamTaskId'] : []),
    ...('queryAttempt' in v ? ['queryAttempt'] : []),
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
      'submitted',
      'processing',
      'failed',
      'materializing',
      'materialization_failed',
    ].includes(String(v.state)) ||
    !Array.isArray(v.outputs) ||
    v.outputs.length > 10 ||
    (v.state === 'completed' && v.outputs.length < 1) ||
    (['unknown', 'rejected', 'submitted', 'processing', 'failed'].includes(String(v.state)) &&
      v.outputs.length !== 0)
  )
    throw new Error('IMAGE_MESSAGE_INVALID');
  if (v.recoveryId !== undefined && (typeof v.recoveryId !== 'string' || !uuid.test(v.recoveryId)))
    throw new Error('IMAGE_MESSAGE_INVALID');
  if (
    ['submitted', 'processing'].includes(String(v.state)) &&
    (typeof v.upstreamTaskId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(v.upstreamTaskId) ||
      !Number.isSafeInteger(v.queryAttempt) ||
      Number(v.queryAttempt) < 0 ||
      Number(v.queryAttempt) > 16)
  )
    throw new Error('IMAGE_MESSAGE_INVALID');
  if (
    v.state === 'failed' &&
    (typeof v.errorCode !== 'string' ||
      ![
        'IMAGE_QUERY_UNKNOWN',
        'IMAGE_QUERY_FAILED',
        'IMAGE_QUERY_LIMIT',
        'IMAGE_CREDENTIAL_UNAVAILABLE',
        'IMAGE_HANDLER_UNAVAILABLE',
      ].includes(v.errorCode))
  )
    throw new Error('IMAGE_MESSAGE_INVALID');
  if (
    v.errorCode !== undefined &&
    !(
      (v.state === 'unknown' &&
        ['IMAGE_SUBMISSION_UNKNOWN', 'IMAGE_QUERY_UNKNOWN'].includes(String(v.errorCode))) ||
      (v.state === 'failed' &&
        [
          'IMAGE_QUERY_UNKNOWN',
          'IMAGE_QUERY_FAILED',
          'IMAGE_QUERY_LIMIT',
          'IMAGE_CREDENTIAL_UNAVAILABLE',
          'IMAGE_HANDLER_UNAVAILABLE',
        ].includes(String(v.errorCode))) ||
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
  'async',
  'operation',
  'image',
  'images',
  'mask',
  'geometry',
  'n',
  'background',
  'moderation',
  'quality',
  'size',
  'output_format',
  'output_compression',
  'user',
]);

function validGptImageInput(input: ImageInput): boolean {
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
  if (input.async !== undefined && typeof input.async !== 'boolean') return false;
  const operation = input.operation ?? 'generate';
  if (!IMAGE_OPERATIONS.includes(operation)) return false;
  const rules = IMAGE_PROFILE_RULES[profile];
  if (!rules.supportedOperations.some((item) => item === operation)) return false;
  if (rules.requiresAsync && input.async !== true) return false;
  const images = input.images ?? (input.image ? [input.image] : []);
  if (input.image !== undefined && input.images !== undefined) return false;
  if (
    input.images !== undefined &&
    (!Array.isArray(input.images) ||
      input.images.length < 1 ||
      input.images.some((image) => !validAssetRef(image)) ||
      new Set(input.images.map((image) => image.assetId)).size !== input.images.length)
  )
    return false;
  if (input.geometry !== undefined && !validImageGeometry(input.geometry)) return false;
  if (
    operation === 'generate' &&
    ((!rules.allowGenerateReferences && images.length > 0) ||
      input.mask !== undefined ||
      input.geometry !== undefined)
  )
    return false;
  if (
    (operation === 'edit' || operation === 'outpaint') &&
    (images.length < 1 || (input.mask !== undefined && !validAssetRef(input.mask, true)))
  )
    return false;
  if (operation === 'edit' && input.mask !== undefined && images.length < 1) return false;
  if (operation === 'outpaint' && input.geometry === undefined) return false;
  if (operation !== 'outpaint' && input.geometry !== undefined) return false;
  switch (profile) {
    case 'seedream-4-images-v1':
      return (
        operation === 'generate' &&
        Object.keys(input).every((key) =>
          ['model', 'prompt', 'operation', 'n', 'size'].includes(key),
        ) &&
        (input.n === undefined || input.n === 1) &&
        (input.size === undefined || input.size === '1024x1024')
      );
    case 'vidu-image-v1':
      return (
        operation === 'generate' &&
        input.async === true &&
        input.image === undefined &&
        input.mask === undefined &&
        input.geometry === undefined &&
        input.n === undefined &&
        (input.size === undefined || ['1080p', '2K', '4K'].includes(input.size)) &&
        Object.keys(input).every((key) =>
          ['model', 'prompt', 'async', 'operation', 'images', 'n', 'size'].includes(key),
        )
      );
    case 'gpt-images-v1':
      return validGptImageInput(input);
    default: {
      const exhaustive: never = profile;
      void exhaustive;
      return false;
    }
  }
}

function validImageGeometry(value: unknown): value is ImageGeometry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const geometry = value as Record<string, unknown>;
  if (
    Object.keys(geometry).length !== IMAGE_GEOMETRY_EDGES.length ||
    IMAGE_GEOMETRY_EDGES.some((edge) => !Object.hasOwn(geometry, edge))
  )
    return false;
  const values = IMAGE_GEOMETRY_EDGES.map((edge) => geometry[edge]);
  return (
    values.every((value) => Number.isSafeInteger(value) && Number(value) >= 0) &&
    values.some((value) => Number(value) > 0)
  );
}

function canonicalImageValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalImageValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalImageValue(item)]),
  );
}

/** Stable recursive representation used for AAD and command identity across JSONB round-trips. */
export function canonicalImageInput(input: ImageInput): ImageInput {
  return canonicalImageValue(input) as ImageInput;
}
