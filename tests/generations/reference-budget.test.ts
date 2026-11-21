import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createGenerationAdmission } from '../../src/generations/admission.ts';
import { createGenerationHandler } from '../../src/generations/http.ts';
import {
  IMAGE_MAX_REFERENCE_BYTES,
  IMAGE_MAX_TOTAL_REFERENCE_BYTES,
  type ImageRequestParameters,
} from '../../src/generations/contracts.ts';
import { generationFixture } from './fixture.ts';

type Fixture = Awaited<ReturnType<typeof generationFixture>>;
const MiB = 1024 * 1024;

/** Large rejected objects need only truthful metadata: reading any bytes is a test failure. */
async function declaredSources(f: Fixture, sizes: number[]) {
  const sources = await Promise.all(sizes.map(() => f.addImageSource()));
  for (const [index, source] of sources.entries()) {
    source.sizeBytes = sizes[index]!;
    await f.pool.query('UPDATE mio_assets SET size_bytes=$2 WHERE id=$1', [
      source.assetId,
      source.sizeBytes,
    ]);
  }
  vi.mocked(f.objects.head).mockImplementation(async (key) => {
    const source = sources.find((source) => source.key === key);
    if (!source) throw new Error('unexpected object');
    return { size: source.sizeBytes, etag: source.etag };
  });
  return sources;
}

it.each(['single image', 'mask', 'total references', 'repeated mask'] as const)(
  'rejects excessive %s through HTTP and tool admission before creating a job',
  async (kind) => {
    const f = await generationFixture();
    const service = await f.start();
    const handler = createGenerationHandler(service, async () => f.actor, ['https://fixture']);
    const server = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const create = vi.spyOn(f.store, 'imageCreate');
    try {
      const sizes =
        kind === 'single image'
          ? [16 * MiB + 1]
          : kind === 'mask'
            ? [1, 16 * MiB + 1]
            : kind === 'total references'
              ? [16 * MiB, 16 * MiB, 1]
              : [16 * MiB, 1];
      const sources = await declaredSources(f, sizes);
      const parameters: ImageRequestParameters = {
        prompt: 'bounded original references',
        operation: 'edit',
        ...(kind === 'mask'
          ? { imageAssetId: sources[0]!.assetId, maskAssetId: sources[1]!.assetId }
          : {
              imageAssetIds: sources.map((source) => source.assetId),
              ...(kind === 'repeated mask' ? { maskAssetId: sources[0]!.assetId } : {}),
            }),
      };
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/compute/images`, {
        method: 'POST',
        headers: { origin: 'https://fixture', 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: randomUUID(), modelRef: f.modelRef, parameters }),
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: { code: 'IMAGE_REFERENCE_LIMIT' } });
      await expect(
        service.createImage(f.actor, randomUUID(), f.modelRef, parameters, {
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ status: 413, code: 'IMAGE_REFERENCE_LIMIT' });
      expect(create).not.toHaveBeenCalled();
      expect((await f.pool.query('SELECT count(*) FROM mio_image_jobs')).rows[0].count).toBe('0');
      expect(f.objects.readImage).not.toHaveBeenCalled();
      expect(f.transport).not.toHaveBeenCalled();
      expect(f.asyncTransport.submit).not.toHaveBeenCalled();
    } finally {
      create.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.close();
    }
  },
);

it('accepts inclusive limits and preserves original reference order and repeated mask bytes', async () => {
  expect(IMAGE_MAX_REFERENCE_BYTES).toBe(16 * MiB);
  expect(IMAGE_MAX_TOTAL_REFERENCE_BYTES).toBe(32 * MiB);
  const f = await generationFixture();
  try {
    const first = Buffer.alloc(16 * MiB, 17);
    const second = Buffer.alloc(16 * MiB, 29);
    f.bytes.copy(first);
    f.bytes.copy(second);
    const sources = await Promise.all([f.addImageSource(first), f.addImageSource(second)]);
    const ordered = await f.admit(randomUUID(), 'ordered exact total', {
      operation: 'edit',
      imageAssetIds: sources.map((source) => source.assetId),
    });
    const masked = await f.admit(randomUUID(), 'mask counts twice', {
      operation: 'edit',
      imageAssetId: sources[0]!.assetId,
      maskAssetId: sources[0]!.assetId,
    });
    const service = await f.start();
    const single = await service.createImage(
      f.actor,
      randomUUID(),
      f.asyncModelRef,
      { prompt: 'single exact limit', imageAssetIds: [sources[0]!.assetId] },
      { signal: new AbortController().signal },
    );
    await vi.waitFor(
      async () => {
        for (const job of [ordered, masked, single])
          expect((await service.getImage(f.actor, job.jobId)).status).toBe('completed');
      },
      { timeout: 6000 },
    );
    const forms = f.transport.mock.calls.map(([, options]) => options!.body as FormData);
    const orderedForm = forms.find((form) => form.get('prompt') === 'ordered exact total')!;
    const orderedFiles = orderedForm.getAll('image[]') as File[];
    expect(orderedFiles).toHaveLength(2);
    for (const [index, expected] of [first, second].entries())
      expect(Buffer.from(await orderedFiles[index]!.arrayBuffer()).equals(expected)).toBe(true);
    const maskForm = forms.find((form) => form.get('prompt') === 'mask counts twice')!;
    for (const field of ['image', 'mask'])
      expect(Buffer.from(await (maskForm.get(field) as File).arrayBuffer()).equals(first)).toBe(
        true,
      );
    expect(f.asyncTransport.submit).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
}, 15000);

it('finishes historical oversized ready jobs before reads or submission and never retries them', async () => {
  const f = await generationFixture();
  const submitting = vi.spyOn(f.store, 'submitting');
  const release = vi.spyOn(f.store, 'release');
  const claim = vi.spyOn(f.store, 'claim');
  try {
    const source = await f.addImageSource();
    const otherSources = await Promise.all([f.addImageSource(), f.addImageSource()]);
    const jobs: { jobId: string }[] = [];
    for (const kind of ['single', 'mask', 'total', 'async', 'expired'] as const) {
      const job = await f.admit(
        randomUUID(),
        kind,
        kind === 'async'
          ? { operation: 'generate', async: true, imageAssetIds: [source.assetId] }
          : { operation: 'edit', imageAssetId: source.assetId },
        kind === 'async',
      );
      const over = { ...source, sizeBytes: 16 * MiB + 1 };
      const input =
        kind === 'mask'
          ? { image: source, mask: over }
          : kind === 'total'
            ? {
                image: undefined,
                images: [
                  { ...source, sizeBytes: 16 * MiB },
                  { ...otherSources[0]!, sizeBytes: 16 * MiB },
                  { ...otherSources[1]!, sizeBytes: 1 },
                ],
              }
            : kind === 'async'
              ? { images: [over] }
              : { image: over };
      const { command } = (
        await f.pool.query('SELECT command FROM mio_image_jobs WHERE id=$1', [job.jobId])
      ).rows[0];
      command.input = { ...command.input, ...input };
      if (kind === 'expired') command.expiresAt = Date.now() - 1000;
      await f.pool.query('UPDATE mio_image_jobs SET command=$2 WHERE id=$1', [job.jobId, command]);
      jobs.push(job);
    }
    const service = await f.start();
    await vi.waitFor(
      async () => {
        for (const job of jobs)
          expect(await service.getImage(f.actor, job.jobId)).toMatchObject({
            status: 'rejected',
            errorCode: 'IMAGE_REFERENCE_LIMIT',
          });
        expect(claim.mock.calls.length).toBeGreaterThan(jobs.length + 1);
      },
      { timeout: 6000 },
    );
    expect((await f.pool.query('SELECT DISTINCT phase FROM mio_image_executions')).rows).toEqual([
      { phase: 'done' },
    ]);
    expect(submitting).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    await f.stop();
    const restartedClaim = vi.spyOn(f.store, 'claim');
    await f.start();
    await vi.waitFor(() => expect(restartedClaim.mock.calls.length).toBeGreaterThan(1), {
      timeout: 3000,
    });
    expect(await f.store.claim()).toBeUndefined();
    expect(f.objects.readImage).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.asyncTransport.submit).not.toHaveBeenCalled();
    expect(f.asyncTransport.query).not.toHaveBeenCalled();
    restartedClaim.mockRestore();
  } finally {
    submitting.mockRestore();
    release.mockRestore();
    claim.mockRestore();
    await f.close();
  }
}, 15000);

it('replays an admitted request before current reference-budget and provider preflight', async () => {
  const f = await generationFixture();
  try {
    const source = await f.addImageSource();
    const requestId = randomUUID();
    const parameters = {
      prompt: 'old request',
      operation: 'edit' as const,
      imageAssetId: source.assetId,
    };
    const job = await f.admit(requestId, parameters.prompt, parameters);
    await f.pool.query('UPDATE mio_assets SET size_bytes=$2 WHERE id=$1', [
      source.assetId,
      16 * MiB + 1,
    ]);
    const snapshot = vi.spyOn(f.provider, 'snapshotImage').mockRejectedValue(new Error('offline'));
    const create = createGenerationAdmission(f.store, f.files, f.objects.head, () => f.provider);
    for (const tool of [undefined, { signal: new AbortController().signal }])
      expect((await create(f.actor, requestId, f.modelRef, parameters, tool)).jobId).toBe(
        job.jobId,
      );
    expect(snapshot).not.toHaveBeenCalled();
    snapshot.mockRestore();
  } finally {
    await f.close();
  }
});

it('keeps oversized frozen inputs out of waiting, unknown and durable-result recovery decisions', async () => {
  const f = await generationFixture();
  try {
    const source = await f.addImageSource();
    const jobs: { jobId: string; phase: string }[] = [];
    for (const phase of ['submitting', 'receipt', 'materializing', 'waiting'] as const) {
      const job = await f.admit(
        randomUUID(),
        phase,
        phase === 'waiting'
          ? { operation: 'generate', async: true, imageAssetIds: [source.assetId] }
          : { operation: 'edit', imageAssetId: source.assetId },
        phase === 'waiting',
      );
      await f.pool.query(`UPDATE mio_image_jobs SET command=jsonb_set(command,$2,$3) WHERE id=$1`, [
        job.jobId,
        phase === 'waiting' ? '{input,images,0,sizeBytes}' : '{input,image,sizeBytes}',
        JSON.stringify(16 * MiB + 1),
      ]);
      const row = (await f.store.claim())!;
      expect(row.id).toBe(job.jobId);
      expect(await f.store.submitting(row)).toBe(true);
      if (phase === 'waiting') await f.store.submitted(row, 'original-task');
      if (phase === 'receipt' || phase === 'materializing') {
        const saved = await f.files.receive(
          row.id,
          row.command.messageId,
          1,
          [{ base64: f.bytes.toString('base64') }],
          'png',
        );
        if (phase === 'materializing') expect(await f.store.checkpoint(row, saved.ref)).toBe(true);
      }
      jobs.push({ ...job, phase });
    }
    const service = await f.start();
    await vi.waitFor(
      async () => {
        for (const job of jobs)
          expect((await service.getImage(f.actor, job.jobId)).status).toBe(
            job.phase === 'submitting' ? 'unknown' : 'completed',
          );
      },
      { timeout: 6000 },
    );
    expect(f.objects.readImage).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.asyncTransport.submit).not.toHaveBeenCalled();
    expect(f.asyncTransport.query).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
}, 15000);
