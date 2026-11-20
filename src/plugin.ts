import { monotonicMs } from '@mio/foundation/time';
import { createId } from '@mio/foundation/identifiers';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-system-prompt';
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
import type { ConversationImageTools } from './conversations/contracts.ts';
import { createConversationHandler } from './conversations/http.ts';
import { createDshConversationEngine } from './dsh/conversations.ts';
import { createConversationVision } from './dsh/vision.ts';
import * as imageOffload from '@deepseek-ai/dsh-compaction-image-offload';
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
import { readMaterialConfig } from './materials/config.ts';
import { createMaterialStore } from './materials/store.ts';
import { createMaterialService } from './materials/service.ts';
import type { MaterialService } from './materials/service.ts';
import { createMaterialHandler } from './materials/http.ts';
import { createMaterialUpstream } from './integrations/onelink/materials.ts';
import { readGenerationConfig } from './generations/config.ts';
import { createGenerationStore } from './generations/store.ts';
import { createGenerationService } from './generations/service.ts';
import type { GenerationService } from './generations/service.ts';
import { createGenerationHandler } from './generations/http.ts';

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

/** Mount foundation and configured account routes. No global model-facing tool is authorized. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Deny before awaiting optional dependencies, including when authentication startup fails.
  denyModelTools(ctx);
  const authConfig = readAuthConfig();
  const providerConfig = readProviderConfig();
  const materialConfig = readMaterialConfig();
  // A materials-only installation shares the media URL but does not opt into COS/assets.
  // Any partial COS configuration still reaches the existing strict asset validation.
  const materialDatabaseOnly =
    materialConfig &&
    process.env.MIO_COMPUTE_ENABLED === undefined &&
    process.env.MIO_GENERATIONS_ENABLED === undefined &&
    [
      'MIO_COS_BUCKET',
      'MIO_COS_REGION',
      'MIO_COS_SECRET_ID',
      'MIO_COS_SECRET_KEY',
      'MIO_COS_SESSION_TOKEN',
    ].every((key) => process.env[key] === undefined);
  const assetConfig = readAssetConfig(
    materialDatabaseOnly ? { ...process.env, MIO_ASSETS_DATABASE_URL: undefined } : process.env,
  );
  const computeConfig = readComputeConfig();
  const conversationConfig = readConversationConfig(process.env, Boolean(providerConfig));
  const generationConfig = readGenerationConfig();
  const imageEnabled = Boolean(generationConfig);
  if (materialConfig && (!authConfig || !providerConfig))
    throw new Error('MATERIAL_CONFIG: authentication and providers required');
  if (generationConfig && (!authConfig || !assetConfig || !providerConfig))
    throw new Error('GENERATION_CONFIG: authentication, assets and providers are required');
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
    let conversations: ConversationService | undefined;
    let generations: GenerationService | undefined;
    let materials: MaterialService | undefined;
    let assets: ReturnType<typeof createAssetService> | undefined;
    let vision: ReturnType<typeof createConversationVision> | undefined;
    if (assetConfig) {
      const store = await createAssetStore(assetConfig.databaseURL);
      try {
        const acquired = (assets = createAssetService(store, createCosStorage(assetConfig)));
        vision = createConversationVision((owner, id, expected, signal) =>
          acquired.readVisionSource(owner, id, expected, signal),
        );
        ctx.effect(() => async () => {
          const failures: unknown[] = [];
          try {
            await conversations?.close();
          } catch (error) {
            failures.push(error);
          }
          try {
            await materials?.close();
          } catch (error) {
            failures.push(error);
          }
          try {
            await acquired.close();
          } catch (error) {
            failures.push(error);
          }
          if (failures.length) throw new AggregateError(failures, 'Mio resource cleanup failed');
        });
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
    let providers: ProviderService | undefined;
    if (computeConfig && assetConfig) {
      const store = await createComputeStore(assetConfig.databaseURL);
      let ownedCompute: ReturnType<typeof createComputeService> | undefined;
      try {
        const acquired = (ownedCompute = createComputeService(
          store,
          createCosStorage(assetConfig),
          computeConfig,
        ));
        ctx.effect(() => async () => {
          // Parent/child effects may unload concurrently: drain conversations before closing compute.
          const failures: unknown[] = [];
          try {
            await conversations?.close();
          } catch (error) {
            failures.push(error);
          }
          try {
            await acquired.close();
          } catch (error) {
            failures.push(error);
          }
          if (failures.length) throw new AggregateError(failures, 'Mio resource cleanup failed');
        });
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/compute',
            handler: createComputeHandler(acquired, auth.identity, authConfig.origins),
          }),
        );
      } catch (error) {
        await (ownedCompute ? ownedCompute.close() : store.close());
        throw error;
      }
    }
    if (providerConfig) {
      const store = await createProviderStore(providerConfig, imageEnabled);
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
            await generations?.close();
          } catch (error) {
            failures.push(error);
          }
          try {
            await materials?.close();
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
    if (materialConfig && providers) {
      const store = await createMaterialStore(materialConfig.databaseURL);
      let acquired: MaterialService | undefined;
      try {
        materials = acquired = createMaterialService(
          store,
          providers,
          createMaterialUpstream(),
          assets,
        );
        const owned = acquired;
        ctx.effect(() => async () => {
          await owned.close();
        });
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/materials',
            handler: createMaterialHandler(owned, auth.identity, authConfig.origins),
          }),
        );
      } catch (error) {
        await (acquired ? acquired.close() : store.close());
        throw error;
      }
    }
    if (generationConfig && assetConfig) {
      const store = await createGenerationStore(assetConfig.databaseURL);
      let ownedGenerations: GenerationService | undefined;
      try {
        const acquired =
          (generations =
          ownedGenerations =
            await createGenerationService(
              store,
              createCosStorage(assetConfig),
              generationConfig,
              () => providers,
            ));
        ctx.effect(() => async () => {
          const failures: unknown[] = [];
          try {
            await conversations?.close();
          } catch (error) {
            failures.push(error);
          }
          try {
            await acquired.close();
          } catch (error) {
            failures.push(error);
          }
          if (failures.length) throw new AggregateError(failures, 'Mio resource cleanup failed');
        });
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/compute/images',
            handler: createGenerationHandler(acquired, auth.identity, authConfig.origins),
          }),
        );
      } catch (error) {
        await (ownedGenerations ? ownedGenerations.close() : store.close());
        throw error;
      }
    }
    if (conversationConfig) {
      if (!ctx.get('mioKernel')) throw new Error('CONVERSATION_CONFIG: DSH kernel required');
      await ctx.plugin({
        name: 'mio-conversations',
        inject: ['mioKernel', 'llm', 'webServer', 'agents', 'sessions', 'systemPrompt'],
        async apply(conversationCtx: Context) {
          let acquired: ConversationService | undefined;
          let http: ReturnType<typeof createConversationHandler> | undefined;
          // Keep the plugin on the parent's retained service scope. A child with its
          // own required injections may otherwise unload when those services begin
          // shutting down, before the parent has drained history and active turns.
          const offload = conversationCtx.plugin({
            name: imageOffload.name,
            apply: imageOffload.apply,
          });
          // Cordis unloads sibling effects concurrently. Collect the plugin disposer and
          // conversation drain in one effect so the projection outlives every agent.
          conversationCtx.effect(function* () {
            yield offload.dispose;
            yield async () => {
              const failures: unknown[] = [];
              try {
                http?.close();
              } catch (error) {
                failures.push(error);
              }
              try {
                await acquired?.close();
              } catch (error) {
                failures.push(error);
              }
              if (failures.length) {
                try {
                  await offload.dispose();
                } catch (error) {
                  failures.push(error);
                }
                throw new AggregateError(failures, 'Conversation cleanup failed');
              }
            };
          });
          await offload;
          const store = await createConversationStore(conversationConfig.databaseURL);
          try {
            const imageTools: ConversationImageTools | undefined =
              imageEnabled && generations && providers
                ? {
                    listModels: (actor) => providers.listImageModels(actor),
                    createImage: (actor, requestId, modelRef, parameters, signal) =>
                      generations.createImage(actor, requestId, modelRef, parameters, { signal }),
                    getImage: (actor, jobId) => generations.getImage(actor, jobId),
                  }
                : undefined;
            const ownedConversations =
              (conversations =
              acquired =
                createConversationService(
                  store,
                  createDshConversationEngine(
                    conversationCtx,
                    conversationConfig,
                    imageTools,
                    vision,
                  ),
                  providers,
                  vision,
                ));
            const ownedHttp = (http = createConversationHandler(
              ownedConversations,
              auth.identity,
              authConfig.origins,
            ));
            conversationCtx.effect(() =>
              conversationCtx.webServer.register({
                kind: 'prefix',
                path: '/api/v1/conversations',
                handler: ownedHttp.handler,
              }),
            );
          } catch (error) {
            const failures: unknown[] = [error];
            try {
              http?.close();
            } catch (failure) {
              failures.push(failure);
            }
            try {
              await (acquired ? acquired.close() : store.close());
            } catch (failure) {
              failures.push(failure);
            }
            if (failures.length === 1) throw error;
            throw new AggregateError(failures, 'Conversation startup cleanup failed');
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
