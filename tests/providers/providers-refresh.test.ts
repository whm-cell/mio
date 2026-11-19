import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { legacyReference } from '../../src/providers/catalog.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { createProviderService } from '../../src/providers/service.ts';
import type { ModelTransport } from '../../src/integrations/onelink/models.ts';
import { findFixtureRoute, makeChatRouteFixture } from './fixtures/onelink-routes-fixture.ts';

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

async function resolveRawIdFromRef(ref: string): Promise<string> {
  const legacy = legacyReference(ref);
  if (legacy) return legacy.id;
  if (ref.startsWith('onelink:model:')) {
    const key = ref.slice('onelink:model:'.length);
    const { rows } = await pool.query<{ raw_model_id: string }>(
      'SELECT raw_model_id FROM mio_provider_models WHERE model_key = $1',
      [key],
    );
    if (rows[0]?.raw_model_id) return rows[0].raw_model_id;
  }
  return ref;
}

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
  ) => {
    const rawModelId = await resolveRawIdFromRef(ref);
    await store.importRoutes([
      makeChatRouteFixture(rawModelId, profile === 'anthropic-messages' ? 'anthropic' : 'openai', {
        driver: profile,
        source: 'deterministic protocol fixture',
        sourceVersion: 'v1',
      }),
    ]);
  };
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
  expect(first.items.every((item) => item.supplierMetadataSource === 'onelink-v1-models')).toBe(
    true,
  );
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

it('updates retained members once per refresh and removes only missing members without touching other owners', async () => {
  const originalIds = Array.from({ length: 100 }, (_, index) => `refresh-write-${index}`);
  let ids = originalIds;
  const f = await fixture(async () => metadata(ids));
  const other = await fixture(async () => metadata(originalIds));
  await f.service.discover(f.actor);
  await other.service.discover(other.actor);
  const original = await f.service.catalog(f.actor);
  const otherOriginal = await other.service.catalog(other.actor);
  const providerId = original.provider!.id;
  await pool.query(`
    CREATE TABLE mio_provider_refresh_writes (
      provider_id uuid NOT NULL, raw_model_id text NOT NULL,
      old_state text NOT NULL, new_state text NOT NULL
    );
    CREATE FUNCTION record_provider_refresh_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO mio_provider_refresh_writes VALUES
        (NEW.provider_id, NEW.raw_model_id, OLD.membership_state, NEW.membership_state);
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provider_refresh_write AFTER UPDATE ON mio_provider_models
      FOR EACH ROW EXECUTE FUNCTION record_provider_refresh_write();
  `);
  try {
    await f.service.discover(f.actor);
    expect(
      (
        await pool.query(`SELECT provider_id, old_state, new_state, count(*)::int AS writes
        FROM mio_provider_refresh_writes GROUP BY provider_id, old_state, new_state`)
      ).rows,
    ).toEqual([
      { provider_id: providerId, old_state: 'current', new_state: 'current', writes: 100 },
    ]);
    const refreshed = await f.service.catalog(f.actor);
    expect(refreshed.provider!.catalog.version).toBe(2);
    expect(refreshed.provider!.discovery!.ids).toEqual(originalIds);
    expect(refreshed.items).toHaveLength(100);
    for (const model of refreshed.items) {
      const previous = original.items.find((item) => item.modelId === model.modelId)!;
      expect(model).toMatchObject({
        modelKey: previous.modelKey,
        modelRef: previous.modelRef,
        firstSeenAt: previous.firstSeenAt,
        membership: 'current',
        credentialVersion: 1,
        catalogVersion: 2,
        discovered: true,
      });
      expect(Date.parse(model.lastSeenAt!)).toBeGreaterThanOrEqual(
        Date.parse(previous.lastSeenAt!),
      );
    }

    await pool.query('TRUNCATE mio_provider_refresh_writes');
    ids = originalIds.slice(1);
    await f.service.discover(f.actor);
    expect(
      (
        await pool.query(`SELECT old_state, new_state, count(*)::int AS writes
        FROM mio_provider_refresh_writes GROUP BY old_state, new_state ORDER BY new_state`)
      ).rows,
    ).toEqual([
      { old_state: 'current', new_state: 'current', writes: 99 },
      { old_state: 'current', new_state: 'removed', writes: 1 },
    ]);
    const removed = (await f.service.catalog(f.actor)).items.find(
      (item) => item.modelId === originalIds[0],
    )!;
    expect(removed).toMatchObject({ membership: 'removed', discovered: false, catalogVersion: 2 });

    await pool.query('TRUNCATE mio_provider_refresh_writes');
    ids = originalIds;
    await f.service.discover(f.actor);
    expect(
      (
        await pool.query(`SELECT old_state, new_state, count(*)::int AS writes
        FROM mio_provider_refresh_writes GROUP BY old_state, new_state ORDER BY old_state`)
      ).rows,
    ).toEqual([
      { old_state: 'current', new_state: 'current', writes: 99 },
      { old_state: 'removed', new_state: 'current', writes: 1 },
    ]);
    const restored = (await f.service.catalog(f.actor)).items.find(
      (item) => item.modelId === originalIds[0],
    )!;
    expect(restored).toMatchObject({
      modelKey: removed.modelKey,
      modelRef: removed.modelRef,
      firstSeenAt: removed.firstSeenAt,
      membership: 'current',
      catalogVersion: 4,
      discovered: true,
    });
    expect(await f.service.catalog(other.actor)).toEqual(otherOriginal);
    expect(
      (await pool.query('SELECT DISTINCT provider_id FROM mio_provider_refresh_writes')).rows,
    ).toEqual([{ provider_id: providerId }]);
  } finally {
    await pool.query(`
      DROP TRIGGER IF EXISTS provider_refresh_write ON mio_provider_models;
      DROP FUNCTION IF EXISTS record_provider_refresh_write();
      DROP TABLE IF EXISTS mio_provider_refresh_writes;
    `);
  }
});

it("resolves an existing task owner's current key independently of admission and discovery", async () => {
  const transport = vi.fn(async () => metadata(['model']));
  const f = await fixture(transport);
  expect(await f.service.resolveImageTaskCredential(f.actor.userId)).toBe(
    'synthetic-refresh-private-key',
  );
  await f.service.settings(f.actor, (await f.service.get(f.actor))!.revision, { enabled: false });
  await f.service.save(f.actor, (await f.service.get(f.actor))!.revision, 'rotated-task-key');
  expect(await f.service.get(f.actor)).toMatchObject({
    enabled: false,
    credentialAuthState: 'unchecked',
  });
  expect(await f.service.resolveImageTaskCredential(f.actor.userId)).toBe('rotated-task-key');
  await expect(f.service.resolveImageTaskCredential(randomUUID())).rejects.toThrow(
    'PROVIDER_NOT_CONFIGURED',
  );
  await pool.query('UPDATE mio_provider_configs SET auth_tag=$2 WHERE owner_id=$1', [
    f.actor.userId,
    Buffer.alloc(16),
  ]);
  await expect(f.service.resolveImageTaskCredential(f.actor.userId)).rejects.toThrow(
    'PROVIDER_CREDENTIAL_UNAVAILABLE',
  );
  await f.service.save(f.actor, (await f.service.get(f.actor))!.revision, 'restored-task-key');
  expect(await f.service.resolveImageTaskCredential(f.actor.userId)).toBe('restored-task-key');
  expect(transport).not.toHaveBeenCalled();
});

it('shows image route and eligibility separately while preserving the chat view', async () => {
  let ids = ['gpt-image-2-elig'];
  const f = await fixture(async () => metadata(ids));
  await f.service.discover(f.actor);
  const ref = (await f.service.catalog(f.actor)).items[0]!.modelRef;
  const baseFixture = findFixtureRoute('gpt-image-2', 'image.generate');
  await f.store.importRoutes([
    {
      ...baseFixture,
      rawModelId: 'gpt-image-2-elig',
    },
  ]);
  const item = (await f.service.catalog(f.actor)).items[0]!;
  expect(item).toMatchObject({
    adaptation: null,
    runnable: false,
    unavailableReason: 'ADAPTER_PENDING',
    image: {
      adaptation: {
        vendor: 'openai',
        operation: 'image.generate',
        profile: 'openai-images',
        sourceKind: 'protocol-reference',
        metadata: {
          image: {
            modes: ['generate', 'edit'],
            references: { maxImages: 16 },
            mask: { format: 'png' },
          },
        },
        verification: { status: 'unverified' },
      },
      enabled: true,
      runnable: true,
      unavailableReason: null,
    },
  });
  expect(await f.service.resolveImage(f.actor, ref)).toMatchObject({
    modelId: 'gpt-image-2-elig',
    vendor: 'openai',
    profile: 'openai-images',
    capabilityMetadata: {
      image: {
        modes: ['generate', 'edit'],
        references: { maxImages: 16 },
        mask: { format: 'png' },
      },
    },
  });
  ids = [];
  await f.service.discover(f.actor);
  expect((await f.service.catalog(f.actor)).items[0]!.image).toMatchObject({
    runnable: false,
    unavailableReason: 'MODEL_REMOVED',
  });
});

it('requires an enabled async route for Vidu without inferring it from a discovered model id', async () => {
  const f = await fixture(async () => metadata(['fixture-vidu-alt', 'fixture-vidu-unrouted']));
  await f.service.discover(f.actor);
  const items = (await f.service.catalog(f.actor)).items;
  const supported = items.find((item) => item.modelId === 'fixture-vidu-alt')!;
  const unrouted = items.find((item) => item.modelId === 'fixture-vidu-unrouted')!;
  const viduFixture = findFixtureRoute('image-vidu-q2', 'image.generate');
  await f.store.importRoutes([
    {
      ...viduFixture,
      rawModelId: 'fixture-vidu-unrouted',
      enabled: false,
    },
    {
      ...viduFixture,
      rawModelId: 'fixture-vidu-alt',
    },
  ]);
  expect(
    (await f.service.catalog(f.actor)).items.find((item) => item.modelRef === unrouted.modelRef)
      ?.image,
  ).toMatchObject({
    runnable: false,
    unavailableReason: 'ADAPTER_PENDING',
  });
  expect(
    (await f.service.catalog(f.actor)).items.find((item) => item.modelRef === supported.modelRef)
      ?.image.runnable,
  ).toBe(true);
  expect(await f.service.resolveImage(f.actor, supported.modelRef)).toMatchObject({
    modelId: 'fixture-vidu-alt',
    vendor: 'vidu',
    profile: 'vidu-images',
  });
});

it('requires an explicit Volcengine route and freezes the image driver without guessing the model name', async () => {
  const f = await fixture(async () => metadata(['doubao-seedream-4.0-freeze']));
  await f.service.discover(f.actor);
  const ref = (await f.service.catalog(f.actor)).items[0]!.modelRef;
  await expect(f.service.resolveImage(f.actor, ref)).rejects.toThrow('ADAPTER_PENDING');
  const volcFixture = findFixtureRoute('doubao-seedream-4.0', 'image.generate');
  await f.store.importRoutes([{ ...volcFixture, rawModelId: 'doubao-seedream-4.0-freeze' }]);
  const item = (await f.service.catalog(f.actor)).items[0]!;
  expect(item.image).toMatchObject({
    runnable: true,
    adaptation: { vendor: 'volcengine', profile: 'volcengine-ark-images' },
  });
  expect(await f.service.resolveImage(f.actor, ref)).toMatchObject({
    modelId: 'doubao-seedream-4.0-freeze',
    vendor: 'volcengine',
    profile: 'volcengine-ark-images',
    adaptationVersion: 1,
  });
});

it('rejects runtime selection and preferences without a current successful directory member despite DB routes', async () => {
  let ids = ['directory-member'];
  const f = await fixture(async () => metadata(ids));
  await f.store.importRoutes([
    makeChatRouteFixture('directory-member', 'openai'),
    makeChatRouteFixture('docs-only-model', 'openai'),
  ]);
  const missing = 'onelink:model:00000000-0000-4000-8000-000000000000';
  await expect(f.service.selectChat(f.actor, missing)).rejects.toThrow(
    'MODEL_CATALOG_NOT_DISCOVERED',
  );
  await f.service.discover(f.actor);
  await expect(f.service.selectChat(f.actor, 'onelink:chat:docs-only-model')).rejects.toThrow(
    'MODEL_NOT_FOUND',
  );
  const member = (await f.service.catalog(f.actor)).items[0]!;
  ids = ['different-member'];
  await f.service.discover(f.actor);
  await expect(f.service.selectChat(f.actor, member.modelRef)).rejects.toThrow('MODEL_REMOVED');
});

it('derives explicit multi-reference and geometry capability metadata from route paramSpec without guessing it', async () => {
  const f = await fixture(async () => metadata(['gpt-image-2-geom']));
  await f.service.discover(f.actor);
  const ref = (await f.service.catalog(f.actor)).items[0]!.modelRef;
  const baseFixture = findFixtureRoute('gpt-image-2', 'image.generate');
  await f.store.importRoutes([
    {
      ...baseFixture,
      rawModelId: 'gpt-image-2-geom',
      paramSpec: {
        ...baseFixture.paramSpec!,
        supportedOperations: ['generate', 'edit', 'outpaint'],
        maxReferenceImages: 4,
        allowMaskPng: false,
        allowOutpaintGeometry: true,
      },
    },
  ]);
  expect(await f.service.resolveImage(f.actor, ref)).toMatchObject({
    capabilityMetadata: {
      image: {
        modes: ['generate', 'edit', 'outpaint'],
        references: { maxImages: 4 },
        geometry: { unit: 'pixels', edges: ['left', 'top', 'right', 'bottom'] },
      },
    },
  });
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

it('does not manufacture members or verification through route data and isolates per-user verification and default targets', async () => {
  const one = await fixture(async () => metadata(['Same-ID']));
  const two = await fixture(async () => metadata(['Same-ID']));
  await one.service.discover(one.actor);
  await two.service.discover(two.actor);
  const ref = (await one.service.catalog(one.actor)).items[0]!.modelRef;
  await one.declare(ref);
  await expect(two.choose(ref)).rejects.toThrow('MODEL_NOT_FOUND');
  await expect(one.choose('onelink:chat:missing')).rejects.toThrow('MODEL_NOT_FOUND');
  await one.choose(ref);
  const snapshot = await one.service.resolveChat(
    one.actor,
    await one.service.selectChat(one.actor),
  );
  await one.store.recordVerification(one.actor.userId, snapshot, 'fixture:actual-success');
  expect((await one.service.catalog(one.actor)).items[0]!.adaptation!.verification.status).toBe(
    'verified',
  );
  expect((await two.service.catalog(two.actor)).items[0]!.adaptation!.verification.status).toBe(
    'unverified',
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
