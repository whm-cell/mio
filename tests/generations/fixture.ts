import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import sharp from 'sharp';
import { vi } from 'vitest';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { GenerationStore } from '../../src/generations/image/store.ts';
import { GenerationFiles } from '../../src/generations/image/files.ts';
import { createGenerationAdmission } from '../../src/generations/image/admission.ts';
import { createGenerationService } from '../../src/generations/image/service.ts';
import type { GenerationService } from '../../src/generations/image/service.ts';
import type { GenerationObjects } from '../../src/generations/image/execution.ts';
import type { GenerationTransports } from '../../src/generations/image/runner.ts';
import type {
  ImageAssetRef,
  ImageRequestParameters,
} from '../../src/generations/image/contracts.ts';
import type { AsyncImageTransport } from '../../src/integrations/onelink/shared/index.ts';
import { authDatabase } from '../support/auth-database.ts';
import { findFixtureRoute } from '../providers/fixtures/onelink-routes-fixture.ts';

export async function generationFixture(asyncModel = 'image-vidu-q2') {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(generationSchemaSQL);
  await pool.query(generationSchemaSQL);
  await pool.query(providerSchemaSQL);
  const config = {
    databaseURL: database.url,
    masterKey: randomBytes(32),
    masterKeyId: 'generation-test',
  };
  const providerStore = await createProviderStore(config);
  await providerStore.importRoutes([
    findFixtureRoute('gpt-image-2', 'image.generate'),
    findFixtureRoute(asyncModel, 'image.generate'),
  ]);
  const provider = createProviderService(providerStore, config, async () =>
    Response.json({
      data: ['gpt-image-2', asyncModel].map((id) => ({ id, object: 'model' })),
    }),
  );
  const actor = { userId: randomUUID(), sessionId: 'generation-test' };
  await provider.save(actor, 0, 'initial-image-key');
  await provider.discover(actor);
  const catalog = (await provider.catalog(actor)).items;
  const modelRef = catalog.find((model) => model.modelId === 'gpt-image-2')!.modelRef;
  const asyncModelRef = catalog.find((model) => model.modelId === asyncModel)!.modelRef;
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 4, background: '#7799bb' } })
    .png()
    .toBuffer();
  const directory = await mkdtemp(join(tmpdir(), 'mio-generation-'));
  const files = new GenerationFiles(directory);
  await files.initialize();
  const stored = new Map<string, { bytes: Buffer; etag: string; sha256: string }>();
  let offline = false;
  const objects: GenerationObjects = {
    uploadUrl: () => 'https://fixture.invalid/upload',
    downloadUrl: () => 'https://fixture.invalid/download',
    copy: async () => {},
    delete: async () => {},
    head: vi.fn(async (key: string) => {
      const object = stored.get(key);
      if (!object) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return { size: object.bytes.length, etag: object.etag, sha256: object.sha256 };
    }),
    readImage: vi.fn(async (key: string, etag: string, size: number) => {
      const object = stored.get(key);
      if (!object || object.etag !== etag || object.bytes.length !== size)
        throw new Error('changed');
      return object.bytes;
    }),
    putImage: vi.fn(async (key, input, format, sha256) => {
      if (offline) throw new Error('COS unavailable');
      if (stored.has(key)) throw new Error('overwrite forbidden');
      const actual = Buffer.from(input);
      if (createHash('sha256').update(actual).digest('hex') !== sha256)
        throw new Error('digest mismatch');
      stored.set(key, { bytes: actual, etag: 'etag-' + stored.size, sha256 });
      return {
        key,
        sizeBytes: actual.length,
        sha256,
        etag: stored.get(key)!.etag,
        contentType: 'image/' + format,
      };
    }),
  };
  const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
    const input =
      options?.body instanceof FormData
        ? Object.fromEntries(options.body.entries())
        : JSON.parse(String(options?.body));
    if (input.prompt === 'unknown') throw new Error('connection lost after submission');
    return Response.json({
      data: Array.from({ length: Number(input.n ?? 1) }, () => ({
        b64_json: bytes.toString('base64'),
      })),
    });
  });
  const asyncTransport = {
    submit: vi.fn<AsyncImageTransport['submit']>().mockResolvedValue({
      state: 'submitted',
      upstreamTaskId: 'original-upstream-task',
    }),
    query: vi
      .fn<AsyncImageTransport['query']>()
      .mockImplementation(async (_input, _key, taskId) => ({
        state: 'returned',
        upstreamTaskId: taskId,
        images: [{ base64: bytes.toString('base64') }],
      })),
  };
  let store = new GenerationStore(new Pool({ connectionString: database.url }));
  let service: GenerationService | undefined;
  const start = async (transports: GenerationTransports = { transport, asyncTransport }) => {
    service = await createGenerationService(
      store,
      objects,
      { dataDirectory: directory },
      () => provider,
      transports,
    );
    return service;
  };
  const stop = async () => {
    if (service) {
      await service.close();
      service = undefined;
    } else await store.close();
    store = new GenerationStore(new Pool({ connectionString: database.url }));
  };
  return {
    database,
    pool,
    provider,
    actor,
    modelRef,
    asyncModelRef,
    bytes,
    directory,
    files,
    stored,
    objects,
    transport,
    asyncTransport,
    start,
    stop,
    get store() {
      return store;
    },
    get service() {
      return service!;
    },
    setOffline(value: boolean) {
      offline = value;
    },
    async addImageSource(input = bytes, contentType: ImageAssetRef['contentType'] = 'image/png') {
      const assetId = randomUUID();
      const key = `mio/raw/${assetId}/${randomUUID()}`;
      const etag = 'etag-' + assetId;
      await pool.query(
        `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,raw_key,state,expires_at)
         VALUES($1,$2,'source',$3,$4,$5,'ready',now())`,
        [assetId, actor.userId, contentType, input.length, key],
      );
      stored.set(key, {
        bytes: input,
        etag,
        sha256: createHash('sha256').update(input).digest('hex'),
      });
      return { assetId, key, etag, sizeBytes: input.length, contentType };
    },
    async admit(
      requestId = randomUUID(),
      prompt = 'fixture',
      parameters: Partial<ImageRequestParameters> = {},
      async = false,
    ) {
      return createGenerationAdmission(store, files, objects.head, () => provider)(
        actor,
        requestId,
        async ? asyncModelRef : modelRef,
        { prompt, ...parameters },
      );
    },
    async close() {
      if (service) await service.close();
      else await store.close();
      await provider.close();
      await pool.end();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
