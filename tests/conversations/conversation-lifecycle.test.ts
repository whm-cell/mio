import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  Conversation,
  ConversationArchive,
  HistoryPage,
  Receipt,
} from '../../src/conversations/contracts.ts';
import { authDatabase } from '../support/auth-database.ts';
import { packedAuthRuntime } from '../support/auth-runtime.ts';

const base = '/api/v1/conversations';
let database: Awaited<ReturnType<typeof authDatabase>>;
let runtime: Awaited<ReturnType<typeof packedAuthRuntime>>;
let ownerCookie = '';
let otherCookie = '';

const call = (
  path: string,
  method = 'GET',
  body?: string,
  { cookie = ownerCookie, origin = runtime.origin, contentType = 'application/json' } = {},
) =>
  fetch(`${runtime.origin}${path}`, {
    method,
    headers: { origin, cookie, ...(body === undefined ? {} : { 'content-type': contentType }) },
    body: body ?? null,
  });

const message = (id: string, requestId: string, text: string) =>
  call(`${base}/${id}/messages`, 'POST', JSON.stringify({ requestId, text }));

async function create() {
  const response = await call(base, 'POST', '{}');
  expect(response.status).toBe(201);
  return (await response.json()) as Conversation;
}

async function list(query = '') {
  const response = await call(`${base}${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as { items: Conversation[]; nextAfter: string | null };
}

async function receipt(id: string, requestId: string) {
  const response = await call(`${base}/${id}/requests/${requestId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Receipt;
}

async function completed(id: string, requestId: string) {
  await expect
    .poll(async () => (await receipt(id, requestId)).status, { timeout: 5000 })
    .toBe('completed');
}

async function modelCalls() {
  const response = await call('/__test/model');
  expect(response.status).toBe(200);
  return ((await response.json()) as { count: number }).count;
}

async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

beforeAll(async () => {
  database = await authDatabase();
  const env = {
    ...process.env,
    MIO_AUTH_BASE_URL: 'http://127.0.0.1:4311',
    MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_CONVERSATIONS_DATABASE_URL: database.url,
  };
  for (const file of [
    'scripts/service/migrate-auth.ts',
    'scripts/service/migrate-conversations.ts',
  ]) {
    const result = spawnSync(process.execPath, [file, '--apply'], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  runtime = await packedAuthRuntime(database.url, '', 'unused', {
    conversations: true,
    modelFixture: true,
  });
  await runtime.start('database');
  for (const name of ['owner', 'other']) {
    const response = await call(
      '/api/auth/sign-up/email',
      'POST',
      JSON.stringify({
        name,
        email: `m2-${name}@example.test`,
        password: 'mio-m2-lifecycle-test-password-79',
      }),
      { cookie: '' },
    );
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((item) => item.split(';')[0])
      .join('; ');
    expect(cookie).not.toBe('');
    if (name === 'owner') ownerCookie = cookie;
    else otherCookie = cookie;
  }
}, 45000);

afterAll(async () => {
  try {
    if (runtime) await runtime.close();
  } finally {
    if (database) await database.close();
  }
}, 30000);

it('derives the first title locally, pins an explicit title, and paginates activity and legacy UUIDs', async () => {
  const before = await modelCalls();
  const first = await create();
  const second = await create();
  expect(first.title).toBeNull();
  expect(first.updatedAt).toBe(first.createdAt);
  expect(
    (await message(first.id, 'opening', '  序幕\n山雨\t一 二 三 四 五 六 七 八 九 十 十一 十二 '))
      .status,
  ).toBe(202);
  await completed(first.id, 'opening');
  const opening = (await list()).items.find((item) => item.id === first.id)!;
  expect(opening.title).toBe('序幕 山雨 一 二 三 四 五 六 七 八 九 十');
  expect(Date.parse(opening.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
  expect((await message(second.id, 'alternate', 'another conversation')).status).toBe(202);
  await completed(second.id, 'alternate');
  expect((await list()).items[0]?.id).toBe(second.id);

  const path = `${base}/${first.id}`;
  const renamed = await call(path, 'PATCH', JSON.stringify({ title: '  正式\n第 二章  ' }));
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({
    id: first.id,
    title: '正式 第 二章',
    updatedAt: opening.updatedAt,
  });
  expect((await list()).items[0]?.id).toBe(second.id);

  const exactTitle = '章'.repeat(40);
  expect((await call(path, 'PATCH', JSON.stringify({ title: exactTitle }))).status).toBe(200);
  for (const invalid of [`${exactTitle} `, '\u200B', '\uD800', ' \t ', 42]) {
    await error(await call(path, 'PATCH', JSON.stringify({ title: invalid })), 400, 'BODY_INVALID');
  }
  expect((await message(first.id, 'later', 'new active input')).status).toBe(202);
  await completed(first.id, 'later');
  expect((await modelCalls()) - before).toBe(3);

  const recent = await list('?limit=1');
  expect(recent.items).toEqual([expect.objectContaining({ id: first.id, title: exactTitle })]);
  expect(Date.parse(recent.items[0]!.updatedAt)).toBeGreaterThan(Date.parse(opening.updatedAt));
  expect(recent.nextAfter).toBeTruthy();
  const next = await list(`?limit=1&after=${encodeURIComponent(recent.nextAfter!)}`);
  expect(next.items).toEqual([expect.objectContaining({ id: second.id })]);
  expect(next.nextAfter).toBeNull();
  expect((await message(first.id, 'later', 'new active input')).status).toBe(202);
  expect((await list('?limit=1')).items[0]?.updatedAt).toBe(recent.items[0]?.updatedAt);
  expect((await modelCalls()) - before).toBe(3);

  const byId = [first.id, second.id].sort();
  const legacy = await list('?limit=1&after=00000000-0000-4000-8000-000000000000');
  expect(legacy.items.map((item) => item.id)).toEqual(byId.slice(0, 1));
  expect(legacy.nextAfter).toBe(byId[0]);
  expect((await list(`?limit=1&after=${legacy.nextAfter}`)).items.map((item) => item.id)).toEqual(
    byId.slice(1),
  );
  for (const invalid of ['', 'malformed'])
    await error(await call(`${base}?after=${invalid}`), 400, 'QUERY_INVALID');
});

it('archives only idle owned sessions, preserves prior receipts and history, and rejects fresh writes', async () => {
  const { id } = await create();
  const path = `${base}/${id}`;
  const preflight = await call(path, 'OPTIONS', undefined, { cookie: '' });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-methods')).toBe('PATCH, DELETE, OPTIONS');
  expect(preflight.headers.get('access-control-allow-origin')).toBe(runtime.origin);
  const wrongMethod = await call(path);
  expect(wrongMethod.status).toBe(405);
  expect(wrongMethod.headers.get('allow')).toBe('PATCH, DELETE, OPTIONS');
  await error(await call(path, 'DELETE', undefined, { cookie: '' }), 401, 'UNAUTHORIZED');
  await error(
    await call(path, 'DELETE', undefined, { origin: 'https://untrusted.test' }),
    403,
    'ORIGIN_DENIED',
  );
  await error(
    await fetch(`${runtime.origin}${path}`, { method: 'DELETE', headers: { cookie: ownerCookie } }),
    403,
    'ORIGIN_REQUIRED',
  );
  await error(
    await call(path, 'DELETE', undefined, { cookie: otherCookie }),
    404,
    'CONVERSATION_NOT_FOUND',
  );
  await error(
    await call(path, 'PATCH', '{"title":"盗改"}', { cookie: otherCookie }),
    404,
    'CONVERSATION_NOT_FOUND',
  );
  await error(
    await call(path, 'DELETE', '{}', { contentType: 'text/plain' }),
    415,
    'JSON_REQUIRED',
  );
  await error(await call(path, 'DELETE', '{"force":true}'), 400, 'BODY_INVALID');
  const chunkedOptions = {
    method: 'DELETE',
    headers: { origin: runtime.origin, cookie: ownerCookie, 'content-type': 'application/json' },
    duplex: 'half' as const,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('{}'));
        controller.enqueue(Buffer.alloc(16 * 1024 - 1, ' '));
        controller.close();
      },
    }),
  };
  await error(await fetch(`${runtime.origin}${path}`, chunkedOptions), 413, 'BODY_TOO_LARGE');

  const requests = await modelCalls();
  const text = 'HOLD until archive observes busy';
  expect((await message(id, 'busy', text)).status).toBe(202);
  try {
    await expect.poll(modelCalls).toBe(requests + 1);
    await error(await call(path, 'DELETE'), 409, 'CONVERSATION_BUSY');
  } finally {
    await call('/__test/release');
  }
  await completed(id, 'busy');
  const accepted = await receipt(id, 'busy');
  const archived = await call(path, 'DELETE');
  expect(archived.status).toBe(200);
  const archive = (await archived.json()) as ConversationArchive;
  expect(archive.id).toBe(id);
  expect(Number.isFinite(Date.parse(archive.archivedAt))).toBe(true);
  const again = await call(path, 'DELETE', '{}'.padEnd(16 * 1024));
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual(archive);
  expect((await list()).items.some((item) => item.id === id)).toBe(false);

  await error(await message(id, 'fresh', 'must not run'), 409, 'CONVERSATION_ARCHIVED');
  await error(await message(id, 'busy', 'different input'), 409, 'REQUEST_ID_CONFLICT');
  await error(await call(path, 'PATCH', '{"title":"封存后"}'), 409, 'CONVERSATION_ARCHIVED');
  await error(
    await call(`${path}/model`, 'PUT', '{"modelRef":"unused"}'),
    409,
    'CONVERSATION_ARCHIVED',
  );
  await error(await call(`${path}/cancel`, 'POST', '{}'), 409, 'CONVERSATION_ARCHIVED');
  await error(await call(`${path}/requests/fresh`), 404, 'REQUEST_NOT_FOUND');
  const replay = await message(id, 'busy', text);
  expect(replay.status).toBe(202);
  expect(await replay.json()).toEqual(accepted);
  expect(await receipt(id, 'busy')).toEqual(accepted);
  const history = await call(`${path}/history`);
  expect(history.status).toBe(200);
  expect((await history.json()).items).toContainEqual(
    expect.objectContaining({ role: 'user', text }),
  );
  await error(
    await call(`${path}/history`, 'GET', undefined, { cookie: otherCookie }),
    404,
    'CONVERSATION_NOT_FOUND',
  );
  expect(await modelCalls()).toBe(requests + 1);
});

it.each([1, 2])(
  'settles one model call after %i PostgreSQL activity-projection failures',
  async (failures) => {
    const created = await create();
    const observer = new Pool({ connectionString: database.observerURL });
    try {
      // A PostgreSQL sequence survives the failing trigger's statement rollback.
      await observer.query(`
        CREATE SEQUENCE mio_m2_activity_attempt;
        CREATE FUNCTION mio_m2_fail_activity() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('mio_m2_activity_attempt') <= TG_ARGV[0]::int THEN
            RAISE EXCEPTION 'fixture activity projection unavailable';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER mio_m2_fail_activity BEFORE UPDATE OF updated_at ON mio_conversations
          FOR EACH ROW EXECUTE FUNCTION mio_m2_fail_activity('${failures}');
      `);
      const attempts = async () => {
        const { rows } = await observer.query<{ count: number }>(
          'SELECT CASE WHEN is_called THEN last_value::int ELSE 0 END AS count FROM mio_m2_activity_attempt',
        );
        return rows[0]!.count;
      };
      const before = await modelCalls();
      const firstInput = 'HOLD 第一条真人输入';
      const startedAt = Date.now();
      let beforeRelease: number;
      expect((await message(created.id, 'projection-failure', firstInput)).status).toBe(202);
      try {
        await expect.poll(modelCalls, { timeout: 5000 }).toBe(before + 1);
        await expect.poll(attempts, { timeout: 5000 }).toBe(1);
        expect((await receipt(created.id, 'projection-failure')).status).toBe('input-persisted');
        const during = (await list()).items.find((item) => item.id === created.id)!;
        expect(during.title).toBeNull();
        expect(during.updatedAt).toBe(created.updatedAt);
        beforeRelease = Date.now();
      } finally {
        await call('/__test/release');
      }
      await completed(created.id, 'projection-failure');
      expect(await attempts()).toBe(2);
      expect(await modelCalls()).toBe(before + 1);
      const after = (await list()).items.find((item) => item.id === created.id)!;
      if (failures === 1) {
        expect(after.title).toBe(firstInput);
        expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(startedAt);
        expect(Date.parse(after.updatedAt)).toBeLessThanOrEqual(beforeRelease);
      } else {
        expect(after.title).toBeNull();
        expect(after.updatedAt).toBe(created.updatedAt);
      }
    } finally {
      try {
        await observer.query(`
          DROP TRIGGER IF EXISTS mio_m2_fail_activity ON mio_conversations;
          DROP FUNCTION IF EXISTS mio_m2_fail_activity();
          DROP SEQUENCE IF EXISTS mio_m2_activity_attempt
        `);
      } finally {
        await observer.end();
      }
    }
  },
);

it('reads a 180 KiB script and the exact 256 KiB message back from cold native history', async () => {
  const { id } = await create();
  const path = `${base}/${id}`;
  const before = await modelCalls();
  const scene = '第七场·夜。侦探打开封存的剧本，发现两人台词还缺一行。\n';
  const script = scene.repeat(Math.floor((180 * 1024) / Buffer.byteLength(scene)));
  const text = script + '。'.repeat((180 * 1024 - Buffer.byteLength(script)) / 3);
  expect(Buffer.byteLength(text)).toBe(180 * 1024);
  expect((await message(id, 'script', text)).status).toBe(202);
  await completed(id, 'script');

  const requestId = 'edge';
  const empty = Buffer.byteLength(JSON.stringify({ requestId, text: '' }));
  const edge =
    '字'.repeat(Math.floor((256 * 1024 - empty) / 3)) + 'x'.repeat((256 * 1024 - empty) % 3);
  expect(Buffer.byteLength(JSON.stringify({ requestId, text: edge }))).toBe(256 * 1024);
  const oversized = JSON.stringify({ requestId, text: edge + 'x' });
  expect(Buffer.byteLength(oversized)).toBe(256 * 1024 + 1);
  await error(await call(`${path}/messages`, 'POST', oversized), 413, 'BODY_TOO_LARGE');
  await error(await call(`${path}/requests/${requestId}`), 404, 'REQUEST_NOT_FOUND');
  expect((await message(id, requestId, edge)).status).toBe(202);
  await completed(id, requestId);
  expect(await modelCalls()).toBe(before + 2);

  await runtime.stop();
  await runtime.start('database');
  const response = await call(`${path}/history`);
  expect(response.status).toBe(200);
  const { items } = (await response.json()) as HistoryPage;
  const users = items.flatMap((item) => (item.role === 'user' ? [item.text] : []));
  expect(users).toHaveLength(2);
  expect(users[0] === text).toBe(true);
  expect(users[1] === edge).toBe(true);
  expect(await modelCalls()).toBe(0);
});
