import { createAccountDeletionRuntime } from './account-deletion/runtime.ts';
import type { AccountDeletionRuntime } from './account-deletion/runtime.ts';
import { reclaimDeletedMedia, reclaimDeletedTranscode } from './compute/deleted-results.ts';
import { createStorageAccounting } from './assets/storage-store.ts';
import { startStorageReconciliation } from './assets/storage-worker.ts';
import { createStorageUsageHandler } from './assets/storage-http.ts';
import { defaultStoragePolicy } from './assets/storage.ts';
import type { StorageHolderSource } from './assets/storage-worker.ts';
import { createCreationLogStore } from './notifications/creation-store.ts';
import { createCreationLogHandler } from './notifications/creation-http.ts';
import { startAudioCreationDelivery } from './audio/jobs/creation-outbox.ts';
import { monotonicMs } from '@mio/foundation/time';
import { createLogger } from '@mio/foundation/logging';
import { createId } from '@mio/foundation/identifiers';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { createHandler } from './http.ts';
import {
  AUTH_BASE_PATH,
  readAuthConfig,
  readAuthRateLimitBackend,
  resolveAllowedOneLinkClientIds,
} from './auth/config.ts';
import type { AuthRuntimePolicy, OneLinkSsoPolicyReader } from './auth/config.ts';
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
import type { ConversationImageTools, ConversationVideoTools } from './conversations/contracts.ts';
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
import { createPromptRuntime } from './prompts/runner.ts';
import type { PromptRuntime } from './prompts/runner.ts';
import { callPromptModel } from './dsh/prompt-caller.ts';
import type { ProviderService } from './providers/service.ts';
import { createProviderHandler } from './providers/http.ts';
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
import { createComputeStore } from './compute/transcode/store.ts';
import { createComputeService } from './compute/transcode/service.ts';
import { createComputeHandler } from './compute/transcode/http.ts';
import { createMediaHandler } from './compute/media/http.ts';
import { createMediaService } from './compute/media/service.ts';
import { createMediaStore } from './compute/media/store.ts';
import { createComputeOpsHandler } from './compute/observability/http.ts';
import {
  openWorkerObservabilityPools,
  WorkerObservabilityStore,
} from './compute/observability/store.ts';
import { WorkerObservabilityQueries } from './compute/observability/queries.ts';
import { startWorkerObservability, WorkerControlStore } from './compute/observability/control.ts';
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
import { readOneLinkSsoConfig } from './integrations/onelink/sso.ts';
import { readGenerationConfig } from './generations/config.ts';
import { createGenerationStore } from './generations/image/store.ts';
import { createGenerationService } from './generations/image/service.ts';
import type { GenerationService } from './generations/image/service.ts';
import { createGenerationHandler } from './generations/image/http.ts';
import { createVideoGenerationService } from './generations/video/service.ts';
import { createVideoGenerationHandler } from './generations/video/http.ts';
import { createVideoExecutor } from './generations/video/executor.ts';
import { createVideoMaterializer, createVideoCleanup } from './generations/video/media.ts';
import { createVideoInputResolver } from './generations/video/inputs.ts';
import { createVideoProtocol } from './integrations/onelink/video/index.ts';
import { readAdminConfig } from './admin/config.ts';
import { createAdminStore } from './admin/store.ts';
import { createAdminService } from './admin/service.ts';
import type { AdminService } from './admin/service.ts';
import { createAdminHandler, readAdminSessionCookie } from './admin/http.ts';
import { readNotificationsConfig } from './notifications/config.ts';
import { createNotificationStore } from './notifications/store.ts';
import { createNotificationService } from './notifications/service.ts';
import { createNotificationHandler } from './notifications/http.ts';

export const name = 'mio-foundation';
const log = createLogger('app', 'plugin');
export const inject = ['webServer', 'tools'];

declare module '@deepseek-ai/cordis' {
  interface Context {
    mioConversationProjectContext: ConversationProjectContextResolver;
    mioPromptRuntime: PromptRuntime;
  }
}

class ConversationTokenMeter extends TokenMeter {
  // The parent retains sessionProjections until its conversation work drains.
  static override inject = [];
}

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

async function closeVideoResources(
  admission: ReturnType<typeof createVideoGenerationService> | undefined,
  executor: Awaited<ReturnType<typeof createVideoExecutor>> | undefined,
): Promise<void> {
  // Each async call starts its stop synchronously and captures even a synchronous throw.
  const settled = await Promise.allSettled([
    (async () => admission?.close())(),
    (async () => executor?.close())(),
  ]);
  const failures = settled.filter((result) => result.status === 'rejected');
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Video cleanup failed',
    );
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
  const notificationsConfig = readNotificationsConfig();
  if (notificationsConfig && !authConfig)
    throw new Error('NOTIFICATIONS_CONFIG: authentication required');
  const oneLinkSsoConfig = readOneLinkSsoConfig();
  const rabbitmqMonitorConfig = adminConfig ? readRabbitmqMonitorConfig() : undefined;
  const redisMonitorConfig = adminConfig ? readRedisMonitorConfig() : undefined;
  const imageEnabled = Boolean(generationConfig);
  if (oneLinkSsoConfig && !authConfig)
    throw new Error('ONELINK_SSO_CONFIG: authentication required');
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
    const deletionRef: { current?: AccountDeletionRuntime } = {};
    const closeDeletion = () => deletionRef.current?.close();
    let videoAccountDrain: ((owner: string) => Promise<void>) | undefined;
    let admin: AdminService | undefined;
    let notifications: ReturnType<typeof createNotificationService> | undefined;
    let creationLogs: Awaited<ReturnType<typeof createCreationLogStore>> | undefined;
    let creationDelivery: ReturnType<typeof startAudioCreationDelivery> | undefined;
    const closeCreationLogs = () =>
      closeMioResources(
        closeDeletion,
        () => creationDelivery?.close(),
        () => creationLogs?.close(),
      );
    const getAuthPolicy = (): AuthRuntimePolicy =>
      admin?.getAuthPolicy() ?? {
        emailPasswordEnabled: authConfig.emailPasswordEnabled,
        smsMode: 'live',
        smsBypassCode: null,
      };
    const defaultOneLinkClientName = oneLinkSsoConfig?.clientName ?? 'miioo';
    const getOneLinkSsoPolicy: OneLinkSsoPolicyReader = () =>
      admin?.getOneLinkSsoPolicy() ?? {
        enabled: false,
        clientName: defaultOneLinkClientName,
        allowedClientIds: resolveAllowedOneLinkClientIds(defaultOneLinkClientName, null, null),
      };
    const redisConfig = backend === 'redis' ? readRedisConfig() : undefined;
    const deadline = monotonicMs() + 5000;
    const redis = redisConfig ? await createRedisResource(redisConfig, deadline) : undefined;
    let auth;
    try {
      const rateLimit =
        redis && (await createRedisRateLimit(redis, redisConfig!.namespace, deadline));
      auth = await createAuthentication(authConfig, rateLimit, undefined, getAuthPolicy, {
        ...(oneLinkSsoConfig ? { config: oneLinkSsoConfig } : {}),
        getPolicy: getOneLinkSsoPolicy,
      });
      const acquired = auth;
      ctx.effect(() => async () => {
        await closeMioResources(
          closeDeletion,
          () => acquired.close(),
          () => redis?.close(),
        );
      });
    } catch (error) {
      // The fiber may have been disposed while either dependency was connecting.
      await Promise.all([auth?.close(), redis?.close()]);
      throw error;
    }
    let conversations: ConversationService | undefined;
    if (notificationsConfig) {
      const store = await createNotificationStore(notificationsConfig.databaseURL);
      try {
        const acquired = (notifications = createNotificationService(store, (actor, action, id) => {
          if (!admin) throw new Error('ADMIN_UNAVAILABLE');
          return admin.recordAnnouncementOperation(actor, action, id);
        }));
        ctx.effect(() => () => closeMioResources(closeDeletion, () => acquired.close()));
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/announcements',
            handler: createNotificationHandler(acquired, auth.identity, authConfig.origins),
          }),
        );
      } catch (error) {
        await (notifications ? notifications.close() : store.close());
        throw error;
      }
    }
    let generations: GenerationService | undefined;
    let videoGenerations: ReturnType<typeof createVideoGenerationService> | undefined;
    const closeWithVideo = (
      drains: Array<() => Promise<void> | undefined>,
      ...dependencies: Array<() => Promise<void> | undefined>
    ) => {
      const deletionDrain = closeDeletion();
      const video = videoGenerations?.close();
      // Cordis disposes sibling effects concurrently. Stop video immediately, then join its drain
      // before releasing any shared dependency, even if another consumer has a slow close.
      void video?.catch(() => {});
      return closeMioResources(
        () => deletionDrain,
        ...drains,
        () => video,
        ...dependencies,
      );
    };
    let materials: MaterialService | undefined;
    let assets: ReturnType<typeof createAssetService> | undefined;
    let storage: Awaited<ReturnType<typeof createStorageAccounting>> | undefined;
    let storageWorker: ReturnType<typeof startStorageReconciliation> | undefined;
    let storageClosing: Promise<void> | undefined;
    const getStoragePolicy = () => (admin ? admin.getStoragePolicy() : defaultStoragePolicy);
    const closeStorage = () =>
      (storageClosing ??= (async () => {
        await closeDeletion();
        await storageWorker?.close();
        await storage?.close();
      })());
    const syncAvatarHolder = (owner: string) =>
      storage?.store.replaceHolder(owner, async () => {
        const avatarAssetId = await auth.avatarAssetId(owner);
        return {
          type: 'avatar',
          id: owner,
          assetIds: avatarAssetId ? [avatarAssetId] : [],
        };
      }) ?? Promise.resolve();
    const syncStorageHolders = (owner: string, id: string, read: () => Promise<string[]>) =>
      storage?.store.replaceHolder(owner, async () => ({
        type: 'conversation',
        id,
        assetIds: await read(),
      })) ?? Promise.resolve();
    let derivatives: ReturnType<typeof startAssetDerivatives> | undefined;
    let audio: AudioJobService | undefined;
    let assetResources: { store: AssetStore; objects: AssetObjectStore } | undefined;
    let vision: ReturnType<typeof createConversationVision> | undefined;
    const authHandler = createAuthHandler(
      authConfig,
      auth,
      (identity, assetId) =>
        assets?.verifyAvatar(identity, assetId) ?? Promise.resolve('unavailable'),
      getAuthPolicy,
      {
        accountDeleted: (owner, finalizedAt) =>
          deletionRef.current?.wake(owner, new Date(finalizedAt)),
        avatarChanged: syncAvatarHolder,
        avatarUrl: (identity, assetId) =>
          assets?.avatarUrl(identity, assetId) ?? Promise.resolve(null),
        normalizeAvatar: (identity, sourceAssetId) => {
          if (!assets) throw new Error('ASSET_UNAVAILABLE');
          return assets.normalizeAvatar(identity, sourceAssetId);
        },
      },
    );
    if (assetConfig) {
      const store = await createAssetStore(assetConfig.databaseURL, Boolean(computeConfig));
      try {
        storage = await createStorageAccounting(assetConfig.databaseURL, getStoragePolicy);
        const objects = createCosStorage(assetConfig);
        assetResources = { store, objects };
        const acquired = (assets = createAssetService(store, objects));
        vision = createConversationVision((owner, id, expected, signal) =>
          acquired.readVisionSource(owner, id, expected, signal),
        );
        ctx.effect(
          () => () =>
            closeWithVideo(
              [
                () => conversations?.close(),
                () => materials?.close(),
                () => audio?.close(),
                () => derivatives?.close(),
                closeStorage,
              ],
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
        await closeStorage();
        await (assets ? assets.close() : store.close());
        throw error;
      }
    }
    let providers: ProviderService | undefined;
    let compute: ReturnType<typeof createComputeService> | undefined;
    if (computeConfig && assetConfig && assetResources) {
      const store = await createComputeStore(assetConfig.databaseURL);
      let ownedCompute: ReturnType<typeof createComputeService> | undefined;
      try {
        const acquired =
          (compute =
          ownedCompute =
            createComputeService(
              store,
              assetResources.objects,
              computeConfig,
              async (attempt, result) => {
                if (!deletionRef.current?.gc)
                  throw new Error('ACCOUNT_DELETION_CLEANUP_UNAVAILABLE');
                await reclaimDeletedTranscode(attempt, result, deletionRef.current!.gc);
              },
            ));
        // Parent/child effects may unload concurrently: drain conversations before closing compute.
        ctx.effect(
          () => () => closeWithVideo([() => conversations?.close()], () => acquired.close()),
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
        const acquired = (media = createMediaService(
          store,
          assetResources.objects,
          computeConfig,
          async (attempt, result, signal) => {
            if (!deletionRef.current?.gc) throw new Error('ACCOUNT_DELETION_CLEANUP_UNAVAILABLE');
            await reclaimDeletedMedia(
              attempt,
              result,
              assetResources!.objects,
              deletionRef.current!.gc,
              signal,
            );
          },
        ));
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
      const pools = await openWorkerObservabilityPools(assetConfig.databaseURL);
      let telemetry: ReturnType<typeof startWorkerObservability> | undefined;
      try {
        const instances = computeConfig.workerInstances;
        const observations = new WorkerObservabilityStore(pools.write, instances);
        const control = adminConfig ? new WorkerControlStore(pools.write, instances) : undefined;
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
              () => pools.close(),
            ),
        );
        if (adminConfig && control) {
          computeOps = {
            view: new WorkerObservabilityQueries(pools.read, instances),
            control,
            wake: ownedTelemetry.wake,
          };
        }
      } catch (error) {
        await closeMioResources(
          () => telemetry?.close(),
          () => pools.close(),
        );
        throw error;
      }
    }
    if (providerConfig) {
      const store = await createProviderStore(providerConfig);
      let ownedProviders: ProviderService | undefined;
      let prompts: PromptRuntime | undefined;
      let providerClosing: Promise<void> | undefined;
      // Both normal teardown and startup failure join the same drain before touching the pool.
      const closeProviders = () =>
        (providerClosing ??= closeMioResources(
          () => prompts?.close(),
          () => (ownedProviders ? ownedProviders.close() : store.close()),
        ));
      try {
        const acquired =
          (providers =
          ownedProviders =
            createProviderService(
              store,
              providerConfig,
              undefined,
              Boolean(generationConfig?.videoEnabled && assetConfig && computeConfig),
            ));
        prompts = createPromptRuntime({
          callModel: callPromptModel,
          recordVerification: (ownerId, snapshot, evidence) =>
            acquired.recordVerification({ userId: ownerId }, snapshot, evidence),
        });
        if (computeConfig && assetResources) {
          audio = createAudioJobService(
            acquired.audioStore,
            acquired,
            assetResources.objects,
            createAudioMediaClient(computeConfig),
            assetResources.store,
          );
        }
        const ownedAudio = audio;
        // Parent/child effects may unload concurrently: explicitly join admission and run teardown.
        ctx.effect(
          () => () =>
            closeWithVideo(
              [
                () => prompts!.close(),
                closeCreationLogs,
                () => notifications?.close(),
                () => admin?.close(),
                () => conversations?.close(),
              ],
              () => generations?.close(),
              () => materials?.close(),
              () => ownedAudio?.close(),
              closeProviders,
            ),
        );
        // Cordis waits for service dependents before running this fiber's effects.
        // Stop admission at retirement, while admitted observations still own their provider pool.
        const ownedPrompts = prompts;
        ctx.on('internal/status', (fiber, previous) => {
          // Cordis 4.1 ACTIVE is 2; its const enum has no JavaScript export.
          if (fiber === ctx.fiber && previous === 2) void ownedPrompts.close();
        });
        ctx.provide('mioPromptRuntime', prompts);
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/providers/onelink',
            handler: createProviderHandler(acquired, auth.identity, authConfig.origins),
          }),
        );
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/audio',
            handler: createAudioHandler(acquired, auth.identity, authConfig.origins, ownedAudio),
          }),
        );
      } catch (error) {
        try {
          await closeMioResources(
            () => prompts?.close(),
            () => audio?.close(),
            closeProviders,
          );
        } catch (failure) {
          throw new AggregateError([error, failure], 'Provider startup cleanup failed');
        }
        throw error;
      }
    }
    if (adminConfig && providers && providerConfig) {
      const store = await createAdminStore(adminConfig, oneLinkSsoConfig?.environment);
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
              {
                ...(oneLinkSsoConfig ? { config: oneLinkSsoConfig } : {}),
                authBaseURL: authConfig.baseURL,
              },
            ));
        ctx.effect(
          () => () =>
            closeMioResources(
              closeCreationLogs,
              () => notifications?.close(),
              () => acquired.close(),
            ),
        );
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
            handler: createAdminHandler(
              {
                ...acquired,
                async updateStorageSettings(...args) {
                  const saved = await acquired.updateStorageSettings(...args);
                  try {
                    await storage?.store.updatePolicy();
                  } catch {
                    // The admin transaction is already committed. Existing background work repairs
                    // the projection; usage reads reject a mismatched version until it catches up.
                    log.warn('STORAGE_POLICY_PROJECTION_UNAVAILABLE');
                  }
                  return saved;
                },
              },
              adminConfig.allowedOrigins,
              computeHandler,
              notifications,
            ),
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
          await closeMioResources(closeDeletion, () => owned.close());
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
    if (generationConfig && assetConfig && assetResources) {
      const store = await createGenerationStore(assetConfig.databaseURL);
      let ownedGenerations: GenerationService | undefined;
      let videoAdmission: ReturnType<typeof createVideoGenerationService> | undefined;
      let videoExecutor: Awaited<ReturnType<typeof createVideoExecutor>> | undefined;
      let videoInputs: ReturnType<typeof createVideoInputResolver> | undefined;
      let videoClosing: Promise<void> | undefined;
      const closeVideo = () =>
        (videoClosing ??= closeVideoResources(videoAdmission, videoExecutor));
      try {
        const acquired =
          (generations =
          ownedGenerations =
            await createGenerationService(
              store,
              assetResources.objects,
              generationConfig,
              () => providers,
            ));
        const videoStore = store.videoStore();
        if (compute && generationConfig.videoEnabled) {
          const { store: assetStore, objects } = assetResources;
          const probe = compute.probeVideo;
          const inputs = (videoInputs = createVideoInputResolver(assetStore, objects));
          videoExecutor = await createVideoExecutor(
            videoStore,
            () => providers,
            createVideoMaterializer(objects, generationConfig.dataDirectory, probe),
            {
              protocol: createVideoProtocol,
              cleanup: createVideoCleanup(objects, generationConfig.dataDirectory),
              references: (row, signal) =>
                inputs.resolve(
                  row.owner_id,
                  row.command.inputSnapshot,
                  signal,
                  row.command.inputObjects,
                ),
            },
            generationConfig.dataDirectory,
          );
        }
        videoAccountDrain = videoExecutor?.drainAccount;
        const admission = (videoAdmission = createVideoGenerationService(
          videoStore,
          () => providers,
          videoExecutor,
          videoInputs?.inspect,
        ));
        const ownedVideoGenerations = (videoGenerations = {
          ...admission,
          close: closeVideo,
        });
        ctx.effect(
          () => () => closeWithVideo([() => conversations?.close()], () => acquired.close()),
        );
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/compute/images',
            handler: createGenerationHandler(acquired, auth.identity, authConfig.origins),
          }),
        );
        const videoHandler = createVideoGenerationHandler(
          ownedVideoGenerations,
          auth.identity,
          authConfig.origins,
        );
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/compute/video-capabilities',
            handler: videoHandler,
          }),
        );
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/compute/videos',
            handler: videoHandler,
          }),
        );
      } catch (error) {
        try {
          await closeMioResources(closeVideo, () =>
            ownedGenerations ? ownedGenerations.close() : store.close(),
          );
        } catch (failure) {
          throw new AggregateError([error, failure], 'Generation startup cleanup failed');
        }
        throw error;
      }
    }
    // Publish a single creation feed only when all three production paths and retention policy exist.
    if (
      admin &&
      providers &&
      audio &&
      assetConfig &&
      generationConfig?.videoEnabled &&
      computeConfig
    ) {
      const policy = admin;
      const store = await createCreationLogStore(assetConfig.databaseURL, () =>
        policy.getCreationLogRetentionDays(),
      );
      creationLogs = store;
      try {
        creationDelivery = startAudioCreationDelivery(
          providers.audioStore.creationOutbox,
          store.receiveAudio,
        );
        ctx.effect(() => closeCreationLogs);
        ctx.effect(() =>
          ctx.webServer.register({
            kind: 'prefix',
            path: '/api/v1/notifications',
            handler: createCreationLogHandler(store, auth.identity, authConfig.origins),
          }),
        );
      } catch (error) {
        await closeCreationLogs();
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
              await Promise.resolve(closeDeletion()).catch((error) => failures.push(error));
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
            const conversationVideoTools: ConversationVideoTools | undefined =
              videoGenerations && providers && generationConfig?.videoEnabled && computeConfig
                ? {
                    listModels: async (actor) => {
                      const catalog = await providers.catalog(actor, 'video');
                      return catalog.items.map((item) => ({
                        modelRef: item.modelRef,
                        modelId: item.modelId ?? item.modelKey,
                        name: item.name ?? item.modelId ?? item.modelKey,
                        vendor: item.video.adaptation?.vendor ?? 'OneLink',
                        available: item.video.runnable,
                        unavailableReason: item.video.unavailableReason,
                        supportedModes: item.video.modes,
                      }));
                    },
                    createVideo: (actor, request, signal) =>
                      videoGenerations
                        .createFromTool(actor, request, signal)
                        .then((result) => result.job),
                    getVideo: (actor, jobId) => videoGenerations.get(actor, jobId),
                    recoverVideo: (actor, jobId) => videoGenerations.recover(actor, jobId),
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
                    conversationVideoTools,
                  ),
                  providers,
                  vision,
                  async (lookup) => {
                    const resolve = conversationCtx.get('mioConversationProjectContext');
                    return resolve ? resolve(lookup) : null;
                  },
                  audioTools,
                  syncStorageHolders,
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
    if (storage) {
      const sources: StorageHolderSource[] = [
        {
          type: 'avatar',
          async read(owner) {
            const avatarAssetId = await auth.avatarAssetId(owner);
            return avatarAssetId ? [{ type: 'avatar', id: owner, assetIds: [avatarAssetId] }] : [];
          },
        },
      ];
      if (conversationConfig)
        sources.push({
          type: 'conversation',
          async read(owner) {
            if (!conversations) throw new Error('CONVERSATION_STORAGE_UNAVAILABLE');
            return conversations.storageHolders(owner);
          },
        });
      storageWorker = startStorageReconciliation(storage.store, sources);
    }
    deletionRef.current = await createAccountDeletionRuntime({
      auth,
      authDatabaseURL: authConfig.databaseURL,
      ...(providerConfig
        ? {
            providers: {
              databaseURL: providerConfig.databaseURL,
              drain: (owner: string) => audio?.drainAccount(owner) ?? Promise.resolve(),
            },
          }
        : {}),
      ...(notificationsConfig ? { notificationsDatabaseURL: notificationsConfig.databaseURL } : {}),
      ...(materialConfig ? { materialsDatabaseURL: materialConfig.databaseURL } : {}),
      ...(conversationConfig ? { conversations: () => conversations } : {}),
      ...(assetConfig && assetResources && assets
        ? {
            media: {
              databaseURL: assetConfig.databaseURL,
              objects: assetResources.objects,
              deleteEnabled: process.env.MIO_ASSETS_GC_DELETE_ENABLED === 'true',
              ...(generationConfig ? { generationDirectory: generationConfig.dataDirectory } : {}),
              cleanStaging: () => assets!.cleanup(),
              drainAssets: (owner: string) => assets!.drainAccount(owner),
              async drainGenerations(owner: string, kinds: readonly ('image' | 'video')[]) {
                if (kinds.includes('image')) {
                  if (!generations) throw new Error('LOCAL_GENERATION_VOLUME_NOT_OWNED');
                  await generations.drainAccount(owner);
                }
                if (kinds.includes('video')) {
                  if (!videoAccountDrain) throw new Error('LOCAL_VIDEO_VOLUME_NOT_OWNED');
                  await videoAccountDrain(owner);
                }
              },
            },
          }
        : {}),
    });
    auth.setDeletionDomains(deletionRef.current.domains);
    ctx.effect(() => () => deletionRef.current!.close());
    const storageHandler = createStorageUsageHandler(
      () => storage?.store,
      auth.identity,
      authConfig.origins,
    );
    for (const path of ['/api/v1/me/storage-usage', '/api/v1/me/storage-usage/reminders/ack']) {
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler: storageHandler }));
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
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/v1/me/profile/avatar/normalize',
        handler: authHandler,
      }),
    );
    for (const path of ['/api/v1/me/wechat', '/api/v1/me/onelink']) {
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler: authHandler }));
    }
  }

  // Registered on this fiber, so the guard and routes are removed together on disposal.
  for (const path of ['/healthz', '/readyz']) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }));
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/v1', handler }));
}
