import { isDeepStrictEqual } from 'node:util';
import { ComputeBroker } from '../../src/integrations/rabbitmq.ts';
import { computeCapacity, computePermissions, computeTopology } from './compute-broker-topology.ts';

type Json = Record<string, unknown>;

/** Verify operator-provisioned resources and declare only the matching media topology. */
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
        redirect: 'error',
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
  async function absent(path: string, expected: Json, binding = false): Promise<boolean> {
    const current = await api('GET', path);
    if (current === null || (binding && Array.isArray(current) && current.length === 0))
      return true;
    const actual = (
      binding && Array.isArray(current) && current.length === 1 ? current[0] : current
    ) as Json;
    if (!Object.entries(expected).every(([key, value]) => isDeepStrictEqual(actual[key], value)))
      throw new Error(
        `LOCAL_BROKER_CONFLICT: ${path}; preserve data and inspect configuration drift`,
      );
    return false;
  }
  if (!(await api('GET', 'health/checks/ready-to-serve-clients')))
    throw new Error('LOCAL_BROKER_HEALTH_UNAVAILABLE');
  const flags = (await api('GET', 'feature-flags')) as Json[];
  if (!flags.some((flag) => flag.name === 'stream_queue' && flag.state === 'enabled'))
    throw new Error('LOCAL_BROKER_STREAM_FEATURE_REQUIRED');
  const vhost = `mio-${name}`;
  const vhostPath = `vhosts/${vhost}`;
  const capacityPath = `operator-policies/${vhost}/mio-capacity`;
  const roles = ['a', 'b'] as const;
  // These management endpoints can replace existing metadata. Compose provisions the root vhost.
  const prerequisites: { path: string; expected: Json }[] = [
    { path: vhostPath, expected: {} },
    {
      path: capacityPath,
      expected: {
        pattern: '.*',
        definition: computeCapacity,
        priority: 0,
        'apply-to': 'queues',
      },
    },
  ];
  for (const role of roles) {
    const user = `mio-${name}-${role}`;
    prerequisites.push({
      path: `users/${user}`,
      // RabbitMQ 4.4 omits the password hash. Verify credentials via AMQP once provisioned.
      expected: {
        has_password: true,
        hashing_algorithm: 'rabbit_password_hashing_sha256',
        tags: [],
      },
    });
    prerequisites.push({
      path: `permissions/${vhost}/${user}`,
      expected: computePermissions(role),
    });
  }
  async function readPrerequisiteGaps() {
    const missing = new Set<string>();
    for (const { path, expected } of prerequisites) {
      if (await absent(path, expected)) missing.add(path);
    }
    return missing;
  }
  const missingPrerequisites = await readPrerequisiteGaps();
  const topology = computeTopology(vhost);
  const missingTopology: typeof topology = [];
  // Preflight everything before the first write. A failed/unknown write leaves resources for rerun.
  if (!missingPrerequisites.has(vhostPath)) {
    for (const resource of topology) {
      if (await absent(resource.path, resource.body, resource.method === 'POST'))
        missingTopology.push(resource);
    }
  }
  // Exchanges are safe without the capacity policy. Queues and bindings wait for it.
  const declarations = missingPrerequisites.has(capacityPath)
    ? missingTopology.filter(({ path }) => path.startsWith('exchanges/'))
    : missingTopology;
  for (const resource of declarations) await api(resource.method, resource.path, resource.body);
  function requireProvisioned(missing: Set<string>) {
    if (missing.size)
      throw new Error(
        `LOCAL_BROKER_PREPROVISION_REQUIRED: ${[...missing].join(', ')}\n` +
          `Safe topology declarations completed: ${declarations.length}. Check current resources before provisioning. See docs/integrations/rabbitmq.md#预置本地-broker and rerun pnpm broker:init:${name}.`,
      );
  }
  requireProvisioned(missingPrerequisites);

  let failedLogin: string | undefined;
  for (const role of roles) {
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
      failedLogin = url.username;
      break;
    }
  }
  // Login alone cannot verify that an administrator kept the same permission or policy.
  requireProvisioned(await readPrerequisiteGaps());
  if (failedLogin)
    throw new Error(
      `LOCAL_BROKER_LOGIN_FAILED: ${failedLogin}; restore the original credentials, do not reset users`,
    );
  console.log(
    `${name}: RabbitMQ topology and A/B permissions ready (${declarations.length} declarations applied)`,
  );
}
