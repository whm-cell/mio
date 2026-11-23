import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  Conversation,
  ConversationEvent,
  ConversationSnapshot,
  HistoryPage,
  ModelObservation,
  Receipt,
  TerminalRequestStatus,
} from '../../src/conversations/contracts.ts';
import { isInFlightRequest } from '../../src/conversations/contracts.ts';
import {
  importRoutesViaCli,
  makeChatRouteFixture,
} from '../providers/fixtures/onelink-routes-fixture.ts';
import { authDatabase } from '../support/auth-database.ts';
import { packedAuthRuntime } from '../support/auth-runtime.ts';
import { readSessionArtifact } from '../support/session-artifact.ts';

const execFileAsync = promisify(execFile);
const modelId = 'deepseek-v4.1-flash';
const modelRef = `onelink:chat:${modelId}`;
const contextWindow = 8192;
const apiKey = 'synthetic-m3-profile-owner';
const assistantText = 'fixture answer';
const base = '/api/v1/conversations';
let database: Awaited<ReturnType<typeof authDatabase>>;
let observer: Pool;
let runtime: Awaited<ReturnType<typeof packedAuthRuntime>>;
let cookie = '';

const call = (path: string, method = 'GET', body?: unknown) =>
  fetch(`${runtime.origin}${path}`, {
    method,
    headers: {
      origin: runtime.origin,
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });

async function json<T>(response: Response, status: number): Promise<T> {
  const raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
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
      if (done) throw new Error('Profile event stream ended before settlement');
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
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

async function settled(
  stream: AsyncGenerator<Frame>,
  path: string,
  requestId: string,
  status: TerminalRequestStatus = 'completed',
) {
  let text = '';
  for (;;) {
    const { value: frame, done } = await stream.next();
    if (done) throw new Error(`No terminal state for ${requestId}`);
    if (frame.type === 'error') throw new Error(`Profile event error: ${frame.code}`);
    if (frame.type === 'text' && frame.requestId === requestId) text += frame.text;
    if (
      frame.type === 'state' &&
      frame.receipt.requestId === requestId &&
      !isInFlightRequest(frame.receipt.status)
    ) {
      expect(frame.receipt.status, JSON.stringify(frame)).toBe(status);
      const receipt = await json<Receipt>(await call(`${path}/requests/${requestId}`), 200);
      expect(frame.receipt).toEqual(receipt);
      return { ...frame, text };
    }
  }
}

async function history(path: string) {
  const items: HistoryPage['items'] = [];
  let afterSeq = -1;
  for (;;) {
    const page = await json<HistoryPage>(
      await call(`${path}/history?limit=2&afterSeq=${afterSeq}`),
      200,
    );
    expect(page.items.length).toBeLessThanOrEqual(2);
    items.push(...page.items);
    if (!page.hasMore) return items;
    expect(page.nextAfterSeq).toBeGreaterThan(afterSeq);
    afterSeq = page.nextAfterSeq;
  }
}

async function observations(id: string, requestId: string) {
  const result = await observer.query<{ model_observations: ModelObservation[] }>(
    'SELECT model_observations FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2',
    [id, requestId],
  );
  return result.rows[0]?.model_observations;
}

beforeAll(async () => {
  database = await authDatabase();
  observer = new Pool({ connectionString: database.observerURL });
  const providerMasterKey = randomBytes(32).toString('base64');
  const providerKeyId = 'm3-profile';
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
  const route = makeChatRouteFixture(modelId, 'deepseek', { contextWindow, maxOutputTokens: 1024 });
  await importRoutesViaCli(env, route);
  runtime = await packedAuthRuntime(database.url, '', 'unused', {
    conversations: true,
    onelinkFixture: true,
    providerMasterKey,
    providerKeyId,
  });
  await runtime.start('database');
  const signup = await call('/api/auth/sign-up/email', 'POST', {
    name: 'M3 剧本作者',
    email: 'm3-profile-owner@example.test',
    password: 'm3-profile-owner-fixture-7412',
  });
  await json(signup, 200);
  cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  await json(
    await call('/api/v1/providers/onelink/credential', 'PUT', { apiKey, expectedRevision: 0 }),
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

it('compacts through the packed Profile, restores its history and limits overflow recovery to one retry', async () => {
  const { id } = await json<Conversation>(await call(base, 'POST', { modelRef }), 201);
  const path = `${base}/${id}`;
  const assetId = '785fc006-6aaa-4f29-b962-4b08497501f5';
  const original = `盐雾城的时钟由同一首报时曲控制。钟表匠苏荞保留着旧纪年的记忆，她的定妆照 assetId=${assetId}。第一集必须从最后一班夜渡开始，不得提前揭晓钟楼失火的原因。`;
  const recent = '锁定第三场在天亮前结束。';
  const inputs = [original, '第二场中，守渡人第一次怀疑报时曲停了。', recent];
  const compactId = 'compact-script';
  const compact = () => call(`${path}/compact`, 'POST', { requestId: compactId });
  const stream = events(path);
  let originalHistory: Awaited<ReturnType<typeof history>>;
  let compactReceipt: Receipt;
  let artifact: string;
  let compactedLog: string;
  try {
    expect((await stream.next()).value).toMatchObject({
      type: 'snapshot',
      conversationId: id,
      activeRequestId: null,
      receipt: null,
      contextUsage: { compacted: false },
    });
    let beforeTokens = 0;
    for (const [index, text] of inputs.entries()) {
      const requestId = `scene-${index}`;
      await json(await call(`${path}/messages`, 'POST', { requestId, text }), 202);
      const state = await settled(stream, path, requestId);
      expect(state.text).toBe(assistantText);
      expect(state.contextUsage).toMatchObject({ contextWindow, compacted: false });
      beforeTokens = state.contextUsage!.estimatedTokens;
    }
    expect(await runtime.onelinkRequests()).toHaveLength(inputs.length);
    originalHistory = await history(path);
    expect(originalHistory).toMatchObject(
      inputs.flatMap((text) => [
        { role: 'user', text },
        { role: 'assistant', text: assistantText },
        { role: 'status', status: 'completed' },
      ]),
    );
    const [legacyRoot, compressedRoot] = runtime.nativeLogRoots;
    const modernFiles = (await readdir(compressedRoot, { recursive: true })).filter((file) =>
      file.endsWith('.jsonl.zstd'),
    );
    expect(modernFiles).toHaveLength(1);
    const legacyFiles = await readdir(legacyRoot, { recursive: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    expect(legacyFiles.some((file) => file.endsWith('.jsonl'))).toBe(false);
    artifact = join(compressedRoot, modernFiles[0]!);
    const originalLog = await readSessionArtifact(artifact);

    await json(await compact(), 202);
    const terminal = await settled(stream, path, compactId);
    compactReceipt = terminal.receipt;
    expect(terminal.text).toBe('');
    expect(terminal.contextUsage).toEqual({
      contextWindow,
      compacted: true,
      estimatedTokens: expect.any(Number),
    });
    expect(terminal.contextUsage!.estimatedTokens).toBeLessThan(beforeTokens);
    compactedLog = await readSessionArtifact(artifact);
    expect(compactedLog.startsWith(originalLog)).toBe(true);
    expect(compactedLog.slice(originalLog.length)).toContain('"compaction/summary"');
  } finally {
    await stream.return(undefined);
  }

  const wireAfterCompact = await runtime.onelinkRequests();
  expect(wireAfterCompact).toHaveLength(inputs.length + 1);
  const summary = wireAfterCompact.at(-1)!;
  expect(summary).toMatchObject({
    authorization: `Bearer ${apiKey}`,
    path: '/v1/chat/completions',
    body: { model: modelId },
  });
  expect(summary.body.tools ?? []).toEqual([]);
  const summaryMessages = summary.body.messages as { role: string; content: string }[];
  expect(summaryMessages.map(({ role }) => role)).toEqual(['system', 'user']);
  expect(summaryMessages[0]!.content).toContain('世界观与时代设定');
  expect(JSON.parse(summaryMessages[1]!.content)).toMatchObject({
    rows: expect.arrayContaining([{ role: 'user', text: original }]),
    references: [`assetId=${assetId}`],
  });

  const observed = {
    status: 200,
    finish: 'stop',
    usageStatus: 'reported',
    providerRequestId: 'fixture-request-id',
  };
  expect(await observations(id, compactId)).toMatchObject([{ ...observed, purpose: 'compaction' }]);
  const bodyObservations = await observations(id, 'scene-0');
  expect(bodyObservations).toMatchObject([observed]);
  expect(bodyObservations?.[0]).not.toHaveProperty('purpose');

  await runtime.stop();
  await runtime.start('database');
  expect(await history(path)).toEqual(originalHistory);
  expect(await json<Receipt>(await compact(), 202)).toEqual(compactReceipt);
  expect(await readSessionArtifact(artifact)).toBe(compactedLog);
  const coldStream = events(path);
  const followup = '下一集的筹备表里，需要引用钟表匠的哪张定妆照？';
  try {
    expect((await coldStream.next()).value).toMatchObject({
      type: 'snapshot',
      activeRequestId: null,
      receipt: compactReceipt,
      contextUsage: { contextWindow, compacted: true },
    });
    expect(await runtime.onelinkRequests()).toHaveLength(wireAfterCompact.length);
    await json(
      await call(`${path}/messages`, 'POST', { requestId: 'cold-followup', text: followup }),
      202,
    );
    const terminal = await settled(coldStream, path, 'cold-followup');
    expect(terminal.text).toBe(assistantText);
    expect(terminal.contextUsage).toMatchObject({ contextWindow, compacted: true });
  } finally {
    await coldStream.return(undefined);
  }
  const advanced = await runtime.onelinkRequests();
  expect(advanced).toHaveLength(wireAfterCompact.length + 1);
  const lastMessages = advanced.at(-1)!.body.messages as { role: string; content: string }[];
  const checkpoint = lastMessages.find(
    ({ role, content }) => role === 'user' && content.includes(`assetId=${assetId}`),
  );
  expect(checkpoint?.content).toContain(assistantText);
  expect(lastMessages).toContainEqual(expect.objectContaining({ role: 'user', content: recent }));
  expect(JSON.stringify(lastMessages)).not.toContain('钟楼失火');
  expect(lastMessages.at(-1)).toMatchObject({ role: 'user', content: followup });
  const updatedHistory = await history(path);
  expect(updatedHistory.slice(0, originalHistory.length)).toEqual(originalHistory);
  expect(updatedHistory.slice(originalHistory.length)).toMatchObject([
    { role: 'user', text: followup },
    { role: 'assistant', text: assistantText },
    { role: 'status', status: 'completed' },
  ]);
  expect((await readSessionArtifact(artifact)).startsWith(compactedLog)).toBe(true);

  const overflowId = 'overflow-script';
  const failureMarker = 'FIXTURE_FAILURE_CONTEXT';
  const overflow = () =>
    call(`${path}/messages`, 'POST', {
      requestId: overflowId,
      text: `沿用夜渡场景继续改写下一场。${failureMarker}`,
    });
  const overflowStream = events(path);
  try {
    await overflowStream.next();
    await json(await overflow(), 202);
    const terminal = await settled(overflowStream, path, overflowId, 'failed');
    expect(terminal.receipt).toEqual({
      conversationId: id,
      requestId: overflowId,
      status: 'failed',
      error: 'MODEL_CONTEXT_OVERFLOW',
    });
    expect(terminal.text).toBe('');
    const failedAttempt = {
      status: 400,
      finish: 'error',
      usageStatus: 'unknown',
      failureCode: 'CONTEXT_OVERFLOW',
    };
    const recordedAttempts = await observations(id, overflowId);
    expect(recordedAttempts).toMatchObject([
      failedAttempt,
      { ...observed, purpose: 'compaction' },
      failedAttempt,
    ]);
    expect(recordedAttempts?.map(({ purpose }) => purpose)).toEqual([
      undefined,
      'compaction',
      undefined,
    ]);
    const attempts = (await runtime.onelinkRequests()).slice(advanced.length);
    expect(attempts).toHaveLength(3);
    expect(
      attempts.map(({ body }) => JSON.stringify(body.messages).includes(failureMarker)),
    ).toEqual([true, false, true]);
    expect(await json<Receipt>(await overflow(), 202)).toEqual(terminal.receipt);
    expect(await runtime.onelinkRequests()).toHaveLength(advanced.length + 3);
  } finally {
    await overflowStream.return(undefined);
  }
}, 30000);
