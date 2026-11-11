import { isDeepStrictEqual } from 'node:util';
import { ComputeBroker } from '../../src/integrations/rabbitmq.ts';
import { computeCapacity, computePermissions, computeTopology } from './compute-broker-topology.ts';

type Json = Record<string, unknown>;

/** Missing resources may be created; existing resources must match, never overwritten or purged. */
export async function prepareLocalBroker(name: 'dev' | 'test', values: NodeJS.ProcessEnv) {
  const base = `http://127.0.0.1:${values.MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT}/api/`;
  const auth = Buffer.from(`mio-${name}-admin:${values.MIO_LOCAL_RABBITMQ_PASSWORD}`).toString(
    'base64',
  );
  async function api(method: string, path: string, body?: Json) {
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        method,
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(
        `LOCAL_BROKER_REQUEST_UNKNOWN: ${method} ${path}; inspect broker then rerun initialization`,
      );
    }
    if (method === 'GET' && response.status === 404) return null;
    if (!response.ok) throw new Error(`LOCAL_BROKER_HTTP: ${response.status} ${method} ${path}`);
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : null;
  }
  if (!(await api('GET', 'health/checks/ready-to-serve-clients')))
    throw new Error('LOCAL_BROKER_HEALTH_UNAVAILABLE');
  const flags = (await api('GET', 'feature-flags')) as Json[];
  if (!flags.some((flag) => flag.name === 'stream_queue' && flag.state === 'enabled'))
    throw new Error('LOCAL_BROKER_STREAM_FEATURE_REQUIRED');
  const vhost = `mio-${name}`;
  const resources = [
    { method: 'PUT', path: `vhosts/${vhost}`, body: {} },
    {
      method: 'PUT',
      path: `operator-policies/${vhost}/mio-capacity`,
      body: {
        pattern: '.*',
        definition: computeCapacity,
        priority: 0,
        'apply-to': 'queues',
      },
    },
    ...computeTopology(vhost),
  ];
  for (const role of ['a', 'b'] as const) {
    const user = `mio-${name}-${role}`;
    resources.push({
      method: 'PUT',
      path: `users/${user}`,
      body: {
        password: values[`MIO_LOCAL_RABBITMQ_${role.toUpperCase()}_PASSWORD`],
        hashing_algorithm: 'rabbit_password_hashing_sha256',
        tags: [],
      },
    });
    resources.push({
      method: 'PUT',
      path: `permissions/${vhost}/${user}`,
      body: computePermissions(role),
    });
  }
  const missing: typeof resources = [];
  // Preflight everything before the first write. A failed/unknown write leaves resources for rerun.
  for (const resource of resources) {
    const current = await api('GET', resource.path);
    if (current === null || (Array.isArray(current) && current.length === 0)) {
      missing.push(resource);
      continue;
    }
    const actual = (
      resource.method === 'POST' && Array.isArray(current) && current.length === 1
        ? current[0]
        : current
    ) as Json;
    const expected: Json = { ...resource.body };
    if (resource.path.startsWith('users/')) {
      // RabbitMQ 4.4 omits password hashes from this endpoint. Verify via AMQP below.
      expected.has_password = true;
      delete expected.password;
    }
    if (!Object.entries(expected).every(([key, value]) => isDeepStrictEqual(actual[key], value)))
      throw new Error(
        `LOCAL_BROKER_CONFLICT: ${resource.path}; preserve data and inspect configuration drift`,
      );
  }
  for (const resource of missing) await api(resource.method, resource.path, resource.body);
  for (const role of ['a', 'b'] as const) {
    const url = new URL(values.RABBITMQ_URL!);
    url.username = `mio-${name}-${role}`;
    url.password = values[`MIO_LOCAL_RABBITMQ_${role.toUpperCase()}_PASSWORD`]!;
    try {
      // Connection setup is shared transport code; do not publish or consume through A's API here.
      const broker = await ComputeBroker.connect(
        url.toString(),
        url.username,
        `mio-${name}-${role === 'a' ? 'b' : 'a'}`,
      );
      await broker.close();
    } catch {
      throw new Error(
        `LOCAL_BROKER_LOGIN_FAILED: mio-${name}-${role}; restore the original credentials, do not reset users`,
      );
    }
  }
  console.log(
    `${name}: RabbitMQ topology and A/B permissions ready (${missing.length} resources created)`,
  );
}
