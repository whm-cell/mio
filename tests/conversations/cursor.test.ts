import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createConversationHandler } from '../../src/conversations/http.ts';
import type { ConversationService } from '../../src/conversations/service.ts';

it('rejects invalid cursors before list and passes validated legacy and activity positions', async () => {
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
    const id = randomUUID();
    const updatedAt = '2026-11-23T00:00:00.123456Z';
    const encode = (value: { v: number; updatedAt: string; id: string }) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const cursor of [
      '',
      'malformed',
      encode({ v: 2, updatedAt, id }),
      encode({ v: 1, updatedAt, id: 'invalid-uuid' }),
      encode({ v: 1, updatedAt: '2026-02-30T00:00:00.123456Z', id }),
      encode({ v: 1, updatedAt: '0000-01-01T00:00:00.123456Z', id }),
    ]) {
      const response = await fetch(`${url}?after=${cursor}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'QUERY_INVALID' } });
    }
    expect(list).not.toHaveBeenCalled();
    expect((await fetch(url)).status).toBe(200);
    expect(list).toHaveBeenLastCalledWith(actor, undefined, 20);
    expect((await fetch(`${url}?after=${id}&limit=5`)).status).toBe(200);
    expect(list).toHaveBeenLastCalledWith(actor, { kind: 'legacy', id }, 5);
    const activity = encode({ v: 1, updatedAt, id });
    expect((await fetch(`${url}?after=${activity}`)).status).toBe(200);
    expect(list).toHaveBeenLastCalledWith(actor, { kind: 'activity', updatedAt, id }, 20);
    expect((await fetch(`${url}?purpose=audio`)).status).toBe(200);
    expect(list).toHaveBeenLastCalledWith(actor, undefined, 20, 'audio');
    expect((await fetch(`${url}?purpose=audio&after=${activity}&limit=5`)).status).toBe(200);
    expect(list).toHaveBeenLastCalledWith(actor, { kind: 'activity', updatedAt, id }, 5, 'audio');
    list.mockClear();
    for (const query of ['purpose=general', 'purpose=audio&purpose=audio', 'purpose=']) {
      const response = await fetch(`${url}?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'QUERY_INVALID' } });
    }
    expect(list).not.toHaveBeenCalled();
  } finally {
    await endpoint.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
