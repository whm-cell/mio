import { spawnSync } from 'node:child_process';
import { makeAudioRouteFixture } from '../providers/fixtures/onelink-audio-route.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { providerSchemaSQL, checkProviderSchema } from '../../src/providers/schema.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { createAudioHandler } from '../../src/audio/http.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
const services: ReturnType<typeof createProviderService>[] = [];
beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  await pool.query(providerSchemaSQL);
  await pool.query(providerSchemaSQL);
  await checkProviderSchema(pool);
}, 30000);
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.restoreAllMocks();
});
afterAll(async () => {
  await pool?.end();
  await database?.close();
});

async function fixture() {
  const config = {
    databaseURL: database.url,
    masterKey: randomBytes(32),
    masterKeyId: 'voice-fixture',
  };
  const store = await createProviderStore(config);
  const actor = { userId: randomUUID(), sessionId: 'synthetic-session' };
  const modelId = `audio-fixture-${randomUUID()}`;
  let ids = [modelId];
  const calls = vi.fn(async () => Response.json({ data: ids.map((id) => ({ id })) }));
  const service = createProviderService(store, config, calls);
  services.push(service);
  await service.save(actor, 0, 'synthetic-voice-directory-key');
  await service.discover(actor);
  calls.mockClear();
  const route = makeAudioRouteFixture(modelId, 'audio.voices.list');
  const ttsRoute = makeAudioRouteFixture(modelId);
  await store.importRoutes([route, ttsRoute]);
  const providerId = (
    await pool.query<{ id: string }>('SELECT id FROM mio_provider_configs WHERE owner_id=$1', [
      actor.userId,
    ])
  ).rows[0]!.id;
  const seed = async (
    voices: {
      source: 'system' | 'voice_cloning' | 'voice_generation';
      upstreamId: string;
      name?: string;
    }[],
    replace = true,
  ) => {
    if (replace)
      await pool.query('DELETE FROM mio_provider_voices WHERE provider_id=$1', [providerId]);
    await pool.query(
      `INSERT INTO mio_provider_voices(provider_id,source,upstream_id,name,descriptions,seen_seq)
       SELECT $1,x.source,x."upstreamId",COALESCE(x.name,x."upstreamId"),'["中文"]'::jsonb,1
       FROM jsonb_to_recordset($2::jsonb) x(source text,"upstreamId" text,name text)
       ON CONFLICT(provider_id,source,upstream_id) DO UPDATE SET
         name=EXCLUDED.name,descriptions=EXCLUDED.descriptions,present=true,updated_at=now()`,
      [providerId, JSON.stringify(voices)],
    );
  };
  await seed(
    ['voice-a', 'voice-b', 'voice-c'].map((upstreamId) => ({
      source: 'system' as const,
      upstreamId,
    })),
  );
  const models = await service.listVoiceModels(actor);
  const modelRef = models[0]!.modelRef;
  const list = (query = '') => service.voices.list(actor.userId, new URLSearchParams(query));
  const refresh = () => service.voices.refresh(actor.userId);
  return {
    actor,
    config,
    service,
    store,
    modelRef,
    route,
    ttsRoute,
    providerId,
    calls,
    list,
    refresh,
    seed,
    setModels(value: string[]) {
      ids = value;
    },
  };
}

it('never calls the supplier from reads and reports only discovered, declared, enabled models', async () => {
  const f = await fixture();
  expect(await f.list()).toMatchObject({
    catalog: { status: 'connected', current: true, stale: false, errorCode: null },
    total: 3,
  });
  expect((await f.service.listVoiceModels(f.actor))[0]!.voice).toMatchObject({
    runnable: true,
    generationAvailable: true,
    adaptation: { verification: { status: 'unverified' } },
  });
  expect(f.calls).not.toHaveBeenCalled();
  await pool.query("UPDATE mio_provider_catalog_models SET category='chat' WHERE raw_model_id=$1", [
    f.route.rawModelId,
  ]);
  expect(await f.service.listVoiceModels(f.actor)).toHaveLength(1);
  await f.store.importRoutes([{ ...f.route, enabled: false }]);
  expect(await f.service.listVoiceModels(f.actor)).toEqual([]);
  await expect(f.refresh()).resolves.toEqual({ status: 'connected', source: 'local', count: 3 });
  expect(f.calls).not.toHaveBeenCalled();
});

it('preserves stable references and favorites across complete refreshes and independent source IDs', async () => {
  const f = await fixture();
  await f.refresh();
  const voice = (await f.list()).items[0]!;
  await f.service.voices.favorite(f.actor.userId, voice.voiceRef, true);
  await f.service.voices.favorite(f.actor.userId, voice.voiceRef, true);
  await f.refresh();
  expect(await f.service.voices.get(f.actor.userId, voice.voiceRef)).toMatchObject({
    favorite: true,
    available: true,
    previewAssetId: null,
    language: null,
    generationAvailable: true,
  });
  await f.seed(
    [
      { source: 'system', upstreamId: 'same' },
      { source: 'voice_cloning', upstreamId: 'same' },
    ],
    false,
  );
  await f.refresh();
  const rows = (await f.list('search=same')).items;
  expect(rows).toHaveLength(2);
  expect(rows[0]!.voiceRef).not.toBe(rows[1]!.voiceRef);
  expect(await f.service.voices.get(f.actor.userId, voice.voiceRef)).toMatchObject({
    favorite: true,
    available: true,
  });
});

it('does not reveal or mutate another user voice, and blocks nonmember refreshes before outbound', async () => {
  const f = await fixture();
  await f.refresh();
  const voice = (await f.list()).items[0]!;
  const stranger = randomUUID();
  await expect(f.service.voices.get(stranger, voice.voiceRef)).rejects.toThrow('VOICE_NOT_FOUND');
  await expect(f.service.voices.favorite(stranger, voice.voiceRef, true)).rejects.toThrow(
    'VOICE_NOT_FOUND',
  );
  expect((await f.service.voices.list(stranger, new URLSearchParams())).items).toEqual([]);
  f.setModels([]);
  await f.service.discover(f.actor);
  f.calls.mockClear();
  await expect(f.refresh()).resolves.toEqual({ status: 'connected', source: 'local', count: 3 });
  expect((await f.list()).items.every((voice) => !voice.available)).toBe(true);
  expect(f.calls).not.toHaveBeenCalled();
});

it('keeps local system voices usable after key rotation without a supplier refresh', async () => {
  const f = await fixture();
  await f.seed([
    { source: 'system', upstreamId: 'system-voice', name: '系统音色' },
    { source: 'voice_cloning', upstreamId: 'cloned-voice', name: '克隆音色' },
    { source: 'voice_generation', upstreamId: 'generated-voice', name: '生成音色' },
  ]);
  await f.refresh();
  const initial = (await f.list()).items;
  const system = initial.find((voice) => voice.source === 'system')!;
  const cloning = initial.find((voice) => voice.source === 'voice_cloning')!;
  const generated = initial.find((voice) => voice.source === 'voice_generation')!;
  await f.service.voices.favorite(f.actor.userId, system.voiceRef, true);
  await f.service.save(
    f.actor,
    (await f.service.get(f.actor))!.revision,
    'synthetic-rotated-voice-key',
  );
  expect(await f.service.voices.get(f.actor.userId, system.voiceRef)).toMatchObject({
    favorite: true,
    available: false,
  });
  await expect(f.refresh()).resolves.toEqual({ status: 'connected', source: 'local', count: 3 });
  await f.service.discover(f.actor);
  f.calls.mockClear();
  await expect(f.refresh()).resolves.toEqual({ status: 'connected', source: 'local', count: 3 });
  expect((await f.list()).catalog).toMatchObject({
    status: 'connected',
    errorCode: null,
    current: true,
    stale: false,
  });
  expect(await f.service.voices.get(f.actor.userId, system.voiceRef)).toMatchObject({
    favorite: true,
    available: true,
    generationAvailable: true,
  });
  expect(await f.service.voices.get(f.actor.userId, cloning.voiceRef)).toMatchObject({
    available: false,
  });
  expect(await f.service.voices.get(f.actor.userId, generated.voiceRef)).toMatchObject({
    available: false,
  });
  const admission = await f.service.snapshotAudio(f.actor, f.modelRef, 'tts');
  await expect(
    f.service.resolveAudioVoice(f.actor.userId, system.voiceRef, admission),
  ).resolves.toMatchObject({ upstream_id: 'system-voice' });
  await expect(
    f.service.resolveAudioVoice(f.actor.userId, cloning.voiceRef, admission),
  ).rejects.toThrow('VOICE_NOT_FOUND');
  expect(f.calls).not.toHaveBeenCalled();
});

it('reads only local rows and ignores an old failed supplier catalog snapshot', async () => {
  const f = await fixture();
  await pool.query(
    `INSERT INTO mio_provider_voice_catalogs(provider_id,latest_seq,last_status,last_error,started_at,finished_at,lease_until)
     VALUES($1,1,'failed','VOICE_UPSTREAM_UNAVAILABLE',now(),now(),now())`,
    [f.providerId],
  );
  expect(await f.refresh()).toEqual({ status: 'connected', source: 'local', count: 3 });
  expect(await f.list()).toMatchObject({
    total: 3,
    catalog: { status: 'connected', current: true, stale: false, errorCode: null },
  });
  expect(f.calls).not.toHaveBeenCalled();
});

it('requires a current TTS route before a system voice can be selected', async () => {
  const f = await fixture();
  await f.refresh();
  const voice = (await f.list()).items[0]!;
  expect(voice).toMatchObject({ available: true, generationAvailable: true });
  await f.store.importRoutes([{ ...f.ttsRoute, enabled: false }]);
  expect(await f.service.voices.get(f.actor.userId, voice.voiceRef)).toMatchObject({
    available: false,
    generationAvailable: false,
  });
});

it('refreshes the local directory idempotently without outbound requests', async () => {
  const f = await fixture();
  await expect(Promise.all([f.refresh(), f.refresh()])).resolves.toEqual([
    { status: 'connected', source: 'local', count: 3 },
    { status: 'connected', source: 'local', count: 3 },
  ]);
  expect(f.calls).not.toHaveBeenCalled();
});

it('reflects local database mutations immediately', async () => {
  const f = await fixture();
  await f.seed([{ source: 'system', upstreamId: 'local-new', name: '本地新增音色' }]);
  expect(await f.refresh()).toEqual({ status: 'connected', source: 'local', count: 1 });
  expect(await f.list()).toMatchObject({ total: 1, items: [{ name: '本地新增音色' }] });
});

it('reports the complete local total independently of pages and empty search results', async () => {
  const f = await fixture();
  const outbound = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('unexpected outbound'));
  await f.seed(
    Array.from({ length: 592 }, (_, index) => ({
      source: 'system' as const,
      upstreamId: `system-${index}`,
      name: index === 591 ? 'Approachable Girl' : `Local voice ${index}`,
    })),
  );
  await f.store.importRoutes([{ ...f.route, enabled: false }]);
  expect(await f.refresh()).toEqual({ status: 'connected', source: 'local', count: 592 });
  const first = await f.list();
  expect(first.total).toBe(592);
  expect(first.items).toHaveLength(30);
  expect(first.items.every((voice) => voice.available)).toBe(true);
  expect(await f.list(`cursor=${first.nextCursor}`)).toMatchObject({ total: 592 });
  expect(await f.list('search=Approachable%20Girl')).toMatchObject({
    total: 1,
    items: [{ name: 'Approachable Girl', available: true }],
  });
  expect(await f.list('search=missing-voice')).toMatchObject({
    catalog: { status: 'connected', current: true, stale: false, errorCode: null },
    total: 0,
    items: [],
  });
  expect(f.calls).not.toHaveBeenCalled();
  expect(outbound).not.toHaveBeenCalled();
});

it('paginates tied microsecond timestamps exactly and treats wildcard/search text literally', async () => {
  const f = await fixture();
  await f.seed(
    ['literal%_', 'literalX', 'slash\\voice', '普通音色'].map((upstreamId) => ({
      source: 'system' as const,
      upstreamId,
    })),
  );
  await f.refresh();
  await pool.query(
    `UPDATE mio_provider_voices SET created_at='2026-11-18T00:00:00.123456Z' WHERE provider_id=(SELECT id FROM mio_provider_configs WHERE owner_id=$1)`,
    [f.actor.userId],
  );
  const all: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await f.list(`limit=1${cursor ? `&cursor=${cursor}` : ''}`);
    all.push(...page.items.map((voice) => voice.voiceRef));
    cursor = page.nextCursor;
  } while (cursor);
  expect(all).toHaveLength(4);
  expect(new Set(all).size).toBe(4);
  expect((await f.list('search=%25_')).items.map((voice) => voice.name)).toEqual(['literal%_']);
  expect((await f.list('search=%5C')).items.map((voice) => voice.name)).toEqual(['slash\\voice']);
  await f.service.voices.favorite(f.actor.userId, all[0]!, true);
  expect((await f.list('favorite=true')).items).toHaveLength(1);
});

it('rejects impossible dates and noncanonical cursors before they can reach PostgreSQL', async () => {
  const f = await fixture();
  for (const time of ['2026-02-31T00:00:00.123456Z', '0000-01-01T00:00:00.123456Z']) {
    const cursor = Buffer.from(JSON.stringify([time, randomUUID()])).toString('base64url');
    await expect(f.list(`cursor=${cursor}`)).rejects.toThrow('QUERY_INVALID');
  }
});

it.each([
  'limit=0',
  'limit=101',
  'limit=01',
  'source=unknown',
  'favorite=1',
  'limit=1&limit=2',
  'owner=x',
  'cursor=garbage',
  `search=${'字'.repeat(101)}`,
])('rejects invalid query %s before supplier or SQL writes', async (query) => {
  const f = await fixture();
  await expect(f.list(query)).rejects.toThrow('QUERY_INVALID');
  expect(f.calls).not.toHaveBeenCalled();
});

it('checks Origin/login/JSON/method/body fields and rechecks identity after the request body', async () => {
  const f = await fixture();
  const identity = vi.fn(async (headers: Headers) =>
    headers.get('cookie') === 'synthetic=owner' ? f.actor : null,
  );
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  const origin = `http://127.0.0.1:${address.port}`;
  const handler = createAudioHandler(f.service, identity, [origin]);
  server.on('request', (request, response) => {
    void handler(request, response);
  });
  const call = (
    path: string,
    method = 'GET',
    value?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${origin}/api/v1/audio${path}`, {
      method,
      headers: { origin, cookie: 'synthetic=owner', 'content-type': 'application/json', ...extra },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  try {
    expect((await call('/voices', 'GET', undefined, { cookie: '' })).status).toBe(401);
    expect(
      (await call('/voices', 'GET', undefined, { origin: 'https://untrusted.test' })).status,
    ).toBe(403);
    expect(
      (await call('/voices/refresh', 'POST', {}, { 'content-type': 'text/plain' })).status,
    ).toBe(415);
    expect(
      (await call('/voices/refresh', 'POST', { modelRef: f.modelRef, ownerId: f.actor.userId }))
        .status,
    ).toBe(400);
    expect((await call('/voices/refresh', 'DELETE')).status).toBe(405);
    expect(f.calls).not.toHaveBeenCalled();
    const preflight = await call('/voices/refresh', 'OPTIONS');
    expect(preflight.status).toBe(204);
    const refresh = await call('/voices/refresh', 'POST', {});
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toEqual({ status: 'connected', source: 'local', count: 3 });
    expect(refresh.headers.get('cache-control')).toBe('no-store');
    expect(refresh.headers.get('x-request-id')).toBeTruthy();
    const items = (await f.list()).items;
    expect((await call(`/voices/${items[0]!.voiceRef}`, 'PATCH', { favorite: true })).status).toBe(
      200,
    );
    const detail = await call(`/voices/${items[0]!.voiceRef}`);
    expect(await detail.json()).toMatchObject({ favorite: true });
    expect((await call('/models?extra=1')).status).toBe(400);
    identity.mockResolvedValueOnce(f.actor).mockResolvedValueOnce(null);
    expect((await call('/voices/refresh', 'POST', { modelRef: f.modelRef })).status).toBe(401);
    expect(f.calls).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('waits for local reads on shutdown and rejects further reads', async () => {
  const f = await fixture();
  const pending = f.refresh();
  await f.service.close();
  expect(await pending).toEqual({ status: 'connected', source: 'local', count: 3 });
  expect(f.calls).not.toHaveBeenCalled();
  expect(() => f.list()).toThrow('VOICE_UNAVAILABLE');
});

it('registers only one reviewed voice from CLI for the current owner and exact model', async () => {
  const f = await fixture();
  await f.seed([]);
  expect(await f.list()).toMatchObject({ total: 0, items: [], catalog: { status: 'empty' } });
  const input = [
    '--owner-id',
    f.actor.userId,
    '--model-ref',
    f.modelRef,
    '--voice-id',
    'reviewed-voice',
    '--name',
    '已核对的音色',
    '--evidence',
    'regression synthetic known candidate',
  ];
  const run = (...flags: string[]) =>
    spawnSync(process.execPath, ['scripts/service/import-system-voice.ts', ...input, ...flags], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        MIO_PROVIDERS_DATABASE_URL: f.config.databaseURL,
        MIO_PROVIDERS_MASTER_KEY: f.config.masterKey.toString('base64'),
        MIO_PROVIDERS_MASTER_KEY_ID: f.config.masterKeyId,
      },
    });
  expect(run().status).toBe(0);
  expect((await f.list()).total).toBe(0);
  const applied = run('--apply');
  expect(applied.status, applied.stderr).toBe(0);
  const first = JSON.parse(applied.stdout) as { voiceRef: string };
  await f.service.voices.favorite(f.actor.userId, first.voiceRef, true);
  const replay = run('--apply');
  expect(replay.status, replay.stderr).toBe(0);
  expect(JSON.parse(replay.stdout)).toMatchObject({ voiceRef: first.voiceRef, exists: true });
  expect((await f.list()).items).toMatchObject([
    {
      voiceRef: first.voiceRef,
      registrationModelRef: f.modelRef,
      favorite: true,
      generationAvailable: true,
    },
  ]);
  expect((await f.service.voices.list(randomUUID(), new URLSearchParams())).items).toEqual([]);

  const secondModel = `audio-other-${randomUUID()}`;
  await f.store.importRoutes([makeAudioRouteFixture(secondModel)]);
  f.setModels([f.route.rawModelId, secondModel]);
  await f.service.discover(f.actor);
  f.calls.mockClear();
  const models = await f.service.listAudioModels(f.actor, 'tts');
  const secondRef = models.find((model) => model.modelId === secondModel)!.modelRef;
  const incorrect = await f.service.snapshotAudio(f.actor, secondRef, 'tts');
  await expect(
    f.service.resolveAudioVoice(f.actor.userId, first.voiceRef, incorrect),
  ).rejects.toThrow('VOICE_NOT_FOUND');
  const correct = await f.service.snapshotAudio(f.actor, f.modelRef, 'tts');
  await expect(
    f.service.resolveAudioVoice(f.actor.userId, first.voiceRef, correct),
  ).resolves.toMatchObject({ upstream_id: 'reviewed-voice' });
  await expect(
    f.store.registerSystemVoice(
      {
        ownerId: f.actor.userId,
        modelRef: secondRef,
        upstreamId: 'reviewed-voice',
        name: '系统音色',
        evidence: 'new reference',
      },
      true,
    ),
  ).rejects.toThrow('VOICE_REGISTRATION_MODEL_CONFLICT');
  await f.store.importRoutes({ ...f.ttsRoute, enabled: false });
  expect(await f.service.voices.get(f.actor.userId, first.voiceRef)).toMatchObject({
    generationAvailable: false,
    available: false,
  });
  expect(f.calls).not.toHaveBeenCalled();
});

it('reports only current, exact operation verification and never uses a curated undiscovered model to admit speech', async () => {
  const f = await fixture();
  await f.store.importRoutes(makeAudioRouteFixture(f.route.rawModelId, 'audio.clone'));
  const tts = await f.service.snapshotAudio(f.actor, f.modelRef, 'tts');
  await f.service.recordAudioVerification(
    f.actor.userId,
    tts,
    'synthetic successful TTS observation',
  );
  expect((await f.service.listAudioModels(f.actor, 'tts'))[0]!.verification.status).toBe(
    'verified',
  );
  expect((await f.service.listAudioModels(f.actor, 'clone'))[0]!.verification.status).toBe(
    'unverified',
  );
  await f.store.importRoutes({ ...f.ttsRoute, sourceVersion: 'v2' });
  await f.service.recordAudioVerification(f.actor.userId, tts, 'synthetic late completion');
  expect((await f.service.listAudioModels(f.actor, 'tts'))[0]!.verification.status).toBe(
    'unverified',
  );
  await pool.query(
    'UPDATE mio_provider_catalog_models SET allow_undiscovered=true WHERE raw_model_id=$1',
    [f.route.rawModelId],
  );
  f.setModels([]);
  await f.service.discover(f.actor);
  expect(await f.service.listAudioModels(f.actor, 'tts')).toEqual([]);
  await expect(f.service.snapshotAudio(f.actor, f.modelRef, 'tts')).rejects.toThrow(
    'MODEL_REMOVED',
  );
});
