import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import {
  computeCapacity,
  computeExchanges as exchanges,
  computeQueues as queues,
  computePermissions,
  computeTopology,
} from './compute-broker-topology.ts';

type Json = Record<string, unknown>;
type Reply = { status: number; value: unknown };
type Role = { user: string; password: string };

const [adminFile, outputPath, ...extra] = process.argv.slice(2);
if (!adminFile || !outputPath || extra.length)
  throw new Error(
    'Usage: node scripts/service/prepare-compute-broker.ts <admin-env> <new-private-output-dir>',
  );

function readEnv(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator < 1) throw new Error('BROKER_ENV_INVALID');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function required(value: string | undefined): string {
  if (!value) throw new Error('BROKER_ENV_MISSING');
  return value;
}

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('BROKER_RESPONSE_INVALID');
  return value as Json;
}

async function privateFile(path: string, contents: string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
}

const env = readEnv(await readFile(adminFile, 'utf8'));
const management = new URL(required(env.RABBITMQ_MANAGEMENT_URL));
if (
  management.protocol !== 'http:' ||
  management.hostname !== '127.0.0.1' ||
  management.username ||
  management.password ||
  management.pathname !== '/' ||
  management.search ||
  management.hash
)
  throw new Error('BROKER_LOCAL_MANAGEMENT_REQUIRED');
const amqpPort = required(env.RABBITMQ_AMQP_PORT);
if (!/^\d{1,5}$/.test(amqpPort) || Number(amqpPort) < 1 || Number(amqpPort) > 65535)
  throw new Error('BROKER_AMQP_PORT_INVALID');
const originalVhost = required(env.RABBITMQ_DEFAULT_VHOST);
const adminAuth = Buffer.from(
  `${required(env.RABBITMQ_DEFAULT_USER)}:${required(env.RABBITMQ_DEFAULT_PASS)}`,
).toString('base64');
const base = await realpath('.runtime');
const output = resolve(outputPath);
const parent = await realpath(dirname(output));
if (!parent.startsWith(`${base}${sep}`)) throw new Error('BROKER_PRIVATE_DIR_REQUIRED');

const token = randomBytes(8).toString('hex');
const roles: Record<'a' | 'b', Role> = {
  a: { user: `mio-a-${token}`, password: randomBytes(32).toString('base64url') },
  b: { user: `mio-b-${token}`, password: randomBytes(32).toString('base64url') },
};
const vhosts = [originalVhost, `mio-worker-test-${token}`, `mio-env-probe-${token}`] as const;
const encoded = (value: string) => encodeURIComponent(value);

async function api(method: string, path: string, body?: Json): Promise<Reply> {
  const response = await fetch(new URL(`/api/${path}`, management), {
    method,
    headers: {
      authorization: `Basic ${adminAuth}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  return { status: response.status, value: text ? (JSON.parse(text) as unknown) : null };
}

async function absent(path: string): Promise<void> {
  if ((await api('GET', path)).status !== 404) throw new Error(`BROKER_PREFLIGHT_CONFLICT ${path}`);
}

const who = await api('GET', 'whoami');
if (
  who.status !== 200 ||
  !Array.isArray(object(who.value).tags) ||
  !(object(who.value).tags as unknown[]).includes('administrator')
)
  throw new Error('BROKER_ADMIN_REQUIRED');
const flags = await api('GET', 'feature-flags');
if (
  flags.status !== 200 ||
  !Array.isArray(flags.value) ||
  !flags.value.some(
    (flag: unknown) => object(flag).name === 'stream_queue' && object(flag).state === 'enabled',
  )
)
  throw new Error('BROKER_STREAM_FEATURE_REQUIRED');
const capacity = await api('GET', `operator-policies/${encoded(originalVhost)}/mio-capacity`);
const cap = object(capacity.value);
const definition = object(cap.definition);
if (
  capacity.status !== 200 ||
  cap.pattern !== '.*' ||
  definition['max-length-bytes'] !== 1073741824 ||
  definition.overflow !== 'reject-publish'
)
  throw new Error('BROKER_OPERATOR_POLICY_MISMATCH');
for (const role of Object.values(roles)) await absent(`users/${encoded(role.user)}`);
for (const vhost of vhosts.slice(1)) await absent(`vhosts/${encoded(vhost)}`);
for (const exchange of exchanges)
  await absent(`exchanges/${encoded(originalVhost)}/${encoded(exchange)}`);
for (const queue of queues) await absent(`queues/${encoded(originalVhost)}/${encoded(queue)}`);

await mkdir(output, { mode: 0o700 });
const journal = await open(resolve(output, 'bootstrap-journal.jsonl'), 'wx', 0o600);
async function log(action: string, status: string, extraData: Json = {}): Promise<void> {
  await journal.writeFile(
    `${JSON.stringify({ at: new Date().toISOString(), action, status, ...extraData })}\n`,
  );
  await journal.sync();
}
async function mutate(method: string, path: string, body: Json): Promise<void> {
  await log(`${method} ${path}`, 'started');
  let response: Reply;
  try {
    response = await api(method, path, body);
  } catch {
    await log(`${method} ${path}`, 'unknown');
    throw new Error('BROKER_MUTATION_UNKNOWN');
  }
  await log(
    `${method} ${path}`,
    response.status >= 200 && response.status < 300 ? 'ok' : 'failed',
    { httpStatus: response.status },
  );
  if (response.status < 200 || response.status >= 300)
    throw new Error(`BROKER_MUTATION_FAILED ${response.status}`);
}
function roleEnv(role: 'a' | 'b', vhost: string): string {
  const identity = roles[role];
  const uri = `amqp://${encoded(identity.user)}:${encoded(identity.password)}@127.0.0.1:${amqpPort}/${encoded(vhost)}`;
  const peer =
    role === 'a' ? 'MIO_COMPUTE_EXPECTED_RESULT_USER' : 'MIO_COMPUTE_EXPECTED_COMMAND_USER';
  return `RABBITMQ_URL=${uri}\nMIO_COMPUTE_BROKER_USER=${identity.user}\n${peer}=${roles[role === 'a' ? 'b' : 'a'].user}\n`;
}

try {
  await privateFile(
    resolve(output, 'plan.json'),
    `${JSON.stringify({ vhosts, roles: { a: roles.a.user, b: roles.b.user }, exchanges, queues }, null, 2)}\n`,
  );
  for (const [index, label] of ['runtime', 'worker-test', 'probe'].entries()) {
    const vhost = vhosts[index]!;
    for (const role of ['a', 'b'] as const)
      await privateFile(resolve(output, `${label}-${role}.env`), roleEnv(role, vhost));
  }
  await log('preflight', 'ok', { streamQueue: 'enabled', operatorPolicy: 'mio-capacity' });
  for (const vhost of vhosts.slice(1)) {
    await mutate('PUT', `vhosts/${encoded(vhost)}`, {});
    await mutate('PUT', `operator-policies/${encoded(vhost)}/mio-capacity`, {
      pattern: '.*',
      definition: computeCapacity,
      priority: 0,
      'apply-to': 'queues',
    });
  }
  for (const vhost of vhosts)
    for (const resource of computeTopology(vhost))
      await mutate(resource.method, resource.path, resource.body);
  for (const role of ['a', 'b'] as const) {
    const identity = roles[role];
    await mutate('PUT', `users/${encoded(identity.user)}`, {
      password: identity.password,
      tags: '',
    });
    for (const vhost of vhosts)
      await mutate(
        'PUT',
        `permissions/${encoded(vhost)}/${encoded(identity.user)}`,
        computePermissions(role),
      );
  }
  for (const role of ['a', 'b'] as const) {
    const user = object((await api('GET', `users/${encoded(roles[role].user)}`)).value);
    if (!Array.isArray(user.tags) || user.tags.length)
      throw new Error('BROKER_RUNTIME_TAGS_INVALID');
    for (const vhost of vhosts) {
      const result = await api('GET', `permissions/${encoded(vhost)}/${encoded(roles[role].user)}`);
      const p = object(result.value);
      if (
        result.status !== 200 ||
        p.configure !== '^$' ||
        p.write !== computePermissions(role).write ||
        p.read !== computePermissions(role).read
      )
        throw new Error('BROKER_RUNTIME_PERMISSION_MISMATCH');
    }
  }
  for (const vhost of vhosts) {
    for (const [index, queue] of queues.entries()) {
      const response = await api('GET', `queues/${encoded(vhost)}/${encoded(queue)}`);
      const q = object(response.value),
        args = object(q.arguments);
      if (
        response.status !== 200 ||
        q.type !== 'quorum' ||
        q.durable !== true ||
        args['x-delivery-limit'] !== -1 ||
        args['x-overflow'] !== 'reject-publish'
      )
        throw new Error('BROKER_QUEUE_MISMATCH');
      if (
        index < 2 &&
        (args['x-dead-letter-strategy'] !== 'at-least-once' ||
          args['x-dead-letter-exchange'] !== exchanges[index + 2])
      )
        throw new Error('BROKER_DEAD_LETTER_MISMATCH');
    }
  }
  await log('bootstrap', 'ok');
  console.log(`Broker identities and topology prepared. Private output: ${output}`);
} catch (error) {
  await log('bootstrap', 'failed-or-unknown', {
    type: error instanceof Error ? error.message : 'unknown',
  });
  throw error;
} finally {
  await journal.close();
}
