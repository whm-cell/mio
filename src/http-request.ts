import type { IncomingMessage } from 'node:http';
import { HttpError } from '@mio/foundation/errors';
import { HTTP_STATUS } from '@mio/foundation/http-status';

type RequestBodyErrorCode = 'BODY_TOO_LARGE' | 'BODY_TIMEOUT' | 'BODY_INVALID';
export class RequestBodyError extends HttpError<RequestBodyErrorCode> {}

/** Read raw bytes without interpreting authentication payloads. */
export function readBody(request: IncomingMessage, limit = 8192): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (code?: RequestBodyErrorCode) => {
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('error', fail);
      request.off('aborted', fail);
      if (code) {
        request.resume();
        reject(
          new RequestBodyError(
            code === 'BODY_TOO_LARGE'
              ? HTTP_STATUS.PAYLOAD_TOO_LARGE
              : code === 'BODY_TIMEOUT'
                ? HTTP_STATUS.REQUEST_TIMEOUT
                : HTTP_STATUS.BAD_REQUEST,
            code,
          ),
        );
      } else resolve(Buffer.concat(chunks));
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) finish('BODY_TOO_LARGE');
      else chunks.push(chunk);
    };
    const end = () => finish();
    const fail = () => finish('BODY_INVALID');
    const timer = setTimeout(() => finish('BODY_TIMEOUT'), 10_000);
    request.on('data', data).once('end', end).once('error', fail).once('aborted', fail);
  });
}

/** Shared bounded JSON reader for authenticated mutation endpoints. */
export async function readJsonBody(
  request: IncomingMessage,
  limit = 8192,
): Promise<Record<string, unknown>> {
  const bytes = await readBody(request, limit);
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new RequestBodyError(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
  }
}
