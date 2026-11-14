import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import type { ImageCommandV1, ImageRecoveryCommandV1, ImageResultV1 } from '@mio/compute-contracts';
import { parseImageCommand, parseImageRecovery, parseImageResult } from '@mio/compute-contracts';
import { createComputeService } from '../../src/compute/service.ts';
import { createComputeHandler } from '../../src/compute/http.ts';
import { ComputeStore, createComputeStore } from '../../src/compute/store.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { Journal } from '../../compute/src/adapters/journal.ts';
import { sealImageKey } from '../../src/compute/image-credentials.ts';
import { createImageWorker, recoverImageMaterialization } from '../../compute/src/image-worker.ts';
import type { ProviderService } from '../../src/providers/service.ts';
import { ProviderError } from '../../src/providers/contracts.ts';
import { authDatabase } from '../support/auth-database.ts';

const bus = vi.hoisted(() => ({
  receive: undefined as undefined | ((r: ImageResultV1) => Promise<void>),
  execute: undefined as undefined | ((c: ImageCommandV1 | ImageRecoveryCommandV1) => Promise<void>),
}));
vi.mock('../../src/integrations/rabbitmq.ts', () => ({
  ComputeBroker: {
    connect: async () => ({
      onClose() {},
      async close() {},
      async consume(_handle: unknown, _failed: unknown, images: typeof bus.receive) {
        bus.receive = images;
      },
      async publish(command: ImageCommandV1 | ImageRecoveryCommandV1) {
        const value = JSON.parse(JSON.stringify(command));
        await bus.execute!(
          command.type === 'image.recover' ? parseImageRecovery(value) : parseImageCommand(value),
        );
      },
    }),
  },
}));

function imageKey(
  jobId: string,
  index: number,
  format: string,
  fileId = '00000000-0000-4000-8000-000000000000',
) {
  return `mio/derived/${jobId}/images/${index}-${fileId}.${format}`;
}

it('runs HTTP admission through PG outbox, B journal and result to owned asset; duplicates and unknown never repost', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  const directory = mkdtempSync(join(tmpdir(), 'mio-image-http-'));
  const journal = new Journal(directory, randomUUID(), true);
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const objects = new Map<string, { size: number; etag: string; sha256: string }>();
  const failures = new Map<string, number>();
  let objectOffline = false;
  const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
    const input = JSON.parse(String(options?.body));
    if (input.prompt === 'unknown') throw new Error('connection lost');
    return Response.json({ data: [{ b64_json: 'YWJj' }] });
  });
  const materialize = async (
    job: string,
    index: number,
    base64: string,
    format: string,
    fileId: string,
  ) => {
    const remaining = failures.get(job) ?? 0;
    if (remaining) {
      failures.set(job, remaining - 1);
      throw new Error('storage offline');
    }
    const bytes = Buffer.from(base64, 'base64');
    const key = imageKey(job, index, format, fileId);
    const meta = {
      size: bytes.length,
      etag: 'etag',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    objects.set(key, meta);
    return {
      key,
      sizeBytes: meta.size,
      etag: meta.etag,
      sha256: meta.sha256,
      contentType: `image/${format}`,
    };
  };
  const worker = createImageWorker(journal, 'b1', keys.privateKey, materialize, transport);
  bus.execute = async (command) => {
    if (command.type === 'image.request' && command.input.prompt === 'recover')
      failures.set(command.jobId, 3);
    const send = async (result: Awaited<ReturnType<typeof worker>>) => {
      const message = parseImageResult({
        version: 1,
        type: 'image.result',
        messageId: randomUUID(),
        commandId: command.type === 'image.recover' ? command.commandId : command.messageId,
        jobId: command.jobId,
        state: result.state,
        outputs: 'outputs' in result ? result.outputs : [],
        ...('errorCode' in result ? { errorCode: result.errorCode } : {}),
        ...(command.type === 'image.recover' ? { recoveryId: command.messageId } : {}),
      });
      await bus.receive!(message);
      await bus.receive!({ ...message, messageId: randomUUID() });
    };
    if (command.type === 'image.recover') {
      const result = await recoverImageMaterialization(
        journal,
        command.jobId,
        command.commandId,
        command.sequence,
        materialize,
      );
      await send(result.outcome);
      await recoverImageMaterialization(
        journal,
        command.jobId,
        command.commandId,
        command.sequence,
        materialize,
      );
    } else {
      let result = await worker(command);
      while (result.state === 'materializing') {
        await send(result);
        result = await worker(command);
      }
      await send(result);
      await worker(command);
    }
  };
  await pool.query(assetSchemaSQL);
  await pool.query(computeSchemaSQL);
  const store = new ComputeStore(pool, true);
  expect(() =>
    createComputeService(
      store,
      {} as never,
      { brokerURL: 'amqp://localhost', brokerUser: 'a', expectedResultUser: 'b' },
      { keyId: 'x'.repeat(8193), publicKey: keys.publicKey, provider: () => undefined },
    ),
  ).toThrow('IMAGE_CONFIG');
  expect(Number((await pool.query('SELECT count(*) FROM mio_image_jobs')).rows[0].count)).toBe(0);
  const service = createComputeService(
    store,
    {
      head: async (key) => {
        if (objectOffline) throw new Error('temporary outage');
        return objects.get(key)!;
      },
      uploadUrl: () => '',
      downloadUrl: () => '',
      copy: async () => {},
      delete: async () => {},
    },
    { brokerURL: 'amqp://localhost', brokerUser: 'a', expectedResultUser: 'b' },
    {
      keyId: 'b1',
      publicKey: keys.publicKey,
      provider: () =>
        ({
          resolveImage: async (_actor: unknown, modelRef: string) => {
            if (modelRef === 'unadapted') throw new ProviderError(409, 'ADAPTER_PENDING');
            return {
              modelId: modelRef === 'seed' ? 'doubao-seedream-4.0' : 'gpt-image-2',
              profile: modelRef === 'seed' ? 'seedream-4-images-v1' : 'gpt-images-v1',
              apiKey: 'secret',
              providerConfigId: randomUUID(),
              credentialVersion: 1,
              catalogVersion: 1,
              adaptationVersion: 1,
            };
          },
        }) as unknown as ProviderService,
    },
  );
  let origin = '';
  const server = createServer(
    (req, res) =>
      void createComputeHandler(
        service,
        async (headers) => {
          const owner = headers.get('cookie');
          return owner === 'owner' || owner === 'other'
            ? { userId: owner, sessionId: owner }
            : null;
        },
        [origin],
      )(req, res),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error();
  origin = `http://127.0.0.1:${address.port}`;
  const call = (path: string, body?: unknown, cookie = 'owner') =>
    fetch(`${origin}/api/v1/compute/images${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { origin, cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    const request = {
      requestId: randomUUID(),
      modelRef: 'model-ref',
      parameters: { prompt: 'square', quality: 'low' },
    };
    expect((await call('', request, '')).status).toBe(401);
    const unsupported = await call('', { ...request, modelRef: 'unadapted' });
    expect(unsupported.status).toBe(409);
    expect(JSON.stringify(await unsupported.json())).toContain('ADAPTER_PENDING');
    expect(transport).not.toHaveBeenCalled();
    for (const parameters of [
      { prompt: 'seed', n: 2 },
      { prompt: 'seed', quality: 'low' },
      { prompt: 'seed', output_format: 'png' },
      { prompt: 'seed', size: '2048x2048' },
    ])
      expect(
        (await call('', { requestId: randomUUID(), modelRef: 'seed', parameters })).status,
      ).toBe(400);
    expect(Number((await pool.query('SELECT count(*) FROM mio_image_jobs')).rows[0].count)).toBe(0);
    await vi.waitFor(() => expect(bus.receive).toBeDefined());
    const foreignJob = randomUUID();
    const foreignKey = imageKey(foreignJob, 0, 'png');
    const invalid: ImageResultV1 = {
      version: 1,
      type: 'image.result',
      messageId: randomUUID(),
      commandId: randomUUID(),
      jobId: foreignJob,
      state: 'completed',
      outputs: [
        {
          key: foreignKey,
          sizeBytes: 3,
          etag: 'etag',
          sha256: 'a'.repeat(64),
          contentType: 'image/png',
        },
      ],
    };
    objects.set(foreignKey, { size: 4, etag: 'etag', sha256: 'a'.repeat(64) });
    await expect(bus.receive!(invalid)).rejects.toMatchObject({
      permanent: true,
      message: 'IMAGE_OBJECT_MISMATCH',
    });
    objectOffline = true;
    await expect(bus.receive!(invalid)).rejects.not.toHaveProperty('permanent');
    objectOffline = false;
    objects.set(foreignKey, { size: 3, etag: 'etag', sha256: 'a'.repeat(64) });
    await expect(bus.receive!(invalid)).rejects.toMatchObject({
      permanent: true,
      code: 'RESULT_CONFLICT',
    });
    expect(Number((await pool.query('SELECT count(*) FROM mio_assets')).rows[0].count)).toBe(0);
    const oversized = {
      ...request,
      requestId: randomUUID(),
      parameters: { prompt: '\u0001'.repeat(26600) },
    };
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(160_000);
    expect((await call('', oversized)).status).toBe(400);
    expect(Number((await pool.query('SELECT count(*) FROM mio_image_jobs')).rows[0].count)).toBe(0);
    const response = await call('', request);
    expect(response.status).toBe(202);
    const job = await response.json();
    expect((await (await call('', request)).json()).jobId).toBe(job.jobId);
    expect((await call('', { ...request, parameters: { prompt: 'changed' } })).status).toBe(409);
    expect((await call(`/${job.jobId}`, undefined, 'other')).status).toBe(404);
    await vi.waitFor(
      async () => expect((await (await call(`/${job.jobId}`)).json()).status).toBe('completed'),
      { timeout: 5000 },
    );
    const view = await (await call(`/${job.jobId}`)).json();
    expect(view.assetIds).toHaveLength(1);
    expect(
      (await pool.query('SELECT owner_id FROM mio_assets WHERE id=$1', [view.assetIds[0]])).rows[0]
        ?.owner_id,
    ).toBe('owner');
    expect(transport).toHaveBeenCalledTimes(1);
    const partial = await (
      await call('', {
        ...request,
        requestId: randomUUID(),
        parameters: { prompt: 'partial', n: 2 },
      })
    ).json();
    await vi.waitFor(
      async () => expect((await (await call(`/${partial.jobId}`)).json()).status).toBe('partial'),
      { timeout: 5000 },
    );
    const partialView = await (await call(`/${partial.jobId}`)).json();
    expect(partialView.requestedCount).toBe(2);
    expect(partialView.assetIds).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(2);
    const recover = await (
      await call('', { ...request, requestId: randomUUID(), parameters: { prompt: 'recover' } })
    ).json();
    await vi.waitFor(
      async () =>
        expect((await (await call(`/${recover.jobId}`)).json()).status).toBe(
          'materialization_failed',
        ),
      { timeout: 5000 },
    );
    expect((await call(`/${recover.jobId}/recover`, {}, 'other')).status).toBe(404);
    expect((await call(`/${recover.jobId}/recover`, {})).status).toBe(202);
    await vi.waitFor(
      async () => expect((await (await call(`/${recover.jobId}`)).json()).status).toBe('completed'),
      { timeout: 5000 },
    );
    expect(transport).toHaveBeenCalledTimes(3);
    const unknown = await (
      await call('', { ...request, requestId: randomUUID(), parameters: { prompt: 'unknown' } })
    ).json();
    await vi.waitFor(
      async () => expect((await (await call(`/${unknown.jobId}`)).json()).status).toBe('unknown'),
      { timeout: 5000 },
    );
    expect(transport).toHaveBeenCalledTimes(4);
    const seedRequest = {
      requestId: randomUUID(),
      modelRef: 'seed',
      parameters: { prompt: 'seed', n: 1, size: '1024x1024' },
    };
    const seedResponse = await call('', seedRequest);
    expect(seedResponse.status).toBe(202);
    const seed = await seedResponse.json();
    await vi.waitFor(
      async () => expect((await (await call(`/${seed.jobId}`)).json()).status).toBe('completed'),
      { timeout: 5000 },
    );
    const record = await pool.query<{ profile: string; raw_key: string; content_type: string }>(
      `SELECT j.admitted->>'profile' AS profile,a.raw_key,a.content_type
       FROM mio_image_jobs j JOIN mio_image_outputs o ON o.job_id=j.id
       JOIN mio_assets a ON a.id=o.asset_id WHERE j.id=$1`,
      [seed.jobId],
    );
    expect(record.rows[0]).toMatchObject({
      profile: 'seedream-4-images-v1',
      content_type: 'image/jpeg',
    });
    expect(record.rows[0]?.raw_key).toMatch(
      new RegExp(`^mio/derived/${seed.jobId}/images/0-[0-9a-f-]{36}\\.jpeg$`),
    );
    expect((await (await call('', seedRequest)).json()).jobId).toBe(seed.jobId);
    expect(transport).toHaveBeenCalledTimes(5);
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    journal.close();
    rmSync(directory, { recursive: true });
    await database.close();
  }
}, 15000);

it('continues a previously admitted image and allows output recovery after new image admission is disabled', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(computeSchemaSQL);
  const store = await createComputeStore(database.url);
  expect(store.imagesAvailable).toBe(true);
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const jobId = randomUUID();
  const command: ImageCommandV1 = {
    version: 1,
    type: 'image.request',
    profile: 'gpt-images-v1',
    messageId: randomUUID(),
    jobId,
    ownerId: 'owner',
    expiresAt: Date.now() + 60000,
    input: { model: 'gpt-image-2', prompt: 'previously admitted' },
    credential: sealImageKey('key', 'binding', 'b1', keys.publicKey),
  };
  const requestId = randomUUID();
  const hash = createHash('sha256')
    .update(JSON.stringify(['model', { prompt: 'previously admitted' }]))
    .digest('hex');
  await store.imageCreate('owner', requestId, hash, command);
  const sent: (ImageCommandV1 | ImageRecoveryCommandV1)[] = [];
  bus.execute = async (value) => {
    sent.push(value);
  };
  bus.receive = undefined;
  const key = imageKey(jobId, 0, 'png');
  const meta = { size: 3, etag: 'etag', sha256: 'a'.repeat(64) };
  const service = createComputeService(
    store,
    {
      head: async () => meta,
      uploadUrl: () => '',
      downloadUrl: () => '',
      copy: async () => {},
      delete: async () => {},
    },
    { brokerURL: 'amqp://localhost', brokerUser: 'a', expectedResultUser: 'b' },
  );
  try {
    const actor = { userId: 'owner', sessionId: 'session' };
    expect(
      (await service.createImage(actor, requestId, 'model', { prompt: 'previously admitted' }))
        .jobId,
    ).toBe(jobId);
    await expect(
      service.createImage(actor, requestId, 'model', { prompt: 'different' }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.createImage({ userId: 'owner', sessionId: 'session' }, randomUUID(), 'model', {
        prompt: 'new',
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 4000 });
    expect(sent[0]).toEqual(command);
    await bus.receive!({
      version: 1,
      type: 'image.result',
      messageId: randomUUID(),
      commandId: command.messageId,
      jobId,
      state: 'materialization_failed',
      outputs: [],
    });
    expect((await store.imageGet('owner', jobId)).status).toBe('materialization_failed');
    await service.recoverImage({ userId: 'owner', sessionId: 'session' }, jobId);
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 4000 });
    const recovery = sent[1]!;
    expect(recovery.type).toBe('image.recover');
    expect(JSON.stringify(recovery)).not.toContain('credential');
    await bus.receive!({
      version: 1,
      type: 'image.result',
      messageId: randomUUID(),
      commandId: command.messageId,
      jobId,
      recoveryId: recovery.messageId,
      state: 'completed',
      outputs: [{ key, sizeBytes: 3, etag: 'etag', sha256: meta.sha256, contentType: 'image/png' }],
    });
    expect((await store.imageGet('owner', jobId)).status).toBe('completed');
  } finally {
    await service.close();
    await pool.end();
    await database.close();
  }
}, 15000);
