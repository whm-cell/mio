import { createClient, ErrorReply } from '@redis/client';

export interface RedisConfig {
  url: string;
  namespace: string;
}

/** Only called for a configured consumer. Unused Redis environment never enables a resource. */
export function readRedisConfig(env: NodeJS.ProcessEnv = process.env): RedisConfig {
  let url: URL;
  try {
    url = new URL(env.MIO_REDIS_URL!);
  } catch {
    throw new Error('REDIS_CONFIG: valid URL and namespace are required');
  }
  if (
    !['redis:', 'rediss:'].includes(url.protocol) ||
    !url.hostname ||
    url.hash ||
    url.search ||
    (url.protocol === 'redis:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
    !/^[a-z0-9_-]{1,64}$/.test(env.MIO_REDIS_NAMESPACE ?? '')
  )
    throw new Error('REDIS_CONFIG: use TLS remotely and a stable lowercase namespace');
  return { url: env.MIO_REDIS_URL!, namespace: env.MIO_REDIS_NAMESPACE! };
}

/** Rejected means definitely not executed; unknown must never be retried on this connection. */
export class RedisFailure extends Error {
  readonly kind: 'unavailable' | 'rejected' | 'unknown';
  constructor(kind: RedisFailure['kind']) {
    super(`REDIS_${kind.toUpperCase()}`);
    this.kind = kind;
  }
}

/** One single-node resource, with no reconnect, offline queue, command replay or driver escape. */
export async function createRedisResource(
  config: RedisConfig,
  startupDeadline = performance.now() + 5000,
) {
  const lifetime = new AbortController();
  const client = createClient({
    url: config.url,
    socket: { connectTimeout: 5000, reconnectStrategy: false, signal: lifetime.signal },
    disableOfflineQueue: true,
    commandsQueueMaxLength: 128,
  });
  let accepting = true;
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const stop = () => {
    accepting = false;
    // Also reaches the TCP/TLS socket before node-redis has acquired it (DNS/handshake).
    lifetime.abort();
    if (client.isOpen) client.destroy();
  };
  client.on('error', stop);

  // node-redis's command timeout only covers commands not yet written to the socket.
  // This deadline also covers an accepted write whose response never arrives.
  const bounded = async <T>(operation: () => Promise<T>, milliseconds: number): Promise<T> => {
    const deadline = performance.now() + milliseconds;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (milliseconds <= 0) {
        stop();
        throw new RedisFailure('unknown');
      }
      const result = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            stop();
            reject(new RedisFailure('unknown'));
          }, milliseconds);
        }),
      ]);
      // A blocked event loop can process I/O before the overdue timer callback.
      if (performance.now() >= deadline) {
        stop();
        throw new RedisFailure('unknown');
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await bounded(() => client.connect(), startupDeadline - performance.now());
  } catch {
    stop();
    throw new Error('REDIS_STARTUP: resource unavailable');
  }

  const execute = async (args: string[], milliseconds = 1000) => {
    if (!accepting || !client.isReady) throw new RedisFailure('unavailable');
    let operation: Promise<unknown> | undefined;
    try {
      return await bounded(() => {
        operation = client.sendCommand(args);
        pending.add(operation);
        return operation;
      }, milliseconds);
    } catch (error) {
      // This exact top-level OOM rejects EVAL before the script runs. Script errors,
      // including OOM within a script or WRONGTYPE, do not establish state integrity.
      if (
        (error instanceof ErrorReply &&
          [
            "OOM command not allowed when used memory > 'maxmemory'.",
            "OOM allow-oom flag is not set on the script, can not run it when used memory > 'maxmemory'",
          ].includes(error.message)) ||
        (error instanceof Error &&
          !(error instanceof ErrorReply) &&
          error.message === 'The queue is full')
      )
        throw new RedisFailure('rejected');
      stop();
      throw error instanceof RedisFailure ? error : new RedisFailure('unknown');
    } finally {
      if (operation) pending.delete(operation);
    }
  };
  return {
    evaluate: (script: string, key: string, args: string[], milliseconds?: number) =>
      execute(['EVAL', script, '1', key, ...args], milliseconds),
    ttl: (key: string, milliseconds?: number) => execute(['PTTL', key], milliseconds),
    delete: (key: string, milliseconds?: number) => execute(['DEL', key], milliseconds),
    stop,
    close() {
      accepting = false;
      closing ??= (async () => {
        if (!client.isOpen) return;
        try {
          // In 6.2.1 close() marks the socket closed before draining, after which
          // destroy() cannot destroy it. Drain our finite operations first, then
          // destroy while the client is still open; never await an unbounded close.
          await bounded(() => Promise.allSettled([...pending]), 1000);
        } catch {
          // A deadline expires the wait, not the obligation to destroy below.
        } finally {
          stop();
        }
      })();
      return closing;
    },
  };
}

export type RedisResource = Awaited<ReturnType<typeof createRedisResource>>;
