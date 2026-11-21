import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createServer } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { Pool } from 'pg';
import { readLocalEnvironment } from '../../scripts/service/local-environment.ts';
import { readAssetDatabaseURL } from '../../src/assets/config.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { materialSchemaSQL } from '../../src/materials/schema.ts';
import { materialAuthSchemaSQL, checkMaterialAuthSchema } from '../../src/materials/auth-schema.ts';
import {
  createMaterialAuthProxy,
  materialAuthProxyPath,
} from '../../scripts/service/material-auth-proxy.ts';
import * as Mio from '../../src/plugin.ts';
import { auditMaterialAuthResponse } from './auth-live-audit.ts';

assert.equal(process.env.MIO_RUN_LIVE_MATERIAL_AUTH, 'yes', 'MATERIAL_AUTH_LIVE_OPT_IN');
const taskId = process.argv[2],
  binaryArgument = process.argv[3];
assert(taskId && /^[a-z0-9_-]+$/.test(taskId) && binaryArgument, 'MATERIAL_AUTH_LIVE_ARGUMENTS');
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('status', '--porcelain'), '', 'MATERIAL_AUTH_LIVE_CLEAN_CANDIDATE');
const commit = git('rev-parse', 'HEAD');
const task = JSON.parse(await readFile(resolve('.work/tasks', taskId, 'state.json'), 'utf8')) as {
  stage: string;
  checkpoint?: { candidate: { commit: string; contractRevision: number } };
};
assert.equal(task.stage, 'C1_EVIDENCE_PENDING');
assert.equal(task.checkpoint?.candidate.commit, commit);
const binary = await realpath(resolve(binaryArgument));
assert(
  !relative(resolve('.runtime/tools/cloudflared'), binary).startsWith('..'),
  'MATERIAL_AUTH_LIVE_BINARY_SCOPE',
);
assert(
  execFileSync(binary, ['--version'], { encoding: 'utf8' }).startsWith('cloudflared version '),
  'MATERIAL_AUTH_LIVE_BINARY',
);
const candidateDirectory = resolve('.runtime/dev/material-auth-live', commit);
await mkdir(candidateDirectory, { recursive: true, mode: 0o700 });
// Failed tunnel preparations may restart. The external-create guard is shared by every attempt.
const directory = await mkdtemp(resolve(candidateDirectory, 'attempt-'));
const report: {
  candidate: unknown;
  state: string;
  backendOrigin?: string;
  proxyOrigin?: string;
  publicOrigin?: string;
  actions: Record<string, number>;
  publicEvents: { kind: string; queryNames: string[]; statusCode?: number }[];
  observedResultFields?: Record<string, string>;
  observedGroupFields?: Record<string, string>;
  errorCode?: string;
} = { candidate: task.checkpoint!.candidate, state: 'preparing', actions: {}, publicEvents: [] };
const save = () =>
  writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
save();
const stop = Promise.withResolvers<void>();
process.once('SIGTERM', () => stop.resolve());
process.once('SIGINT', () => stop.resolve());
const ctx = new Context(),
  nativeFetch = globalThis.fetch;
let tunnel: ChildProcess | undefined, proxy: ReturnType<typeof createServer> | undefined;
const tunnelClosed = Promise.withResolvers<void>();
let step = 'DATABASE';
try {
  const env = await readLocalEnvironment('dev'),
    url = readAssetDatabaseURL(env.runtime);
  assert(url, 'MATERIAL_AUTH_LIVE_DATABASE');
  const pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 5000,
  });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(assetSchemaSQL);
      await client.query(materialSchemaSQL);
      await client.query(materialAuthSchemaSQL);
      await checkMaterialAuthSchema(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  for (const key of Object.keys(process.env))
    if (/^(MIO_|DSH_|RABBITMQ_)/.test(key)) delete process.env[key];
  Object.assign(process.env, env.runtime);
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
  process.env.MIO_AUTH_BASE_URL = 'http://localhost:4320';
  process.env.MIO_AUTH_ALLOWED_ORIGINS = '[]';
  step = 'LOCAL_PLUGINS';
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(NativeExecutor);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  report.backendOrigin = ctx.webServer.getOrigin();
  const forward = createMaterialAuthProxy(report.backendOrigin);
  proxy = createServer((req, res) => {
    const raw = req.url ?? '',
      path = raw.split('?')[0] ?? '';
    if (
      req.method === 'GET' &&
      materialAuthProxyPath.test(path) &&
      raw.length <= 8192 &&
      report.publicEvents.length < 20
    ) {
      const event: (typeof report.publicEvents)[number] = {
        kind: path.endsWith('/launch') ? 'launch' : 'complete',
        queryNames: [...new URL(raw, 'http://mio.invalid').searchParams.keys()].map((name) =>
          ['bytedToken', 'resultCode'].includes(name) ? name : 'other',
        ),
      };
      report.publicEvents.push(event);
      res.once('finish', () => {
        event.statusCode = res.statusCode;
        save();
      });
      save();
    }
    forward(req, res);
  });
  proxy.maxConnections = 16;
  await new Promise<void>((ok, reject) => {
    proxy!.once('error', reject);
    proxy!.listen(0, '127.0.0.1', ok);
  });
  const address = proxy.address();
  assert(address && typeof address === 'object');
  report.proxyOrigin = `http://127.0.0.1:${address.port}`;
  const assigned = Promise.withResolvers<string>();
  let output = '';
  step = 'TUNNEL';
  tunnel = spawn(
    binary,
    [
      'tunnel',
      '--no-autoupdate',
      '--url',
      report.proxyOrigin,
      '--protocol',
      'http2',
      '--loglevel',
      'info',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-16000);
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) assigned.resolve(match[0]);
  };
  tunnel.stdout?.on('data', capture);
  tunnel.stderr?.on('data', capture);
  tunnel.once('close', () => {
    assigned.reject(new Error('MATERIAL_AUTH_TUNNEL_EXIT'));
    tunnelClosed.resolve();
  });
  tunnel.once('error', () => assigned.reject(new Error('MATERIAL_AUTH_TUNNEL_START')));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    report.publicOrigin = await Promise.race([
      assigned.promise,
      new Promise<never>((_ok, reject) => {
        timer = setTimeout(() => reject(new Error('MATERIAL_AUTH_TUNNEL_TIMEOUT')), 45000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  process.env.MIO_MATERIALS_PUBLIC_BASE_URL = report.publicOrigin;
  const max: Record<string, number> = {
    CreateVisualValidateSession: 1,
    GetVisualValidateResult: 8,
    GetAssetGroup: 8,
  };
  globalThis.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin === 'https://api.onelinkai.cloud') {
      const action = target.searchParams.get('Action')!;
      assert(
        max[action] && (report.actions[action] ?? 0) < max[action],
        'MATERIAL_AUTH_LIVE_ACTION_BUDGET',
      );
      if (action === 'CreateVisualValidateSession')
        await writeFile(
          resolve(candidateDirectory, 'create-session-post.json'),
          JSON.stringify({ state: 'sending', at: new Date().toISOString() }),
          { mode: 0o600, flag: 'wx' },
        );
      report.actions[action] = (report.actions[action] ?? 0) + 1;
      save();
      const response = await nativeFetch(input, init);
      if (action === 'GetVisualValidateResult' || action === 'GetAssetGroup')
        return auditMaterialAuthResponse(
          response,
          action,
          (fields) => {
            if (action === 'GetVisualValidateResult') report.observedResultFields = fields;
            else report.observedGroupFields = fields;
            save();
          },
          init?.signal ?? undefined,
        );
      return response;
    }
    return nativeFetch(input, init);
  };
  step = 'MIO_PLUGIN';
  await ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
  report.state = 'ready';
  save();
  console.log(
    JSON.stringify({
      state: 'ready',
      candidate: report.candidate,
      backendOrigin: report.backendOrigin,
      proxyOrigin: report.proxyOrigin,
      publicOrigin: report.publicOrigin,
      reportPath: resolve(directory, 'report.json'),
    }),
  );
  step = 'TUNNEL_CLOSED';
  await Promise.race([
    stop.promise,
    tunnelClosed.promise.then(() => {
      throw new Error();
    }),
  ]);
} catch {
  report.state = 'failed';
  report.errorCode = `MATERIAL_AUTH_LIVE_${step}`;
  console.error(report.errorCode);
  process.exitCode = 1;
} finally {
  await ctx.fiber.dispose().catch(() => {
    report.state = 'failed';
    process.exitCode = 1;
  });
  globalThis.fetch = nativeFetch;
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise<void>((ok) => proxy!.close(() => ok()));
  }
  if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) {
    tunnel.kill('SIGTERM');
    const timer = setTimeout(() => tunnel!.kill('SIGKILL'), 5000);
    await tunnelClosed.promise;
    clearTimeout(timer);
  }
  if (report.state === 'ready') report.state = 'stopped';
  save();
}
