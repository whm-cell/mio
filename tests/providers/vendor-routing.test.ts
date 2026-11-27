import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateImageRouteConfig } from '../../src/generations/image/contracts.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { createGenerationHandler } from '../../src/generations/image/http.ts';
import { checkGenerationSchema, generationSchemaSQL } from '../../src/generations/schema.ts';
import { createGenerationService } from '../../src/generations/image/service.ts';
import { createGenerationStore, GenerationStore } from '../../src/generations/image/store.ts';
import type { GenerationObjects } from '../../src/generations/image/execution.ts';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { createConversationService } from '../../src/conversations/service.ts';
import { createConversationStore } from '../../src/conversations/store.ts';
import { installConversationTitles } from '../../src/dsh/conversation-titles.ts';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import type { ProviderConfig } from '../../src/providers/config.ts';
import type { ModelRouteInput, ProviderPrincipal } from '../../src/providers/contracts.ts';
import { checkProviderSchema, providerSchemaSQL } from '../../src/providers/schema.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { protocolResponse } from '../onelink/fixture.ts';
import { authDatabase } from '../support/auth-database.ts';
import { legacyProviderAdaptationTablesSQL } from './fixtures/provider-legacy-schema.ts';
import { kernelRuntime, ScriptedModel } from '../support/kernel-runtime.ts';
import {
  findFixtureImageRouteConfig,
  findFixtureRoute,
  importRoutesViaCli,
  ONELINK_FIXTURE_ROUTES,
} from './fixtures/onelink-routes-fixture.ts';

afterEach(() => vi.unstubAllGlobals());

function encodeSampleJpeg(): Uint8Array {
  const encoded = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=green:s=16x16',
      '-frames:v',
      '1',
      '-c:v',
      'mjpeg',
      '-f',
      'image2pipe',
      'pipe:1',
    ],
    { timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  if (encoded.status !== 0) throw new Error('ffmpeg sample encode failed');
  return Uint8Array.from(encoded.stdout);
}

const JPEG_BYTES = encodeSampleJpeg();
const PNG_BYTES = await sharp(JPEG_BYTES).png().toBuffer();

function generationObjects(
  objects: Map<string, { size: number; etag: string; sha256: string }>,
): GenerationObjects {
  return {
    uploadUrl: () => '',
    downloadUrl: () => '',
    copy: async () => {},
    delete: async () => {},
    head: async (key) => {
      const value = objects.get(key);
      if (!value) throw Object.assign(new Error('OBJECT_NOT_FOUND'), { statusCode: 404 });
      return value;
    },
    readImage: async (key, etag, size) => {
      const value = objects.get(key);
      if (!value || value.etag !== etag || value.size !== size)
        throw new Error('REFERENCE_MISMATCH');
      return JPEG_BYTES;
    },
    putImage: async (key, bytes, format, sha256) => {
      const digest = createHash('sha256').update(bytes).digest('hex');
      expect(sha256).toBe(digest);
      expect(Buffer.from(bytes)).toEqual(Buffer.from(format === 'png' ? PNG_BYTES : JPEG_BYTES));
      if (objects.has(key)) throw new Error('OBJECT_OVERWRITE');
      const meta = { size: bytes.byteLength, etag: 'etag-derived', sha256: digest };
      objects.set(key, meta);
      return {
        key,
        sizeBytes: meta.size,
        etag: meta.etag,
        sha256: digest,
        contentType: 'image/' + format,
      };
    },
  };
}

function providerEnv(databaseURL: string, masterKey: Buffer) {
  return {
    PATH: process.env.PATH ?? '',
    MIO_PROVIDERS_DATABASE_URL: databaseURL,
    MIO_PROVIDERS_MASTER_KEY: masterKey.toString('base64'),
    MIO_PROVIDERS_MASTER_KEY_ID: 'vendor-routing-test-v1',
  };
}

function runRouteCli(env: Record<string, string>, arg: string, stdin?: string) {
  return spawnSync(process.execPath, ['scripts/service/import-provider-route.ts', arg], {
    env,
    input: stdin,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

async function withProviderDb(
  action: (ctx: {
    pool: Pool;
    config: ProviderConfig;
    env: Record<string, string>;
    databaseURL: string;
  }) => Promise<void>,
) {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  const masterKey = randomBytes(32);
  const config: ProviderConfig = {
    databaseURL: database.url,
    masterKey,
    masterKeyId: 'vendor-routing-test-v1',
  };
  const env = providerEnv(database.url, masterKey);
  try {
    await pool.query(providerSchemaSQL);
    await action({ pool, config, env, databaseURL: database.url });
  } finally {
    await pool.end();
    await database.close();
  }
}

describe('OneLink database vendor routing acceptance scenarios (PRD §3.1)', () => {
  it('rejects an imported OpenAI image route for reference-driven JSON generation', async () =>
    withProviderDb(async ({ pool, env }) => {
      const route = findFixtureRoute('gpt-image-2', 'image.generate');
      const rejected = runRouteCli(
        env,
        '--stdin',
        JSON.stringify({
          ...route,
          paramSpec: { ...route.paramSpec, allowGenerateReferences: true },
        }),
      );
      expect(rejected.status).toBe(1);
      expect(rejected.stderr.trim()).toBe('ROUTE_INVALID');
      expect((await pool.query('SELECT raw_model_id FROM mio_provider_model_routes')).rows).toEqual(
        [],
      );
    }));

  it('Scenario 1: imports JSON routes idempotently via CLI, rejects --seed and >65536B inputs, and makes discovered models runnable across users', async () =>
    withProviderDb(async ({ config, env }) => {
      const rejectedSeed = runRouteCli(env, '--seed');
      expect(rejectedSeed.status).toBe(1);
      expect(rejectedSeed.stderr.trim()).toBe('Usage: providers:route <--stdin | routes.json>');

      const firstSummary = await importRoutesViaCli(env, ONELINK_FIXTURE_ROUTES);
      expect(firstSummary.inserted).toBe(45);
      expect(firstSummary.updated).toBe(0);
      expect(firstSummary.unchanged).toBe(0);

      const oversizedDir = mkdtempSync(join(tmpdir(), 'mio-route-cli-'));
      try {
        const oversizedPath = join(oversizedDir, 'oversized.json');
        writeFileSync(oversizedPath, ' '.repeat(65_537));
        const rejectedFile = runRouteCli(env, oversizedPath);
        expect(rejectedFile.status).toBe(1);
        expect(rejectedFile.stderr.trim()).toBe('ROUTE_INVALID');
        const rejectedDir = runRouteCli(env, oversizedDir);
        expect(rejectedDir.status).toBe(1);
        expect(rejectedDir.stderr.trim()).toBe('ROUTE_INVALID');
      } finally {
        rmSync(oversizedDir, { recursive: true, force: true });
      }

      const secondSummary = await importRoutesViaCli(env, ONELINK_FIXTURE_ROUTES);
      expect(secondSummary.inserted).toBe(0);
      expect(secondSummary.updated).toBe(0);
      expect(secondSummary.unchanged).toBe(firstSummary.inserted);

      const store = await createProviderStore(config);
      const service = createProviderService(store, config, async () =>
        Response.json({
          data: [
            { id: 'deepseek-v4.1-flash' },
            { id: 'doubao-seedream-5.0-lite' },
            { id: 'image-kling-v3-omni' },
          ],
        }),
      );
      try {
        const userA: ProviderPrincipal = { userId: 'user-a', sessionId: 'sess-a' };
        const userB: ProviderPrincipal = { userId: 'user-b', sessionId: 'sess-b' };
        for (const [actor, key] of [
          [userA, 'key-user-a-secret-123'],
          [userB, 'key-user-b-secret-456'],
        ] as const) {
          await service.save(actor, 0, key);
          const discovery = await service.discover(actor);
          expect(discovery.status).toBe('connected');
          const view = await service.catalog(actor);
          const chatItem = view.items.find((item) => item.modelId === 'deepseek-v4.1-flash')!;
          const seedreamItem = view.items.find(
            (item) => item.modelId === 'doubao-seedream-5.0-lite',
          )!;
          const omniItem = view.items.find((item) => item.modelId === 'image-kling-v3-omni')!;
          expect(chatItem.runnable).toBe(true);
          expect(chatItem.adaptation?.vendor).toBe('deepseek');
          expect('origin' in (chatItem.adaptation ?? {})).toBe(false);
          expect(chatItem.adaptation?.verification.status).toBe('unverified');
          expect(seedreamItem.image.runnable).toBe(true);
          expect(seedreamItem.image.adaptation?.vendor).toBe('volcengine');
          expect('origin' in (seedreamItem.image.adaptation ?? {})).toBe(false);
          expect(seedreamItem.image.adaptation?.verification.status).toBe('unverified');
          expect(omniItem.image.runnable).toBe(true);
          expect(omniItem.image.adaptation?.profile).toBe('kling-images');
        }
      } finally {
        await service.close();
        await store.close();
      }
    }));

  it('Scenario 2: enforces strict per-user /v1/models membership, removal and key-rotation gates despite DB routes', async () =>
    withProviderDb(async ({ config, env }) => {
      await importRoutesViaCli(env, ONELINK_FIXTURE_ROUTES);
      let currentIds = ['deepseek-v4.1-flash'];
      const store = await createProviderStore(config);
      const service = createProviderService(store, config, async () =>
        Response.json({ data: currentIds.map((id) => ({ id })) }),
      );
      try {
        const userB: ProviderPrincipal = { userId: 'user-b-isolated', sessionId: 'sess-b' };
        await service.save(userB, 0, 'key-user-b-initial-123');
        await service.discover(userB);
        const view = await service.catalog(userB);
        expect(view.items.map((item) => item.modelId)).toEqual(['deepseek-v4.1-flash']);
        await expect(service.selectChat(userB, 'onelink:chat:qwen3.7-max')).rejects.toMatchObject({
          code: 'MODEL_NOT_FOUND',
        });
        await expect(
          service.snapshotImage(userB, 'onelink:image:doubao-seedream-5.0-lite'),
        ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });

        const deepseekRef = view.items[0]!.modelRef;
        currentIds = [];
        await service.discover(userB);
        await expect(service.selectChat(userB, deepseekRef)).rejects.toMatchObject({
          code: 'MODEL_REMOVED',
        });

        const latest = (await service.get(userB))!;
        await service.save(userB, latest.revision, 'key-user-b-rotated-999');
        await expect(service.selectChat(userB, deepseekRef)).rejects.toMatchObject({
          code: 'MODEL_CATALOG_NOT_DISCOVERED',
        });
      } finally {
        await service.close();
        await store.close();
      }
    }));

  it('Scenario 3: isolates per-user verification on shared DB routes and resets verification status on route version bump', async () =>
    withProviderDb(async ({ pool, config, env }) => {
      await importRoutesViaCli(env, ONELINK_FIXTURE_ROUTES);
      const store = await createProviderStore(config);
      const service = createProviderService(store, config, async () =>
        Response.json({
          data: [{ id: 'deepseek-v4.1-flash' }, { id: 'doubao-seedream-5.0-lite' }],
        }),
      );
      try {
        const userA: ProviderPrincipal = { userId: 'user-a-shared', sessionId: 's-a' };
        const userB: ProviderPrincipal = { userId: 'user-b-shared', sessionId: 's-b' };
        for (const [actor, key] of [
          [userA, 'key-a-123456'],
          [userB, 'key-b-654321'],
        ] as const) {
          await service.save(actor, 0, key);
          await service.discover(actor);
        }

        const viewB = await service.catalog(userB);
        const chatRefB = viewB.items.find((i) => i.modelId === 'deepseek-v4.1-flash')!.modelRef;
        const selB = await service.selectChat(userB, chatRefB);
        const snapB = await service.resolveChat(userB, selB);
        expect(snapB.maxOutputTokens).toBe(4096);
        expect(snapB.submitPath).toBe('/v1/chat/completions');

        const imageRefB = viewB.items.find(
          (i) => i.modelId === 'doubao-seedream-5.0-lite',
        )!.modelRef;
        const imgSnapB = await service.snapshotImage(userB, imageRefB);
        expect(imgSnapB.vendor).toBe('volcengine');
        await service.recordVerification(
          userB,
          {
            providerConfigId: imgSnapB.providerConfigId,
            credentialVersion: imgSnapB.credentialVersion,
            catalogVersion: imgSnapB.catalogVersion,
            adaptationVersion: imgSnapB.adaptationVersion,
            modelKey: imgSnapB.modelKey,
            operation: 'image.generate',
            profile: imgSnapB.profile,
          },
          'image:job-b-1',
        );

        const verifiedViewB = await service.catalog(userB);
        const unverifiedViewA = await service.catalog(userA);
        expect(
          verifiedViewB.items.find((i) => i.modelId === 'doubao-seedream-5.0-lite')?.image
            .adaptation?.verification.status,
        ).toBe('verified');
        expect(
          unverifiedViewA.items.find((i) => i.modelId === 'doubao-seedream-5.0-lite')?.image
            .adaptation?.verification.status,
        ).toBe('unverified');

        const existingRoute = (
          await pool.query(
            "SELECT * FROM mio_provider_model_routes WHERE raw_model_id='doubao-seedream-5.0-lite'",
          )
        ).rows[0]!;
        await store.importRoutes([
          {
            providerType: 'onelink',
            rawModelId: 'doubao-seedream-5.0-lite',
            operation: 'image.generate',
            vendor: existingRoute.vendor,
            driver: existingRoute.driver,
            classification: existingRoute.classification,
            submitPath: existingRoute.submit_path,
            paramSpec: existingRoute.param_spec,
            requestDefaults: existingRoute.request_defaults,
            outputSpec: existingRoute.output_spec,
            sourceKind: 'runtime-observation',
            source: 'updated-route-source-v2',
            sourceVersion: '2026-11-16',
          },
        ]);

        const afterBumpB = await service.catalog(userB);
        const bumpedItem = afterBumpB.items.find((i) => i.modelId === 'doubao-seedream-5.0-lite')!;
        expect(bumpedItem.image.adaptation?.declarationVersion).toBe(2);
        expect(bumpedItem.image.adaptation?.verification.status).toBe('unverified');
        const historyRows = (
          await pool.query(
            'SELECT declaration_version, verification_status FROM mio_provider_model_verifications WHERE provider_id=$1',
            [imgSnapB.providerConfigId],
          )
        ).rows;
        expect(historyRows).toEqual([{ declaration_version: 1, verification_status: 'verified' }]);
      } finally {
        await service.close();
        await store.close();
      }
    }));

  it(
    'Scenario 4: executes brand-new arbitrary chat and image model IDs end-to-end via CLI route import without TS code edits',
    async () =>
      withProviderDb(async ({ pool, config, env, databaseURL }) => {
        const customRoutes: ModelRouteInput[] = [
          {
            providerType: 'onelink',
            rawModelId: 's-chat-custom-2048',
            operation: 'chat',
            vendor: 'customchat',
            driver: 'openai-chat',
            classification: 'chat',
            submitPath: '/v1/chat/completions',
            capabilityMetadata: { maxOutputTokens: 2048, cacheRetention: 'long' },
            sourceKind: 'protocol-reference',
            source: 'unit1-acceptance-scenario-4',
            sourceVersion: 'v1',
          },
          {
            providerType: 'onelink',
            rawModelId: 'WL-Next-Seedream-X',
            operation: 'image.generate',
            vendor: 'volcengine',
            driver: 'volcengine-ark-images',
            classification: 'image',
            submitPath: '/volc/api/v3/images/generations',
            paramSpec: {
              supportedOperations: ['generate'],
              requiresAsync: false,
              maxN: 2,
              allowExplicitN: true,
              allowedSizes: ['2K'],
              allowCustomDimensions: false,
              maxReferenceImages: 0,
              allowGenerateReferences: false,
              allowMaskPng: false,
              allowOutpaintGeometry: false,
              allowedQualities: [],
              allowedBackgrounds: [],
              allowedModerations: [],
              allowedOutputFormats: [],
              allowOutputCompression: false,
              allowUserField: false,
              allowedAspectRatios: [],
              allowWatermarkOverride: true,
              async: null,
            },
            requestDefaults: {
              watermark: true,
              sequentialImageGeneration: 'disabled',
              responseFormat: 'b64_json',
              stream: false,
              defaultSize: '2K',
            },
            outputSpec: { fixedOutputFormat: 'jpeg' },
            sourceKind: 'protocol-reference',
            source: 'unit1-acceptance-scenario-4',
            sourceVersion: 'v1',
          },
        ];
        const imported = runRouteCli(env, '--stdin', JSON.stringify(customRoutes));
        expect(imported.status, imported.stderr).toBe(0);

        await pool.query(conversationSchemaSQL);
        await pool.query(assetSchemaSQL);
        await pool.query(generationSchemaSQL);

        const dshRoot = await mkdtemp(join(tmpdir(), 'mio-vr-dsh-'));
        const generationDir = mkdtempSync(join(tmpdir(), 'mio-vr-generations-'));
        const ctx = await kernelRuntime(dshRoot, new ScriptedModel([]));
        const store = await createProviderStore(config);
        const providerService = createProviderService(store, config, async () =>
          Response.json({
            data: [{ id: 's-chat-custom-2048' }, { id: 'WL-Next-Seedream-X' }],
          }),
        );
        const convStore = await createConversationStore(databaseURL);
        const engine = createDshConversationEngine(ctx, { databaseURL, byok: true });
        const convService = createConversationService(convStore, engine, providerService);

        const chatOutbound: Record<string, unknown>[] = [];

        const objects = new Map<string, { size: number; etag: string; sha256: string }>();
        const imageOutbound: Record<string, unknown>[] = [];
        const imageTransport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
          imageOutbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          const b64 = Buffer.from(JPEG_BYTES).toString('base64');
          return Response.json({ data: [{ b64_json: b64 }, { b64_json: b64 }] });
        });
        const generationStore = await createGenerationStore(databaseURL);
        const generationService = await createGenerationService(
          generationStore,
          generationObjects(objects),
          { dataDirectory: generationDir },
          () => providerService,
          { transport: imageTransport },
        );
        const actor: ProviderPrincipal = { userId: 'user-zero-ts', sessionId: 'sess-zero-ts' };
        let httpOrigin = '';
        const server = createServer(
          (req, res) =>
            void createGenerationHandler(
              generationService,
              async () => ({ userId: actor.userId, sessionId: actor.sessionId }),
              [httpOrigin],
            )(req, res),
        );
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const port = (server.address() as { port: number }).port;
        httpOrigin = `http://127.0.0.1:${port}`;
        vi.unstubAllGlobals();
        const realFetch = globalThis.fetch;
        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.startsWith('https://api.onelinkai.cloud/')) {
            const request = new Request(input, init);
            chatOutbound.push((await request.clone().json()) as Record<string, unknown>);
            return protocolResponse(request, 'hello from custom model');
          }
          return realFetch(input, init);
        });

        try {
          await ctx.inject(['sessions', 'sessionProjections', 'agents'], async (titleCtx) => {
            await installConversationTitles(titleCtx);
          });
          await providerService.save(actor, 0, 'sk-zero-ts-key-12345');
          const afterSave = (await providerService.get(actor))!;
          await providerService.settings(actor, afterSave.revision, {
            defaultImageWatermark: false,
          });
          await providerService.discover(actor);
          const catalog = await providerService.catalog(actor);
          const chatModel = catalog.items.find((i) => i.modelId === 's-chat-custom-2048')!;
          const imageModel = catalog.items.find((i) => i.modelId === 'WL-Next-Seedream-X')!;
          const selection = await providerService.selectChat(actor, chatModel.modelRef);
          const snapshot = await providerService.resolveChat(actor, selection);
          expect(snapshot.cacheRetention).toBe('long');
          expect(Object.isFrozen(snapshot)).toBe(true);

          const created = await convService.create(actor, chatModel.modelRef);
          const chatReqId = randomUUID();
          await convService.send(actor, created.id, chatReqId, 'ping');
          await vi.waitFor(async () => {
            expect((await convService.request(actor, created.id, chatReqId)).status).toBe(
              'completed',
            );
          });
          const conversations = await convService.list(actor, undefined, 20);
          expect(conversations.items).toContainEqual(
            expect.objectContaining({ id: created.id, title: 'ping' }),
          );
          expect(chatOutbound).toHaveLength(1);
          expect(chatOutbound[0]).toMatchObject({
            model: 's-chat-custom-2048',
            max_tokens: 2048,
          });
          expect(JSON.stringify(chatOutbound[0])).not.toMatch(
            /"(?:prompt_cache_(?:key|retention)|cache_control)":/,
          );

          const postRes = await realFetch(`${httpOrigin}/api/v1/compute/images`, {
            method: 'POST',
            headers: {
              origin: httpOrigin,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              requestId: randomUUID(),
              modelRef: imageModel.modelRef,
              parameters: { prompt: 'dual custom frames', n: 2 },
            }),
          });
          expect(postRes.status).toBe(202);
          const createdJob = (await postRes.json()) as { jobId: string };

          let finalJob: { status: string; assetIds: string[] } = { status: '', assetIds: [] };
          await vi.waitFor(async () => {
            const getRes = await realFetch(
              `${httpOrigin}/api/v1/compute/images/${createdJob.jobId}`,
              { headers: { origin: httpOrigin } },
            );
            finalJob = (await getRes.json()) as { status: string; assetIds: string[] };
            expect(finalJob.status).toBe('completed');
          });
          expect(finalJob.assetIds).toHaveLength(2);
          expect(imageOutbound[0]).toMatchObject({
            model: 'WL-Next-Seedream-X',
            watermark: false,
            sequential_image_generation: 'auto',
            sequential_image_generation_options: { max_images: 2 },
          });

          // Completion is committed before verification; drain the active execution first.
          await generationService.close();
          const refreshedCatalog = await providerService.catalog(actor);
          expect(
            refreshedCatalog.items.find((i) => i.modelId === 's-chat-custom-2048')?.adaptation
              ?.verification.status,
          ).toBe('verified');
          expect(
            refreshedCatalog.items.find((i) => i.modelId === 'WL-Next-Seedream-X')?.image.adaptation
              ?.verification.status,
          ).toBe('verified');
        } finally {
          server.close();
          await generationService.close();
          await convService.close();
          await engine.close();
          await convStore.close();
          await providerService.close();
          await store.close();
          await ctx.fiber.dispose();
          rmSync(generationDir, { recursive: true });
          await rm(dshRoot, { recursive: true, force: true });
        }
      }),
    45_000,
  );

  it('Scenario 5: upgrades provider adaptations and image schema without taking over legacy image jobs', async () => {
    const database = await authDatabase();
    const pool = new Pool({ connectionString: database.url });
    try {
      await pool.query(providerSchemaSQL);
      // Simulate pre-existing legacy adaptations/policies tables, adaptation_origin, and classification* columns
      await pool.query(`
        ${legacyProviderAdaptationTablesSQL}
        ALTER TABLE mio_provider_model_verifications ADD COLUMN adaptation_origin text DEFAULT 'owner';
        ALTER TABLE mio_provider_models
          ADD COLUMN classification text,
          ADD COLUMN classification_source text;
      `);

      const providerId = randomUUID();
      const ownerId = 'legacy-owner-1';
      await pool.query(
        `INSERT INTO mio_provider_configs(id,owner_id,revision,credential_version,catalog_version,catalog_credential_version,catalog_succeeded_at,credential_auth_state,cipher_format,master_key_id,nonce,ciphertext,auth_tag)
           VALUES($1,$2,1,1,1,1,now(),'valid',1,'legacy',$3,$4,$5)`,
        [providerId, ownerId, randomBytes(12), randomBytes(32), randomBytes(16)],
      );
      const chatModelKey = randomUUID();
      const unmappedImageKey = randomUUID();
      await pool.query(
        `INSERT INTO mio_provider_models(provider_id,model_key,raw_model_id,classification,classification_source,credential_version,catalog_version,first_seen_at,last_seen_at,membership_state)
           VALUES
           ($1,$2,'deepseek-v4.1-flash','chat','manual',1,1,now(),now(),'current'),
           ($1,$3,'image-kling-v2-1','image','manual',1,1,now(),now(),'current')`,
        [providerId, chatModelKey, unmappedImageKey],
      );
      await pool.query(
        `INSERT INTO mio_provider_model_routes(
           provider_type,raw_model_id,operation,vendor,driver,classification,submit_path,source_kind,source,source_version,declaration_version,enabled
         ) VALUES('onelink','deepseek-v4.1-flash','chat','deepseek','openai-chat','chat','/v1/chat/completions','runtime-observation','e3','v1',1,true)`,
      );
      await pool.query(
        `INSERT INTO mio_provider_model_adaptations(provider_id,model_key,operation,profile,declaration_version,verification_status,verified_at,verification_evidence,tested_tuple)
           VALUES
           ($1::uuid,$2::uuid,'chat','openai-chat',1,'verified',now(),'legacy-chat-0','{"adaptationOrigin":"owner","modelId":"deepseek-v4.1-flash"}'::jsonb),
           ($1::uuid,$3::uuid,'image.generate','kling-image-v1',1,'verified',now(),'legacy-img-0','{"modelId":"image-kling-v2-1"}'::jsonb)`,
        [providerId, chatModelKey, unmappedImageKey],
      );
      await pool.query(
        `INSERT INTO mio_provider_model_policies(provider_type,raw_model_id,user_visible,allow_undiscovered,display_label,call_notes,updated_by)
           VALUES('onelink','legacy-hidden-policy',false,true,'Legacy Hidden','Keep note','ops')`,
      );

      await pool.query(assetSchemaSQL);
      await pool.query(generationSchemaSQL);
      await pool.query(`CREATE TABLE mio_image_outbox (
        job_id uuid PRIMARY KEY REFERENCES mio_image_jobs(id), sent_at timestamptz
      )`);
      await pool.query('ALTER TABLE mio_image_jobs DROP COLUMN route_snapshot');

      const klingRoute = findFixtureImageRouteConfig('image-kling-v3');
      const jobId = randomUUID();
      const commandBase = {
        version: 1 as const,
        type: 'image.request' as const,
        messageId: randomUUID(),
        jobId,
        ownerId,
        expiresAt: Date.now() + 120_000,
        profile: 'kling-images' as const,
        route: klingRoute,
        input: { model: 'image-kling-v3', prompt: 'missing snapshot test', async: true },
      };
      const cmd = {
        ...commandBase,
        credential: {
          version: 1,
          keyId: 'legacy',
          wrappedKey: 'retained-encrypted-key',
          nonce: 'retained-nonce',
          ciphertext: 'retained-ciphertext',
          tag: 'retained-tag',
        },
      };
      await pool.query(
        `INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,admitted,state,query_attempt,async_max_queries,async_deadline)
           VALUES($1,$2,$3,'legacy-hash',$4::jsonb,'{}'::jsonb,'processing',0,6,now() + interval '5 minutes')`,
        [jobId, ownerId, randomUUID(), JSON.stringify(cmd)],
      );
      await pool.query(`INSERT INTO mio_image_outbox(job_id,sent_at) VALUES($1,now())`, [jobId]);

      const unsentLegacyJobId = randomUUID();
      const unsentLegacyCmd = {
        version: 1,
        type: 'image.request',
        messageId: randomUUID(),
        jobId: unsentLegacyJobId,
        ownerId,
        expiresAt: Date.now() + 120_000,
        profile: 'kling-image-v1',
        input: { model: 'image-kling-v2-1', prompt: 'legacy unsent request' },
        credential: { keyId: 'k1', encryptedKey: 'enc', iv: 'iv', ciphertext: 'ct', tag: 'tag' },
      };
      await pool.query(
        `INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,admitted,state)
           VALUES($1,$2,$3,'legacy-unsent-hash',$4::jsonb,'{}'::jsonb,'accepted')`,
        [unsentLegacyJobId, ownerId, randomUUID(), JSON.stringify(unsentLegacyCmd)],
      );
      await pool.query(`INSERT INTO mio_image_outbox(job_id,sent_at) VALUES($1,NULL)`, [
        unsentLegacyJobId,
      ]);

      // Run incremental schema migrations on top of legacy state
      await pool.query(providerSchemaSQL);
      await pool.query(generationSchemaSQL);
      await expect(checkProviderSchema(pool)).resolves.toBeUndefined();
      await expect(checkGenerationSchema(pool)).resolves.toBeUndefined();

      // Backfills matching chat verified row & legacy policy row, then drops retired tables & dead columns
      expect(
        (await pool.query("SELECT to_regclass('mio_provider_model_adaptations') AS name")).rows[0]
          .name,
      ).toBeNull();
      expect(
        (await pool.query("SELECT to_regclass('mio_provider_model_policies') AS name")).rows[0]
          .name,
      ).toBeNull();
      expect(
        (
          await pool.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'mio_provider_models'
               AND column_name IN ('classification', 'classification_source')`,
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await pool.query(
            `SELECT raw_model_id, display_label, user_visible, allow_undiscovered, call_notes, origin_source
             FROM mio_provider_catalog_models WHERE raw_model_id='legacy-hidden-policy'`,
          )
        ).rows,
      ).toEqual([
        {
          raw_model_id: 'legacy-hidden-policy',
          display_label: 'Legacy Hidden',
          user_visible: false,
          allow_undiscovered: true,
          call_notes: 'Keep note',
          origin_source: 'admin-manual',
        },
      ]);
      const backfilled = (
        await pool.query(
          'SELECT driver, verification_status, tested_tuple FROM mio_provider_model_verifications WHERE provider_id=$1',
          [providerId],
        )
      ).rows;
      expect(backfilled).toEqual([
        {
          driver: 'openai-chat',
          verification_status: 'verified',
          tested_tuple: { modelId: 'deepseek-v4.1-flash' },
        },
      ]);

      // These rows predate A executions. A must preserve their state, encrypted
      // command and outbox for operator reconciliation, with no new provider call.
      const legacyCommands = await pool.query(
        'SELECT id,state,command FROM mio_image_jobs ORDER BY id',
      );
      const generationStore = new GenerationStore(new Pool({ connectionString: database.url }));
      try {
        await generationStore.startExecutor(() => {});
        expect(await generationStore.claim()).toBeUndefined();
        expect((await generationStore.imageGet(ownerId, unsentLegacyJobId)).status).toBe(
          'accepted',
        );
        expect((await generationStore.imageGet(ownerId, jobId)).status).toBe('processing');
        expect(
          (await pool.query('SELECT id,state,command FROM mio_image_jobs ORDER BY id')).rows,
        ).toEqual(legacyCommands.rows);
        expect(
          (await pool.query('SELECT count(*)::int AS count FROM mio_image_executions')).rows[0]
            .count,
        ).toBe(0);
        expect(
          (
            await pool.query('SELECT sent_at FROM mio_image_outbox WHERE job_id=$1', [
              unsentLegacyJobId,
            ])
          ).rows[0].sent_at,
        ).toBeNull();
      } finally {
        await generationStore.close();
      }
    } finally {
      await pool.end();
      await database.close();
    }
  }, 45_000);

  it(
    'admits explicit DB routes across openai-images (minimal generate-only) and volcengine-ark-images (references, omitted defaultSize) end-to-end through GenerationService',
    async () =>
      withProviderDb(async ({ pool, config, databaseURL }) => {
        await pool.query(assetSchemaSQL);
        await pool.query(generationSchemaSQL);

        const generationDir = mkdtempSync(join(tmpdir(), 'mio-routed-multi-'));
        const store = await createProviderStore(config);
        const providerService = createProviderService(store, config, async () =>
          Response.json({
            data: [{ id: 'custom-gpt-sync' }, { id: 'custom-volc-ref' }],
          }),
        );
        const objects = new Map<string, { size: number; etag: string; sha256: string }>();
        const outboundBodies: Record<string, unknown>[] = [];
        const imageTransport: typeof fetch = async (url, init) => {
          outboundBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          const bytes = String(url).includes('/v1/images/generations') ? PNG_BYTES : JPEG_BYTES;
          return Response.json({
            data: [{ b64_json: Buffer.from(bytes).toString('base64') }],
          });
        };
        let generationService: Awaited<ReturnType<typeof createGenerationService>> | undefined;
        const generationStore = await createGenerationStore(databaseURL);

        try {
          const actor: ProviderPrincipal = { userId: 'owner-routed-1', sessionId: 'sess-routed-1' };
          const refAssetId = randomUUID();
          const refKey = `mio/raw/${refAssetId}/${randomUUID()}`;
          objects.set(refKey, {
            size: JPEG_BYTES.byteLength,
            etag: '"etag-ref-1"',
            sha256: createHash('sha256').update(JPEG_BYTES).digest('hex'),
          });
          await pool.query(
            `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at)
           VALUES($1,$2,'ref.jpg','image/jpeg',$3,$4,$5,'ready',now() + interval '1 hour')`,
            [refAssetId, actor.userId, JPEG_BYTES.byteLength, `mio/staging/${refAssetId}`, refKey],
          );

          const gptFixture = findFixtureRoute('gpt-image-2', 'image.generate');
          const volcFixture = findFixtureRoute('doubao-seedream-4.5', 'image.generate');
          await store.importRoutes([
            {
              ...gptFixture,
              rawModelId: 'custom-gpt-sync',
              editPath: null,
              paramSpec: {
                ...gptFixture.paramSpec!,
                supportedOperations: ['generate'],
                maxReferenceImages: 0,
                allowMaskPng: false,
              },
            },
            {
              ...volcFixture,
              rawModelId: 'custom-volc-ref',
              requestDefaults: {
                watermark: false,
                sequentialImageGeneration: 'disabled',
                responseFormat: 'b64_json',
                stream: false,
              },
            },
          ]);

          generationService = await createGenerationService(
            generationStore,
            generationObjects(objects),
            { dataDirectory: generationDir },
            () => providerService,
            { transport: imageTransport },
          );

          await providerService.save(actor, 0, 'sk-owner-routed-key');
          await providerService.discover(actor);
          const catalog = await providerService.catalog(actor);
          const gptItem = catalog.items.find((i) => i.modelId === 'custom-gpt-sync')!;
          const volcItem = catalog.items.find((i) => i.modelId === 'custom-volc-ref')!;

          const resolvedGpt = await providerService.snapshotImage(actor, gptItem.modelRef);
          expect(validateImageRouteConfig(resolvedGpt.route)).toBe(true);
          expect(resolvedGpt.route.paramSpec.async).toBeNull();
          expect(resolvedGpt.route.paramSpec.supportedOperations).toEqual(['generate']);

          const resolvedVolc = await providerService.snapshotImage(actor, volcItem.modelRef);
          expect(validateImageRouteConfig(resolvedVolc.route)).toBe(true);
          expect(resolvedVolc.route.paramSpec.allowGenerateReferences).toBe(true);
          expect(resolvedVolc.route.requestDefaults.defaultSize).toBeUndefined();

          let httpOrigin = '';
          const server = createServer(
            (req, res) =>
              void createGenerationHandler(
                generationService!,
                async () => ({ userId: actor.userId, sessionId: actor.sessionId }),
                [httpOrigin],
              )(req, res),
          );
          server.listen(0, '127.0.0.1');
          await once(server, 'listening');
          const port = (server.address() as { port: number }).port;
          httpOrigin = `http://127.0.0.1:${port}`;

          try {
            for (const reqBody of [
              {
                requestId: randomUUID(),
                modelRef: gptItem.modelRef,
                parameters: { prompt: 'minimal gpt sync' },
              },
              {
                requestId: randomUUID(),
                modelRef: volcItem.modelRef,
                parameters: {
                  operation: 'generate',
                  prompt: 'volc with reference and no default size',
                  imageAssetIds: [refAssetId],
                },
              },
            ]) {
              const postRes = await fetch(`${httpOrigin}/api/v1/compute/images`, {
                method: 'POST',
                headers: { origin: httpOrigin, 'content-type': 'application/json' },
                body: JSON.stringify(reqBody),
              });
              expect(postRes.status, await postRes.clone().text()).toBe(202);
              const { jobId } = (await postRes.json()) as { jobId: string };
              // The A executor runs after admission and commits owner-scoped assets.
              await vi.waitFor(
                async () => {
                  const getRes = await fetch(`${httpOrigin}/api/v1/compute/images/${jobId}`, {
                    headers: { origin: httpOrigin },
                  });
                  const view = (await getRes.json()) as { status: string; assetIds: string[] };
                  expect(view.status).toBe('completed');
                  expect(view.assetIds).toHaveLength(1);
                },
                { timeout: 5_000 },
              );
            }
            expect(outboundBodies[0]).toMatchObject({
              model: 'custom-gpt-sync',
              prompt: 'minimal gpt sync',
            });
            expect(outboundBodies[1]).toMatchObject({
              model: 'custom-volc-ref',
              prompt: 'volc with reference and no default size',
            });
            expect('size' in (outboundBodies[1] ?? {})).toBe(false);
            expect(typeof outboundBodies[1]?.image).toBe('string');
          } finally {
            server.close();
          }
        } finally {
          if (generationService) await generationService.close();
          else await generationStore.close();
          await providerService.close();
          await store.close();
          rmSync(generationDir, { recursive: true });
        }
      }),
    45_000,
  );
});
