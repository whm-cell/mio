import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readAdminConfig } from '../../src/admin/config.ts';
import { createAdminHandler } from '../../src/admin/http.ts';
import { adminSchemaSQL, checkAdminSchema } from '../../src/admin/schema.ts';
import { createAdminService } from '../../src/admin/service.ts';
import { createAdminStore } from '../../src/admin/store.ts';
import { hashAdminPassword } from '../../src/auth/admin-password.ts';
import { AUTH_BASE_PATH, readAuthConfig } from '../../src/auth/config.ts';
import { createAuthHandler } from '../../src/auth/http.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import {
  probeRabbitmqMetrics,
  readRabbitmqMonitorConfig,
} from '../../src/integrations/rabbitmq-monitor.ts';
import { probeRedisMetrics, readRedisMonitorConfig } from '../../src/integrations/redis.ts';
import { readProviderConfig } from '../../src/providers/config.ts';
import type { ImageParameterView } from '../../src/providers/contracts.ts';
import { createProviderHandler } from '../../src/providers/http.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import {
  findFixtureRoute,
  makeChatRouteFixture,
} from '../providers/fixtures/onelink-routes-fixture.ts';
import { authDatabase } from '../support/auth-database.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let auth: Awaited<ReturnType<typeof createAuthentication>>;
let providerStore: Awaited<ReturnType<typeof createProviderStore>>;
let providerService: ReturnType<typeof createProviderService>;
let adminStore: Awaited<ReturnType<typeof createAdminStore>>;
let adminService: ReturnType<typeof createAdminService>;
let server: Server;
let origin = '';
let userCookie = '';
let adminCookie = '';

const upstreamModels: { id: string; description?: string; owned_by?: string }[] = [
  { id: 'deepseek-v4.1-flash', description: 'Fast chat model', owned_by: 'deepseek' },
  {
    id: 'doubao-seedream-4.5',
    description: '支持文生图与多图参考',
    owned_by: 'volcengine',
  },
  { id: 'internal-embedding-v1', description: 'Internal vector model', owned_by: 'ali' },
];
const seenUpstreamAuthHeaders: string[] = [];

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const list = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  return list.map((item) => item.split(';')[0]!).join('; ');
}

function requestApi(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = '',
  extraHeaders: Record<string, string> = {},
) {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.observerURL });
  await pool.query(providerSchemaSQL);
  await pool.query(adminSchemaSQL);
  await pool.query(conversationSchemaSQL);
  await pool.query(assetSchemaSQL);
  await pool.query(computeSchemaSQL);
  await pool.query(generationSchemaSQL);
  await checkAdminSchema(pool);

  server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  origin = `http://127.0.0.1:${address.port}`;

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    MIO_AUTH_BASE_URL: origin,
    MIO_AUTH_SECRET: randomBytes(32).toString('hex'),
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_PROVIDERS_DATABASE_URL: database.url,
    MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
    MIO_PROVIDERS_MASTER_KEY_ID: 'admin-test-v1',
    MIO_CONVERSATIONS_DATABASE_URL: database.url,
    MIO_ASSETS_DATABASE_URL: database.url,
    MIO_COMPUTE_ENABLED: 'true',
    MIO_GENERATIONS_ENABLED: 'true',
    MIO_ADMIN_ENABLED: 'true',
  };
  const migrated = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(migrated.status, migrated.stderr).toBe(0);

  const authConfig = readAuthConfig(env)!;
  const providerConfig = readProviderConfig(env)!;
  expect(providerConfig.catalogWhitelist).toBe(true);
  const adminConfig = readAdminConfig(env, authConfig.origins)!;

  auth = await createAuthentication(authConfig);
  const transport = async (_url: string, init: RequestInit) => {
    const authHeader = new Headers(init.headers).get('authorization') ?? '';
    seenUpstreamAuthHeaders.push(authHeader);
    return Response.json({
      object: 'list',
      data: upstreamModels.map((m) => ({
        id: m.id,
        object: 'model',
        created: 1_700_000_000,
        owned_by: m.owned_by ?? 'onelink',
        description: m.description ?? '',
      })),
    });
  };

  const mqMonitorConfig = readRabbitmqMonitorConfig({
    MIO_ADMIN_RABBITMQ_MONITOR_URL: 'http://mio-dev-monitor:secret-mon@127.0.0.1:15680/mio-dev',
  });
  const fakeMqTransport: typeof fetch = async (input) => {
    const u = new URL(String(input));
    if (u.pathname === '/api/overview') {
      return Response.json({
        rabbitmq_version: '4.4.0',
        erlang_version: '27.2',
        cluster_name: 'rabbit@mio-dev-rabbitmq',
        object_totals: { connections: 2, channels: 3, exchanges: 5, queues: 4, consumers: 2 },
        queue_totals: { messages: 3, messages_ready: 2, messages_unacknowledged: 1 },
        message_stats: {
          publish_details: { rate: 1.5 },
          deliver_get_details: { rate: 1.2 },
          ack_details: { rate: 1.2 },
        },
      });
    }
    if (u.pathname === '/api/nodes') {
      return Response.json([
        {
          name: 'rabbit@mio-dev-rabbitmq',
          running: true,
          mem_used: 120_000_000,
          mem_limit: 858_993_459,
          mem_alarm: false,
          disk_free: 50_000_000_000,
          disk_free_limit: 50_000_000,
          disk_free_alarm: false,
          fd_used: 48,
          fd_total: 1048576,
          sockets_used: 4,
          sockets_total: 943626,
          proc_used: 420,
          proc_total: 1048576,
          uptime: 3600_000,
        },
      ]);
    }
    if (u.pathname === '/api/queues/mio-dev') {
      return Response.json([
        {
          name: 'mio.compute.commands.v1',
          type: 'quorum',
          state: 'running',
          consumers: 1,
          messages: 2,
          messages_ready: 1,
          messages_unacknowledged: 1,
          memory: 65536,
          message_stats: {
            publish_details: { rate: 1.5 },
            deliver_get_details: { rate: 1.2 },
            ack_details: { rate: 1.2 },
          },
        },
        {
          name: 'mio.compute.commands.dlq',
          type: 'quorum',
          state: 'running',
          consumers: 0,
          messages: 1,
          messages_ready: 1,
          messages_unacknowledged: 0,
          memory: 32768,
        },
      ]);
    }
    return new Response('not found', { status: 404 });
  };

  providerStore = await createProviderStore(providerConfig, true);
  providerService = createProviderService(providerStore, providerConfig, transport);
  adminStore = await createAdminStore(adminConfig);
  adminService = createAdminService(adminStore, providerService, providerConfig, transport, {
    probeRabbitmq: () => probeRabbitmqMetrics(mqMonitorConfig, fakeMqTransport),
    probeRedis: async () => ({
      configured: true,
      status: 'up',
      checkedAt: new Date().toISOString(),
      latencyMs: 0.8,
      errorCode: null,
      redisVersion: '8.2.11',
      uptimeSeconds: 7200,
      clockDriftMs: 12,
      clockHealthy: true,
      dbsize: 18,
      memory: {
        usedBytes: 2_097_152,
        usedHuman: '2.00M',
        peakBytes: 3_145_728,
        peakHuman: '3.00M',
        maxBytes: 134_217_728,
        maxHuman: '128.00M',
        policy: 'noeviction',
        usageRatio: 0.0156,
        fragmentationRatio: 1.18,
        oomRisk: false,
      },
      clients: { connected: 2, blocked: 0, rejectedConnections: 0 },
      stats: {
        instantaneousOpsPerSec: 14,
        totalCommandsProcessed: 980,
        evictedKeys: 0,
        keyspaceHits: 410,
        keyspaceMisses: 22,
      },
      persistence: {
        aofEnabled: true,
        aofLastWriteStatus: 'ok',
        rdbLastBgsaveStatus: 'ok',
      },
    }),
  });

  // Bootstrap initial super admin miioo_admin / miioo_admin
  const passwordHash = await hashAdminPassword('miioo_admin');
  const boot = await adminStore.bootstrapSuperAdmin('miioo_admin', passwordHash);
  expect(boot.created).toBe(true);
  expect(boot.admin.username).toBe('miioo_admin');

  const authHttp = createAuthHandler(authConfig, auth);
  const providerHttp = createProviderHandler(providerService, auth.identity, authConfig.origins);
  const adminHttp = createAdminHandler(adminService, adminConfig.allowedOrigins);

  server.on('request', (req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith(AUTH_BASE_PATH)) {
      void authHttp(req, res);
    } else if (url.startsWith('/api/v1/providers/onelink')) {
      void providerHttp(req, res);
    } else if (url.startsWith('/api/v1/admin')) {
      void adminHttp(req, res);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });

  // Register an ordinary C-end user and save+refresh their OneLink key
  const signUp = await requestApi('/api/auth/sign-up/email', 'POST', {
    email: 'creator@example.com',
    password: 'creator-password-123',
    name: 'Creator',
  });
  expect(signUp.status).toBe(200);
  userCookie = extractCookie(signUp.headers.getSetCookie());

  const saveCred = await requestApi(
    '/api/v1/providers/onelink/credential',
    'PUT',
    { apiKey: 'sk-user-valid-key-123456', expectedRevision: 0 },
    userCookie,
  );
  expect(saveCred.status).toBe(200);
  const testRes = await requestApi('/api/v1/providers/onelink/test', 'POST', {}, userCookie);
  expect(testRes.status).toBe(200);
});

afterAll(async () => {
  server?.close();
  await adminService?.close();
  await providerService?.close();
  await auth?.close();
  await pool?.end();
  await database?.close();
});

it('isolates admin authentication from ordinary users and supports username & verified password updates', async () => {
  const userAttempt = await requestApi('/api/v1/admin/auth/me', 'GET', undefined, userCookie);
  expect(userAttempt.status).toBe(401);

  const badLogin = await requestApi('/api/v1/admin/auth/login', 'POST', {
    username: 'miioo_admin',
    password: 'wrong_password',
  });
  expect(badLogin.status).toBe(401);

  const loginOne = await requestApi('/api/v1/admin/auth/login', 'POST', {
    username: 'miioo_admin',
    password: 'miioo_admin',
  });
  expect(loginOne.status).toBe(200);
  const firstSessionCookie = extractCookie(loginOne.headers.getSetCookie());
  expect(firstSessionCookie).toContain('mio.admin_session=');

  const loginTwo = await requestApi('/api/v1/admin/auth/login', 'POST', {
    username: 'miioo_admin',
    password: 'miioo_admin',
  });
  expect(loginTwo.status).toBe(200);
  adminCookie = extractCookie(loginTwo.headers.getSetCookie());

  const meRes = await requestApi('/api/v1/admin/auth/me', 'GET', undefined, adminCookie);
  expect(meRes.status).toBe(200);
  const meJson = (await meRes.json()) as { admin: { username: string; isSuperAdmin: boolean } };
  expect(meJson.admin.username).toBe('miioo_admin');
  expect(meJson.admin.isSuperAdmin).toBe(true);

  const missingOld = await requestApi(
    '/api/v1/admin/account',
    'PATCH',
    { newPassword: 'new_admin_password' },
    adminCookie,
  );
  expect(missingOld.status).toBe(400);

  const wrongOld = await requestApi(
    '/api/v1/admin/account',
    'PATCH',
    { currentPassword: 'wrong_password', newPassword: 'new_admin_password' },
    adminCookie,
  );
  expect(wrongOld.status).toBe(401);
  expect(((await wrongOld.json()) as { error: { code: string } }).error.code).toBe(
    'ADMIN_PASSWORD_MISMATCH',
  );

  const updated = await requestApi(
    '/api/v1/admin/account',
    'PATCH',
    {
      username: 'miioo_super',
      currentPassword: 'miioo_admin',
      newPassword: 'miioo_new_pass',
    },
    adminCookie,
  );
  expect(updated.status).toBe(200);
  expect(((await updated.json()) as { admin: { username: string } }).admin.username).toBe(
    'miioo_super',
  );

  const revokedCheck = await requestApi(
    '/api/v1/admin/auth/me',
    'GET',
    undefined,
    firstSessionCookie,
  );
  expect(revokedCheck.status).toBe(401);

  const activeCheck = await requestApi('/api/v1/admin/auth/me', 'GET', undefined, adminCookie);
  expect(activeCheck.status).toBe(200);

  const restore = await requestApi(
    '/api/v1/admin/account',
    'PATCH',
    {
      username: 'miioo_admin',
      currentPassword: 'miioo_new_pass',
      newPassword: 'miioo_admin',
    },
    adminCookie,
  );
  expect(restore.status).toBe(200);
});

it('seeds dynamic DB protocol templates once, supports full template CRUD, and never resurrects deleted templates on re-migration', async () => {
  const list1 = (await (
    await requestApi('/api/v1/admin/templates', 'GET', undefined, adminCookie)
  ).json()) as {
    drivers: { chat: string[]; image: string[] };
    items: {
      id: string;
      templateKey: string;
      label: string;
      routeTemplate: Record<string, unknown>;
      uiHints: { recommendedSizes?: string[] };
    }[];
  };
  expect(list1.drivers.chat).toEqual(['openai-chat', 'anthropic-messages']);
  expect(list1.drivers.image).toContain('volcengine-ark-images');
  expect(list1.items).toHaveLength(7);

  // Invalid routeTemplate is rejected with 400 ROUTE_INVALID
  const badTpl = await requestApi(
    '/api/v1/admin/templates',
    'POST',
    {
      templateKey: 'invalid-tpl',
      label: 'Invalid Template',
      routeTemplate: {
        operation: 'chat',
        vendor: 'openai',
        driver: 'unknown-driver',
        classification: 'chat',
        submitPath: '/v1/chat/completions',
        sourceKind: 'protocol-reference',
        source: 'Test',
        sourceVersion: '1.0',
      },
    },
    adminCookie,
  );
  expect(badTpl.status).toBe(400);
  expect(((await badTpl.json()) as { error: { code: string } }).error.code).toBe('ROUTE_INVALID');

  // Create a custom template
  const createdRes = await requestApi(
    '/api/v1/admin/templates',
    'POST',
    {
      templateKey: 'custom-vision-chat',
      label: '自定义多模态对话模板',
      description: '8192 输出上限 + 图文输入',
      sortOrder: 5,
      routeTemplate: {
        operation: 'chat',
        vendor: 'deepseek',
        driver: 'openai-chat',
        classification: 'chat',
        submitPath: '/v1/chat/completions',
        sourceKind: 'protocol-reference',
        source: 'Custom Admin Spec',
        sourceVersion: '2026-11',
        enabled: true,
        capabilityMetadata: {
          maxOutputTokens: 8192,
          inputModalities: ['text', 'image'],
        },
      },
      uiHints: { recommendedSizes: ['1024x1024'] },
    },
    adminCookie,
  );
  expect(createdRes.status).toBe(201);

  // Edit a seeded template & delete another seeded template (kling-omni)
  const seedream = list1.items.find((i) => i.templateKey === 'seedream-5')!;
  const klingOmni = list1.items.find((i) => i.templateKey === 'kling-omni')!;
  const updateSeeded = await requestApi(
    '/api/v1/admin/templates',
    'PUT',
    {
      id: seedream.id,
      templateKey: seedream.templateKey,
      label: '火山 Seedream 定制版模板',
      description: '管理员修改后的描述',
      sortOrder: 1,
      routeTemplate: seedream.routeTemplate,
      uiHints: { recommendedSizes: ['2K', '4K'] },
    },
    adminCookie,
  );
  expect(updateSeeded.status).toBe(200);

  const deleteSeeded = await requestApi(
    '/api/v1/admin/templates',
    'DELETE',
    { id: klingOmni.id },
    adminCookie,
  );
  expect(deleteSeeded.status).toBe(200);

  // Re-run adminSchemaSQL migration and verify deleted template stays deleted & edited label stays intact!
  await pool.query(adminSchemaSQL);
  const listAfterRemigrate = (await (
    await requestApi('/api/v1/admin/templates', 'GET', undefined, adminCookie)
  ).json()) as { items: { templateKey: string; label: string }[] };
  expect(listAfterRemigrate.items.some((i) => i.templateKey === 'kling-omni')).toBe(false);
  expect(listAfterRemigrate.items.some((i) => i.templateKey === 'custom-vision-chat')).toBe(true);
  expect(listAfterRemigrate.items.find((i) => i.templateKey === 'seedream-5')?.label).toBe(
    '火山 Seedream 定制版模板',
  );
});

it('enforces platform catalog whitelist on C-end users, previews OneLink candidates without auto-import, and supports full model & route CRUD', async () => {
  // 0. Before importing any models into platform catalog, C-end user sees 0 models!
  const userInitial = (await (
    await requestApi('/api/v1/providers/onelink/models', 'GET', undefined, userCookie)
  ).json()) as { items: { modelId: string }[] };
  expect(userInitial.items).toEqual([]);

  const adminInitial = (await (
    await requestApi('/api/v1/admin/models', 'GET', undefined, adminCookie)
  ).json()) as { summary: { totalModels: number } };
  expect(adminInitial.summary.totalModels).toBe(0);

  // 1. Ephemeral & saved OneLink probe returns candidates with importState='new' without polluting platform catalog
  const noKey = await requestApi('/api/v1/admin/onelink/discover', 'POST', {}, adminCookie);
  expect(noKey.status).toBe(400);
  expect(((await noKey.json()) as { error: { code: string } }).error.code).toBe(
    'PROBE_KEY_REQUIRED',
  );

  const probe1 = await requestApi(
    '/api/v1/admin/onelink/discover',
    'POST',
    { apiKey: 'sk-saved-channel-key-9876', saveKey: true },
    adminCookie,
  );
  expect(probe1.status).toBe(200);
  const probe1Json = (await probe1.json()) as {
    status: string;
    discoveredCount: number;
    newCount: number;
    totalCatalogCount: number;
    savedKey: boolean;
    candidates: { rawModelId: string; importState: string }[];
  };
  expect(probe1Json.status).toBe('connected');
  expect(probe1Json.discoveredCount).toBe(3);
  expect(probe1Json.newCount).toBe(3);
  expect(probe1Json.totalCatalogCount).toBe(0);
  expect(probe1Json.savedKey).toBe(true);

  // Re-discover omitting apiKey reuses encrypted saved key, then clear saved key
  seenUpstreamAuthHeaders.length = 0;
  const reuseProbe = await requestApi('/api/v1/admin/onelink/discover', 'POST', {}, adminCookie);
  expect(reuseProbe.status).toBe(200);
  expect(seenUpstreamAuthHeaders.at(-1)).toBe('Bearer sk-saved-channel-key-9876');
  expect(
    (await requestApi('/api/v1/admin/onelink/probe', 'DELETE', undefined, adminCookie)).status,
  ).toBe(200);

  // 2. Selectively import ONLY deepseek-v4.1-flash and doubao-seedream-4.5 (leaving internal-embedding-v1 unimported)
  const importRes = await requestApi(
    '/api/v1/admin/models/import',
    'POST',
    {
      items: [
        {
          rawModelId: 'deepseek-v4.1-flash',
          displayLabel: 'DeepSeek V4.1 Flash',
          category: 'chat',
          vendorLabel: 'deepseek',
        },
        {
          rawModelId: 'doubao-seedream-4.5',
          displayLabel: 'Doubao Seedream 4.5',
          category: 'image',
          vendorLabel: 'volcengine',
        },
      ],
    },
    adminCookie,
  );
  expect(importRes.status).toBe(200);
  expect((await importRes.json()) as { imported: number }).toMatchObject({ imported: 2 });

  // C-end user now sees ONLY the 2 imported models; internal-embedding-v1 stays blocked by whitelist!
  const userAfterImport = (await (
    await requestApi('/api/v1/providers/onelink/models', 'GET', undefined, userCookie)
  ).json()) as {
    provider: { revision: number };
    items: { modelId: string; modelRef: string; name: string }[];
  };
  expect(userAfterImport.items.map((i) => i.modelId)).toEqual([
    'deepseek-v4.1-flash',
    'doubao-seedream-4.5',
  ]);
  expect(userAfterImport.items[0]?.name).toBe('DeepSeek V4.1 Flash');

  // 3. Publish chat route v1 for deepseek-v4.1-flash & set user default
  const routeV1 = makeChatRouteFixture('deepseek-v4.1-flash', 'openai', {
    maxOutputTokens: 2048,
    source: 'OneLink official chat spec',
    sourceVersion: '2026-11-01',
  });
  const pubV1 = await requestApi(
    '/api/v1/admin/routes',
    'POST',
    { route: routeV1, summary: 'Initial chat route v1' },
    adminCookie,
  );
  expect(pubV1.status).toBe(200);
  const v1RevisionId = ((await pubV1.json()) as { revisions: { id: string }[] }).revisions[0]!.id;

  const deepseekItem = userAfterImport.items.find((i) => i.modelId === 'deepseek-v4.1-flash')!;
  expect(
    (
      await requestApi(
        '/api/v1/providers/onelink/models',
        'PATCH',
        {
          modelRef: deepseekItem.modelRef,
          expectedRevision: userAfterImport.provider.revision,
          usage: 'chat',
          isDefault: true,
        },
        userCookie,
      )
    ).status,
  ).toBe(200);

  // 4. Retired /models/policy endpoint returns 404 and retired tables do not exist
  const retiredPolicyRes = await requestApi(
    '/api/v1/admin/models/policy',
    'PUT',
    {
      rawModelId: 'deepseek-v4.1-flash',
      userVisible: false,
      allowUndiscovered: false,
    },
    adminCookie,
  );
  expect(retiredPolicyRes.status).toBe(404);
  expect(
    (
      await pool.query<{ policies: string | null; adaptations: string | null }>(
        `SELECT
           to_regclass('mio_provider_model_policies')::text AS policies,
           to_regclass('mio_provider_model_adaptations')::text AS adaptations`,
      )
    ).rows[0],
  ).toEqual({ policies: null, adaptations: null });

  // Update model via PATCH /api/v1/admin/models (hide userVisible=false -> 409 MODEL_HIDDEN, then restore)
  const patchHide = await requestApi(
    '/api/v1/admin/models',
    'PATCH',
    {
      rawModelId: 'deepseek-v4.1-flash',
      userVisible: false,
      callNotes: 'Maintenance window',
    },
    adminCookie,
  );
  expect(patchHide.status).toBe(200);

  const userWhileHidden = (await (
    await requestApi('/api/v1/providers/onelink/models', 'GET', undefined, userCookie)
  ).json()) as {
    provider: { revision: number };
    items: { modelId: string }[];
    defaults: { usage: string; effective: boolean; unavailableReason: string | null }[];
  };
  expect(userWhileHidden.items.map((i) => i.modelId)).toEqual(['doubao-seedream-4.5']);
  expect(userWhileHidden.defaults.find((d) => d.usage === 'chat')).toMatchObject({
    effective: false,
    unavailableReason: 'MODEL_HIDDEN',
  });

  const blockedPatch = await requestApi(
    '/api/v1/providers/onelink/models',
    'PATCH',
    {
      modelRef: deepseekItem.modelRef,
      expectedRevision: userWhileHidden.provider.revision,
      name: 'Attempt rename',
    },
    userCookie,
  );
  expect(blockedPatch.status).toBe(409);

  await requestApi(
    '/api/v1/admin/models',
    'PATCH',
    { rawModelId: 'deepseek-v4.1-flash', userVisible: true },
    adminCookie,
  );

  // 5. Create manual curated hidden model via POST /api/v1/admin/models
  const unlistedId = 'secret-omni-preview-v1';
  const createCurated = await requestApi(
    '/api/v1/admin/models',
    'POST',
    {
      rawModelId: unlistedId,
      displayLabel: 'Secret Omni Preview',
      vendorLabel: 'openai',
      category: 'chat',
      description: 'Curated unlisted model',
      userVisible: true,
      allowUndiscovered: true,
      callNotes: '支持多轮预览，建议 max_tokens <= 4096',
    },
    adminCookie,
  );
  expect(createCurated.status).toBe(201);
  await requestApi(
    '/api/v1/admin/routes',
    'POST',
    {
      route: makeChatRouteFixture(unlistedId, 'openai', {
        maxOutputTokens: 4096,
        source: 'Internal channel preview doc',
        sourceVersion: '2026-11-21',
      }),
    },
    adminCookie,
  );

  const userWithCurated = (await (
    await requestApi('/api/v1/providers/onelink/models', 'GET', undefined, userCookie)
  ).json()) as {
    items: { modelId: string; curated: boolean; runnable: boolean; description: string | null }[];
  };
  expect(userWithCurated.items.find((i) => i.modelId === unlistedId)).toMatchObject({
    curated: true,
    runnable: true,
    description: 'Curated unlisted model',
  });

  // 6. Update route to v2, rollback to v1, delete route on curated model, and delete doubao-seedream-4.5 with ignoreFutureImports=true
  const routeV2 = makeChatRouteFixture('deepseek-v4.1-flash', 'openai', {
    maxOutputTokens: 8192,
    source: 'Updated chat spec',
    sourceVersion: '2026-11-21',
  });
  await requestApi('/api/v1/admin/routes', 'POST', { route: routeV2 }, adminCookie);
  const rollbackRes = await requestApi(
    '/api/v1/admin/routes/rollback',
    'POST',
    { revisionId: v1RevisionId },
    adminCookie,
  );
  expect(rollbackRes.status).toBe(200);

  const delRouteRes = await requestApi(
    '/api/v1/admin/routes',
    'DELETE',
    { rawModelId: unlistedId, operation: 'chat', summary: 'Remove preview route' },
    adminCookie,
  );
  expect(delRouteRes.status).toBe(200);

  // 6b. Publish restricted image.generate route for doubao-seedream-4.5, verify C-end image.parameters & live update
  const userBeforeImageRoute = (await (
    await requestApi('/api/v1/providers/onelink/models', 'GET', undefined, userCookie)
  ).json()) as {
    items: {
      modelId: string;
      image: { runnable: boolean; parameters: ImageParameterView | null };
    }[];
  };
  expect(
    userBeforeImageRoute.items.find((i) => i.modelId === 'doubao-seedream-4.5')?.image.parameters,
  ).toBeNull();

  const seedreamBase = findFixtureRoute('doubao-seedream-4.5', 'image.generate');
  const seedreamRouteV1 = {
    ...seedreamBase,
    paramSpec: {
      ...seedreamBase.paramSpec!,
      allowedSizes: ['2K'],
      allowCustomDimensions: false,
      allowedAspectRatios: ['1:1', '16:9'],
      maxN: 2,
    },
    requestDefaults: {
      ...seedreamBase.requestDefaults!,
      defaultSize: '2K',
    },
  };
  const pubImgV1 = await requestApi(
    '/api/v1/admin/routes',
    'POST',
    { route: seedreamRouteV1, summary: 'Publish restricted Seedream 4.5 image bounds v1' },
    adminCookie,
  );
  expect(pubImgV1.status).toBe(200);

  const userAfterImgV1 = (await (
    await requestApi('/api/v1/providers/onelink/models', 'GET', undefined, userCookie)
  ).json()) as {
    items: {
      modelId: string;
      image: { runnable: boolean; parameters: ImageParameterView | null };
    }[];
  };
  expect(
    userAfterImgV1.items.find((i) => i.modelId === 'deepseek-v4.1-flash')?.image.parameters,
  ).toBeNull();
  expect(
    userAfterImgV1.items.find((i) => i.modelId === 'doubao-seedream-4.5')?.image,
  ).toMatchObject({
    runnable: true,
    parameters: {
      supportedOperations: ['generate'],
      requiresAsync: false,
      maxN: 2,
      allowExplicitN: true,
      allowedSizes: ['2K'],
      defaultSize: '2K',
      allowCustomDimensions: false,
      allowedAspectRatios: ['1:1', '16:9'],
      fixedOutputFormat: 'jpeg',
      defaultWatermark: false,
    },
  });

  // Verify listImageModels reuses deriveImageParameterView + display_label fallback and keeps strictly 19 fields
  const ownerRow = (
    await pool.query<{ owner_id: string }>('SELECT owner_id FROM mio_provider_configs LIMIT 1')
  ).rows[0]!;
  const listedImageModels = await providerService.listImageModels({ userId: ownerRow.owner_id });
  expect(listedImageModels).toHaveLength(1);
  expect(listedImageModels[0]).toMatchObject({
    modelId: 'doubao-seedream-4.5',
    name: 'Doubao Seedream 4.5',
    allowedSizes: ['2K'],
    defaultSize: '2K',
    allowCustomDimensions: false,
    allowedAspectRatios: ['1:1', '16:9'],
    maxN: 2,
  });
  expect(Object.keys(listedImageModels[0]!).sort()).toEqual([
    'allowCustomDimensions',
    'allowExplicitN',
    'allowGenerateReferences',
    'allowMaskPng',
    'allowedAspectRatios',
    'allowedBackgrounds',
    'allowedOutputFormats',
    'allowedQualities',
    'allowedSizes',
    'defaultSize',
    'driver',
    'maxN',
    'maxReferenceImages',
    'modelId',
    'modelRef',
    'name',
    'requiresAsync',
    'supportedOperations',
    'vendor',
  ]);

  const seedreamRouteV2 = {
    ...seedreamRouteV1,
    paramSpec: {
      ...seedreamRouteV1.paramSpec,
      allowedSizes: ['2K', '4K'],
    },
  };
  const pubImgV2 = await requestApi(
    '/api/v1/admin/routes',
    'POST',
    { route: seedreamRouteV2, summary: 'Expand Seedream 4.5 allowedSizes to 2K/4K' },
    adminCookie,
  );
  expect(pubImgV2.status).toBe(200);

  const userAfterImgV2 = (await (
    await requestApi('/api/v1/providers/onelink/models', 'GET', undefined, userCookie)
  ).json()) as {
    items: {
      modelId: string;
      image: { runnable: boolean; parameters: ImageParameterView | null };
    }[];
  };
  expect(
    userAfterImgV2.items.find((i) => i.modelId === 'doubao-seedream-4.5')?.image.parameters,
  ).toMatchObject({
    allowedSizes: ['2K', '4K'],
    defaultSize: '2K',
    allowCustomDimensions: false,
    allowedAspectRatios: ['1:1', '16:9'],
    maxN: 2,
  });

  const delModelRes = await requestApi(
    '/api/v1/admin/models',
    'DELETE',
    {
      rawModelId: 'doubao-seedream-4.5',
      ignoreFutureImports: true,
      summary: 'Retire legacy Seedream 4.5',
    },
    adminCookie,
  );
  expect(delModelRes.status).toBe(200);

  // Deleted model disappears from both C-end user catalog and Admin catalog, and shows as 'ignored' in candidates!
  const userAfterDelete = (await (
    await requestApi('/api/v1/providers/onelink/models', 'GET', undefined, userCookie)
  ).json()) as { items: { modelId: string }[] };
  expect(userAfterDelete.items.some((i) => i.modelId === 'doubao-seedream-4.5')).toBe(false);

  const candidatesRes = (await (
    await requestApi('/api/v1/admin/onelink/candidates', 'GET', undefined, adminCookie)
  ).json()) as {
    newCount: number;
    existingCount: number;
    ignoredCount: number;
    candidates: { rawModelId: string; importState: string }[];
  };
  expect(candidatesRes.existingCount).toBe(1); // deepseek-v4.1-flash
  expect(candidatesRes.ignoredCount).toBe(1); // doubao-seedream-4.5
  expect(candidatesRes.newCount).toBe(1); // internal-embedding-v1
});

it('aggregates runtime image/conversation/compute outbox monitoring plus full-tier RabbitMQ and Redis telemetry', async () => {
  // Validate Redis & RabbitMQ config guardrails
  expect(() =>
    readRedisMonitorConfig({ MIO_ADMIN_REDIS_MONITOR_URL: 'redis://remote.example.com:6379' }),
  ).toThrow('REDIS_MONITOR_CONFIG');
  expect(() =>
    readRabbitmqMonitorConfig({ MIO_ADMIN_RABBITMQ_MONITOR_URL: 'http://remote.example.com/mio' }),
  ).toThrow('RABBITMQ_MONITOR_CONFIG');

  const unconfRedis = await probeRedisMetrics(undefined);
  expect(unconfRedis.status).toBe('unconfigured');

  const deniedMq = await probeRabbitmqMetrics(
    readRabbitmqMonitorConfig({
      MIO_ADMIN_RABBITMQ_MONITOR_URL: 'http://mio-dev-monitor:bad@127.0.0.1:15680/mio-dev',
    }),
    async () => new Response('Unauthorized', { status: 401 }),
  );
  expect(deniedMq).toMatchObject({ status: 'down', errorCode: 'RABBITMQ_AUTH_DENIED' });

  // Seed image jobs + compute job & unsent outbox row
  const jobOk = randomUUID();
  const jobUpstreamFail = randomUUID();
  const jobStorageFail = randomUUID();
  const jobRejected = randomUUID();

  await pool.query(
    `INSERT INTO mio_image_jobs (id, owner_id, request_id, input_hash, command, state, error_code, route_snapshot)
     VALUES
       ($1, 'u1', $5, 'h1', '{"model":"doubao-seedream-4.5"}'::jsonb, 'completed', NULL, '{"driver":"volcengine-ark-images"}'::jsonb),
       ($2, 'u1', $6, 'h2', '{"model":"doubao-seedream-4.5"}'::jsonb, 'failed', 'UPSTREAM_GENERATION_FAILED', '{"driver":"volcengine-ark-images"}'::jsonb),
       ($3, 'u1', $7, 'h3', '{"model":"image-vidu-q2"}'::jsonb, 'materialization_failed', 'https://cos.example.com/obj?q-sign-algorithm=sha1&secret=123', '{"driver":"vidu-images"}'::jsonb),
       ($4, 'u1', $8, 'h4', '{"model":"image-vidu-q2"}'::jsonb, 'rejected', 'IMAGE_SIZE_INVALID', '{"driver":"vidu-images"}'::jsonb)`,
    [
      jobOk,
      jobUpstreamFail,
      jobStorageFail,
      jobRejected,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ],
  );
  await pool.query(
    `INSERT INTO mio_image_executions (job_id, phase, storage_failed)
     VALUES ($1, 'done', true)`,
    [jobStorageFail],
  );

  const assetId = randomUUID();
  const computeJobId = randomUUID();
  await pool.query(
    `INSERT INTO mio_assets (id, owner_id, filename, content_type, size_bytes, raw_key, state, expires_at)
     VALUES ($1, 'u1', 'clip.mp4', 'video/mp4', 1024, 'mio/raw/test', 'ready', now() + interval '1 hour')`,
    [assetId],
  );
  await pool.query(
    `INSERT INTO mio_compute_jobs (id, owner_id, request_id, input_asset_id, input_key, input_size, input_etag, state, attempt, attempt_id, command_id)
     VALUES ($1, 'u1', $2, $3, 'mio/raw/test', 1024, '"e1"', 'queued', 1, $4, $5)`,
    [computeJobId, randomUUID(), assetId, randomUUID(), randomUUID()],
  );
  await pool.query(
    `INSERT INTO mio_compute_outbox (id, job_id, command)
     VALUES ($1, $2, '{"type":"transcode.v1"}'::jsonb)`,
    [randomUUID(), computeJobId],
  );

  const monRes = await requestApi(
    '/api/v1/admin/monitoring?window=7d',
    'GET',
    undefined,
    adminCookie,
  );
  expect(monRes.status).toBe(200);
  const mon = (await monRes.json()) as {
    images: {
      enabled: boolean;
      totals: {
        total: number;
        completed: number;
        rejected: number;
        upstreamFailed: number;
        storageFailed: number;
      };
      recentJobs: { id: string; errorCode: string | null }[];
    };
    compute: {
      enabled: boolean;
      jobs: { total: number; queued: number };
      outbox: { pending: number };
    };
    rabbitmq: {
      status: string;
      rabbitmqVersion: string;
      dlqMessages: number;
      queues: { name: string; isDlq: boolean }[];
    };
    redis: {
      status: string;
      redisVersion: string;
      dbsize: number;
      clockHealthy: boolean;
      memory: { maxHuman: string; oomRisk: boolean };
    };
  };
  expect(mon.images.enabled).toBe(true);
  expect(mon.images.totals).toMatchObject({
    total: 4,
    completed: 1,
    rejected: 1,
    upstreamFailed: 1,
    storageFailed: 1,
  });
  const redactedJob = mon.images.recentJobs.find((j) => j.id === jobStorageFail)!;
  expect(redactedJob.errorCode).toBe('REDACTED_ERROR');

  expect(mon.compute.enabled).toBe(true);
  expect(mon.compute.jobs).toMatchObject({ total: 1, queued: 1 });
  expect(mon.compute.outbox.pending).toBe(1);

  expect(mon.rabbitmq).toMatchObject({
    status: 'up',
    rabbitmqVersion: '4.4.0',
    dlqMessages: 1,
  });
  expect(mon.rabbitmq.queues).toHaveLength(2);

  expect(mon.redis).toMatchObject({
    status: 'up',
    redisVersion: '8.2.11',
    dbsize: 18,
    clockHealthy: true,
  });
  expect(mon.redis.memory).toMatchObject({ maxHuman: '128.00M', oomRisk: false });
});
