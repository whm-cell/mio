import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { ComputeStore } from '../../src/compute/store.ts';
import { generationFixture } from '../generations/fixture.ts';

it('runs 15 images through A while ten video jobs occupy the independent B admission quota', async () => {
  const f = await generationFixture();
  const video = new ComputeStore(new Pool({ connectionString: f.database.url }));
  const releases: (() => void)[] = [];
  let active = 0;
  let maximum = 0;
  try {
    await f.pool.query(computeSchemaSQL);
    const assetId = randomUUID();
    const key = 'mio/raw/' + assetId + '/' + randomUUID();
    await f.pool.query(
      "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at) VALUES($1,$2,'video','video/mp4',3,$3,$4,'ready',now())",
      [assetId, f.actor.userId, 'mio/staging/' + assetId, key],
    );
    await Promise.all(
      Array.from({ length: 10 }, () =>
        video.create(f.actor.userId, randomUUID(), assetId, key, 3, 'etag'),
      ),
    );
    await expect(
      video.create(f.actor.userId, randomUUID(), assetId, key, 3, 'etag'),
    ).rejects.toMatchObject({ code: 'COMPUTE_QUOTA_EXCEEDED' });
    f.transport.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise<void>((resolve) => releases.push(resolve));
        return Response.json({ data: [{ b64_json: f.bytes.toString('base64') }] });
      } finally {
        active--;
      }
    });
    await f.start();
    const jobs = await Promise.all(
      Array.from({ length: 15 }, (_, index) =>
        f.service.createImage(f.actor, randomUUID(), f.modelRef, { prompt: 'parallel ' + index }),
      ),
    );
    await vi.waitFor(() => expect(releases.length).toBe(4));
    expect(maximum).toBe(4);
    // Client queries remain available while all four image outbound permits are held.
    expect((await f.service.getImage(f.actor, jobs[0]!.jobId)).status).toBe('accepted');
    for (let index = 0; index < 15; index++) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(index), { timeout: 6000 });
      releases[index]!();
    }
    await vi.waitFor(
      async () =>
        expect(
          (await Promise.all(jobs.map((job) => f.service.getImage(f.actor, job.jobId)))).every(
            (job) => job.status === 'completed',
          ),
        ).toBe(true),
      { timeout: 6000 },
    );
    expect(f.transport).toHaveBeenCalledTimes(15);
    expect(maximum).toBeLessThanOrEqual(4);
    expect((await f.pool.query('SELECT count(*) FROM mio_compute_jobs')).rows[0].count).toBe('10');
    await f.stop();
    await f.start();
    expect(f.transport).toHaveBeenCalledTimes(15);
  } finally {
    for (const release of releases) release();
    await video.close();
    await f.close();
  }
}, 20000);
