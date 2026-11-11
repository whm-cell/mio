import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { authDatabase } from './auth-database.ts';
import { providerSchemaSQL } from '../src/providers/schema.ts';
import { createProviderStore } from '../src/providers/store.ts';
import { createProviderService } from '../src/providers/service.ts';
import type { ModelTransport } from '../src/integrations/onelink/models.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
const services: ReturnType<typeof createProviderService>[] = [];
const masterKey = randomBytes(32);
const metadata = (ids: string[]) =>
  Response.json({ data: ids.map((id) => ({ id, object: 'model', owned_by: 'fixture' })) });
beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  await pool.query(providerSchemaSQL);
}, 30000);
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});
afterAll(async () => {
  await pool?.end();
  await database?.close();
});
async function fixture(transport: ModelTransport) {
  const config = { databaseURL: database.url, masterKey, masterKeyId: 'refresh-fixture' };
  const store = await createProviderStore(config);
  const service = createProviderService(store, config, transport);
  services.push(service);
  const actor = { userId: randomUUID(), sessionId: 'fixture' };
  await service.save(actor, 0, 'synthetic-refresh-private-key');
  const declare = async (
    ref: string,
    profile: 'openai-chat' | 'anthropic-messages' = 'openai-chat',
  ) =>
    store.declare(actor.userId, (await service.get(actor))!.revision, {
      modelRef: ref,
      operation: 'chat',
      profile,
      source: 'deterministic protocol fixture',
      sourceVersion: 'v1',
    });
  const choose = async (ref: string) =>
    service.preference(actor, (await service.get(actor))!.revision, ref, {
      usage: 'chat',
      isDefault: true,
    });
  return { config, store, service, actor, declare, choose };
}

it('discovers new exact identities without a release, keeps unknown metadata pending and freezes current versions', async () => {
  let ids = ['Future-Q', 'future-Q', 'claude-does-not-prove-protocol', 'vendor:route-K'];
  const f = await fixture(async () => metadata(ids));
  await expect(f.service.selectChat(f.actor, 'onelink:chat:Future-Q')).rejects.toThrow(
    'MODEL_CATALOG_NOT_DISCOVERED',
  );
  await f.service.discover(f.actor);
  const first = await f.service.catalog(f.actor);
  expect(first.items).toHaveLength(4);
  expect(
    first.items.every((item) => item.category === null && item.protocol === null && !item.runnable),
  ).toBe(true);
  const selected = first.items.find((item) => item.modelId === 'Future-Q')!;
  await expect(f.service.selectChat(f.actor, selected.modelRef)).rejects.toThrow('ADAPTER_PENDING');
  await f.declare(selected.modelRef);
  await f.choose(selected.modelRef);
  const binding = await f.service.selectChat(f.actor);
  const snapshot = await f.service.resolveChat(f.actor, binding);
  expect(snapshot).toMatchObject({
    modelId: 'Future-Q',
    modelKey: selected.modelKey,
    credentialVersion: 1,
    catalogVersion: 1,
    adaptationVersion: 1,
    operation: 'chat',
    profile: 'openai-chat',
  });
  expect(snapshot.contextWindow).toBeUndefined();
  expect((await f.service.catalog(f.actor)).defaults[0]).toMatchObject({ effective: true });
  ids = ['future-Q'];
  await f.service.discover(f.actor);
  await expect(f.service.resolveChat(f.actor, binding)).rejects.toThrow('MODEL_REMOVED');
  await expect(f.service.selectChat(f.actor)).rejects.toThrow('MODEL_DEFAULT_INVALID');
  expect(snapshot.catalogVersion).toBe(1);
  ids = ['Future-Q', 'future-Q'];
  await f.service.discover(f.actor);
  expect((await f.service.selectChat(f.actor)).modelKey).toBe(selected.modelKey);
  await f.declare(selected.modelRef, 'anthropic-messages');
  expect(await f.service.resolveChat(f.actor, binding)).toMatchObject({
    modelKey: selected.modelKey,
    catalogVersion: 3,
    adaptationVersion: 2,
    profile: 'anthropic-messages',
  });
  expect(snapshot.profile).toBe('openai-chat');
});

it('distinguishes empty success, temporary stale, sticky auth rejection and credential rotation across restart', async () => {
  let response = () => metadata(['New-Z']);
  const f = await fixture(async () => response());
  await f.service.discover(f.actor);
  const ref = (await f.service.catalog(f.actor)).items[0]!.modelRef;
  await f.declare(ref);
  await f.choose(ref);
  const binding = await f.service.selectChat(f.actor);
  response = () => new Response('', { status: 429 });
  await f.service.discover(f.actor);
  expect((await f.service.get(f.actor))!.catalog).toMatchObject({
    version: 1,
    current: true,
    stale: true,
  });
  expect((await f.service.resolveChat(f.actor, binding)).catalogVersion).toBe(1);
  response = () => new Response('', { status: 401 });
  await f.service.discover(f.actor);
  response = () => new Response('', { status: 503 });
  await f.service.discover(f.actor);
  await expect(f.service.resolveChat(f.actor, binding)).rejects.toThrow('PROVIDER_AUTH_REJECTED');
  const reopened = await createProviderStore(f.config);
  try {
    expect((await reopened.get(f.actor.userId))!.credentialAuthState).toBe('rejected');
  } finally {
    await reopened.close();
  }
  response = () => metadata(['New-Z']);
  await f.service.discover(f.actor);
  await f.service.save(
    f.actor,
    (await f.service.get(f.actor))!.revision,
    'synthetic-new-refresh-key',
  );
  await expect(f.service.selectChat(f.actor)).rejects.toThrow('MODEL_CATALOG_NOT_DISCOVERED');
  expect((await f.service.catalog(f.actor)).defaults[0]!.modelRef).toBe(ref);
  await f.service.discover(f.actor);
  expect((await f.service.resolveChat(f.actor, binding)).credentialVersion).toBe(2);
  response = () => metadata([]);
  await f.service.discover(f.actor);
  const empty = await f.service.catalog(f.actor);
  expect(empty.provider!.catalog).toMatchObject({ version: 4, current: true, stale: false });
  expect(empty.items[0]).toMatchObject({ membership: 'removed', isDefault: true, runnable: false });
  expect(empty.defaults[0]).toMatchObject({
    modelRef: ref,
    effective: false,
    unavailableReason: 'MODEL_REMOVED',
  });
  await expect(f.choose(ref)).rejects.toThrow('MODEL_REMOVED');
});

it('publishes only the latest started refresh, including a newer failure and a rotation', async () => {
  const release: ((value: Response) => void)[] = [];
  const f = await fixture(async () => new Promise<Response>((resolve) => release.push(resolve)));
  const a = f.service.discover(f.actor);
  await expect.poll(() => release.length).toBe(1);
  const b = f.service.discover(f.actor);
  await expect.poll(() => release.length).toBe(2);
  release[1]!(new Response('', { status: 401 }));
  await b;
  release[0]!(metadata(['stale-success']));
  await expect(a).rejects.toThrow('PROVIDER_REFRESH_SUPERSEDED');
  expect((await f.service.get(f.actor))!.credentialAuthState).toBe('rejected');
  expect((await f.service.catalog(f.actor)).items).toHaveLength(0);
  const old = f.service.discover(f.actor);
  await expect.poll(() => release.length).toBe(3);
  await f.service.save(
    f.actor,
    (await f.service.get(f.actor))!.revision,
    'synthetic-replacement-key',
  );
  release[2]!(metadata(['old-credential']));
  await expect(old).rejects.toThrow('PROVIDER_CREDENTIAL_CHANGED');
  expect((await f.service.get(f.actor))!.catalog.current).toBe(false);
});

it('rejects conflicting duplicates and partial/malformed metadata without replacing success', async () => {
  let value: unknown = { data: [{ id: 'New-A' }] };
  const f = await fixture(async () => Response.json(value));
  await f.service.discover(f.actor);
  for (const bad of [
    {
      data: [
        { id: 'New-A', owned_by: 'one' },
        { id: 'New-A', owned_by: 'two' },
      ],
    },
    { data: [{ id: 'New-B', created: 'unknown' }] },
    { data: [], has_more: true },
    { data: [{ id: 'New-B', description: 'synthetic-refresh-private-key' }] },
  ]) {
    value = bad;
    expect(await f.service.discover(f.actor)).toMatchObject({
      status: 'failed',
      error: 'UPSTREAM_RESPONSE_INVALID',
    });
    expect((await f.service.get(f.actor))!.catalog.version).toBe(1);
    expect((await f.service.catalog(f.actor)).items.map((item) => item.modelId)).toEqual(['New-A']);
  }
});

it('does not manufacture members or verification through deployment data and keeps ownership and default targets', async () => {
  const one = await fixture(async () => metadata(['Same-ID']));
  const two = await fixture(async () => metadata(['Same-ID']));
  await one.service.discover(one.actor);
  await two.service.discover(two.actor);
  const ref = (await one.service.catalog(one.actor)).items[0]!.modelRef;
  await expect(two.declare(ref)).rejects.toThrow('MODEL_NOT_FOUND');
  await expect(one.declare('onelink:chat:missing')).rejects.toThrow('MODEL_NOT_FOUND');
  await one.declare(ref);
  await one.choose(ref);
  const snapshot = await one.service.resolveChat(
    one.actor,
    await one.service.selectChat(one.actor),
  );
  await one.store.recordVerification(one.actor.userId, snapshot, 'fixture:actual-success');
  expect((await one.service.catalog(one.actor)).items[0]!.adaptation!.verification.status).toBe(
    'verified',
  );
  await one.declare(ref, 'anthropic-messages');
  const changed = (await one.service.catalog(one.actor)).items[0]!.adaptation!;
  expect(changed.verification).toMatchObject({
    status: 'unverified',
    evidence: 'fixture:actual-success',
  });
  const newer = await one.service.resolveChat(one.actor, await one.service.selectChat(one.actor));
  await one.store.recordVerification(one.actor.userId, newer, 'fixture:new-declaration');
  await one.store.recordVerification(one.actor.userId, snapshot, 'fixture:late-old-declaration');
  expect((await one.service.catalog(one.actor)).items[0]!.adaptation!.verification).toMatchObject({
    status: 'verified',
    evidence: 'fixture:new-declaration',
  });
  await one.service.discover(one.actor);
  const refreshed = await one.service.resolveChat(
    one.actor,
    await one.service.selectChat(one.actor),
  );
  await one.store.recordVerification(one.actor.userId, refreshed, 'fixture:new-catalog');
  await one.store.recordVerification(one.actor.userId, newer, 'fixture:late-old-catalog');
  expect((await one.service.catalog(one.actor)).items[0]!.adaptation!.verification).toMatchObject({
    status: 'verified',
    evidence: 'fixture:new-catalog',
  });
  await one.service.preference(one.actor, (await one.service.get(one.actor))!.revision, ref, {
    usage: 'chat',
    enabled: false,
  });
  expect((await one.service.catalog(one.actor)).defaults[0]).toMatchObject({
    modelRef: ref,
    effective: false,
    unavailableReason: 'MODEL_DISABLED',
  });
  await expect(one.service.selectChat(one.actor)).rejects.toThrow('MODEL_DEFAULT_INVALID');
  await one.service.settings(one.actor, (await one.service.get(one.actor))!.revision, {
    enabled: false,
  });
  expect(await one.service.discover(one.actor)).toMatchObject({ status: 'connected' });
  await expect(one.service.selectChat(one.actor)).rejects.toThrow('PROVIDER_DISABLED');
});
