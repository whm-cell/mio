import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, parseEnv, promisify } from 'node:util';
import { connect } from 'amqplib';
import type { ChannelModel } from 'amqplib';
import {
  COMMAND_QUEUE,
  COMPUTE_VERSION,
  parseComputeCommandV1,
  RESULT_EXCHANGE,
  RESULT_QUEUE,
  RESULT_ROUTING_KEY,
} from '@mio/compute-contracts';
import type { ComputeCommandV1, ComputeResultV1 } from '@mio/compute-contracts';
import { Pool } from 'pg';
import type { AssetObjectStore } from '../src/assets/contracts.ts';
import { assetSchemaSQL } from '../src/assets/schema.ts';
import type { ComputeConfig } from '../src/compute/config.ts';
import { createComputeHandler } from '../src/compute/http.ts';
import { computeSchemaSQL } from '../src/compute/schema.ts';
import { createComputeService } from '../src/compute/service.ts';
import { createComputeStore } from '../src/compute/store.ts';
import { ComputeBroker } from '../src/integrations/rabbitmq.ts';
import { authDatabase } from './auth-database.ts';

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`QUEUE_PROBE_${code}`);
}

async function waitFor<T>(observe: () => T | undefined | Promise<T | undefined>, code: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const observed = await observe();
    if (observed !== undefined) return observed;
    await delay(100);
  }
  throw new Error(`QUEUE_PROBE_${code}`);
}

type Queue = {
  type: string;
  durable: boolean;
  messages: number;
  messages_ready: number;
  messages_unacknowledged: number;
  consumers: number;
  arguments: Record<string, unknown>;
  effective_policy_definition?: Record<string, unknown>;
  message_stats?: { ack?: number };
};

type Memory = { mem_limit: number; mem_alarm: boolean };
type Connection = { user: string; vhost: string; state: string };
const execute = promisify(execFile);
const restoreLimit = 536870912;
let phase = 'fixture';

async function prepareFixture() {
  const [adminPath, bootstrapDir, container, ...extra] = process.argv.slice(2);
  check(adminPath && bootstrapDir && container && !extra.length, 'FIXTURE_PATHS_REQUIRED');
  check(!process.env.MIO_TEST_DATABASE_URL, 'PRIVATE_PG_FIXTURE_REQUIRED');
  const readEnv = async (path: string) => parseEnv(await readFile(path, 'utf8'));
  const [admin, app, worker] = await Promise.all([
    readEnv(adminPath),
    readEnv(join(bootstrapDir, 'probe-a.env')),
    readEnv(join(bootstrapDir, 'probe-b.env')),
  ]);
  const management = new URL(admin.RABBITMQ_MANAGEMENT_URL ?? '');
  check(
    management.protocol === 'http:' &&
      management.hostname === '127.0.0.1' &&
      management.pathname === '/' &&
      management.port === admin.RABBITMQ_MANAGEMENT_PORT &&
      !management.username &&
      !management.password &&
      admin.RABBITMQ_DEFAULT_USER &&
      admin.RABBITMQ_DEFAULT_PASS,
    'LOCAL_BROKER_ADMIN_REQUIRED',
  );
  const userA = app.MIO_COMPUTE_BROKER_USER ?? '';
  const userB = worker.MIO_COMPUTE_BROKER_USER ?? '';
  const suffix = /^mio-a-([0-9a-f]{16})$/.exec(userA)?.[1];
  const vhost = `mio-env-probe-${suffix}`;
  const appURL = new URL(app.RABBITMQ_URL ?? '');
  const workerURL = new URL(worker.RABBITMQ_URL ?? '');
  check(
    suffix &&
      userB === `mio-b-${suffix}` &&
      app.MIO_COMPUTE_EXPECTED_RESULT_USER === userB &&
      worker.MIO_COMPUTE_EXPECTED_COMMAND_USER === userA &&
      vhost !== admin.RABBITMQ_DEFAULT_VHOST &&
      [appURL, workerURL].every(
        (url) =>
          url.protocol === 'amqp:' &&
          url.hostname === '127.0.0.1' &&
          url.port === admin.RABBITMQ_AMQP_PORT &&
          url.pathname === `/${vhost}` &&
          Boolean(url.password) &&
          !url.search,
      ) &&
      appURL.username === userA &&
      workerURL.username === userB,
    'DEDICATED_BOOTSTRAP_ROLES_REQUIRED',
  );
  check(/^mio-queue-[0-9a-f]{16}-rabbitmq-1$/.test(container), 'EXCLUSIVE_CONTAINER_REQUIRED');
  const inspected = await execute(
    'docker',
    ['inspect', container, '--format', '{{json .Config.Labels}}'],
    {
      timeout: 10_000,
    },
  );
  const labels = JSON.parse(inspected.stdout) as Record<string, string>;
  check(
    labels['com.docker.compose.project'] === container.slice(0, -'-rabbitmq-1'.length) &&
      labels['com.docker.compose.project.environment_file'] === resolve(adminPath) &&
      labels['com.docker.compose.service'] === 'rabbitmq',
    'CONTAINER_FIXTURE_IDENTITY',
  );
  const auth = Buffer.from(
    `${admin.RABBITMQ_DEFAULT_USER}:${admin.RABBITMQ_DEFAULT_PASS}`,
  ).toString('base64');
  const api = async <T>(path: string) => {
    const response = await fetch(new URL(path, management), {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(5000),
    });
    check(response.ok, 'FIXTURE_API_LOOKUP_FAILED');
    return (await response.json()) as T;
  };
  const queue = (name: string) => api<Queue>(`/api/queues/${vhost}/${name}`);
  const [commands, results] = await Promise.all([queue(COMMAND_QUEUE), queue(RESULT_QUEUE)]);
  check(
    [commands, results].every(
      (item) =>
        item.type === 'quorum' && item.durable && item.messages === 0 && item.consumers === 0,
    ),
    'EMPTY_EXCLUSIVE_QUEUES_REQUIRED',
  );
  check(
    (commands.arguments['x-max-length'] ?? commands.effective_policy_definition?.['max-length']) ===
      1 &&
      (commands.arguments['x-overflow'] ?? commands.effective_policy_definition?.overflow) ===
        'reject-publish',
    'COMMAND_QUEUE_MUST_REJECT_AT_ONE',
  );
  const config: ComputeConfig = {
    brokerURL: appURL.toString(),
    brokerUser: userA,
    expectedResultUser: userB,
  };
  const memory = async () => {
    const nodes = await api<Memory[]>('/api/nodes');
    check(nodes.length === 1 && nodes[0], 'SINGLE_FIXTURE_NODE_REQUIRED');
    return nodes[0];
  };
  const blocked = async () =>
    (await api<Connection[]>('/api/connections')).some(
      (connection) =>
        connection.user === userA && connection.vhost === vhost && connection.state === 'blocked',
    );
  const setWatermark = async (bytes: number) => {
    await execute(
      'docker',
      [
        'exec',
        container,
        'rabbitmqctl',
        '-q',
        'set_vm_memory_high_watermark',
        'absolute',
        String(bytes),
      ],
      { timeout: 10_000 },
    );
    console.log(JSON.stringify({ observation: 'memory-watermark-set', bytes }));
  };
  return { config, workerURL: workerURL.toString(), queue, memory, blocked, setWatermark };
}

type Job = { jobId: string; requestId: string; status: string; resultAssetId: string | null };
type Outbox = {
  request_id: string;
  state: string;
  command: ComputeCommandV1;
  sent_at: Date | null;
};

async function probe() {
  const { config, workerURL, queue, memory, blocked, setWatermark } = await prepareFixture();
  const database = await authDatabase();
  const observer = new Pool({
    connectionString: database.observerURL,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  let service: ReturnType<typeof createComputeService> | undefined;
  let server: Server | undefined;
  let worker: ChannelModel | undefined;
  let failed = false;
  let releaseHead = Promise.withResolvers<void>();
  let watermarkNeedsRestore = false;
  const restoreMemory = async () => {
    await setWatermark(restoreLimit);
    await waitFor(async () => {
      const node = await memory();
      if (!node.mem_alarm && node.mem_limit === restoreLimit) return true;
    }, 'MEMORY_ALARM_NOT_CLEARED');
    watermarkNeedsRestore = false;
  };
  const nacks = new Map<string, { count: number; unsent: boolean }>();
  const brokerCloses = new Set<ComputeBroker>();
  const originalPublish = ComputeBroker.prototype.publish;
  const originalClose = ComputeBroker.prototype.close;
  // Observe the real publish promise. amqplib 2.2.1 uses a distinct confirm error for Basic.Nack.
  ComputeBroker.prototype.publish = async function (command) {
    try {
      await originalPublish.call(this, command);
    } catch (error) {
      if (error instanceof Error && error.message === 'message nacked') {
        const persisted = await observer.query<{ sent_at: Date | null }>(
          'SELECT sent_at FROM mio_compute_outbox WHERE id=$1',
          [command.messageId],
        );
        nacks.set(command.messageId, {
          count: (nacks.get(command.messageId)?.count ?? 0) + 1,
          unsent: persisted.rows[0]?.sent_at === null,
        });
      }
      throw error;
    }
  };
  ComputeBroker.prototype.close = function () {
    brokerCloses.add(this);
    return originalClose.call(this);
  };
  try {
    await observer.query(assetSchemaSQL);
    await observer.query(computeSchemaSQL);
    const actor = { userId: 'queue-probe-owner', sessionId: 'queue-probe-session' };
    const assetId = randomUUID();
    const resultMessageId = randomUUID();
    console.log(JSON.stringify({ observation: 'fixture-started', assetId, resultMessageId }));
    const rawKey = `mio/raw/${assetId}/${randomUUID()}`;
    await observer.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at)
       VALUES($1,$2,'probe.mp4','video/mp4',4,$3,$4,'ready',now()+interval '1 day')`,
      [assetId, actor.userId, `mio/staging/${assetId}`, rawKey],
    );
    let outputKey: string | undefined;
    let derivedHeads = 0;
    const sha256 = 'a'.repeat(64);
    const unavailableObjectOperation = () => {
      throw new Error('QUEUE_PROBE_UNEXPECTED_OBJECT_OPERATION');
    };
    const objects: AssetObjectStore = {
      uploadUrl: unavailableObjectOperation,
      downloadUrl: unavailableObjectOperation,
      copy: unavailableObjectOperation,
      delete: unavailableObjectOperation,
      async head(key) {
        if (key === rawKey) return { size: 4, etag: 'probe-raw-etag' };
        check(key === outputKey, 'UNEXPECTED_HEAD_KEY');
        derivedHeads++;
        await releaseHead.promise;
        return { size: 7, etag: 'probe-output-etag', sha256 };
      },
    };
    service = createComputeService(await createComputeStore(database.url), objects, config);
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    check(address && typeof address !== 'string', 'HTTP_LISTENER_MISSING');
    const origin = `http://127.0.0.1:${address.port}`;
    server.on(
      'request',
      createComputeHandler(service, async () => actor, [origin]),
    );
    const endpoint = `${origin}/api/v1/compute/jobs`;
    const submit = async (requestId: string = randomUUID(), expectedStatus = 202) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, assetId }),
        signal: AbortSignal.timeout(5000),
      });
      check(response.status === expectedStatus, 'HTTP_SUBMIT_STATUS');
      const job = (await response.json()) as Job;
      check(job.requestId === requestId && typeof job.jobId === 'string', 'HTTP_JOB_IDENTITY');
      return job;
    };
    const outbox = async (job: Job) => {
      const rows = await observer.query<Outbox>(
        `SELECT j.request_id,j.state,o.command,o.sent_at FROM mio_compute_jobs j
         JOIN mio_compute_outbox o ON o.job_id=j.id WHERE j.id=$1`,
        [job.jobId],
      );
      const row = rows.rows[0];
      check(
        rows.rows.length === 1 &&
          row?.request_id === job.requestId &&
          row.command.jobId === job.jobId,
        'OUTBOX_IDENTITY',
      );
      return row;
    };
    const recordJob = (job: Job, command: ComputeCommandV1) => {
      console.log(
        JSON.stringify({
          observation: 'job-accepted',
          requestId: job.requestId,
          jobId: job.jobId,
          messageId: command.messageId,
        }),
      );
    };
    const queued = (job: Job) =>
      waitFor(async () => {
        const row = await outbox(job);
        if (row.state === 'queued' && row.sent_at) return row.command;
      }, 'JOB_NOT_QUEUED');
    const succeeded = (job: Job) =>
      waitFor(async () => {
        const response = await fetch(`${endpoint}/${job.jobId}`, {
          signal: AbortSignal.timeout(5000),
        });
        check(response.ok, 'HTTP_RESULT_LOOKUP_FAILED');
        const current = (await response.json()) as Job;
        if (current.status === 'succeeded') return current;
      }, 'RESULT_NOT_PERSISTED');
    const checkEffects = async (job: Job, key: string, resultId: string) => {
      const effects = await observer.query<{ assets: number; events: number }>(
        `SELECT
          (SELECT count(*)::int FROM mio_assets WHERE id=$1 AND owner_id=$2 AND raw_key=$3 AND asset_kind='derived') AS assets,
          (SELECT count(*)::int FROM mio_compute_inbox WHERE id=$4) AS events`,
        [job.resultAssetId, actor.userId, key, resultId],
      );
      check(effects.rows[0]?.assets === 1 && effects.rows[0]?.events === 1, 'RESULT_EFFECTS');
    };
    const drained = (name: string, minimumAcks: number) =>
      waitFor(async () => {
        const state = await queue(name);
        const acks = state.message_stats?.ack ?? 0;
        if (
          acks >= minimumAcks &&
          state.messages_ready === 0 &&
          state.messages_unacknowledged === 0
        )
          return acks;
      }, 'QUEUE_NOT_DRAINED');
    worker = await connect(workerURL, { timeout: 5000 });
    worker.on('error', () => {});
    const receiver = await worker.createChannel();
    receiver.on('error', () => {});
    const publisher = await worker.createConfirmChannel();
    publisher.on('error', () => {});
    const take = async (command: ComputeCommandV1) => {
      const message = await receiver.get(COMMAND_QUEUE, { noAck: false });
      check(
        message &&
          message.properties.userId === config.brokerUser &&
          message.properties.messageId === command.messageId &&
          isDeepStrictEqual(parseComputeCommandV1(JSON.parse(message.content.toString())), command),
        'UNEXPECTED_COMMAND_LEFT_UNACKED',
      );
      return message;
    };

    phase = 'queue-full';
    const finishing = await submit();
    recordJob(finishing, (await outbox(finishing)).command);
    const completedCommand = await queued(finishing);
    const working = await take(completedCommand);
    const retained = await submit();
    recordJob(retained, (await outbox(retained)).command);
    const retainedCommand = await queued(retained);
    const retainedCommands = [retainedCommand];
    outputKey = `mio/derived/${finishing.jobId}/${completedCommand.attemptId}/result.mp4`;
    const result: ComputeResultV1 = {
      version: COMPUTE_VERSION,
      type: 'transcode.result',
      messageId: resultMessageId,
      commandId: completedCommand.messageId,
      jobId: finishing.jobId,
      attemptId: completedCommand.attemptId,
      attempt: completedCommand.attempt,
      state: 'succeeded',
      output: { key: outputKey, sizeBytes: 7, etag: 'probe-output-etag', sha256 },
    };
    const publishResult = async (event: ComputeResultV1) => {
      publisher.publish(RESULT_EXCHANGE, RESULT_ROUTING_KEY, Buffer.from(JSON.stringify(event)), {
        contentType: 'application/json',
        messageId: event.messageId,
        userId: config.expectedResultUser,
        mandatory: true,
        persistent: true,
      });
      await publisher.waitForConfirms();
    };
    await publishResult(result);
    receiver.ack(working);
    await waitFor(() => (derivedHeads ? true : undefined), 'RESULT_NOT_ADMITTED');

    // Quorum limits permit overshoot. Bound admissions and require a real broker Nack.
    let refused: { job: Job; command: ComputeCommandV1 } | undefined;
    for (let admission = 0; admission < 4; admission++) {
      const job = await submit();
      const { command: admittedCommand } = await outbox(job);
      recordJob(job, admittedCommand);
      const outcome = await waitFor(async () => {
        const nack = nacks.get(admittedCommand.messageId);
        if (nack) return { nacked: true, unsent: nack.unsent };
        if ((await outbox(job)).sent_at) return { nacked: false, unsent: false };
      }, 'NO_CONFIRMED_PUBLISH_OUTCOME');
      if (outcome.nacked) {
        check(outcome.unsent, 'NACK_MARKED_OUTBOX_SENT');
        refused = { job, command: admittedCommand };
        break;
      }
      retainedCommands.push(admittedCommand);
      console.log(
        JSON.stringify({
          observation: 'quorum-soft-limit-confirmed',
          messageId: admittedCommand.messageId,
        }),
      );
    }
    check(refused, 'PUBLISH_NACK_NOT_OBSERVED');
    const { job: pending, command } = refused;
    console.log(
      JSON.stringify({
        observation: 'command-nacked',
        outboxUnsentAtNack: nacks.get(command.messageId)?.unsent,
        requestId: pending.requestId,
        jobId: pending.jobId,
        messageId: command.messageId,
      }),
    );
    releaseHead.resolve();
    const completed = await succeeded(finishing);
    // Publish a duplicate after the Nack, while the retained command still fills the queue.
    await publishResult(result);
    const resultAcks = await drained(RESULT_QUEUE, 2);
    await checkEffects(completed, outputKey, result.messageId);
    const afterRefusal = await outbox(pending);
    check(isDeepStrictEqual(afterRefusal.command, command), 'REFUSED_COMMAND_CHANGED');
    check((await queue(COMMAND_QUEUE)).messages_ready > 0, 'COMMAND_BACKLOG_NOT_RETAINED');
    console.log(
      JSON.stringify({
        observation: 'result-persisted-while-command-queue-full',
        resultAcks,
        resultHeads: derivedHeads,
        brokerCloses: brokerCloses.size,
        confirmedBeforeDrain: afterRefusal.sent_at !== null,
      }),
    );
    for (const retainedItem of retainedCommands) receiver.ack(await take(retainedItem));
    const recovered = await queued(pending);
    check(isDeepStrictEqual(recovered, command), 'RECOVERY_CHANGED_COMMAND');
    receiver.ack(await take(command));
    check((await submit(pending.requestId, 200)).jobId === pending.jobId, 'RECOVERY_CHANGED_JOB');
    const commandAcks = await drained(COMMAND_QUEUE, retainedCommands.length + 2);
    console.log(
      JSON.stringify({
        observation: 'retained-command-delivered-and-outbox-recovered',
        retainedMessageIds: retainedCommands.map((item) => item.messageId),
        requestId: pending.requestId,
        jobId: pending.jobId,
        messageId: command.messageId,
      }),
    );

    phase = 'memory-result-admission';
    const before = await memory();
    check(before.mem_limit === restoreLimit && !before.mem_alarm, 'MEMORY_BASELINE_CHANGED');
    releaseHead = Promise.withResolvers<void>();
    const headsBeforeAlarm = derivedHeads;
    const alarmFinishing = await submit();
    recordJob(alarmFinishing, (await outbox(alarmFinishing)).command);
    const alarmCommand = await queued(alarmFinishing);
    const alarmWorking = await take(alarmCommand);
    outputKey = `mio/derived/${alarmFinishing.jobId}/${alarmCommand.attemptId}/result.mp4`;
    const alarmResult: ComputeResultV1 = {
      ...result,
      messageId: randomUUID(),
      commandId: alarmCommand.messageId,
      jobId: alarmFinishing.jobId,
      attemptId: alarmCommand.attemptId,
      attempt: alarmCommand.attempt,
      output: { ...result.output, key: outputKey },
    };
    console.log(
      JSON.stringify({
        observation: 'alarm-result-started',
        resultMessageId: alarmResult.messageId,
      }),
    );
    await publishResult(alarmResult);
    receiver.ack(alarmWorking);
    await waitFor(
      () => (derivedHeads > headsBeforeAlarm ? true : undefined),
      'ALARM_RESULT_NOT_ADMITTED',
    );

    phase = 'memory-alarm';
    watermarkNeedsRestore = true;
    await setWatermark(1);
    await waitFor(
      async () => ((await memory()).mem_alarm ? true : undefined),
      'MEMORY_ALARM_NOT_TRIGGERED',
    );
    const alarmPending = await submit();
    const alarmOutbox = (await outbox(alarmPending)).command;
    recordJob(alarmPending, alarmOutbox);
    await waitFor(async () => ((await blocked()) ? true : undefined), 'APP_PUBLISHER_NOT_BLOCKED');
    const underAlarm = await outbox(alarmPending);
    check(
      underAlarm.sent_at === null &&
        underAlarm.state === 'accepted' &&
        isDeepStrictEqual(underAlarm.command, alarmOutbox),
      'ALARM_OUTBOX_CHANGED',
    );
    releaseHead.resolve();
    const alarmCompleted = await succeeded(alarmFinishing);
    const alarmResultAcks = await drained(RESULT_QUEUE, resultAcks + 1);
    await checkEffects(alarmCompleted, outputKey, alarmResult.messageId);
    const stillAlarmed = await memory();
    check(stillAlarmed.mem_alarm && stillAlarmed.mem_limit === 1, 'MEMORY_ALARM_ENDED_EARLY');
    check((await outbox(alarmPending)).sent_at === null, 'OUTBOX_SENT_DURING_MEMORY_ALARM');
    console.log(
      JSON.stringify({
        observation: 'result-acked-during-memory-alarm',
        resultAcks: alarmResultAcks,
        requestId: alarmPending.requestId,
        jobId: alarmPending.jobId,
        messageId: alarmOutbox.messageId,
      }),
    );
    phase = 'memory-restoration';
    await restoreMemory();
    const resumed = await queued(alarmPending);
    check(isDeepStrictEqual(resumed, alarmOutbox), 'ALARM_RECOVERY_CHANGED_COMMAND');
    receiver.ack(await take(alarmOutbox));
    check(
      (await submit(alarmPending.requestId, 200)).jobId === alarmPending.jobId,
      'ALARM_RECOVERY_CHANGED_JOB',
    );
    await drained(COMMAND_QUEUE, commandAcks + 2);
    console.log(
      JSON.stringify({
        observation: 'outbox-recovered-after-memory-alarm',
        messageId: alarmOutbox.messageId,
      }),
    );
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    releaseHead.resolve();
    const restored = watermarkNeedsRestore ? await Promise.allSettled([restoreMemory()]) : [];
    if (restored.length)
      console.log(
        JSON.stringify({
          observation: 'memory-restoration-cleanup',
          ok: restored[0]?.status === 'fulfilled',
        }),
      );
    const stopped = await Promise.allSettled([
      service?.close(),
      worker?.close(),
      server?.listening
        ? new Promise<void>((resolve, reject) => {
            server!.closeAllConnections();
            server!.close((error) => (error ? reject(error) : resolve()));
          })
        : undefined,
    ]);
    ComputeBroker.prototype.publish = originalPublish;
    ComputeBroker.prototype.close = originalClose;
    const [observerStop] = await Promise.allSettled([observer.end()]);
    const [databaseStop] = await Promise.allSettled([database.close()]);
    const cleanupOk = [...restored, ...stopped, observerStop, databaseStop].every(
      (item) => item.status === 'fulfilled',
    );
    console.log(JSON.stringify({ observation: 'fixture-cleanup', ok: cleanupOk }));
    if (!failed) check(cleanupOk, 'CLEANUP_FAILED');
  }
}

try {
  await probe();
  console.log('QUEUE_PROBE_PASS');
} catch (error) {
  const code =
    error instanceof Error && /^QUEUE_PROBE_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'QUEUE_PROBE_UNEXPECTED';
  console.error(JSON.stringify({ phase, code }));
  process.exitCode = 1;
}
