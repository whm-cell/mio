import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AUDIO_RESULT_QUEUE, parseWorkerInstanceIds } from '@mio/compute-contracts';
import { readComputeBrokerEnvironment } from './compute-broker-env.ts';
import {
  audioResultPolicy,
  computeCapacity,
  computeDeadLetters,
  computeExchanges as exchanges,
  computeQueues,
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

const workerInstanceIds = parseWorkerInstanceIds(process.env.MIO_COMPUTE_WORKER_INSTANCE_IDS);
const workerInstanceId = process.env.MIO_COMPUTE_INSTANCE_ID ?? workerInstanceIds[0];
if (workerInstanceId && !workerInstanceIds.includes(workerInstanceId))
  throw new Error('BROKER_WORKER_INSTANCE_NOT_PROVISIONED');
if (workerInstanceIds.length > 1 && !process.env.MIO_COMPUTE_INSTANCE_ID)
  throw new Error('BROKER_WORKER_INSTANCE_REQUIRED');
const deadLetters = computeDeadLetters(workerInstanceIds);
const queues = computeQueues(deadLetters);

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

const {
  management,
  user,
  password,
  vhost: originalVhost,
  amqpPort,
} = readComputeBrokerEnvironment(await readFile(adminFile, 'utf8'));
if (!amqpPort || !/^\d{1,5}$/.test(amqpPort) || Number(amqpPort) < 1 || Number(amqpPort) > 65535)
  throw new Error('BROKER_AMQP_PORT_INVALID');
const adminAuth = Buffer.from(`${user}:${password}`).toString('base64');
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
    redirect: 'error',
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
if (capacity.status !== 200) throw new Error('BROKER_OPERATOR_POLICY_MISMATCH');
const cap = object(capacity.value);
const definition = object(cap.definition);
if (
  cap.pattern !== '.*' ||
  !['all', 'queues', 'quorum_queues'].some((target) => cap['apply-to'] === target) ||
  (cap['apply-to'] !== 'quorum_queues' &&
    (typeof cap.priority !== 'number' || cap.priority >= audioResultPolicy.definition.priority)) ||
  definition['max-length-bytes'] !== computeCapacity['max-length-bytes'] ||
  definition.overflow !== computeCapacity.overflow
)
  throw new Error('BROKER_OPERATOR_POLICY_MISMATCH');
await absent(`operator-policies/${encoded(originalVhost)}/${audioResultPolicy.name}`);
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
  const instance =
    role === 'b' && workerInstanceId ? `MIO_COMPUTE_INSTANCE_ID=${workerInstanceId}\n` : '';
  const allowlist =
    role === 'a' && workerInstanceIds.length
      ? `MIO_COMPUTE_WORKER_INSTANCE_IDS=${workerInstanceIds.join(',')}\n`
      : '';
  return `${instance}${allowlist}RABBITMQ_URL=${uri}\nMIO_COMPUTE_BROKER_USER=${identity.user}\n${peer}=${roles[role === 'a' ? 'b' : 'a'].user}\n`;
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
  for (const vhost of vhosts) {
    await mutate(
      'PUT',
      `operator-policies/${encoded(vhost)}/${audioResultPolicy.name}`,
      audioResultPolicy.definition,
    );
    for (const resource of computeTopology(vhost, workerInstanceIds))
      await mutate(resource.method, resource.path, resource.body);
  }
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
        computePermissions(role, workerInstanceId),
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
        p.write !== computePermissions(role, workerInstanceId).write ||
        p.read !== computePermissions(role, workerInstanceId).read
      )
        throw new Error('BROKER_RUNTIME_PERMISSION_MISMATCH');
    }
  }
  // Management adds effective policy to the first statistics sample after declaration.
  const policyStatsDeadline = performance.now() + 10_000;
  for (const vhost of vhosts) {
    for (const queue of queues) {
      const path = `queues/${encoded(vhost)}/${encoded(queue)}`;
      let response = await api('GET', path);
      let q = object(response.value);
      while (
        response.status === 200 &&
        q.effective_policy_definition === undefined &&
        performance.now() < policyStatsDeadline
      ) {
        await sleep(250);
        response = await api('GET', path);
        q = object(response.value);
      }
      const args = object(q.arguments);
      if (queue === AUDIO_RESULT_QUEUE) {
        if (
          response.status !== 200 ||
          q.type !== 'stream' ||
          q.durable !== true ||
          q.operator_policy !== audioResultPolicy.name ||
          args['x-max-age'] !== '1h' ||
          object(q.effective_policy_definition)['max-length-bytes'] !==
            audioResultPolicy.definition.definition['max-length-bytes'] ||
          Object.hasOwn(object(q.effective_policy_definition), 'overflow')
        )
          throw new Error(`BROKER_STREAM_RETENTION_MISMATCH ${vhost}/${queue}`);
        continue;
      }
      if (
        response.status !== 200 ||
        q.type !== 'quorum' ||
        q.durable !== true ||
        args['x-delivery-limit'] !== -1 ||
        args['x-overflow'] !== 'reject-publish'
      )
        throw new Error('BROKER_QUEUE_MISMATCH');
      const effective = q.effective_policy_definition;
      if (
        q.operator_policy !== 'mio-capacity' ||
        !effective ||
        typeof effective !== 'object' ||
        (effective as Json)['max-length-bytes'] !== computeCapacity['max-length-bytes'] ||
        (effective as Json).overflow !== computeCapacity.overflow
      )
        throw new Error(`BROKER_QUEUE_CAPACITY_MISMATCH ${vhost}/${queue}`);
      const deadLetter = deadLetters.get(queue);
      if (
        deadLetter &&
        (args['x-dead-letter-strategy'] !== 'at-least-once' ||
          args['x-dead-letter-exchange'] !== deadLetter.exchange ||
          args['x-dead-letter-routing-key'] !== deadLetter.routingKey)
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
