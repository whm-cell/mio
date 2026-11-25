import type { VideoResultSource } from '../../../generations/video/execution.ts';

export const ONELINK_ORIGIN = 'https://api.onelinkai.cloud';
const MAX_VIDEO_RESPONSE_BYTES = 1024 * 1024;
export const TASK_ID = /^(?!\.{1,2}$)(?!.*\.\.)[A-Za-z0-9._:-]{1,256}$/;

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('VIDEO_RESPONSE_INVALID');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_VIDEO_RESPONSE_BYTES)) {
    await response.body.cancel();
    throw new Error('VIDEO_RESPONSE_INVALID');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_VIDEO_RESPONSE_BYTES) throw new Error('VIDEO_RESPONSE_INVALID');
      chunks.push(result.value);
    }
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('VIDEO_RESPONSE_INVALID');
    return value as Record<string, unknown>;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function endpoint(path: string): URL {
  const url = new URL(path, ONELINK_ORIGIN);
  if (
    url.origin !== ONELINK_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !path.startsWith('/') ||
    path.includes('..') ||
    path.includes('//')
  )
    throw new Error('VIDEO_ROUTE_INVALID');
  return url;
}

export function resultUrls(values: unknown[]): VideoResultSource[] | undefined {
  if (values.length === 0 || values.length > 16) return;
  const output: VideoResultSource[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 8192) return;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return;
      output.push({ url: url.href });
    } catch {
      return;
    }
  }
  return output;
}

/** A Veo operation remains a scoped path; arbitrary URLs never become authenticated requests. */
export function operationPath(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.length > 768) return;
  const value = name.replace(/^\//, '').replace(/^v1beta\//, '');
  if (
    !/^(?:operations\/[A-Za-z0-9._:-]+|models\/[A-Za-z0-9._:-]+\/operations\/[A-Za-z0-9._:-]+)$/.test(
      value,
    )
  )
    return;
  return '/v1beta/' + value;
}
