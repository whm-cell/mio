import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createCreationLogHandler } from '../../src/notifications/creation-http.ts';
import type { CreationLogStore } from '../../src/notifications/creation-store.ts';

async function cursorRequest(occurredAt: string) {
  const list = vi
    .fn<CreationLogStore['list']>()
    .mockResolvedValue({ items: [], page: 2, pageSize: 10, hasMore: false, nextCursor: null });
  const handler = createCreationLogHandler(
    { list } as unknown as CreationLogStore,
    async () => ({ userId: 'cursor-owner' }),
    [],
  );
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  const cursor = { occurredAt, id: 'aaaaaaaa-0000-4000-8000-000000000001' };
  try {
    const encoded = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/notifications?type=creation_log&page=2&cursor=${encoded}`,
    );
    return { status: response.status, body: await response.json(), list, cursor };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it.each([
  '2026-02-29T01:02:03.123Z',
  '2026-02-31T01:02:03.123456Z',
  '2026-04-31T01:02:03.123Z',
  '2100-02-29T01:02:03.123456Z',
  '2026-01-01T24:00:00.000Z',
  '0000-01-01T01:02:03.123Z',
])('rejects impossible calendar cursor %s before touching the store', async (occurredAt) => {
  const result = await cursorRequest(occurredAt);
  expect(result.list).not.toHaveBeenCalled();
  expect(result.status).toBe(400);
  expect(result.body).toMatchObject({ error: { code: 'QUERY_INVALID' } });
});
it.each(['2024-02-29T01:02:03.123Z', '2000-02-29T01:02:03.123456Z'])(
  'preserves valid leap day and fractional cursor %s without precision loss',
  async (occurredAt) => {
    const result = await cursorRequest(occurredAt);
    expect(result.status).toBe(200);
    expect(result.list).toHaveBeenCalledExactlyOnceWith('cursor-owner', 2, 10, result.cursor);
  },
);
