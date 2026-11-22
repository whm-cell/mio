import { epochMs, monotonicMs, utcISOString } from '@mio/foundation/time';
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
  startupDeadline = monotonicMs() + 5000,
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
    const deadline = monotonicMs() + milliseconds;
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
      if (monotonicMs() >= deadline) {
        stop();
        throw new RedisFailure('unknown');
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await bounded(() => client.connect(), startupDeadline - monotonicMs());
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

export interface RedisMonitorConfig {
  readonly url: string;
}

export interface RedisMonitorSnapshot {
  readonly configured: boolean;
  readonly status: 'up' | 'down' | 'unconfigured';
  readonly checkedAt: string;
  readonly latencyMs: number | null;
  readonly errorCode: string | null;
  readonly redisVersion: string | null;
  readonly uptimeSeconds: number | null;
  readonly clockDriftMs: number | null;
  readonly clockHealthy: boolean | null;
  readonly dbsize: number | null;
  readonly memory: {
    readonly usedBytes: number;
    readonly usedHuman: string;
    readonly peakBytes: number;
    readonly peakHuman: string;
    readonly maxBytes: number;
    readonly maxHuman: string;
    readonly policy: string;
    readonly usageRatio: number | null;
    readonly fragmentationRatio: number | null;
    readonly oomRisk: boolean;
  } | null;
  readonly clients: {
    readonly connected: number;
    readonly blocked: number;
    readonly rejectedConnections: number;
  } | null;
  readonly stats: {
    readonly instantaneousOpsPerSec: number;
    readonly totalCommandsProcessed: number;
    readonly evictedKeys: number;
    readonly keyspaceHits: number;
    readonly keyspaceMisses: number;
  } | null;
  readonly persistence: {
    readonly aofEnabled: boolean;
    readonly aofLastWriteStatus: string;
    readonly rdbLastBgsaveStatus: string;
  } | null;
}

export function readRedisMonitorConfig(
  env: NodeJS.ProcessEnv = process.env,
): RedisMonitorConfig | undefined {
  const raw = env.MIO_ADMIN_REDIS_MONITOR_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('REDIS_MONITOR_CONFIG: valid MIO_ADMIN_REDIS_MONITOR_URL is required');
  }
  if (
    !['redis:', 'rediss:'].includes(url.protocol) ||
    !url.hostname ||
    url.hash ||
    url.search ||
    (url.protocol === 'redis:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  ) {
    throw new Error('REDIS_MONITOR_CONFIG: use TLS remotely and omit query/fragment');
  }
  return { url: raw };
}

function parseRedisInfo(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    map.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return map;
}

/** Isolated zero-key-access probe connection; failures never affect the auth rate-limit resource. */
export async function probeRedisMetrics(
  config: RedisMonitorConfig | undefined,
  timeoutMs = 3000,
): Promise<RedisMonitorSnapshot> {
  const checkedAt = utcISOString();
  if (!config) {
    return {
      configured: false,
      status: 'unconfigured',
      checkedAt,
      latencyMs: null,
      errorCode: null,
      redisVersion: null,
      uptimeSeconds: null,
      clockDriftMs: null,
      clockHealthy: null,
      dbsize: null,
      memory: null,
      clients: null,
      stats: null,
      persistence: null,
    };
  }
  const lifetime = new AbortController();
  const client = createClient({
    url: config.url,
    socket: { connectTimeout: timeoutMs, reconnectStrategy: false, signal: lifetime.signal },
    disableOfflineQueue: true,
    commandsQueueMaxLength: 16,
  });
  const closeClient = () => {
    lifetime.abort();
    if (client.isOpen) client.destroy();
  };
  client.on('error', () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = monotonicMs();
  try {
    const result = await Promise.race([
      (async () => {
        await client.connect();
        const pingStart = monotonicMs();
        await client.sendCommand(['PING']);
        const latencyMs = Math.max(0, Math.round((monotonicMs() - pingStart) * 10) / 10);
        const [timeReply, dbsizeReply, infoReply] = await Promise.all([
          client.sendCommand(['TIME']),
          client.sendCommand(['DBSIZE']),
          client.sendCommand([
            'INFO',
            'server',
            'memory',
            'clients',
            'stats',
            'persistence',
            'keyspace',
          ]),
        ]);
        const localMs = epochMs();
        let clockDriftMs: number | null = null;
        if (Array.isArray(timeReply) && timeReply.length >= 2) {
          const sec = Number(timeReply[0]);
          const usec = Number(timeReply[1]);
          if (Number.isFinite(sec) && Number.isFinite(usec)) {
            const redisMs = sec * 1000 + Math.round(usec / 1000);
            clockDriftMs = redisMs - localMs;
          }
        }
        const dbsize = Number.isFinite(Number(dbsizeReply)) ? Number(dbsizeReply) : 0;
        const info = parseRedisInfo(typeof infoReply === 'string' ? infoReply : '');
        const intVal = (key: string) => {
          const n = Number(info.get(key) ?? 0);
          return Number.isFinite(n) ? n : 0;
        };
        const usedBytes = intVal('used_memory');
        const maxBytes = intVal('maxmemory');
        const policy = info.get('maxmemory_policy') ?? 'unknown';
        const usageRatio = maxBytes > 0 ? Math.round((usedBytes / maxBytes) * 10000) / 10000 : null;
        const fragRaw = Number(info.get('mem_fragmentation_ratio') ?? '');
        return {
          configured: true,
          status: 'up' as const,
          checkedAt: utcISOString(),
          latencyMs,
          errorCode: null,
          redisVersion: info.get('redis_version') ?? null,
          uptimeSeconds: intVal('uptime_in_seconds'),
          clockDriftMs,
          clockHealthy: clockDriftMs !== null ? Math.abs(clockDriftMs) < 2000 : null,
          dbsize,
          memory: {
            usedBytes,
            usedHuman: info.get('used_memory_human') ?? `${usedBytes}B`,
            peakBytes: intVal('used_memory_peak'),
            peakHuman: info.get('used_memory_peak_human') ?? '0B',
            maxBytes,
            maxHuman: info.get('maxmemory_human') ?? (maxBytes > 0 ? `${maxBytes}B` : 'unlimited'),
            policy,
            usageRatio,
            fragmentationRatio: Number.isFinite(fragRaw) ? fragRaw : null,
            oomRisk: policy === 'noeviction' && usageRatio !== null && usageRatio >= 0.85,
          },
          clients: {
            connected: intVal('connected_clients'),
            blocked: intVal('blocked_clients'),
            rejectedConnections: intVal('rejected_connections'),
          },
          stats: {
            instantaneousOpsPerSec: intVal('instantaneous_ops_per_sec'),
            totalCommandsProcessed: intVal('total_commands_processed'),
            evictedKeys: intVal('evicted_keys'),
            keyspaceHits: intVal('keyspace_hits'),
            keyspaceMisses: intVal('keyspace_misses'),
          },
          persistence: {
            aofEnabled: (info.get('aof_enabled') ?? '0') === '1',
            aofLastWriteStatus: info.get('aof_last_write_status') ?? 'unknown',
            rdbLastBgsaveStatus: info.get('rdb_last_bgsave_status') ?? 'unknown',
          },
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('REDIS_MONITOR_TIMEOUT')), timeoutMs);
      }),
    ]);
    return result;
  } catch (error) {
    const code =
      error instanceof ErrorReply
        ? error.message.startsWith('WRONGPASS') || error.message.startsWith('NOAUTH')
          ? 'REDIS_AUTH_FAILED'
          : error.message.startsWith('NOPERM')
            ? 'REDIS_ACL_DENIED'
            : 'REDIS_COMMAND_ERROR'
        : error instanceof Error && error.message === 'REDIS_MONITOR_TIMEOUT'
          ? 'REDIS_MONITOR_TIMEOUT'
          : 'REDIS_UNREACHABLE';
    return {
      configured: true,
      status: 'down',
      checkedAt: utcISOString(),
      latencyMs: Math.max(0, Math.round((monotonicMs() - startedAt) * 10) / 10),
      errorCode: code,
      redisVersion: null,
      uptimeSeconds: null,
      clockDriftMs: null,
      clockHealthy: null,
      dbsize: null,
      memory: null,
      clients: null,
      stats: null,
      persistence: null,
    };
  } finally {
    clearTimeout(timer);
    closeClient();
  }
}
