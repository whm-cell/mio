import { monotonicMs, utcISOString } from '@mio/foundation/time';

export interface RabbitmqMonitorConfig {
  readonly baseUrl: string;
  readonly authorization: string;
  readonly vhost: string;
}

export interface RabbitmqNodeHealth {
  readonly name: string;
  readonly running: boolean;
  readonly memUsedBytes: number;
  readonly memLimitBytes: number;
  readonly memAlarm: boolean;
  readonly diskFreeBytes: number;
  readonly diskFreeLimitBytes: number;
  readonly diskFreeAlarm: boolean;
  readonly fdUsed: number;
  readonly fdTotal: number;
  readonly socketsUsed: number;
  readonly socketsTotal: number;
  readonly procUsed: number;
  readonly procTotal: number;
  readonly uptimeMs: number;
}

export interface RabbitmqQueueMetrics {
  readonly name: string;
  readonly type: string;
  readonly state: string;
  readonly isDlq: boolean;
  readonly consumers: number;
  readonly messages: number;
  readonly messagesReady: number;
  readonly messagesUnacknowledged: number;
  readonly memoryBytes: number;
  readonly publishPerSec: number;
  readonly deliverPerSec: number;
  readonly ackPerSec: number;
}

export interface RabbitmqMonitorSnapshot {
  readonly configured: boolean;
  readonly status: 'up' | 'down' | 'unconfigured';
  readonly checkedAt: string;
  readonly latencyMs: number | null;
  readonly vhost: string | null;
  readonly errorCode: string | null;
  readonly rabbitmqVersion: string | null;
  readonly erlangVersion: string | null;
  readonly clusterName: string | null;
  readonly hasAlarms: boolean;
  readonly dlqMessages: number;
  readonly objectTotals: {
    readonly connections: number;
    readonly channels: number;
    readonly exchanges: number;
    readonly queues: number;
    readonly consumers: number;
  } | null;
  readonly queueTotals: {
    readonly messages: number;
    readonly messagesReady: number;
    readonly messagesUnacknowledged: number;
  } | null;
  readonly rates: {
    readonly publishPerSec: number;
    readonly deliverGetPerSec: number;
    readonly ackPerSec: number;
  } | null;
  readonly nodes: readonly RabbitmqNodeHealth[];
  readonly queues: readonly RabbitmqQueueMetrics[];
}

export function readRabbitmqMonitorConfig(
  env: NodeJS.ProcessEnv = process.env,
): RabbitmqMonitorConfig | undefined {
  const raw = env.MIO_ADMIN_RABBITMQ_MONITOR_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('RABBITMQ_MONITOR_CONFIG: valid MIO_ADMIN_RABBITMQ_MONITOR_URL is required');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    url.search ||
    url.hash ||
    (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  ) {
    throw new Error(
      'RABBITMQ_MONITOR_CONFIG: require credentials, HTTPS remotely and no query/fragment',
    );
  }
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  if (segments.length !== 1 || !segments[0]) {
    throw new Error('RABBITMQ_MONITOR_CONFIG: URL path must specify exact /<vhost>');
  }
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  return {
    baseUrl: `${url.origin}/api/`,
    authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
    vhost: segments[0],
  };
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rateOf(container: unknown, key: string): number {
  if (!container || typeof container !== 'object') return 0;
  const detail = (container as Record<string, unknown>)[`${key}_details`];
  if (!detail || typeof detail !== 'object') return 0;
  return Math.round(num((detail as Record<string, unknown>).rate) * 100) / 100;
}

/** Read-only RabbitMQ Management HTTP probe using dedicated monitoring credentials. */
export async function probeRabbitmqMetrics(
  config: RabbitmqMonitorConfig | undefined,
  transport: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<RabbitmqMonitorSnapshot> {
  const checkedAt = utcISOString();
  if (!config) {
    return {
      configured: false,
      status: 'unconfigured',
      checkedAt,
      latencyMs: null,
      vhost: null,
      errorCode: null,
      rabbitmqVersion: null,
      erlangVersion: null,
      clusterName: null,
      hasAlarms: false,
      dlqMessages: 0,
      objectTotals: null,
      queueTotals: null,
      rates: null,
      nodes: [],
      queues: [],
    };
  }

  const startedAt = monotonicMs();
  const fetchJson = async (path: string): Promise<unknown> => {
    const response = await transport(new URL(path, config.baseUrl), {
      method: 'GET',
      headers: {
        authorization: config.authorization,
        accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error('RABBITMQ_AUTH_DENIED');
    }
    if (!response.ok) {
      throw new Error(`RABBITMQ_HTTP_${response.status}`);
    }
    return response.json();
  };

  try {
    const [overviewRaw, nodesRaw, queuesRaw] = await Promise.all([
      fetchJson('overview'),
      fetchJson('nodes'),
      fetchJson(`queues/${encodeURIComponent(config.vhost)}`),
    ]);
    const latencyMs = Math.max(0, Math.round((monotonicMs() - startedAt) * 10) / 10);
    const overview =
      overviewRaw && typeof overviewRaw === 'object'
        ? (overviewRaw as Record<string, unknown>)
        : {};
    const objTotals =
      overview.object_totals && typeof overview.object_totals === 'object'
        ? (overview.object_totals as Record<string, unknown>)
        : {};
    const qTotals =
      overview.queue_totals && typeof overview.queue_totals === 'object'
        ? (overview.queue_totals as Record<string, unknown>)
        : {};
    const msgStats = overview.message_stats;

    const nodes: RabbitmqNodeHealth[] = Array.isArray(nodesRaw)
      ? nodesRaw
          .filter((item): item is Record<string, unknown> =>
            Boolean(item && typeof item === 'object'),
          )
          .map((node) => ({
            name: typeof node.name === 'string' ? node.name : 'unknown',
            running: Boolean(node.running),
            memUsedBytes: num(node.mem_used),
            memLimitBytes: num(node.mem_limit),
            memAlarm: Boolean(node.mem_alarm),
            diskFreeBytes: num(node.disk_free),
            diskFreeLimitBytes: num(node.disk_free_limit),
            diskFreeAlarm: Boolean(node.disk_free_alarm),
            fdUsed: num(node.fd_used),
            fdTotal: num(node.fd_total),
            socketsUsed: num(node.sockets_used),
            socketsTotal: num(node.sockets_total),
            procUsed: num(node.proc_used),
            procTotal: num(node.proc_total),
            uptimeMs: num(node.uptime),
          }))
      : [];

    const queues: RabbitmqQueueMetrics[] = Array.isArray(queuesRaw)
      ? queuesRaw
          .filter((item): item is Record<string, unknown> =>
            Boolean(item && typeof item === 'object'),
          )
          .map((q) => {
            const name = typeof q.name === 'string' ? q.name : 'unknown';
            const stats = q.message_stats;
            return {
              name,
              type: typeof q.type === 'string' ? q.type : 'classic',
              state: typeof q.state === 'string' ? q.state : 'unknown',
              isDlq: /(?:^|\.)dlq(?:\.|$)/i.test(name),
              consumers: num(q.consumers),
              messages: num(q.messages),
              messagesReady: num(q.messages_ready),
              messagesUnacknowledged: num(q.messages_unacknowledged),
              memoryBytes: num(q.memory),
              publishPerSec: rateOf(stats, 'publish'),
              deliverPerSec: rateOf(stats, 'deliver_get'),
              ackPerSec: rateOf(stats, 'ack'),
            };
          })
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      : [];

    const hasAlarms = nodes.some((n) => !n.running || n.memAlarm || n.diskFreeAlarm);
    const dlqMessages = queues.reduce((sum, q) => (q.isDlq ? sum + q.messages : sum), 0);

    return {
      configured: true,
      status: 'up',
      checkedAt: utcISOString(),
      latencyMs,
      vhost: config.vhost,
      errorCode: null,
      rabbitmqVersion:
        typeof overview.rabbitmq_version === 'string' ? overview.rabbitmq_version : null,
      erlangVersion: typeof overview.erlang_version === 'string' ? overview.erlang_version : null,
      clusterName: typeof overview.cluster_name === 'string' ? overview.cluster_name : null,
      hasAlarms,
      dlqMessages,
      objectTotals: {
        connections: num(objTotals.connections),
        channels: num(objTotals.channels),
        exchanges: num(objTotals.exchanges),
        queues: num(objTotals.queues),
        consumers: num(objTotals.consumers),
      },
      queueTotals: {
        messages: num(qTotals.messages),
        messagesReady: num(qTotals.messages_ready),
        messagesUnacknowledged: num(qTotals.messages_unacknowledged),
      },
      rates: {
        publishPerSec: rateOf(msgStats, 'publish'),
        deliverGetPerSec: rateOf(msgStats, 'deliver_get'),
        ackPerSec: rateOf(msgStats, 'ack'),
      },
      nodes,
      queues,
    };
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : '';
    const errorCode =
      rawMsg === 'RABBITMQ_AUTH_DENIED' || /^RABBITMQ_HTTP_\d{3}$/.test(rawMsg)
        ? rawMsg
        : error instanceof DOMException && error.name === 'TimeoutError'
          ? 'RABBITMQ_MONITOR_TIMEOUT'
          : 'RABBITMQ_UNREACHABLE';
    return {
      configured: true,
      status: 'down',
      checkedAt: utcISOString(),
      latencyMs: Math.max(0, Math.round((monotonicMs() - startedAt) * 10) / 10),
      vhost: config.vhost,
      errorCode,
      rabbitmqVersion: null,
      erlangVersion: null,
      clusterName: null,
      hasAlarms: false,
      dlqMessages: 0,
      objectTotals: null,
      queueTotals: null,
      rates: null,
      nodes: [],
      queues: [],
    };
  }
}
