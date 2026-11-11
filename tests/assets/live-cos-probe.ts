import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { Pool } from 'pg';
import * as Mio from '../../src/plugin.ts';
import { authDatabase } from '../support/auth-database.ts';

// Explicitly invoked against the authorized private test bucket, never by the ordinary test suite.
if (process.env.MIO_RUN_COS_PROBE !== 'yes')
  throw new Error('LIVE_COS_PROBE_REQUIRES_EXPLICIT_TEST_ENV');
if (
  !process.env.MIO_COS_BUCKET ||
  !process.env.MIO_COS_REGION ||
  !process.env.MIO_COS_SECRET_ID ||
  !process.env.MIO_COS_SECRET_KEY
)
  throw new Error('LIVE_COS_PROBE_CONFIG_REQUIRED');
delete process.env.MIO_COMPUTE_ENABLED;
let phase = 'database';
let database: Awaited<ReturnType<typeof authDatabase>> | undefined;
let observer: Pool | undefined;
let ctx: Context | undefined;
try {
  database = await authDatabase();
  observer = new Pool({ connectionString: database.observerURL });
  ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(NativeExecutor);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  const origin = ctx.webServer.getOrigin();
  const secret = randomBytes(40).toString('hex');
  process.env.MIO_API_TOKEN = secret;
  process.env.MIO_AUTH_DATABASE_URL = database.url;
  process.env.MIO_AUTH_BASE_URL = origin;
  process.env.MIO_AUTH_SECRET = secret;
  process.env.MIO_AUTH_RATE_LIMIT_BACKEND = 'database';
  process.env.MIO_AUTH_ALLOWED_ORIGINS = '[]';
  process.env.MIO_ASSETS_DATABASE_URL = database.url;
  for (const file of ['scripts/service/migrate-auth.ts', 'scripts/service/migrate-assets.ts']) {
    const result = spawnSync(process.execPath, [file, '--apply'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    if (result.status !== 0) throw new Error('MIGRATION_FAILED');
  }
  phase = 'plugin';
  await ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
  const post = (path: string, value: unknown, cookie = '') =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(value),
    });
  phase = 'signup';
  const signup = await post('/api/auth/sign-up/email', {
    name: 'COS test',
    email: `cos-${randomUUID()}@example.test`,
    password: randomBytes(24).toString('hex'),
  });
  if (signup.status !== 200) throw new Error('SIGNUP_FAILED');
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  if (!cookie) throw new Error('COOKIE_MISSING');
  const bytes = Buffer.from('mio private COS live upload probe\n');
  phase = 'upload-request';
  const created = await post(
    '/api/v1/assets/uploads',
    { filename: 'probe.mp4', contentType: 'video/mp4', size: bytes.length },
    cookie,
  );
  if (created.status !== 201) throw new Error('UPLOAD_REQUEST_FAILED');
  const asset = (await created.json()) as { assetId: string; uploadUrl: string };
  const manifestPath = `.work/tooling/live-cos-${asset.assetId}.json`;
  const manifest = {
    assetId: asset.assetId,
    bucket: process.env.MIO_COS_BUCKET,
    stagingKey: `mio/staging/${asset.assetId}`,
    rawKey: null as string | null,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
  phase = 'direct-put';
  const put = await fetch(asset.uploadUrl, { method: 'PUT', body: bytes });
  if (!put.ok) throw new Error('DIRECT_PUT_FAILED');
  phase = 'complete';
  const completed = await post(`/api/v1/assets/${asset.assetId}/complete`, {}, cookie);
  if (completed.status !== 200) throw new Error('COMPLETE_FAILED');
  const row = (
    await observer.query<{ raw_key: string }>('SELECT raw_key FROM mio_assets WHERE id=$1', [
      asset.assetId,
    ])
  ).rows[0];
  if (!row?.raw_key) throw new Error('RAW_KEY_MISSING');
  manifest.rawKey = row.raw_key;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  phase = 'read';
  const lookup = await fetch(`${origin}/api/v1/assets/${asset.assetId}`, {
    headers: { cookie, origin },
  });
  if (lookup.status !== 200) throw new Error('LOOKUP_FAILED');
  const view = (await lookup.json()) as { status: string; downloadUrl: string; size: number };
  if (view.status !== 'ready' || view.size !== bytes.length) throw new Error('VIEW_MISMATCH');
  const downloaded = await fetch(view.downloadUrl);
  if (!downloaded.ok || !Buffer.from(await downloaded.arrayBuffer()).equals(bytes))
    throw new Error('DOWNLOAD_MISMATCH');
  console.log(
    `LIVE_COS_PROBE_OK assetId=${asset.assetId} manifest=${manifestPath} bytes=${bytes.length}`,
  );
} catch {
  console.error(`LIVE_COS_PROBE_FAILED phase=${phase}`);
  process.exitCode = 1;
} finally {
  if (ctx) await ctx.fiber.dispose();
  if (observer) await observer.end();
  if (database) await database.close();
}
