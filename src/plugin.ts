import { monotonicMs } from '@mio/foundation/time';
import { createId } from '@mio/foundation/identifiers';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { createHandler } from './http.ts';
import { AUTH_BASE_PATH, readAuthConfig, readAuthRateLimitBackend } from './auth/config.ts';
import { createAuthentication } from './auth/service.ts';
import { createAuthHandler } from './auth/http.ts';
import { createRedisRateLimit } from './auth/rate-limit.ts';
import { createRedisResource, readRedisConfig } from './integrations/redis.ts';
import { denyModelTools } from './dsh/policy.ts';
import { readConversationConfig } from './conversations/config.ts';
import { createConversationStore } from './conversations/store.ts';
import { createConversationService } from './conversations/service.ts';
import type { ConversationService } from './conversations/service.ts';
import { createConversationHandler } from './conversations/http.ts';
import { createDshConversationEngine } from './dsh/conversations.ts';
import { readProviderConfig } from './providers/config.ts';
import { createProviderStore } from './providers/store.ts';
import { createProviderService } from './providers/service.ts';
import type { ProviderService } from './providers/service.ts';
import { createProviderHandler } from './providers/http.ts';
import { readAssetConfig } from './assets/config.ts';
import { createAssetStore } from './assets/store.ts';
import { createAssetService } from './assets/service.ts';
import { createAssetHandler } from './assets/http.ts';
import { createCosStorage } from './integrations/cos.ts';
import { readComputeConfig } from './compute/config.ts';
import { createComputeStore } from './compute/store.ts';
import { createComputeService } from './compute/service.ts';
import { createComputeHandler } from './compute/http.ts';

export const name = 'mio-foundation';
export const inject = ['webServer', 'tools'];

export interface Config {
  tokenEnv: string;
  allowedOrigins: string[];
}

export const Config = z.object({
  tokenEnv: z.string().default('MIO_API_TOKEN'),
  allowedOrigins: z.array(z.string()).default([]),
});

/** Mount foundation and configured account routes. No model-facing tool is authorized. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Deny before awaiting optional dependencies, including when authentication startup fails.
  denyModelTools(ctx);
  const authConfig = readAuthConfig();
  const providerConfig = readProviderConfig();
  const assetConfig = readAssetConfig();
  const computeConfig = readComputeConfig();
  const conversationConfig = readConversationConfig(process.env, Boolean(providerConfig));
  const handler = createHandler({
    token: process.env[config.tokenEnv] ?? '',
    allowedOrigins: config.allowedOrigins,
    instanceId: createId(),
    sessions: Boolean(conversationConfig),
  });

  if (conversationConfig && !authConfig)
    throw new Error('CONVERSATION_CONFIG: authentication required');
  if (providerConfig && !authConfig) throw new Error('PROVIDER_CONFIG: authentication required');
  if (assetConfig && !authConfig) throw new Error('ASSET_CONFIG: authentication required');
  if (computeConfig && (!authConfig || !assetConfig))
    throw new Error('COMPUTE_CONFIG: authentication and assets required');
  const backend = readAuthRateLimitBackend();
  if (backend === 'redis' && !authConfig)
    throw new Error('AUTH_CONFIG: authentication is required for Redis rate limiting');
  if (authConfig) {
    const redisConfig = backend === 'redis' ? readRedisConfig() : undefined;
    const deadline = monotonicMs() + 5000;
    const redis = redisConfig ? await createRedisResource(redisConfig, deadline) : undefined;
    let auth;
    try {
      const rateLimit =
        redis && (await createRedisRateLimit(redis, redisConfig!.namespace, deadline));
      auth = await createAuthentication(authConfig, rateLimit);
      const acquired = auth;
      ctx.effect(() => async () => {
        await Promise.all([acquired.close(), redis?.close()]);
      });
    } catch (error) {
      // The fiber may have been disposed while either dependency was connecting.
      await Promise.all([auth?.close(), redis?.close()]);
      throw error;
    }
    const authHandler = createAuthHandler(authConfig, auth);
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'prefix',
        path: AUTH_BASE_PATH,
        handler: authHandler,
      }),
    );
    if (assetConfig) {
      const store = await createAssetStore(assetConfig.databaseURL);
      let assets: ReturnType<typeof createAssetService> | undefined;
      try {
        const acquired = (assets = createAssetService(store, createCosStorage(assetConfig)));
        ctx.effect(() => async () => acquired.close());
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/assets',
            handler: createAssetHandler(acquired, auth.identity, authConfig.origins),
          }),
        );
      } catch (error) {
        await (assets ? assets.close() : store.close());
        throw error;
      }
    }
    if (computeConfig && assetConfig) {
      const store = await createComputeStore(assetConfig.databaseURL);
      let compute: ReturnType<typeof createComputeService> | undefined;
      try {
        const acquired = (compute = createComputeService(
          store,
          createCosStorage(assetConfig),
          computeConfig,
        ));
        ctx.effect(() => async () => acquired.close());
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/compute',
            handler: createComputeHandler(acquired, auth.identity, authConfig.origins),
          }),
        );
      } catch (error) {
        await (compute ? compute.close() : store.close());
        throw error;
      }
    }
    let providers: ProviderService | undefined;
    let conversations: ConversationService | undefined;
    if (providerConfig) {
      const store = await createProviderStore(providerConfig);
      providers = createProviderService(store, providerConfig);
      const ownedProviders = providers;
      try {
        ctx.effect(() => async () => {
          // Parent/child effects may unload concurrently: explicitly join admission and run teardown.
          const failures: unknown[] = [];
          try {
            await conversations?.close();
          } catch (error) {
            failures.push(error);
          }
          try {
            await ownedProviders.close();
          } catch (error) {
            failures.push(error);
          }
          if (failures.length) throw new AggregateError(failures, 'Mio resource cleanup failed');
        });
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/providers/onelink',
            handler: createProviderHandler(ownedProviders, auth.identity, authConfig.origins),
          }),
        );
      } catch (error) {
        await ownedProviders.close();
        throw error;
      }
    }
    if (conversationConfig) {
      if (!ctx.get('mioKernel')) throw new Error('CONVERSATION_CONFIG: DSH kernel required');
      await ctx.plugin({
        name: 'mio-conversations',
        inject: ['mioKernel', 'llm', 'webServer'],
        async apply(conversationCtx: Context) {
          const store = await createConversationStore(conversationConfig.databaseURL);
          let acquired: ConversationService | undefined;
          let http: ReturnType<typeof createConversationHandler> | undefined;
          try {
            const ownedConversations =
              (conversations =
              acquired =
                createConversationService(
                  store,
                  createDshConversationEngine(conversationCtx, conversationConfig),
                  providers,
                ));
            const ownedHttp = (http = createConversationHandler(
              ownedConversations,
              auth.identity,
              authConfig.origins,
            ));
            conversationCtx.effect(() => async () => {
              ownedHttp.close();
              await ownedConversations.close();
            });
            conversationCtx.effect(() =>
              conversationCtx.webServer.register({
                kind: 'prefix',
                path: '/api/v1/conversations',
                handler: ownedHttp.handler,
              }),
            );
          } catch (error) {
            http?.close();
            await (acquired ? acquired.close() : store.close());
            throw error;
          }
        },
      });
    }
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/v1/me',
        handler: authHandler,
      }),
    );
  }

  // Registered on this fiber, so the guard and routes are removed together on disposal.
  for (const path of ['/healthz', '/readyz']) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }));
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/v1', handler }));
}
