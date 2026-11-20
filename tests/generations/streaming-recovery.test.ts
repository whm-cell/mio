import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { generationFixture } from './fixture.ts';
import type { ImageResult } from '../../src/integrations/onelink/shared/index.ts';
import type { GenerationTransports } from '../../src/generations/runner.ts';

it.each(['last-query', 'expired', 'credentials', 'query-failed', 'processing-limit'] as const)(
  'materializes its durable prefix when subsequent querying cannot continue (%s)',
  async (failure) => {
    const f = await generationFixture('image-kling-v3');
    let credentialSpy: ReturnType<typeof vi.spyOn> | undefined;
    const image: ImageResult = { download: async (consume) => consume(new Response(f.bytes)) };
    const broken: ImageResult = {
      download: async (consume) =>
        consume(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('download interrupted'));
              },
            }),
          ),
        ),
    };
    f.asyncTransport.query.mockResolvedValueOnce({
      state: 'returned',
      upstreamTaskId: 'original-upstream-task',
      images: [image, broken],
    });
    const job = await f.admit(randomUUID(), 'durable partial stream', { async: true, n: 2 }, true);
    if (failure === 'last-query')
      await f.pool.query('UPDATE mio_image_jobs SET async_max_queries=1 WHERE id=$1', [job.jobId]);
    if (failure === 'processing-limit')
      await f.pool.query('UPDATE mio_image_jobs SET async_max_queries=2 WHERE id=$1', [job.jobId]);
    try {
      await f.start();
      await vi.waitFor(
        async () => {
          const saved = await f.files.load(
            job.jobId,
            (await f.pool.query('SELECT command FROM mio_image_jobs WHERE id=$1', [job.jobId]))
              .rows[0].command.messageId,
            2,
          );
          expect(saved?.checkpoint.images).toHaveLength(1);
        },
        { timeout: 5000 },
      );
      if (failure !== 'last-query') {
        await vi.waitFor(async () =>
          expect(
            (
              await f.pool.query('SELECT phase FROM mio_image_executions WHERE job_id=$1', [
                job.jobId,
              ])
            ).rows[0].phase,
          ).toBe('waiting'),
        );
        await f.stop();
        if (failure === 'credentials')
          credentialSpy = vi
            .spyOn(f.provider, 'resolveImageTaskCredential')
            .mockRejectedValue(new Error('credential removed'));
        if (failure === 'query-failed')
          f.asyncTransport.query.mockResolvedValue({
            state: 'unknown',
            code: 'IMAGE_QUERY_UNKNOWN',
          });
        if (failure === 'processing-limit')
          f.asyncTransport.query.mockResolvedValue({
            state: 'processing',
            upstreamTaskId: 'original-upstream-task',
          });
        await f.pool.query(
          "UPDATE mio_image_jobs SET next_query_at=now(),async_deadline=CASE WHEN $2 THEN now()-interval '1 second' ELSE async_deadline END WHERE id=$1",
          [job.jobId, failure === 'expired'],
        );
        await f.start();
      }
      await vi.waitFor(
        async () =>
          expect(
            (await f.pool.query('SELECT state FROM mio_image_jobs WHERE id=$1', [job.jobId]))
              .rows[0].state,
          ).toBe('materialization_failed'),
        { timeout: 10000 },
      );
      const outputs = await f.pool.query(
        'SELECT a.raw_key,a.owner_id FROM mio_image_outputs o JOIN mio_assets a ON a.id=o.asset_id WHERE o.job_id=$1',
        [job.jobId],
      );
      expect(outputs.rows).toHaveLength(1);
      expect(outputs.rows[0].owner_id).toBe(f.actor.userId);
      expect(f.stored.get(outputs.rows[0].raw_key)?.bytes).toEqual(f.bytes);
      expect(f.asyncTransport.submit).toHaveBeenCalledOnce();
      expect(f.asyncTransport.query).toHaveBeenCalledTimes(
        failure === 'query-failed' || failure === 'processing-limit' ? 2 : 1,
      );
    } finally {
      credentialSpy?.mockRestore();
      await f.close();
    }
  },
  15000,
);

it('recovers partial default Kling URL results through restart without resubmitting or redownloading saved indices', async () => {
  const f = await generationFixture('image-kling-v3');
  const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, options) =>
    options?.method === 'POST'
      ? Response.json({ code: 0, data: { task_id: 'original-task' } })
      : Response.json({
          code: 0,
          data: {
            task_id: 'original-task',
            task_status: 'succeed',
            task_result: {
              images: [
                { url: 'https://cdn.kling.example/first.png' },
                { url: 'https://cdn.kling.example/second.png' },
              ],
            },
          },
        }),
  );
  let interrupted = true;
  const downloaded = vi.fn();
  const download: NonNullable<GenerationTransports['download']> = async (url, _signal, consume) => {
    downloaded(url);
    if (String(url).endsWith('/second.png') && interrupted)
      throw new Error('second download interrupted');
    return consume(new Response(f.bytes));
  };
  const job = await f.admit(randomUUID(), 'default URL restart', { async: true, n: 2 }, true);
  try {
    await f.start({ transport, download });
    await vi.waitFor(
      async () => {
        expect(downloaded).toHaveBeenCalledTimes(2);
        expect(
          (
            await f.pool.query('SELECT phase FROM mio_image_executions WHERE job_id=$1', [
              job.jobId,
            ])
          ).rows[0].phase,
        ).toBe('waiting');
      },
      { timeout: 5000 },
    );
    await f.stop();
    interrupted = false;
    await f.pool.query('UPDATE mio_image_jobs SET next_query_at=now() WHERE id=$1', [job.jobId]);
    const service = await f.start({ transport, download });
    await vi.waitFor(
      async () => expect((await service.getImage(f.actor, job.jobId)).status).toBe('completed'),
      { timeout: 10000 },
    );
    const result = await service.getImage(f.actor, job.jobId);
    expect(result.outputs).toHaveLength(2);
    expect(downloaded.mock.calls.map(([url]) => String(url))).toEqual([
      'https://cdn.kling.example/first.png',
      'https://cdn.kling.example/second.png',
      'https://cdn.kling.example/second.png',
    ]);
    expect(transport.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
      1,
    );
    expect([...f.stored.values()].map((image) => image.bytes)).toEqual([f.bytes, f.bytes]);
  } finally {
    await f.close();
  }
}, 15000);
