import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  open: vi.fn((await original<typeof fs>()).open),
  mkdir: vi.fn((await original<typeof fs>()).mkdir),
}));
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createGenerationHandler } from '../../src/generations/http.ts';
import { generationFixture } from './fixture.ts';

it('keeps image HTTP ownership, idempotency, output order and derived-image editing without B or MQ', async () => {
  const f = await generationFixture();
  const service = await f.start();
  const handler = createGenerationHandler(
    service,
    async (headers) =>
      headers.get('cookie') === 'owner'
        ? f.actor
        : headers.get('cookie') === 'other'
          ? { userId: 'other', sessionId: 'other' }
          : null,
    ['https://app.fixture'],
  );
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const base = 'http://127.0.0.1:' + address.port + '/api/v1/compute/images';
  const requestId = randomUUID();
  const submit = (prompt: string) =>
    fetch(base, {
      method: 'POST',
      headers: {
        origin: 'https://app.fixture',
        cookie: 'owner',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ requestId, modelRef: f.modelRef, parameters: { prompt, n: 2 } }),
    });
  try {
    const accepted = await submit('two original images');
    expect(accepted.status).toBe(202);
    const job = await accepted.json();
    await vi.waitFor(
      async () => expect((await service.getImage(f.actor, job.jobId)).status).toBe('completed'),
      { timeout: 6000 },
    );
    const complete = await service.getImage(f.actor, job.jobId);
    expect(complete.outputs.map((output) => output.index)).toEqual([0, 1]);
    expect(complete.assetIds).toHaveLength(2);
    expect((await (await submit('two original images')).json()).jobId).toBe(job.jobId);
    expect((await submit('changed prompt')).status).toBe(409);
    expect((await fetch(base + '/' + job.jobId)).status).toBe(401);
    expect((await fetch(base + '/' + job.jobId, { headers: { cookie: 'other' } })).status).toBe(
      404,
    );
    expect([...f.stored.values()].every((object) => object.bytes.equals(f.bytes))).toBe(true);
    const edited = await service.createImage(f.actor, randomUUID(), f.modelRef, {
      prompt: 'edit prior result',
      operation: 'edit',
      imageAssetId: complete.assetIds[0]!,
    });
    await vi.waitFor(
      async () => expect((await service.getImage(f.actor, edited.jobId)).status).toBe('completed'),
      { timeout: 6000 },
    );
    expect(f.transport).toHaveBeenCalledTimes(2);
    const form = f.transport.mock.calls[1]![1]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(Buffer.from(await (form.get('image') as File).arrayBuffer())).toEqual(f.bytes);
    expect(
      (await readdir(join(f.directory, job.jobId))).filter((name) => name.endsWith('.png')),
    ).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await f.close();
  }
}, 15000);

it('keeps legacy OpenAI jobs for generate and edit while rejecting generate with references', async () => {
  const f = await generationFixture();
  const submitting = vi.spyOn(f.store, 'submitting');
  try {
    const secondBytes = await sharp(f.bytes).negate().png().toBuffer();
    const sources = await Promise.all([f.addImageSource(), f.addImageSource(secondBytes)]);
    const imageAssetIds = sources.map((source) => source.assetId);
    await f.pool.query(
      `UPDATE mio_provider_model_routes SET param_spec=param_spec ||
       '{"allowGenerateReferences":true,"allowedAspectRatios":["16:9"]}'::jsonb
       WHERE raw_model_id='gpt-image-2' AND operation='image.generate'`,
    );
    const generate = await f.admit(randomUUID(), 'plain legacy generate', {
      operation: 'generate',
      n: 1,
      aspect_ratio: '16:9',
    });
    const edit = await f.admit(randomUUID(), 'ordered legacy edit', {
      operation: 'edit',
      imageAssetIds,
    });
    const blocked = await f.admit(randomUUID(), 'legacy generate with references');
    await f.pool.query(
      `UPDATE mio_image_jobs SET
       command=jsonb_set(command,'{route,paramSpec,allowGenerateReferences}','true'),
       route_snapshot=jsonb_set(route_snapshot,'{paramSpec,allowGenerateReferences}','true')
       WHERE id=ANY($1::uuid[])`,
      [[generate.jobId, edit.jobId, blocked.jobId]],
    );
    await f.pool.query(
      "UPDATE mio_image_jobs SET command=jsonb_set(command,'{input,images}',$2) WHERE id=$1",
      [blocked.jobId, JSON.stringify(sources)],
    );

    const service = await f.start();
    await vi.waitFor(
      async () => {
        const result = await service.getImage(f.actor, blocked.jobId);
        expect(result.status).not.toBe('accepted');
      },
      { timeout: 6000 },
    );
    expect(await service.getImage(f.actor, blocked.jobId)).toMatchObject({
      status: 'rejected',
      errorCode: 'IMAGE_INPUT_INVALID',
    });
    expect(submitting.mock.calls.map(([row]) => row.id)).not.toContain(blocked.jobId);
    await vi.waitFor(
      async () => {
        expect((await service.getImage(f.actor, generate.jobId)).status).toBe('completed');
        expect((await service.getImage(f.actor, edit.jobId)).status).toBe('completed');
      },
      { timeout: 6000 },
    );
    expect(f.transport).toHaveBeenCalledTimes(2);
    const [generateCall] = f.transport.mock.calls.filter(([url]) =>
      String(url).endsWith('/generations'),
    );
    expect(JSON.parse(String(generateCall?.[1]?.body))).toEqual({
      model: 'gpt-image-2',
      prompt: 'plain legacy generate',
      n: 1,
      aspect_ratio: '16:9',
    });
    const [editCall] = f.transport.mock.calls.filter(([url]) => String(url).endsWith('/edits'));
    const form = editCall?.[1]?.body as FormData;
    expect([...form.keys()]).toEqual(['model', 'prompt', 'response_format', 'image', 'image']);
    const images = form.getAll('image') as File[];
    expect(
      await Promise.all(images.map(async (image) => Buffer.from(await image.arrayBuffer()))),
    ).toEqual([f.bytes, secondBytes]);
    const model = (await f.provider.listImageModels(f.actor)).find(
      (item) => item.modelRef === f.modelRef,
    );
    expect(model).toMatchObject({
      supportedOperations: ['generate', 'edit'],
      allowGenerateReferences: false,
      allowedAspectRatios: ['16:9'],
    });
    await expect(
      service.createImage(f.actor, randomUUID(), f.modelRef, {
        prompt: 'new generate with references',
        operation: 'generate',
        imageAssetIds,
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_OPERATION_UNSUPPORTED' });
    expect(f.transport).toHaveBeenCalledTimes(2);
  } finally {
    submitting.mockRestore();
    await f.close();
  }
}, 15000);

it('freezes the first encrypted credential but queries an admitted async task with the current Key', async () => {
  const f = await generationFixture();
  try {
    const sync = await f.admit();
    const async = await f.admit(randomUUID(), 'async', { async: true }, true);
    const before = (
      await f.pool.query('SELECT snapshot FROM mio_image_executions WHERE job_id=$1', [sync.jobId])
    ).rows[0].snapshot;
    expect(JSON.stringify(before)).not.toContain('initial-image-key');
    expect(before.credentialVersion).toBe(1);
    const current = await f.provider.get(f.actor);
    await f.provider.save(f.actor, current!.revision, 'rotated-image-key');
    await f.start();
    await vi.waitFor(
      async () => expect((await f.service.getImage(f.actor, sync.jobId)).status).toBe('completed'),
      { timeout: 6000 },
    );
    await vi.waitFor(
      async () => expect((await f.service.getImage(f.actor, async.jobId)).status).toBe('completed'),
      { timeout: 6000 },
    );
    const headers = f.transport.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Authorization ?? headers.authorization).toBe('Bearer initial-image-key');
    expect(f.asyncTransport.submit.mock.calls[0]![1]).toBe('initial-image-key');
    expect(f.asyncTransport.query.mock.calls[0]![1]).toBe('rotated-image-key');
    const receipt = await readFile(join(f.directory, async.jobId, 'receipt.json'), 'utf8');
    expect(receipt).not.toContain('image-key');
    const metadata = (
      await f.pool.query('SELECT command,admitted FROM mio_image_jobs WHERE id=$1', [async.jobId])
    ).rows[0];
    expect(JSON.stringify(metadata)).not.toContain('image-key');
  } finally {
    await f.close();
  }
}, 15000);

it.each(['later reference', 'mask'] as const)(
  'rejects a %s with a mismatched signature before writing a submission intent',
  async (fault) => {
    const f = await generationFixture();
    const submitting = vi.spyOn(f.store, 'submitting');
    try {
      const source = await f.addImageSource();
      const jpeg = await sharp(f.bytes).jpeg().toBuffer();
      const mislabeled = await f.addImageSource(jpeg, 'image/png');
      const service = await f.start();
      const job = await service.createImage(
        f.actor,
        randomUUID(),
        fault === 'mask' ? f.modelRef : f.asyncModelRef,
        {
          prompt: 'signature preflight',
          ...(fault === 'mask'
            ? { operation: 'edit', imageAssetId: source.assetId, maskAssetId: mislabeled.assetId }
            : {
                operation: 'generate',
                async: true,
                imageAssetIds: [source.assetId, mislabeled.assetId],
              }),
        },
      );
      await vi.waitFor(
        async () =>
          expect((await service.getImage(f.actor, job.jobId)).status).not.toBe('accepted'),
        { timeout: 6000 },
      );
      expect(submitting.mock.calls.length).toBe(0);
      expect(await service.getImage(f.actor, job.jobId)).toMatchObject({
        status: 'rejected',
        errorCode: 'IMAGE_INPUT_INVALID',
      });
      const reads = vi.mocked(f.objects.readImage!).mock.calls.map(([key]) => key);
      expect(reads).toEqual([source.key, mislabeled.key]);
      expect(f.transport).not.toHaveBeenCalled();
      expect(f.asyncTransport.submit).not.toHaveBeenCalled();
    } finally {
      submitting.mockRestore();
      await f.close();
    }
  },
  15000,
);

it('retries a failed conditional read before submitting verified image and mask bytes once', async () => {
  const f = await generationFixture();
  const release = vi.spyOn(f.store, 'release');
  const submitting = vi.spyOn(f.store, 'submitting');
  const read = vi.mocked(f.objects.readImage!);
  try {
    const source = await f.addImageSource();
    const mask = await f.addImageSource();
    read.mockRejectedValueOnce(
      Object.assign(new Error('ASSET_OBJECT_RESPONSE'), { statusCode: 412 }),
    );
    const service = await f.start();
    const job = await service.createImage(f.actor, randomUUID(), f.modelRef, {
      prompt: 'retry storage read',
      operation: 'edit',
      imageAssetId: source.assetId,
      maskAssetId: mask.assetId,
    });
    await vi.waitFor(
      async () => expect((await service.getImage(f.actor, job.jobId)).status).toBe('completed'),
      { timeout: 6000 },
    );
    expect(release).toHaveBeenCalledOnce();
    expect(submitting).toHaveBeenCalledOnce();
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(
      submitting.mock.invocationCallOrder[0]!,
    );
    expect(read.mock.calls.map(([key, etag, size]) => [key, etag, size])).toEqual([
      [source.key, source.etag, source.sizeBytes],
      [source.key, source.etag, source.sizeBytes],
      [mask.key, mask.etag, mask.sizeBytes],
    ]);
    expect(f.transport).toHaveBeenCalledOnce();
  } finally {
    release.mockRestore();
    submitting.mockRestore();
    await f.close();
  }
}, 15000);

it('keeps an uncertain submission unknown across restarts and refuses a generation replay', async () => {
  const f = await generationFixture();
  try {
    await f.start();
    const job = await f.service.createImage(f.actor, randomUUID(), f.modelRef, {
      prompt: 'unknown',
    });
    await vi.waitFor(
      async () => expect((await f.service.getImage(f.actor, job.jobId)).status).toBe('unknown'),
      { timeout: 6000 },
    );
    await expect(f.service.recoverImage(f.actor, job.jobId)).rejects.toMatchObject({
      code: 'RESULT_CONFLICT',
    });
    await f.stop();
    await f.start();
    expect((await f.service.getImage(f.actor, job.jobId)).status).toBe('unknown');
    expect(f.transport).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it('recovers a durable receipt ahead of PG and never submits a persisted intent again', async () => {
  const f = await generationFixture();
  try {
    const returned = await f.admit(randomUUID(), 'receipt before PG checkpoint');
    const first = (await f.store.claim())!;
    expect(await f.store.submitting(first)).toBe(true);
    await f.files.receive(
      first.id,
      first.command.messageId,
      1,
      [{ base64: f.bytes.toString('base64') }],
      'png',
    );
    const unknown = await f.admit(randomUUID(), 'intent without receipt');
    const second = (await f.store.claim())!;
    expect(await f.store.submitting(second)).toBe(true);
    await f.start();
    await vi.waitFor(
      async () =>
        expect((await f.service.getImage(f.actor, returned.jobId)).status).toBe('completed'),
      { timeout: 6000 },
    );
    await vi.waitFor(
      async () => expect((await f.service.getImage(f.actor, unknown.jobId)).status).toBe('unknown'),
      { timeout: 6000 },
    );
    expect(f.transport).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(['404', 'sha256', 'etag'] as const)(
  'keeps a recovered receipt with a %s HEAD failure out of ready assets',
  async (fault) => {
    const f = await generationFixture();
    const release = Promise.withResolvers<void>();
    const accept = vi.spyOn(f.store, 'acceptOutputs').mockImplementation(async () => {
      await release.promise;
      throw new Error('PG unavailable after durable object receipt');
    });
    const ready = () =>
      f.pool.query("SELECT id,raw_key FROM mio_assets WHERE owner_id=$1 AND state='ready'", [
        f.actor.userId,
      ]);
    try {
      const initial = await f.start();
      const job = await initial.createImage(f.actor, randomUUID(), f.modelRef, {
        prompt: 'object receipt before PG outputs',
      });
      await vi.waitFor(() => expect(accept).toHaveBeenCalledTimes(1), { timeout: 6000 });
      const stopping = f.stop();
      release.resolve();
      await stopping;

      const [{ command }] = accept.mock.calls[0]!;
      const persisted = (
        await f.pool.query('SELECT checkpoint FROM mio_image_executions WHERE job_id=$1', [
          job.jobId,
        ])
      ).rows[0].checkpoint;
      const saved = (await f.files.load(job.jobId, command.messageId, 1, persisted))!;
      expect(saved.ref.revision).toBeGreaterThan(persisted.revision);
      expect((await ready()).rows).toEqual([]);
      const output = saved.checkpoint.outputs[0]!;
      const original = f.stored.get(output.key)!;
      if (fault === '404') f.stored.delete(output.key);
      if (fault === 'sha256') f.stored.set(output.key, { ...original, sha256: '0'.repeat(64) });
      if (fault === 'etag') f.stored.set(output.key, { ...original, etag: 'different-etag' });

      const restarted = await f.start();
      await vi.waitFor(
        async () =>
          expect((await restarted.getImage(f.actor, job.jobId)).status).toBe(
            'materialization_failed',
          ),
        { timeout: 6000 },
      );
      expect((await ready()).rows).toEqual([]);
      expect((await restarted.getImage(f.actor, job.jobId)).outputs).toEqual([]);
      const exhausted = (await f.files.load(job.jobId, command.messageId, 1))!.checkpoint;
      expect(exhausted.attempts).toBe(3);
      expect(exhausted.outputs[0]).toEqual(output);
      expect(exhausted.attemptedKeys[0]).toEqual([output.key]);
      expect(await f.files.read(job.jobId, exhausted.images[0]!)).toEqual(f.bytes);

      f.stored.set(output.key, original);
      await restarted.recoverImage(f.actor, job.jobId);
      await vi.waitFor(
        async () => expect((await restarted.getImage(f.actor, job.jobId)).status).toBe('completed'),
        { timeout: 6000 },
      );
      const recovered = await restarted.getImage(f.actor, job.jobId);
      expect(recovered.outputs.map((item) => item.index)).toEqual([0]);
      expect((await ready()).rows).toEqual([{ id: recovered.assetIds[0], raw_key: output.key }]);
      expect(f.objects.putImage).toHaveBeenCalledTimes(1);
      expect(f.transport).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      accept.mockRestore();
      await f.close();
    }
  },
  15000,
);

it('retains durable original bytes after COS failure and recovers assets without another generation', async () => {
  const f = await generationFixture();
  try {
    f.setOffline(true);
    await f.start();
    const job = await f.service.createImage(f.actor, randomUUID(), f.modelRef, {
      prompt: 'recover storage',
    });
    await vi.waitFor(
      async () =>
        expect((await f.service.getImage(f.actor, job.jobId)).status).toBe(
          'materialization_failed',
        ),
      { timeout: 6000 },
    );
    const row = (await f.pool.query('SELECT command FROM mio_image_jobs WHERE id=$1', [job.jobId]))
      .rows[0];
    const saved = (await f.files.load(job.jobId, row.command.messageId, 1))!;
    expect(await f.files.read(job.jobId, saved.checkpoint.images[0]!)).toEqual(f.bytes);
    await f.stop();
    f.setOffline(false);
    await f.start();
    await f.service.recoverImage(f.actor, job.jobId);
    await vi.waitFor(
      async () => expect((await f.service.getImage(f.actor, job.jobId)).status).toBe('completed'),
      { timeout: 6000 },
    );
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect((await f.service.getImage(f.actor, job.jobId)).assetIds).toHaveLength(1);
    expect(
      (
        await f.pool.query('SELECT count(*) AS count FROM mio_image_outputs WHERE job_id=$1', [
          job.jobId,
        ])
      ).rows[0].count,
    ).toBe('1');
  } finally {
    await f.close();
  }
}, 15000);

it.each(['in-process', 'restart'])(
  'recovers the final async result ahead of PG after %s and deadline expiry',
  async (recovery) => {
    const f = await generationFixture();
    const checkpoint = vi.spyOn(f.store, 'checkpoint');
    try {
      const job = await f.admit(randomUUID(), 'async checkpoint fault', { async: true }, true);
      await f.pool.query('UPDATE mio_image_jobs SET async_max_queries=1 WHERE id=$1', [job.jobId]);
      checkpoint.mockImplementationOnce(async (row) => {
        expect(row.phase).toBe('querying');
        const saved = await f.files.load(row.id, row.command.messageId, 1);
        expect(saved?.checkpoint.receivedAll).toBe(true);
        expect(await f.files.read(row.id, saved!.checkpoint.images[0]!)).toEqual(f.bytes);
        await f.pool.query(
          "UPDATE mio_image_jobs SET async_deadline=now()-interval '1 second' WHERE id=$1",
          [row.id],
        );
        throw new Error('transient PG failure after durable async result');
      });
      await f.start();
      await vi.waitFor(() => expect(checkpoint).toHaveBeenCalled(), { timeout: 6000 });
      if (recovery === 'restart') {
        await f.stop();
        await f.start();
      }
      await vi.waitFor(
        async () => expect((await f.service.getImage(f.actor, job.jobId)).status).toBe('completed'),
        { timeout: 6000 },
      );
      expect((await f.service.getImage(f.actor, job.jobId)).assetIds).toHaveLength(1);
      expect(
        (await f.pool.query('SELECT query_attempt FROM mio_image_jobs WHERE id=$1', [job.jobId]))
          .rows[0].query_attempt,
      ).toBe(1);
      expect(f.asyncTransport.submit).toHaveBeenCalledTimes(1);
      expect(f.asyncTransport.query).toHaveBeenCalledTimes(1);
      expect(f.transport).not.toHaveBeenCalled();
      expect([...f.stored.values()][0]!.bytes).toEqual(f.bytes);
    } finally {
      checkpoint.mockRestore();
      await f.close();
    }
  },
);

it('checks the absolute query deadline after all four execution permits were occupied', async () => {
  const f = await generationFixture();
  const releases: (() => void)[] = [];
  try {
    await f.start();
    const job = await f.service.createImage(f.actor, randomUUID(), f.asyncModelRef, {
      prompt: 'query queue',
      async: true,
    });
    await vi.waitFor(async () =>
      expect((await f.service.getImage(f.actor, job.jobId)).status).toBe('submitted'),
    );
    f.transport.mockImplementation(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return Response.json({ data: [{ b64_json: f.bytes.toString('base64') }] });
    });
    for (let index = 0; index < 4; index++)
      await f.service.createImage(f.actor, randomUUID(), f.modelRef, { prompt: 'occupy ' + index });
    await vi.waitFor(() => expect(releases).toHaveLength(4), { timeout: 6000 });
    await f.pool.query(
      "UPDATE mio_image_jobs SET async_deadline=now()-interval '1 second',next_query_at=now() WHERE id=$1",
      [job.jobId],
    );
    for (const release of releases) release();
    await vi.waitFor(
      async () =>
        expect((await f.service.getImage(f.actor, job.jobId)).errorCode).toBe('IMAGE_QUERY_LIMIT'),
      { timeout: 6000 },
    );
    expect(f.asyncTransport.submit).toHaveBeenCalledTimes(1);
    expect(f.asyncTransport.query).not.toHaveBeenCalled();
  } finally {
    for (const release of releases) release();
    await f.close();
  }
}, 15000);

it('blocks new generation after a real file write exhausts storage, including after restart', async () => {
  const f = await generationFixture();
  const originalOpen = (await vi.importActual<typeof fs>('node:fs/promises')).open;
  const opened = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const file = await originalOpen(...args);
    if (String(args[0]).endsWith('.png'))
      vi.spyOn(file, 'writeFile').mockRejectedValue(
        Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
      );
    return file;
  });
  try {
    await f.start();
    const requestId = randomUUID();
    const job = await f.service.createImage(f.actor, requestId, f.modelRef, {
      prompt: 'disk fault',
    });
    await vi.waitFor(
      async () =>
        expect((await f.service.getImage(f.actor, job.jobId)).status).toBe(
          'materialization_failed',
        ),
      { timeout: 6000 },
    );
    opened.mockRestore();
    await expect(
      f.service.createImage(f.actor, randomUUID(), f.modelRef, { prompt: 'must not generate' }),
    ).rejects.toMatchObject({ code: 'COMPUTE_STORAGE_UNAVAILABLE' });
    expect(
      (await f.service.createImage(f.actor, requestId, f.modelRef, { prompt: 'disk fault' })).jobId,
    ).toBe(job.jobId);
    await f.stop();
    await f.start();
    await expect(
      f.service.createImage(f.actor, randomUUID(), f.modelRef, { prompt: 'still blocked' }),
    ).rejects.toMatchObject({ code: 'COMPUTE_STORAGE_UNAVAILABLE' });
    expect(f.transport).toHaveBeenCalledTimes(1);
    const files = await readdir(join(f.directory, job.jobId));
    expect(files).toContain('receipt.json');
  } finally {
    opened.mockRestore();
    await f.close();
  }
});

it('persists the admission block when the result directory cannot be created', async () => {
  const f = await generationFixture();
  const originalMkdir = (await vi.importActual<typeof fs>('node:fs/promises')).mkdir;
  const mkdir = vi.spyOn(fs, 'mkdir').mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(f.directory + '/'))
      throw Object.assign(new Error('directory quota exhausted'), { code: 'EDQUOT' });
    return originalMkdir(...args);
  });
  try {
    await f.start();
    const job = await f.service.createImage(f.actor, randomUUID(), f.modelRef, {
      prompt: 'directory fault',
    });
    await vi.waitFor(async () =>
      expect(
        (
          await f.pool.query('SELECT storage_failed FROM mio_image_executions WHERE job_id=$1', [
            job.jobId,
          ])
        ).rows[0].storage_failed,
      ).toBe(true),
    );
    mkdir.mockRestore();
    await f.stop();
    await f.start();
    await expect(
      f.service.createImage(f.actor, randomUUID(), f.modelRef, { prompt: 'must remain blocked' }),
    ).rejects.toMatchObject({ code: 'COMPUTE_STORAGE_UNAVAILABLE' });
    expect(f.transport).toHaveBeenCalledTimes(1);
  } finally {
    mkdir.mockRestore();
    await f.close();
  }
});

it('retains a committed output while a recovered second output fails HEAD', async () => {
  const f = await generationFixture();
  const put = f.objects.putImage!;
  const accept = vi.spyOn(f.store, 'acceptOutputs');
  const release = Promise.withResolvers<void>();
  let rejectSecond = true;
  f.objects.putImage = vi.fn<typeof put>(async (...args) => {
    if (rejectSecond && args[0].includes('/images/1-'))
      throw new Error('second output unavailable');
    return put(...args);
  });
  try {
    await f.start();
    const job = await f.service.createImage(f.actor, randomUUID(), f.modelRef, {
      prompt: 'partial upload',
      n: 2,
    });
    await vi.waitFor(
      async () =>
        expect((await f.service.getImage(f.actor, job.jobId)).status).toBe(
          'materialization_failed',
        ),
      { timeout: 6000 },
    );
    const partial = await f.service.getImage(f.actor, job.jobId);
    expect(partial.outputs.map((output) => output.index)).toEqual([0]);
    accept.mockClear().mockImplementationOnce(async () => {
      await release.promise;
      throw new Error('PG unavailable after second object receipt');
    });
    rejectSecond = false;
    await f.service.recoverImage(f.actor, job.jobId);
    await vi.waitFor(() => expect(accept).toHaveBeenCalledTimes(1), { timeout: 6000 });
    const stopping = f.stop();
    release.resolve();
    await stopping;

    const [, outputs] = accept.mock.calls[0]!;
    const first = outputs[0]!;
    const second = outputs[1]!;
    const original = f.stored.get(second.key)!;
    expect(f.stored.delete(second.key)).toBe(true);
    const putCount = vi.mocked(f.objects.putImage).mock.calls.length;
    vi.mocked(f.objects.head).mockClear();
    await f.start();
    await vi.waitFor(
      async () =>
        expect((await f.service.getImage(f.actor, job.jobId)).status).toBe(
          'materialization_failed',
        ),
      { timeout: 6000 },
    );
    expect(f.objects.head).toHaveBeenCalledWith(first.key);
    expect(f.objects.head).toHaveBeenCalledWith(second.key);
    expect((await f.service.getImage(f.actor, job.jobId)).outputs).toEqual(partial.outputs);
    expect(
      (
        await f.pool.query(
          "SELECT id,raw_key FROM mio_assets WHERE owner_id=$1 AND state='ready'",
          [f.actor.userId],
        )
      ).rows,
    ).toEqual([{ id: partial.assetIds[0], raw_key: first.key }]);

    f.stored.set(second.key, original);
    await f.service.recoverImage(f.actor, job.jobId);
    await vi.waitFor(
      async () => expect((await f.service.getImage(f.actor, job.jobId)).status).toBe('completed'),
      { timeout: 6000 },
    );
    const result = await f.service.getImage(f.actor, job.jobId);
    expect(result.outputs.map((output) => output.index)).toEqual([0, 1]);
    expect(result.assetIds[0]).toBe(partial.assetIds[0]);
    expect(f.objects.putImage).toHaveBeenCalledTimes(putCount);
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.stored.size).toBe(2);
    expect(
      (await f.pool.query('SELECT count(*) FROM mio_image_outputs WHERE job_id=$1', [job.jobId]))
        .rows[0].count,
    ).toBe('2');
  } finally {
    release.resolve();
    accept.mockRestore();
    await f.close();
  }
}, 15000);

it('reconciles an ambiguous successful COS write by its saved physical identity', async () => {
  const f = await generationFixture();
  const put = f.objects.putImage!;
  f.objects.putImage = vi.fn<typeof put>(async (...args) => {
    await put(...args);
    throw new Error('connection lost after COS accepted bytes');
  });
  try {
    await f.start();
    const job = await f.service.createImage(f.actor, randomUUID(), f.modelRef, {
      prompt: 'ambiguous upload',
    });
    await vi.waitFor(
      async () => expect((await f.service.getImage(f.actor, job.jobId)).status).toBe('completed'),
      { timeout: 6000 },
    );
    expect(f.objects.putImage).toHaveBeenCalledTimes(1);
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect((await f.service.getImage(f.actor, job.jobId)).assetIds).toHaveLength(1);
    expect(f.stored.size).toBe(1);
    expect([...f.stored.values()][0]!.bytes).toEqual(f.bytes);
  } finally {
    await f.close();
  }
});
