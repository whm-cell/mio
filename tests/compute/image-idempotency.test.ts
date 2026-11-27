import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createGenerationAdmission } from '../../src/generations/image/admission.ts';
import { IMAGE_GEOMETRY_EDGES } from '../../src/generations/image/contracts.ts';
import type { ImageGeometry } from '../../src/generations/image/contracts.ts';
import type { GenerationRequest } from '../../src/generations/image/execution.ts';
import { createGenerationHandler } from '../../src/generations/image/http.ts';
import type { ImageAdmissionSnapshot } from '../../src/providers/contracts.ts';
import { generationFixture } from '../generations/fixture.ts';

const geometry = { left: 16, top: 0, right: 32, bottom: 8 };
const reorderedGeometry = { bottom: 8, right: 32, top: 0, left: 16 };

function legacyHash(modelRef: string, parameters: Record<string, unknown>): string {
  const topLevelOnly = Object.fromEntries(
    Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash('sha256')
    .update(JSON.stringify([modelRef, topLevelOnly]))
    .digest('hex');
}

async function outpaintFixture(f: Awaited<ReturnType<typeof generationFixture>>) {
  const original = await f.provider.snapshotImage(f.actor, f.modelRef);
  const image = original.capabilityMetadata.image!;
  const snapshot: ImageAdmissionSnapshot = {
    ...original,
    capabilityMetadata: {
      ...original.capabilityMetadata,
      image: {
        ...image,
        modes: [...image.modes, 'outpaint'],
        geometry: { unit: 'pixels', edges: [...IMAGE_GEOMETRY_EDGES] },
      },
    },
    route: {
      ...original.route,
      paramSpec: {
        ...original.route.paramSpec,
        supportedOperations: [...original.route.paramSpec.supportedOperations, 'outpaint'],
        allowOutpaintGeometry: true,
      },
    },
  };
  const images = [await f.addImageSource(), await f.addImageSource()];
  const intent = {
    prompt: 'outpaint idempotency fixture',
    operation: 'outpaint',
    imageAssetIds: images.map((image) => image.assetId),
    geometry,
  } as const;
  return {
    snapshot,
    intent,
    images,
    async retainLegacy(
      requestId: string,
      parameters: Record<string, unknown>,
      input: Record<string, unknown> = {
        prompt: intent.prompt,
        operation: intent.operation,
        images,
        geometry: parameters.geometry,
      },
    ) {
      const jobId = randomUUID();
      const command: Omit<GenerationRequest, 'input'> & { input: Record<string, unknown> } = {
        version: 1,
        type: 'image.request',
        jobId,
        messageId: randomUUID(),
        ownerId: f.actor.userId,
        expiresAt: Date.now() + 600_000,
        profile: snapshot.profile,
        route: snapshot.route,
        input: { model: snapshot.modelId, ...input },
      };
      const hash = legacyHash(f.modelRef, parameters);
      await f.pool.query(
        `INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,state)
         VALUES($1,$2,$3,$4,$5,'accepted')`,
        [jobId, f.actor.userId, requestId, hash, JSON.stringify(command)],
      );
      return { jobId, hash, requestId };
    },
  };
}

it('replays each retained geometry key order after reopening without credentials or assets', async () => {
  const f = await generationFixture();
  try {
    const { intent, retainLegacy } = await outpaintFixture(f);
    const orders = Object.entries(geometry).reduce<[string, number][][]>(
      (prefixes, edge) =>
        prefixes.flatMap((prefix) =>
          Array.from({ length: prefix.length + 1 }, (_, index) => [
            ...prefix.slice(0, index),
            edge,
            ...prefix.slice(index),
          ]),
        ),
      [[]],
    );
    const retained = [];
    for (const order of orders) {
      const oldGeometry = Object.fromEntries(order) as unknown as ImageGeometry;
      retained.push(await retainLegacy(randomUUID(), { ...intent, geometry: oldGeometry }));
    }
    expect(new Set(retained.map(({ hash }) => hash)).size).toBe(24);
    await f.pool.query('DELETE FROM mio_asset_holders WHERE asset_id=ANY($1::uuid[])', [
      intent.imageAssetIds,
    ]);
    await f.pool.query('DELETE FROM mio_assets WHERE id=ANY($1::uuid[])', [intent.imageAssetIds]);
    await f.start();
    await f.stop();
    const provider = await f.provider.get(f.actor);
    await f.provider.settings(f.actor, provider!.revision, { enabled: false });
    const readProvider = vi.spyOn(f.provider, 'snapshotImage');
    const service = await f.start();
    for (const { requestId, jobId } of retained) {
      await expect(service.createImage(f.actor, requestId, f.modelRef, intent)).resolves.toEqual({
        jobId,
        requestedCount: 1,
        status: 'accepted',
        errorCode: null,
        assetIds: [],
        outputs: [],
      });
    }
    const { requestId } = retained[0]!;
    await expect(
      service.createImage(f.actor, requestId, f.modelRef, {
        ...intent,
        geometry: { ...geometry, left: 64 },
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.createImage(f.actor, requestId, f.modelRef, {
        ...intent,
        imageAssetIds: intent.imageAssetIds.toReversed(),
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect(readProvider).not.toHaveBeenCalled();
    expect(f.objects.head).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    expect((await f.pool.query('SELECT id,input_hash FROM mio_image_jobs')).rows).toEqual(
      expect.arrayContaining(retained.map(({ jobId, hash }) => ({ id: jobId, input_hash: hash }))),
    );
    expect((await f.pool.query('SELECT id FROM mio_image_jobs')).rowCount).toBe(24);
    expect((await f.pool.query('SELECT job_id FROM mio_image_executions')).rowCount).toBe(0);
  } finally {
    await f.close();
  }
});

it('replays historically admitted null parameters over HTTP without admitting a new job', async () => {
  const f = await generationFixture();
  const { intent, images, retainLegacy } = await outpaintFixture(f);
  const { prompt, imageAssetIds } = intent;
  const retained = [
    {
      parameters: { prompt, operation: null },
      input: { prompt, operation: null },
    },
    {
      parameters: { prompt, operation: 'generate', imageAssetIds: null },
      input: { prompt, operation: 'generate' },
    },
    {
      parameters: { prompt, operation: null, imageAssetIds },
      input: { prompt, operation: 'edit', images },
    },
    {
      parameters: { prompt, operation: null, imageAssetIds, geometry },
      input: { prompt, operation: 'outpaint', images, geometry },
    },
  ];
  let actor = f.actor;
  const handle = createGenerationHandler(await f.start(), async () => actor, [
    'https://app.fixture',
  ]);
  const server = createServer((request, response) => void handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const post = async (requestId: string, parameters: Record<string, unknown>) => {
    const response = await fetch('http://127.0.0.1:' + address.port + '/api/v1/compute/images', {
      method: 'POST',
      headers: { origin: 'https://app.fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, modelRef: f.modelRef, parameters }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const previous = await Promise.all(
      retained.map(({ parameters, input }) => retainLegacy(randomUUID(), parameters, input)),
    );
    await f.pool.query('DELETE FROM mio_asset_holders WHERE asset_id=ANY($1::uuid[])', [
      imageAssetIds,
    ]);
    await f.pool.query('DELETE FROM mio_assets WHERE id=ANY($1::uuid[])', [imageAssetIds]);
    const provider = await f.provider.get(f.actor);
    await f.provider.settings(f.actor, provider!.revision, { enabled: false });
    const readProvider = vi.spyOn(f.provider, 'snapshotImage');
    const readAsset = vi.spyOn(f.store, 'imageInputs');
    for (const [index, { parameters }] of retained.entries()) {
      const { requestId, jobId } = previous[index]!;
      const retry = parameters.geometry
        ? { ...parameters, geometry: reorderedGeometry }
        : parameters;
      expect(await post(requestId, retry)).toMatchObject({ status: 202, body: { jobId } });
      expect(await post(randomUUID(), retry)).toMatchObject({
        status: 400,
        body: { error: { code: 'IMAGE_INPUT_INVALID' } },
      });
    }
    const { requestId } = previous[0]!;
    expect(await post(requestId, { prompt: 'changed prompt', operation: null })).toMatchObject({
      status: 409,
      body: { error: { code: 'REQUEST_CONFLICT' } },
    });
    actor = { ...actor, userId: randomUUID() };
    expect(await post(requestId, retained[0]!.parameters)).toMatchObject({
      status: 400,
      body: { error: { code: 'IMAGE_INPUT_INVALID' } },
    });
    expect(readProvider).not.toHaveBeenCalled();
    expect(readAsset).not.toHaveBeenCalled();
    expect(f.objects.head).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    expect((await f.pool.query('SELECT id FROM mio_image_jobs')).rowCount).toBe(previous.length);
    expect((await f.pool.query('SELECT job_id FROM mio_image_executions')).rowCount).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

it('matches a legacy winner committed after the initial replay lookup', async () => {
  const f = await generationFixture();
  try {
    const { intent, snapshot, retainLegacy } = await outpaintFixture(f);
    const reachedProvider = Promise.withResolvers<void>();
    const allowPreflight = Promise.withResolvers<ImageAdmissionSnapshot>();
    vi.spyOn(f.provider, 'snapshotImage').mockImplementationOnce(() => {
      reachedProvider.resolve();
      return allowPreflight.promise;
    });
    const create = createGenerationAdmission(f.store, f.files, f.objects.head, () => f.provider);
    const requestId = randomUUID();
    const concurrent = create(f.actor, requestId, f.modelRef, {
      ...intent,
      geometry: reorderedGeometry,
    });
    try {
      await Promise.race([reachedProvider.promise, concurrent]);
      const { jobId } = await retainLegacy(requestId, intent);
      allowPreflight.resolve(snapshot);
      await expect(concurrent).resolves.toMatchObject({ jobId });
      expect((await f.pool.query('SELECT id FROM mio_image_jobs')).rows).toEqual([{ id: jobId }]);
      expect((await f.pool.query('SELECT job_id FROM mio_image_executions')).rowCount).toBe(0);
    } finally {
      allowPreflight.resolve(snapshot);
      await Promise.allSettled([concurrent]);
    }
  } finally {
    await f.close();
  }
});

it('admits concurrent geometry key orders as one new job and submits once', async () => {
  const f = await generationFixture();
  try {
    const { snapshot, intent } = await outpaintFixture(f);
    vi.spyOn(f.provider, 'snapshotImage').mockResolvedValue(snapshot);
    const service = await f.start();
    const requestId = randomUUID();
    const [first, second] = await Promise.all([
      service.createImage(f.actor, requestId, f.modelRef, intent),
      service.createImage(f.actor, requestId, f.modelRef, {
        ...intent,
        geometry: reorderedGeometry,
      }),
    ]);
    expect(first.jobId).toBe(second.jobId);
    await vi.waitFor(async () =>
      expect((await service.getImage(f.actor, first.jobId)).status).toBe('completed'),
    );
    const completed = await service.getImage(f.actor, first.jobId);
    await expect(
      service.createImage(f.actor, requestId, f.modelRef, {
        ...intent,
        geometry: reorderedGeometry,
      }),
    ).resolves.toEqual(completed);
    await expect(
      service.createImage(f.actor, requestId, f.modelRef, {
        ...intent,
        imageAssetIds: intent.imageAssetIds.toReversed(),
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect(f.transport).toHaveBeenCalledTimes(1);
    const canonical = legacyHash(f.modelRef, {
      ...intent,
      geometry: { bottom: 8, left: 16, right: 32, top: 0 },
    });
    expect((await f.pool.query('SELECT id,input_hash FROM mio_image_jobs')).rows).toEqual([
      { id: first.jobId, input_hash: canonical },
    ]);
  } finally {
    await f.close();
  }
});
