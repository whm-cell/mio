import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import COS from 'cos-nodejs-sdk-v5';
import { ObjectStore } from '../../compute/src/adapters/cos.ts';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { readAssetConfig } from '../../src/assets/config.ts';

// Explicit opt-in only. Each role runs in its own process with only its own private env file.
if (process.env.MIO_RUN_COS_SESSION_PROBE !== 'yes') throw new Error('COS_SESSION_PROBE_OPT_IN');
const [phase, directoryArgument, credentialPath, ...extra] = process.argv.slice(2);
if (!['init', 'worker', 'app'].includes(phase ?? '') || !directoryArgument || extra.length)
  throw new Error('COS_SESSION_PROBE_ARGUMENTS');
const directory = resolve(directoryArgument);
const root = resolve('.runtime');
if (!directory.startsWith(`${root}${sep}`)) throw new Error('COS_SESSION_PROBE_PRIVATE_DIRECTORY');
const manifestPath = resolve(directory, 'manifest.json');
type Observation = { operation: string; state: string; status?: number | null };
type Manifest = {
  version: 1;
  runId: string;
  jobId: string;
  rawId: string;
  rawAttemptId: string;
  bucketFingerprint?: string;
  workerIdentityFingerprint?: string;
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
      version: 1,
      runId: randomUUID(),
      jobId: randomUUID(),
      rawId: randomUUID(),
      rawAttemptId: randomUUID(),
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
    manifest.version !== 1 ||
    !manifest.jobId ||
    !manifest.rawId ||
    !manifest.rawAttemptId ||
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
  const rawKey = `mio/raw/${manifest.rawId}/${manifest.rawAttemptId}`;
  const derived = `mio/derived/${manifest.jobId}/images`;
  if (phase === 'worker') {
    if (manifest.expected) throw new Error('COS_SESSION_PROBE_ALREADY_ATTEMPTED');
    manifest.bucketFingerprint = createHash('sha256')
      .update(`${config.bucket}/${config.region}`)
      .digest('hex');
    manifest.workerIdentityFingerprint = createHash('sha256').update(config.secretId).digest('hex');
    await save(manifest);
    const encoded = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=16x16',
        '-frames:v',
        '1',
        '-c:v',
        'png',
        '-f',
        'image2pipe',
        'pipe:1',
      ],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    if (encoded.status !== 0 || !encoded.stdout.length)
      throw new Error('COS_SESSION_PROBE_PNG_FAILED');
    const worker = new ObjectStore(config);
    const output = await once('worker-derived-put', () =>
      worker.image(manifest.jobId, 0, encoded.stdout.toString('base64'), 'png', randomUUID()),
    );
    manifest.expected = { size: output.sizeBytes, sha256: output.sha256, etag: output.etag };
    await save(manifest);
    await denied(
      'worker-raw-put',
      () =>
        cos.putObject({
          ...target,
          Key: rawKey,
          Body: Buffer.from('probe'),
          Headers: { 'x-cos-forbid-overwrite': 'true' },
        }),
      [403],
    );
    await denied('worker-raw-delete', () => cos.deleteObject({ ...target, Key: rawKey }), [403]);
    await denied(
      'worker-derived-put-without-guard',
      () => cos.putObject({ ...target, Key: `${derived}/1.png`, Body: Buffer.from('probe') }),
      [403],
    );
    await denied(
      'worker-derived-put-wrong-guard',
      () =>
        cos.putObject({
          ...target,
          Key: `${derived}/2.png`,
          Body: Buffer.from('probe'),
          Headers: { 'x-cos-forbid-overwrite': 'false' },
        }),
      [403],
    );
    await denied(
      'worker-derived-overwrite',
      () =>
        cos.putObject({
          ...target,
          Key: `${derived}/0.png`,
          Body: Buffer.from('probe'),
          Headers: { 'x-cos-forbid-overwrite': 'true' },
        }),
      [409, 412],
    );
    console.log('COS_SESSION_PROBE_WORKER_PASS');
    return;
  }
  if (!manifest.expected) throw new Error('COS_SESSION_PROBE_WORKER_EVIDENCE_REQUIRED');
  if (
    manifest.bucketFingerprint !==
      createHash('sha256').update(`${config.bucket}/${config.region}`).digest('hex') ||
    manifest.workerIdentityFingerprint ===
      createHash('sha256').update(config.secretId).digest('hex')
  )
    throw new Error('COS_SESSION_PROBE_ROLE_OR_BUCKET_MISMATCH');
  const app = createCosStorage(config);
  await once('app-derived-head', async () => {
    const head = await app.head(`${derived}/0.png`);
    if (
      head.size !== manifest.expected!.size ||
      head.sha256 !== manifest.expected!.sha256 ||
      head.etag !== manifest.expected!.etag
    )
      throw new Error('COS_SESSION_PROBE_HEAD_MISMATCH');
  });
  await once('app-signed-download', async () => {
    const url = app.downloadUrl(`${derived}/0.png`);
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
    'app-derived-put',
    () =>
      cos.putObject({
        ...target,
        Key: `${derived}/3.png`,
        Body: Buffer.from('probe'),
        Headers: { 'x-cos-forbid-overwrite': 'true' },
      }),
    [403],
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
