import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { authDatabase } from '../auth-database.ts';
import { packedAuthRuntime } from '../auth-runtime.ts';
import { importDeclaration } from '../fixtures/provider-declaration.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let runtime: Awaited<ReturnType<typeof packedAuthRuntime>>;
let observer: Pool;
let declarationEnv: NodeJS.ProcessEnv;
const cookies: string[] = [];
const owners: string[] = [];
const ref = 'onelink:chat:deepseek-v4.1-flash';
const call = (path: string, method = 'GET', value?: unknown, owner = 0) =>
  fetch(`${runtime.origin}${path}`, {
    method,
    headers: {
      origin: runtime.origin,
      cookie: cookies[owner] ?? '',
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
async function create(owner = 0, modelRef?: string) {
  const response = await call('/api/v1/conversations', 'POST', modelRef ? { modelRef } : {}, owner);
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}
const send = (id: string, requestId: string, text: string, owner = 0) =>
  call(`/api/v1/conversations/${id}/messages`, 'POST', { requestId, text }, owner);
async function refresh(owner = 0) {
  const response = await call('/api/v1/providers/onelink/test', 'POST', {}, owner);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'connected' });
}
async function revision(owner = 0) {
  return (
    (await (await call('/api/v1/providers/onelink', 'GET', undefined, owner)).json()) as {
      revision: number;
    }
  ).revision;
}
async function terminal(id: string, requestId: string, timeout = 8000) {
  let receipt: { status: string } = { status: '' };
  await expect
    .poll(
      async () => {
        receipt = (await (
          await call(`/api/v1/conversations/${id}/requests/${requestId}`)
        ).json()) as { status: string };
        return ['completed', 'failed', 'cancelled', 'unknown'].includes(receipt.status);
      },
      { timeout },
    )
    .toBe(true);
  return receipt.status;
}
beforeAll(async () => {
  database = await authDatabase();
  observer = new Pool({ connectionString: database.observerURL });
  const master = randomBytes(32).toString('base64');
  const env = {
    PATH: process.env.PATH ?? '',
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_AUTH_BASE_URL: 'http://127.0.0.1:4311',
    MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
    MIO_CONVERSATIONS_DATABASE_URL: database.url,
    MIO_PROVIDERS_DATABASE_URL: database.url,
    MIO_PROVIDERS_MASTER_KEY: master,
    MIO_PROVIDERS_MASTER_KEY_ID: 'w2-profile',
  };
  declarationEnv = env;
  for (const file of ['auth', 'providers', 'conversations']) {
    const result = spawnSync(process.execPath, [`scripts/service/migrate-${file}.ts`, '--apply'], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.status, result.stderr).toBe(0);
  }
  runtime = await packedAuthRuntime(database.url, '', 'unused', {
    conversations: true,
    providerMasterKey: master,
    providerKeyId: 'w2-profile',
    onelinkFixture: true,
  });
  await runtime.start('database');
  for (const name of ['one', 'two', 'no-key']) {
    const response = await call('/api/auth/sign-up/email', 'POST', {
      name,
      email: `w2-${name}@example.test`,
      password: 'w2-packed-password-strong-7412',
    });
    expect(response.status).toBe(200);
    cookies.push(
      response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    );
    owners.push(((await response.json()) as { user: { id: string } }).user.id);
  }
  expect((await call('/api/v1/conversations', 'POST', {}, 2)).status).toBe(404);
  for (const owner of [0, 1]) {
    expect(
      (
        await call(
          '/api/v1/providers/onelink/credential',
          'PUT',
          {
            apiKey: `synthetic-profile-owner-${owner}`,
            expectedRevision: 0,
          },
          owner,
        )
      ).status,
    ).toBe(200);
    expect((await call('/api/v1/conversations', 'POST', {}, owner)).status).toBe(409);
    await refresh(owner);
    await importDeclaration(env, owners[owner]!, await revision(owner), ref, 'openai-chat');
    await importDeclaration(
      env,
      owners[owner]!,
      await revision(owner),
      'onelink:chat:claude-sonnet-4.5-20250929',
      'anthropic-messages',
    );
    expect(
      (
        await call(
          '/api/v1/providers/onelink/models',
          'PATCH',
          {
            modelRef: ref,
            isDefault: true,
            expectedRevision: await revision(owner),
          },
          owner,
        )
      ).status,
    ).toBe(200);
  }
}, 45000);
afterAll(async () => {
  try {
    await runtime?.close();
  } finally {
    await observer?.end();
    await database?.close();
  }
}, 30000);

it('keeps owner snapshots across interleaved streams, rotation/disable, cancel, old receipts and restart', async () => {
  const a = await create();
  const b = await create(1);
  const count = (await runtime.onelinkRequests()).length;
  expect((await send(a, 'first', 'remember context')).status).toBe(202);
  expect(await terminal(a, 'first')).toBe('completed');
  expect((await send(a, 'holding-a', 'HOLD')).status).toBe(202);
  expect((await send(b, 'holding-b', 'HOLD', 1)).status).toBe(202);
  await expect.poll(async () => (await runtime.onelinkRequests()).length).toBe(count + 3);
  const seen = await runtime.onelinkRequests();
  expect(
    seen
      .slice(-2)
      .map((value) => value.authorization)
      .sort(),
  ).toEqual(['Bearer synthetic-profile-owner-0', 'Bearer synthetic-profile-owner-1']);
  expect(JSON.stringify(seen[count + 1]!.body.messages)).toContain('remember context');
  expect(
    (
      await call('/api/v1/providers/onelink/credential', 'PUT', {
        apiKey: 'synthetic-profile-rotated',
        expectedRevision: await revision(),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(
        '/api/v1/providers/onelink',
        'PATCH',
        { enabled: false, expectedRevision: await revision(1) },
        1,
      )
    ).status,
  ).toBe(200);
  expect((await send(a, 'first', 'remember context')).status).toBe(202);
  expect((await send(a, 'first', 'different')).status).toBe(409);
  expect((await send(a, 'busy', 'new')).status).toBe(409);
  await call(`/api/v1/conversations/${a}/cancel`, 'POST', {});
  await call(`/api/v1/conversations/${b}/cancel`, 'POST', {}, 1);
  expect(await terminal(a, 'holding-a')).toBe('cancelled');
  const bReceipt = await call(`/api/v1/conversations/${b}/requests/holding-b`, 'GET', undefined, 1);
  await expect
    .poll(
      async () =>
        (
          (await (
            await call(`/api/v1/conversations/${b}/requests/holding-b`, 'GET', undefined, 1)
          ).json()) as { status: string }
        ).status,
    )
    .toBe('cancelled');
  expect(bReceipt.status).toBe(200);
  expect((await send(b, 'new-disabled', 'new', 1)).status).toBe(409);
  expect((await send(b, 'holding-b', 'HOLD', 1)).status).toBe(202);
  expect((await send(a, 'rotated', 'continue')).status).toBe(409);
  await refresh();
  expect((await send(a, 'rotated', 'continue')).status).toBe(202);
  expect(await terminal(a, 'rotated')).toBe('completed');
  expect((await runtime.onelinkRequests()).at(-1)!.authorization).toBe(
    'Bearer synthetic-profile-rotated',
  );
  const stored = (
    await observer.query<{
      model_binding: Record<string, unknown>;
      model_observations: Record<string, unknown>[];
    }>(
      'SELECT model_binding,model_observations FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2',
      [a, 'holding-a'],
    )
  ).rows[0]!;
  expect(stored.model_binding).toMatchObject({
    credentialVersion: 1,
    capabilityVersion: 'onelink-text:1',
    catalogVersion: 1,
    adaptationVersion: 1,
    operation: 'chat',
    profile: 'openai-chat',
  });
  expect(stored.model_observations).toHaveLength(1);
  expect(stored.model_observations[0]).toMatchObject({
    providerRequestId: 'fixture-request-id',
    finish: 'aborted',
    usageStatus: 'unknown',
  });
  expect(JSON.stringify(stored)).not.toContain('synthetic-profile');
  await runtime.stop();
  await runtime.start('database');
  expect((await send(a, 'first', 'remember context')).status).toBe(202);
  expect((await runtime.onelinkRequests()).length).toBe(count + 4);
  expect(JSON.stringify(await (await call(`/api/v1/conversations/${a}/history`)).json())).toContain(
    'fixture answer',
  );
});

it('reads unbound old history, requires an explicit owner binding once, and keeps Messages separate', async () => {
  const id = await create();
  await observer.query('UPDATE mio_conversations SET model_binding=NULL WHERE id=$1', [id]);
  expect((await call(`/api/v1/conversations/${id}/history`)).status).toBe(200);
  expect((await send(id, 'unbound', 'no')).status).toBe(409);
  expect(
    (await call(`/api/v1/conversations/${id}/model`, 'PUT', { modelRef: ref }, 1)).status,
  ).toBe(404);
  expect((await call(`/api/v1/conversations/${id}/model`, 'PUT', { modelRef: ref })).status).toBe(
    200,
  );
  expect((await call(`/api/v1/conversations/${id}/model`, 'PUT', { modelRef: ref })).status).toBe(
    200,
  );
  const claude = 'onelink:chat:claude-sonnet-4.5-20250929';
  expect(
    (await call(`/api/v1/conversations/${id}/model`, 'PUT', { modelRef: claude })).status,
  ).toBe(409);
  const messages = await create(0, claude);
  for (const requestId of ['messages-one', 'messages-two']) {
    expect((await send(messages, requestId, 'Messages protocol')).status).toBe(202);
    expect(await terminal(messages, requestId)).toBe('completed');
  }
});

it('settles an observation persistence failure unknown without repeating the model request', async () => {
  const id = await create();
  const count = (await runtime.onelinkRequests()).length;
  await observer.query(
    `CREATE FUNCTION w2_fail_observation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.model_observations IS DISTINCT FROM OLD.model_observations THEN RAISE EXCEPTION 'fixture observation failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER w2_fail_observation BEFORE UPDATE ON mio_conversation_requests FOR EACH ROW EXECUTE FUNCTION w2_fail_observation()`,
  );
  try {
    expect((await send(id, 'observation-failed', 'one call')).status).toBe(202);
    expect(await terminal(id, 'observation-failed')).toBe('unknown');
    expect((await send(id, 'observation-failed', 'one call')).status).toBe(202);
    expect((await runtime.onelinkRequests()).length).toBe(count + 1);
  } finally {
    await observer.query(
      'DROP TRIGGER w2_fail_observation ON mio_conversation_requests; DROP FUNCTION w2_fail_observation()',
    );
  }
});

it('freezes accepted credentials through a pause after prepare and before actual fetch', async () => {
  const id = await create();
  const count = (await runtime.onelinkRequests()).length;
  expect((await send(id, 'prepared', 'PAUSE_WIRE')).status).toBe(202);
  await expect.poll(() => runtime.onelinkPaused()).toBe(true);
  expect((await runtime.onelinkRequests()).length).toBe(count);
  const current = (await (await call('/api/v1/providers/onelink')).json()) as { revision: number };
  expect(
    (
      await call('/api/v1/providers/onelink/credential', 'PUT', {
        apiKey: 'synthetic-after-prepare',
        expectedRevision: current.revision,
      })
    ).status,
  ).toBe(200);
  await runtime.releaseOnelink();
  expect(await terminal(id, 'prepared')).toBe('completed');
  expect((await runtime.onelinkRequests()).at(-1)!.authorization).toBe(
    'Bearer synthetic-profile-rotated',
  );
  const stored = (
    await observer.query<{ model_binding: { credentialVersion: number } }>(
      'SELECT model_binding FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2',
      [id, 'prepared'],
    )
  ).rows[0]!;
  expect(stored.model_binding.credentialVersion).toBe(2);
  expect((await send(id, 'after-prepare', 'fresh input')).status).toBe(409);
  await refresh();
  expect((await send(id, 'after-prepare', 'fresh input')).status).toBe(202);
  expect(await terminal(id, 'after-prepare')).toBe('completed');
  expect((await runtime.onelinkRequests()).at(-1)!.authorization).toBe(
    'Bearer synthetic-after-prepare',
  );
});

it('discovers new exact IDs after startup and reuses declared protocols through the packed user flow', async () => {
  const suffix = randomBytes(8).toString('hex');
  const variants = [
    {
      id: `Future.Mixed:Route-X-${suffix}`,
      profile: 'openai-chat' as const,
      path: '/v1/chat/completions',
    },
    {
      id: `future.Mixed:Route-X-${suffix}`,
      profile: 'openai-chat' as const,
      path: '/v1/chat/completions',
    },
    {
      id: `openai-looking.Messages:${suffix}`,
      profile: 'anthropic-messages' as const,
      path: '/v1/messages',
    },
  ];
  const pendingId = `claude-looking.Pending:${suffix}`;
  const originalIds = ['deepseek-v4.1-flash', 'claude-sonnet-4.5-20250929'];
  const count = (await runtime.onelinkRequests()).length;
  try {
    await runtime.setOnelinkCatalog([
      ...originalIds,
      ...variants.map((item) => item.id),
      pendingId,
    ]);
    await refresh();
    const discovered = (await (await call('/api/v1/providers/onelink/models')).json()) as {
      items: {
        modelId: string;
        modelRef: string;
        modelKey: string;
        category: string | null;
        adaptation: unknown;
        unavailableReason: string;
      }[];
    };
    const additions = discovered.items.filter((item) => item.modelId.endsWith(suffix));
    expect(additions).toHaveLength(4);
    expect(new Set(additions.map((item) => item.modelKey)).size).toBe(4);
    for (const item of additions) {
      expect(item).toMatchObject({
        category: null,
        adaptation: null,
        unavailableReason: 'ADAPTER_PENDING',
      });
      const denied = await call('/api/v1/conversations', 'POST', { modelRef: item.modelRef });
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({ error: { code: 'ADAPTER_PENDING' } });
    }
    const absent = await call('/api/v1/conversations', 'POST', {
      modelRef: `onelink:chat:absent-${suffix}`,
    });
    expect(absent.status).toBe(409);
    expect(await absent.json()).toMatchObject({ error: { code: 'MODEL_NOT_FOUND' } });
    expect((await runtime.onelinkRequests()).length).toBe(count);
    const state = (await (await call('/api/v1/providers/onelink')).json()) as {
      credentialVersion: number;
      catalog: { version: number };
    };
    for (const variant of variants) {
      const model = additions.find((item) => item.modelId === variant.id)!;
      await importDeclaration(
        declarationEnv,
        owners[0]!,
        await revision(),
        model.modelRef,
        variant.profile,
      );
      const id = await create(0, model.modelRef);
      const before = (await runtime.onelinkRequests()).length;
      for (const requestId of ['extension-first', 'extension-second']) {
        expect((await send(id, requestId, `remember ${variant.id}`)).status).toBe(202);
        expect(await terminal(id, requestId)).toBe('completed');
      }
      const requests = (await runtime.onelinkRequests()).slice(before);
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.path)).toEqual([variant.path, variant.path]);
      expect(requests.map((request) => request.body.model)).toEqual([variant.id, variant.id]);
      expect(JSON.stringify(requests[1]!.body.messages)).toContain('fixture answer');
      const rows = (
        await observer.query<{ model_binding: Record<string, unknown> }>(
          'SELECT model_binding FROM mio_conversation_requests WHERE conversation_id=$1 ORDER BY created_at',
          [id],
        )
      ).rows;
      expect(rows).toHaveLength(2);
      for (const row of rows)
        expect(row.model_binding).toMatchObject({
          modelId: variant.id,
          modelKey: model.modelKey,
          profile: variant.profile,
          credentialVersion: state.credentialVersion,
          catalogVersion: state.catalog.version,
          adaptationVersion: 1,
        });
      expect((await call(`/api/v1/conversations/${id}/history`)).status).toBe(200);
    }
    expect((await runtime.onelinkRequests()).length).toBe(count + 6);
    const after = (await (
      await call('/api/v1/providers/onelink/models')
    ).json()) as typeof discovered;
    for (const model of additions)
      expect(after.items.find((item) => item.modelId === model.modelId)).toMatchObject({
        modelRef: model.modelRef,
        modelKey: model.modelKey,
      });
    expect(after.items.find((item) => item.modelId === pendingId)).toMatchObject({
      adaptation: null,
      unavailableReason: 'ADAPTER_PENDING',
    });
  } finally {
    await runtime.setOnelinkCatalog(originalIds);
    await refresh();
  }
}, 30000);

it('settles a real stream idle deadline without reposting the paid request', async () => {
  const id = await create();
  const count = (await runtime.onelinkRequests()).length;
  expect((await send(id, 'idle-deadline', 'HOLD until the configured idle deadline')).status).toBe(
    202,
  );
  expect(await terminal(id, 'idle-deadline', 40_000)).toBe('failed');
  const row = (
    await observer.query<{ model_observations: { finish: string; usageStatus: string }[] }>(
      'SELECT model_observations FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2',
      [id, 'idle-deadline'],
    )
  ).rows[0]!;
  expect(row.model_observations).toHaveLength(1);
  expect(['error', 'unknown']).toContain(row.model_observations[0]!.finish);
  expect(row.model_observations[0]!.usageStatus).toBe('unknown');
  expect((await runtime.onelinkRequests()).length).toBe(count + 1);
}, 45_000);

it('keeps receipts/history readable after an empty directory and restart, refusing fresh or unbound inputs without billing', async () => {
  const id = await create();
  const unbound = await create();
  await observer.query('UPDATE mio_conversations SET model_binding=NULL WHERE id=$1', [unbound]);
  expect((await send(id, 'before-removal', 'remember before removal')).status).toBe(202);
  expect(await terminal(id, 'before-removal')).toBe('completed');
  const count = (await runtime.onelinkRequests()).length;
  await runtime.setOnelinkCatalog([]);
  await refresh();
  for (const restart of [false, true]) {
    if (restart) {
      await runtime.stop();
      await runtime.start('database');
    }
    expect((await send(id, 'before-removal', 'remember before removal')).status).toBe(202);
    expect((await send(id, 'before-removal', 'different')).status).toBe(409);
    const fresh = await send(id, 'after-removal', 'no new bill');
    expect(fresh.status).toBe(409);
    expect(await fresh.json()).toMatchObject({ error: { code: 'MODEL_REMOVED' } });
    expect((await call('/api/v1/conversations', 'POST', {})).status).toBe(409);
    expect(
      (await call(`/api/v1/conversations/${unbound}/model`, 'PUT', { modelRef: ref })).status,
    ).toBe(409);
    expect((await call(`/api/v1/conversations/${id}/history`)).status).toBe(200);
    expect((await runtime.onelinkRequests()).length).toBe(count);
    expect(
      (
        await observer.query(
          'SELECT * FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2',
          [id, 'after-removal'],
        )
      ).rows,
    ).toHaveLength(0);
  }
});
