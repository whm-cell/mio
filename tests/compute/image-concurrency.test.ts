import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import type { ConsumeMessage } from 'amqplib';
import {
  COMMAND_EXCHANGE,
  COMMAND_QUEUE,
  COMMAND_ROUTING_KEY,
  IMAGE_COMMAND_QUEUE,
  IMAGE_COMMAND_ROUTING_KEY,
  IMAGE_WORKER_PREFETCH,
  RESULT_EXCHANGE,
  RESULT_QUEUE,
  RESULT_ROUTING_KEY,
  imageOutputIndex,
  imageOutputKey,
} from '@mio/compute-contracts';
import { Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { createComputeHandler } from '../../src/compute/http.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { ComputeStore } from '../../src/compute/store.ts';
import { Journal } from '../../compute/src/adapters/journal.ts';
import { createImageWorker, recoverImageMaterialization } from '../../compute/src/image-worker.ts';
import { Maintenance } from '../../compute/src/maintenance.ts';
import { Worker } from '../../compute/src/worker.ts';
import {
  computeCapacity,
  computePermissions,
  computeTopology,
} from '../../scripts/service/compute-broker-topology.ts';
import { findFixtureImageRouteConfig } from '../providers/fixtures/onelink-routes-fixture.ts';
import { authDatabase } from '../support/auth-database.ts';

const GPT_ROUTE = findFixtureImageRouteConfig('gpt-image-2');
const VALID_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

function createInMemoryAmqpHub() {
  type QueueEntry = { content: Buffer; properties: Record<string, unknown> };
  const queues = new Map<string, QueueEntry[]>([
    [COMMAND_QUEUE, []],
    [IMAGE_COMMAND_QUEUE, []],
    [RESULT_QUEUE, []],
    ['mio.compute.commands.dlq.v1', []],
    ['mio.compute.image.commands.dlq.v1', []],
    ['mio.compute.results.dlq.v1', []],
  ]);
  const dlqByQueue = new Map<string, string>([
    [COMMAND_QUEUE, 'mio.compute.commands.dlq.v1'],
    [IMAGE_COMMAND_QUEUE, 'mio.compute.image.commands.dlq.v1'],
    [RESULT_QUEUE, 'mio.compute.results.dlq.v1'],
  ]);
  const bindingToQueue = new Map<string, string>([
    [`${COMMAND_EXCHANGE}:${COMMAND_ROUTING_KEY}`, COMMAND_QUEUE],
    [`${COMMAND_EXCHANGE}:${IMAGE_COMMAND_ROUTING_KEY}`, IMAGE_COMMAND_QUEUE],
    [`${RESULT_EXCHANGE}:${RESULT_ROUTING_KEY}`, RESULT_QUEUE],
  ]);
  type ActiveConsumer = {
    queue: string;
    channel: InMemoryChannel;
    callback: (msg: ConsumeMessage | null) => void;
  };
  const consumers: ActiveConsumer[] = [];

  function pump(queueName: string) {
    const items = queues.get(queueName);
    if (!items || items.length === 0) return;
    for (const sub of [...consumers]) {
      if (sub.queue !== queueName || sub.channel.closed) continue;
      while (items.length > 0 && sub.channel.unacked.size < sub.channel.prefetchLimit) {
        const entry = items.shift()!;
        const message = {
          content: entry.content,
          fields: {} as ConsumeMessage['fields'],
          properties: entry.properties as unknown as ConsumeMessage['properties'],
        } as ConsumeMessage;
        sub.channel.unacked.set(message, { queue: queueName, entry });
        queueMicrotask(() => {
          if (!sub.channel.closed) sub.callback(message);
        });
      }
    }
  }

  class InMemoryChannel extends EventEmitter {
    closed = false;
    prefetchLimit = 1;
    readonly unacked = new Map<ConsumeMessage, { queue: string; entry: QueueEntry }>();

    async prefetch(count: number) {
      if (this.closed) throw new Error('Channel closed');
      this.prefetchLimit = Math.max(1, count);
      for (const q of queues.keys()) pump(q);
    }

    async consume(queue: string, callback: (msg: ConsumeMessage | null) => void) {
      if (this.closed) throw new Error('Channel closed');
      consumers.push({ queue, channel: this, callback });
      queueMicrotask(() => pump(queue));
      return { consumerTag: randomUUID() };
    }

    publish(
      exchange: string,
      routingKey: string,
      content: Buffer,
      options: Record<string, unknown>,
      confirm?: (err: Error | null) => void,
    ) {
      const target = bindingToQueue.get(`${exchange}:${routingKey}`);
      if (target) {
        queues.get(target)!.push({ content: Buffer.from(content), properties: { ...options } });
        queueMicrotask(() => {
          confirm?.(null);
          pump(target);
        });
      } else {
        queueMicrotask(() => confirm?.(new Error('UNROUTABLE')));
      }
      return true;
    }

    ack(message: ConsumeMessage) {
      if (this.closed) throw new Error('Channel closed');
      const tracked = this.unacked.get(message);
      this.unacked.delete(message);
      if (tracked) pump(tracked.queue);
    }

    reject(message: ConsumeMessage, requeue = true) {
      if (this.closed) throw new Error('Channel closed');
      const tracked = this.unacked.get(message);
      this.unacked.delete(message);
      if (tracked) {
        if (requeue) {
          queues.get(tracked.queue)!.unshift(tracked.entry);
        } else {
          const dlq = dlqByQueue.get(tracked.queue);
          if (dlq) queues.get(dlq)!.push(tracked.entry);
        }
        pump(tracked.queue);
      }
    }

    async close() {
      if (this.closed) return;
      this.closed = true;
      for (let i = consumers.length - 1; i >= 0; i--) {
        if (consumers[i]!.channel === this) consumers.splice(i, 1);
      }
      const requeueEntries = [...this.unacked.values()].reverse();
      this.unacked.clear();
      for (const item of requeueEntries) {
        queues.get(item.queue)!.unshift(item.entry);
        pump(item.queue);
      }
      this.emit('close');
    }
  }

  class InMemoryConnection extends EventEmitter {
    readonly #channels: InMemoryChannel[] = [];
    #closed = false;
    async createChannel() {
      if (this.#closed) throw new Error('Connection closed');
      const ch = new InMemoryChannel();
      this.#channels.push(ch);
      return ch;
    }
    async createConfirmChannel() {
      return this.createChannel();
    }
    async close() {
      if (this.#closed) return;
      this.#closed = true;
      for (const ch of this.#channels) await ch.close();
      this.emit('close');
    }
  }

  return {
    connect: async () => new InMemoryConnection(),
  };
}

afterEach(() => {
  vi.doUnmock('amqplib');
  vi.resetModules();
});

it('processes 15 concurrent image jobs without head-of-line blocking or quota starvation while 10 video jobs saturate video quota and block Worker B, enforces 32 active image quota, and avoids duplicate upstream POSTs on redelivery', async () => {
  const cleanups: (() => Promise<void>)[] = [];
  try {
    const database = await authDatabase();
    cleanups.push(async () => {
      await database.close();
    });
    const pool = new Pool({ connectionString: database.url });
    cleanups.push(async () => {
      await pool.end();
    });
    await pool.query(assetSchemaSQL);
    await pool.query(computeSchemaSQL);

    let appBrokerUrl: string;
    let appBrokerUser: string;
    let expectedResultUser: string;
    let workerBrokerUrl: string;

    if (existsSync(resolve('.env.test'))) {
      const envTest = parseEnv(await readFile(resolve('.env.test'), 'utf8'));
      const mgmtPort = envTest.MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT;
      const amqpPort = envTest.MIO_LOCAL_RABBITMQ_PORT;
      const adminPass = envTest.MIO_LOCAL_RABBITMQ_PASSWORD;
      assert(mgmtPort && amqpPort && adminPass, 'LOCAL_TEST_RABBITMQ_ENV_REQUIRED');
      const token = randomBytes(6).toString('hex');
      const vhost = `mio-img-conc-${token}`;
      const userA = `mio-a-${token}`;
      const passA = randomBytes(24).toString('base64url');
      const userB = `mio-b-${token}`;
      const passB = randomBytes(24).toString('base64url');
      const adminAuth = Buffer.from(`mio-test-admin:${adminPass}`).toString('base64');
      const mgmtBase = `http://127.0.0.1:${mgmtPort}/api/`;
      const mgmtApi = async (method: string, path: string, body?: Record<string, unknown>) => {
        const res = await fetch(new URL(path, mgmtBase), {
          method,
          headers: {
            authorization: `Basic ${adminAuth}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
          throw new Error(`RABBITMQ_MGMT_${res.status}:${method}:${path}`);
        }
      };
      const encVhost = encodeURIComponent(vhost);
      await mgmtApi('PUT', `vhosts/${encVhost}`, {});
      await mgmtApi('PUT', `operator-policies/${encVhost}/mio-capacity`, {
        pattern: '.*',
        definition: computeCapacity,
        priority: 0,
        'apply-to': 'queues',
      });
      for (const item of computeTopology(vhost)) {
        await mgmtApi(item.method, item.path, item.body);
      }
      for (const [role, username, password] of [
        ['a', userA, passA],
        ['b', userB, passB],
      ] as const) {
        await mgmtApi('PUT', `users/${encodeURIComponent(username)}`, {
          password,
          tags: '',
        });
        await mgmtApi(
          'PUT',
          `permissions/${encVhost}/${encodeURIComponent(username)}`,
          computePermissions(role),
        );
      }
      cleanups.push(async () => {
        await mgmtApi('DELETE', `vhosts/${encVhost}`).catch(() => {});
        await mgmtApi('DELETE', `users/${encodeURIComponent(userA)}`).catch(() => {});
        await mgmtApi('DELETE', `users/${encodeURIComponent(userB)}`).catch(() => {});
      });
      appBrokerUrl = `amqp://${encodeURIComponent(userA)}:${encodeURIComponent(passA)}@127.0.0.1:${amqpPort}/${encVhost}`;
      appBrokerUser = userA;
      expectedResultUser = userB;
      workerBrokerUrl = `amqp://${encodeURIComponent(userB)}:${encodeURIComponent(passB)}@127.0.0.1:${amqpPort}/${encVhost}`;
    } else {
      assert.equal(
        process.env.GITHUB_ACTIONS,
        'true',
        'Local runs require .env.test and mio-test RabbitMQ',
      );
      const hub = createInMemoryAmqpHub();
      vi.doMock('amqplib', () => ({ connect: hub.connect }));
      appBrokerUrl = 'amqp://mio-ci-a:secret@127.0.0.1:5672/mio-ci';
      appBrokerUser = 'mio-ci-a';
      expectedResultUser = 'mio-ci-b';
      workerBrokerUrl = 'amqp://mio-ci-b:secret@127.0.0.1:5672/mio-ci';
    }

    const { Broker } = await import('../../compute/src/adapters/rabbitmq.ts');
    const { createComputeService: createDynamicComputeService } =
      await import('../../src/compute/service.ts');

    const ownerId = `owner-${randomUUID()}`;
    const videoAssetId = randomUUID();
    const videoRawKey = `mio/raw/${videoAssetId}/${randomUUID()}`;
    const videoBytes = Buffer.from('mp4-placeholder');
    const videoSha256 = createHash('sha256').update(videoBytes).digest('hex');
    const videoEtag = `"raw-${videoSha256.slice(0, 16)}"`;

    const cosObjects = new Map<string, { size: number; etag: string; sha256: string }>([
      [videoRawKey, { size: videoBytes.length, etag: videoEtag, sha256: videoSha256 }],
    ]);

    await pool.query(
      "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at,asset_kind) VALUES($1,$2,'clip.mp4','video/mp4',$3,$4,$5,'ready',now(),'original')",
      [videoAssetId, ownerId, videoBytes.length, `mio/staging/${videoAssetId}`, videoRawKey],
    );

    const rsaKeys = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const imageKeyId = 'conc-key-v1';
    const providerConfigId = randomUUID();

    const store = new ComputeStore(pool, true);
    const service = createDynamicComputeService(
      store,
      {
        head: async (key: string) => {
          const found = cosObjects.get(key);
          if (!found) throw Object.assign(new Error('NOT_FOUND'), { statusCode: 404 });
          return found;
        },
        uploadUrl: () => '',
        downloadUrl: () => '',
        copy: async () => {},
        delete: async () => {},
      },
      {
        brokerURL: appBrokerUrl,
        brokerUser: appBrokerUser,
        expectedResultUser,
      },
      {
        keyId: imageKeyId,
        publicKey: rsaKeys.publicKey,
        provider: () =>
          ({
            resolveImageTaskCredential: async () => 'onelink-test-secret',
            resolveImage: async (_actor: unknown, modelRef: string) => ({
              modelId: 'gpt-image-2',
              modelKey: modelRef,
              vendor: 'openai',
              profile: 'openai-images' as const,
              route: GPT_ROUTE,
              apiKey: 'onelink-test-secret',
              providerConfigId,
              providerRevision: 1,
              credentialVersion: 1,
              catalogVersion: 1,
              adaptationVersion: 1,
            }),
            recordVerification: async () => {},
          }) as never,
      },
    );
    cleanups.push(async () => {
      await service.close();
    });

    const httpOrigin = 'http://127.0.0.1:4399';
    const handler = createComputeHandler(
      service,
      async (headers) => {
        const cookie = headers.get('cookie') ?? '';
        const match = /^mio_user=(.+)$/.exec(cookie);
        return match?.[1] ? { userId: match[1], sessionId: 'conc-session' } : null;
      },
      [httpOrigin],
    );
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    cleanups.push(
      () =>
        new Promise<void>((done) => {
          server.close(() => done());
        }),
    );

    const postApi = async (path: string, body: unknown) => {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          origin: httpOrigin,
          'content-type': 'application/json',
          cookie: `mio_user=${ownerId}`,
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as Record<string, unknown>;
      return { status: res.status, json };
    };
    const getApi = async (path: string) => {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { cookie: `mio_user=${ownerId}` },
      });
      const json = (await res.json()) as Record<string, unknown>;
      return { status: res.status, json };
    };

    // Worker B setup with real SQLite Journal, real Worker (video), and real createImageWorker
    const workerDir = await mkdtemp(join(tmpdir(), 'mio-img-conc-worker-'));
    const workerInstanceId = randomUUID();
    const journal = new Journal(workerDir, workerInstanceId, true);
    cleanups.push(async () => {
      journal.close();
      await rm(workerDir, { recursive: true, force: true });
    });

    let videoDownloadEntered = false;
    let releaseSlowVideo: () => void = () => {};
    const slowVideoGate = new Promise<void>((resolve) => {
      releaseSlowVideo = resolve;
    });
    const videoStore = {
      async download(_command: unknown, _dir: string, signal: AbortSignal) {
        videoDownloadEntered = true;
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          const onAbort = () => reject(new Error('aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
          void slowVideoGate.then(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          });
        });
        throw Object.assign(new Error('input superseded after test'), { statusCode: 412 });
      },
      async head() {
        return null;
      },
      async verify() {
        return false;
      },
      async upload() {},
    };

    let activeUpstream = 0;
    let maxObservedConcurrency = 0;
    const upstreamPostsByPrompt = new Map<string, number>();
    let holdUpstreamGate: Promise<void> | null = null;

    const upstreamTransport: typeof fetch = async (_input, init) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
      const prompt = parsed.prompt ?? 'unknown';
      upstreamPostsByPrompt.set(prompt, (upstreamPostsByPrompt.get(prompt) ?? 0) + 1);
      activeUpstream += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, activeUpstream);
      try {
        if (holdUpstreamGate) await holdUpstreamGate;
        await delay(90);
        return Response.json({ data: [{ b64_json: VALID_PNG_BASE64 }] });
      } finally {
        activeUpstream -= 1;
      }
    };

    const materializeToCos = async (
      jobId: string,
      index: number,
      base64: string,
      format: string,
      fileId: string,
    ) => {
      const bytes = Buffer.from(base64, 'base64');
      const key = imageOutputKey(jobId, index, fileId, format);
      assert.equal(imageOutputIndex(jobId, key, `image/${format}`), index);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const etag = `"img-${sha256.slice(0, 20)}"`;
      cosObjects.set(key, { size: bytes.length, etag, sha256 });
      return {
        key,
        sizeBytes: bytes.length,
        etag,
        sha256,
        contentType: `image/${format}`,
      };
    };

    const imageWorker = createImageWorker(
      journal,
      imageKeyId,
      rsaKeys.privateKey,
      materializeToCos,
      upstreamTransport,
    );

    let dropBeforePublishJobId: string | null = null;
    let droppedOnce = false;
    const sessionFailures: unknown[] = [];

    const startWorkerSession = async () => {
      const workerBroker = await Broker.connect(workerBrokerUrl, expectedResultUser, appBrokerUser);
      const workerInstance = new Worker(journal, videoStore, workerBroker, workerDir);
      const imageStop = new AbortController();
      const maintenance = new Maintenance(
        workerBroker,
        workerInstance,
        (error) => {
          sessionFailures.push(error);
        },
        async (command, ack) => {
          const outcome =
            command.type === 'image.recover'
              ? (
                  await recoverImageMaterialization(
                    journal,
                    command.jobId,
                    command.commandId,
                    command.sequence,
                    materializeToCos,
                    imageStop.signal,
                  )
                ).outcome
              : await imageWorker(command, imageStop.signal);
          if (dropBeforePublishJobId === command.jobId && !droppedOnce) {
            droppedOnce = true;
            throw new Error('IMAGE_MATERIALIZATION_PENDING');
          }
          await workerBroker.publishImage({
            version: 1,
            type: 'image.result',
            messageId: randomUUID(),
            commandId:
              command.type === 'image.recover' || command.type === 'image.query'
                ? command.commandId
                : command.messageId,
            jobId: command.jobId,
            state: outcome.state,
            outputs: 'outputs' in outcome ? outcome.outputs : [],
            ...('errorCode' in outcome ? { errorCode: outcome.errorCode } : {}),
            ...('upstreamTaskId' in outcome ? { upstreamTaskId: outcome.upstreamTaskId } : {}),
            ...('queryAttempt' in outcome ? { queryAttempt: outcome.queryAttempt } : {}),
            ...(command.type === 'image.recover' ? { recoveryId: command.messageId } : {}),
          });
          if (outcome.state === 'materializing') throw new Error('IMAGE_MATERIALIZATION_PENDING');
          ack();
        },
        120,
      );
      await maintenance.tick();
      return {
        workerBroker,
        workerInstance,
        maintenance,
        stopSession: async () => {
          maintenance.stop();
          workerInstance.stop();
          imageStop.abort();
          await workerBroker.close();
          await maintenance.wait().catch(() => {});
          await workerInstance.waitIdle();
        },
      };
    };

    const session = await startWorkerSession();
    cleanups.push(async () => {
      releaseSlowVideo();
      await session.stopSession();
    });

    // 1. Saturate all 10 active video slots for this owner; 11th video job must return 429.
    for (let i = 0; i < 10; i++) {
      const res = await postApi('/api/v1/compute/jobs', {
        requestId: randomUUID(),
        assetId: videoAssetId,
      });
      expect(res.status).toBe(202);
    }
    const eleventhVideo = await postApi('/api/v1/compute/jobs', {
      requestId: randomUUID(),
      assetId: videoAssetId,
    });
    expect(eleventhVideo.status).toBe(429);
    expect((eleventhVideo.json.error as { code?: string })?.code).toBe('COMPUTE_QUOTA_EXCEEDED');

    // Wait until Worker B is actively blocked in the slow video job (holding prefetch(1) on COMMAND_QUEUE).
    await vi.waitFor(
      () => {
        expect(videoDownloadEntered).toBe(true);
        expect(session.workerInstance.admissionReady()).toBe(false);
        expect(session.workerBroker.imageConsuming).toBe(true);
      },
      { timeout: 5000, interval: 25 },
    );

    // 2. While video transcode blocks Worker B and all 10 video slots remain occupied,
    //    submit 15 image jobs rapidly — none may return 429, Service A must batch-drain them rapidly,
    //    and Worker B must execute them with true multi-way concurrency (maxObservedConcurrency >= 2).
    const batchStart = Date.now();
    const fifteenResponses = await Promise.all(
      Array.from({ length: 15 }, (_, index) =>
        postApi('/api/v1/compute/images', {
          requestId: randomUUID(),
          modelRef: 'gpt-image-2',
          parameters: { prompt: `scene-${index}` },
        }),
      ),
    );
    for (const item of fifteenResponses) {
      expect(item.status).toBe(202);
    }
    const fifteenJobIds = fifteenResponses.map((item) => String(item.json.jobId));

    await vi.waitFor(
      async () => {
        const unsent = await pool.query<{ count: string }>(
          'SELECT count(*) AS count FROM mio_image_outbox WHERE sent_at IS NULL',
        );
        expect(Number(unsent.rows[0]!.count)).toBe(0);
      },
      { timeout: 2500, interval: 25 },
    );
    expect(Date.now() - batchStart).toBeLessThan(3000);

    await vi.waitFor(
      async () => {
        const states = await Promise.all(
          fifteenJobIds.map((jobId) => getApi(`/api/v1/compute/images/${jobId}`)),
        );
        for (const state of states) {
          expect(state.status).toBe(200);
          expect(state.json.status).toBe('completed');
          expect((state.json.assetIds as string[]).length).toBe(1);
        }
      },
      { timeout: 10_000, interval: 50 },
    );

    expect(maxObservedConcurrency).toBeGreaterThanOrEqual(2);
    expect(maxObservedConcurrency).toBeLessThanOrEqual(IMAGE_WORKER_PREFETCH);
    // Confirm the slow video job was STILL blocking Worker B throughout all 15 image completions!
    expect(session.workerInstance.admissionReady()).toBe(false);
    for (let i = 0; i < 15; i++) {
      expect(upstreamPostsByPrompt.get(`scene-${i}`)).toBe(1);
    }

    // 3. Verify exact 32 active image quota boundary (33rd active image job returns 429 COMPUTE_QUOTA_EXCEEDED).
    let releaseQuotaGate: () => void = () => {};
    holdUpstreamGate = new Promise<void>((resolve) => {
      releaseQuotaGate = resolve;
    });
    const activeThirtyTwo: string[] = [];
    for (let i = 0; i < 32; i++) {
      const res = await postApi('/api/v1/compute/images', {
        requestId: randomUUID(),
        modelRef: 'gpt-image-2',
        parameters: { prompt: `quota-${i}` },
      });
      expect(res.status).toBe(202);
      activeThirtyTwo.push(String(res.json.jobId));
    }
    const thirtyThird = await postApi('/api/v1/compute/images', {
      requestId: randomUUID(),
      modelRef: 'gpt-image-2',
      parameters: { prompt: 'quota-overflow' },
    });
    expect(thirtyThird.status).toBe(429);
    expect((thirtyThird.json.error as { code?: string })?.code).toBe('COMPUTE_QUOTA_EXCEEDED');

    holdUpstreamGate = null;
    releaseQuotaGate();
    await vi.waitFor(
      async () => {
        const row = await pool.query<{ done: string }>(
          "SELECT count(*) AS done FROM mio_image_jobs WHERE id = ANY($1::uuid[]) AND state = 'completed'",
          [activeThirtyTwo],
        );
        expect(Number(row.rows[0]!.done)).toBe(32);
      },
      { timeout: 15_000, interval: 80 },
    );

    // 4. Verify isolated image-channel recovery & redelivery idempotency while slow video is STILL running:
    //    0 session-level failures, video transcode uninterrupted, and 0 duplicate upstream generation POSTs!
    const redeliveryPrompt = 'redelivery-proof';
    const submittedRedelivery = await postApi('/api/v1/compute/images', {
      requestId: randomUUID(),
      modelRef: 'gpt-image-2',
      parameters: { prompt: redeliveryPrompt },
    });
    expect(submittedRedelivery.status).toBe(202);
    const redeliveryJobId = String(submittedRedelivery.json.jobId);
    dropBeforePublishJobId = redeliveryJobId;

    await vi.waitFor(
      async () => {
        expect(droppedOnce).toBe(true);
        const check = await getApi(`/api/v1/compute/images/${redeliveryJobId}`);
        expect(check.status).toBe(200);
        expect(check.json.status).toBe('completed');
        expect((check.json.assetIds as string[]).length).toBe(1);
      },
      { timeout: 8000, interval: 50 },
    );
    expect(upstreamPostsByPrompt.get(redeliveryPrompt)).toBe(1);
    expect(sessionFailures).toEqual([]);
    expect(session.workerInstance.admissionReady()).toBe(false);
    releaseSlowVideo();
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await cleanup().catch(() => {});
    }
  }
}, 45_000);
