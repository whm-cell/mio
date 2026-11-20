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

// Explicit live entry: ordinary Vitest never discovers this file or loads dev credentials.
assert.equal(process.env.MIO_RUN_LIVE_MATERIALS, 'yes', 'MATERIAL_LIVE_OPT_IN_REQUIRED');
const taskId = process.argv[2],
  loginFile = process.argv[3];
assert(
  taskId && /^[a-z0-9_-]+$/.test(taskId) && loginFile,
  'MATERIAL_LIVE_TASK_AND_EXISTING_LOGIN_REQUIRED',
);
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('status', '--porcelain'), '', 'MATERIAL_LIVE_CLEAN_CANDIDATE_REQUIRED');
const commit = git('rev-parse', 'HEAD');
const task = JSON.parse(await readFile(resolve('.work/tasks', taskId, 'state.json'), 'utf8')) as {
  stage: string;
  checkpoint?: { candidate: { commit: string; contractRevision: number } };
};
assert.equal(task.stage, 'C1_EVIDENCE_PENDING');
assert.equal(task.checkpoint?.candidate.commit, commit);
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
const report: {
  candidate: unknown;
  status: string;
  actions: Record<string, number>;
  observations: unknown[];
  errorCode?: string;
} = { candidate: task.checkpoint!.candidate, status: 'running', actions: {}, observations: [] };
const save = () =>
  writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
await save();
const environment = await readLocalEnvironment('dev');
const databaseURL = readAssetDatabaseURL(environment.runtime);
assert(databaseURL, 'MATERIAL_LIVE_MEDIA_CONFIG_REQUIRED');
const pool = new Pool({
  connectionString: databaseURL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
  query_timeout: 5000,
});
const nativeFetch = globalThis.fetch;
const ctx = new Context();
try {
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
  report.observations.push({ migration: 'three tables checked; existing assets retained' });
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
  process.env.MIO_MATERIALS_ENABLED = 'true';
  process.env.MIO_AUTH_RATE_LIMIT_BACKEND = 'database';
  const max: Record<string, number> = {
    CreateAssetGroup: 1,
    UpdateAssetGroup: 1,
    DeleteAssetGroup: 1,
    GetAssetGroup: 3,
    ListAssets: 1,
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === 'https://api.onelinkai.cloud') {
      const action = url.searchParams.get('Action')!;
      assert(
        max[action] && (report.actions[action] ?? 0) < max[action],
        'MATERIAL_LIVE_ACTION_BUDGET',
      );
      report.actions[action] = (report.actions[action] ?? 0) + 1;
      await save();
    }
    return nativeFetch(input, init);
  };
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(NativeExecutor);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  const origin = ctx.webServer.getOrigin();
  process.env.MIO_AUTH_BASE_URL = origin;
  process.env.MIO_AUTH_ALLOWED_ORIGINS = '[]';
  await ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
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
    name: `Mio Unit1 bounded check ${commit.slice(0, 8)}`,
  });
  report.observations.push({ create: created });
  await save();
  assert(
    created.group && created.operation.state === 'succeeded',
    'MATERIAL_LIVE_CREATE_UNCONFIRMED',
  );
  const group = created.group;
  const renamed = await call<GroupView>(
    `/groups/${group.groupId}`,
    { revision: group.revision, name: 'Mio Unit1 bounded check renamed' },
    'PATCH',
  );
  report.observations.push({ rename: renamed });
  await save();
  const sync = await call<{ group: GroupView; syncedCount: number }>(
    `/groups/${group.groupId}/sync`,
    {},
  );
  report.observations.push({ sync });
  await save();
  assert.equal(sync.syncedCount, 0);
  const deleted = await call<{ operation: OperationView }>(`/groups/${group.groupId}/delete`, {
    requestId: randomUUID(),
    revision: renamed.revision,
    scope: 'upstream',
  });
  report.observations.push({ delete: deleted });
  await save();
  assert.equal(deleted.operation.state, 'succeeded', 'MATERIAL_LIVE_DELETE_UNCONFIRMED');
  const operation = await call<OperationView>(`/operations/${deleted.operation.operationId}`);
  assert.equal(operation.state, 'succeeded');
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
