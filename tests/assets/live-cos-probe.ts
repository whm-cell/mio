import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import {
  authenticateOrCreateRetainedDevOwner,
  createPersistentDevProfileController,
  parseLiveAuthInput,
  preparePersistentDevEnvironment,
} from '../support/local-dev-live.ts';

// Explicitly invoked against persistent mio_dev and its authorized private COS bucket; retains the mio_assets row.
if (process.env.MIO_RUN_COS_PROBE !== 'yes')
  throw new Error('LIVE_COS_PROBE_REQUIRES_EXPLICIT_TEST_ENV');

let phase = 'dev-environment';
let observer: Pool | undefined;
let runtime: Awaited<ReturnType<typeof createPersistentDevProfileController>> | undefined;

try {
  const loginFile = process.argv[2];
  const dev = await preparePersistentDevEnvironment(['auth', 'assets']);
  const env = dev.runtimeEnv;
  if (
    !env.MIO_COS_BUCKET ||
    !env.MIO_COS_REGION ||
    !env.MIO_COS_SECRET_ID ||
    !env.MIO_COS_SECRET_KEY
  ) {
    throw new Error('LIVE_COS_PROBE_CONFIG_REQUIRED: configure MIO_COS_* in .env');
  }
  delete env.MIO_COMPUTE_ENABLED;

  observer = new Pool({ connectionString: env.MIO_ASSETS_DATABASE_URL ?? dev.databaseUrl });
  runtime = await createPersistentDevProfileController(env, dev.origin);
  phase = 'profile-start';
  await runtime.start();
  const origin = runtime.origin;

  phase = 'auth';
  const authInput = loginFile
    ? await parseLiveAuthInput(loginFile)
    : { kind: 'apiKey' as const, apiKey: 'unused' };
  const owner = await authenticateOrCreateRetainedDevOwner(origin, authInput, 'cos-probe');
  const cookie = owner.cookie;

  const post = (path: string, value: unknown) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', cookie },
      body: JSON.stringify(value),
    });

  const bytes = Buffer.from('mio private COS live upload probe\n');
  phase = 'upload-request';
  const created = await post('/api/v1/assets/uploads', {
    filename: 'probe.mp4',
    contentType: 'video/mp4',
    size: bytes.length,
  });
  if (created.status !== 201) throw new Error('UPLOAD_REQUEST_FAILED');
  const asset = (await created.json()) as { assetId: string; uploadUrl: string };
  await mkdir('.runtime/dev/cos-probes', { recursive: true, mode: 0o700 });
  const manifestPath = `.runtime/dev/cos-probes/live-cos-${asset.assetId}.json`;
  const manifest = {
    environment: 'mio_dev',
    retainedInDatabase: true,
    ownerId: owner.userId,
    assetId: asset.assetId,
    bucket: env.MIO_COS_BUCKET,
    stagingKey: `mio/staging/${asset.assetId}`,
    rawKey: null as string | null,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });

  phase = 'direct-put';
  const put = await fetch(asset.uploadUrl, { method: 'PUT', body: bytes });
  if (!put.ok) throw new Error('DIRECT_PUT_FAILED');

  phase = 'complete';
  const completed = await post(`/api/v1/assets/${asset.assetId}/complete`, {});
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
    `LIVE_COS_PROBE_OK environment=mio_dev assetId=${asset.assetId} manifest=${manifestPath} bytes=${bytes.length}`,
  );
} catch {
  console.error(`LIVE_COS_PROBE_FAILED phase=${phase}`);
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.close();
  if (observer) await observer.end();
}
