import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import COS from 'cos-nodejs-sdk-v5';
import { ObjectStore } from '../../compute/src/adapters/cos.ts';

// Explicitly run only with an authorized target bucket and a separate B identity.
if (process.env.MIO_RUN_IMAGE_UPLOAD_COS_PROBE !== 'yes')
  throw new Error('IMAGE_UPLOAD_COS_PROBE_OPT_IN_REQUIRED');
const bucket = process.env.MIO_COS_BUCKET;
const region = process.env.MIO_COS_REGION;
const secretId = process.env.MIO_COS_SECRET_ID;
const secretKey = process.env.MIO_COS_SECRET_KEY;
if (
  !bucket ||
  bucket !== process.env.MIO_IMAGE_UPLOAD_TEST_BUCKET ||
  !region ||
  !secretId ||
  !secretKey
)
  throw new Error('IMAGE_UPLOAD_COS_PROBE_ISOLATED_CONFIG_REQUIRED');

const sessionToken = process.env.MIO_COS_SESSION_TOKEN;
const config = { bucket, region, secretId, secretKey, ...(sessionToken ? { sessionToken } : {}) };
const runId = randomUUID();
const jobId = randomUUID();
const fileId = randomUUID();
const badFileId = randomUUID();
const goodKey = 'mio/derived/' + jobId + '/images/0-' + fileId + '.png';
const badKey = 'mio/derived/' + jobId + '/images/1-' + badFileId + '.png';
const directory = '.runtime/image-upload-cos-probe';
const manifestPath = join(directory, runId + '.json');
const manifest = {
  runId,
  bucketFingerprint: createHash('sha256')
    .update(bucket + '/' + region)
    .digest('hex'),
  goodKey,
  badKey,
  goodPut: 'not-started',
  audit: 'not-started',
  badPut: 'not-started',
  size: 0,
  sha256: '',
  etag: '',
  downloadedSha256: '',
  badStatus: 0,
  badCode: '',
};
const save = () =>
  writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

async function main() {
  const fixture = spawnSync(
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
  if (fixture.status !== 0 || !fixture.stdout.length) throw new Error('IMAGE_PROBE_FIXTURE_FAILED');
  const bytes = fixture.stdout;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  manifest.size = bytes.length;
  manifest.sha256 = sha256;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log('IMAGE_UPLOAD_COS_PROBE_MANIFEST=' + manifestPath);
  const store = new ObjectStore(config);
  const cos = new COS({
    SecretId: config.secretId,
    SecretKey: config.secretKey,
    ...(sessionToken ? { SecurityToken: sessionToken } : {}),
    Protocol: 'https:',
    FollowRedirect: false,
    Timeout: 60_000,
  });
  manifest.goodPut = 'started';
  await save();
  const result = await store.image(jobId, 0, bytes.toString('base64'), 'png', fileId);
  if (result.key !== goodKey || result.sizeBytes !== bytes.length || result.sha256 !== sha256)
    throw new Error('IMAGE_PROBE_OUTPUT_MISMATCH');
  manifest.goodPut = 'pass';
  manifest.etag = result.etag;
  manifest.audit = 'started';
  await save();

  // This is an independent audit download, not part of the image upload path.
  const stream = cos.getObjectStream({
    Bucket: config.bucket,
    Region: config.region,
    Key: goodKey,
    IfMatch: result.etag,
  }) as Readable;
  const timer = setTimeout(() => stream.destroy(new Error('IMAGE_PROBE_DOWNLOAD_TIMEOUT')), 60_000);
  let downloaded = 0;
  const hash = createHash('sha256');
  try {
    for await (const chunk of stream) {
      const part = Buffer.from(chunk);
      downloaded += part.length;
      if (downloaded > bytes.length) throw new Error('IMAGE_PROBE_DOWNLOAD_MISMATCH');
      hash.update(part);
    }
  } finally {
    clearTimeout(timer);
    stream.destroy();
  }
  manifest.downloadedSha256 = hash.digest('hex');
  if (downloaded !== bytes.length || manifest.downloadedSha256 !== sha256)
    throw new Error('IMAGE_PROBE_DOWNLOAD_MISMATCH');
  manifest.audit = 'pass';
  manifest.badPut = 'started';
  await save();

  try {
    await cos.putObject({
      Bucket: config.bucket,
      Region: config.region,
      Key: badKey,
      Body: Readable.from(bytes),
      ContentLength: bytes.length,
      ContentType: 'image/png',
      Headers: {
        'x-cos-forbid-overwrite': 'true',
        'Content-MD5': createHash('md5').update('deliberately different').digest('base64'),
      },
    });
    manifest.badPut = 'unexpected-success';
    await save();
    throw new Error('IMAGE_PROBE_BAD_MD5_ACCEPTED');
  } catch (error) {
    const cosError = error as { statusCode?: number; error?: { Code?: string } };
    if (cosError.statusCode !== 400 || cosError.error?.Code !== 'BadDigest') throw error;
    manifest.badStatus = cosError.statusCode;
    manifest.badCode = cosError.error.Code;
  }
  manifest.badPut = 'pass';
  await save();
  console.log('IMAGE_UPLOAD_COS_PROBE_PASS');
}

try {
  await main();
} catch {
  // The manifest preserves started/unknown operations and exact keys; never retry them here.
  console.error('IMAGE_UPLOAD_COS_PROBE_FAILED_OR_UNKNOWN');
  process.exitCode = 1;
}
