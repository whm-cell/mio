import type { IncomingMessage } from 'node:http';

export class RequestBodyError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** Shared bounded JSON reader for authenticated mutation endpoints. */
export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (code?: string) => {
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('error', fail);
      request.off('aborted', fail);
      if (code) {
        request.resume();
        reject(
          new RequestBodyError(
            code === 'BODY_TOO_LARGE' ? 413 : code === 'BODY_TIMEOUT' ? 408 : 400,
            code,
          ),
        );
      } else resolve(Buffer.concat(chunks));
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) finish('BODY_TOO_LARGE');
      else chunks.push(chunk);
    };
    const end = () => finish();
    const fail = () => finish('BODY_INVALID');
    const timer = setTimeout(() => finish('BODY_TIMEOUT'), 10_000);
    request.on('data', data).once('end', end).once('error', fail).once('aborted', fail);
  });
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new RequestBodyError(400, 'BODY_INVALID');
  }
}
