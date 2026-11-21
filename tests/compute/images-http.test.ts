import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createGenerationHandler } from '../../src/generations/http.ts';
import { generationFixture } from '../generations/fixture.ts';

it('preserves HTTP paths, closed input, origin checks, preflight and session recheck', async () => {
  const f = await generationFixture();
  const service = await f.start();
  let checks = 0;
  let revoked = false;
  const handler = createGenerationHandler(service, async () => {
    checks++;
    return revoked && checks % 2 === 0 ? null : f.actor;
  }, ['https://app.fixture']);
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const base = 'http://127.0.0.1:' + address.port + '/api/v1/compute/images';
  const post = (value: unknown, origin = 'https://app.fixture') =>
    fetch(base, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  const input = {
    requestId: randomUUID(),
    modelRef: f.modelRef,
    parameters: { prompt: 'fixture' },
  };
  try {
    expect((await post(input, 'https://untrusted.fixture')).status).toBe(403);
    expect(
      (
        await fetch(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect((await post({ ...input, ownerId: 'other' })).status).toBe(400);
    expect(
      (await post({ ...input, parameters: { prompt: 'fixture', apiKey: 'model-key' } })).status,
    ).toBe(400);
    expect((await fetch(base + '?ownerId=other')).status).toBe(400);
    expect(
      (await fetch(base, { method: 'OPTIONS', headers: { origin: 'https://app.fixture' } })).status,
    ).toBe(204);
    expect((await fetch(base)).status).toBe(405);
    checks = 0;
    revoked = true;
    expect((await post(input)).status).toBe(401);
    expect(f.transport).not.toHaveBeenCalled();
    expect((await f.pool.query('SELECT count(*) FROM mio_image_jobs')).rows[0].count).toBe('0');
    revoked = false;
    const readPrevious = vi.spyOn(f.store, 'imageRequest');
    const readRoute = vi.spyOn(f.provider, 'snapshotImage');
    const readAsset = vi.spyOn(f.store, 'imageInput');
    const invalidShapes = [
      { n: { count: 1 } },
      { size: ['1024x1024'] },
      { imageAssetIds: [[randomUUID()]] },
      { imageAssetIds: null },
      { operation: null, imageAssetIds: null },
      { operation: 'generate', imageAssetIds: null, imageAssetId: randomUUID() },
      { operation: null, imageAssetIds: ['invalid-asset-id'] },
      {
        imageAssetId: randomUUID(),
        geometry: { left: { pixels: 16 }, top: 0, right: 0, bottom: 0 },
      },
    ];
    for (const invalid of invalidShapes) {
      const response = await post({ ...input, parameters: { ...input.parameters, ...invalid } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'IMAGE_INPUT_INVALID' } });
    }
    expect(readPrevious).not.toHaveBeenCalled();
    expect(readRoute).not.toHaveBeenCalled();
    expect(readAsset).not.toHaveBeenCalled();
    const accepted = await post(input);
    expect(accepted.status).toBe(202);
    const job = await accepted.json();
    await vi.waitFor(async () =>
      expect((await service.getImage(f.actor, job.jobId)).status).toBe('completed'),
    );
    const view = await (await fetch(base + '/' + job.jobId)).json();
    expect(view.assetIds).toHaveLength(1);
    expect(Object.keys(view).sort()).toEqual([
      'assetIds',
      'errorCode',
      'jobId',
      'outputs',
      'requestedCount',
      'status',
    ]);
    expect(
      (
        await fetch(base + '/' + job.jobId + '/recover', {
          method: 'POST',
          headers: { origin: 'https://app.fixture', 'content-type': 'application/json' },
          body: '{"credential":"bad"}',
        })
      ).status,
    ).toBe(400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

it('persists query identity/count/schedule and resumes with a current Key without another submission', async () => {
  const f = await generationFixture();
  try {
    f.asyncTransport.query.mockResolvedValueOnce({
      state: 'processing',
      upstreamTaskId: 'original-upstream-task',
    });
    await f.start();
    const job = await f.service.createImage(f.actor, randomUUID(), f.asyncModelRef, {
      prompt: 'async recovery',
      async: true,
    });
    await vi.waitFor(
      async () => expect((await f.service.getImage(f.actor, job.jobId)).status).toBe('processing'),
      { timeout: 6000 },
    );
    const row = (
      await f.pool.query(
        'SELECT upstream_task_id,query_attempt,next_query_at,async_deadline FROM mio_image_jobs WHERE id=$1',
        [job.jobId],
      )
    ).rows[0];
    expect(row.upstream_task_id).toBe('original-upstream-task');
    expect(row.query_attempt).toBe(1);
    expect(row.next_query_at.getTime()).toBeLessThan(row.async_deadline.getTime());
    const schedule = row.next_query_at.getTime();
    await Promise.all([
      f.service.recoverImage(f.actor, job.jobId),
      f.service.recoverImage(f.actor, job.jobId),
    ]);
    expect(
      (
        await f.pool.query('SELECT next_query_at FROM mio_image_jobs WHERE id=$1', [job.jobId])
      ).rows[0].next_query_at.getTime(),
    ).toBe(schedule);
    await f.stop();
    const provider = await f.provider.get(f.actor);
    await f.provider.save(f.actor, provider!.revision, 'current-query-key');
    await f.pool.query('UPDATE mio_image_jobs SET next_query_at=now() WHERE id=$1', [job.jobId]);
    await f.start();
    await vi.waitFor(
      async () => expect((await f.service.getImage(f.actor, job.jobId)).status).toBe('completed'),
      { timeout: 6000 },
    );
    expect(f.asyncTransport.submit).toHaveBeenCalledTimes(1);
    expect(f.asyncTransport.query).toHaveBeenCalledTimes(2);
    expect(f.asyncTransport.query.mock.calls[1]![1]).toBe('current-query-key');
    expect(f.asyncTransport.query.mock.calls.map((call) => call[2])).toEqual([
      'original-upstream-task',
      'original-upstream-task',
    ]);
    expect(
      (
        await f.pool.query('SELECT query_attempt,next_query_at FROM mio_image_jobs WHERE id=$1', [
          job.jobId,
        ])
      ).rows[0],
    ).toMatchObject({ query_attempt: 2, next_query_at: null });
  } finally {
    await f.close();
  }
});

it('permits manual query recovery only for a known upstream task within its persisted bounds', async () => {
  const f = await generationFixture();
  try {
    const job = await f.admit(randomUUID(), 'known recovery', { async: true }, true);
    const row = (await f.store.claim())!;
    await f.store.submitted(row, 'original-upstream-task');
    await f.pool.query(
      "UPDATE mio_image_jobs SET state='unknown',error_code='IMAGE_CREDENTIAL_UNAVAILABLE',query_attempt=1 WHERE id=$1",
      [job.jobId],
    );
    await f.pool.query("UPDATE mio_image_executions SET phase='done' WHERE job_id=$1", [job.jobId]);
    await f.store.imageRecover(f.actor.userId, job.jobId);
    expect((await f.store.imageGet(f.actor.userId, job.jobId)).status).toBe('processing');
    await f.pool.query(
      "UPDATE mio_image_jobs SET state='failed',query_attempt=async_max_queries WHERE id=$1",
      [job.jobId],
    );
    await expect(f.store.imageRecover(f.actor.userId, job.jobId)).rejects.toMatchObject({
      code: 'RESULT_CONFLICT',
    });
    await f.pool.query(
      "UPDATE mio_image_jobs SET query_attempt=1,async_deadline=now()-interval '1 second' WHERE id=$1",
      [job.jobId],
    );
    await expect(f.store.imageRecover(f.actor.userId, job.jobId)).rejects.toMatchObject({
      code: 'RESULT_CONFLICT',
    });
    await expect(f.store.imageRecover('other', job.jobId)).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });
    expect(f.asyncTransport.submit).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
