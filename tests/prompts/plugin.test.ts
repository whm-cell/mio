import { randomBytes } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import { Pool } from 'pg';
import { expect, it, onTestFinished, vi } from 'vitest';
import * as Mio from '../../src/plugin.ts';
import * as Auth from '../../src/auth/service.ts';
import * as Deletion from '../../src/account-deletion/runtime.ts';
import * as Providers from '../../src/providers/service.ts';
import { ProviderStore } from '../../src/providers/store.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import * as Prompts from '../../src/prompts/runner.ts';
import { authDatabase } from '../support/auth-database.ts';
import { execution, system, validOutput } from './fixture.ts';
import { protocolResponse } from '../onelink/fixture.ts';

async function pluginFixture() {
  if (!process.env.MIO_TEST_DATABASE_URL)
    throw new Error('PROMPT_TEST_REQUIRES_ISOLATED_REGRESSION_DATABASE');
  const database = await authDatabase();
  onTestFinished(() => database.close());
  const pool = new Pool({ connectionString: database.url });
  try {
    await pool.query(providerSchemaSQL);
  } finally {
    await pool.end();
  }
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(NativeExecutor);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  const token = randomBytes(40).toString('hex');
  for (const [key, value] of Object.entries({
    MIO_API_TOKEN: token,
    MIO_AUTH_BASE_URL: ctx.webServer.getOrigin(),
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_AUTH_SECRET: token,
    MIO_AUTH_RATE_LIMIT_BACKEND: 'database',
    MIO_AUTH_ALLOWED_ORIGINS: '[]',
    MIO_PROVIDERS_DATABASE_URL: database.url,
    MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
    MIO_PROVIDERS_MASTER_KEY_ID: 'prompt-lifecycle',
  }))
    vi.stubEnv(key, value);
  for (const key of [
    'MIO_CONVERSATIONS_DATABASE_URL',
    'MIO_ASSETS_DATABASE_URL',
    'MIO_MATERIALS_ENABLED',
    'MIO_COMPUTE_ENABLED',
    'MIO_GENERATIONS_ENABLED',
    'MIO_VIDEO_GENERATIONS_ENABLED',
    'MIO_ADMIN_ENABLED',
    'MIO_AUTH_SMS_ENABLED',
    'MIO_AUTH_WECHAT_ENABLED',
    'MIO_NOTIFICATIONS_DATABASE_URL',
    'MIO_COS_BUCKET',
    'MIO_COS_REGION',
    'MIO_COS_SECRET_ID',
    'MIO_COS_SECRET_KEY',
    'MIO_COS_SESSION_TOKEN',
  ])
    vi.stubEnv(key, undefined);
  vi.spyOn(Auth, 'createAuthentication').mockResolvedValue({
    identity: async () => null,
    setDeletionDomains: () => {},
    close: async () => {},
  } as unknown as Awaited<ReturnType<typeof Auth.createAuthentication>>);
  vi.spyOn(Deletion, 'createAccountDeletionRuntime').mockResolvedValue({
    domains: [],
    close: async () => {},
  } as unknown as Awaited<ReturnType<typeof Deletion.createAccountDeletionRuntime>>);
  const providerFactory = Providers.createProviderService;
  const verificationEntered = Promise.withResolvers<void>();
  const resumeVerification = Promise.withResolvers<void>();
  let provider: Providers.ProviderService | undefined;
  vi.spyOn(Providers, 'createProviderService').mockImplementation((...args) => {
    provider = providerFactory(...args);
    vi.spyOn(provider, 'recordVerification').mockImplementation(async () => {
      verificationEntered.resolve();
      await resumeVerification.promise;
    });
    vi.spyOn(provider, 'close');
    return provider;
  });
  const poolClose = vi.spyOn(ProviderStore.prototype, 'close');
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    protocolResponse(new Request(input, init), validOutput),
  );
  vi.stubGlobal('fetch', transport);
  return {
    ctx,
    token,
    provider: () => provider!,
    poolClose,
    transport,
    verificationEntered,
    resumeVerification,
    async close() {
      resumeVerification.resolve();
      await ctx.fiber.dispose();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    },
  };
}

it('provides the internal runtime and drains observation and verification before provider/pool close under concurrent Cordis effects', async () => {
  const f = await pluginFixture();
  const observationEntered = Promise.withResolvers<void>();
  const resumeObservation = Promise.withResolvers<void>();
  const consumerClosing = Promise.withResolvers<void>();
  const resumeConsumer = Promise.withResolvers<void>();
  let pending: Promise<unknown> | undefined;
  let disposing: Promise<unknown> | undefined;
  try {
    const plugin = await f.ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
    const runtime = f.ctx.mioPromptRuntime;
    expect(runtime).toBeDefined();
    const request = {
      ...execution('openai-chat'),
      input: { system, prompt: 'text' },
      observe: async () => {
        observationEntered.resolve();
        await resumeObservation.promise;
      },
    };
    await f.ctx.plugin({
      name: 'prompt-consumer-fixture',
      inject: ['mioPromptRuntime'],
      apply(consumer: Context) {
        consumer.effect(() => async () => {
          consumerClosing.resolve();
          await resumeConsumer.promise;
        });
      },
    });
    pending = runtime.executeTextPrompt(request);
    await observationEntered.promise;
    disposing = plugin.dispose();
    await consumerClosing.promise;
    expect(() => runtime.executeTextPrompt(request)).toThrow(
      expect.objectContaining({ status: 503 }),
    );
    expect(f.provider().close).not.toHaveBeenCalled();
    expect(f.poolClose).not.toHaveBeenCalled();
    resumeObservation.resolve();
    await f.verificationEntered.promise;
    expect(f.provider().recordVerification).toHaveBeenCalledExactlyOnceWith(
      { userId: request.ownerId },
      request.snapshot,
      request.evidence,
    );
    expect(f.provider().close).not.toHaveBeenCalled();
    expect(f.poolClose).not.toHaveBeenCalled();
    f.resumeVerification.resolve();
    resumeConsumer.resolve();
    expect(await pending).toMatchObject({ status: 'succeeded' });
    await disposing;
    expect(f.provider().close).toHaveBeenCalledOnce();
    expect(f.poolClose).toHaveBeenCalledOnce();
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.ctx.get('mioPromptRuntime')).toBeUndefined();
  } finally {
    resumeObservation.resolve();
    resumeConsumer.resolve();
    f.resumeVerification.resolve();
    await Promise.allSettled([pending, disposing]);
    await f.close();
  }
});

it('joins an admitted startup call before cleaning the provider pool when registration fails', async () => {
  const f = await pluginFixture();
  const observationEntered = Promise.withResolvers<void>();
  const resumeObservation = Promise.withResolvers<void>();
  const factory = Prompts.createPromptRuntime;
  let runtime: Prompts.PromptRuntime | undefined;
  let pending: Promise<unknown> | undefined;
  let startup: Promise<unknown> | undefined;
  const failure = new Error('PROMPT_REGISTRATION_FIXTURE');
  try {
    vi.spyOn(Prompts, 'createPromptRuntime').mockImplementation((...args) => {
      runtime = factory(...args);
      pending = runtime.executeTextPrompt({
        ...execution('anthropic-messages'),
        input: { system, prompt: 'text' },
        observe: async () => {
          observationEntered.resolve();
          await resumeObservation.promise;
        },
      });
      return runtime;
    });
    const register = f.ctx.webServer.register.bind(f.ctx.webServer);
    vi.spyOn(f.ctx.webServer, 'register').mockImplementation((route) => {
      if (route.path === '/api/v1/providers/onelink') throw failure;
      return register(route);
    });
    startup = f.ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] }).await();
    const outcome = startup.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await Promise.race([
      observationEntered.promise,
      outcome.then(() => {
        throw new Error('Startup finished before the admitted call reached observation');
      }),
    ]);
    expect(() =>
      runtime!.executeTextPrompt({
        ...execution('anthropic-messages'),
        input: { system, prompt: 'new' },
      }),
    ).toThrow(expect.objectContaining({ status: 503 }));
    expect(f.provider().close).not.toHaveBeenCalled();
    expect(f.poolClose).not.toHaveBeenCalled();
    resumeObservation.resolve();
    await f.verificationEntered.promise;
    expect(f.provider().close).not.toHaveBeenCalled();
    expect(f.poolClose).not.toHaveBeenCalled();
    f.resumeVerification.resolve();
    await pending;
    expect(await outcome).toEqual({ ok: false, error: failure });
    expect(f.provider().close).toHaveBeenCalledOnce();
    expect(f.poolClose).toHaveBeenCalledOnce();
  } finally {
    resumeObservation.resolve();
    f.resumeVerification.resolve();
    await Promise.allSettled([pending, startup]);
    await f.close();
  }
});
