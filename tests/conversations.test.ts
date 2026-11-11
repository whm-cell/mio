import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import type { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as Mio from '../src/plugin.ts';
import * as Stores from '../src/conversations/store.ts';
import type { Receipt } from '../src/conversations/contracts.ts';
import { authDatabase } from './auth-database.ts';
import { kernelRuntime, ScriptedModel, textResponse } from './kernel-runtime.ts';
import type { ModelScript } from './kernel-runtime.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let observer: Pool;
let ctx: Context;
let origin: string;
let root: string;
let plugin: ReturnType<Context['plugin']>;
let store: Stores.ConversationStore;
let ownerCookie: string;
let otherCookie: string;
const script: ModelScript[] = [];
const model = new ScriptedModel(script);
const password = 'mio-conversation-test-strong-47';
const secret = randomBytes(40).toString('hex');

const call = (
  path: string,
  value?: unknown,
  cookie = ownerCookie,
  extra: Record<string, string> = {},
) =>
  fetch(`${origin}${path}`, {
    method: value === undefined ? 'GET' : 'POST',
    headers: {
      origin,
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .join('; ');
async function create() {
  const response = await call('/api/v1/conversations', {});
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}
const path = (id: string, suffix: string) => `/api/v1/conversations/${id}/${suffix}`;
const send = (id: string, requestId: string, text: string) =>
  call(path(id, 'messages'), { requestId, text });
async function terminal(id: string, requestId: string): Promise<Receipt> {
  let receipt: Receipt | undefined;
  await vi.waitFor(
    async () => {
      const response = await call(path(id, `requests/${requestId}`));
      expect(response.status).toBe(200);
      receipt = (await response.json()) as Receipt;
      expect(['completed', 'cancelled', 'failed', 'unknown']).toContain(receipt.status);
    },
    { timeout: 5000, interval: 10 },
  );
  return receipt!;
}
function controlled(text = 'visible partial') {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const response: ModelScript = async function* (options) {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    entered.resolve();
    await Promise.race([
      release.promise,
      new Promise<never>((_resolve, reject) => {
        const abort = () => reject(options.signal?.reason ?? new Error('aborted'));
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  return { entered: entered.promise, release: () => release.resolve(), response };
}
async function events(id: string, cookie = ownerCookie) {
  const abort = new AbortController();
  const response = await fetch(`${origin}${path(id, 'events')}`, {
    headers: { origin, cookie },
    signal: abort.signal,
  });
  expect(
    response.status,
    await (response.status === 200 ? Promise.resolve('') : response.text()),
  ).toBe(200);
  const reader = response.body!.getReader();
  const received: Record<string, unknown>[] = [];
  let done = false;
  let buffer = '';
  const reading = (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        buffer += new TextDecoder().decode(next.value);
        let split: number;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) received.push(JSON.parse(data.slice(6)) as Record<string, unknown>);
        }
      }
    } catch {
      /* Client abort and explicit authorization close are observed separately. */
    } finally {
      done = true;
    }
  })();
  return {
    received,
    get done() {
      return done;
    },
    async close() {
      abort.abort();
      await reading;
    },
    async wait(predicate: (item: Record<string, unknown>) => boolean) {
      await vi.waitFor(() => expect(received.some(predicate)).toBe(true), {
        timeout: 5000,
        interval: 10,
      });
    },
  };
}

beforeAll(async () => {
  database = await authDatabase();
  observer = new Pool({ connectionString: database.observerURL });
  root = await mkdtemp(join(tmpdir(), 'mio-conversations-'));
  ctx = await kernelRuntime(root, model);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  origin = ctx.webServer.getOrigin();
  vi.stubEnv('MIO_API_TOKEN', secret);
  vi.stubEnv('MIO_AUTH_DATABASE_URL', database.url);
  vi.stubEnv('MIO_AUTH_BASE_URL', origin);
  vi.stubEnv('MIO_AUTH_SECRET', secret);
  vi.stubEnv('MIO_AUTH_RATE_LIMIT_BACKEND', 'database');
  vi.stubEnv('MIO_AUTH_ALLOWED_ORIGINS', '[]');
  vi.stubEnv('MIO_CONVERSATIONS_DATABASE_URL', database.url);
  vi.stubEnv('MIO_MODEL_PROVIDER', 'mio-test-only');
  vi.stubEnv('MIO_MODEL', 'scripted');
  for (const file of [
    'scripts/service/migrate-auth.ts',
    'scripts/service/migrate-conversations.ts',
  ]) {
    const result = spawnSync(process.execPath, [file, '--apply'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  const original = Stores.createConversationStore;
  vi.spyOn(Stores, 'createConversationStore').mockImplementation(async (...args) => {
    store = await original(...args);
    return store;
  });
  plugin = ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
  await plugin;
  const owner = await call(
    '/api/auth/sign-up/email',
    { name: 'Owner', email: 'conversation-owner@example.test', password },
    '',
  );
  expect(owner.status, await owner.clone().text()).toBe(200);
  ownerCookie = cookies(owner);
  const other = await call(
    '/api/auth/sign-up/email',
    { name: 'Other', email: 'conversation-other@example.test', password },
    '',
  );
  expect(other.status, await other.clone().text()).toBe(200);
  otherCookie = cookies(other);
}, 45000);
beforeEach(async () => {
  script.length = 0;
  await observer.query('DELETE FROM "rateLimit"');
  const login = await call(
    '/api/auth/sign-in/email',
    { email: 'conversation-owner@example.test', password },
    '',
  );
  expect(login.status).toBe(200);
  ownerCookie = cookies(login);
});
afterAll(async () => {
  try {
    if (ctx) await ctx.fiber.dispose();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (observer) await observer.end();
    if (database) await database.close();
    if (root) await rm(root, { recursive: true, force: true });
  }
}, 30000);

it('enforces real user ownership, strict inputs, bounded lists and second-round model context', async () => {
  const id = await create();
  const capabilities = await fetch(`${origin}/api/v1/capabilities`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(await capabilities.json()).toMatchObject({ sessions: true, tools: [] });
  const empty = (await (await call(path(id, 'history'))).json()) as { nextAfterSeq: number };
  expect((await call(path(id, `history?afterSeq=${empty.nextAfterSeq}`))).status).toBe(200);
  const initial = model.requests.length;
  for (const suffix of ['history', 'events', 'requests/missing']) {
    expect((await call(path(id, suffix), undefined, otherCookie)).status).toBe(404);
    expect(
      (await call(path(id, suffix), undefined, '', { authorization: `Bearer ${secret}` })).status,
    ).toBe(401);
  }
  for (const [suffix, value] of [
    ['messages', { requestId: 'wrong', text: 'no' }],
    ['cancel', {}],
  ] as const)
    expect((await call(path(id, suffix), value, otherCookie)).status).toBe(404);
  expect((await call('/api/v1/conversations', { owner: 'forged' })).status).toBe(400);
  expect((await call('/api/v1/conversations', {}, '')).status).toBe(401);
  expect((await call('/api/v1/conversations?limit=101')).status).toBe(400);
  const others = (await (await call('/api/v1/conversations', undefined, otherCookie)).json()) as {
    items: { id: string }[];
  };
  expect(others.items.some((item) => item.id === id)).toBe(false);
  script.push(textResponse('remembered blue'), textResponse('blue again'));
  expect((await send(id, 'round-1', 'remember blue')).status).toBe(202);
  expect((await terminal(id, 'round-1')).status).toBe('completed');
  expect((await send(id, 'round-2', 'which color?')).status).toBe(202);
  expect((await terminal(id, 'round-2')).status).toBe('completed');
  expect(model.requests.length - initial).toBe(2);
  expect(JSON.stringify(model.requests.at(-1)!.messages)).toContain('remembered blue');
  const first = (await (await call(path(id, 'history?limit=2'))).json()) as {
    items: unknown[];
    nextAfterSeq: number;
    hasMore: boolean;
  };
  expect(first.items).toHaveLength(2);
  expect(first.hasMore).toBe(true);
  const second = (await (
    await call(path(id, `history?afterSeq=${first.nextAfterSeq}&limit=2`))
  ).json()) as { items: unknown[] };
  expect(second.items).toHaveLength(2);
  expect(JSON.stringify([first, second])).not.toContain('mio-test-only');
});

it.each(['native-create', 'native-flush', 'metadata-ready'] as const)(
  'keeps a failed %s creation queryable as unknown without executing a model',
  async (failure) => {
    const before = new Set(
      (await observer.query<{ id: string }>('SELECT id FROM mio_conversations')).rows.map(
        (row) => row.id,
      ),
    );
    const initial = model.requests.length;
    const createFailure =
      failure === 'native-create'
        ? vi.spyOn(ctx.mioKernel, 'create').mockRejectedValueOnce(new Error('private-create'))
        : undefined;
    const detach =
      failure === 'native-flush'
        ? ctx.on('session/flush', () => {
            throw new Error('private-flush');
          })
        : undefined;
    if (failure === 'metadata-ready')
      await observer.query(
        `CREATE FUNCTION mio_fail_ready() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='ready' THEN RAISE EXCEPTION 'private-ready'; END IF; RETURN NEW; END $$; CREATE TRIGGER mio_fail_ready BEFORE UPDATE ON mio_conversations FOR EACH ROW EXECUTE FUNCTION mio_fail_ready()`,
      );
    try {
      const response = await call('/api/v1/conversations', {});
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'CONVERSATION_UNKNOWN' } });
      const rows = (
        await observer.query<{ id: string; state: string }>(
          'SELECT id,state FROM mio_conversations',
        )
      ).rows.filter((row) => !before.has(row.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe('unknown');
      const listed = (await (await call('/api/v1/conversations?limit=100')).json()) as {
        items: { id: string; state: string }[];
      };
      expect(listed.items).toContainEqual(expect.objectContaining(rows[0]!));
      expect((await send(rows[0]!.id, 'failed-create', 'must not execute')).status).toBe(409);
      expect(model.requests.length).toBe(initial);
    } finally {
      createFailure?.mockRestore();
      detach?.();
      if (failure === 'metadata-ready')
        await observer.query(
          'DROP TRIGGER mio_fail_ready ON mio_conversations; DROP FUNCTION mio_fail_ready()',
        );
    }
    expect(await create()).toBeTruthy();
  },
);

it('fails closed on corrupt durable public history without exposing native diagnostics', async () => {
  const id = await create();
  script.push(textResponse('private-history-content'));
  await send(id, 'before-corruption', 'durable input');
  expect((await terminal(id, 'before-corruption')).status).toBe('completed');
  const initial = model.requests.length;
  const target = (
    await observer.query<{ dsh_session_id: string }>(
      'SELECT dsh_session_id FROM mio_conversations WHERE id=$1',
      [id],
    )
  ).rows[0]!.dsh_session_id;
  expect(ctx.sessions.get(SessionId(target))).toBeFalsy();
  const stat = await ctx.sessionPersistence.stat(SessionId(target));
  if (stat?.location?.kind !== 'jsonl') throw new Error('missing isolated JSONL location');
  const original = await readFile(stat.location.path, 'utf8');
  const corrupt = original.replace('"type":"user/message"', '"type":"ptc/retired-required"');
  expect(corrupt).not.toBe(original);
  try {
    await writeFile(stat.location.path, corrupt);
    const response = await call(path(id, 'history'));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain('private-history-content');
    expect(body).not.toContain('ptc/retired-required');
    expect(body).not.toContain(stat.location.path);
    expect((await call(path(id, 'history'), undefined, otherCookie)).status).toBe(404);
    expect((await terminal(id, 'before-corruption')).status).toBe('completed');
    expect(model.requests.length).toBe(initial);
  } finally {
    await writeFile(stat.location.path, original);
  }
  expect((await call(path(id, 'history'))).status).toBe(200);
});

it('rejects busy input, de-duplicates reception and preserves a queryable cancelled result', async () => {
  const id = await create();
  const gate = controlled();
  script.push(gate.response);
  const initial = model.requests.length;
  expect((await send(id, 'same-id', 'hold')).status).toBe(202);
  await gate.entered;
  expect((await send(id, 'same-id', 'hold')).status).toBe(202);
  expect((await send(id, 'same-id', 'different')).status).toBe(409);
  expect((await send(id, 'new-id', 'other input')).status).toBe(409);
  expect(model.requests.length - initial).toBe(1);
  expect((await call(path(id, 'cancel'), {})).status).toBe(202);
  expect((await terminal(id, 'same-id')).status).toBe('cancelled');
  expect((await call(path(id, 'cancel'), {})).status).toBe(202);
  expect((await send(id, 'same-id', 'hold')).status).toBe(202);
  expect(model.requests.length - initial).toBe(1);
});

it.each(['normal', 'before-commit', 'lost-ack'] as const)(
  'settles pre-execution cancellation without starting a model: %s',
  async (mode) => {
    const id = await create();
    const count = model.requests.length;
    const receive = store.receive.bind(store);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const spy = vi.spyOn(store, 'receive').mockImplementationOnce(async (...args) => {
      const result = await receive(...args);
      entered.resolve();
      await release.promise;
      return result;
    });
    const sending = send(id, 'cancel-before-run', 'not executed');
    const finish = store.finish.bind(store);
    const finishSpy =
      mode === 'lost-ack'
        ? vi.spyOn(store, 'finish').mockImplementationOnce(async (...args) => {
            await finish(...args);
            throw new Error('TEST_CANCEL_ACK_LOST');
          })
        : undefined;
    try {
      await entered.promise;
      const cancel = await call(path(id, 'cancel'), {});
      expect(cancel.status).toBe(202);
      expect(await cancel.json()).toMatchObject({
        requested: true,
        requestId: 'cancel-before-run',
      });
      if (mode === 'before-commit')
        await observer.query(
          `CREATE FUNCTION mio_fail_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='cancelled' THEN RAISE EXCEPTION 'test cancelled receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER mio_fail_cancel BEFORE UPDATE ON mio_conversation_requests FOR EACH ROW EXECUTE FUNCTION mio_fail_cancel()`,
        );
      release.resolve();
      expect((await sending).status).toBe(202);
      expect((await terminal(id, 'cancel-before-run')).status).toBe(
        mode === 'before-commit' ? 'unknown' : 'cancelled',
      );
      expect(model.requests.length).toBe(count);
      script.push(textResponse('next explicit request'));
      expect((await send(id, 'after-cancel', 'new explicit input')).status).toBe(202);
      expect((await terminal(id, 'after-cancel')).status).toBe('completed');
      expect(model.requests.length).toBe(count + 1);
    } finally {
      release.resolve();
      spy.mockRestore();
      finishSpy?.mockRestore();
      if (mode === 'before-commit')
        await observer.query(
          'DROP TRIGGER IF EXISTS mio_fail_cancel ON mio_conversation_requests; DROP FUNCTION IF EXISTS mio_fail_cancel()',
        );
    }
  },
);

it('does not let a delayed cancellation of an old request stop the following request', async () => {
  const id = await create();
  const first = controlled('first'),
    second = controlled('second');
  script.push(first.response, second.response);
  await send(id, 'old-request', 'first');
  await first.entered;
  const owned = store.owned.bind(store);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let once = true;
  const spy = vi.spyOn(store, 'owned').mockImplementation(async (...args) => {
    const row = await owned(...args);
    if (args[1] === id && once) {
      once = false;
      entered.resolve();
      await release.promise;
    }
    return row;
  });
  const cancelling = call(path(id, 'cancel'), {});
  try {
    await entered.promise;
    first.release();
    await terminal(id, 'old-request');
    await send(id, 'new-request', 'second');
    await second.entered;
    await vi.waitFor(
      async () =>
        expect(
          (await (await call(path(id, 'requests/new-request'))).json()) as Receipt,
        ).toMatchObject({ status: 'input-persisted' }),
      { timeout: 5000, interval: 10 },
    );
    release.resolve();
    expect((await cancelling).status).toBe(202);
    expect((await (await call(path(id, 'requests/new-request'))).json()) as Receipt).toMatchObject({
      status: 'input-persisted',
    });
    second.release();
    expect((await terminal(id, 'new-request')).status).toBe('completed');
  } finally {
    release.resolve();
    first.release();
    second.release();
    spy.mockRestore();
  }
});

it('reconciles a reception committed before acknowledgment failure without blocking a future explicit request', async () => {
  const id = await create();
  const count = model.requests.length;
  const receive = store.receive.bind(store);
  const spy = vi.spyOn(store, 'receive').mockImplementationOnce(async (...args) => {
    await receive(...args);
    throw new Error('TEST_RECEPTION_ACK_LOST');
  });
  try {
    expect((await send(id, 'unknown-reception', 'must not run')).status).toBe(503);
    expect((await terminal(id, 'unknown-reception')).status).toBe('unknown');
    expect((await send(id, 'unknown-reception', 'must not run')).status).toBe(202);
    expect(model.requests.length).toBe(count);
    script.push(textResponse('new explicit result'));
    expect((await send(id, 'new-after-unknown', 'new explicit request')).status).toBe(202);
    await terminal(id, 'new-after-unknown');
    expect(model.requests.length - count).toBe(1);
  } finally {
    spy.mockRestore();
  }
});

it('bounds request bodies and closes excessive stream frames while accepted execution completes', async () => {
  const id = await create();
  expect(
    (await call(path(id, 'messages'), { requestId: 'too-large', text: 'x'.repeat(16 * 1024) }))
      .status,
  ).toBe(413);
  expect(
    (await call(path(id, 'cancel'), {}, ownerCookie, { 'content-type': 'text/plain' })).status,
  ).toBe(415);
  expect(
    (await call(path(id, 'cancel'), {}, ownerCookie, { origin: 'https://wrong.example' })).status,
  ).toBe(403);
  const stream = await events(id);
  try {
    script.push(textResponse('x'.repeat(128 * 1024)));
    await send(id, 'large-output', 'public output');
    await vi.waitFor(() => expect(stream.done).toBe(true), { timeout: 3000 });
    expect((await terminal(id, 'large-output')).status).toBe('completed');
  } finally {
    await stream.close();
  }
});

it('closes a truly expired login stream and lets its already accepted request settle', async () => {
  const id = await create();
  const gate = controlled();
  script.push(gate.response);
  const stream = await events(id);
  try {
    await send(id, 'expire-in-flight', 'hold');
    await gate.entered;
    const me = (await (await call('/api/v1/me')).json()) as { sessionId: string };
    await observer.query(
      'UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1',
      [me.sessionId],
    );
    await vi.waitFor(() => expect(stream.done).toBe(true), { timeout: 3000 });
    expect((await call(path(id, 'history'))).status).toBe(401);
    gate.release();
    const login = await call(
      '/api/auth/sign-in/email',
      { email: 'conversation-owner@example.test', password },
      '',
    );
    ownerCookie = cookies(login);
    expect((await terminal(id, 'expire-in-flight')).status).toBe('completed');
  } finally {
    gate.release();
    await stream.close();
  }
});

it('streams only public text/status, continues after disconnect and closes revoked login without cancelling accepted work', async () => {
  const id = await create();
  const gate = controlled();
  const sensitive: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'SECRET_REASONING' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'SECRET_REASONING' } },
  ];
  script.push(
    sensitive.concat(
      textResponse('public first').map((chunk) =>
        'index' in chunk ? { ...chunk, index: 1 } : chunk,
      ),
    ),
  );
  const stream = await events(id);
  try {
    expect((await send(id, 'visible', 'first input')).status).toBe(202);
    await terminal(id, 'visible');
    await stream.wait((event) => event.type === 'text');
    expect(JSON.stringify(stream.received)).not.toContain('SECRET_REASONING');
    expect(JSON.stringify(await (await call(path(id, 'history'))).json())).not.toContain(
      'SECRET_REASONING',
    );
  } finally {
    await stream.close();
  }
  script.push(gate.response);
  const reconnect = await events(id);
  expect((await send(id, 'continue', 'hold until explicit release')).status).toBe(202);
  await gate.entered;
  await reconnect.close();
  const revoked = await events(id);
  try {
    expect((await call('/api/auth/sign-out', {})).status).toBe(200);
    await vi.waitFor(() => expect(revoked.done).toBe(true), { timeout: 3000, interval: 20 });
    expect((await send(id, 'after-logout', 'must reject')).status).toBe(401);
    gate.release();
    const login = await call(
      '/api/auth/sign-in/email',
      { email: 'conversation-owner@example.test', password },
      '',
    );
    ownerCookie = cookies(login);
    expect((await terminal(id, 'continue')).status).toBe('completed');
  } finally {
    gate.release();
    await revoked.close();
  }
});

it('keeps the final snapshot when completion occurs during the first subscription ownership read', async () => {
  const id = await create();
  const gate = controlled();
  script.push(gate.response);
  await send(id, 'snapshot-race', 'hold');
  await gate.entered;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const owned = store.owned.bind(store);
  let once = true;
  const spy = vi.spyOn(store, 'owned').mockImplementation(async (...args) => {
    const result = await owned(...args);
    if (args[1] === id && once) {
      once = false;
      entered.resolve();
      await release.promise;
    }
    return result;
  });
  const opening = events(id);
  try {
    await entered.promise;
    gate.release();
    await terminal(id, 'snapshot-race');
    release.resolve();
    const stream = await opening;
    try {
      await stream.wait((event) => event.type === 'snapshot');
      expect(stream.received[0]).toMatchObject({
        type: 'snapshot',
        receipt: { requestId: 'snapshot-race', status: 'completed' },
      });
    } finally {
      await stream.close();
    }
  } finally {
    release.resolve();
    gate.release();
    spy.mockRestore();
  }
});

it('does not execute when PostgreSQL reception fails and never resends a failed durability receipt', async () => {
  const id = await create();
  const initial = model.requests.length;
  await observer.query(
    `CREATE FUNCTION mio_fail_receive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test reception failure'; END $$; CREATE TRIGGER mio_fail_receive BEFORE INSERT ON mio_conversation_requests FOR EACH ROW EXECUTE FUNCTION mio_fail_receive()`,
  );
  try {
    expect((await send(id, 'receive-failed', 'not accepted')).status).toBe(503);
    expect(model.requests.length).toBe(initial);
  } finally {
    await observer.query(
      'DROP TRIGGER mio_fail_receive ON mio_conversation_requests; DROP FUNCTION mio_fail_receive()',
    );
  }
  const target = (
    await observer.query<{ dsh_session_id: string }>(
      'SELECT dsh_session_id FROM mio_conversations WHERE id=$1',
      [id],
    )
  ).rows[0]!.dsh_session_id;
  let flushes = 0;
  const detach = ctx.on('session/flush', async (session) => {
    if (session.id === target && ++flushes === 2) throw new Error('TEST_DURABILITY_FAILURE');
  });
  script.push(textResponse('possibly committed'));
  try {
    expect((await send(id, 'durability-failed', 'unknown receipt')).status).toBe(202);
    expect((await terminal(id, 'durability-failed')).status).toBe('unknown');
    const count = model.requests.length;
    expect((await send(id, 'durability-failed', 'unknown receipt')).status).toBe(202);
    await delay(30);
    expect(model.requests.length).toBe(count);
  } finally {
    detach();
  }
});

it('reconciles a lost completion acknowledgment and a discarded HTTP receipt by original request identity', async () => {
  const id = await create();
  const initial = model.requests.length;
  script.push(textResponse('persisted once'));
  const finish = store.finish.bind(store);
  const spy = vi.spyOn(store, 'finish').mockImplementationOnce(async (...args) => {
    await finish(...args);
    throw new Error('TEST_COMMIT_ACK_LOST');
  });
  try {
    const response = await send(id, 'response-lost', 'one execution');
    await response.body?.cancel();
    expect((await terminal(id, 'response-lost')).status).toBe('completed');
    expect((await send(id, 'response-lost', 'one execution')).status).toBe(202);
    expect(model.requests.length - initial).toBe(1);
  } finally {
    spy.mockRestore();
  }
});

it('keeps a PostgreSQL receipt-write failure after the native input barrier unknown without retrying', async () => {
  const id = await create();
  script.push('hold');
  await observer.query(
    `CREATE FUNCTION mio_fail_input() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='input-persisted' THEN RAISE EXCEPTION 'test input receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER mio_fail_input BEFORE UPDATE ON mio_conversation_requests FOR EACH ROW EXECUTE FUNCTION mio_fail_input()`,
  );
  try {
    await send(id, 'pg-input-failed', 'native input before failed receipt');
    expect((await terminal(id, 'pg-input-failed')).status).toBe('unknown');
    const count = model.requests.length;
    expect((await send(id, 'pg-input-failed', 'native input before failed receipt')).status).toBe(
      202,
    );
    await delay(30);
    expect(model.requests.length).toBe(count);
    const row = (
      await observer.query<{ dsh_session_id: string }>(
        'SELECT dsh_session_id FROM mio_conversations WHERE id=$1',
        [id],
      )
    ).rows[0]!;
    expect(JSON.stringify((await ctx.mioKernel.history(row.dsh_session_id)).events)).toContain(
      'native input before failed receipt',
    );
  } finally {
    await observer.query(
      'DROP TRIGGER mio_fail_input ON mio_conversation_requests; DROP FUNCTION mio_fail_input()',
    );
  }
});

it('holds an exclusive schema lease and preserves receipts across normal plugin reload without auto replay', async () => {
  await expect(Stores.createConversationStore(database.url)).rejects.toThrow(
    'CONVERSATION_INSTANCE',
  );
  const id = await create();
  script.push(textResponse('before reload'));
  await send(id, 'before-reload', 'remember persisted');
  await terminal(id, 'before-reload');
  const count = model.requests.length;
  await plugin.dispose();
  ctx.llm.registerAdapter(['mio-model-b'], model);
  vi.stubEnv('MIO_MODEL_PROVIDER', 'mio-model-b');
  plugin = ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
  await plugin;
  expect(model.requests.length).toBe(count);
  const history = await (await call(path(id, 'history'))).json();
  expect(JSON.stringify(history)).toContain('before reload');
  expect((await send(id, 'before-reload', 'remember persisted')).status).toBe(202);
  expect(model.requests.length).toBe(count);
  script.push(textResponse('current route B'));
  await send(id, 'route-b', 'continue with current model');
  await terminal(id, 'route-b');
  expect(model.requests.at(-1)!.provider).toBe('mio-model-b');
  expect(JSON.stringify(model.requests.at(-1)!.messages)).toContain('before reload');
});

it('refuses new execution after the exact schema ownership connection is lost', async () => {
  const id = await create();
  const count = model.requests.length;
  const lock = await observer.query<{ pid: number }>(
    `SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND a.application_name=$1 AND a.datname=current_database() AND l.objid=(hashtext(current_schema()||':mio-conversations')::bigint & 4294967295)`,
    [database.applicationName],
  );
  expect(lock.rows).toHaveLength(1);
  await observer.query('SELECT pg_terminate_backend($1)', [lock.rows[0]!.pid]);
  await vi.waitFor(
    async () => expect((await send(id, 'lease-lost', 'must not start')).status).toBe(503),
    { timeout: 3000 },
  );
  expect(model.requests.length).toBe(count);
});
