import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as Mio from '../src/plugin.ts';
import { authDatabase } from './auth-database.ts';

const cloud = vi.hoisted(() => ({ origin: '', bytes: new Map<string, Buffer>() }));
vi.mock('../src/integrations/cos.ts', () => ({
  createCosStorage: () => ({
    uploadUrl: (key: string) => `${cloud.origin}/${key}`,
    downloadUrl: (key: string) => `${cloud.origin}/${key}`,
    async head(key: string) {
      const bytes = cloud.bytes.get(key);
      if (!bytes) throw { statusCode: 404 };
      const hash = createHash('sha256').update(bytes).digest('hex');
      return {
        size: bytes.length,
        etag: `${key.startsWith('mio/raw/') ? 'raw' : 'staging'}-${hash}`,
      };
    },
    async copy(source: string, target: string, etag: string) {
      const bytes = cloud.bytes.get(source);
      if (!bytes || `staging-${createHash('sha256').update(bytes).digest('hex')}` !== etag)
        throw { statusCode: 412 };
      cloud.bytes.set(target, Buffer.from(bytes));
    },
    async delete(key: string) {
      cloud.bytes.delete(key);
    },
  }),
}));

let database: Awaited<ReturnType<typeof authDatabase>>;
let observer: Pool;
let ctx: Context;
let objectServer: Server;
let origin: string;
let ownerCookie: string;
let otherCookie: string;
const secret = randomBytes(40).toString('hex');
const password = 'compute-api-test-password-strong';
const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .join('; ');
const call = (path: string, value?: unknown, user = ownerCookie, requestOrigin = origin) =>
  fetch(`${origin}${path}`, {
    method: value === undefined ? 'GET' : 'POST',
    headers: {
      origin: requestOrigin,
      ...(user ? { cookie: user } : {}),
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });

beforeAll(async () => {
  objectServer = createServer(async (request, response) => {
    const key = decodeURIComponent((request.url ?? '').slice(1));
    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      cloud.bytes.set(key, Buffer.concat(chunks));
      response.writeHead(200).end();
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => objectServer.listen(0, '127.0.0.1', resolve));
  const address = objectServer.address();
  if (!address || typeof address === 'string') throw new Error('object test listener missing');
  cloud.origin = `http://127.0.0.1:${address.port}`;
  database = await authDatabase();
  observer = new Pool({ connectionString: database.observerURL });
  ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(NativeExecutor);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  origin = ctx.webServer.getOrigin();
  vi.stubEnv('MIO_API_TOKEN', secret);
  vi.stubEnv('MIO_AUTH_DATABASE_URL', database.url);
  vi.stubEnv('MIO_AUTH_BASE_URL', origin);
  vi.stubEnv('MIO_AUTH_SECRET', secret);
  vi.stubEnv('MIO_AUTH_RATE_LIMIT_BACKEND', 'database');
  vi.stubEnv('MIO_AUTH_ALLOWED_ORIGINS', '[]');
  vi.stubEnv('MIO_ASSETS_DATABASE_URL', database.url);
  vi.stubEnv('MIO_COS_BUCKET', 'mio-test-1234567890');
  vi.stubEnv('MIO_COS_REGION', 'ap-shanghai');
  vi.stubEnv('MIO_COS_SECRET_ID', 'test-id');
  vi.stubEnv('MIO_COS_SECRET_KEY', 'test-key');
  vi.stubEnv('MIO_COMPUTE_ENABLED', 'true');
  vi.stubEnv('RABBITMQ_URL', 'amqp://test-a:test-password@127.0.0.1:1/test');
  vi.stubEnv('MIO_COMPUTE_BROKER_USER', 'test-a');
  vi.stubEnv('MIO_COMPUTE_EXPECTED_RESULT_USER', 'test-b');
  for (const file of [
    'scripts/service/migrate-auth.ts',
    'scripts/service/migrate-assets.ts',
    'scripts/service/migrate-compute.ts',
  ]) {
    const result = spawnSync(process.execPath, [file, '--apply'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  await ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
  const owner = await call(
    '/api/auth/sign-up/email',
    { name: 'Owner', email: 'compute-owner@example.test', password },
    '',
  );
  expect(owner.status).toBe(200);
  ownerCookie = cookie(owner);
  const other = await call(
    '/api/auth/sign-up/email',
    { name: 'Other', email: 'compute-other@example.test', password },
    '',
  );
  expect(other.status).toBe(200);
  otherCookie = cookie(other);
}, 45000);
afterAll(async () => {
  try {
    if (ctx) await ctx.fiber.dispose();
  } finally {
    vi.unstubAllEnvs();
    if (observer) await observer.end();
    if (database) await database.close();
    if (objectServer) await new Promise<void>((resolve) => objectServer.close(() => resolve()));
  }
}, 30000);

it('accepts authenticated jobs and keeps the outbox while the broker is offline', async () => {
  const bytes = Buffer.from('example video');
  const uploadResponse = await call('/api/v1/assets/uploads', {
    filename: 'x.mp4',
    contentType: 'video/mp4',
    size: bytes.length,
  });
  expect(uploadResponse.status).toBe(201);
  const upload = (await uploadResponse.json()) as { assetId: string; uploadUrl: string };
  expect((await fetch(upload.uploadUrl, { method: 'PUT', body: bytes })).status).toBe(200);
  expect((await call(`/api/v1/assets/${upload.assetId}/complete`, {})).status).toBe(200);
  const requestId = randomUUID();
  const body = { requestId, assetId: upload.assetId };
  expect((await call('/api/v1/compute/jobs', body, '')).status).toBe(401);
  expect(
    (await call('/api/v1/compute/jobs', body, ownerCookie, 'https://other.invalid')).status,
  ).toBe(403);
  const response = await call('/api/v1/compute/jobs', body);
  expect(response.status, await response.clone().text()).toBe(202);
  const job = (await response.json()) as { jobId: string; status: string };
  expect(job.status).toBe('accepted');
  expect((await call('/api/v1/compute/jobs', body)).status).toBe(200);
  expect((await call('/api/v1/compute/jobs', { ...body, assetId: randomUUID() })).status).toBe(409);
  expect((await call(`/api/v1/compute/jobs/${job.jobId}`, undefined, otherCookie)).status).toBe(
    404,
  );
  expect((await call(`/api/v1/compute/jobs/${job.jobId}`)).status).toBe(200);
  expect((await fetch(`${origin}/healthz`)).status).toBe(200);
  const persisted = (
    await observer.query<{ input_etag: string; sent_at: Date | null }>(
      'SELECT j.input_etag,o.sent_at FROM mio_compute_jobs j JOIN mio_compute_outbox o ON o.job_id=j.id WHERE j.id=$1',
      [job.jobId],
    )
  ).rows[0]!;
  expect(persisted.input_etag).toBe(`raw-${createHash('sha256').update(bytes).digest('hex')}`);
  expect(persisted.sent_at).toBeNull();
});
