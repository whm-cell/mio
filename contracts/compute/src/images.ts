import type {
  ImageAssetRef,
  ImageDriver,
  ImageGeometry,
  ImageGeometryEdge,
  ImageInput,
  ImageOperation,
  ImageRequestParameters,
  ImageRouteConfig,
} from './image-routes.ts';
import {
  IMAGE_GEOMETRY_EDGES,
  IMAGE_INPUT_FIELDS,
  IMAGE_OPERATIONS,
  canonicalImageRouteConfig,
  canonicalImageValue,
  isImageDriver,
  validateImageInputByRoute,
  validateImageRouteConfig,
} from './image-routes.ts';

export { IMAGE_GEOMETRY_EDGES, IMAGE_OPERATIONS };
export type {
  ImageAssetRef,
  ImageGeometry,
  ImageGeometryEdge,
  ImageInput,
  ImageOperation,
  ImageRequestParameters,
};

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
  profile: ImageDriver;
  route: ImageRouteConfig;
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
  profile: ImageDriver;
  route: ImageRouteConfig;
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
const imageKey = new RegExp(`^([0-9]|1[0-5])-(${uuidText})\\.(png|jpeg|webp)$`);

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

function validCommandInput(
  profile: unknown,
  route: unknown,
  input: Record<string, unknown>,
): boolean {
  return (
    isImageDriver(profile) &&
    validateImageRouteConfig(route) &&
    profile === route.driver &&
    validateImageInputByRoute(input as unknown as ImageInput, route)
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
    'route',
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
    !validImageCredential(c) ||
    typeof input.model !== 'string' ||
    typeof input.prompt !== 'string' ||
    input.prompt.length > 32000 ||
    Object.keys(input).some((k) => !IMAGE_INPUT_FIELDS.has(k)) ||
    !validCommandInput(v.profile, v.route, input)
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
    'route',
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
    !validCommandInput(v.profile, v.route, input) ||
    input.async !== true ||
    v.operation !== (input.operation ?? 'generate')
  )
    throw new Error('IMAGE_MESSAGE_INVALID');
  return v as unknown as ImageQueryCommandV1;
}

export function imageCommandCredentialBinding(
  command: Pick<ImageCommandV1, 'jobId' | 'ownerId' | 'expiresAt' | 'profile' | 'input' | 'route'>,
): string {
  return JSON.stringify([
    command.jobId,
    command.ownerId,
    command.expiresAt,
    command.profile,
    canonicalImageInput(command.input),
    canonicalImageRouteConfig(command.route),
  ]);
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
    canonicalImageRouteConfig(command.route),
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
    index > 15 ||
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
    v.outputs.length > 16 ||
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

/** Stable recursive representation used for AAD and command identity across JSONB round-trips. */
export function canonicalImageInput(input: ImageInput): ImageInput {
  return canonicalImageValue(input) as ImageInput;
}
