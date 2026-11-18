import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createGenerationAdmission } from '../../src/generations/admission.ts';
import { validateImageRouteConfig } from '../../src/generations/contracts.ts';
import { ProviderError } from '../../src/providers/contracts.ts';
import type { ImageAdmissionSnapshot } from '../../src/providers/contracts.ts';
import { generationFixture } from '../generations/fixture.ts';

it('replays a retained tool job using its original parameters after reopening the store', async () => {
  const f = await generationFixture();
  try {
    const requestId = randomUUID();
    const assetId = randomUUID();
    const key = `mio/raw/${assetId}/${randomUUID()}`;
    f.stored.set(key, {
      bytes: f.bytes,
      etag: 'original-fixture',
      sha256: createHash('sha256').update(f.bytes).digest('hex'),
    });
    await f.pool.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,raw_key,state,expires_at)
       VALUES($1,$2,'example.png','image/png',$3,$4,'ready',now()+interval '1 hour')`,
      [assetId, f.actor.userId, f.bytes.length, key],
    );
    const intent = { prompt: 'work saved by the old tool', imageAssetIds: [assetId] };
    const oldParameters = { ...intent, async: true, operation: 'generate' } as const;
    const old = await f.admit(requestId, intent.prompt, oldParameters, true);
    // Older rows retain their route only inside the frozen command.
    await f.pool.query('UPDATE mio_image_jobs SET route_snapshot=NULL WHERE id=$1', [old.jobId]);
    await f.stop();

    const provider = await f.provider.get(f.actor);
    await f.provider.settings(f.actor, provider!.revision, { enabled: false });
    const readProvider = vi.spyOn(f.provider, 'snapshotImage');
    vi.mocked(f.objects.head).mockClear();
    const create = createGenerationAdmission(f.store, f.files, f.objects.head, () => f.provider);
    const tool = { signal: new AbortController().signal };
    await expect(create(f.actor, requestId, f.asyncModelRef, intent, tool)).resolves.toEqual(old);
    await expect(create(f.actor, requestId, f.asyncModelRef, oldParameters, tool)).resolves.toEqual(
      old,
    );
    await expect(
      create(f.actor, requestId, f.asyncModelRef, { ...intent, async: false }, tool),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(create(f.actor, requestId, f.asyncModelRef, intent)).rejects.toMatchObject({
      code: 'REQUEST_CONFLICT',
    });
    await expect(create(f.actor, requestId, f.asyncModelRef, oldParameters)).resolves.toEqual(old);
    expect(readProvider).not.toHaveBeenCalled();
    expect(f.objects.head).not.toHaveBeenCalled();
    expect((await f.pool.query('SELECT id FROM mio_image_jobs')).rows).toEqual([{ id: old.jobId }]);
  } finally {
    await f.close();
  }
});

it.each(['route change', 'provider disabled'] as const)(
  'compares concurrent retries against the recorded winner after %s',
  async (change) => {
    const f = await generationFixture();
    try {
      const frozen = await f.provider.snapshotImage(f.actor, f.asyncModelRef);
      const changed = {
        ...frozen,
        route: {
          ...frozen.route,
          requiresAsync: false,
          paramSpec: { ...frozen.route.paramSpec, requiresAsync: false },
        },
      };
      expect(validateImageRouteConfig(changed.route)).toBe(true);
      const firstLookup = Promise.withResolvers<void>();
      const secondLookup = Promise.withResolvers<void>();
      const firstRoute = Promise.withResolvers<ImageAdmissionSnapshot>();
      const secondRoute = Promise.withResolvers<ImageAdmissionSnapshot>();
      vi.spyOn(f.provider, 'snapshotImage')
        .mockImplementationOnce(() => {
          firstLookup.resolve();
          return firstRoute.promise;
        })
        .mockImplementationOnce(() => {
          secondLookup.resolve();
          return secondRoute.promise;
        });
      const create = createGenerationAdmission(f.store, f.files, f.objects.head, () => f.provider);
      const requestId = randomUUID();
      const tool = { signal: new AbortController().signal };
      const intent = { prompt: 'two submits for the same saved intent' };
      const first = create(f.actor, requestId, f.asyncModelRef, intent, tool);
      let second: Promise<Awaited<typeof first>> | undefined;
      try {
        await Promise.race([first, firstLookup.promise]);
        second = create(f.actor, requestId, f.asyncModelRef, intent, tool);
        await Promise.race([second, secondLookup.promise]);
        firstRoute.resolve(frozen);
        const job = await first;
        if (change === 'route change') secondRoute.resolve(changed);
        else secondRoute.reject(new ProviderError(409, 'PROVIDER_DISABLED'));
        await expect(second).resolves.toEqual(job);
        expect((await f.pool.query('SELECT id FROM mio_image_jobs')).rows).toEqual([
          { id: job.jobId },
        ]);
      } finally {
        firstRoute.resolve(frozen);
        secondRoute.resolve(changed);
        await Promise.allSettled([first, second]);
      }
    } finally {
      await f.close();
    }
  },
);

it('keeps a cancelled tool from admitting a job after route lookup completes', async () => {
  const f = await generationFixture();
  try {
    const controller = new AbortController();
    const frozen = await f.provider.snapshotImage(f.actor, f.asyncModelRef);
    vi.spyOn(f.provider, 'snapshotImage').mockImplementationOnce(async () => {
      controller.abort();
      return frozen;
    });
    const create = createGenerationAdmission(f.store, f.files, f.objects.head, () => f.provider);
    await expect(
      create(
        f.actor,
        randomUUID(),
        f.asyncModelRef,
        { prompt: 'cancelled tool' },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect((await f.pool.query('SELECT id FROM mio_image_jobs')).rowCount).toBe(0);
  } finally {
    await f.close();
  }
});
