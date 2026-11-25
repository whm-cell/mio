import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  Conversation,
  ConversationEvent,
  ConversationSnapshot,
  HistoryPage,
  Receipt,
} from '../../src/conversations/contracts.ts';
import { isInFlightRequest } from '../../src/conversations/contracts.ts';
import {
  importRoutesViaCli,
  makeChatRouteFixture,
} from '../providers/fixtures/onelink-routes-fixture.ts';
import { authDatabase } from '../support/auth-database.ts';
import { packedAuthRuntime } from '../support/auth-runtime.ts';

const execFileAsync = promisify(execFile);
const base = '/api/v1/conversations';
const modelId = 'deepseek-v4.1-flash';
const modelRef = `onelink:chat:${modelId}`;
const contextWindow = 262144;
const assistantText = 'fixture answer';
let database: Awaited<ReturnType<typeof authDatabase>>;
let observer: Pool;
let runtime: Awaited<ReturnType<typeof packedAuthRuntime>>;
let owner: { id: string; cookie: string };
let outsider: { id: string; cookie: string };

const call = (path: string, method = 'GET', body?: unknown, cookie = owner?.cookie ?? '') =>
  fetch(runtime.origin + path, {
    method,
    headers: {
      origin: runtime.origin,
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });

async function json<T = unknown>(response: Response, status: number): Promise<T> {
  const raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}

async function signup(label: string) {
  const response = await call(
    '/api/auth/sign-up/email',
    'POST',
    { name: label, email: `m4-${label}@example.test`, password: 'm4-profile-fixture-7412' },
    '',
  );
  const { user } = await json<{ user: { id: string } }>(response, 200);
  return {
    id: user.id,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  };
}

type Frame = ConversationEvent | ({ type: 'snapshot' } & ConversationSnapshot);

async function* events(path: string): AsyncGenerator<Frame> {
  const response = await call(`${path}/events`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Packed M4 stream ended before settlement');
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const [event, data] = buffer.slice(0, boundary).split('\n');
        buffer = buffer.slice(boundary + 2);
        const frame = JSON.parse(data!.slice('data: '.length)) as Frame;
        expect(event).toBe(`event: ${frame.type}`);
        yield frame;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const send = (path: string, requestId: string, text: string, cookie?: string) =>
  call(`${path}/messages`, 'POST', { requestId, text }, cookie);

async function turn(path: string, requestId: string, text: string) {
  const stream = events(path);
  try {
    const initial = (await stream.next()).value as Frame;
    expect(initial).toMatchObject({ type: 'snapshot', activeRequestId: null });
    const frames: Frame[] = [initial];
    expect(await json(await send(path, requestId, text), 202)).toMatchObject({
      requestId,
      status: 'accepted',
    });
    let reply = '';
    for await (const frame of stream) {
      frames.push(frame);
      if (frame.type === 'error') throw new Error(`Packed M4 stream error: ${frame.code}`);
      if (frame.type === 'text' && frame.requestId === requestId) reply += frame.text;
      if (
        frame.type === 'state' &&
        frame.receipt.requestId === requestId &&
        !isInFlightRequest(frame.receipt.status)
      ) {
        expect(frame.receipt.status).toBe('completed');
        expect(reply).toBe(assistantText);
        expect(await json(await call(`${path}/requests/${requestId}`), 200)).toEqual(frame.receipt);
        expect(frame.contextUsage).toMatchObject({ contextWindow, compacted: false });
        return { frames, receipt: frame.receipt, usage: frame.contextUsage! };
      }
    }
    throw new Error(`No terminal frame for ${requestId}`);
  } finally {
    await stream.return(undefined);
  }
}

beforeAll(async () => {
  database = await authDatabase();
  observer = new Pool({ connectionString: database.observerURL });
  const providerMasterKey = randomBytes(32).toString('base64');
  const providerKeyId = 'm4-profile';
  const env = {
    PATH: process.env.PATH ?? '',
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_AUTH_BASE_URL: 'http://127.0.0.1:4311',
    MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
    MIO_CONVERSATIONS_DATABASE_URL: database.url,
    MIO_PROVIDERS_DATABASE_URL: database.url,
    MIO_PROVIDERS_MASTER_KEY: providerMasterKey,
    MIO_PROVIDERS_MASTER_KEY_ID: providerKeyId,
  };
  for (const domain of ['auth', 'providers', 'conversations']) {
    await execFileAsync(process.execPath, [`scripts/service/migrate-${domain}.ts`, '--apply'], {
      env,
      timeout: 30000,
    });
  }
  await importRoutesViaCli(
    env,
    makeChatRouteFixture(modelId, 'deepseek', { contextWindow, maxOutputTokens: 1024 }),
  );
  runtime = await packedAuthRuntime(database.url, '', 'unused', {
    conversations: true,
    onelinkFixture: true,
    providerMasterKey,
    providerKeyId,
  });
  await runtime.start('database');
  owner = await signup('owner');
  outsider = await signup('outsider');
  await json(
    await call('/api/v1/providers/onelink/credential', 'PUT', {
      apiKey: 'synthetic-m4-profile-owner',
      expectedRevision: 0,
    }),
    200,
  );
  expect(await json(await call('/api/v1/providers/onelink/test', 'POST', {}), 200)).toMatchObject({
    status: 'connected',
  });
}, 45000);

afterAll(async () => {
  try {
    await runtime?.close();
  } finally {
    await observer?.end();
    await database?.close();
  }
}, 30000);

it('uses the latest private project context on normal messages across a packed Profile restart', async () => {
  const { id, purpose } = await json<Conversation>(
    await call(base, 'POST', { modelRef, purpose: 'drama-script' }),
    201,
  );
  expect(purpose).toBe('drama-script');
  const path = `${base}/${id}`;
  const oldMarker = 'M4_PRIVATE_FOG_CLOCK';
  const newMarker = 'M4_PRIVATE_CLOCK_TOWER';
  const firstText = '打磨第一场对白';
  const secondText = '改写第二场旁白';
  const thirdText = '继续写下一场戏';
  const association = { ownerId: owner.id, conversationId: id };
  const firstSnapshot = {
    scriptSummary: `${oldMarker}：盐雾城的钟表受报时曲控制。`,
    worldbuilding: '夜渡结束前听不到第二次报时',
    characters: ['苏荞 — 钟表匠'],
  };
  await runtime.setConversationProjectContext({ ...association, snapshot: firstSnapshot });
  expect(
    await json(await send(path, 'other-owner', '越权读取', outsider.cookie), 404),
  ).toMatchObject({
    error: { code: 'CONVERSATION_NOT_FOUND' },
  });

  const first = await turn(path, 'old', firstText);
  expect(await runtime.onelinkRequests()).toHaveLength(1);
  const firstHistory = await json<HistoryPage>(await call(`${path}/history`), 200);
  const firstMetadata = await json<{ items: Conversation[] }>(await call(base), 200);
  expect(firstMetadata.items.find((item) => item.id === id)).toMatchObject({
    title: firstText,
    purpose: 'drama-script',
  });
  expect(JSON.stringify([first.frames, firstHistory, firstMetadata])).not.toContain(oldMarker);

  // The new snapshot and receipts must survive a real cold native read.
  await runtime.stop();
  await runtime.start('database');
  expect(await json(await call(`${path}/history`), 200)).toEqual(firstHistory);
  const markerText = `${newMarker}：雪夜钟楼。\n"\\`;
  const remaining = 64 * 1024 - Buffer.byteLength(JSON.stringify({ scriptSummary: markerText }));
  const scriptSummary =
    markerText + '雪'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
  const secondSnapshot = { scriptSummary };
  expect(Buffer.byteLength(JSON.stringify(secondSnapshot))).toBe(64 * 1024);
  await runtime.setConversationProjectContext({
    ...association,
    snapshot: { scriptSummary: scriptSummary + 'x' },
  });
  // A settled replay bypasses a project source that would currently reject fresh sends.
  expect(await json<Receipt>(await send(path, 'old', firstText), 202)).toEqual(first.receipt);
  expect(await json(await send(path, 'new', secondText), 413)).toMatchObject({
    error: { code: 'CONVERSATION_CONTEXT_TOO_LARGE' },
  });
  expect(await json(await call(`${path}/requests/new`), 404)).toMatchObject({
    error: { code: 'REQUEST_NOT_FOUND' },
  });
  expect(await runtime.onelinkRequests()).toHaveLength(1);

  await runtime.setConversationProjectContext({ ...association, snapshot: secondSnapshot });
  const second = await turn(path, 'new', secondText);
  expect(second.usage.estimatedTokens).toBeGreaterThan(first.usage.estimatedTokens + 1000);
  await runtime.setConversationProjectContext(null);
  const third = await turn(path, 'unlinked', thirdText);
  expect(third.usage.estimatedTokens).toBeLessThan(second.usage.estimatedTokens);

  const wires = await runtime.onelinkRequests();
  expect(wires).toHaveLength(3);
  const messages = wires.map(({ path: target, body }) => {
    expect(target).toBe('/v1/chat/completions');
    return body.messages as { role: string; content: unknown }[];
  });
  const prefix = messages[0]![0]!;
  expect(prefix).toEqual({
    role: 'system',
    content: expect.stringContaining('【剧本创作工作区】'),
  });
  expect(messages.map((request) => request[0])).toEqual([prefix, prefix, prefix]);
  expect(JSON.stringify(prefix)).not.toMatch(/M4_PRIVATE_/);
  const snapshots = [firstSnapshot, secondSnapshot];
  for (const [index, marker] of [oldMarker, newMarker].entries()) {
    const request = messages[index]!;
    const project = request.find(
      ({ role, content }) =>
        role === 'user' && typeof content === 'string' && content.includes(marker),
    );
    expect(project?.content).toContain(JSON.stringify(snapshots[index]));
    expect(JSON.stringify(request.filter(({ role }) => role !== 'user'))).not.toContain(marker);
    const human = request.find(
      ({ role, content }) => role === 'user' && content === (index ? secondText : firstText),
    );
    expect(human).toBeDefined();
    if (index === 0) expect(request.indexOf(project!)).toBeLessThan(request.indexOf(human!));
  }
  expect(JSON.stringify(messages[0])).not.toContain(newMarker);
  expect(JSON.stringify(messages[1])).not.toContain(oldMarker);
  expect(JSON.stringify(messages[2])).not.toMatch(/M4_PRIVATE_/);

  const history = await json<HistoryPage>(await call(`${path}/history?limit=100`), 200);
  expect(history.items.map(({ role }) => role)).toEqual([
    'user',
    'assistant',
    'status',
    'user',
    'assistant',
    'status',
    'user',
    'assistant',
    'status',
  ]);
  expect(history.items.flatMap((item) => (item.role === 'user' ? [item.text] : []))).toEqual([
    firstText,
    secondText,
    thirdText,
  ]);
  const page = await json<HistoryPage>(await call(`${path}/history?limit=3`), 200);
  expect(page).toEqual({
    items: history.items.slice(0, 3),
    nextAfterSeq: history.items[2]!.seq,
    hasMore: true,
  });
  const nextPage = await json<HistoryPage>(
    await call(`${path}/history?limit=2&afterSeq=${page.nextAfterSeq}`),
    200,
  );
  expect(nextPage).toEqual({
    items: history.items.slice(3, 5),
    nextAfterSeq: history.items[4]!.seq,
    hasMore: true,
  });
  const finalMetadata = await json<{ items: Conversation[] }>(await call(base), 200);
  expect(finalMetadata.items.find((item) => item.id === id)?.title).toBe(firstText);
  const persisted = await observer.query(
    `SELECT to_jsonb(c) AS conversation,
       (SELECT jsonb_agg(to_jsonb(r)) FROM mio_conversation_requests r WHERE r.conversation_id=c.id) AS requests
     FROM mio_conversations c WHERE c.id=$1`,
    [id],
  );
  expect(
    JSON.stringify([history, second.frames, third.frames, finalMetadata, persisted.rows]),
  ).not.toMatch(/M4_PRIVATE_/);
});
