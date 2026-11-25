import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import * as Mio from '../../src/plugin.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { AssetStore } from '../../src/assets/store.ts';
import * as Auth from '../../src/auth/service.ts';
import type { Authentication } from '../../src/auth/service.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { ComputeStore } from '../../src/compute/transcode/store.ts';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';
import * as Engines from '../../src/dsh/conversations.ts';
import { GenerationStore } from '../../src/generations/image/store.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { videoRequestHash } from '../../src/generations/video/contracts.ts';
import type { VideoCreateRequest } from '../../src/generations/video/contracts.ts';
import * as Executor from '../../src/generations/video/executor.ts';
import { VideoExecutionStore } from '../../src/generations/video/execution-store.ts';
import * as Admission from '../../src/generations/video/service.ts';
import { VideoGenerationStore } from '../../src/generations/video/store.ts';
import * as Cos from '../../src/integrations/cos.ts';
import { ComputeBroker } from '../../src/integrations/rabbitmq.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { ProviderStore } from '../../src/providers/store.ts';
import { authDatabase } from '../support/auth-database.ts';
import { kernelRuntime, ScriptedModel } from '../support/kernel-runtime.ts';

it('stops video admission and executor together and drains both before disposing their dependencies', async () => {
  const database = await authDatabase();
  const observer = new Pool({ connectionString: database.observerURL });
  const directory = await mkdtemp(join(tmpdir(), 'mio-video-plugin-'));
  const ctx = await kernelRuntime(directory, new ScriptedModel([]));
  const actor = { userId: randomUUID(), sessionId: 'video-lifecycle-fixture' };
  const request: VideoCreateRequest = {
    requestId: randomUUID(),
    modelRef: `onelink:model:${randomUUID()}`,
    expectedCapabilitiesVersion: 'fixture',
    parameters: { mode: 'text_to_video', prompt: 'fixture' },
  };
  const claimed = Promise.withResolvers<string | undefined>();
  const readEntered = Promise.withResolvers<void>();
  const conversationClosing = Promise.withResolvers<void>();
  const admissionClosing = Promise.withResolvers<boolean>();
  const executorDrained = Promise.withResolvers<void>();
  const resumeClaim = Promise.withResolvers<void>();
  const resumeRead = Promise.withResolvers<void>();
  const resumeConversation = Promise.withResolvers<void>();
  const failure = new Error('synthetic executor close failure');
  const report = vi.spyOn(ctx.logger, 'error');
  const upstream = vi.fn<typeof fetch>().mockRejectedValue(new Error('unexpected video transport'));
  let admission: ReturnType<typeof Admission.createVideoGenerationService> | undefined;
  let disposing: Promise<unknown> | undefined;
  let pending: Promise<Response> | undefined;
  try {
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
    const origin = ctx.webServer.getOrigin();
    for (const [key, value] of Object.entries({
      MIO_API_TOKEN: randomBytes(32).toString('hex'),
      MIO_AUTH_DATABASE_URL: database.url,
      MIO_AUTH_BASE_URL: origin,
      MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
      MIO_AUTH_RATE_LIMIT_BACKEND: 'database',
      MIO_ASSETS_DATABASE_URL: database.url,
      MIO_COS_BUCKET: 'mio-fixture-1234567890',
      MIO_COS_REGION: 'ap-shanghai',
      MIO_COS_SECRET_ID: 'fixture',
      MIO_COS_SECRET_KEY: 'fixture',
      MIO_COMPUTE_ENABLED: 'true',
      RABBITMQ_URL: 'amqp://fixture-a:unused@127.0.0.1:1/unused',
      MIO_COMPUTE_BROKER_USER: 'fixture-a',
      MIO_COMPUTE_EXPECTED_RESULT_USER: 'fixture-b',
      MIO_CONVERSATIONS_DATABASE_URL: database.url,
      MIO_PROVIDERS_DATABASE_URL: database.url,
      MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
      MIO_PROVIDERS_MASTER_KEY_ID: 'video-lifecycle-fixture',
      MIO_GENERATIONS_ENABLED: 'true',
      MIO_VIDEO_GENERATIONS_ENABLED: 'true',
      MIO_GENERATIONS_DATA_DIR: directory,
    }))
      vi.stubEnv(key, value);
    for (const sql of [
      assetSchemaSQL,
      computeSchemaSQL,
      generationSchemaSQL,
      providerSchemaSQL,
      conversationSchemaSQL,
    ])
      await observer.query(sql);
    const store = new VideoGenerationStore(observer);
    const { jobId } = await store.create(
      actor.userId,
      request,
      videoRequestHash(request),
      { request, inputSnapshot: [] },
      {},
      {},
      {},
    );
    vi.spyOn(Auth, 'createAuthentication').mockResolvedValue({
      identity: async (headers: Headers) =>
        headers.get('cookie') === 'session=fixture' ? actor : null,
      close: async () => {},
    } as Authentication);
    vi.spyOn(Cos, 'createCosStorage').mockReturnValue({
      head: vi.fn().mockRejectedValue(new Error('unexpected COS HEAD')),
      putImage: vi.fn().mockRejectedValue(new Error('unexpected COS upload')),
      readMedia: vi.fn().mockRejectedValue(new Error('unexpected COS read')),
    } as unknown as ReturnType<typeof Cos.createCosStorage>);
    const broker = {
      close: vi.fn(async () => {}),
      consume: vi.fn(async () => {}),
      consumeMedia: vi.fn(async () => {}),
      onClose: vi.fn(),
    };
    vi.spyOn(ComputeBroker, 'connect')
      .mockResolvedValueOnce(broker as unknown as ComputeBroker)
      .mockResolvedValue({ ...broker, close: async () => {} } as unknown as ComputeBroker);
    const bottom = [
      vi.spyOn(GenerationStore.prototype, 'close'),
      vi.spyOn(AssetStore.prototype, 'close'),
      vi.spyOn(ComputeStore.prototype, 'close'),
      vi.spyOn(ProviderStore.prototype, 'close'),
      broker.close,
    ];
    const createEngine = Engines.createDshConversationEngine;
    vi.spyOn(Engines, 'createDshConversationEngine').mockImplementation((...args) => {
      const engine = createEngine(...args);
      return {
        ...engine,
        close: async () => {
          conversationClosing.resolve();
          await resumeConversation.promise;
          await engine.close();
        },
      };
    });
    const claim = VideoExecutionStore.prototype.claim;
    vi.spyOn(VideoExecutionStore.prototype, 'claim').mockImplementationOnce(async function (
      this: VideoExecutionStore,
      signal,
    ) {
      const row = await claim.call(this, signal);
      claimed.resolve(row?.id);
      await resumeClaim.promise;
      return row;
    });
    const get = VideoGenerationStore.prototype.get;
    vi.spyOn(VideoGenerationStore.prototype, 'get').mockImplementationOnce(async function (
      this: VideoGenerationStore,
      ...args
    ) {
      readEntered.resolve();
      await resumeRead.promise;
      return get.apply(this, args);
    });
    const startExecutor = Executor.createVideoExecutor;
    vi.spyOn(Executor, 'createVideoExecutor').mockImplementation(
      async (store, provider, materialize, transports, directory) => {
        const worker = await startExecutor(
          store,
          provider,
          materialize,
          { ...transports, transport: upstream },
          directory,
        );
        const close = worker.close.bind(worker);
        vi.spyOn(worker, 'close').mockImplementation(async () => {
          try {
            await close();
          } finally {
            executorDrained.resolve();
          }
          throw failure;
        });
        return worker;
      },
    );
    const createAdmission = Admission.createVideoGenerationService;
    vi.spyOn(Admission, 'createVideoGenerationService').mockImplementation((...args) => {
      const owned = (admission = createAdmission(...args));
      const close = owned.close.bind(owned);
      vi.spyOn(owned, 'close').mockImplementation(() => {
        const drained = close();
        queueMicrotask(() => admissionClosing.resolve(args[2]?.signal.aborted === true));
        return drained;
      });
      return owned;
    });

    const plugin = await ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
    expect(await claimed.promise).toBe(jobId);
    pending = fetch(`${origin}/api/v1/compute/videos/${jobId}`, {
      headers: { cookie: 'session=fixture' },
    });
    await Promise.race([
      readEntered.promise,
      pending.then(() => {
        throw new Error('GET replied without entering the video admission service');
      }),
    ]);
    disposing = plugin.dispose();
    expect(await admissionClosing.promise).toBe(true);
    await conversationClosing.promise;
    expect(() => admission!.create(actor, { ...request, requestId: randomUUID() })).toThrow(
      expect.objectContaining({ status: 503, code: 'VIDEO_UNAVAILABLE' }),
    );
    for (const close of bottom) expect(close).not.toHaveBeenCalled();
    resumeConversation.resolve();
    resumeClaim.resolve();
    await executorDrained.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const close of bottom) expect(close).not.toHaveBeenCalled();

    resumeRead.resolve();
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({ id: jobId, state: 'accepted', stage: 'ready' });
    await disposing;
    for (const close of bottom) expect(close).toHaveBeenCalledOnce();
    expect(upstream).not.toHaveBeenCalled();
    expect(
      (await observer.query('SELECT job_id,phase,claim_id FROM mio_video_executions')).rows,
    ).toEqual([{ job_id: jobId, phase: 'ready', claim_id: null }]);
    const includesFailure = (value: unknown): boolean =>
      value === failure || (value instanceof AggregateError && value.errors.some(includesFailure));
    expect(report.mock.calls.some(([error]) => includesFailure(error))).toBe(true);
  } finally {
    resumeConversation.resolve();
    resumeClaim.resolve();
    resumeRead.resolve();
    await Promise.allSettled([pending, disposing]);
    await ctx.fiber.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await observer.end();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
