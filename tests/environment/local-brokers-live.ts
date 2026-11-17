import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'amqplib';
import type { ConfirmChannel } from 'amqplib';
import {
  COMMAND_EXCHANGE,
  COMMAND_QUEUE,
  COMMAND_ROUTING_KEY,
  RESULT_EXCHANGE,
  RESULT_QUEUE,
  RESULT_ROUTING_KEY,
} from '@mio/compute-contracts';
import { readLocalEnvironment } from '../../scripts/service/local-environment.ts';
import { localWorkerEnvironment } from '../../scripts/service/local-compute-environment.ts';

// Explicit operator probe, never part of pnpm check. Refuse occupied environments; never purge.
assert.deepEqual(process.argv.slice(2), ['--restart-local-brokers']);
const runId = randomUUID();
const directory = resolve('.runtime/local-broker-acceptance', runId);
await mkdir(directory, { recursive: true, mode: 0o700 });
const cancellation = new AbortController();
const cancel = () => cancellation.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
const directions = [
  {
    sender: 'a',
    receiver: 'b',
    exchange: COMMAND_EXCHANGE,
    queue: COMMAND_QUEUE,
    routing: COMMAND_ROUTING_KEY,
  },
  {
    sender: 'b',
    receiver: 'a',
    exchange: RESULT_EXCHANGE,
    queue: RESULT_QUEUE,
    routing: RESULT_ROUTING_KEY,
  },
] as const;

async function environment(name: 'dev' | 'test') {
  const config = await readLocalEnvironment(name);
  const worker = localWorkerEnvironment(name, config.values, config.host);
  const url = (role: 'a' | 'b' | 'admin') => {
    const result = new URL(config.values.RABBITMQ_URL!);
    result.username = `mio-${name}-${role}`;
    result.password =
      config.values[
        role === 'admin'
          ? 'MIO_LOCAL_RABBITMQ_PASSWORD'
          : `MIO_LOCAL_RABBITMQ_${role.toUpperCase()}_PASSWORD`
      ]!;
    return result.toString();
  };
  return { name, config, worker, url };
}
type Environment = Awaited<ReturnType<typeof environment>>;

async function inspect(env: Environment) {
  const { values } = env.config;
  const auth = Buffer.from(`mio-${env.name}-admin:${values.MIO_LOCAL_RABBITMQ_PASSWORD}`).toString(
    'base64',
  );
  const read = async (path: string) => {
    const response = await fetch(
      `http://127.0.0.1:${values.MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT}/api/${path}`,
      {
        headers: { authorization: `Basic ${auth}` },
        signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(5000)]),
      },
    );
    assert.equal(response.status, 200, `${env.name}: management inspection failed`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const connections = await read('connections?columns=user,vhost');
  assert(
    Array.isArray(connections) && connections.length === 0,
    `${env.name}: stop all A/B connections before the probe`,
  );
  const capacity = await read(`operator-policies/mio-${env.name}/mio-capacity`);
  assert.deepEqual(capacity.definition, {
    'max-length-bytes': 1073741824,
    overflow: 'reject-publish',
  });
  for (const queue of [
    COMMAND_QUEUE,
    RESULT_QUEUE,
    'mio.compute.commands.dlq.v1',
    'mio.compute.results.dlq.v1',
  ]) {
    const state = await read(`queues/mio-${env.name}/${queue}`);
    assert.equal(state.type, 'quorum');
    assert.equal(state.durable, true);
    const args = state.arguments as Record<string, unknown>;
    assert.equal(args['x-delivery-limit'], -1);
    assert.equal(args['x-overflow'], 'reject-publish');
    if (queue === COMMAND_QUEUE || queue === RESULT_QUEUE)
      assert.equal(args['x-dead-letter-strategy'], 'at-least-once');
  }
}

async function probeConnection(url: string) {
  cancellation.signal.throwIfAborted();
  // amqplib forwards this signal to Node's socket, including after the AMQP handshake.
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(15000)]);
  // Its SocketOptions type omits Node's signal; a named options object retains both fields.
  const socketOptions = { timeout: 5000, signal };
  const connection = await connect(url, socketOptions);
  connection.on('error', () => {});
  const closed = new Promise<void>((done) => connection.once('close', () => done()));
  const close = () =>
    Promise.race([
      closed,
      Promise.resolve()
        .then(() => connection.close())
        .catch((error: unknown) => {
          // Same amqplib close-event/already-closed handling as the production adapter.
          if (
            error instanceof Error &&
            error.name === 'IllegalOperationError' &&
            error.message.startsWith('Connection closed (')
          )
            return;
          return closed;
        }),
    ]);
  return { connection, signal, close };
}

async function channel<T>(
  env: Environment,
  role: 'a' | 'b' | 'admin',
  action: (channel: ConfirmChannel) => Promise<T>,
) {
  const { connection, signal, close } = await probeConnection(env.url(role));
  try {
    signal.throwIfAborted();
    const ch = await connection.createConfirmChannel();
    ch.on('error', () => {});
    const result = await action(ch);
    signal.throwIfAborted();
    return result;
  } finally {
    await close();
    signal.throwIfAborted();
  }
}

async function command(env: Environment, argv: string[], recovery = false) {
  if (!recovery) cancellation.signal.throwIfAborted();
  const child = spawn(argv[0]!, argv.slice(1), { env: env.config.host, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGTERM');
  if (!recovery) cancellation.signal.addEventListener('abort', interrupt, { once: true });
  try {
    const [code, signal] = await once(child, 'close');
    if (!recovery) cancellation.signal.throwIfAborted();
    assert(code === 0 && signal === null, `${env.name}: command failed`);
  } finally {
    cancellation.signal.removeEventListener('abort', interrupt);
  }
}
const compose = (env: Environment, ...args: string[]) => [
  'docker',
  'compose',
  '--env-file',
  env.config.file,
  '-p',
  `mio-${env.name}`,
  '-f',
  'deploy/local/compose.yaml',
  ...args,
];

async function empty(env: Environment) {
  await channel(env, 'admin', async (ch) => {
    for (const queue of [
      COMMAND_QUEUE,
      RESULT_QUEUE,
      'mio.compute.commands.dlq.v1',
      'mio.compute.results.dlq.v1',
    ]) {
      const state = await ch.checkQueue(queue);
      assert.equal(
        state.messageCount,
        0,
        `${env.name}: ${queue} contains data; stop and inspect, never purge`,
      );
      assert.equal(state.consumerCount, 0, `${env.name}: stop A/B before this probe`);
    }
  });
}

async function publish(env: Environment, token: string) {
  for (const direction of directions)
    await channel(env, direction.sender, async (ch) => {
      let returned = false;
      ch.on('return', () => {
        returned = true;
      });
      ch.publish(direction.exchange, direction.routing, Buffer.from(token), {
        persistent: true,
        mandatory: true,
        userId: `mio-${env.name}-${direction.sender}`,
        messageId: token,
      });
      await ch.waitForConfirms();
      assert(!returned, `${env.name}: message returned`);
    });
}
async function receive(env: Environment, token: string) {
  for (const direction of directions)
    await channel(env, direction.receiver, async (ch) => {
      const message = await ch.get(direction.queue);
      assert(message, `${env.name}: missing retained message`);
      if (message.content.toString() !== token) {
        ch.nack(message, false, true);
        assert.fail(`${env.name}: unexpected message preserved; inspect environment`);
      }
      assert.equal(message.properties.userId, `mio-${env.name}-${direction.sender}`);
      ch.ack(message);
      // A connection-level close can overtake buffered channel ACKs; drain this channel first.
      await ch.prefetch(1);
    });
}

async function permissions(env: Environment, other: Environment) {
  for (const role of ['a', 'b'] as const) {
    const wrong = new URL(env.url(role));
    wrong.port = new URL(other.url(role)).port;
    wrong.pathname = `/mio-${other.name}`;
    await assert.rejects(
      async () => {
        const probe = await probeConnection(wrong.toString());
        await probe.close();
      },
      /403|ACCESS_REFUSED/,
      `${env.name}: foreign broker accepted credentials`,
    );
    await channel(env, role, async (ch) => {
      await assert.rejects(ch.assertQueue(`forbidden-${runId}`), /403|ACCESS_REFUSED/);
    });
    await channel(env, role, async (ch) => {
      await assert.rejects(
        ch.get(role === 'a' ? COMMAND_QUEUE : RESULT_QUEUE),
        /403|ACCESS_REFUSED/,
      );
    });
    await channel(env, role, async (ch) => {
      const wrongDirection = directions[role === 'a' ? 1 : 0];
      ch.publish(wrongDirection.exchange, wrongDirection.routing, Buffer.from(runId), {
        persistent: true,
      });
      await assert.rejects(ch.waitForConfirms(), /403|ACCESS_REFUSED|closed/);
    });
  }
  console.log(
    `${env.name}: cross-environment authentication and forbidden configure/read/write rejected`,
  );
}

function journalIdentity(env: Environment) {
  const database = new DatabaseSync(resolve(env.worker.MIO_COMPUTE_DIRECTORY!, 'journal.sqlite3'), {
    readOnly: true,
  });
  try {
    assert.equal(
      database.prepare('SELECT count(*) AS count FROM attempts').get()!.count,
      0,
      `${env.name}: Worker has retained work; skip idle-only probe and inspect`,
    );
    return database.prepare('SELECT instance_id FROM metadata').get()!.instance_id;
  } finally {
    database.close();
  }
}

async function idleWorker(env: Environment) {
  const journal = resolve(env.worker.MIO_COMPUTE_DIRECTORY!, 'journal.sqlite3');
  if (!existsSync(journal))
    await command(env, [process.execPath, 'scripts/service/local.ts', env.name, 'compute', 'init']);
  assert.equal(journalIdentity(env), env.worker.MIO_COMPUTE_INSTANCE_ID);
  // No jobs and no network calls to COS: this proves process/MQ/journal wiring, not media processing.
  for (let run = 0; run < 2; run++) {
    const log = await open(resolve(directory, `${env.name}-worker-${run}.log`), 'wx', 0o600);
    const child = spawn(process.execPath, ['compute/dist/main.js', 'start'], {
      env: {
        ...env.worker,
        MIO_COS_BUCKET: 'unused-1234567890',
        MIO_COS_REGION: 'ap-guangzhou',
        MIO_COS_SECRET_ID: 'idle-probe',
        MIO_COS_SECRET_KEY: 'idle-probe',
      },
      stdio: ['ignore', log.fd, log.fd],
    });
    const exited = once(child, 'close');
    try {
      let ready = false;
      for (let attempt = 0; attempt < 40 && child.exitCode === null; attempt++) {
        const state = await channel(env, 'admin', (ch) => ch.checkQueue(COMMAND_QUEUE));
        if (state.consumerCount === 1) {
          ready = true;
          break;
        }
        await delay(250, undefined, { signal: cancellation.signal });
      }
      assert(ready, `${env.name}: Worker failed to consume`);
    } finally {
      child.kill('SIGTERM');
      const result = await Promise.race([exited, delay(30000, null, { ref: false })]);
      if (!result) child.kill('SIGKILL');
      await log.close();
      assert(result && result[0] === 0, `${env.name}: Worker failed to drain`);
    }
    assert.equal(journalIdentity(env), env.worker.MIO_COMPUTE_INSTANCE_ID);
  }
  console.log(
    `${env.name}: real Worker consumed an empty queue, stopped and restarted with the same journal identity; COS not exercised`,
  );
}

const environments = [await environment('dev'), await environment('test')];
const stopped = new Set<Environment>();
try {
  for (const env of environments) {
    await inspect(env);
    await empty(env);
    if (existsSync(resolve(env.worker.MIO_COMPUTE_DIRECTORY!, 'journal.sqlite3')))
      assert.equal(journalIdentity(env), env.worker.MIO_COMPUTE_INSTANCE_ID);
  }
  for (const [index, env] of environments.entries()) {
    const other = environments[1 - index]!;
    await permissions(env, other);
    const token = `${runId}-${env.name}`;
    await publish(env, token);
    await empty(other);
    await command(env, [process.execPath, 'scripts/service/local.ts', env.name, 'broker-init']);
    stopped.add(env);
    await command(env, compose(env, 'stop', 'rabbitmq'));
    const otherToken = `${runId}-while-${env.name}-stopped`;
    await publish(other, otherToken);
    await receive(other, otherToken);
    await command(env, compose(env, 'up', '-d', '--wait', '--wait-timeout', '120', 'rabbitmq'));
    stopped.delete(env);
    await receive(env, token);
    await command(env, [process.execPath, 'scripts/service/local.ts', env.name, 'broker-init']);
    await empty(env);
    console.log(
      `${env.name}: confirmed command/result messages survived broker restart; ${other.name} stayed usable`,
    );
    await idleWorker(env);
  }
  for (const env of environments) await empty(env);
} finally {
  for (const env of stopped)
    await command(
      env,
      compose(env, 'up', '-d', '--wait', '--wait-timeout', '120', 'rabbitmq'),
      true,
    );
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
cancellation.signal.throwIfAborted();
console.log(
  `PASS local RabbitMQ isolation/persistence and idle Worker restart; logs: ${directory}`,
);
