import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { Pool } from 'pg';
import { readLocalEnvironment } from '../../scripts/service/local-environment.ts';
import { readAssetDatabaseURL } from '../../src/assets/config.ts';
import { materialSchemaSQL, checkMaterialSchema } from '../../src/materials/schema.ts';
import * as Mio from '../../src/plugin.ts';
import type { GroupView, OperationView } from '../../src/materials/contracts.ts';
import { observeMaterialLiveResponse } from './live-response-audit.ts';

// Explicit live entry: ordinary Vitest never discovers this file or loads dev credentials.
assert.equal(process.env.MIO_RUN_LIVE_MATERIALS, 'yes', 'MATERIAL_LIVE_OPT_IN_REQUIRED');
const taskId = process.argv[2],
  loginFile = process.argv[3];
const devRoot = resolve(process.argv[4] ?? '.');
const confirmCascade = process.env.MIO_MATERIALS_LIVE_CONFIRM_CASCADE === 'yes';
assert(
  taskId && /^[a-z0-9_-]+$/.test(taskId) && loginFile,
  'MATERIAL_LIVE_TASK_AND_EXISTING_LOGIN_REQUIRED',
);
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('status', '--porcelain'), '', 'MATERIAL_LIVE_CLEAN_CANDIDATE_REQUIRED');
const commit = git('rev-parse', 'HEAD');
const task = JSON.parse(await readFile(resolve('.work/tasks', taskId, 'state.json'), 'utf8')) as {
  stage: string;
  contractRevision: number;
  checkpoint?: { candidate: { commit: string; contractRevision: number } };
};
assert.equal(task.stage, 'C1_EVIDENCE_PENDING');
assert.equal(task.checkpoint?.candidate.commit, commit);
assert.equal(task.checkpoint?.candidate.contractRevision, task.contractRevision);
const loginText = await readFile(resolve(loginFile), 'utf8');
assert(Buffer.byteLength(loginText) <= 8192, 'MATERIAL_LIVE_LOGIN_SIZE');
const login = JSON.parse(loginText) as { email?: unknown; password?: unknown };
assert(
  typeof login.email === 'string' && typeof login.password === 'string',
  'MATERIAL_LIVE_EXISTING_LOGIN_REQUIRED',
);
const directory = resolve('.runtime/dev/materials-unit1-live', commit);
await mkdir(resolve('.runtime/dev/materials-unit1-live'), { recursive: true, mode: 0o700 });
await mkdir(directory, { mode: 0o700 }); // Existing audit is a stop: never repeat a possibly sent creation.
type UpstreamCall = {
  action: string;
  step: string;
  targetMatched: boolean;
  nameMatched?: boolean;
  requestPage?: { number: number; size: number };
  httpStatus?: number;
  accepted?: boolean;
  returnedRenamedName?: boolean;
  responsePage?: { number: number; size: number; total: number };
};
const report: {
  candidate: unknown;
  mode: 'management' | 'confirmed-cascade';
  status: string;
  actions: Record<string, number>;
  upstream: UpstreamCall[];
  blockedCalls: number;
  observations: unknown[];
  errorCode?: string;
} = {
  candidate: task.checkpoint!.candidate,
  mode: confirmCascade ? 'confirmed-cascade' : 'management',
  status: 'running',
  actions: {},
  upstream: [],
  blockedCalls: 0,
  observations: [],
};
const save = () =>
  writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
await save();
const environment = await readLocalEnvironment('dev', devRoot);
const databaseURL = readAssetDatabaseURL(environment.runtime);
assert(databaseURL, 'MATERIAL_LIVE_MEDIA_CONFIG_REQUIRED');
const database = new URL(databaseURL);
assert(
  database.hostname === '127.0.0.1' &&
    database.port === environment.values.MIO_LOCAL_POSTGRES_PORT &&
    ['/mio_assets_dev', '/mio_dev'].includes(database.pathname),
  'MATERIAL_LIVE_DATABASE_TARGET',
);
const pool = new Pool({
  connectionString: databaseURL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
  query_timeout: 5000,
});
const nativeFetch = globalThis.fetch;
const ctx = new Context();
const createName = `Mio material management ${commit.slice(0, 8)}`;
const renameName = `${createName} renamed`;
let upstreamGroupId: string | undefined;
let step = 'create';
try {
  const identity = await pool.query<{ database: string; username: string }>(
    'SELECT current_database() AS database, current_user AS username',
  );
  assert(
    identity.rows[0]?.database === database.pathname.slice(1) &&
      identity.rows[0]?.username === 'mio',
    'MATERIAL_LIVE_DATABASE_IDENTITY',
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(materialSchemaSQL);
    await checkMaterialSchema(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  report.observations.push({ database: identity.rows[0], migration: 'three tables checked' });
  await save();
  for (const key of Object.keys(process.env))
    if (/^(MIO_|DSH_|RABBITMQ_)/.test(key)) delete process.env[key];
  Object.assign(process.env, environment.runtime);
  // This bounded fixture serves metadata only. It cannot run asset staging cleanup or model work.
  for (const key of Object.keys(process.env))
    if (
      /^(MIO_COS_|MIO_COMPUTE_|MIO_GENERATIONS_|MIO_CONVERSATIONS_|MIO_AUTH_SMS_|MIO_TENCENT_|MIO_AUTH_WECHAT_)/.test(
        key,
      )
    )
      delete process.env[key];
  delete process.env.RABBITMQ_URL;
  delete process.env.MIO_MATERIALS_PUBLIC_BASE_URL;
  process.env.MIO_MATERIALS_ENABLED = 'true';
  process.env.MIO_AUTH_RATE_LIMIT_BACKEND = 'database';
  process.env.DSH_HOME = resolve('.runtime/dev/dsh');
  process.env.DSH_AGENTS_HOME = resolve('.runtime/dev/dsh/agents');
  const max: Record<string, number> = {
    CreateAssetGroup: 1,
    UpdateAssetGroup: 1,
    DeleteAssetGroup: confirmCascade ? 1 : 0,
    GetAssetGroup: confirmCascade ? 4 : 2,
    ListAssets: 1,
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://api.onelinkai.cloud') return nativeFetch(input, init);
    const action = url.searchParams.get('Action') ?? '';
    if (
      !Number.isInteger(max[action]) ||
      (report.actions[action] ?? 0) >= max[action]! ||
      url.pathname !== '/volc/openapi' ||
      url.searchParams.get('Version') !== '2024-01-01' ||
      init?.method !== 'POST'
    ) {
      report.blockedCalls += 1;
      await save();
      throw new Error('MATERIAL_LIVE_ACTION_BUDGET');
    }
    const request = JSON.parse(String(init?.body)) as {
      Id?: unknown;
      Name?: unknown;
      GroupType?: unknown;
      Filter?: { GroupIds?: unknown };
      PageNumber?: unknown;
      PageSize?: unknown;
    };
    const groupIds = request.Filter?.GroupIds;
    const targetMatched =
      action === 'CreateAssetGroup'
        ? request.GroupType === 'AIGC'
        : Boolean(
            upstreamGroupId &&
            (action === 'ListAssets'
              ? Array.isArray(groupIds) && groupIds.length === 1 && groupIds[0] === upstreamGroupId
              : request.Id === upstreamGroupId),
          );
    const expectedName =
      action === 'CreateAssetGroup'
        ? createName
        : action === 'UpdateAssetGroup'
          ? renameName
          : undefined;
    const nameMatched = expectedName === undefined ? undefined : request.Name === expectedName;
    const isPage = action === 'ListAssets';
    const pageMatched = request.PageNumber === 1 && request.PageSize === 100;
    if (!targetMatched || nameMatched === false || (isPage && !pageMatched)) {
      report.blockedCalls += 1;
      await save();
      throw new Error('MATERIAL_LIVE_REQUEST_SCOPE');
    }
    const call: UpstreamCall = {
      action,
      step,
      targetMatched,
      ...(nameMatched === undefined ? {} : { nameMatched }),
      ...(isPage ? { requestPage: { number: 1, size: 100 } } : {}),
    };
    report.actions[action] = (report.actions[action] ?? 0) + 1;
    report.upstream.push(call);
    await save();
    const response = await nativeFetch(input, init);
    call.httpStatus = response.status;
    return observeMaterialLiveResponse(
      response,
      (value) => {
        const body = value as {
          ResponseMetadata?: {
            Action?: unknown;
            Version?: unknown;
            Service?: unknown;
            Error?: unknown;
          };
          Result?: Record<string, unknown>;
        } | null;
        const metadata = body?.ResponseMetadata;
        const result = body?.Result;
        if (
          !response.ok ||
          metadata?.Action !== action ||
          metadata.Version !== '2024-01-01' ||
          metadata.Service !== 'ark' ||
          metadata.Error !== undefined ||
          !result
        )
          return;
        if (action === 'CreateAssetGroup' && typeof result.Id === 'string') {
          upstreamGroupId = result.Id;
          call.accepted = true;
        }
        if (action === 'UpdateAssetGroup' || action === 'GetAssetGroup') {
          call.accepted = result.Id === upstreamGroupId;
          if (action === 'GetAssetGroup' && call.step === 'sync')
            call.returnedRenamedName = result.Name === renameName;
        }
        if (
          isPage &&
          result.PageNumber === 1 &&
          typeof result.PageSize === 'number' &&
          typeof result.TotalCount === 'number'
        ) {
          call.responsePage = {
            number: result.PageNumber,
            size: result.PageSize,
            total: result.TotalCount,
          };
          call.accepted =
            Array.isArray(result.Items) && result.Items.length === 0 && result.TotalCount === 0;
        }
      },
      init?.signal ?? undefined,
    );
  };
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(NativeExecutor);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  const origin = ctx.webServer.getOrigin();
  process.env.MIO_AUTH_BASE_URL = origin;
  process.env.MIO_AUTH_ALLOWED_ORIGINS = JSON.stringify([origin]);
  await ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [origin] });
  const loginResponse = await nativeFetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: login.email, password: login.password }),
  });
  assert.equal(loginResponse.status, 200, 'MATERIAL_LIVE_LOGIN_FAILED');
  const cookie = loginResponse.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert(cookie, 'MATERIAL_LIVE_COOKIE_REQUIRED');
  const call = async <T>(
    path: string,
    value?: unknown,
    method = value === undefined ? 'GET' : 'POST',
  ): Promise<T> => {
    const response = await nativeFetch(`${origin}/api/v1/materials${path}`, {
      method,
      headers: {
        origin,
        cookie,
        ...(value !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
      signal: AbortSignal.timeout(80_000),
    });
    const body = (await response.json()) as T & { error?: { code?: string } };
    assert(response.ok, `MATERIAL_LIVE_HTTP_${response.status}_${body.error?.code ?? 'FAILED'}`);
    return body;
  };
  report.observations.push({ login: 'existing owner Cookie accepted; no credential write' });
  await save();
  const created = await call<{ group?: GroupView; operation: OperationView }>('/groups', {
    requestId: randomUUID(),
    type: 'aigc',
    name: createName,
  });
  assert(
    created.group &&
      created.operation.state === 'succeeded' &&
      created.group.type === 'aigc' &&
      created.group.name === createName &&
      created.group.state === 'ready',
    'MATERIAL_LIVE_CREATE_UNCONFIRMED',
  );
  const group = created.group;
  report.observations.push({
    create: {
      groupId: group.groupId,
      name: group.name,
      revision: group.revision,
      operationId: created.operation.operationId,
    },
  });
  await save();
  step = 'rename';
  const renamed = await call<GroupView>(
    `/groups/${group.groupId}`,
    { revision: group.revision, name: renameName },
    'PATCH',
  );
  report.observations.push({
    rename: { groupId: renamed.groupId, name: renamed.name, revision: renamed.revision },
  });
  await save();
  assert(
    renamed.groupId === group.groupId &&
      renamed.name === renameName &&
      renamed.revision === group.revision + 1 &&
      renamed.lastSyncStatus === null &&
      renamed.lastSyncedAt === null,
    'MATERIAL_LIVE_RENAME_UNCONFIRMED',
  );
  step = 'sync';
  const startedSync = (
    await pool.query<{ started_at: Date }>('SELECT clock_timestamp() AS started_at')
  ).rows[0]!.started_at;
  const sync = await call<{ group: GroupView; syncedCount: number; nextCursor: string | null }>(
    `/groups/${group.groupId}/sync`,
    {},
  );
  report.observations.push({
    sync: {
      groupId: sync.group.groupId,
      syncedCount: sync.syncedCount,
      nextCursor: sync.nextCursor,
      status: sync.group.lastSyncStatus,
      at: sync.group.lastSyncedAt,
    },
  });
  await save();
  assert(
    sync.group.groupId === group.groupId &&
      sync.syncedCount === 0 &&
      sync.nextCursor === null &&
      sync.group.lastSyncStatus === 'succeeded' &&
      sync.group.lastSyncErrorCode === null &&
      Date.parse(sync.group.lastSyncedAt ?? '') >= startedSync.getTime(),
    'MATERIAL_LIVE_SYNC_UNCONFIRMED',
  );
  step = 'read';
  const read = await call<GroupView>(`/groups/${group.groupId}`);
  report.observations.push({
    read: {
      groupId: read.groupId,
      name: read.name,
      revision: read.revision,
      status: read.lastSyncStatus,
      at: read.lastSyncedAt,
    },
  });
  await save();
  assert(
    read.groupId === group.groupId &&
      read.state === 'ready' &&
      read.name === renameName &&
      read.revision === renamed.revision &&
      read.lastSyncStatus === 'succeeded' &&
      read.lastSyncErrorCode === null &&
      read.lastSyncedAt === sync.group.lastSyncedAt,
    'MATERIAL_LIVE_READBACK_UNCONFIRMED',
  );
  const expectedActions = [
    'CreateAssetGroup',
    'GetAssetGroup',
    'UpdateAssetGroup',
    'GetAssetGroup',
    'ListAssets',
  ];
  assert(
    report.upstream.length === expectedActions.length &&
      report.upstream.every(
        (call, index) => call.action === expectedActions[index] && call.accepted,
      ) &&
      report.upstream.some(
        (call) =>
          call.action === 'GetAssetGroup' && call.step === 'sync' && call.returnedRenamedName,
      ),
    'MATERIAL_LIVE_UPSTREAM_UNCONFIRMED',
  );
  if (confirmCascade) {
    step = 'delete';
    const deleted = await call<{ operation: OperationView }>(`/groups/${group.groupId}/delete`, {
      requestId: randomUUID(),
      revision: renamed.revision,
      scope: 'upstream',
      confirmCascade: true,
    });
    report.observations.push({
      delete: { state: deleted.operation.state, operationId: deleted.operation.operationId },
    });
    await save();
    assert.equal(deleted.operation.state, 'succeeded', 'MATERIAL_LIVE_DELETE_UNCONFIRMED');
    const operation = await call<OperationView>(`/operations/${deleted.operation.operationId}`);
    assert.equal(operation.state, 'succeeded', 'MATERIAL_LIVE_DELETE_READBACK_UNCONFIRMED');
  } else {
    assert.equal(report.actions.DeleteAssetGroup ?? 0, 0, 'MATERIAL_LIVE_DELETE_FORBIDDEN');
  }
  assert.equal(report.blockedCalls, 0, 'MATERIAL_LIVE_ACTION_BUDGET');
  report.status = 'pass';
  await save();
  console.log('MATERIAL_UNIT1_LIVE_HTTP_MANAGEMENT_PASS');
} catch (error) {
  report.status = 'fail';
  const message = error instanceof Error ? error.message : '';
  report.errorCode = /^MATERIAL_LIVE_[A-Z0-9_]+$/.test(message)
    ? message
    : 'MATERIAL_LIVE_CHECK_FAILED';
  await save();
  console.log(report.errorCode);
  process.exitCode = 1;
} finally {
  await ctx.fiber.dispose().catch(() => {
    report.status = 'fail';
    process.exitCode = 1;
  });
  globalThis.fetch = nativeFetch;
  await pool.end();
  await save();
}
