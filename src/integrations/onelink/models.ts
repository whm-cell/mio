import { isDeepStrictEqual } from 'node:util';

/** Fixed destination. A complete response establishes membership, not a protocol declaration. */
export const ONELINK_ORIGIN = 'https://api.onelinkai.cloud';
export type ModelTransport = (url: string, options: RequestInit) => Promise<Response>;
export interface DiscoveredModel {
  id: string;
  metadata: Record<string, unknown>;
}
export class DiscoveryError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export async function discoverModels(
  apiKey: string,
  transport: ModelTransport = fetch,
  timeoutMs = 10_000,
  cancellation?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = cancellation ? AbortSignal.any([timeout, cancellation]) : timeout;
  try {
    const response = await transport(`${ONELINK_ORIGIN}/v1/models`, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DiscoveryError(
        response.status === 401 || response.status === 403
          ? 'UPSTREAM_AUTH_REJECTED'
          : response.status === 429
            ? 'UPSTREAM_RATE_LIMITED'
            : 'UPSTREAM_UNAVAILABLE',
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new DiscoveryError('UPSTREAM_RESPONSE_INVALID');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2 * 1024 * 1024) throw new DiscoveryError('UPSTREAM_RESPONSE_TOO_LARGE');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    // Never persist a credential echoed anywhere in supplier metadata.
    if (raw.includes(apiKey)) throw new DiscoveryError('UPSTREAM_RESPONSE_INVALID');
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      !('data' in value) ||
      !Array.isArray(value.data) ||
      value.data.length > 5000 ||
      ('has_more' in value && value.has_more !== false) ||
      ('next' in value && value.next !== null) ||
      ('next_cursor' in value && value.next_cursor !== null)
    )
      throw new DiscoveryError('UPSTREAM_RESPONSE_INVALID');
    const originals = new Map<string, unknown>();
    const models: DiscoveredModel[] = [];
    for (const item of value.data) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof item.id !== 'string' ||
        !item.id ||
        item.id.includes(apiKey) ||
        Buffer.byteLength(item.id) > 256 ||
        /[\u0000-\u001f\u007f]/.test(item.id)
      )
        throw new DiscoveryError('UPSTREAM_RESPONSE_INVALID');
      if (Buffer.byteLength(JSON.stringify(item)) > 16384)
        throw new DiscoveryError('UPSTREAM_RESPONSE_INVALID');
      if (originals.has(item.id)) {
        if (!isDeepStrictEqual(originals.get(item.id), item))
          throw new DiscoveryError('UPSTREAM_RESPONSE_INVALID');
        continue;
      }
      const metadata: Record<string, unknown> = {};
      for (const field of ['object', 'owned_by', 'description'] as const) {
        if (field in item) {
          if (typeof item[field] !== 'string' || item[field].includes(apiKey))
            throw new DiscoveryError('UPSTREAM_RESPONSE_INVALID');
          metadata[field] = item[field];
        }
      }
      if ('created' in item) {
        if (!Number.isSafeInteger(item.created) || Number(item.created) < 0)
          throw new DiscoveryError('UPSTREAM_RESPONSE_INVALID');
        metadata.created = item.created;
      }
      // The documented schema has no authoritative per-model protocol or classification.
      originals.set(item.id, item);
      models.push({ id: item.id, metadata });
    }
    return models;
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError(
      cancellation?.aborted
        ? 'UPSTREAM_CANCELLED'
        : timeout.aborted
          ? 'UPSTREAM_TIMEOUT'
          : 'UPSTREAM_RESPONSE_OR_TRANSPORT_ERROR',
    );
  }
}
