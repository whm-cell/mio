import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Principal } from '../../src/conversations/contracts.ts';
import { createConversationHandler } from '../../src/conversations/http.ts';
import type { ConversationService } from '../../src/conversations/service.ts';
import { createConversationService } from '../../src/conversations/service.ts';
import type { ConversationStore } from '../../src/conversations/store.ts';
import { ConversationError } from '../../src/conversations/contracts.ts';
import type { ConversationEngine } from '../../src/conversations/contracts.ts';

const actor = { userId: 'stream-owner', sessionId: 'initial-session' };

async function openStream(recheck: () => Promise<Principal | null>) {
  const id = randomUUID();
  const unsubscribe = vi.fn();
  const subscribed = vi.fn<ConversationService['subscribe']>().mockResolvedValue({
    snapshot: { conversationId: id, activeRequestId: null, receipt: null },
    close: unsubscribe,
  });
  const subscribe: ConversationService['subscribe'] = subscribed;
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
  return {
    identity,
    unsubscribe,
    response,
    write,
    publish: subscribed.mock.calls[0]![2],
    close: endpoint.close,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function streamHarness(service?: ConversationService) {
  const principals = new Map<string, Principal>([['owner', actor]]);
  const verify = async (headers: Headers) => principals.get(headers.get('cookie') ?? '') ?? null;
  const identity = vi.fn(verify);
  const subscribed = vi
    .fn<ConversationService['subscribe']>()
    .mockImplementation(async (_actor, id) => ({
      snapshot: { conversationId: id, activeRequestId: null, receipt: null },
      close: vi.fn(),
    }));
  const endpoint = createConversationHandler(
    service ?? ({ subscribe: subscribed } as unknown as ConversationService),
    identity,
    [],
  );
  const begin = (cookie = 'owner', options: { method?: string; origin?: string } = {}) => {
    const request = new IncomingMessage(new Socket());
    request.url = `/api/v1/conversations/${randomUUID()}/events`;
    request.method = options.method ?? 'GET';
    request.headers.cookie = cookie;
    if (options.origin) request.headers.origin = options.origin;
    const response = new ServerResponse(request);
    const write = vi.spyOn(response, 'write');
    const end = vi.spyOn(response, 'end');
    const done = endpoint.handler(request, response);
    return { request, response, write, end, done };
  };
  return {
    principals,
    identity,
    verify,
    subscribed,
    begin,
    async open(cookie = 'owner') {
      const stream = begin(cookie);
      await stream.done;
      return stream;
    },
    close: endpoint.close,
  };
}

it('shares fresh checks for staggered streams and chooses a remaining member after the first exits', async () => {
  const h = streamHarness();
  h.principals.set('alternate-cookie', actor);
  try {
    const first = await h.open();
    await vi.advanceTimersByTimeAsync(150);
    const second = await h.open('alternate-cookie');
    await vi.advanceTimersByTimeAsync(150);
    const third = await h.open();
    expect(h.identity).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(h.identity).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.identity).toHaveBeenCalledTimes(5);
    first.response.emit('close');
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.identity).toHaveBeenCalledTimes(6);
    expect(h.identity.mock.lastCall![0].get('cookie')).toBe('alternate-cookie');
    h.principals.delete('alternate-cookie');
    await vi.advanceTimersByTimeAsync(1000);
    for (const stream of [second, third]) {
      expect(stream.response.writableEnded).toBe(true);
      expect(stream.write.mock.lastCall![0]).toContain('UNAUTHORIZED');
    }
    expect(vi.getTimerCount()).toBe(0);
    for (const result of h.subscribed.mock.results)
      expect((await result.value).close).toHaveBeenCalledOnce();
  } finally {
    h.close();
  }
});

it('reserves the first 64 unauthenticated opens before awaits and releases timeout/disconnect capacity', async () => {
  const h = streamHarness();
  const pending = Promise.withResolvers<Principal | null>();
  h.identity.mockImplementation(() => pending.promise);
  const streams = Array.from({ length: 65 }, () => h.begin());
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(h.identity).toHaveBeenCalledTimes(64);
    expect(streams[64]!.response.statusCode).toBe(429);
    expect(streams[64]!.end.mock.lastCall![0]).toContain('SSE_LIMITED');
    expect(h.subscribed).not.toHaveBeenCalled();
    streams[0]!.response.emit('close');
    const replacement = h.begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.identity).toHaveBeenCalledTimes(65);
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([...streams.map((stream) => stream.done), replacement.done]);
    expect(replacement.response.statusCode).toBe(503);
    expect(replacement.end.mock.lastCall![0]).toContain('AUTH_UNAVAILABLE');
    expect(vi.getTimerCount()).toBe(0);
    h.identity.mockImplementation(h.verify);
    pending.resolve(null);
    expect((await h.open()).response.statusCode).toBe(200);
    expect(h.subscribed).toHaveBeenCalledOnce();
  } finally {
    h.close();
    pending.resolve(null);
  }
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['resolve', 'reject'] as const)(
  'cleans initial authentication on disconnect/shutdown before late %s',
  async (outcome) => {
    for (const shutdown of [false, true]) {
      const h = streamHarness();
      const pending = Promise.withResolvers<Principal | null>();
      h.identity.mockImplementation(() => pending.promise);
      const stream = h.begin();
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);
        if (shutdown) h.close();
        else stream.response.emit('close');
        await stream.done;
        expect(vi.getTimerCount()).toBe(0);
        if (outcome === 'resolve') pending.resolve(actor);
        else pending.reject(new Error('late authentication error'));
        await vi.advanceTimersByTimeAsync(10000);
        expect(h.subscribed).not.toHaveBeenCalled();
        expect(stream.write).not.toHaveBeenCalled();
        h.identity.mockImplementation(h.verify);
        expect((await h.open()).response.statusCode).toBe(shutdown ? 503 : 200);
      } finally {
        h.close();
        pending.resolve(actor);
      }
      expect(vi.getTimerCount()).toBe(0);
    }
  },
);

it('bounds verified pending/open streams to eight per user across sessions and reuses a released slot', async () => {
  const h = streamHarness();
  const pending = Promise.withResolvers<Awaited<ReturnType<ConversationService['subscribe']>>>();
  h.principals.set('second-session', { ...actor, sessionId: 'second-session' });
  h.subscribed.mockImplementation(() => pending.promise);
  const streams = Array.from({ length: 9 }, (_, index) =>
    h.begin(index % 2 ? 'owner' : 'second-session'),
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(h.subscribed).toHaveBeenCalledTimes(8);
    expect(streams[8]!.response.statusCode).toBe(429);
    streams[0]!.response.emit('close');
    h.subscribed.mockResolvedValue({
      snapshot: { conversationId: 'replacement', activeRequestId: null, receipt: null },
      close: vi.fn(),
    });
    expect((await h.open()).response.statusCode).toBe(200);
    expect(h.subscribed).toHaveBeenCalledTimes(9);
    const lateClose = vi.fn();
    pending.resolve({
      snapshot: { conversationId: 'late', activeRequestId: null, receipt: null },
      close: lateClose,
    });
    await Promise.all(streams.map((stream) => stream.done));
    expect(streams[0]!.write).not.toHaveBeenCalled();
    expect(lateClose).toHaveBeenCalledOnce();
  } finally {
    h.close();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('counts all pending/open streams against 256 global slots before another identity call', async () => {
  const h = streamHarness();
  const streams = [];
  try {
    for (let wave = 0; wave < 4; wave++) {
      const opening = Array.from({ length: 64 }, (_, index) => {
        const user = `user-${Math.floor((wave * 64 + index) / 8)}`;
        h.principals.set(user, { userId: user, sessionId: 'session' });
        return h.begin(user);
      });
      await Promise.all(opening.map((stream) => stream.done));
      streams.push(...opening);
    }
    expect(h.subscribed).toHaveBeenCalledTimes(256);
    expect(streams.every((stream) => stream.response.statusCode === 200)).toBe(true);
    const blocked = await h.open();
    expect(blocked.response.statusCode).toBe(429);
    expect(h.identity).toHaveBeenCalledTimes(256);
    streams[0]!.response.emit('close');
    expect((await h.open()).response.statusCode).toBe(200);
    expect(h.identity).toHaveBeenCalledTimes(257);
  } finally {
    h.close();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['revoked', 'user changed', 'session changed', 'sync throw', 'reject', 'timeout'] as const)(
  'closes the whole affected group on %s while isolating other users and sessions',
  async (fault) => {
    const h = streamHarness();
    h.principals.set('other-session', { ...actor, sessionId: 'other-session' });
    h.principals.set('other-user', { userId: 'other-user', sessionId: actor.sessionId });
    const pending = Promise.withResolvers<Principal | null>();
    try {
      const affected = await Promise.all([h.open(), h.open()]);
      const isolated = await Promise.all([h.open('other-session'), h.open('other-user')]);
      h.identity.mockImplementation((headers) => {
        if (headers.get('cookie') !== 'owner') return h.verify(headers);
        if (fault === 'sync throw') throw new Error('private error');
        if (fault === 'reject') return Promise.reject(new Error('private error'));
        if (fault === 'timeout') return pending.promise;
        return Promise.resolve(
          fault === 'revoked'
            ? null
            : fault === 'user changed'
              ? { ...actor, userId: 'changed' }
              : { ...actor, sessionId: 'changed' },
        );
      });
      await vi.advanceTimersByTimeAsync(fault === 'timeout' ? 6000 : 1000);
      for (const stream of affected) {
        expect(stream.response.writableEnded).toBe(true);
        expect(stream.write.mock.lastCall![0]).toContain(
          ['revoked', 'user changed', 'session changed'].includes(fault)
            ? 'UNAUTHORIZED'
            : 'AUTH_UNAVAILABLE',
        );
        expect(stream.write.mock.lastCall![0]).not.toContain('private error');
      }
      expect(isolated.every((stream) => !stream.response.writableEnded)).toBe(true);
      expect(vi.getTimerCount()).toBe(2);
    } finally {
      h.close();
      pending.resolve(actor);
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(['resolve', 'reject'] as const)(
  'keeps a rebuilt group safe from the old check late %s',
  async (outcome) => {
    const h = streamHarness();
    const pending = Promise.withResolvers<Principal | null>();
    try {
      const old = await h.open();
      h.identity.mockImplementationOnce(() => pending.promise);
      await vi.advanceTimersByTimeAsync(1000);
      old.response.emit('close');
      expect(vi.getTimerCount()).toBe(0);
      const current = await h.open();
      if (outcome === 'resolve') pending.resolve(null);
      else pending.reject(new Error('late error'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(current.response.writableEnded).toBe(false);
      expect(current.write).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      h.close();
      pending.resolve(actor);
    }
  },
);

it.each([
  ['ownership', 'resolve'],
  ['ownership', 'reject'],
  ['snapshot', 'resolve'],
  ['snapshot', 'reject'],
] as const)(
  'removes pending %s subscriptions on disconnect/shutdown before late %s',
  async (stage, outcome) => {
    for (const shutdown of [false, true]) {
      const gate = Promise.withResolvers<unknown>();
      const store = {
        owned: vi.fn().mockResolvedValue({ dsh_session_id: 'session' }),
        snapshot: vi.fn().mockImplementation(async (_actor, id) => ({
          conversationId: id,
          activeRequestId: null,
          receipt: null,
        })),
        receive: vi.fn().mockImplementation(async (_actor, id, requestId) => ({
          fresh: true,
          row: { dsh_session_id: 'session' },
          receipt: { conversationId: id, requestId, status: 'accepted' },
        })),
        finish: vi.fn().mockImplementation(async (id, requestId) => ({
          conversationId: id,
          requestId,
          status: 'completed',
        })),
        close: vi.fn(),
      };
      store[stage === 'ownership' ? 'owned' : 'snapshot'].mockImplementationOnce(
        () => gate.promise,
      );
      const engine = {
        run: vi.fn().mockResolvedValue('completed'),
        close: vi.fn(),
      } as unknown as ConversationEngine;
      const service = createConversationService(store as unknown as ConversationStore, engine);
      const actual = service.subscribe;
      const observed = vi.fn();
      vi.spyOn(service, 'subscribe').mockImplementation((actor, id, listener, signal) =>
        actual(
          actor,
          id,
          (event) => {
            observed(event);
            listener(event);
          },
          signal,
        ),
      );
      const h = streamHarness(service);
      const pending = h.begin();
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(store[stage === 'ownership' ? 'owned' : 'snapshot']).toHaveBeenCalledOnce();
        if (shutdown) h.close();
        else pending.request.emit('aborted');
        expect(vi.getTimerCount()).toBe(0);
        const id = pending.request.url!.split('/')[4]!;
        await service.send(actor, id, 'after-disconnect', 'accepted execution continues');
        expect(observed).not.toHaveBeenCalled();
        if (outcome === 'reject') gate.reject(new Error('late storage error'));
        else
          gate.resolve(
            stage === 'ownership'
              ? { dsh_session_id: 'session' }
              : { conversationId: id, activeRequestId: null, receipt: null },
          );
        await pending.done;
        expect(pending.write).not.toHaveBeenCalled();
        if (stage === 'ownership') expect(store.snapshot).not.toHaveBeenCalled();
        if (!shutdown) {
          const next = await Promise.all(Array.from({ length: 8 }, () => h.open()));
          expect(next.every((stream) => stream.response.statusCode === 200)).toBe(true);
        }
      } finally {
        h.close();
        gate.reject(new Error('fixture cleanup'));
        await pending.done;
        await service.close();
      }
      expect(vi.getTimerCount()).toBe(0);
    }
  },
);

it('releases failed subscribe and overflow resources and checks browser policy before reserving', async () => {
  const h = streamHarness();
  try {
    for (const options of [{ method: 'PUT' }, { origin: 'https://denied.fixture' }]) {
      const denied = h.begin('owner', options);
      await denied.done;
      expect([403, 405]).toContain(denied.response.statusCode);
    }
    expect(h.identity).not.toHaveBeenCalled();
    h.subscribed.mockRejectedValueOnce(new ConversationError(404, 'CONVERSATION_NOT_FOUND'));
    expect((await h.open()).response.statusCode).toBe(404);
    expect(vi.getTimerCount()).toBe(0);
    const overflow = await h.open();
    h.subscribed.mock.lastCall![2]({
      type: 'text',
      requestId: 'large',
      text: 'x'.repeat(65 * 1024),
    });
    expect(overflow.response.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const next = await Promise.all(Array.from({ length: 8 }, () => h.open()));
    expect(next.every((stream) => stream.response.statusCode === 200)).toBe(true);
  } finally {
    h.close();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('continues streaming after successful verification and releases the interval on disconnect', async () => {
  const stream = await openStream(async () => actor);
  try {
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stream.identity).toHaveBeenCalledTimes(3);
    expect(stream.response.writableEnded).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    stream.publish({ type: 'text', requestId: 'live-turn', text: 'after verification' });
    expect(stream.write.mock.calls[1]?.[0]).toContain('"text":"after verification"');
    stream.response.emit('close');
    expect(stream.unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    stream.close();
  }
});

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
