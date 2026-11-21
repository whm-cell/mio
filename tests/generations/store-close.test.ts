import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { GenerationStore } from '../../src/generations/store.ts';
import { createGenerationService } from '../../src/generations/service.ts';
import { generationFixture } from './fixture.ts';

it('only rewrites stale claims and interrupted queries after acquiring the executor lease', async () => {
  const f = await generationFixture();
  const contender = new GenerationStore(new Pool({ connectionString: f.database.url }));
  try {
    for (const [phase, claimed] of [
      ['ready', false],
      ['ready', true],
      ['submitting', true],
      ['waiting', false],
      ['querying', false],
      ['querying', true],
      ['materializing', false],
      ['materializing', true],
      ['done', true],
    ] as const) {
      const { jobId } = await f.admit();
      await f.pool.query('UPDATE mio_image_executions SET phase=$2,claim_id=$3 WHERE job_id=$1', [
        jobId,
        phase,
        claimed ? randomUUID() : null,
      ]);
    }
    const read = async () =>
      (
        await f.pool.query<{
          job_id: string;
          phase: string;
          claim_id: string | null;
          version: string;
        }>(
          'SELECT job_id,phase,claim_id,ctid::text AS version FROM mio_image_executions ORDER BY job_id',
        )
      ).rows;
    const before = await read();
    await f.store.startExecutor(() => {});
    const recovered = await read();
    for (const [index, row] of before.entries()) {
      const next = recovered[index]!;
      const changed = row.phase !== 'done' && (row.claim_id !== null || row.phase === 'querying');
      if (changed) {
        expect(next).toMatchObject({
          job_id: row.job_id,
          phase: row.phase === 'querying' ? 'waiting' : row.phase,
          claim_id: null,
        });
        expect(next.version).not.toBe(row.version);
      } else expect(next).toEqual(row);
    }
    await expect(contender.startExecutor(() => {})).rejects.toThrow(
      'GENERATION_EXECUTOR_ALREADY_RUNNING',
    );
    expect(await read()).toEqual(recovered);
    await f.stop();
    await f.store.startExecutor(() => {});
    expect(await read()).toEqual(recovered);
  } finally {
    await contender.close();
    await f.close();
  }
});

it.each([false, true])(
  'settles the owned pool through public close with lost executor=%s',
  async (lost) => {
    const f = await generationFixture();
    const pool = new Pool({ connectionString: f.database.url });
    const connected: PoolClient[] = [];
    pool.on('connect', (client) => connected.push(client));
    let service: Awaited<ReturnType<typeof createGenerationService>> | undefined;
    try {
      service = await createGenerationService(
        new GenerationStore(pool),
        f.objects,
        { dataDirectory: f.directory },
        () => f.provider,
      );
      if (lost) {
        const executor = connected[0]!;
        const pid = (await executor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]!.pid;
        const disconnected = once(executor, 'error');
        await f.pool.query('SELECT pg_terminate_backend($1)', [pid]);
        await disconnected;
      }
      const closing = service.close();
      expect(service.close()).toBe(closing);
      if (lost) await expect(closing).rejects.toThrow();
      else await expect(closing).resolves.toBeUndefined();
      expect(pool.totalCount).toBe(0);
      await expect(pool.query('SELECT 1')).rejects.toThrow('Cannot use a pool after calling end');
    } finally {
      await service?.close().catch(() => {});
      if (pool.totalCount) await pool.end();
      await f.close();
    }
  },
  15000,
);

it('preserves unlock, release and pool errors while attempting every cleanup', async () => {
  const unlock = new Error('unlock failed');
  const release = new Error('release failed');
  const end = new Error('end failed');
  const client = {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValue(unlock),
    on: vi.fn(),
    off: vi.fn(),
    release: vi.fn(() => {
      throw release;
    }),
  };
  const pool = {
    connect: async () => client,
    end: vi.fn().mockRejectedValue(end),
  };
  const store = new GenerationStore(pool as unknown as Pool);
  await store.startExecutor(() => {});
  await expect(store.close()).rejects.toMatchObject({ errors: [unlock, release, end] });
  expect(client.release).toHaveBeenCalledOnce();
  expect(pool.end).toHaveBeenCalledOnce();
});
