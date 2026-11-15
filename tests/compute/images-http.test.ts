import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import type {
  ImageCommandV1,
  ImageQueryCommandV1,
  ImageRecoveryCommandV1,
  ImageResultV1,
} from '@mio/compute-contracts';
import {
  parseImageCommand,
  parseImageQuery,
  parseImageRecovery,
  parseImageResult,
} from '@mio/compute-contracts';
import { createComputeService } from '../../src/compute/service.ts';
import { createComputeHandler } from '../../src/compute/http.ts';
import { ComputeStore, createComputeStore } from '../../src/compute/store.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { Journal } from '../../compute/src/adapters/journal.ts';
import { sealImageKey } from '../../src/compute/image-credentials.ts';
import { createImageWorker, recoverImageMaterialization } from '../../compute/src/image-worker.ts';
import type { AsyncImageTransport } from '../../compute/src/images.ts';
import type { ProviderService } from '../../src/providers/service.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { ProviderError } from '../../src/providers/contracts.ts';
import { authDatabase } from '../support/auth-database.ts';

const bus = vi.hoisted(() => ({
  receive: undefined as undefined | ((r: ImageResultV1) => Promise<void>),
  execute: undefined as
    | undefined
    | ((c: ImageCommandV1 | ImageQueryCommandV1 | ImageRecoveryCommandV1) => Promise<void>),
}));
vi.mock('../../src/integrations/rabbitmq.ts', () => ({
  ComputeBroker: {
    connect: async () => ({
      onClose() {},
      async close() {},
      async consume(_handle: unknown, _failed: unknown, images: typeof bus.receive) {
        bus.receive = images;
      },
      async publish(command: ImageCommandV1 | ImageQueryCommandV1 | ImageRecoveryCommandV1) {
        const value = JSON.parse(JSON.stringify(command));
        await bus.execute!(
          command.type === 'image.recover'
            ? parseImageRecovery(value)
            : command.type === 'image.query'
              ? parseImageQuery(value)
              : parseImageCommand(value),
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
  const head = vi.fn(async (key: string) => {
    if (objectOffline) throw new Error('temporary outage');
    return objects.get(key)!;
  });
  const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
    const input =
      options?.body instanceof FormData
        ? { prompt: String((await new Response(options.body).formData()).get('prompt')) }
        : JSON.parse(String(options?.body));
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
  const readImage = vi.fn(async () => Uint8Array.from(Buffer.from('89504e470d0a1a0a', 'hex')));
  let currentTaskKey: string | undefined = 'secret';
  const asyncTransport = {
    submit: vi.fn<AsyncImageTransport['submit']>().mockResolvedValue({
      state: 'submitted',
      upstreamTaskId: 'http-async-1',
    }),
    query: vi.fn(async (_input, _key, taskId: string, attempt: number) =>
      attempt === 1
        ? { state: 'processing' as const, upstreamTaskId: taskId }
        : { state: 'returned' as const, upstreamTaskId: taskId, images: [{ base64: 'YWJj' }] },
    ),
  };
  const worker = createImageWorker(
    journal,
    'b1',
    keys.privateKey,
    materialize,
    transport,
    readImage,
    asyncTransport,
  );
  bus.execute = async (command) => {
    if (command.type === 'image.request' && command.input.prompt === 'recover')
      failures.set(command.jobId, 3);
    const send = async (result: Awaited<ReturnType<typeof worker>>) => {
      const message = parseImageResult({
        version: 1,
        type: 'image.result',
        messageId: randomUUID(),
        commandId:
          command.type === 'image.recover' || command.type === 'image.query'
            ? command.commandId
            : command.messageId,
        jobId: command.jobId,
        state: result.state,
        outputs: 'outputs' in result ? result.outputs : [],
        ...('errorCode' in result ? { errorCode: result.errorCode } : {}),
        ...('upstreamTaskId' in result ? { upstreamTaskId: result.upstreamTaskId } : {}),
        ...('queryAttempt' in result ? { queryAttempt: result.queryAttempt } : {}),
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
      head,
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
          resolveImageTaskCredential: async (ownerId: string) => {
            if (ownerId !== 'owner' || !currentTaskKey) throw new Error('credential unavailable');
            return currentTaskKey;
          },
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
              capabilityMetadata: {
                image: {
                  modes: ['generate', 'edit', 'outpaint'],
                  mask: { format: 'png' },
                  ...(modelRef === 'no-async'
                    ? {}
                    : { async: { operations: ['generate'], maxQueries: 4, maxAgeSeconds: 300 } }),
                  ...(modelRef === 'no-references' ? {} : { references: { maxImages: 4 } }),
                  geometry: { unit: 'pixels', edges: ['left', 'top', 'right', 'bottom'] },
                },
              },
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
    const imageAssetId = randomUUID();
    const secondImageAssetId = randomUUID();
    const maskAssetId = randomUUID();
    const sourceKey = `mio/raw/${imageAssetId}/${randomUUID()}`;
    const secondSourceKey = `mio/raw/${secondImageAssetId}/${randomUUID()}`;
    const maskKey = `mio/raw/${maskAssetId}/${randomUUID()}`;
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
    await pool.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at,staging_deleted_at,asset_kind)
       VALUES($1,'owner','source.png','image/png',8,$2,$3,'ready',now(),now(),'original'),
             ($4,'owner','second.png','image/png',8,$5,$6,'ready',now(),now(),'original'),
             ($7,'owner','mask.png','image/png',8,$8,$9,'ready',now(),now(),'original')`,
      [
        imageAssetId,
        `mio/staging/${imageAssetId}`,
        sourceKey,
        secondImageAssetId,
        `mio/staging/${secondImageAssetId}`,
        secondSourceKey,
        maskAssetId,
        `mio/staging/${maskAssetId}`,
        maskKey,
      ],
    );
    objects.set(sourceKey, { size: 8, etag: 'image-etag', sha256: 'a'.repeat(64) });
    objects.set(secondSourceKey, { size: 8, etag: 'second-etag', sha256: 'c'.repeat(64) });
    objects.set(maskKey, { size: 8, etag: 'mask-etag', sha256: 'b'.repeat(64) });
    const headBeforeRejectedInputs = head.mock.calls.length;
    const editGeometryResponse = await call('', {
      requestId: randomUUID(),
      modelRef: 'model-ref',
      parameters: {
        prompt: 'edit geometry is invalid',
        operation: 'edit',
        imageAssetIds: [imageAssetId],
        geometry: { left: 16, top: 0, right: 0, bottom: 16 },
      },
    });
    expect(editGeometryResponse.status).toBe(400);
    expect(head).toHaveBeenCalledTimes(headBeforeRejectedInputs);
    const invalidMaskResponse = await call('', {
      requestId: randomUUID(),
      modelRef: 'model-ref',
      parameters: {
        prompt: 'empty mask is invalid',
        operation: 'edit',
        imageAssetId,
        maskAssetId: '',
      },
    });
    expect(invalidMaskResponse.status).toBe(400);
    expect(head).toHaveBeenCalledTimes(headBeforeRejectedInputs);
    const missingReferencesResponse = await call('', {
      requestId: randomUUID(),
      modelRef: 'no-references',
      parameters: {
        prompt: 'references capability required',
        operation: 'edit',
        imageAssetIds: [imageAssetId, secondImageAssetId],
      },
    });
    expect(missingReferencesResponse.status).toBe(409);
    expect(head).toHaveBeenCalledTimes(headBeforeRejectedInputs);
    const tooManyReferencesResponse = await call('', {
      requestId: randomUUID(),
      modelRef: 'model-ref',
      parameters: {
        prompt: 'references maxImages gate',
        operation: 'edit',
        imageAssetIds: Array.from({ length: 5 }, () => randomUUID()),
      },
    });
    expect(tooManyReferencesResponse.status).toBe(409);
    expect(head).toHaveBeenCalledTimes(headBeforeRejectedInputs);
    const editRequest = {
      requestId: randomUUID(),
      modelRef: 'model-ref',
      parameters: {
        prompt: 'edit',
        operation: 'edit',
        imageAssetId,
        maskAssetId,
      },
    };
    expect((await call('', editRequest, 'other')).status).toBe(404);
    const editResponse = await call('', editRequest);
    expect(editResponse.status).toBe(202);
    const edit = await editResponse.json();
    await vi.waitFor(
      async () => expect((await (await call(`/${edit.jobId}`)).json()).status).toBe('completed'),
      { timeout: 5000 },
    );
    expect(readImage).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(5);
    const multiRequest = {
      requestId: randomUUID(),
      modelRef: 'model-ref',
      parameters: {
        prompt: 'multi',
        operation: 'edit',
        imageAssetIds: [imageAssetId, secondImageAssetId],
      },
    };
    const multiResponse = await call('', multiRequest);
    expect(multiResponse.status).toBe(202);
    const multi = await multiResponse.json();
    await vi.waitFor(
      async () => expect((await (await call(`/${multi.jobId}`)).json()).status).toBe('completed'),
      { timeout: 5000 },
    );
    const multiForm = await new Response(transport.mock.calls[5]?.[1]?.body).formData();
    expect(multiForm.getAll('image')).toHaveLength(2);
    expect(readImage).toHaveBeenCalledTimes(4);
    expect(transport).toHaveBeenCalledTimes(6);
    const outpaintRequest = {
      requestId: randomUUID(),
      modelRef: 'model-ref',
      parameters: {
        prompt: 'outpaint',
        operation: 'outpaint',
        imageAssetIds: [imageAssetId],
        geometry: { left: 16, top: 0, right: 0, bottom: 16 },
      },
    };
    const outpaintResponse = await call('', outpaintRequest);
    expect(outpaintResponse.status).toBe(202);
    const outpaint = await outpaintResponse.json();
    await vi.waitFor(
      async () =>
        expect((await (await call(`/${outpaint.jobId}`)).json()).status).toBe('completed'),
      { timeout: 5000 },
    );
    const outpaintForm = await new Response(transport.mock.calls[6]?.[1]?.body).formData();
    expect(JSON.parse(String(outpaintForm.get('geometry')))).toEqual({
      left: 16,
      top: 0,
      right: 0,
      bottom: 16,
    });
    expect(transport).toHaveBeenCalledTimes(7);
    const asyncRequest = {
      requestId: randomUUID(),
      modelRef: 'model-ref',
      parameters: { prompt: 'async', async: true },
    };
    const unsupportedAsync = await call('', {
      ...asyncRequest,
      requestId: randomUUID(),
      modelRef: 'no-async',
    });
    expect(unsupportedAsync.status).toBe(409);
    expect(asyncTransport.submit).not.toHaveBeenCalled();
    const asyncResponse = await call('', asyncRequest);
    expect(asyncResponse.status).toBe(202);
    const asyncJob = await asyncResponse.json();
    currentTaskKey = 'rotated-secret';
    await vi.waitFor(
      async () => {
        const scheduled = await pool.query<{ query_attempt: number; next_query_at: Date | null }>(
          'SELECT query_attempt,next_query_at FROM mio_image_jobs WHERE id=$1',
          [asyncJob.jobId],
        );
        expect(scheduled.rows[0]?.query_attempt).toBe(2);
        expect(scheduled.rows[0]?.next_query_at?.getTime()).toBeGreaterThan(Date.now());
      },
      { timeout: 5000 },
    );
    expect(asyncTransport.submit.mock.calls[0]?.[1]).toBe('secret');
    expect(asyncTransport.query.mock.calls[0]?.[1]).toBe('rotated-secret');
    currentTaskKey = undefined;
    // Exercise the next scheduled step without making the test wait for its real deadline slot.
    await pool.query('UPDATE mio_image_jobs SET next_query_at=now() WHERE id=$1', [asyncJob.jobId]);
    await vi.waitFor(
      async () =>
        expect(await (await call(`/${asyncJob.jobId}`)).json()).toMatchObject({
          status: 'failed',
          errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE',
        }),
      { timeout: 5000 },
    );
    expect(asyncTransport.query).toHaveBeenCalledOnce();
    expect((await call(`/${asyncJob.jobId}`, undefined, 'other')).status).toBe(404);
    expect((await call(`/${asyncJob.jobId}/recover`, {}, 'other')).status).toBe(404);
    currentTaskKey = 'restored-secret';
    expect((await call(`/${asyncJob.jobId}/recover`, {})).status).toBe(202);
    await vi.waitFor(
      async () =>
        expect((await (await call(`/${asyncJob.jobId}`)).json()).status).toBe('completed'),
      { timeout: 5000 },
    );
    expect(asyncTransport.submit).toHaveBeenCalledOnce();
    expect(asyncTransport.query).toHaveBeenCalledTimes(2);
    expect(asyncTransport.query.mock.calls[1]?.[1]).toBe('restored-secret');
    expect(JSON.stringify(await (await call(`/${asyncJob.jobId}`)).json())).not.toContain(
      'http-async-1',
    );
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
    expect(transport).toHaveBeenCalledTimes(8);
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    journal.close();
    rmSync(directory, { recursive: true });
    await database.close();
  }
}, 15000);

it('distributes pending async queries and retains the new schedule when an older send settles', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(computeSchemaSQL);
  const store = new ComputeStore(pool, true);
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
    expiresAt: Date.now() + 600_000,
    input: { model: 'gpt-image-2', prompt: 'scheduled', async: true },
    credential: sealImageKey('key', 'binding', 'b1', keys.publicKey),
  };
  try {
    await store.imageCreate('owner', randomUUID(), 'hash', command, {
      async: { operations: ['generate'], maxQueries: 8, maxAgeSeconds: 600 },
    });
    expect((await store.imagePending())?.messageId).toBe(command.messageId);
    await store.imageAccept({
      version: 1,
      type: 'image.result',
      messageId: randomUUID(),
      commandId: command.messageId,
      jobId,
      state: 'submitted',
      outputs: [],
      upstreamTaskId: 'known-upstream',
      queryAttempt: 0,
    });
    // A late confirmation for the submission must not erase the new query's schedule.
    await store.imageSent(jobId, command.messageId);
    let outbox = await pool.query<{ sent_at: Date | null; next_query_at: Date | null }>(
      'SELECT o.sent_at,j.next_query_at FROM mio_image_outbox o JOIN mio_image_jobs j ON j.id=o.job_id WHERE j.id=$1',
      [jobId],
    );
    expect(outbox.rows[0]?.sent_at).toBeNull();
    expect(outbox.rows[0]?.next_query_at).not.toBeNull();
    await pool.query('UPDATE mio_image_jobs SET next_query_at=now() WHERE id=$1', [jobId]);
    const first = (await store.imagePending()) as ImageQueryCommandV1;
    expect(first.queryAttempt).toBe(1);
    await store.imageAccept({
      version: 1,
      type: 'image.result',
      messageId: randomUUID(),
      commandId: command.messageId,
      jobId,
      state: 'processing',
      outputs: [],
      upstreamTaskId: 'known-upstream',
      queryAttempt: 1,
    });
    await store.imageSent(jobId, first.messageId);
    const scheduled = await pool.query<{
      seconds_until: number;
      fraction: number;
      before_deadline: boolean;
      query_attempt: number;
    }>(
      `SELECT EXTRACT(EPOCH FROM (next_query_at-now()))::float8 AS seconds_until,
        EXTRACT(EPOCH FROM (next_query_at-now())) /
          EXTRACT(EPOCH FROM (LEAST(async_deadline,to_timestamp((command->>'expiresAt')::double precision/1000))-now())) AS fraction,
        next_query_at<async_deadline AND next_query_at<to_timestamp((command->>'expiresAt')::double precision/1000) AS before_deadline,
        query_attempt FROM mio_image_jobs WHERE id=$1`,
      [jobId],
    );
    expect(scheduled.rows[0]!.seconds_until).toBeGreaterThan(70);
    expect(Number(scheduled.rows[0]!.fraction)).toBeCloseTo(1 / 8, 2);
    expect(scheduled.rows[0]).toMatchObject({ before_deadline: true, query_attempt: 2 });
    expect(await store.imagePending()).toBeUndefined();
    outbox = await pool.query(
      'SELECT o.sent_at,j.next_query_at FROM mio_image_outbox o JOIN mio_image_jobs j ON j.id=o.job_id WHERE j.id=$1',
      [jobId],
    );
    expect(outbox.rows[0]?.sent_at).toBeNull();
    expect(outbox.rows[0]?.next_query_at).not.toBeNull();
    const next = await pool.query<{ query_command: ImageQueryCommandV1; deadline: string }>(
      `SELECT o.query_command,
        floor(extract(epoch FROM LEAST(j.async_deadline,to_timestamp((j.command->>'expiresAt')::double precision/1000)))*1000)::bigint AS deadline
       FROM mio_image_outbox o JOIN mio_image_jobs j ON j.id=o.job_id WHERE j.id=$1`,
      [jobId],
    );
    const deadline = Number(next.rows[0]!.deadline);
    const firstEnvelope = sealImageKey('current-key', 'binding', 'b1', keys.publicKey);
    const rotatedEnvelope = sealImageKey('later-key', 'binding', 'b1', keys.publicKey);
    expect(
      await store.imagePrepareQuery(jobId, first.messageId, deadline, firstEnvelope),
    ).toBeUndefined();
    const prepared = await store.imagePrepareQuery(
      jobId,
      next.rows[0]!.query_command.messageId,
      deadline,
      firstEnvelope,
    );
    expect(prepared?.queryCredential).toEqual(firstEnvelope);
    expect(prepared?.queryDeadline).toBe(deadline);
    expect(
      await store.imagePrepareQuery(
        jobId,
        next.rows[0]!.query_command.messageId,
        deadline,
        rotatedEnvelope,
      ),
    ).toEqual(prepared);
    await store.imageQueryUnavailable(jobId, first.messageId, 'IMAGE_CREDENTIAL_UNAVAILABLE');
    const durable = await pool.query<{ query_command: ImageQueryCommandV1; sent_at: Date | null }>(
      'SELECT query_command,sent_at FROM mio_image_outbox WHERE job_id=$1',
      [jobId],
    );
    expect(durable.rows[0]).toMatchObject({ query_command: prepared, sent_at: null });
    expect(JSON.stringify(await store.imageGet('owner', jobId))).not.toContain('queryCredential');
    const locked = await pool.connect();
    let lockedTransaction = false;
    try {
      await locked.query('BEGIN');
      lockedTransaction = true;
      await locked.query('SELECT id FROM mio_image_jobs WHERE id=$1 FOR UPDATE', [jobId]);
      const stale = store.imagePrepareQuery(
        jobId,
        next.rows[0]!.query_command.messageId,
        deadline,
        rotatedEnvelope,
      );
      await vi.waitFor(async () => {
        const blocked = await pool.query<{ count: string }>(
          "SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM mio_image_jobs WHERE id=%'",
          [database.applicationName],
        );
        expect(Number(blocked.rows[0]!.count)).toBeGreaterThan(0);
      });
      const newer = { ...next.rows[0]!.query_command, messageId: randomUUID(), queryAttempt: 3 };
      await locked.query('UPDATE mio_image_outbox SET query_command=$2 WHERE job_id=$1', [
        jobId,
        JSON.stringify(newer),
      ]);
      await locked.query('UPDATE mio_image_jobs SET query_attempt=3 WHERE id=$1', [jobId]);
      await locked.query('COMMIT');
      lockedTransaction = false;
      expect(await stale).toBeUndefined();
      const afterRace = await pool.query<{ query_command: ImageQueryCommandV1 }>(
        'SELECT query_command FROM mio_image_outbox WHERE job_id=$1',
        [jobId],
      );
      expect(afterRace.rows[0]!.query_command).toEqual(newer);
    } finally {
      if (lockedTransaction) await locked.query('ROLLBACK');
      locked.release();
    }
    // A delayed restart past the deadline cannot publish the already scheduled query.
    await pool.query(
      "UPDATE mio_image_jobs SET async_deadline=now()-interval '1 second' WHERE id=$1",
      [jobId],
    );
    expect(await store.imagePending()).toBeUndefined();
    const expired = await pool.query<{
      state: string;
      error_code: string;
      upstream_task_id: string;
      query_command: unknown;
    }>(
      'SELECT j.state,j.error_code,j.upstream_task_id,o.query_command FROM mio_image_jobs j JOIN mio_image_outbox o ON o.job_id=j.id WHERE j.id=$1',
      [jobId],
    );
    expect(expired.rows[0]).toMatchObject({
      state: 'failed',
      error_code: 'IMAGE_QUERY_LIMIT',
      upstream_task_id: 'known-upstream',
      query_command: null,
    });
    await expect(store.imageRecover('owner', jobId)).rejects.toMatchObject({
      code: 'RESULT_CONFLICT',
    });
  } finally {
    await store.close();
    await database.close();
  }
}, 15000);

it('does not publish an async query when its saved bounds or credential lifetime are unavailable', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(computeSchemaSQL);
  const store = new ComputeStore(pool, true);
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  try {
    for (const change of [
      'async_deadline=NULL',
      'async_max_queries=NULL',
      "command=jsonb_set(command,'{expiresAt}',to_jsonb((extract(epoch from now())*1000-1000)::bigint))",
    ]) {
      const jobId = randomUUID();
      const command: ImageCommandV1 = {
        version: 1,
        type: 'image.request',
        profile: 'gpt-images-v1',
        messageId: randomUUID(),
        jobId,
        ownerId: 'owner',
        expiresAt: Date.now() + 600_000,
        input: { model: 'gpt-image-2', prompt: 'bounded', async: true },
        credential: sealImageKey('key', 'binding', 'b1', keys.publicKey),
      };
      await store.imageCreate('owner', randomUUID(), 'hash', command, {
        async: { operations: ['generate'], maxQueries: 8, maxAgeSeconds: 600 },
      });
      await store.imageAccept({
        version: 1,
        type: 'image.result',
        messageId: randomUUID(),
        commandId: command.messageId,
        jobId,
        state: 'submitted',
        outputs: [],
        upstreamTaskId: 'preserved-upstream',
        queryAttempt: 0,
      });
      await pool.query(`UPDATE mio_image_jobs SET ${change} WHERE id=$1`, [jobId]);
      expect(await store.imagePending()).toBeUndefined();
      expect(await store.imageGet('owner', jobId)).toMatchObject({
        status: 'failed',
        errorCode: 'IMAGE_QUERY_LIMIT',
      });
      const saved = await pool.query<{ upstream_task_id: string; query_command: unknown }>(
        'SELECT j.upstream_task_id,o.query_command FROM mio_image_jobs j JOIN mio_image_outbox o ON o.job_id=j.id WHERE j.id=$1',
        [jobId],
      );
      expect(saved.rows[0]).toEqual({
        upstream_task_id: 'preserved-upstream',
        query_command: null,
      });
    }
  } finally {
    await store.close();
    await database.close();
  }
}, 15000);

it('keeps async credentials for manual recovery of a known upstream task', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(computeSchemaSQL);
  const store = new ComputeStore(pool, true);
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
    input: { model: 'gpt-image-2', prompt: 'async recover', async: true },
    credential: sealImageKey('key', 'binding', 'b1', keys.publicKey),
  };
  const requestId = randomUUID();
  const hash = createHash('sha256')
    .update(JSON.stringify(['model', { prompt: 'async recover', async: true }]))
    .digest('hex');
  try {
    await store.imageCreate('owner', requestId, hash, command, {
      async: { operations: ['generate'], maxQueries: 2, maxAgeSeconds: 300 },
    });
    const initial = await store.imagePending();
    expect(initial?.type).toBe('image.request');
    await store.imageSent(jobId, initial!.messageId);
    await store.imageAccept({
      version: 1,
      type: 'image.result',
      messageId: randomUUID(),
      commandId: command.messageId,
      jobId,
      state: 'submitted',
      outputs: [],
      upstreamTaskId: 'known-upstream',
      queryAttempt: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const firstQuery = await store.imagePending();
    expect(firstQuery?.type).toBe('image.query');
    expect(firstQuery && 'credential' in firstQuery).toBe(true);
    await store.imageSent(jobId, firstQuery!.messageId);
    await store.imageAccept({
      version: 1,
      type: 'image.result',
      messageId: randomUUID(),
      commandId: command.messageId,
      jobId,
      state: 'failed',
      errorCode: 'IMAGE_QUERY_UNKNOWN',
      outputs: [],
      upstreamTaskId: 'known-upstream',
      queryAttempt: 1,
    });
    expect((await store.imageGet('owner', jobId)).status).toBe('failed');
    await store.imageRecover('owner', jobId);
    const recovered = await store.imagePending();
    expect(recovered?.type).toBe('image.query');
    expect(recovered && 'credential' in recovered).toBe(true);
    expect((recovered as ImageQueryCommandV1).queryAttempt).toBe(2);
  } finally {
    await store.close();
    await database.close();
  }
}, 15000);

it('keeps a pending or in-flight query on repeated recovery and ignores stale failures', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(computeSchemaSQL);
  const store = new ComputeStore(pool, true);
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
    expiresAt: Date.now() + 60_000,
    input: { model: 'gpt-image-2', prompt: 'recover-race', async: true },
    credential: sealImageKey('key', 'binding', 'b1', keys.publicKey),
  };
  const result = (attempt: number): ImageResultV1 => ({
    version: 1,
    type: 'image.result',
    messageId: randomUUID(),
    commandId: command.messageId,
    jobId,
    state: 'failed',
    outputs: [],
    errorCode: 'IMAGE_QUERY_UNKNOWN',
    upstreamTaskId: 'known-upstream',
    queryAttempt: attempt,
  });
  try {
    await store.imageCreate('owner', randomUUID(), 'hash', command, {
      async: { operations: ['generate'], maxQueries: 3, maxAgeSeconds: 60 },
    });
    await store.imageAccept({
      version: 1,
      type: 'image.result',
      messageId: randomUUID(),
      commandId: command.messageId,
      jobId,
      state: 'submitted',
      outputs: [],
      upstreamTaskId: 'known-upstream',
      queryAttempt: 0,
    });
    const snapshot = async () =>
      (
        await pool.query<{
          state: string;
          query_attempt: number;
          query_command: ImageQueryCommandV1 | null;
          sent_at: Date | null;
        }>(
          'SELECT j.state,j.query_attempt,o.query_command,o.sent_at FROM mio_image_jobs j JOIN mio_image_outbox o ON o.job_id=j.id WHERE j.id=$1',
          [jobId],
        )
      ).rows[0]!;
    const initial = await snapshot();
    await store.imageRecover('owner', jobId);
    await store.imageRecover('owner', jobId);
    expect(await snapshot()).toEqual(initial);
    await store.imageSent(jobId, initial.query_command!.messageId);
    const inFlight = await snapshot();
    expect(inFlight.sent_at).not.toBeNull();
    await store.imageRecover('owner', jobId);
    expect(await snapshot()).toEqual(inFlight);
    await store.imageAccept(result(1));
    expect((await store.imageGet('owner', jobId)).status).toBe('failed');
    await store.imageRecover('owner', jobId);
    const next = await snapshot();
    expect(next).toMatchObject({ state: 'processing', query_attempt: 2, sent_at: null });
    expect(next.query_command?.messageId).not.toBe(initial.query_command?.messageId);
    await store.imageRecover('owner', jobId);
    expect(await snapshot()).toEqual(next);
    await store.imageAccept(result(1));
    expect(await snapshot()).toEqual(next);
    await expect(store.imageAccept(result(3))).rejects.toMatchObject({ code: 'RESULT_CONFLICT' });
    expect(await snapshot()).toEqual(next);
    await store.imageAccept(result(2));
    expect((await store.imageGet('owner', jobId)).status).toBe('failed');
    expect((await snapshot()).query_command).toBeNull();
  } finally {
    await store.close();
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
  const sent: (ImageCommandV1 | ImageQueryCommandV1 | ImageRecoveryCommandV1)[] = [];
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

it('admits only a discovered and explicitly async Vidu model through HTTP and the worker', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(computeSchemaSQL);
  await pool.query(providerSchemaSQL);
  const config = { databaseURL: database.url, masterKey: randomBytes(32), masterKeyId: 'fixture' };
  const providerStore = await createProviderStore(config, true);
  const provider = createProviderService(providerStore, config, async () =>
    Response.json({
      data: ['fixture-vidu-alt', 'fixture-vidu-incomplete', 'fixture-vidu-unadapted'].map((id) => ({
        id,
        object: 'model',
        owned_by: 'fixture',
      })),
    }),
  );
  const actor = { userId: randomUUID(), sessionId: 'fixture' };
  await provider.save(actor, 0, 'synthetic-provider-key');
  await provider.discover(actor);
  const catalog = (await provider.catalog(actor)).items;
  const model = (id: string) => catalog.find((item) => item.modelId === id)!.modelRef;
  const declaration = {
    operation: 'image.generate' as const,
    profile: 'vidu-image-v1' as const,
    sourceKind: 'protocol-reference' as const,
    source: 'synthetic Vidu protocol fixture',
    sourceVersion: 'v1',
    classification: 'image' as const,
  };
  await providerStore.declare(actor.userId, (await provider.get(actor))!.revision, {
    ...declaration,
    modelRef: model('fixture-vidu-incomplete'),
  });
  await providerStore.declare(actor.userId, (await provider.get(actor))!.revision, {
    ...declaration,
    modelRef: model('fixture-vidu-alt'),
    metadata: {
      image: {
        modes: ['generate'],
        async: { operations: ['generate'], maxQueries: 4, maxAgeSeconds: 300 },
      },
    },
  });
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const directory = mkdtempSync(join(tmpdir(), 'mio-vidu-admission-'));
  const journal = new Journal(directory, randomUUID(), true);
  const asyncTransport = {
    submit: vi.fn<AsyncImageTransport['submit']>().mockResolvedValue({
      state: 'submitted',
      upstreamTaskId: 'synthetic-task',
    }),
    query: vi.fn(async (_input: unknown, _key: string, taskId: string) => ({
      state: 'processing' as const,
      upstreamTaskId: taskId,
    })),
  };
  const worker = createImageWorker(
    journal,
    'b1',
    keys.privateKey,
    vi.fn(),
    fetch,
    undefined,
    asyncTransport,
  );
  bus.execute = async (command) => {
    if (command.type === 'image.recover') throw new Error('unexpected recovery');
    const result = await worker(command);
    await bus.receive!(
      parseImageResult({
        version: 1,
        type: 'image.result',
        messageId: randomUUID(),
        commandId: command.type === 'image.query' ? command.commandId : command.messageId,
        jobId: command.jobId,
        state: result.state,
        outputs: 'outputs' in result ? result.outputs : [],
        ...('errorCode' in result ? { errorCode: result.errorCode } : {}),
        ...('upstreamTaskId' in result ? { upstreamTaskId: result.upstreamTaskId } : {}),
        ...('queryAttempt' in result ? { queryAttempt: result.queryAttempt } : {}),
      }),
    );
  };
  bus.receive = undefined;
  const service = createComputeService(
    new ComputeStore(pool, true),
    {
      head: vi.fn(),
      uploadUrl: () => '',
      downloadUrl: () => '',
      copy: async () => {},
      delete: async () => {},
    },
    { brokerURL: 'amqp://localhost', brokerUser: 'a', expectedResultUser: 'b' },
    { keyId: 'b1', publicKey: keys.publicKey, provider: () => provider },
  );
  let origin = '';
  const server = createServer(
    (req, res) => void createComputeHandler(service, async () => actor, [origin])(req, res),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server');
  origin = `http://127.0.0.1:${address.port}`;
  const call = (modelRef: string, parameters: Record<string, unknown>) =>
    fetch(`${origin}/api/v1/compute/images`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: randomUUID(), modelRef, parameters }),
    });
  try {
    expect(
      (await call(model('fixture-vidu-unadapted'), { prompt: 'fixture', async: true })).status,
    ).toBe(409);
    expect(
      (await call(model('fixture-vidu-incomplete'), { prompt: 'fixture', async: true })).status,
    ).toBe(409);
    expect((await call(model('fixture-vidu-alt'), { prompt: 'fixture' })).status).toBe(400);
    expect(asyncTransport.submit).not.toHaveBeenCalled();
    expect((await call(model('fixture-vidu-alt'), { prompt: 'fixture', async: true })).status).toBe(
      202,
    );
    await vi.waitFor(() => expect(asyncTransport.submit).toHaveBeenCalledOnce(), { timeout: 4000 });
    expect(asyncTransport.submit).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'fixture-vidu-alt', async: true }),
      'synthetic-provider-key',
      expect.any(AbortSignal),
    );
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    journal.close();
    rmSync(directory, { recursive: true });
    await provider.close();
    await database.close();
  }
}, 15000);
