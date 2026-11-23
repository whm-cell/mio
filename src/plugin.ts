import { HTTP_STATUS } from '@mio/foundation/http-status';
import { monotonicMs } from '@mio/foundation/time';
import { createId } from '@mio/foundation/identifiers';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { createHandler } from './http.ts';
import { AUTH_BASE_PATH, readAuthConfig, readAuthRateLimitBackend } from './auth/config.ts';
import type { AuthRuntimePolicy } from './auth/config.ts';
import { createAuthentication } from './auth/service.ts';
import { createAuthHandler } from './auth/http.ts';
import { createRedisRateLimit } from './auth/rate-limit.ts';
import {
  createRedisResource,
  probeRedisMetrics,
  readRedisConfig,
  readRedisMonitorConfig,
} from './integrations/redis.ts';
import {
  probeRabbitmqMetrics,
  readRabbitmqMonitorConfig,
} from './integrations/rabbitmq-monitor.ts';
import { denyModelTools } from './dsh/policy.ts';
import { readConversationConfig } from './conversations/config.ts';
import { createConversationStore } from './conversations/store.ts';
import { createConversationService } from './conversations/service.ts';
import type { ConversationService } from './conversations/service.ts';
import type { ConversationImageTools } from './conversations/contracts.ts';
import { createConversationHandler } from './conversations/http.ts';
import { createDshConversationEngine } from './dsh/conversations.ts';
import { applyConversationPolicies } from './dsh/conversation-checkpoints.ts';
import { installConversationTitles } from './dsh/conversation-titles.ts';
import { createConversationVision } from './dsh/vision.ts';
import * as imageOffload from '@deepseek-ai/dsh-compaction-image-offload';
import { readProviderConfig } from './providers/config.ts';
import { createProviderStore } from './providers/store.ts';
import { createProviderService } from './providers/service.ts';
import type { ProviderService } from './providers/service.ts';
import { createProviderHandler } from './providers/http.ts';
import { AssetError } from './assets/contracts.ts';
import { readAssetConfig } from './assets/config.ts';
import { createAssetStore } from './assets/store.ts';
import { createAssetService } from './assets/service.ts';
import { createAssetHandler } from './assets/http.ts';
import { createCosStorage } from './integrations/cos.ts';
import { readComputeConfig } from './compute/config.ts';
import { createComputeStore } from './compute/store.ts';
import { createComputeService } from './compute/service.ts';
import { createComputeHandler } from './compute/http.ts';
import { createMaterialAuthService } from './materials/auth-service.ts';
import { readMaterialConfig, readMaterialAuthConfig } from './materials/config.ts';
import { createMaterialStore } from './materials/store.ts';
import { createMaterialService } from './materials/service.ts';
import type { MaterialService } from './materials/service.ts';
import { createMaterialHandler } from './materials/http.ts';
import {
  createMaterialUpstream,
  createMaterialAuthUpstream,
} from './integrations/onelink/materials.ts';
import { readGenerationConfig } from './generations/config.ts';
import { createGenerationStore } from './generations/store.ts';
import { createGenerationService } from './generations/service.ts';
import type { GenerationService } from './generations/service.ts';
import { createGenerationHandler } from './generations/http.ts';
import { readAdminConfig } from './admin/config.ts';
import { createAdminStore } from './admin/store.ts';
import { createAdminService } from './admin/service.ts';
import type { AdminService } from './admin/service.ts';
import { createAdminHandler } from './admin/http.ts';

export const name = 'mio-foundation';
export const inject = ['webServer', 'tools'];

const AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface Config {
  tokenEnv: string;
  allowedOrigins: string[];
}

export const Config = z.object({
  tokenEnv: z.string().default('MIO_API_TOKEN'),
  allowedOrigins: z.array(z.string()).default([]),
});

async function closeMioResources(...steps: Array<() => Promise<void> | undefined>): Promise<void> {
  const failures: unknown[] = [];
  for (const close of steps) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Mio resource cleanup failed');
}

/** Mount foundation and configured account routes. No global model-facing tool is authorized. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Deny before awaiting optional dependencies, including when authentication startup fails.
  denyModelTools(ctx);
  const authConfig = readAuthConfig();
  const providerConfig = readProviderConfig();
  const materialConfig = readMaterialConfig();
  const materialAuthConfig = readMaterialAuthConfig();
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
  const adminConfig = readAdminConfig(process.env, authConfig?.origins);
  const rabbitmqMonitorConfig = adminConfig ? readRabbitmqMonitorConfig() : undefined;
  const redisMonitorConfig = adminConfig ? readRedisMonitorConfig() : undefined;
  const imageEnabled = Boolean(generationConfig);
  if (adminConfig && (!authConfig || !providerConfig))
    throw new Error('ADMIN_CONFIG: authentication and providers required');
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
    let admin: AdminService | undefined;
    const getAuthPolicy = (): AuthRuntimePolicy =>
      admin?.getAuthPolicy() ?? {
        emailPasswordEnabled: authConfig.emailPasswordEnabled,
        smsMode: 'live',
        smsBypassCode: null,
      };
    const redisConfig = backend === 'redis' ? readRedisConfig() : undefined;
    const deadline = monotonicMs() + 5000;
    const redis = redisConfig ? await createRedisResource(redisConfig, deadline) : undefined;
    let auth;
    try {
      const rateLimit =
        redis && (await createRedisRateLimit(redis, redisConfig!.namespace, deadline));
      auth = await createAuthentication(authConfig, rateLimit, undefined, getAuthPolicy);
      const acquired = auth;
      ctx.effect(() => async () => {
        await Promise.all([acquired.close(), redis?.close()]);
      });
    } catch (error) {
      // The fiber may have been disposed while either dependency was connecting.
      await Promise.all([auth?.close(), redis?.close()]);
      throw error;
    }
    let conversations: ConversationService | undefined;
    let generations: GenerationService | undefined;
    let materials: MaterialService | undefined;
    let assets: ReturnType<typeof createAssetService> | undefined;
    let vision: ReturnType<typeof createConversationVision> | undefined;
    const verifyAvatarAsset = async (
      identity: { userId: string; sessionId: string },
      assetId: string,
    ): Promise<'ok' | 'not_found' | 'not_ready' | 'invalid_type' | 'unavailable'> => {
      if (!assets) return 'unavailable';
      try {
        const asset = await assets.get(identity, assetId);
        if (asset.status !== 'ready') return 'not_ready';
        if (!AVATAR_MIME_TYPES.has(asset.contentType.toLowerCase())) return 'invalid_type';
        return 'ok';
      } catch (error) {
        if (error instanceof AssetError && error.status === HTTP_STATUS.NOT_FOUND)
          return 'not_found';
        return 'unavailable';
      }
    };
    const authHandler = createAuthHandler(authConfig, auth, verifyAvatarAsset, getAuthPolicy);
    if (assetConfig) {
      const store = await createAssetStore(assetConfig.databaseURL);
      try {
        const acquired = (assets = createAssetService(store, createCosStorage(assetConfig)));
        vision = createConversationVision((owner, id, expected, signal) =>
          acquired.readVisionSource(owner, id, expected, signal),
        );
        ctx.effect(
          () => () =>
            closeMioResources(
              () => conversations?.close(),
              () => materials?.close(),
              () => acquired.close(),
            ),
        );
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
        // Parent/child effects may unload concurrently: drain conversations before closing compute.
        ctx.effect(
          () => () =>
            closeMioResources(
              () => conversations?.close(),
              () => acquired.close(),
            ),
        );
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
        // Parent/child effects may unload concurrently: explicitly join admission and run teardown.
        ctx.effect(
          () => () =>
            closeMioResources(
              () => admin?.close(),
              () => conversations?.close(),
              () => generations?.close(),
              () => materials?.close(),
              () => ownedProviders.close(),
            ),
        );
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
    if (adminConfig && providers && providerConfig) {
      const store = await createAdminStore(adminConfig);
      let ownedAdmin: AdminService | undefined;
      try {
        const acquired =
          (admin =
          ownedAdmin =
            createAdminService(
              store,
              providers,
              providerConfig,
              undefined,
              {
                probeRabbitmq: () => probeRabbitmqMetrics(rabbitmqMonitorConfig),
                probeRedis: () => probeRedisMetrics(redisMonitorConfig),
              },
              {
                emailPasswordEnabled: authConfig.emailPasswordEnabled,
                smsProviderConfigured: Boolean(authConfig.sms),
              },
            ));
        ctx.effect(() => () => acquired.close());
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/admin',
            handler: createAdminHandler(acquired, adminConfig.allowedOrigins),
          }),
        );
      } catch (error) {
        await (ownedAdmin ? ownedAdmin.close() : store.close());
        throw error;
      }
    }
    if (materialConfig && providers) {
      const store = await createMaterialStore(
        materialConfig.databaseURL,
        Boolean(materialAuthConfig),
      );
      let acquired: MaterialService | undefined;
      let authentication: ReturnType<typeof createMaterialAuthService> | undefined;
      try {
        if (materialAuthConfig)
          authentication = createMaterialAuthService(
            store.authentication,
            providers,
            createMaterialAuthUpstream(),
            materialAuthConfig.publicOrigin,
          );
        materials = acquired = createMaterialService(
          store,
          providers,
          createMaterialUpstream(),
          assets,
          () => authentication?.close() ?? Promise.resolve(),
        );
        const owned = acquired;
        ctx.effect(() => async () => {
          await owned.close();
        });
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/materials',
            handler: createMaterialHandler(
              owned,
              auth.identity,
              authConfig.origins,
              authentication,
            ),
          }),
        );
      } catch (error) {
        const failures: unknown[] = [error];
        if (!acquired) {
          try {
            await authentication?.close();
          } catch (failure) {
            failures.push(failure);
          }
        }
        try {
          await (acquired ? acquired.close() : store.close());
        } catch (failure) {
          failures.push(failure);
        }
        if (failures.length > 1)
          throw new AggregateError(failures, 'Material startup cleanup failed');
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
        ctx.effect(
          () => () =>
            closeMioResources(
              () => conversations?.close(),
              () => acquired.close(),
            ),
        );
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
        inject: [
          'mioKernel',
          'llm',
          'webServer',
          'agents',
          'sessions',
          'sessionProjections',
          'systemPrompt',
        ],
        async apply(conversationCtx: Context) {
          let acquired: ConversationService | undefined;
          let http: ReturnType<typeof createConversationHandler> | undefined;
          // Keep the plugin on the parent's retained service scope. A child with its
          // own required injections may otherwise unload when those services begin
          // shutting down, before the parent has drained history and active turns.
          const policies = conversationCtx.plugin({
            name: 'mio-conversation-policies',
            apply(policyCtx: Context) {
              applyConversationPolicies(policyCtx);
              imageOffload.apply(policyCtx);
            },
          });
          const titles = installConversationTitles(conversationCtx);
          // Cordis unloads sibling effects concurrently. Adopt both disposers so
          // the policies and title service outlive every conversation agent.
          conversationCtx.effect(function* () {
            yield titles.dispose;
            yield policies.dispose;
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
                const retired = await Promise.allSettled([policies.dispose(), titles.dispose()]);
                for (const result of retired)
                  if (result.status === 'rejected') failures.push(result.reason);
                throw new AggregateError(failures, 'Conversation cleanup failed');
              }
            };
          });
          await Promise.all([policies, titles]);
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
        kind: 'prefix',
        path: AUTH_BASE_PATH,
        handler: authHandler,
      }),
    );
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/v1/me',
        handler: authHandler,
      }),
    );
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/v1/me/profile',
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
