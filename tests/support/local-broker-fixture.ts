import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import {
  COMMAND_QUEUE,
  MEDIA_ENCODE_QUEUE,
  VIDEO_PROBE_COMMAND_QUEUE,
  VIDEO_PROBE_COMMAND_ROUTING_KEY,
} from '@mio/compute-contracts';
import {
  audioResultPolicy,
  computeCapacity,
  computePermissions,
  computeTopology,
} from '../../scripts/service/compute-broker-topology.ts';

const run = promisify(execFile);
const image =
  'rabbitmq:4.4.0-management@sha256:af6f50d38098d8bd52fef7f3fa85015dd8b2bf6def58e995bf584ae9ba0f6407';

type QueueDefinition = {
  name: string;
  type: string;
  arguments: [name: string, type: string, value: unknown][];
  operator_policy: string;
  effective_policy_definition: Record<string, unknown>;
};

type TestBroker = {
  queueDefinitions: () => Promise<QueueDefinition[]>;
  appBrokerUrl: string;
  workerBrokerUrl: string;
  restrictWorkerToObservation?: () => Promise<string>;
  userA: string;
  userB: string;
  otherWorker?: { url: string; user: string };
};

type MissingObject = { code: number; stderr: string };

async function docker(args: string[], operation: string, input?: string, missing?: MissingObject) {
  const pending = run('docker', args, { timeout: 12_000 });
  // A failing CLI can close stdin before receiving the input. Its exit is reported below.
  pending.child.stdin?.on('error', () => {});
  pending.child.stdin?.end(input);
  try {
    return (await pending).stdout.trim();
  } catch (error) {
    const failure = error as { code?: number | string; signal?: string; stderr?: string };
    if (missing && failure.code === missing.code && failure.stderr?.trim() === missing.stderr)
      return undefined;
    // CLI diagnostics can include Erlang authentication details. Keep only the exit and operation.
    throw new Error(`RABBITMQ_TEST_CONTROL ${operation}: ${failure.signal ?? failure.code}`);
  }
}

async function testBrokerTarget() {
  const host =
    (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) ||
    (await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], 'context'));
  assert(
    typeof host === 'string' && host.startsWith('unix:///'),
    'RABBITMQ_TEST_TARGET: a local Docker socket is required',
  );

  const ci = process.env.GITHUB_ACTIONS === 'true';
  const target = ci ? process.env.MIO_TEST_RABBITMQ_CONTAINER_ID : 'mio-dev-rabbitmq-1';
  assert(
    target && (!ci || /^[a-f0-9]{64}$/.test(target)),
    'RABBITMQ_TEST_TARGET: CI must supply its RabbitMQ service container ID',
  );
  const dockerArgs = ['--host', host];
  const inspectFields = [
    '{{json .Id}}',
    '{{json .Config.Image}}',
    '{{json (index .Config.Labels "mio.test.rabbitmq")}}',
    '{{json (index .Config.Labels "com.docker.compose.project")}}',
    '{{json (index .Config.Labels "com.docker.compose.service")}}',
    '{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}',
    '{{json (index .NetworkSettings.Ports "5672/tcp")}}',
  ];
  const raw = await docker(
    [...dockerArgs, 'container', 'inspect', '--format', `[${inspectFields.join(',')}]`, target],
    ci ? 'inspect CI RabbitMQ service' : 'inspect mio-dev-rabbitmq-1 (pnpm infra:up:dev)',
  );
  assert(raw, 'RABBITMQ_TEST_TARGET: missing container metadata');
  const [id, configuredImage, regressionLabel, project, service, health, bindings] = JSON.parse(
    raw,
  ) as [
    string,
    string,
    string,
    string,
    string,
    string | null,
    { HostIp: string; HostPort: string }[] | null,
  ];
  assert.equal(configuredImage, image, 'RABBITMQ_TEST_TARGET: unexpected RabbitMQ image');
  assert(
    ci
      ? id === target && regressionLabel === 'true'
      : project === 'mio-dev' && service === 'rabbitmq',
    'RABBITMQ_TEST_TARGET: container does not belong to the expected environment',
  );
  assert.equal(health, 'healthy', 'RABBITMQ_TEST_TARGET: RabbitMQ container must be healthy');
  const [binding, ...otherBindings] = bindings ?? [];
  assert(
    binding?.HostIp === '127.0.0.1' && otherBindings.length === 0 && /^\d+$/.test(binding.HostPort),
    'RABBITMQ_TEST_TARGET: expected one loopback AMQP port mapping',
  );
  return {
    port: binding.HostPort,
    ctl: (args: string[], input?: string, missing?: MissingObject) =>
      docker(
        [...dockerArgs, 'exec', '-i', id, 'rabbitmqctl', '-q', ...args],
        args.join(' '),
        input,
        missing,
      ),
  };
}

type WorkerScope = {
  instanceId: string;
  instanceIds: readonly string[];
  observeQueue?: string;
  secondaryInstanceId?: string;
};
type TestRole = { role: 'a' | 'b'; name: string; password: string; instanceId?: string };

function testDefinitions(
  vhost: string,
  users: readonly TestRole[],
  scope?: WorkerScope,
  options?: { singleMessageMediaEncode?: true; legacyVideoProbeBinding?: true },
) {
  const exchanges = [];
  const queues = [];
  const bindings = [];
  for (const { path, body } of computeTopology(vhost, scope?.instanceIds)) {
    const [kind, scope, name, source, destinationType, destination] = path.split('/');
    assert.equal(scope, vhost);
    if (kind === 'exchanges') exchanges.push({ ...body, vhost, name });
    else if (kind === 'queues') {
      const argumentsForQueue = body.arguments as Record<string, unknown>;
      queues.push({
        ...body,
        vhost,
        name,
        ...(options?.singleMessageMediaEncode && name === MEDIA_ENCODE_QUEUE
          ? { arguments: { ...argumentsForQueue, 'x-max-length': 1 } }
          : {}),
      });
    } else {
      assert(kind === 'bindings' && name === 'e' && destinationType === 'q');
      const queue =
        options?.legacyVideoProbeBinding &&
        destination === VIDEO_PROBE_COMMAND_QUEUE &&
        body.routing_key === VIDEO_PROBE_COMMAND_ROUTING_KEY
          ? COMMAND_QUEUE
          : destination;
      bindings.push({ ...body, vhost, source, destination: queue, destination_type: 'queue' });
    }
  }
  return JSON.stringify({
    exchanges,
    queues,
    bindings,
    permissions: users.map(({ role, name, instanceId }) => ({
      vhost,
      user: name,
      ...computePermissions(role, instanceId),
    })),
  });
}

export async function withLocalTestBroker<T>(
  exercise: (broker: TestBroker) => Promise<T>,
  scope?: WorkerScope,
  options?: { singleMessageMediaEncode?: true; legacyVideoProbeBinding?: true },
): Promise<T> {
  const { port, ctl } = await testBrokerTarget();
  const token = randomBytes(16).toString('hex');
  const vhost = `mio-regtest-${token}`;
  const description = `Mio RabbitMQ protocol regression ${token}`;
  const a = {
    role: 'a',
    name: `${vhost}-a`,
    password: randomBytes(24).toString('base64url'),
  } as const;
  const b = {
    role: 'b',
    name: `${vhost}-b`,
    ...(scope ? { instanceId: scope.instanceId } : {}),
    password: randomBytes(24).toString('base64url'),
  } as const;
  const other: TestRole | undefined = scope?.secondaryInstanceId
    ? {
        role: 'b',
        name: `${vhost}-b2`,
        password: randomBytes(24).toString('base64url'),
        instanceId: scope.secondaryInstanceId,
      }
    : undefined;
  if (other)
    assert(
      scope &&
        other.instanceId &&
        other.instanceId !== scope.instanceId &&
        scope.instanceIds.includes(other.instanceId),
    );
  const users: TestRole[] = other ? [a, b, other] : [a, b];
  const amqpUrl = ({ name, password }: (typeof users)[number]) =>
    `amqp://${name}:${password}@127.0.0.1:${port}/${vhost}`;
  const userExists = async (name: string) =>
    (await ctl(['--formatter=json', 'list_user_permissions', name], undefined, {
      code: 69,
      stderr: `Error:\n{:no_such_user, "${name}"}`,
    })) !== undefined;
  const vhostExists = async () =>
    (await ctl(['--formatter=json', 'list_permissions', '--vhost', vhost], undefined, {
      code: 65,
      stderr: `Virtual host '${vhost}' does not exist`,
    })) !== undefined;
  const ownsVhost = async () => {
    // rabbitmqctl cannot filter vhost descriptions. Match the random name and ownership marker.
    const output = await ctl(['--formatter=json', 'list_vhosts', 'name', 'description']);
    assert(output, 'RABBITMQ_TEST_CONTROL: missing vhost descriptions');
    const entries = JSON.parse(output) as { name: string; description: string }[];
    return entries.some((entry) => entry.name === vhost && entry.description === description);
  };
  const assertAbsent = async () => {
    const [hasVhost, hasA, hasB] = await Promise.all([
      vhostExists(),
      userExists(a.name),
      userExists(b.name),
    ]);
    assert(!hasVhost, `RABBITMQ_TEST_VHOST_PRESENT: ${vhost}`);
    assert(!hasA && !hasB, `RABBITMQ_TEST_USER_PRESENT: ${vhost}`);
  };

  await assertAbsent();
  const attemptedUsers: (typeof users)[number][] = [];
  const cleanup = async () => {
    const failures: unknown[] = [];
    try {
      if ((await vhostExists()) && (await ownsVhost())) await ctl(['delete_vhost', vhost]);
    } catch (error) {
      failures.push(error);
    }
    for (const { name, password } of attemptedUsers) {
      try {
        if (!(await userExists(name))) continue;
        // An add_user error can arrive after creation. Prove ownership before deleting.
        await ctl(['authenticate_user', name], `${password}\n`);
        await ctl(['delete_user', name]);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await assertAbsent();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, `RABBITMQ_TEST_CLEANUP: ${vhost}`);
  };

  let result: T;
  try {
    await ctl(['add_vhost', vhost, '--description', description]);
    assert(await ownsVhost(), `RABBITMQ_TEST_VHOST_OWNERSHIP: ${vhost}`);
    for (const user of users) {
      attemptedUsers.push(user);
      await ctl(['add_user', user.name], `${user.password}\n`);
    }
    await ctl([
      'set_operator_policy',
      '--vhost',
      vhost,
      '--apply-to',
      'queues',
      'mio-capacity',
      '.*',
      JSON.stringify(computeCapacity),
    ]);
    const retention = audioResultPolicy.definition;
    await ctl([
      'set_operator_policy',
      '--vhost',
      vhost,
      '--priority',
      String(retention.priority),
      '--apply-to',
      retention['apply-to'],
      audioResultPolicy.name,
      retention.pattern,
      JSON.stringify(retention.definition),
    ]);
    // The import only contains queues, exchanges, bindings and permissions in the owned vhost.
    await ctl(['import_definitions', '/dev/stdin'], testDefinitions(vhost, users, scope, options));
    result = await exercise({
      async queueDefinitions() {
        const output = await ctl([
          '--formatter=json',
          'list_queues',
          '--vhost',
          vhost,
          'name',
          'type',
          'arguments',
          'operator_policy',
          'effective_policy_definition',
        ]);
        assert(output);
        return JSON.parse(output) as QueueDefinition[];
      },
      appBrokerUrl: amqpUrl(a),
      workerBrokerUrl: amqpUrl(b),
      ...(scope?.observeQueue
        ? {
            async restrictWorkerToObservation() {
              const queue = scope.observeQueue!;
              assert(await ownsVhost(), `RABBITMQ_TEST_VHOST_OWNERSHIP: ${vhost}`);
              await ctl(['authenticate_user', b.name], `${b.password}\n`);
              const read = `^${queue.replace(/[^a-zA-Z0-9_-]/g, '\\$&')}$`;
              await ctl(['set_permissions', '--vhost', vhost, b.name, '^$', '^$', read]);
              return amqpUrl(b);
            },
          }
        : {}),
      userA: a.name,
      userB: b.name,
      ...(other ? { otherWorker: { url: amqpUrl(other), user: other.name } } : {}),
    });
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `RABBITMQ_TEST_FAILURE: ${vhost}`);
    }
    throw error;
  }
  await cleanup();
  return result;
}
