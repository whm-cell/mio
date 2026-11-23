import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Conversation, HistoryPage, Receipt } from '../../src/conversations/contracts.ts';
import {
  importRoutesViaCli,
  makeChatRouteFixture,
} from '../providers/fixtures/onelink-routes-fixture.ts';
import { authDatabase } from '../support/auth-database.ts';
import { packedAuthRuntime } from '../support/auth-runtime.ts';

const execFileAsync = promisify(execFile);
const base = '/api/v1/conversations';
const modelA = 'deepseek-v4.1-flash';
const modelB = 'deepseek-v4-flash';
const modelWithoutReasoning = 'deepseek-chat';
const legacyRef = (modelId: string) => `onelink:chat:${modelId}`;
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
    { name: label, email: `m6-${label}@example.test`, password: 'm6-profile-fixture-7431' },
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

const create = (options: { purpose?: string; reasoningEffort?: string } = {}) =>
  call(base, 'POST', { modelRef: legacyRef(modelA), ...options }).then((res) =>
    json<Conversation>(res, 201),
  );
const history = (id: string) =>
  call(`${base}/${id}/history?limit=100`).then((res) => json<HistoryPage>(res, 200));
const request = (id: string, requestId: string) =>
  call(`${base}/${id}/requests/${requestId}`).then((res) => json<Receipt>(res, 200));
const send = (id: string, requestId: string, text: string) =>
  call(`${base}/${id}/messages`, 'POST', { requestId, text }).then((res) =>
    json<Receipt>(res, 202),
  );
const select = (id: string, modelId: string) =>
  call(`${base}/${id}/model`, 'PUT', { modelRef: legacyRef(modelId) });
const fork = (id: string, body: unknown, cookie?: string) =>
  call(`${base}/${id}/forks`, 'POST', body, cookie);
const boundaries = (page: HistoryPage) =>
  page.items.filter((item) => item.role === 'status').map((item) => item.seq);

async function turn(id: string, requestId: string, text: string) {
  await send(id, requestId, text);
  await expect.poll(async () => (await request(id, requestId)).status).toBe('completed');
}

async function artifact(nativeId: string) {
  const files = (
    await Promise.all(
      runtime.nativeLogRoots.map((root) =>
        readdir(root, { recursive: true, withFileTypes: true }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
          },
        ),
      ),
    )
  )
    .flat()
    .filter(
      (entry) =>
        entry.isFile() &&
        basename(entry.parentPath) === nativeId &&
        (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')),
    );
  expect(files).toHaveLength(1);
  return readFile(join(files[0]!.parentPath, files[0]!.name));
}

const stored = async (id: string) =>
  (
    await observer.query<{
      id: string;
      dsh_session_id: string;
      state: string;
      model_binding: Record<string, unknown>;
    }>('SELECT id,dsh_session_id,state,model_binding FROM mio_conversations WHERE id=$1', [id])
  ).rows[0]!;
const receipts = async (id: string) =>
  (
    await observer.query<{
      request_id: string;
      model_binding: { modelId: string };
      model_observations: unknown[];
    }>('SELECT * FROM mio_conversation_requests WHERE conversation_id=$1 ORDER BY request_id', [id])
  ).rows;

beforeAll(async () => {
  database = await authDatabase();
  observer = new Pool({ connectionString: database.observerURL });
  const providerMasterKey = randomBytes(32).toString('base64');
  const providerKeyId = 'm6-profile';
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
  const reasoningRoutes = [modelA, modelB].map((id) => ({
    ...makeChatRouteFixture(id, 'deepseek'),
    capabilityMetadata: { reasoning: { supported: true, efforts: ['low' as const] } },
  }));
  await importRoutesViaCli(env, [
    ...reasoningRoutes,
    makeChatRouteFixture(modelWithoutReasoning, 'deepseek'),
  ]);
  runtime = await packedAuthRuntime(database.url, '', 'unused', {
    conversations: true,
    onelinkFixture: true,
    providerMasterKey,
    providerKeyId,
  });
  await runtime.setOnelinkCatalog([modelA, modelB, modelWithoutReasoning]);
  await runtime.start('database');
  owner = await signup('owner');
  outsider = await signup('outsider');
  await json(
    await call('/api/v1/providers/onelink/credential', 'PUT', {
      apiKey: 'synthetic-m6-profile-owner',
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

it('forks two of three settled turns and runs the child on the source model selected now', async () => {
  const source = await create({ purpose: 'drama-script', reasoningEffort: 'low' });
  await runtime.setConversationProjectContext({
    ownerId: owner.id,
    conversationId: source.id,
    snapshot: { scriptSummary: 'M6_SOURCE_PRIVATE_PROJECT' },
  });
  await turn(source.id, 'source-one', 'M6_FIRST_TURN');
  await turn(source.id, 'source-two', 'M6_SECOND_TURN');
  await turn(source.id, 'source-three', 'M6_SOURCE_TAIL_EXCLUDED');
  await json(await call(`${base}/${source.id}`, 'PATCH', { title: 'Forkable source' }), 200);
  const original = await history(source.id);
  expect(boundaries(original)).toHaveLength(3);
  const cutoff = boundaries(original)[1]!;
  const sourceNativeId = (await stored(source.id)).dsh_session_id;
  const originalBytes = await artifact(sourceNativeId);
  const before = await receipts(source.id);
  expect(before.map((row) => row.model_binding.modelId)).toEqual([modelA, modelA, modelA]);
  const baseline = (await runtime.onelinkRequests()).length;

  expect(await json(await select(source.id, modelWithoutReasoning), 409)).toMatchObject({
    error: { code: 'MODEL_REASONING_UNSUPPORTED' },
  });
  expect((await stored(source.id)).model_binding.modelId).toBe(modelA);
  const switched = await json<Conversation>(await select(source.id, modelB), 200);
  expect(switched.modelRef).not.toBe(source.modelRef);
  expect(switched.reasoningEffort).toBe('low');
  const replies = await Promise.all(
    [0, 1, 2].map(() => fork(source.id, { requestId: 'second', turnEndSeq: cutoff })),
  );
  expect(replies.map((res) => res.status).sort()).toEqual([200, 200, 201]);
  const children = (await Promise.all(replies.map((res) => res.json()))) as Conversation[];
  const child = children[0]!;
  expect(children).toEqual([child, child, child]);
  expect(child.id).not.toBe(source.id);
  expect(child).toMatchObject({
    state: 'ready',
    modelRef: switched.modelRef,
    title: 'Forkable source',
    purpose: 'drama-script',
    reasoningEffort: 'low',
    forkedFromConversationId: source.id,
    forkedUntilSeq: cutoff,
  });
  const childRow = await stored(child.id);
  expect(childRow.dsh_session_id).not.toBe(sourceNativeId);
  expect(childRow.model_binding).toEqual((await stored(source.id)).model_binding);
  expect(childRow.model_binding).not.toHaveProperty('apiKey');
  expect(await receipts(child.id)).toEqual([]);
  expect((await history(child.id)).items).toEqual(
    original.items.filter(({ seq }) => seq <= cutoff),
  );
  expect(await history(source.id)).toEqual(original);
  expect(await artifact(sourceNativeId)).toEqual(originalBytes);
  expect(await runtime.onelinkRequests()).toHaveLength(baseline);
  expect(await receipts(source.id)).toEqual(before);

  // The child has no linkage to the source project, despite inheriting the native history.
  await turn(child.id, 'child-unlinked', 'M6_CHILD_CONTINUES');
  await runtime.setConversationProjectContext({
    ownerId: owner.id,
    conversationId: child.id,
    snapshot: { scriptSummary: 'M6_CHILD_PRIVATE_PROJECT' },
  });
  await turn(child.id, 'child-linked', 'M6_CHILD_LINKED');
  const wires = await runtime.onelinkRequests();
  expect(wires).toHaveLength(baseline + 2);
  for (const { body } of wires.slice(-2)) {
    expect(body.model).toBe(modelB);
    expect(JSON.stringify(body.messages)).toContain('M6_FIRST_TURN');
    expect(JSON.stringify(body.messages)).toContain('M6_SECOND_TURN');
    expect(JSON.stringify(body.messages)).not.toMatch(
      /M6_(SOURCE_TAIL_EXCLUDED|SOURCE_PRIVATE_PROJECT)/,
    );
  }
  expect(JSON.stringify(wires.at(-2)?.body)).not.toContain('M6_CHILD_PRIVATE_PROJECT');
  expect(JSON.stringify(wires.at(-1)?.body)).toContain('M6_CHILD_PRIVATE_PROJECT');
  expect((await receipts(child.id)).map((row) => row.model_binding.modelId)).toEqual([
    modelB,
    modelB,
  ]);
  expect(await history(source.id)).toEqual(original);
  expect(await artifact(sourceNativeId)).toEqual(originalBytes);
  expect(await receipts(source.id)).toEqual(before);

  await turn(source.id, 'source-after-switch', 'M6_SOURCE_USES_NEW_MODEL');
  const after = await receipts(source.id);
  expect((await runtime.onelinkRequests()).at(-1)?.body.model).toBe(modelB);
  expect(after.find((row) => row.request_id === 'source-after-switch')).toMatchObject({
    model_binding: { modelId: modelB },
    model_observations: [{ status: 200, finish: 'stop' }],
  });
  expect(after.filter((row) => row.request_id !== 'source-after-switch')).toEqual(before);

  // A later source selection never replaces the child's current binding on replay.
  await json(await select(source.id, modelA), 200);
  expect(
    await json(await fork(source.id, { requestId: 'second', turnEndSeq: cutoff }), 200),
  ).toMatchObject({ id: child.id, modelRef: switched.modelRef });
}, 15000);

it('rejects malformed, foreign and unfinished boundaries while allowing a busy or archived source', async () => {
  const source = await create();
  const baseline = (await runtime.onelinkRequests()).length;
  for (const body of [
    {},
    { requestId: 'missing', turnEndSeq: '1' },
    { requestId: 'missing', turnEndSeq: -1 },
    { requestId: 'missing', turnEndSeq: 0.5 },
    { requestId: 'missing', turnEndSeq: null },
    { requestId: 'missing', ownerId: outsider.id },
  ]) {
    expect(await json(await fork(source.id, body), 400)).toMatchObject({
      error: { code: 'BODY_INVALID' },
    });
  }
  expect(await json(await fork(source.id, { requestId: 'empty' }), 409)).toMatchObject({
    error: { code: 'CONVERSATION_FORK_BOUNDARY_INVALID' },
  });
  expect(await runtime.onelinkRequests()).toHaveLength(baseline);
  await turn(source.id, 'closed', 'M6_CLOSED_TURN');
  const settled = await history(source.id);
  const cutoff = boundaries(settled)[0]!;
  expect(
    await json(
      await fork(source.id, { requestId: 'foreign', turnEndSeq: cutoff }, outsider.cookie),
      404,
    ),
  ).toMatchObject({ error: { code: 'CONVERSATION_NOT_FOUND' } });
  await send(source.id, 'open', 'M6_HOLD_OPEN');
  await expect.poll(() => runtime.onelinkRequests()).toHaveLength(baseline + 2);
  const open = (await history(source.id)).items.find(
    (item) => item.role === 'user' && item.seq > cutoff,
  )!;
  expect(open).toMatchObject({ text: 'M6_HOLD_OPEN' });
  expect(
    await json(await fork(source.id, { requestId: 'open', turnEndSeq: open.seq }), 409),
  ).toMatchObject({
    error: { code: 'CONVERSATION_FORK_BOUNDARY_INVALID' },
  });
  expect(await json(await select(source.id, modelB), 409)).toMatchObject({
    error: { code: 'CONVERSATION_BUSY' },
  });
  const during = await json<Conversation>(await fork(source.id, { requestId: 'last' }), 201);
  expect(during.forkedUntilSeq).toBe(cutoff);
  expect((await history(during.id)).items).toEqual(settled.items);
  expect(
    await json(await fork(source.id, { requestId: 'last', turnEndSeq: cutoff }), 409),
  ).toMatchObject({ error: { code: 'REQUEST_ID_CONFLICT' } });
  await json(await call(`${base}/${source.id}/cancel`, 'POST', {}), 202);
  await expect.poll(async () => (await request(source.id, 'open')).status).toBe('cancelled');
  await json(await call(`${base}/${source.id}`, 'DELETE'), 200);
  expect(await json(await select(source.id, modelB), 409)).toMatchObject({
    error: { code: 'CONVERSATION_ARCHIVED' },
  });
  const archived = await json<Conversation>(
    await fork(source.id, { requestId: 'archived', turnEndSeq: cutoff }),
    201,
  );
  expect((await history(archived.id)).items).toEqual(settled.items);
  expect(archived.id).not.toBe(during.id);
  expect(await runtime.onelinkRequests()).toHaveLength(baseline + 2);
}, 15000);

it('recovers a native fork after PG rejects ready without resolving a newer cutoff or creating a new file', async () => {
  const source = await create();
  await turn(source.id, 'initial', 'M6_RECOVERY_PREFIX');
  const prefix = await history(source.id);
  const cutoff = boundaries(prefix)[0]!;
  await observer.query(`
    CREATE FUNCTION mio_m6_reject_ready() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.fork_request_id='fault' AND NEW.state='ready' THEN
        RAISE EXCEPTION 'm6-ready-fault';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER mio_m6_reject_ready BEFORE UPDATE OF state ON mio_conversations
    FOR EACH ROW EXECUTE FUNCTION mio_m6_reject_ready();
  `);
  const body = { requestId: 'fault' };
  try {
    const baseline = (await runtime.onelinkRequests()).length;
    expect(await json(await fork(source.id, body), 503)).toMatchObject({
      error: { code: 'CONVERSATION_UNKNOWN' },
    });
    expect(await runtime.onelinkRequests()).toHaveLength(baseline);
    const reserved = (
      await observer.query<{
        id: string;
        dsh_session_id: string;
        state: string;
        forked_until_seq: string;
      }>(
        'SELECT id,dsh_session_id,state,forked_until_seq FROM mio_conversations WHERE forked_from_conversation_id=$1 AND fork_request_id=$2',
        [source.id, body.requestId],
      )
    ).rows;
    expect(reserved).toHaveLength(1);
    const child = reserved[0]!;
    expect(child).toMatchObject({ state: 'creating', forked_until_seq: String(cutoff) });
    const native = await artifact(child.dsh_session_id);
    await runtime.stop();
    await runtime.start('database');
    expect((await stored(child.id)).state).toBe('creating');
    expect(await json(await fork(source.id, { ...body, turnEndSeq: cutoff }), 409)).toMatchObject({
      error: { code: 'REQUEST_ID_CONFLICT' },
    });
    await turn(source.id, 'later', 'M6_RECOVERY_TAIL_EXCLUDED');
    await json(await select(source.id, modelB), 200);
    await observer.query('DROP TRIGGER mio_m6_reject_ready ON mio_conversations');
    expect(await json(await fork(source.id, body), 201)).toMatchObject({
      id: child.id,
      modelRef: source.modelRef,
      state: 'ready',
      forkedUntilSeq: cutoff,
    });
    expect((await history(child.id)).items).toEqual(prefix.items);
    expect(await artifact(child.dsh_session_id)).toEqual(native);
    await json(await call(`${base}/${child.id}`, 'DELETE'), 200);
    expect(await json(await fork(source.id, body), 200)).toMatchObject({ id: child.id });
    expect((await stored(child.id)).dsh_session_id).toBe(child.dsh_session_id);
    const { items } = await json<{ items: Conversation[] }>(await call(base), 200);
    expect(items.some(({ id }) => id === child.id)).toBe(false);
    expect(await runtime.onelinkRequests()).toHaveLength(baseline + 1);
  } finally {
    await observer.query(
      'DROP TRIGGER IF EXISTS mio_m6_reject_ready ON mio_conversations; DROP FUNCTION mio_m6_reject_ready()',
    );
  }
}, 25000);
