import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Principal } from '../../src/conversations/contracts.ts';
import { createConversationHandler } from '../../src/conversations/http.ts';
import type { ConversationService } from '../../src/conversations/service.ts';

const actor = { userId: 'stream-owner', sessionId: 'initial-session' };

async function openStream(recheck: () => Promise<Principal | null>) {
  const id = randomUUID();
  const unsubscribe = vi.fn();
  const subscribe: ConversationService['subscribe'] = async () => ({
    snapshot: { conversationId: id, activeRequestId: null, receipt: null },
    close: unsubscribe,
  });
  const service = { subscribe } as ConversationService;
  const identity = vi.fn(recheck).mockResolvedValueOnce(actor);
  const endpoint = createConversationHandler(service, identity, []);
  const request = new IncomingMessage(new Socket());
  request.url = `/api/v1/conversations/${id}/events`;
  request.method = 'GET';
  const response = new ServerResponse(request);
  const write = vi.spyOn(response, 'write');
  await endpoint.handler(request, response);
  expect(response.statusCode).toBe(200);
  expect(write.mock.calls[0]?.[0]).toContain('event: snapshot');
  return { identity, unsubscribe, response, write, close: endpoint.close };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each(['resolve', 'reject'] as const)(
  'ends the stream after the authentication budget and ignores a late %s',
  async (outcome) => {
    const pending = Promise.withResolvers<Principal | null>();
    const stream = await openStream(() => pending.promise);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stream.identity).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(stream.response.writableEnded).toBe(false);
      expect(stream.identity).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(stream.response.writableEnded).toBe(true);
      expect(stream.write.mock.calls[1]?.[0]).toContain('"code":"AUTH_UNAVAILABLE"');
      expect(stream.unsubscribe).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);

      if (outcome === 'resolve') pending.resolve(actor);
      else pending.reject(new Error('late fixture error'));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stream.write).toHaveBeenCalledTimes(2);
      expect(stream.identity).toHaveBeenCalledTimes(2);
      expect(stream.unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve(actor);
      stream.close();
    }
  },
);

it.each(['client close', 'handler shutdown'] as const)(
  'releases the pending verification deadline on %s',
  async (source) => {
    const pending = Promise.withResolvers<Principal | null>();
    const stream = await openStream(() => pending.promise);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stream.identity).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(2);
      if (source === 'client close') stream.response.emit('close');
      else stream.close();
      expect(stream.unsubscribe).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      pending.reject(new Error('fixture error after close'));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stream.write).toHaveBeenCalledTimes(1);
      expect(stream.unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve(actor);
      stream.close();
    }
  },
);

it.each([
  ['expired', async (): Promise<Principal | null> => null, 'UNAUTHORIZED'],
  ['a new session', async () => ({ ...actor, sessionId: 'another-session' }), 'UNAUTHORIZED'],
  ['a new user', async () => ({ ...actor, userId: 'another-owner' }), 'UNAUTHORIZED'],
  [
    'an error',
    async () => {
      throw new Error('private fixture detail');
    },
    'AUTH_UNAVAILABLE',
  ],
] as const)('closes immediately when verification returns %s', async (_case, identity, code) => {
  const stream = await openStream(identity);
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stream.response.writableEnded).toBe(true);
    expect(stream.write.mock.calls[1]?.[0]).toContain(`"code":"${code}"`);
    expect(stream.write.mock.calls[1]?.[0]).not.toContain('private fixture detail');
    expect(stream.unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    stream.close();
  }
});
