export * from './image-routes.ts';

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

const uuidText = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const uuid = new RegExp(`^${uuidText}$`);
const imageKey = new RegExp(`^([0-9]|1[0-5])-(${uuidText})\\.(png|jpeg|webp)$`);

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

export const IMAGE_MAX_MESSAGE_BYTES = 160_000;
export const IMAGE_USER_QUOTA = 32;
export const IMAGE_GLOBAL_QUOTA = 1000;
