import { once } from 'node:events';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { GenerationStore } from '../../src/generations/store.ts';
import { createGenerationService } from '../../src/generations/service.ts';
import { generationFixture } from './fixture.ts';

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
      .mockRejectedValue(unlock),
    on: vi.fn(),
    off: vi.fn(),
    release: vi.fn(() => {
      throw release;
    }),
  };
  const pool = {
    connect: async () => client,
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn().mockRejectedValue(end),
  };
  const store = new GenerationStore(pool as unknown as Pool);
  await store.startExecutor(() => {});
  await expect(store.close()).rejects.toMatchObject({ errors: [unlock, release, end] });
  expect(client.release).toHaveBeenCalledOnce();
  expect(pool.end).toHaveBeenCalledOnce();
});
