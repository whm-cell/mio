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
import type { ConversationProjectContextResolver } from './conversations/project-context.ts';
import { createConversationHandler } from './conversations/http.ts';
import { createDshConversationEngine } from './dsh/conversations.ts';
import { applyConversationPolicies } from './dsh/conversation-checkpoints.ts';
import { installConversationTitles } from './dsh/conversation-titles.ts';
import { createConversationVision } from './dsh/vision.ts';
import * as imageOffload from '@deepseek-ai/dsh-compaction-image-offload';
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { readProviderConfig } from './providers/config.ts';
import { createProviderStore } from './providers/store.ts';
import { createProviderService } from './providers/service.ts';
import type { ProviderService } from './providers/service.ts';
import { createProviderHandler } from './providers/http.ts';
import { AssetError } from './assets/contracts.ts';
import { readAssetConfig } from './assets/config.ts';
import { createAssetStore } from './assets/store.ts';
import type { AssetStore } from './assets/store.ts';
import type { AssetObjectStore } from './assets/contracts.ts';
import { createAudioHandler } from './audio/http.ts';
import { createAudioJobService } from './audio/jobs/service.ts';
import type { AudioJobService } from './audio/jobs/service.ts';
import { createAudioMediaClient } from './audio/media.ts';
import { createAssetService } from './assets/service.ts';
import { startAssetDerivatives } from './assets/derivatives.ts';
import { createAssetHandler } from './assets/http.ts';
import { createCosStorage } from './integrations/cos.ts';
import { readComputeConfig } from './compute/config.ts';
import { createComputeStore } from './compute/store.ts';
import { createComputeService } from './compute/service.ts';
import { createComputeHandler } from './compute/http.ts';
import { createMediaHandler } from './compute/media-http.ts';
import { createMediaService } from './compute/media-service.ts';
import { createMediaStore } from './compute/media-store.ts';
import { createComputeOpsHandler } from './compute/ops-http.ts';
import {
  openWorkerObservabilityPool,
  WorkerObservabilityStore,
} from './compute/worker-observability-store.ts';
import { WorkerObservabilityQueries } from './compute/worker-observability-queries.ts';
import {
  startWorkerObservability,
  WorkerControlStore,
} from './compute/worker-observability-control.ts';
import { ComputeBroker } from './integrations/rabbitmq.ts';
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
import { createAdminHandler, readAdminSessionCookie } from './admin/http.ts';

export const name = 'mio-foundation';
export const inject = ['webServer', 'tools'];

declare module '@deepseek-ai/cordis' {
  interface Context {
    mioConversationProjectContext: ConversationProjectContextResolver;
  }
}

class ConversationTokenMeter extends TokenMeter {
  // The parent retains sessionProjections until its conversation work drains.
  static override inject = [];
}

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
    let derivatives: ReturnType<typeof startAssetDerivatives> | undefined;
    let audio: AudioJobService | undefined;
    let assetResources: { store: AssetStore; objects: AssetObjectStore } | undefined;
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
      const store = await createAssetStore(assetConfig.databaseURL, Boolean(computeConfig));
      try {
        const objects = createCosStorage(assetConfig);
        assetResources = { store, objects };
        const acquired = (assets = createAssetService(store, objects));
        vision = createConversationVision((owner, id, expected, signal) =>
          acquired.readVisionSource(owner, id, expected, signal),
        );
        ctx.effect(
          () => () =>
            closeMioResources(
              () => conversations?.close(),
              () => materials?.close(),
              () => audio?.close(),
              () => derivatives?.close(),
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
    if (computeConfig && assetConfig && assetResources) {
      const store = await createMediaStore(assetConfig.databaseURL);
      let media: ReturnType<typeof createMediaService> | undefined;
      try {
        const acquired = (media = createMediaService(store, assetResources.objects, computeConfig));
        derivatives = startAssetDerivatives(assetResources.store, acquired);
        ctx.effect(() => () => {
          const scheduler = derivatives?.close();
          return closeMioResources(
            () => acquired.close(),
            () => scheduler,
          );
        });
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/compute/media',
            handler: createMediaHandler(acquired, auth.identity, authConfig.origins),
          }),
        );
      } catch (error) {
        const scheduler = derivatives?.close();
        await closeMioResources(
          () => (media ? media.close() : store.close()),
          () => scheduler,
        );
        throw error;
      }
    }
    let computeOps:
      | {
          view: WorkerObservabilityQueries;
          control: WorkerControlStore;
          wake: () => void;
        }
      | undefined;
    if (computeConfig?.workerInstances?.length && assetConfig) {
      const pool = await openWorkerObservabilityPool(assetConfig.databaseURL);
      let telemetry: ReturnType<typeof startWorkerObservability> | undefined;
      try {
        const instances = computeConfig.workerInstances;
        const observations = new WorkerObservabilityStore(pool, instances);
        const control = adminConfig ? new WorkerControlStore(pool, instances) : undefined;
        const ownedTelemetry = (telemetry = startWorkerObservability(
          (stop) =>
            ComputeBroker.connect(
              computeConfig.brokerURL,
              computeConfig.brokerUser,
              computeConfig.expectedResultUser,
              stop,
              computeConfig.workerUsers,
            ),
          observations,
          control,
        ));
        ctx.effect(
          () => () =>
            closeMioResources(
              () => ownedTelemetry.close(),
              () => pool.end(),
            ),
        );
        if (adminConfig && control) {
          computeOps = {
            view: new WorkerObservabilityQueries(pool, instances),
            control,
            wake: ownedTelemetry.wake,
          };
        }
      } catch (error) {
        await closeMioResources(
          () => telemetry?.close(),
          () => pool.end(),
        );
        throw error;
      }
    }
    if (providerConfig) {
      const store = await createProviderStore(providerConfig, imageEnabled);
      providers = createProviderService(store, providerConfig);
      const ownedProviders = providers;
      try {
        if (computeConfig && assetResources) {
          audio = createAudioJobService(
            ownedProviders.audioStore,
            ownedProviders,
            assetResources.objects,
            createAudioMediaClient(computeConfig),
            assetResources.store,
          );
        }
        const ownedAudio = audio;
        // Parent/child effects may unload concurrently: explicitly join admission and run teardown.
        ctx.effect(
          () => () =>
            closeMioResources(
              () => admin?.close(),
              () => conversations?.close(),
              () => generations?.close(),
              () => materials?.close(),
              () => ownedAudio?.close(),
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
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/audio',
            handler: createAudioHandler(
              ownedProviders,
              auth.identity,
              authConfig.origins,
              ownedAudio,
            ),
          }),
        );
      } catch (error) {
        await closeMioResources(
          () => audio?.close(),
          () => ownedProviders.close(),
        );
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
        const computeHandler = computeOps
          ? createComputeOpsHandler(
              computeOps.view,
              computeOps.control,
              async (headers) => {
                const principal = await acquired.authenticate(
                  readAdminSessionCookie(headers.get('cookie')),
                );
                return principal
                  ? {
                      id: principal.admin.id,
                      username: principal.admin.username,
                      sessionId: principal.sessionId,
                    }
                  : null;
              },
              adminConfig.allowedOrigins,
              computeOps.wake,
            )
          : undefined;
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/admin',
            handler: createAdminHandler(acquired, adminConfig.allowedOrigins, computeHandler),
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
          const audioTools = conversationConfig.byok ? audio : undefined;
          let acquired: ConversationService | undefined;
          let http: ReturnType<typeof createConversationHandler> | undefined;
          // Keep the plugin on the parent's retained service scope. A child with its
          // own required injections may otherwise unload when those services begin
          // shutting down, before the parent has drained history and active turns.
          const policies = conversationCtx.plugin({
            name: 'mio-conversation-policies',
            async apply(policyCtx: Context) {
              applyConversationPolicies(policyCtx);
              imageOffload.apply(policyCtx);
              await Promise.all([
                policyCtx.plugin(ConversationTokenMeter),
                policyCtx.plugin(ToolResultPruner),
              ]);
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
                    audioTools,
                  ),
                  providers,
                  vision,
                  async (lookup) => {
                    const resolve = conversationCtx.get('mioConversationProjectContext');
                    return resolve ? resolve(lookup) : null;
                  },
                  audioTools,
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
