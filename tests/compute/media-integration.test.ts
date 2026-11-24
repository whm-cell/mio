import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer, createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  MEDIA_CONTROL_QUEUE,
  MEDIA_CORE_OPERATIONS,
  MEDIA_ENCODE_QUEUE,
  MEDIA_PROBE_QUEUE,
  parseMediaManifest,
} from '@mio/compute-contracts';
import { connect } from 'amqplib';
import type { MediaData, MediaOperation, MediaRequest } from '@mio/compute-contracts';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { Journal } from '../../compute/src/adapters/journal.ts';
import { executeMedia } from '../../compute/src/media-executor.ts';
import { runMediaRuntime } from '../../compute/src/media-runtime.ts';
import type { MediaStore as WorkerObjects } from '../../compute/src/media-worker.ts';
import { ResourceSlots } from '../../compute/src/resource-slots.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { createMediaHandler } from '../../src/compute/media-http.ts';
import { createMediaService } from '../../src/compute/media-service.ts';
import { MediaStore } from '../../src/compute/media-store.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { ComputeBroker, MediaPublishRejected } from '../../src/integrations/rabbitmq.ts';
import { authDatabase } from '../support/auth-database.ts';
import { withLocalTestBroker } from '../support/local-broker-fixture.ts';

type Job = {
  jobId: string;
  operation: MediaOperation;
  profile: string;
  status: string;
  attempt: number;
  errorCode: string | null;
  data: MediaData;
  outputs: { name: string; assetId: string; sizeBytes: number; contentType: string }[];
};
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function storage() {
  const blobs = new Map<string, Buffer>();
  const puts: string[] = [];
  const get = (key: string) => {
    const bytes = blobs.get(key);
    if (!bytes) throw Object.assign(new Error('NOT_FOUND'), { statusCode: 404 });
    const sha256 = digest(bytes);
    return { bytes, size: bytes.length, etag: `"${sha256}"`, sha256 };
  };
  const app: AssetObjectStore = {
    uploadUrl: () => '',
    downloadUrl: () => '',
    async head(key) {
      const { size, etag, sha256 } = get(key);
      return { size, etag, sha256 };
    },
    async readMedia(key, etag, size, signal) {
      signal.throwIfAborted();
      const object = get(key);
      if (object.etag !== etag || object.size !== size) throw new Error('INPUT_CHANGED');
      return object.bytes;
    },
    async copy() {
      throw new Error('UNEXPECTED_COPY');
    },
    async delete() {
      throw new Error('UNEXPECTED_DELETE');
    },
  };
  const worker: WorkerObjects = {
    async downloadMedia(input, files, name, signal) {
      const object = get(input.key);
      if (object.etag !== input.etag || object.size !== input.sizeBytes)
        throw new Error('INPUT_CHANGED');
      await files.receive(name, Readable.from(object.bytes), input.sizeBytes, signal);
    },
    async uploadMedia(key, files, name, expected, _contentType, signal) {
      signal.throwIfAborted();
      const bytes = await readFile(files.path(name));
      expect(blobs.has(key)).toBe(false);
      expect({ size: bytes.length, sha256: digest(bytes) }).toEqual(expected);
      blobs.set(key, bytes);
      puts.push(key);
    },
    async headMedia(key, signal) {
      signal.throwIfAborted();
      if (!blobs.has(key)) return null;
      const { size, etag, sha256 } = get(key);
      return { sizeBytes: size, etag, sha256 };
    },
    async verifyMedia(key, etag, size, sha256, signal) {
      signal.throwIfAborted();
      const object = get(key);
      return object.etag === etag && object.size === size && object.sha256 === sha256;
    },
  };
  return { app, worker, blobs, puts, get };
}

function ffmpeg(args: string[]): void {
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-n',
      '-threads',
      '2',
      '-filter_threads',
      '2',
      '-filter_complex_threads',
      '2',
      ...args,
    ],
    { timeout: 30000 },
  );
}

async function workerRelay(target: string) {
  const upstream = new URL(target);
  const brokerPort = Number(upstream.port);
  const sockets = new Set<Socket>();
  const server = createTcpServer((client) => {
    const broker = createConnection({ host: '127.0.0.1', port: brokerPort });
    for (const socket of [client, broker]) {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => {
        sockets.delete(socket);
        client.destroy();
        broker.destroy();
      });
    }
    client.pipe(broker);
    broker.pipe(client);
  });
  const drop = () => {
    for (const socket of sockets) socket.destroy();
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('RELAY_LISTEN_FAILED');
  upstream.port = String(address.port);
  return {
    url: upstream.href,
    drop,
    close: () => {
      drop();
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function samples(
  root: string,
  pool: Pool,
  owner: string,
  objects: ReturnType<typeof storage>,
) {
  const paths = Object.fromEntries(
    ['clip.mp4', 'tone.wav', 'silent.mp4'].map((name) => [name, join(root, name)]),
  );
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=black:size=160x90:rate=10:duration=1.5',
    '-f',
    'lavfi',
    '-i',
    'color=white:size=160x90:rate=10:duration=1.5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=3',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map',
    '[v]',
    '-map',
    '2:a:0',
    '-c:v',
    'libx264',
    '-g',
    '10',
    '-c:a',
    'aac',
    '-pix_fmt',
    'yuv420p',
    paths['clip.mp4']!,
  ]);
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=730:sample_rate=22050:duration=0.7',
    '-c:a',
    'pcm_s16le',
    paths['tone.wav']!,
  ]);
  ffmpeg(['-i', paths['clip.mp4']!, '-c:v', 'copy', '-an', paths['silent.mp4']!]);
  const insert = async (filename: string, bytes: Buffer) => {
    const assetId = randomUUID(),
      key = `mio/raw/${assetId}/${randomUUID()}`;
    objects.blobs.set(key, bytes);
    await pool.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,raw_key,state,source_etag,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,'ready',$7,now()+interval '1 day')`,
      [
        assetId,
        owner,
        filename,
        filename.endsWith('.wav') ? 'audio/wav' : 'video/mp4',
        bytes.length,
        key,
        '"original-staging-etag"',
      ],
    );
    return { assetId, key };
  };
  return {
    video: await insert('clip.mp4', await readFile(paths['clip.mp4']!)),
    tone: await insert('tone.wav', await readFile(paths['tone.wav']!)),
    silent: await insert('silent.mp4', await readFile(paths['silent.mp4']!)),
    invalid: await insert('invalid.mp4', Buffer.from('declared video; invalid bytes')),
  };
}

it('publishes the eleven base operations through real HTTP, PostgreSQL, RabbitMQ, SQLite and FFmpeg', async () => {
  await withLocalTestBroker(async (broker) => {
    const database = await authDatabase();
    const pool = new Pool({ connectionString: database.url });
    const root = await mkdtemp(join(tmpdir(), 'mio-media-integration-'));
    const stop = new AbortController();
    const objects = storage();
    const actor = { userId: 'media-integration-owner', sessionId: 'media-integration-session' };
    let service: ReturnType<typeof createMediaService> | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    let journal: Journal | undefined;
    let runtime: Promise<void> | undefined;
    let runtimeFailure: unknown;
    let relay: Awaited<ReturnType<typeof workerRelay>> | undefined;
    try {
      await pool.query(assetSchemaSQL);
      await pool.query(computeSchemaSQL);
      const { video, tone, silent, invalid } = await samples(root, pool, actor.userId, objects);
      journal = new Journal(root, 'media-integration', true);
      relay = await workerRelay(broker.workerBrokerUrl);
      const slots = new ResourceSlots();
      runtime = runMediaRuntime(
        {
          url: relay.url,
          userId: broker.userB,
          expectedUserId: broker.userA,
          directory: root,
        },
        objects.worker,
        journal,
        executeMedia,
        stop.signal,
        slots,
      ).catch((error) => {
        runtimeFailure = error;
      });
      service = createMediaService(
        new MediaStore(new Pool({ connectionString: database.url })),
        objects.app,
        {
          brokerURL: broker.appBrokerUrl,
          brokerUser: broker.userA,
          expectedResultUser: broker.userB,
        },
      );
      let origin = '';
      const identity = async (headers: Headers) =>
        headers.get('cookie') === 'owner' ? actor : { ...actor, userId: 'other' };
      const admitted = service;
      server = createServer((request, response) => {
        void handle(request, response);
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('LISTEN_FAILED');
      origin = `http://127.0.0.1:${address.port}`;
      const handle = createMediaHandler(admitted, identity, [origin]);
      const call = (path: string, request?: unknown, cookie = 'owner') =>
        fetch(origin + '/api/v1/compute/media' + path, {
          method: request === undefined ? 'GET' : 'POST',
          headers: { cookie, origin, 'content-type': 'application/json' },
          ...(request === undefined ? {} : { body: JSON.stringify(request) }),
        });
      const submit = async (
        operation: MediaOperation,
        inputs: string[],
        parameters: MediaRequest['parameters'],
      ) => {
        const request = {
          requestId: randomUUID(),
          operation,
          inputs: inputs.map((assetId) => ({ assetId })),
          parameters,
        };
        const saved = await call('', request);
        expect(saved.status, await saved.clone().text()).toBe(202);
        const { jobId } = (await saved.json()) as Job;
        let job: Job;
        await vi.waitFor(
          async () => {
            job = (await (await call('/' + jobId)).json()) as Job;
            expect(['succeeded', 'failed', 'reconciling']).toContain(job.status);
          },
          { timeout: 8_000, interval: 25 },
        );
        return { job: job!, request };
      };
      const cases: [MediaOperation, string[], MediaRequest['parameters'], number][] = [
        ['media.probe', [video.assetId], {}, 0],
        ['video.reference_prepare', [silent.assetId], {}, 0],
        ['video.trim', [video.assetId], { startSeconds: 0.2, endSeconds: 1.5 }, 1],
        [
          'frames.extract',
          [video.assetId],
          {
            mode: 'timestamps',
            timestamps: Array.from({ length: 12 }, (_, index) => index / 10),
            width: 80,
          },
          12,
        ],
        ['scenes.detect', [video.assetId], { threshold: 0.1 }, 0],
        ['video.split', [video.assetId], { boundaries: [1, 2] }, 3],
        ['media.export', [video.assetId], { format: 'webm', height: 72, fps: 8 }, 1],
        ['audio.extract', [video.assetId], { profile: 'asr' }, 1],
        ['audio.waveform', [tone.assetId], { points: 16 }, 0],
        ['audio.remux', [silent.assetId, tone.assetId], { sourceDurationSeconds: 2.1 }, 1],
        [
          'audio.concat',
          [video.assetId, tone.assetId],
          {
            subtitles: [
              { inputIndex: 1, cues: [{ startSeconds: 0, endSeconds: 0.2, text: '第二段' }] },
            ],
          },
          1,
        ],
      ];
      expect(cases.map(([operation]) => operation)).toEqual(MEDIA_CORE_OPERATIONS);
      for (const [operation, inputs, parameters, outputs] of cases) {
        const { job, request } = await submit(operation, inputs, parameters);
        expect(job, operation).toMatchObject({
          status: 'succeeded',
          attempt: 1,
          profile: 'standard-media',
        });
        expect(job.outputs).toHaveLength(outputs);
        const durable = (
          await pool.query<{ attempt_id: string }>(
            'SELECT attempt_id FROM mio_media_jobs WHERE id=$1',
            [job.jobId],
          )
        ).rows[0]!;
        const attempt = journal.media.get(durable.attempt_id)!;
        const prefix = `mio/media/${job.jobId}/${durable.attempt_id}/`;
        const writes = objects.puts.filter((key) => key.startsWith(prefix));
        expect(writes).toHaveLength(outputs + 1);
        expect(writes.at(-1)).toBe(prefix + 'manifest.json');
        const manifest = parseMediaManifest(objects.get(prefix + 'manifest.json').bytes);
        expect(manifest.operation).toBe(operation);
        expect(manifest.files.map((file) => file.name)).toEqual(
          job.outputs.map((output) => output.name),
        );
        for (const [index, output] of job.outputs.entries()) {
          const file = manifest.files[index]!;
          expect(objects.get(file.key)).toMatchObject({
            size: file.sizeBytes,
            sha256: file.sha256,
          });
          const persisted = (
            await pool.query(
              'SELECT raw_key,state,asset_kind FROM mio_assets WHERE id=$1 AND owner_id=$2',
              [output.assetId, actor.userId],
            )
          ).rows[0];
          expect(persisted).toEqual({ raw_key: file.key, state: 'ready', asset_kind: 'derived' });
        }
        if (operation === 'media.probe')
          expect(job.data.probe).toMatchObject({
            width: 160,
            height: 90,
            hasAudio: true,
            videoCodec: 'h264',
          });
        if (operation === 'video.reference_prepare') {
          expect(job.data).toEqual({ compressed: false, trimmed: false });
          expect(Object.keys(attempt.steps)).toEqual(['probe-input-0']);
          expect((await call('', request)).status).toBe(200);
          expect((await call('/' + job.jobId, undefined, 'other')).status).toBe(404);
        }
        if (operation === 'frames.extract')
          expect(job.outputs.map((item) => item.name)).toEqual(
            Array.from({ length: 12 }, (_, index) => `frame-${index}.jpg`),
          );
        if (operation === 'scenes.detect') expect(job.data.scenes).toEqual([1.5]);
        if (operation === 'audio.waveform') {
          expect(job.data.waveform).toHaveLength(16);
          expect(job.data.waveform!.every((value) => value > 0 && value <= 1)).toBe(true);
        }
        if (operation === 'audio.concat')
          expect(job.data.subtitles?.[0]?.startSeconds).toBeCloseTo(3, 1);
        console.info('M2_MEDIA', operation, job.status, outputs);
      }

      for (const [operation, input, parameters] of [
        ['media.probe', invalid, {}],
        ['audio.extract', silent, { profile: 'asr' }],
        ['video.trim', video, { startSeconds: 4, endSeconds: 5 }],
      ] as const) {
        const { job } = await submit(operation, [input.assetId], parameters);
        expect(job).toMatchObject({
          status: 'failed',
          errorCode: 'INPUT_INVALID',
          attempt: 1,
          outputs: [],
        });
      }
      const outsider = await (await call('', undefined, 'other')).json();
      expect(outsider).toEqual({ jobs: [] });
      const unknownOperation = await call('', {
        requestId: randomUUID(),
        operation: 'video.derivatives',
        inputs: [{ assetId: video.assetId }],
        parameters: { profile: 'ordinary' },
      });
      expect(unknownOperation.status).toBe(400);
      expect(await unknownOperation.json()).toMatchObject({
        error: { code: 'MEDIA_OPERATION_UNAVAILABLE' },
      });

      // Force an actual RabbitMQ connection loss while B is waiting on an encode HOLD.
      slots.setHold('encode', 'fixture-unknown-process', true);
      const hold = await call('', {
        requestId: randomUUID(),
        operation: 'video.trim',
        inputs: [{ assetId: video.assetId }],
        parameters: { startSeconds: 0, endSeconds: 1 },
      });
      expect(hold.status).toBe(202);
      const held = (await hold.json()) as Job;
      const attemptId = (
        await pool.query<{ attempt_id: string }>(
          'SELECT attempt_id FROM mio_media_jobs WHERE id=$1',
          [held.jobId],
        )
      ).rows[0]!.attempt_id;
      await vi.waitFor(() => expect(journal!.media.get(attemptId)?.phase).toBe('received'));
      relay.drop();
      const cancelled = await call('/' + held.jobId + '/cancel', {});
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ status: 'cancel_requested', attempt: 1 });
      await vi.waitFor(
        async () => {
          expect(await (await call('/' + held.jobId)).json()).toMatchObject({
            status: 'cancelled',
            attempt: 1,
            outputs: [],
          });
        },
        { timeout: 9_000, interval: 40 },
      );
      expect(journal.media.get(attemptId)).toMatchObject({
        phase: 'cancelled',
        steps: {},
        uploads: {},
      });
      const counts = await pool.query(
        "SELECT count(*)::int AS count FROM mio_media_outbox WHERE job_id=$1 AND command->>'type'='media.request'",
        [held.jobId],
      );
      expect(counts.rows[0]?.count).toBe(1);
      console.info('M2_MEDIA_HOLD', 'disconnect', 'cancelled', 'same attempt');
      expect(runtimeFailure).toBeUndefined();
    } finally {
      stop.abort();
      const closed = await Promise.allSettled([
        runtime,
        service?.close(),
        relay?.close(),
        server?.listening
          ? new Promise<void>((resolve, reject) =>
              server!.close((error) => (error ? reject(error) : resolve())),
            )
          : undefined,
        pool.end(),
      ]);
      try {
        journal?.close();
      } finally {
        try {
          await database.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
      const failed = closed.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
  });
}, 120_000);

it('keeps probe and cancellation moving while the real media encode queue NACKs publication', async () => {
  await withLocalTestBroker(
    async (broker) => {
      const database = await authDatabase();
      const pool = new Pool({ connectionString: database.url });
      const objects = storage();
      const actor = { userId: 'queue-pressure-owner', sessionId: 'queue-pressure-session' };
      const notes: { id: string; outcome: 'confirm' | 'nack' }[] = [];
      const inFlight = new Set<string>();
      const original = ComputeBroker.prototype.publishMedia;
      const publish = vi
        .spyOn(ComputeBroker.prototype, 'publishMedia')
        .mockImplementation(async function (this: ComputeBroker, command) {
          const { messageId } = command;
          expect(inFlight.has(messageId)).toBe(false);
          inFlight.add(messageId);
          try {
            await original.call(this, command);
            notes.push({ id: messageId, outcome: 'confirm' });
          } catch (error) {
            if (error instanceof MediaPublishRejected && error.message === 'message nacked')
              notes.push({ id: messageId, outcome: 'nack' });
            throw error;
          } finally {
            inFlight.delete(messageId);
          }
        });
      let service: ReturnType<typeof createMediaService> | undefined;
      let receiver: Awaited<ReturnType<typeof connect>> | undefined;
      try {
        await pool.query(assetSchemaSQL);
        await pool.query(computeSchemaSQL);
        const encodeQueue = (await broker.queueDefinitions()).find(
          (queue) => queue.name === MEDIA_ENCODE_QUEUE,
        );
        expect(
          encodeQueue?.arguments.some(([key, , value]) => key === 'x-max-length' && value === 1),
        ).toBe(true);
        const assetId = randomUUID();
        const key = `mio/raw/${assetId}/${randomUUID()}`;
        objects.blobs.set(key, Buffer.from('x'));
        await pool.query(
          "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,raw_key,state,expires_at) VALUES($1,$2,'source.mp4','video/mp4',1,$3,'ready',now())",
          [assetId, actor.userId, key],
        );
        service = createMediaService(
          new MediaStore(new Pool({ connectionString: database.url })),
          objects.app,
          {
            brokerURL: broker.appBrokerUrl,
            brokerUser: broker.userA,
            expectedResultUser: broker.userB,
          },
        );
        const active = service;
        const submit = (operation: 'video.trim' | 'media.probe') =>
          active.create(actor, {
            requestId: randomUUID(),
            operation,
            inputs: [{ assetId }],
            parameters: operation === 'video.trim' ? { startSeconds: 0, endSeconds: 1 } : {},
          });
        const outbox = async (jobId: string, action: 'request' | 'cancel' = 'request') =>
          (
            await pool.query<{ id: string; sent_at: Date | null }>(
              `SELECT id,sent_at FROM mio_media_outbox WHERE job_id=$1 AND
           CASE WHEN $2='request' THEN command->>'type'='media.request' ELSE command->>'action'=$2 END`,
              [jobId, action],
            )
          ).rows[0]!;
        const earlierEncodes: string[] = [];
        let blocked: { jobId: string; commandId: string } | undefined;
        // A quorum publisher can admit one more delivery before it observes the queue limit.
        // Require a real NACK without assuming that the second delivery is always rejected.
        for (let n = 0; n < 5 && !blocked; n++) {
          const { jobId } = (await submit('video.trim')).job;
          const commandId = (await outbox(jobId)).id;
          await vi.waitFor(() => expect(notes.some((entry) => entry.id === commandId)).toBe(true));
          if (notes.some((entry) => entry.id === commandId && entry.outcome === 'nack')) {
            blocked = { jobId, commandId };
          } else {
            await vi.waitFor(async () =>
              expect((await outbox(jobId)).sent_at).toBeInstanceOf(Date),
            );
            earlierEncodes.push(commandId);
          }
        }
        if (!blocked) throw new Error('ENCODE_QUEUE_NEVER_NACKED');
        expect(earlierEncodes.length).toBeGreaterThan(0);
        const { jobId: blockedJob, commandId: secondMessage } = blocked;
        const probe = (await submit('media.probe')).job;
        await active.cancel(actor, blockedJob);
        const controlMessage = (await outbox(blockedJob, 'cancel')).id;
        const probeMessage = (await outbox(probe.jobId)).id;
        await vi.waitFor(
          async () => {
            expect((await outbox(blockedJob, 'cancel')).sent_at).toBeInstanceOf(Date);
            expect((await outbox(probe.jobId)).sent_at).toBeInstanceOf(Date);
            expect(
              notes.filter((entry) => entry.id === secondMessage && entry.outcome === 'nack')
                .length,
            ).toBeGreaterThanOrEqual(2);
          },
          { timeout: 5_000, interval: 30 },
        );
        expect(await outbox(blockedJob)).toEqual({ id: secondMessage, sent_at: null });
        expect(notes).toContainEqual({ id: controlMessage, outcome: 'confirm' });
        expect(notes).toContainEqual({ id: probeMessage, outcome: 'confirm' });

        receiver = await connect(broker.workerBrokerUrl, { timeout: 5000 });
        const channel = await receiver.createChannel();
        for (const [queue, id] of [
          [MEDIA_CONTROL_QUEUE, controlMessage],
          [MEDIA_PROBE_QUEUE, probeMessage],
          ...earlierEncodes.map((id) => [MEDIA_ENCODE_QUEUE, id] as const),
        ] as const) {
          const delivery = await channel.get(queue, { noAck: false });
          if (!delivery) throw new Error('COMMAND_NOT_VISIBLE');
          expect(delivery.properties.messageId).toBe(id);
          expect(delivery.properties.userId).toBe(broker.userA);
          channel.ack(delivery);
        }
        await vi.waitFor(
          async () => expect((await outbox(blockedJob)).sent_at).toBeInstanceOf(Date),
          { timeout: 5_000, interval: 30 },
        );
        const retried = await channel.get(MEDIA_ENCODE_QUEUE, { noAck: false });
        if (!retried) throw new Error('RETRY_NOT_VISIBLE');
        expect(retried.properties.messageId).toBe(secondMessage);
        channel.ack(retried);
        expect(await channel.get(MEDIA_ENCODE_QUEUE)).toBe(false);
        expect(notes.at(-1)).toEqual({ id: secondMessage, outcome: 'confirm' });
        expect(inFlight.size).toBe(0);
        process.stdout.write(
          `M2_MEDIA_OUTBOX ${JSON.stringify({
            attempts: notes,
            controlMessage,
            probeMessage,
            recoveredEncode: secondMessage,
          })}\n`,
        );
        await channel.close();
      } finally {
        publish.mockRestore();
        try {
          await Promise.all([receiver?.close(), service?.close(), pool.end()]);
        } finally {
          await database.close();
        }
      }
    },
    undefined,
    { singleMessageMediaEncode: true },
  );
}, 90_000);
