import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createConversationHandler } from '../../src/conversations/http.ts';
import type { ConversationService } from '../../src/conversations/service.ts';

it('rejects present empty or malformed cursors before list while allowing missing and UUID cursors', async () => {
  const actor = { userId: 'cursor-owner', sessionId: 'cursor-session' };
  const list = vi
    .fn<ConversationService['list']>()
    .mockResolvedValue({ items: [], nextAfter: null });
  const endpoint = createConversationHandler(
    { list } as unknown as ConversationService,
    async () => actor,
    [],
  );
  const server = createServer(endpoint.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
  const url = `http://127.0.0.1:${address.port}/api/v1/conversations`;
  try {
    for (const cursor of ['', 'malformed']) {
      const response = await fetch(`${url}?after=${cursor}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'QUERY_INVALID' } });
    }
    expect(list).not.toHaveBeenCalled();
    expect((await fetch(url)).status).toBe(200);
    expect(list).toHaveBeenLastCalledWith(actor, undefined, 20);
    const cursor = randomUUID();
    expect((await fetch(`${url}?after=${cursor}&limit=5`)).status).toBe(200);
    expect(list).toHaveBeenLastCalledWith(actor, cursor, 5);
  } finally {
    await endpoint.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
