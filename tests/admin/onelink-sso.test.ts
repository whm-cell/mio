import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readAdminConfig } from '../../src/admin/config.ts';
import type {
  AdminOneLinkSsoRegisterView,
  AdminOneLinkSsoView,
} from '../../src/admin/contracts.ts';
import { createAdminHandler } from '../../src/admin/http.ts';
import { adminSchemaSQL, checkAdminSchema } from '../../src/admin/schema.ts';
import { createAdminService } from '../../src/admin/service.ts';
import { createAdminStore } from '../../src/admin/store.ts';
import { hashAdminPassword } from '../../src/auth/admin-password.ts';
import { AUTH_BASE_PATH, readAuthConfig } from '../../src/auth/config.ts';
import { createAuthHandler } from '../../src/auth/http.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import { readOneLinkSsoConfig } from '../../src/integrations/onelink/sso.ts';
import type { OneLinkSsoRegisterTransport } from '../../src/integrations/onelink/sso.ts';
import * as Mio from '../../src/plugin.ts';
import { readProviderConfig } from '../../src/providers/config.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { authDatabase } from '../support/auth-database.ts';

const SYNTHETIC_ENC_KEY = 'synthetic-admin-sso-test-key-32c';

const unregisteredConfig = {
  enabled: false,
  clientName: 'miioo',
  clientId: null,
  expectedClientId: null,
  registrationStatus: 'unregistered',
  registrationSource: null,
  lastRegisterCode: null,
  lastRegisterTraceId: null,
  lastRegisterMessage: null,
  lastRegisteredAt: null,
  revision: 0,
  updatedBy: null,
  updatedAt: null,
};

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let auth: Awaited<ReturnType<typeof createAuthentication>>;
let providerStore: Awaited<ReturnType<typeof createProviderStore>>;
let providerService: ReturnType<typeof createProviderService>;
let adminStore: Awaited<ReturnType<typeof createAdminStore>>;
let adminService: ReturnType<typeof createAdminService>;
let unconfiguredStore: Awaited<ReturnType<typeof createAdminStore>>;
let unconfiguredService: ReturnType<typeof createAdminService>;
let server: Server;
let unconfiguredServer: Server;
let origin = '';
let unconfiguredOrigin = '';
let userCookie = '';
let adminCookie = '';
let unconfiguredAdminCookie = '';
let activeRegisterHandler: OneLinkSsoRegisterTransport;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const list = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  return list.map((item) => item.split(';')[0]!).join('; ');
}

function requestApi(
  baseOrigin: string,
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = '',
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = {
    origin: baseOrigin,
    ...(cookie ? { cookie } : {}),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...extraHeaders,
  };
  return fetch(`${baseOrigin}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function ssoProviderConfig(masterKeyId: string) {
  return readProviderConfig({
    MIO_PROVIDERS_DATABASE_URL: database.url,
    MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
    MIO_PROVIDERS_MASTER_KEY_ID: masterKeyId,
  })!;
}

function ssoRuntime(environment: string) {
  return {
    config: {
      environment,
      encryptionKey: SYNTHETIC_ENC_KEY,
      authorizeUrl: 'https://scenic.wanlian.cloud/authorize',
      registerUrl: 'https://api-test.wanlian.cloud/sso/client/register',
      clientName: 'miioo',
      appName: 'Miioo',
    },
    authBaseURL: origin,
  };
}

beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.observerURL });
  await pool.query(providerSchemaSQL);
  await pool.query(adminSchemaSQL);
  await checkAdminSchema(pool);

  server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  origin = `http://127.0.0.1:${address.port}`;

  unconfiguredServer = createServer();
  unconfiguredServer.listen(0, '127.0.0.1');
  await once(unconfiguredServer, 'listening');
  const unconfiguredAddress = unconfiguredServer.address();
  if (!unconfiguredAddress || typeof unconfiguredAddress === 'string')
    throw new Error('Missing port');
  unconfiguredOrigin = `http://127.0.0.1:${unconfiguredAddress.port}`;

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    MIO_ENVIRONMENT: 'staging',
    MIO_AUTH_BASE_URL: origin,
    MIO_AUTH_SECRET: randomBytes(32).toString('hex'),
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_PROVIDERS_DATABASE_URL: database.url,
    MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
    MIO_PROVIDERS_MASTER_KEY_ID: 'admin-sso-test-v1',
    MIO_ADMIN_ENABLED: 'true',
    MIO_ONELINK_SSO_ENC_KEY: SYNTHETIC_ENC_KEY,
    MIO_ONELINK_SSO_AUTHORIZE_URL: 'https://scenic.wanlian.cloud/authorize',
    MIO_ONELINK_SSO_REGISTER_URL: 'https://api-test.wanlian.cloud/sso/client/register',
  };
  const migrated = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(migrated.status, migrated.stderr).toBe(0);

  const authConfig = readAuthConfig(env)!;
  const providerConfig = readProviderConfig(env)!;
  const adminConfig = readAdminConfig(env, authConfig.origins)!;
  const oneLinkSsoConfig = readOneLinkSsoConfig(env)!;

  activeRegisterHandler = async () =>
    Response.json({
      traceId: 'default-trace',
      code: 200,
      data: { clientId: 'miiooClientId', clientName: 'miioo' },
    });

  auth = await createAuthentication(authConfig);
  providerStore = await createProviderStore(providerConfig);
  providerService = createProviderService(providerStore, providerConfig);
  adminStore = await createAdminStore(adminConfig, oneLinkSsoConfig.environment);
  adminService = createAdminService(
    adminStore,
    providerService,
    providerConfig,
    undefined,
    undefined,
    {
      emailPasswordEnabled: authConfig.emailPasswordEnabled,
      smsProviderConfigured: false,
    },
    {
      config: oneLinkSsoConfig,
      authBaseURL: authConfig.baseURL,
      registerTransport: (url, init) => activeRegisterHandler(url, init),
    },
  );

  unconfiguredStore = await createAdminStore(
    {
      databaseURL: adminConfig.databaseURL,
      allowedOrigins: [unconfiguredOrigin],
      oneLinkSsoEnv: 'unconfigured-env',
    },
    'unconfigured-env',
  );
  unconfiguredService = createAdminService(
    unconfiguredStore,
    providerService,
    providerConfig,
    undefined,
    undefined,
    undefined,
    {
      authBaseURL: unconfiguredOrigin,
    },
  );

  const authHandler = createAuthHandler(authConfig, auth);
  const adminHandler = createAdminHandler(adminService, adminConfig.allowedOrigins);
  const unconfiguredAdminHandler = createAdminHandler(unconfiguredService, [unconfiguredOrigin]);

  server.on('request', (req, res) => {
    const pathname = new URL(req.url ?? '/', origin).pathname;
    if (pathname.startsWith(AUTH_BASE_PATH)) {
      void authHandler(req, res);
      return;
    }
    if (pathname.startsWith('/api/v1/admin')) {
      void adminHandler(req, res);
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  unconfiguredServer.on('request', (req, res) => {
    void unconfiguredAdminHandler(req, res);
  });

  await adminStore.bootstrapSuperAdmin(
    'sso_admin',
    await hashAdminPassword('AdminPass123!'),
    false,
  );

  const loginRes = await requestApi(origin, '/api/v1/admin/auth/login', 'POST', {
    username: 'sso_admin',
    password: 'AdminPass123!',
  });
  expect(loginRes.status).toBe(200);
  adminCookie = extractCookie(loginRes.headers.getSetCookie());

  const unconfiguredLoginRes = await requestApi(
    unconfiguredOrigin,
    '/api/v1/admin/auth/login',
    'POST',
    {
      username: 'sso_admin',
      password: 'AdminPass123!',
    },
  );
  expect(unconfiguredLoginRes.status).toBe(200);
  unconfiguredAdminCookie = extractCookie(unconfiguredLoginRes.headers.getSetCookie());

  const signUp = await requestApi(origin, '/api/auth/sign-up/email', 'POST', {
    name: 'Normal User',
    email: 'normal-sso-test@example.com',
    password: 'UserPassword123!',
  });
  expect(signUp.status).toBe(200);
  userCookie = extractCookie(signUp.headers.getSetCookie());
});

afterAll(async () => {
  await Promise.allSettled([
    new Promise<void>((resolve) => server?.close(() => resolve())),
    new Promise<void>((resolve) => unconfiguredServer?.close(() => resolve())),
    adminService?.close(),
    unconfiguredService?.close(),
    providerService?.close(),
    auth?.close(),
    pool?.end(),
    database?.close(),
  ]);
});

it('rejects unauthenticated requests, ordinary C-end user cookies and invalid origins', async () => {
  expect((await requestApi(origin, '/api/v1/admin/onelink/sso', 'GET')).status).toBe(401);
  expect(
    (await requestApi(origin, '/api/v1/admin/onelink/sso', 'GET', undefined, userCookie)).status,
  ).toBe(401);
  expect(
    (
      await requestApi(
        origin,
        '/api/v1/admin/onelink/sso',
        'PATCH',
        { expectedRevision: 0, enabled: false, expectedClientId: null },
        userCookie,
      )
    ).status,
  ).toBe(401);
  expect(
    (await requestApi(origin, '/api/v1/admin/onelink/sso/register', 'POST', {}, userCookie)).status,
  ).toBe(401);

  expect(
    (
      await requestApi(origin, '/api/v1/admin/onelink/sso', 'GET', undefined, adminCookie, {
        origin: 'https://evil.example',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${origin}/api/v1/admin/onelink/sso`, {
        method: 'PATCH',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 0, enabled: false, expectedClientId: null }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${origin}/api/v1/admin/onelink/sso/register`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(403);
});

it('reports unconfigured runtime cleanly, blocks enabling and rejects register with 503', async () => {
  const getRes = await requestApi(
    unconfiguredOrigin,
    '/api/v1/admin/onelink/sso',
    'GET',
    undefined,
    unconfiguredAdminCookie,
  );
  expect(getRes.status).toBe(200);
  const view = (await getRes.json()) as AdminOneLinkSsoView;
  expect(view).toEqual({
    config: {
      environment: 'unconfigured-env',
      ...unregisteredConfig,
    },
    runtime: {
      configured: false,
      hasEncryptionKey: false,
      authorizeOrigin: null,
      registerOrigin: null,
      callbackUrl: `${unconfiguredOrigin}/api/auth/callback/onelink`,
      tokenVerificationMode: 'payload_sub_unverified',
    },
  });

  const enableRes = await requestApi(
    unconfiguredOrigin,
    '/api/v1/admin/onelink/sso',
    'PATCH',
    { expectedRevision: 0, enabled: true, expectedClientId: null },
    unconfiguredAdminCookie,
  );
  expect(enableRes.status).toBe(400);
  expect(((await enableRes.json()) as { error: { code: string } }).error.code).toBe(
    'ONELINK_SSO_NOT_CONFIGURED',
  );

  const registerRes = await requestApi(
    unconfiguredOrigin,
    '/api/v1/admin/onelink/sso/register',
    'POST',
    {},
    unconfiguredAdminCookie,
  );
  expect(registerRes.status).toBe(503);
  expect(((await registerRes.json()) as { error: { code: string } }).error.code).toBe(
    'ONELINK_SSO_UNAVAILABLE',
  );
});

it('supports default GET, optimistic lock PATCH, input rejection, hot policy refresh and restart hydration', async () => {
  const initialGet = await requestApi(
    origin,
    '/api/v1/admin/onelink/sso',
    'GET',
    undefined,
    adminCookie,
  );
  expect(initialGet.status).toBe(200);
  const initialText = await initialGet.text();
  expect(initialText).not.toContain(SYNTHETIC_ENC_KEY);
  const initial = JSON.parse(initialText) as AdminOneLinkSsoView;
  expect(initial).toEqual({
    config: {
      environment: 'staging',
      ...unregisteredConfig,
    },
    runtime: {
      configured: true,
      hasEncryptionKey: true,
      authorizeOrigin: 'https://scenic.wanlian.cloud',
      registerOrigin: 'https://api-test.wanlian.cloud',
      callbackUrl: `${origin}/api/auth/callback/onelink`,
      tokenVerificationMode: 'payload_sub_unverified',
    },
  });
  expect(adminService.getOneLinkSsoPolicy()).toEqual({
    enabled: false,
    clientName: 'miioo',
    allowedClientIds: ['miioo', 'miiooClientId'],
  });

  // Reject routerClientId, invalid characters, and extra keys
  for (const invalidBody of [
    { expectedRevision: 0, enabled: true, expectedClientId: 'routerClientId' },
    { expectedRevision: 0, enabled: true, expectedClientId: 'bad client id' },
    { expectedRevision: 0, enabled: true, expectedClientId: '' },
    { expectedRevision: 0, enabled: true, expectedClientId: null, extraField: true },
  ]) {
    const res = await requestApi(
      origin,
      '/api/v1/admin/onelink/sso',
      'PATCH',
      invalidBody,
      adminCookie,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'ADMIN_INPUT_INVALID',
    );
  }

  // PATCH 0 -> 1 enables switch and pins expectedClientId; snapshot updates immediately
  const patch1Res = await requestApi(
    origin,
    '/api/v1/admin/onelink/sso',
    'PATCH',
    { expectedRevision: 0, enabled: true, expectedClientId: 'pinnedClientId' },
    adminCookie,
  );
  expect(patch1Res.status).toBe(200);
  const patch1 = (await patch1Res.json()) as AdminOneLinkSsoView;
  expect(patch1.config).toMatchObject({
    environment: 'staging',
    enabled: true,
    expectedClientId: 'pinnedClientId',
    registrationStatus: 'unregistered',
    revision: 1,
    updatedBy: 'sso_admin',
  });
  expect(adminService.getOneLinkSsoPolicy()).toEqual({
    enabled: true,
    clientName: 'miioo',
    allowedClientIds: ['pinnedClientId'],
  });

  // Stale revision 0 against revision 1 -> 409 SETTINGS_CONFLICT
  const conflict0 = await requestApi(
    origin,
    '/api/v1/admin/onelink/sso',
    'PATCH',
    { expectedRevision: 0, enabled: false, expectedClientId: null },
    adminCookie,
  );
  expect(conflict0.status).toBe(409);
  expect(((await conflict0.json()) as { error: { code: string } }).error.code).toBe(
    'SETTINGS_CONFLICT',
  );

  // PATCH 1 -> 2 omitting expectedClientId preserves existing non-null expectedClientId
  const patchPreserveRes = await requestApi(
    origin,
    '/api/v1/admin/onelink/sso',
    'PATCH',
    { expectedRevision: 1, enabled: false },
    adminCookie,
  );
  expect(patchPreserveRes.status).toBe(200);
  const patchPreserve = (await patchPreserveRes.json()) as AdminOneLinkSsoView;
  expect(patchPreserve.config).toMatchObject({
    enabled: false,
    expectedClientId: 'pinnedClientId',
    revision: 2,
  });
  expect(adminService.getOneLinkSsoPolicy()).toEqual({
    enabled: false,
    clientName: 'miioo',
    allowedClientIds: ['pinnedClientId'],
  });

  // PATCH 2 -> 3 clears expectedClientId and re-enables; snapshot falls back to default client IDs
  const patch2Res = await requestApi(
    origin,
    '/api/v1/admin/onelink/sso',
    'PATCH',
    { expectedRevision: 2, enabled: true, expectedClientId: null },
    adminCookie,
  );
  expect(patch2Res.status).toBe(200);
  const patch2 = (await patch2Res.json()) as AdminOneLinkSsoView;
  expect(patch2.config.revision).toBe(3);
  expect(patch2.config.expectedClientId).toBeNull();
  expect(adminService.getOneLinkSsoPolicy()).toEqual({
    enabled: true,
    clientName: 'miioo',
    allowedClientIds: ['miioo', 'miiooClientId'],
  });

  // Stale revision 2 against revision 3 -> 409 SETTINGS_CONFLICT
  const conflict1 = await requestApi(
    origin,
    '/api/v1/admin/onelink/sso',
    'PATCH',
    { expectedRevision: 2, enabled: false, expectedClientId: null },
    adminCookie,
  );
  expect(conflict1.status).toBe(409);

  // Restart hydration: fresh store + service hydrates enabled & revision from PostgreSQL
  const restartProviderConfig = ssoProviderConfig('restart-test-v1');
  const restartedStore = await createAdminStore(
    {
      databaseURL: database.url,
      allowedOrigins: [origin],
      oneLinkSsoEnv: 'staging',
    },
    'staging',
  );
  const restartedService = createAdminService(
    restartedStore,
    providerService,
    restartProviderConfig,
    undefined,
    undefined,
    undefined,
    ssoRuntime('staging'),
  );
  const restartedUnconfiguredStore = await createAdminStore(
    {
      databaseURL: database.url,
      allowedOrigins: [origin],
      oneLinkSsoEnv: 'staging',
    },
    'staging',
  );
  const restartedUnconfiguredService = createAdminService(
    restartedUnconfiguredStore,
    providerService,
    restartProviderConfig,
    undefined,
    undefined,
    undefined,
    {
      authBaseURL: origin,
    },
  );
  try {
    expect(restartedStore.initialOneLinkSsoConfig).toMatchObject({
      environment: 'staging',
      enabled: true,
      revision: 3,
    });
    expect(restartedService.getOneLinkSsoPolicy()).toEqual({
      enabled: true,
      clientName: 'miioo',
      allowedClientIds: ['miioo', 'miiooClientId'],
    });
    // Fail closed on restart when DB has enabled=true but MIO_ONELINK_SSO_* env is absent
    expect(restartedUnconfiguredStore.initialOneLinkSsoConfig).toMatchObject({
      environment: 'staging',
      enabled: true,
      revision: 3,
    });
    expect(restartedUnconfiguredService.getOneLinkSsoPolicy()).toEqual({
      enabled: false,
      clientName: 'miioo',
      allowedClientIds: ['miioo', 'miiooClientId'],
    });
  } finally {
    await Promise.all([restartedService.close(), restartedUnconfiguredService.close()]);
  }
});

it('handles 362 trust, 200 register, 362 preservation, 363/364/failure preservation, single-flight and redacted audits', async () => {
  // Reject non-empty body on register
  const badBody = await requestApi(
    origin,
    '/api/v1/admin/onelink/sso/register',
    'POST',
    { clientName: 'evil' },
    adminCookie,
  );
  expect(badBody.status).toBe(400);

  // 1) 362 when client_id is empty -> marks trusted_existing without blocking, preserves enabled=true
  activeRegisterHandler = async () =>
    Response.json({ traceId: 'trace-362-first', code: 362, message: 'client already exists' });
  const reg362EmptyRes = await requestApi(
    origin,
    '/api/v1/admin/onelink/sso/register',
    'POST',
    {},
    adminCookie,
  );
  expect(reg362EmptyRes.status).toBe(200);
  const reg362Empty = (await reg362EmptyRes.json()) as AdminOneLinkSsoRegisterView;
  expect(reg362Empty).toMatchObject({
    outcome: 'already_exists_trusted',
    upstreamCode: 362,
    errorCode: null,
    traceId: 'trace-362-first',
    config: {
      enabled: true,
      clientId: 'miioo',
      registrationStatus: 'trusted_existing',
      registrationSource: 'register_362_trusted',
      lastRegisterCode: 362,
      lastRegisterTraceId: 'trace-362-first',
      revision: 4,
    },
  });

  // 2) 200 -> saves returned clientId, marks registered, preserves enabled=true
  activeRegisterHandler = async () =>
    Response.json({
      traceId: 'trace-200-ok',
      code: 200,
      message: 'success',
      data: { clientId: 'miiooRegisteredId', clientName: 'miioo' },
    });
  const reg200Res = await requestApi(
    origin,
    '/api/v1/admin/onelink/sso/register',
    'POST',
    {},
    adminCookie,
  );
  expect(reg200Res.status).toBe(200);
  const reg200 = (await reg200Res.json()) as AdminOneLinkSsoRegisterView;
  expect(reg200).toMatchObject({
    outcome: 'registered',
    upstreamCode: 200,
    errorCode: null,
    traceId: 'trace-200-ok',
    config: {
      enabled: true,
      clientId: 'miiooRegisteredId',
      registrationStatus: 'registered',
      registrationSource: 'register_200',
      lastRegisterCode: 200,
      lastRegisterTraceId: 'trace-200-ok',
      revision: 5,
    },
  });
  expect(adminService.getOneLinkSsoPolicy()).toEqual({
    enabled: true,
    clientName: 'miioo',
    allowedClientIds: ['miiooRegisteredId', 'miioo', 'miiooClientId'],
  });

  // 3) Subsequent 362 -> preserves existing 200 clientId, registered status and register_200 source
  activeRegisterHandler = async () =>
    Response.json({ traceId: 'trace-362-keep', code: 362, message: 'exists' });
  const reg362KeepRes = await requestApi(
    origin,
    '/api/v1/admin/onelink/sso/register',
    'POST',
    {},
    adminCookie,
  );
  expect(reg362KeepRes.status).toBe(200);
  const reg362Keep = (await reg362KeepRes.json()) as AdminOneLinkSsoRegisterView;
  expect(reg362Keep).toMatchObject({
    outcome: 'already_exists_trusted',
    upstreamCode: 362,
    errorCode: null,
    traceId: 'trace-362-keep',
    config: {
      enabled: true,
      clientId: 'miiooRegisteredId',
      registrationStatus: 'registered',
      registrationSource: 'register_200',
      lastRegisterCode: 362,
      lastRegisterTraceId: 'trace-362-keep',
      revision: 6,
    },
  });

  // 4) 363 -> rejected, preserves existing config & revision
  activeRegisterHandler = async () =>
    Response.json({
      traceId: 'trace-363-bad',
      code: 363,
      message: `raw-upstream-secret-${SYNTHETIC_ENC_KEY}`,
    });
  const reg363Res = await requestApi(
    origin,
    '/api/v1/admin/onelink/sso/register',
    'POST',
    {},
    adminCookie,
  );
  expect(reg363Res.status).toBe(200);
  const reg363Text = await reg363Res.text();
  expect(reg363Text).not.toContain(SYNTHETIC_ENC_KEY);
  expect(reg363Text).not.toContain('raw-upstream-secret');
  const reg363 = JSON.parse(reg363Text) as AdminOneLinkSsoRegisterView;
  expect(reg363).toMatchObject({
    outcome: 'rejected',
    upstreamCode: 363,
    errorCode: 'ONELINK_CLIENT_NAME_INVALID',
    traceId: 'trace-363-bad',
    config: {
      enabled: true,
      clientId: 'miiooRegisteredId',
      registrationStatus: 'registered',
      revision: 6,
    },
  });

  // 5) 364 -> rejected, preserves existing config & revision
  activeRegisterHandler = async () =>
    Response.json({ traceId: 'trace-364-tpl', code: 364, message: 'template missing' });
  const reg364Res = await requestApi(
    origin,
    '/api/v1/admin/onelink/sso/register',
    'POST',
    {},
    adminCookie,
  );
  expect(reg364Res.status).toBe(200);
  expect((await reg364Res.json()) as AdminOneLinkSsoRegisterView).toMatchObject({
    outcome: 'rejected',
    upstreamCode: 364,
    errorCode: 'ONELINK_CLIENT_TEMPLATE_MISSING',
    traceId: 'trace-364-tpl',
    config: {
      enabled: true,
      clientId: 'miiooRegisteredId',
      registrationStatus: 'registered',
      revision: 6,
    },
  });

  // 6) Upstream transport failure -> failed, preserves existing config & revision
  activeRegisterHandler = async () => {
    throw new Error(`socket failed with ${SYNTHETIC_ENC_KEY}`);
  };
  const regFailRes = await requestApi(
    origin,
    '/api/v1/admin/onelink/sso/register',
    'POST',
    {},
    adminCookie,
  );
  expect(regFailRes.status).toBe(200);
  const regFailText = await regFailRes.text();
  expect(regFailText).not.toContain(SYNTHETIC_ENC_KEY);
  expect(JSON.parse(regFailText) as AdminOneLinkSsoRegisterView).toMatchObject({
    outcome: 'failed',
    upstreamCode: null,
    errorCode: 'ONELINK_REGISTER_UPSTREAM_FAILED',
    traceId: null,
    config: {
      enabled: true,
      clientId: 'miiooRegisteredId',
      registrationStatus: 'registered',
      revision: 6,
    },
  });

  // 7) Concurrent in-flight register -> 409 ONELINK_REGISTER_IN_PROGRESS
  const gate = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  activeRegisterHandler = async () => {
    started.resolve();
    return gate.promise;
  };
  const firstPromise = requestApi(
    origin,
    '/api/v1/admin/onelink/sso/register',
    'POST',
    {},
    adminCookie,
  );
  await started.promise;
  const secondRes = await requestApi(
    origin,
    '/api/v1/admin/onelink/sso/register',
    'POST',
    {},
    adminCookie,
  );
  expect(secondRes.status).toBe(409);
  expect(((await secondRes.json()) as { error: { code: string } }).error.code).toBe(
    'ONELINK_REGISTER_IN_PROGRESS',
  );
  gate.resolve(
    Response.json({
      traceId: 'trace-concurrent-done',
      code: 200,
      data: { clientId: 'miiooRegisteredId', clientName: 'miioo' },
    }),
  );
  expect((await firstPromise).status).toBe(200);

  // 8) Verify audit log entries and redaction
  const auditRows = (
    await pool.query<{
      action: string;
      target_id: string | null;
      summary: string | null;
      before_state: Record<string, unknown> | null;
      after_state: Record<string, unknown> | null;
    }>(
      `SELECT action, target_id, summary, before_state, after_state
       FROM mio_admin_audit_logs
       WHERE action LIKE 'onelink.sso.%'
       ORDER BY created_at ASC`,
    )
  ).rows;
  const serializedAudits = JSON.stringify(auditRows);
  expect(serializedAudits).not.toContain(SYNTHETIC_ENC_KEY);
  expect(serializedAudits).not.toContain('raw-upstream-secret');

  expect(auditRows.filter((row) => row.action === 'onelink.sso.update')).toHaveLength(3);
  expect(auditRows.filter((row) => row.action === 'onelink.sso.register')).toHaveLength(4);
  const failedAudits = auditRows.filter((row) => row.action === 'onelink.sso.register_failed');
  expect(failedAudits).toHaveLength(3);
  expect(failedAudits.map((row) => row.after_state)).toEqual([
    { code: 363, traceId: 'trace-363-bad' },
    { code: 364, traceId: 'trace-364-tpl' },
    { code: null, traceId: null },
  ]);
  for (const row of auditRows) {
    expect(row.target_id).toBe('staging');
  }
});

it('falls back to expectedClientId on 362 when clientId is still null', async () => {
  const store362 = await createAdminStore(
    {
      databaseURL: database.url,
      allowedOrigins: [origin],
      oneLinkSsoEnv: 'expected-362',
    },
    'expected-362',
  );
  const service362 = createAdminService(
    store362,
    providerService,
    ssoProviderConfig('expected-362-v1'),
    undefined,
    undefined,
    undefined,
    {
      ...ssoRuntime('expected-362'),
      registerTransport: async () =>
        Response.json({ traceId: 'trace-362-expected', code: 362, message: 'exists' }),
    },
  );
  try {
    const principal = await service362.authenticate(decodeURIComponent(adminCookie.split('=')[1]!));
    expect(principal).not.toBeNull();
    await service362.updateOneLinkSso(principal!, {
      expectedRevision: 0,
      enabled: true,
      expectedClientId: 'expectedFallbackId',
    });
    const registered = await service362.registerOneLinkSso(principal!);
    expect(registered).toMatchObject({
      outcome: 'already_exists_trusted',
      upstreamCode: 362,
      errorCode: null,
      traceId: 'trace-362-expected',
      config: {
        environment: 'expected-362',
        enabled: true,
        clientId: 'expectedFallbackId',
        expectedClientId: 'expectedFallbackId',
        registrationStatus: 'trusted_existing',
        registrationSource: 'register_362_trusted',
        revision: 2,
      },
    });
  } finally {
    await service362.close();
  }
});

it('aborts in-flight OneLink registration when admin service closes', async () => {
  let aborted = false;
  const started = Promise.withResolvers<void>();
  const ephemeralStore = await createAdminStore(
    {
      databaseURL: database.url,
      allowedOrigins: [origin],
      oneLinkSsoEnv: 'close-test',
    },
    'close-test',
  );
  const ephemeralService = createAdminService(
    ephemeralStore,
    providerService,
    ssoProviderConfig('close-test-v1'),
    undefined,
    undefined,
    undefined,
    {
      ...ssoRuntime('close-test'),
      registerTransport: (_url, init) =>
        new Promise((_resolve, reject) => {
          started.resolve();
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    },
  );
  const principal = await ephemeralService.authenticate(
    decodeURIComponent(adminCookie.split('=')[1]!),
  );
  expect(principal).not.toBeNull();
  const inFlight = ephemeralService.registerOneLinkSso(principal!);
  await started.promise;
  await ephemeralService.close();
  await expect(inFlight).rejects.toThrow('ADMIN_UNAVAILABLE');
  expect(aborted).toBe(true);
});

it('fails plugin startup when OneLink SSO is configured without authentication', async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(NativeExecutor);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  const tokenEnv = 'MIO_TEST_ONELINK_PLUGIN_TOKEN';
  vi.stubEnv(tokenEnv, randomBytes(32).toString('hex'));
  vi.stubEnv('MIO_AUTH_BASE_URL', undefined);
  vi.stubEnv('MIO_AUTH_SECRET', undefined);
  vi.stubEnv('MIO_AUTH_DATABASE_URL', undefined);
  vi.stubEnv('MIO_ONELINK_SSO_ENC_KEY', SYNTHETIC_ENC_KEY);
  vi.stubEnv('MIO_ONELINK_SSO_AUTHORIZE_URL', 'https://scenic.wanlian.cloud/authorize');
  vi.stubEnv('MIO_ONELINK_SSO_REGISTER_URL', 'https://api-test.wanlian.cloud/sso/client/register');
  try {
    await expect(ctx.plugin(Mio, { tokenEnv, allowedOrigins: [] }).await()).rejects.toThrow(
      'ONELINK_SSO_CONFIG: authentication required',
    );
  } finally {
    await ctx.fiber.dispose();
    vi.unstubAllEnvs();
  }
});
