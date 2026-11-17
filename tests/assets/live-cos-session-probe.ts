import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import COS from 'cos-nodejs-sdk-v5';
import sharp from 'sharp';
import { imageOutputKey } from '../../src/generations/contracts.ts';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { readAssetConfig } from '../../src/assets/config.ts';

// Explicit opt-in only. Version 2 probes A image storage with a private temporary credential file.
// The legacy worker image phase was retired when cloud generation moved into A.
if (process.env.MIO_RUN_COS_SESSION_PROBE !== 'yes') throw new Error('COS_SESSION_PROBE_OPT_IN');
const [phase, directoryArgument, credentialPath, ...extra] = process.argv.slice(2);
if (phase === 'worker') throw new Error('COS_SESSION_PROBE_LEGACY_IMAGE_WORKER_RETIRED');
if (!['init', 'app'].includes(phase ?? '') || !directoryArgument || extra.length)
  throw new Error('COS_SESSION_PROBE_ARGUMENTS');
const directory = resolve(directoryArgument);
const root = resolve('.runtime');
if (!directory.startsWith(`${root}${sep}`)) throw new Error('COS_SESSION_PROBE_PRIVATE_DIRECTORY');
const manifestPath = resolve(directory, 'manifest.json');
type Observation = { operation: string; state: string; status?: number | null };
type Manifest = {
  version: 2;
  runId: string;
  jobId: string;
  imageId: string;
  bucketFingerprint?: string;
  appIdentityFingerprint?: string;
  expected?: { size: number; sha256: string; etag: string };
  observations: Observation[];
};
async function save(manifest: Manifest) {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}
async function main() {
  if (phase === 'init') {
    if (credentialPath) throw new Error('COS_SESSION_PROBE_ARGUMENTS');
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    const manifest: Manifest = {
      version: 2,
      runId: randomUUID(),
      jobId: randomUUID(),
      imageId: randomUUID(),
      observations: [],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    console.log('COS_SESSION_PROBE_INITIALIZED');
    return;
  }
  if (!credentialPath) throw new Error('COS_SESSION_PROBE_PRIVATE_ENV_REQUIRED');
  const stat = await lstat(credentialPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error('COS_SESSION_PROBE_PRIVATE_ENV_REQUIRED');
  const env = parseEnv(await readFile(credentialPath, 'utf8'));
  const config = readAssetConfig({
    ...env,
    MIO_ASSETS_DATABASE_URL: 'postgresql://localhost/mio_probe',
  });
  if (!config?.sessionToken) throw new Error('COS_SESSION_PROBE_TEMPORARY_CREDENTIAL_REQUIRED');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  if (
    manifest.version !== 2 ||
    !manifest.jobId ||
    !manifest.imageId ||
    !Array.isArray(manifest.observations)
  )
    throw new Error('COS_SESSION_PROBE_MANIFEST_INVALID');
  const record = async (operation: string, state: string, status?: number | null) => {
    manifest.observations.push({ operation, state, ...(status === undefined ? {} : { status }) });
    await save(manifest);
  };
  const once = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    if (manifest.observations.some((item) => item.operation === name))
      throw new Error('COS_SESSION_PROBE_ALREADY_ATTEMPTED');
    await record(name, 'started');
    try {
      const result = await run();
      await record(name, 'pass');
      return result;
    } catch (error) {
      const status = (error as { statusCode?: unknown })?.statusCode;
      await record(
        name,
        error instanceof Error && error.message === 'COS_SESSION_PROBE_UNEXPECTED_SUCCESS'
          ? 'unexpected-success'
          : 'fail-or-unknown',
        typeof status === 'number' ? status : null,
      );
      throw new Error(`COS_SESSION_PROBE_FAILED:${name}`);
    }
  };
  const denied = async (name: string, run: () => Promise<unknown>, allowedStatuses: number[]) =>
    once(name, async () => {
      try {
        await run();
      } catch (error) {
        const status = (error as { statusCode?: unknown })?.statusCode;
        if (typeof status === 'number' && allowedStatuses.includes(status)) {
          await record(name, 'denied', status);
          return;
        }
        throw error;
      }
      throw new Error('COS_SESSION_PROBE_UNEXPECTED_SUCCESS');
    });
  const cos = new COS({
    SecretId: config.secretId,
    SecretKey: config.secretKey,
    SecurityToken: config.sessionToken,
    Protocol: 'https:',
    Timeout: 15_000,
    FollowRedirect: false,
  });
  const target = { Bucket: config.bucket, Region: config.region };
  const imageKey = imageOutputKey(manifest.jobId, 0, manifest.imageId, 'png');
  const bucketFingerprint = createHash('sha256')
    .update(`${config.bucket}/${config.region}`)
    .digest('hex');
  const appIdentityFingerprint = createHash('sha256').update(config.secretId).digest('hex');
  if (
    (manifest.bucketFingerprint && manifest.bucketFingerprint !== bucketFingerprint) ||
    (manifest.appIdentityFingerprint && manifest.appIdentityFingerprint !== appIdentityFingerprint)
  )
    throw new Error('COS_SESSION_PROBE_IDENTITY_OR_BUCKET_MISMATCH');
  manifest.bucketFingerprint = bucketFingerprint;
  manifest.appIdentityFingerprint = appIdentityFingerprint;
  await save(manifest);
  const app = createCosStorage(config);
  if (!manifest.expected) {
    const bytes = await sharp({
      create: { width: 16, height: 16, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();
    const hash = createHash('sha256').update(bytes).digest('hex');
    const output = await once('app-derived-put', () =>
      app.putImage!(imageKey, bytes, 'png', hash, AbortSignal.timeout(15000)),
    );
    manifest.expected = { size: output.sizeBytes, sha256: output.sha256, etag: output.etag };
    await save(manifest);
  }
  await once('app-derived-head', async () => {
    const head = await app.head(imageKey);
    if (
      head.size !== manifest.expected!.size ||
      head.sha256 !== manifest.expected!.sha256 ||
      head.etag !== manifest.expected!.etag
    )
      throw new Error('COS_SESSION_PROBE_HEAD_MISMATCH');
  });
  await once('app-signed-download', async () => {
    const url = app.downloadUrl(imageKey);
    if (new URL(url).searchParams.get('x-cos-security-token') !== config.sessionToken)
      throw new Error('COS_SESSION_PROBE_TOKEN_MISSING');
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok)
      throw Object.assign(new Error('COS_SESSION_PROBE_DOWNLOAD_FAILED'), {
        statusCode: response.status,
      });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      bytes.length !== manifest.expected!.size ||
      createHash('sha256').update(bytes).digest('hex') !== manifest.expected!.sha256
    )
      throw new Error('COS_SESSION_PROBE_DOWNLOAD_MISMATCH');
  });
  await denied(
    'app-derived-put-without-guard',
    () =>
      cos.putObject({
        ...target,
        Key: imageOutputKey(manifest.jobId, 1, manifest.imageId, 'png'),
        Body: Buffer.from('probe'),
      }),
    [403],
  );
  await denied(
    'app-derived-put-wrong-guard',
    () =>
      cos.putObject({
        ...target,
        Key: imageOutputKey(manifest.jobId, 2, manifest.imageId, 'png'),
        Body: Buffer.from('probe'),
        Headers: { 'x-cos-forbid-overwrite': 'false' },
      }),
    [403],
  );
  await denied(
    'app-derived-overwrite',
    () =>
      cos.putObject({
        ...target,
        Key: imageKey,
        Body: Buffer.from('probe'),
        Headers: { 'x-cos-forbid-overwrite': 'true' },
      }),
    [409, 412],
  );
  console.log('COS_SESSION_PROBE_APP_PASS');
}
try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error && error.message.startsWith('COS_SESSION_PROBE_')
      ? error.message
      : 'COS_SESSION_PROBE_FAILED',
  );
  process.exitCode = 1;
}
