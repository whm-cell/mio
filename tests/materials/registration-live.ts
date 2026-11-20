import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import sharp from 'sharp';
import { Pool } from 'pg';
import { readLocalEnvironment } from '../../scripts/service/local-environment.ts';
import { readAssetDatabaseURL } from '../../src/assets/config.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { materialSchemaSQL, checkMaterialSchema } from '../../src/materials/schema.ts';
import * as Mio from '../../src/plugin.ts';

// Preparation only starts the formal HTTP service. Browser controls real asset PUT and registration.
assert.equal(
  process.env.MIO_RUN_LIVE_MATERIAL_REGISTRATION,
  'yes',
  'MATERIAL_REGISTRATION_LIVE_OPT_IN',
);
const taskId = process.argv[2];
assert(taskId && /^[a-z0-9_-]+$/.test(taskId), 'MATERIAL_REGISTRATION_LIVE_TASK');
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('status', '--porcelain'), '', 'MATERIAL_REGISTRATION_LIVE_CLEAN_CANDIDATE');
const commit = git('rev-parse', 'HEAD');
const task = JSON.parse(await readFile(resolve('.work/tasks', taskId, 'state.json'), 'utf8')) as {
  stage: string;
  checkpoint?: { candidate: { commit: string; contractRevision: number } };
};
assert.equal(task.stage, 'C1_EVIDENCE_PENDING');
assert.equal(task.checkpoint?.candidate.commit, commit);
const directory = resolve('.runtime/dev/material-registration-live', commit);
await mkdir(resolve('.runtime/dev/material-registration-live'), { recursive: true, mode: 0o700 });
await mkdir(directory, { mode: 0o700 });
const report: {
  candidate: unknown;
  state: string;
  backendOrigin?: string;
  demoOrigin: string;
  imagePath?: string;
  actions: Record<string, number>;
  errorCode?: string;
} = {
  candidate: task.checkpoint!.candidate,
  state: 'preparing',
  demoOrigin: 'http://localhost:4320',
  actions: {},
};
const save = () =>
  writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
await save();
const environment = await readLocalEnvironment('dev');
const databaseURL = readAssetDatabaseURL(environment.runtime);
assert(databaseURL);
const pool = new Pool({
  connectionString: databaseURL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
  query_timeout: 5000,
});
const ctx = new Context();
const nativeFetch = globalThis.fetch;
let stopping = false;
const stop = Promise.withResolvers<void>();
const requestStop = () => {
  if (!stopping) {
    stopping = true;
    stop.resolve();
  }
};
process.once('SIGTERM', requestStop);
process.once('SIGINT', requestStop);
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(assetSchemaSQL);
    await client.query(materialSchemaSQL);
    await checkMaterialSchema(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  for (const key of Object.keys(process.env))
    if (/^(MIO_|DSH_|RABBITMQ_)/.test(key)) delete process.env[key];
  Object.assign(process.env, environment.runtime);
  for (const key of Object.keys(process.env))
    if (
      /^(MIO_COMPUTE_|MIO_GENERATIONS_|MIO_CONVERSATIONS_|MIO_AUTH_SMS_|MIO_TENCENT_|MIO_AUTH_WECHAT_)/.test(
        key,
      )
    )
      delete process.env[key];
  delete process.env.RABBITMQ_URL;
  process.env.MIO_MATERIALS_ENABLED = 'true';
  process.env.MIO_AUTH_RATE_LIMIT_BACKEND = 'database';
  process.env.MIO_AUTH_BASE_URL = report.demoOrigin;
  process.env.MIO_AUTH_ALLOWED_ORIGINS = '[]';
  const max: Record<string, number> = {
    CreateAssetGroup: 1,
    GetAssetGroup: 16,
    CreateAsset: 1,
    GetAsset: 8,
    ListAssets: 3,
    UpdateAssetGroup: 1,
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === 'https://api.onelinkai.cloud') {
      const action = url.searchParams.get('Action')!;
      assert(
        max[action] && (report.actions[action] ?? 0) < max[action],
        'MATERIAL_REGISTRATION_LIVE_ACTION_BUDGET',
      );
      if (action === 'CreateAsset' || action === 'CreateAssetGroup')
        await writeFile(
          resolve(directory, `${action}-post.json`),
          JSON.stringify({ state: 'sending', at: new Date().toISOString() }),
          { mode: 0o600, flag: 'wx' },
        );
      report.actions[action] = (report.actions[action] ?? 0) + 1;
      await save();
    }
    return nativeFetch(input, init);
  };
  report.imagePath = resolve(directory, 'synthetic-512.png');
  await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 72, g: 112, b: 156 } },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="512" height="512"><circle cx="256" cy="210" r="100" fill="#e7b392"/><rect x="140" y="320" width="232" height="180" rx="30" fill="#e9eef4"/></svg>',
        ),
      },
    ])
    .png()
    .toFile(report.imagePath);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(NativeExecutor);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
  report.backendOrigin = ctx.webServer.getOrigin();
  report.state = 'ready';
  await save();
  console.log(
    JSON.stringify({
      state: 'ready',
      candidate: report.candidate,
      backendOrigin: report.backendOrigin,
      demoOrigin: report.demoOrigin,
      imagePath: report.imagePath,
      reportPath: resolve(directory, 'report.json'),
    }),
  );
  await stop.promise;
} catch {
  report.state = 'failed';
  report.errorCode = 'MATERIAL_REGISTRATION_LIVE_FAILED';
  process.exitCode = 1;
} finally {
  await ctx.fiber.dispose().catch(() => {
    report.state = 'failed';
    process.exitCode = 1;
  });
  globalThis.fetch = nativeFetch;
  await pool.end();
  if (report.state === 'ready') report.state = 'stopped';
  await save();
}
