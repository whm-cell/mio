import { createServer } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type {
  Conversation,
  ConversationEngine,
  Receipt,
} from '../../src/conversations/contracts.ts';
import { createConversationHandler } from '../../src/conversations/http.ts';
import type {
  ConversationProjectContextResolver,
  ConversationProjectSnapshot,
} from '../../src/conversations/project-context.ts';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { createConversationService } from '../../src/conversations/service.ts';
import { createConversationStore } from '../../src/conversations/store.ts';
import { authDatabase } from '../support/auth-database.ts';

const origin = 'http://m4-fixture.test';
const resolveContext = vi.fn<ConversationProjectContextResolver>();
const run = vi.fn<ConversationEngine['run']>(async (_id, _request, _text, durable) => {
  await durable();
  return 'completed';
});
const engine: ConversationEngine = {
  available: true,
  create: async () => {},
  rename: async (_id, title) => title,
  history: async () => ({ items: [], nextAfterSeq: -1, hasMore: false }),
  run,
  cancel: async () => {},
  close: async () => {},
};
let database: Awaited<ReturnType<typeof authDatabase>>;
let service: ReturnType<typeof createConversationService>;
let http: ReturnType<typeof createConversationHandler>;
let server: ReturnType<typeof createServer>;
let base: string;

beforeAll(async () => {
  database = await authDatabase();
  const observer = new Pool({ connectionString: database.observerURL });
  try {
    await observer.query(conversationSchemaSQL);
  } finally {
    await observer.end();
  }
  service = createConversationService(
    await createConversationStore(database.url),
    engine,
    undefined,
    undefined,
    resolveContext,
  );
  http = createConversationHandler(
    service,
    async (headers) => {
      const userId = headers.get('cookie');
      return userId === 'owner' || userId === 'other'
        ? { userId, sessionId: `${userId}-login` }
        : null;
    },
    [origin],
  );
  server = createServer(http.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
  base = `http://127.0.0.1:${address.port}/api/v1/conversations`;
}, 15000);

beforeEach(() => {
  run.mockClear();
  resolveContext.mockReset().mockResolvedValue(null);
});

afterAll(async () => {
  try {
    http?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await service?.close();
  } finally {
    await database?.close();
  }
});

const call = (path: string, method = 'GET', body?: unknown, cookie = 'owner') =>
  fetch(base + path, {
    method,
    headers: {
      origin,
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });

async function json<T = unknown>(response: Response, status: number): Promise<T> {
  const raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}

const create = async (body: object) => json<Conversation>(await call('', 'POST', body), 201);
const createDrama = () => create({ purpose: 'drama-script' });
const send = (id: string, requestId: string, text = '写第一场', cookie = 'owner') =>
  call(`/${id}/messages`, 'POST', { requestId, text }, cookie);
const getReceipt = (id: string, requestId: string) => call(`/${id}/requests/${requestId}`);

async function expectError(response: Response, status: number, code: string) {
  const body = await json(response, status);
  expect(body).toMatchObject({ error: { code } });
  return JSON.stringify(body);
}

async function completed(id: string, requestId: string) {
  return vi.waitFor(async () => {
    const receipt = await json<Receipt>(await getReceipt(id, requestId), 200);
    expect(receipt.status).toBe('completed');
    return receipt;
  });
}

function setSnapshot(snapshot: ConversationProjectSnapshot) {
  resolveContext.mockImplementation(async ({ ownerId, conversationId }) => ({
    ownerId,
    conversationId,
    snapshot,
  }));
}

it('preserves general metadata and accepts only the creation-time purpose', async () => {
  for (const body of [
    { purpose: null },
    { purpose: [] },
    { purpose: 'drama' },
    { purpose: 'DRAMA-SCRIPT' },
    { systemPrompt: 'override' },
    { purpose: 'drama-script', projectId: 'fake-project' },
    { purpose: 'drama-script', projectContext: {} },
  ]) {
    await expectError(await call('', 'POST', body), 400, 'BODY_INVALID');
  }
  const implicit = await create({});
  const explicit = await create({ purpose: 'general' });
  const drama = await createDrama();
  expect(drama.purpose).toBe('drama-script');
  for (const general of [implicit, explicit]) {
    expect(Object.keys(general).sort()).toEqual(['createdAt', 'id', 'state', 'title', 'updatedAt']);
  }
  await expectError(
    await call(`/${drama.id}`, 'PATCH', { title: 'First', purpose: 'general' }),
    400,
    'BODY_INVALID',
  );
  const renamed = await json<Conversation>(
    await call(`/${drama.id}`, 'PATCH', { title: 'First' }),
    200,
  );
  expect(renamed).toMatchObject({ title: 'First', purpose: 'drama-script' });
  const list = await json<{ items: Conversation[] }>(await call(''), 200);
  for (const general of [implicit, explicit]) {
    expect(list.items.find(({ id }) => id === general.id)).toEqual(general);
  }
  expect(list.items.find(({ id }) => id === drama.id)).toEqual(renamed);
  expect(resolveContext).not.toHaveBeenCalled();
});

it('reads the trusted source for authorized fresh drama requests and preserves idempotent replay', async () => {
  const drama = await createDrama();
  const general = await create({});
  setSnapshot({ scriptSummary: '剧本一', characters: ['苏荞 — 钟表匠'] });
  await expectError(
    await send(drama.id, 'cross-owner', '越权尝试', 'other'),
    404,
    'CONVERSATION_NOT_FOUND',
  );
  await expectError(
    await call(`/${drama.id}/messages`, 'POST', {
      requestId: 'forged',
      text: '写第一场',
      projectContext: { scriptSummary: '伪造上下文' },
    }),
    400,
    'BODY_INVALID',
  );
  await json(await send(general.id, 'ordinary'), 202);
  await completed(general.id, 'ordinary');
  expect(resolveContext).not.toHaveBeenCalled();
  expect(run.mock.calls[0]?.[9]).toEqual({ purpose: 'general' });

  const first = await Promise.all([send(drama.id, 'scene-1'), send(drama.id, 'scene-1')]);
  for (const response of first) {
    expect(await json(response, 202)).toMatchObject({ requestId: 'scene-1' });
  }
  const settled = await completed(drama.id, 'scene-1');
  expect(resolveContext).toHaveBeenCalledExactlyOnceWith({
    ownerId: 'owner',
    conversationId: drama.id,
    signal: expect.any(AbortSignal),
  });
  expect(run.mock.calls[1]?.[9]).toEqual({
    purpose: 'drama-script',
    projectContext: JSON.stringify({ scriptSummary: '剧本一', characters: ['苏荞 — 钟表匠'] }),
  });
  setSnapshot({ worldbuilding: '新确认的城镇设定' });
  expect(await json(await send(drama.id, 'scene-1'), 202)).toEqual(settled);
  await expectError(await send(drama.id, 'scene-1', '换内容'), 409, 'REQUEST_ID_CONFLICT');
  expect(resolveContext).toHaveBeenCalledTimes(1);
  await json(await send(drama.id, 'scene-2'), 202);
  await completed(drama.id, 'scene-2');
  expect(run.mock.calls[2]?.[9]).toEqual({
    purpose: 'drama-script',
    projectContext: JSON.stringify({ worldbuilding: '新确认的城镇设定' }),
  });

  resolveContext.mockResolvedValue(null);
  await json(await send(drama.id, 'unlinked'), 202);
  await completed(drama.id, 'unlinked');
  expect(run.mock.calls[3]?.[9]).toEqual({ purpose: 'drama-script' });
  expect(resolveContext).toHaveBeenCalledTimes(3);
  expect(run).toHaveBeenCalledTimes(4);
});

it('rejects mismatched identity and invalid or unavailable source data before admission', async () => {
  const { id } = await createDrama();
  const requestId = 'read-failed';
  const snapshot = { scriptSummary: 'M4_PRIVATE_PROJECT_DATA' };
  resolveContext
    .mockRejectedValueOnce(new Error('M4_PRIVATE_PROJECT_ERROR'))
    .mockImplementationOnce(async (lookup) => {
      Object.assign(lookup, { ownerId: 'other' });
      return { ownerId: 'other', conversationId: id, snapshot };
    })
    .mockResolvedValueOnce({ ownerId: 'owner', conversationId: 'another-conversation', snapshot })
    .mockResolvedValueOnce({
      ownerId: 'owner',
      conversationId: id,
      snapshot: Object.assign({}, snapshot, { instructions: 'M4_PRIVATE_UNKNOWN_FIELD' }),
    });
  for (let attempt = 0; attempt < 4; attempt++) {
    const error = await expectError(
      await send(id, requestId),
      503,
      'CONVERSATION_CONTEXT_UNAVAILABLE',
    );
    expect(error).not.toContain('M4_PRIVATE');
    await expectError(await getReceipt(id, requestId), 404, 'REQUEST_NOT_FOUND');
  }
  expect(run).not.toHaveBeenCalled();
  setSnapshot(snapshot);
  await json(await send(id, requestId), 202);
  await completed(id, requestId);
  expect(run).toHaveBeenCalledTimes(1);
});

it('bounds the actual escaped UTF-8 JSON and allows retry at the exact 64 KiB limit', async () => {
  const { id } = await createDrama();
  const prefix = '甲「多字节」\n"\\';
  const remaining = 64 * 1024 - Buffer.byteLength(JSON.stringify({ scriptSummary: prefix }));
  const scriptSummary = prefix + '雪'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
  const serialized = JSON.stringify({ scriptSummary });
  expect(Buffer.byteLength(serialized)).toBe(64 * 1024);
  setSnapshot({ scriptSummary: scriptSummary + 'x' });
  await expectError(await send(id, 'bounded'), 413, 'CONVERSATION_CONTEXT_TOO_LARGE');
  await expectError(await getReceipt(id, 'bounded'), 404, 'REQUEST_NOT_FOUND');
  expect(run).not.toHaveBeenCalled();

  setSnapshot({ scriptSummary });
  await json(await send(id, 'bounded'), 202);
  await completed(id, 'bounded');
  expect(run.mock.calls[0]?.[9]).toEqual({ purpose: 'drama-script', projectContext: serialized });
});
