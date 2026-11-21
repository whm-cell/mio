import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import {
  computeCapacity,
  computePermissions,
  computeTopology,
} from '../../scripts/service/compute-broker-topology.ts';

const run = promisify(execFile);
const image =
  'rabbitmq:4.4.0-management@sha256:af6f50d38098d8bd52fef7f3fa85015dd8b2bf6def58e995bf584ae9ba0f6407';

type TestBroker = {
  appBrokerUrl: string;
  workerBrokerUrl: string;
  userA: string;
  userB: string;
};

async function docker(args: string[], operation: string, input?: string) {
  const pending = run('docker', args, { timeout: 12_000 });
  // A failing CLI can close stdin before receiving the input. Its exit is reported below.
  pending.child.stdin?.on('error', () => {});
  pending.child.stdin?.end(input);
  try {
    return (await pending).stdout.trim();
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { signal?: string };
    // CLI diagnostics can include Erlang authentication details. Keep only the exit and operation.
    throw new Error(`RABBITMQ_TEST_CONTROL ${operation}: ${failure.signal ?? failure.code}`);
  }
}

async function testBrokerTarget() {
  const host =
    (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) ||
    (await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], 'context'));
  assert(host.startsWith('unix:///'), 'RABBITMQ_TEST_TARGET: a local Docker socket is required');

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
    ctl: (args: string[], input?: string) =>
      docker(
        [...dockerArgs, 'exec', '-i', id, 'rabbitmqctl', '-q', ...args],
        args.join(' '),
        input,
      ),
  };
}

function testDefinitions(vhost: string, users: readonly { role: 'a' | 'b'; name: string }[]) {
  const exchanges = [];
  const queues = [];
  const bindings = [];
  for (const { path, body } of computeTopology(vhost)) {
    const [kind, scope, name, source, destinationType, destination] = path.split('/');
    assert.equal(scope, vhost);
    if (kind === 'exchanges') exchanges.push({ ...body, vhost, name });
    else if (kind === 'queues') queues.push({ ...body, vhost, name });
    else {
      assert(kind === 'bindings' && name === 'e' && destinationType === 'q');
      bindings.push({ ...body, vhost, source, destination, destination_type: 'queue' });
    }
  }
  return JSON.stringify({
    exchanges,
    queues,
    bindings,
    permissions: users.map(({ role, name }) => ({
      vhost,
      user: name,
      ...computePermissions(role),
    })),
  });
}

export async function withLocalTestBroker<T>(
  exercise: (broker: TestBroker) => Promise<T>,
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
    password: randomBytes(24).toString('base64url'),
  } as const;
  const users = [a, b];
  const amqpUrl = ({ name, password }: (typeof users)[number]) =>
    `amqp://${name}:${password}@127.0.0.1:${port}/${vhost}`;
  const listVhosts = async () =>
    JSON.parse(await ctl(['--formatter=json', 'list_vhosts', 'name', 'description'])) as {
      name: string;
      description: string;
    }[];
  const listUsers = async () =>
    JSON.parse(await ctl(['--formatter=json', 'list_users'])) as { user: string }[];
  const assertAbsent = async () => {
    const [vhosts, brokerUsers] = await Promise.all([listVhosts(), listUsers()]);
    assert(!vhosts.some((item) => item.name === vhost), `RABBITMQ_TEST_VHOST_PRESENT: ${vhost}`);
    for (const { name } of users) {
      assert(
        !brokerUsers.some((item) => item.user === name),
        `RABBITMQ_TEST_USER_PRESENT: ${name}`,
      );
    }
  };

  await assertAbsent();
  const ownedUsers: string[] = [];
  const cleanup = async () => {
    const failures: unknown[] = [];
    try {
      const entry = (await listVhosts()).find((item) => item.name === vhost);
      if (entry?.description === description) await ctl(['delete_vhost', vhost]);
    } catch (error) {
      failures.push(error);
    }
    for (const name of ownedUsers) {
      try {
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
    const entry = (await listVhosts()).find((item) => item.name === vhost);
    assert.equal(entry?.description, description, `RABBITMQ_TEST_VHOST_OWNERSHIP: ${vhost}`);
    for (const { name, password } of users) {
      await ctl(['add_user', name], `${password}\n`);
      ownedUsers.push(name);
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
    // The import only contains queues, exchanges, bindings and permissions in the owned vhost.
    await ctl(['import_definitions', '/dev/stdin'], testDefinitions(vhost, users));
    result = await exercise({
      appBrokerUrl: amqpUrl(a),
      workerBrokerUrl: amqpUrl(b),
      userA: a.name,
      userB: b.name,
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
