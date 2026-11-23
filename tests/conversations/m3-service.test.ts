import { createServer } from 'node:http';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type {
  ContextUsage,
  Conversation,
  ConversationEngine,
  Receipt,
} from '../../src/conversations/contracts.ts';
import { createConversationHandler } from '../../src/conversations/http.ts';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { createConversationService } from '../../src/conversations/service.ts';
import { createConversationStore } from '../../src/conversations/store.ts';
import type { ChatRuntimeSnapshot } from '../../src/providers/contracts.ts';
import { authDatabase } from '../support/auth-database.ts';

const origin = 'http://m3-fixture.test';
const base = '/api/v1/conversations';
const actor = { userId: 'owner', sessionId: 'owner-login' };
const route: ChatRuntimeSnapshot = {
  providerConfigId: 'provider-config',
  providerRevision: 1,
  credentialVersion: 1,
  catalogVersion: 1,
  adaptationVersion: 1,
  capabilityVersion: 'onelink-text:1',
  modelKey: 'fixture-key',
  modelRef: 'fixture-ref',
  modelId: 'fixture-model',
  operation: 'chat',
  protocol: 'openai-chat',
  profile: 'openai-chat',
  contextWindow: 8192,
  maxOutputTokens: 512,
  apiKey: 'fixture-only-placeholder',
};
const initialUsage = { estimatedTokens: 70, contextWindow: null, compacted: false };
const normalUsage = { estimatedTokens: 900, contextWindow: 8192, compacted: false };
const compactUsage = { estimatedTokens: 200, contextWindow: 8192, compacted: true };
let database: Awaited<ReturnType<typeof authDatabase>>;
let observer: Pool;
let fixture: Awaited<ReturnType<typeof openConversationHttp>>;

async function openConversationHttp() {
  const compact = vi
    .fn<NonNullable<ConversationEngine['compact']>>()
    .mockResolvedValue('completed');
  const contextUsage = vi.fn(async () => ({ ...initialUsage, internal: 'private projection' }));
  const measure = vi.fn<() => ContextUsage>().mockReturnValue(normalUsage);
  const engine: ConversationEngine = {
    available: true,
    create: async () => {},
    rename: async (_id, title) => title,
    history: async () => ({ items: [], nextAfterSeq: -1, hasMore: false }),
    run: async (
      _id,
      _requestId,
      _text,
      inputPersisted,
      _emit,
      _binding,
      _images,
      _admit,
      capture,
    ) => {
      await inputPersisted();
      capture?.(measure);
      return 'completed';
    },
    compact,
    contextUsage,
    cancel: vi.fn(async () => {}),
    close: async () => {},
  };
  const providers = {
    selectChat: vi.fn(async () => ({
      providerConfigId: route.providerConfigId,
      modelRef: route.modelRef,
      modelId: route.modelId,
      modelKey: route.modelKey,
      protocol: route.protocol,
    })),
    resolveChat: vi.fn(async () => route),
    recordVerification: vi.fn(async () => {}),
  };
  const store = await createConversationStore(database.url);
  const service = createConversationService(store, engine, providers);
  const http = createConversationHandler(
    service,
    async (headers) => {
      const userId = headers.get('cookie');
      return userId === 'owner' || userId === 'other'
        ? { userId, sessionId: `${userId}-login` }
        : null;
    },
    [origin],
  );
  const server = createServer(http.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
  return {
    compact,
    contextUsage,
    measure,
    cancel: vi.mocked(engine.cancel),
    providers,
    store,
    async call(path: string, method = 'GET', body?: unknown, cookie = 'owner') {
      return fetch(`http://127.0.0.1:${address.port}${base}${path}`, {
        method,
        headers: {
          origin,
          cookie,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
    },
    async close() {
      http.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.close();
    },
  };
}

async function create() {
  const response = await fixture.call('', 'POST', {});
  expect(response.status).toBe(201);
  return (await response.json()) as Conversation;
}

const requestCompact = (id: string, requestId: string, cookie = 'owner') =>
  fixture.call(`/${id}/compact`, 'POST', { requestId }, cookie);
const sendMessage = (id: string, requestId: string) =>
  fixture.call(`/${id}/messages`, 'POST', { requestId, text: '第一集在山里开始。' });

async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

async function receipt(id: string, requestId: string) {
  const response = await fixture.call(`/${id}/requests/${requestId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Receipt;
}

async function openEvents(id: string) {
  const stream = await fixture.call(`/${id}/events`);
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return {
    async next() {
      let end = buffered.indexOf('\n\n');
      while (end < 0) {
        const { value, done } = await reader.read();
        if (done) throw new Error('expected an SSE frame');
        buffered += decoder.decode(value, { stream: true });
        end = buffered.indexOf('\n\n');
      }
      const frame = buffered.slice(0, end).split('\ndata: ')[1]!;
      buffered = buffered.slice(end + 2);
      return JSON.parse(frame) as unknown;
    },
    close: () => reader.cancel(),
  };
}

beforeAll(async () => {
  database = await authDatabase();
  observer = new Pool({ connectionString: database.observerURL });
  await observer.query(conversationSchemaSQL);
}, 15000);
beforeEach(async () => {
  fixture = await openConversationHttp();
});
afterEach(async () => fixture.close());
afterAll(async () => {
  try {
    await observer?.end();
  } finally {
    await database?.close();
  }
});

it('admits one owner compaction, replays its receipt, and shares the message lock and request namespace', async () => {
  const conversation = await create();
  const id = conversation.id;
  const release = Promise.withResolvers<void>();
  const requestId = 'compact-once';
  const observation = { purpose: 'compaction', status: 200, finish: 'stop' } as const;
  fixture.compact.mockImplementationOnce(async (sessionId, binding) => {
    expect(sessionId).toBe(`mio-${id}`);
    expect(binding).toMatchObject({
      userId: actor.userId,
      conversationId: id,
      requestId,
      snapshot: route,
    });
    await release.promise;
    await binding.observe(observation);
    return 'completed';
  });
  try {
    await error(await requestCompact(id, requestId, 'other'), 404, 'CONVERSATION_NOT_FOUND');
    const responses = await Promise.all([
      requestCompact(id, requestId),
      requestCompact(id, requestId),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ conversationId: id, requestId, status: 'accepted' });
    }
    expect(fixture.providers.resolveChat).toHaveBeenCalledOnce();
    expect(fixture.compact).toHaveBeenCalledOnce();
    await error(await sendMessage(id, requestId), 409, 'REQUEST_ID_CONFLICT');
    await error(await sendMessage(id, 'another-send'), 409, 'CONVERSATION_BUSY');
    await error(await requestCompact(id, 'another-compact'), 409, 'CONVERSATION_BUSY');
    await error(await fixture.call(`/${id}`, 'DELETE'), 409, 'CONVERSATION_BUSY');
  } finally {
    release.resolve();
  }
  await expect.poll(async () => (await receipt(id, requestId)).status).toBe('completed');
  const saved = await observer.query(
    `SELECT r.model_observations, r.model_binding, c.active_request, c.title, c.updated_at
     FROM mio_conversation_requests r JOIN mio_conversations c ON r.conversation_id=c.id
     WHERE c.id=$1 AND r.request_id=$2`,
    [id, requestId],
  );
  expect(saved.rows).toEqual([
    expect.objectContaining({
      active_request: null,
      title: conversation.title,
      updated_at: new Date(conversation.updatedAt),
      model_observations: [observation],
    }),
  ]);
  expect(saved.rows[0].model_binding).not.toHaveProperty('apiKey');
  expect(fixture.providers.recordVerification).not.toHaveBeenCalled();
  expect((await fixture.call(`/${id}`, 'DELETE')).status).toBe(200);
  const replay = await requestCompact(id, requestId);
  expect(replay.status).toBe(202);
  expect(await replay.json()).toMatchObject({ status: 'completed' });
  await error(await requestCompact(id, 'after-archive'), 409, 'CONVERSATION_ARCHIVED');
  expect(fixture.providers.resolveChat).toHaveBeenCalledOnce();
  expect(fixture.compact).toHaveBeenCalledOnce();
});

it('validates the control body and rejects an undeclared window without accepting fresh work', async () => {
  const { id } = await create();
  await error(await requestCompact(id, 'spaces not allowed'), 400, 'BODY_INVALID');
  await error(
    await fixture.call(`/${id}/compact`, 'POST', { requestId: 'x', contextWindow: 8192 }),
    400,
    'BODY_INVALID',
  );
  await error(
    await fixture.call(`/${id}/compact`, 'POST', { requestId: 'x'.repeat(17 * 1024) }),
    413,
    'BODY_TOO_LARGE',
  );
  expect(fixture.providers.resolveChat).not.toHaveBeenCalled();
  const withoutWindow = { ...route };
  delete withoutWindow.contextWindow;
  fixture.providers.resolveChat.mockResolvedValueOnce(withoutWindow);
  await error(await requestCompact(id, 'no-window'), 409, 'CONVERSATION_COMPACTION_UNSUPPORTED');
  await error(await fixture.call(`/${id}/requests/no-window`), 404, 'REQUEST_NOT_FOUND');
  expect(fixture.compact).not.toHaveBeenCalled();
});

it('shares the live terminal meter across existing SSE subscribers and leaves settlement intact on estimation failure', async () => {
  const { id } = await create();
  await error(
    await fixture.call(`/${id}/events`, 'GET', undefined, 'other'),
    404,
    'CONVERSATION_NOT_FOUND',
  );
  const subscribers = await Promise.all([openEvents(id), openEvents(id)]);
  try {
    for (const sub of subscribers)
      expect(await sub.next()).toEqual({
        type: 'snapshot',
        conversationId: id,
        activeRequestId: null,
        receipt: null,
        contextUsage: initialUsage,
      });
    expect(fixture.providers.resolveChat).not.toHaveBeenCalled();
    expect((await sendMessage(id, 'normal')).status).toBe(202);
    for (const sub of subscribers) {
      expect(await sub.next()).toMatchObject({
        receipt: { requestId: 'normal', status: 'accepted' },
      });
      expect(await sub.next()).toMatchObject({
        receipt: { requestId: 'normal', status: 'input-persisted' },
      });
      expect(await sub.next()).toMatchObject({
        type: 'state',
        receipt: { requestId: 'normal', status: 'completed' },
        contextUsage: normalUsage,
      });
    }
    const afterSummary = vi.fn(() => ({ ...compactUsage, summary: 'private model text' }));
    fixture.compact.mockImplementationOnce(async (_sessionId, _binding, _signal, capture) => {
      capture?.(afterSummary);
      return 'completed';
    });
    expect((await requestCompact(id, 'summary')).status).toBe(202);
    for (const sub of subscribers) {
      expect(await sub.next()).toMatchObject({
        receipt: { requestId: 'summary', status: 'accepted' },
      });
      expect(await sub.next()).toEqual({
        type: 'state',
        receipt: { conversationId: id, requestId: 'summary', status: 'completed' },
        contextUsage: compactUsage,
      });
    }
    expect(fixture.measure).toHaveBeenCalledOnce();
    expect(afterSummary).toHaveBeenCalledOnce();
    expect(fixture.contextUsage).toHaveBeenCalledTimes(2);

    fixture.measure.mockImplementationOnce(() => {
      throw new Error('private meter failure');
    });
    expect((await sendMessage(id, 'meter-failure')).status).toBe(202);
    for (const sub of subscribers) {
      expect(await sub.next()).toMatchObject({ receipt: { status: 'accepted' } });
      expect(await sub.next()).toMatchObject({ receipt: { status: 'input-persisted' } });
      expect(await sub.next()).toEqual({
        type: 'state',
        receipt: { conversationId: id, requestId: 'meter-failure', status: 'completed' },
      });
    }
  } finally {
    await Promise.all(subscribers.map((sub) => sub.close()));
  }
});

it('cancels only the active manual request and leaves the idempotent receipt queryable', async () => {
  const { id } = await create();
  const stopped = Promise.withResolvers<void>();
  fixture.compact.mockImplementationOnce(async () => {
    await stopped.promise;
    return 'cancelled';
  });
  fixture.cancel.mockImplementationOnce(async () => stopped.resolve());
  try {
    expect((await requestCompact(id, 'manual-cancel')).status).toBe(202);
    const cancel = await fixture.call(`/${id}/cancel`, 'POST', {});
    expect(cancel.status).toBe(202);
    expect(await cancel.json()).toEqual({ requested: true, requestId: 'manual-cancel' });
    expect(fixture.cancel).toHaveBeenCalledExactlyOnceWith(`mio-${id}`, 'manual-cancel');
    await expect.poll(async () => (await receipt(id, 'manual-cancel')).status).toBe('cancelled');
    const replay = await requestCompact(id, 'manual-cancel');
    expect(await replay.json()).toMatchObject({ status: 'cancelled' });
    expect(fixture.compact).toHaveBeenCalledOnce();
  } finally {
    stopped.resolve();
  }
});

it('keeps an unacknowledged manual admission unknown after reopening the store and never resubmits it', async () => {
  const { id } = await create();
  // Preserve only the committed admission, as with a process stop before engine registration.
  const admission = await fixture.store.receive(
    actor,
    id,
    'interrupted',
    'compact:v1',
    async () => route,
  );
  expect(admission.receipt.status).toBe('accepted');
  await fixture.close();
  fixture = await openConversationHttp();
  expect(await receipt(id, 'interrupted')).toEqual({
    conversationId: id,
    requestId: 'interrupted',
    status: 'unknown',
    error: 'PROCESS_INTERRUPTED',
  });
  const replay = await requestCompact(id, 'interrupted');
  expect(replay.status).toBe(202);
  expect(await replay.json()).toMatchObject({ status: 'unknown' });
  expect(fixture.compact).not.toHaveBeenCalled();
  expect(fixture.providers.resolveChat).not.toHaveBeenCalled();
  const fresh = await requestCompact(id, 'empty-range');
  expect(fresh.status).toBe(202);
  await expect.poll(async () => (await receipt(id, 'empty-range')).status).toBe('completed');
  const empty = await observer.query(
    'SELECT model_observations FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2',
    [id, 'empty-range'],
  );
  expect(empty.rows).toEqual([{ model_observations: [] }]);
});
