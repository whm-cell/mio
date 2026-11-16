import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { ImageCommandV1, ImageResultV1 } from '@mio/compute-contracts';
import {
  imageCommandCredentialBinding,
  parseImageCommand,
  parseImageResult,
} from '@mio/compute-contracts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { checkComputeSchema, computeSchemaSQL } from '../../src/compute/schema.ts';
import { ComputeStore } from '../../src/compute/store.ts';
import { sealImageKey } from '../../src/compute/image-credentials.ts';
import { authDatabase } from '../support/auth-database.ts';
import { findFixtureImageRouteConfig } from '../providers/fixtures/onelink-routes-fixture.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
let store: ComputeStore;
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const GPT_ROUTE = findFixtureImageRouteConfig('gpt-image-2');

function imageKey(jobId: string, index: number, format = 'png') {
  const fileId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return `mio/derived/${jobId}/images/${index}-${fileId}.${format}`;
}
beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(computeSchemaSQL);
  await pool.query(computeSchemaSQL);
  store = new ComputeStore(pool, true);
}, 45000);
afterAll(async () => {
  await store?.close();
  await database?.close();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE mio_image_outputs,mio_image_outbox,mio_image_jobs,mio_compute_inbox,mio_compute_outbox,mio_compute_jobs,mio_assets CASCADE',
  );
});

it('requires image tables and current columns only when images are enabled', async () => {
  const isolated = await authDatabase();
  const db = new Pool({ connectionString: isolated.url });
  try {
    await db.query(assetSchemaSQL);
    await db.query(computeSchemaSQL);
    await db.query('DROP TABLE mio_image_outputs,mio_image_outbox,mio_image_jobs');
    await expect(checkComputeSchema(db)).resolves.toBeUndefined();
    await expect(checkComputeSchema(db, true)).rejects.toThrow();
    await db.query(computeSchemaSQL);
    await expect(checkComputeSchema(db, true)).resolves.toBeUndefined();
  } finally {
    await db.end();
    await isolated.close();
  }
}, 45000);

it('reserves shared capacity for owner recovery, ignores stale results and removes the credential at terminal state', async () => {
  const owner = randomUUID();
  const jobId = randomUUID();
  const command: ImageCommandV1 = {
    version: 1,
    type: 'image.request',
    profile: 'openai-images',
    route: GPT_ROUTE,
    messageId: randomUUID(),
    jobId,
    ownerId: owner,
    expiresAt: Date.now() + 60000,
    input: { model: 'gpt-image-2', prompt: 'square', n: 2 },
    credential: sealImageKey('k', 'binding', 'b1', keys.publicKey),
  };
  await store.imageCreate(owner, randomUUID(), 'recovery', command);
  const output = (index: number) => ({
    key: imageKey(jobId, index),
    sizeBytes: 3,
    sha256: String(index).repeat(64),
    etag: 'etag',
    contentType: 'image/png',
  });
  const failure: ImageResultV1 = {
    version: 1,
    type: 'image.result',
    messageId: randomUUID(),
    commandId: command.messageId,
    jobId,
    state: 'materialization_failed',
    outputs: [output(0)],
  };
  await store.imageAccept(failure);
  expect(
    (
      await pool.query('SELECT command ? $2 AS retained FROM mio_image_jobs WHERE id=$1', [
        jobId,
        'credential',
      ])
    ).rows[0].retained,
  ).toBe(false);
  await expect(store.imageRecover('other', jobId)).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  await Promise.all([store.imageRecover(owner, jobId), store.imageRecover(owner, jobId)]);
  const recovery = await store.imagePending();
  expect(recovery).toMatchObject({
    type: 'image.recover',
    commandId: command.messageId,
    jobId,
    sequence: 1,
  });
  await store.imageSent(jobId, command.messageId);
  expect(await store.imagePending()).toEqual(recovery);
  await store.imageAccept({ ...failure, messageId: randomUUID() });
  expect((await store.imageGet(owner, jobId)).status).toBe('materializing');
  await store.imageAccept({ ...failure, messageId: randomUUID(), recoveryId: recovery!.messageId });
  expect((await store.imageGet(owner, jobId)).status).toBe('materialization_failed');
  await store.imageRecover(owner, jobId);
  const next = await store.imagePending();
  expect(next).toMatchObject({ type: 'image.recover', sequence: 2 });
  await store.imageAccept({
    ...failure,
    messageId: randomUUID(),
    recoveryId: recovery!.messageId,
    state: 'completed',
    outputs: [output(0), output(1)],
  });
  expect((await store.imageGet(owner, jobId)).status).toBe('materializing');
  await store.imageAccept({
    ...failure,
    messageId: randomUUID(),
    recoveryId: next!.messageId,
    state: 'completed',
    outputs: [output(0), output(1)],
  });
  expect((await store.imageGet(owner, jobId)).status).toBe('completed');
  expect((await store.imageGet(owner, jobId)).assetIds).toHaveLength(2);
  expect(await store.imagePending()).toBeUndefined();
});

it('counts image and video admission together and rechecks capacity before explicit recovery', async () => {
  const owner = randomUUID();
  const make = (): ImageCommandV1 => ({
    version: 1,
    type: 'image.request',
    profile: 'openai-images',
    route: GPT_ROUTE,
    messageId: randomUUID(),
    jobId: randomUUID(),
    ownerId: owner,
    expiresAt: Date.now() + 60000,
    input: { model: 'gpt-image-2', prompt: 'square' },
    credential: sealImageKey('k', 'binding', 'b1', keys.publicKey),
  });
  const images = Array.from({ length: 9 }, make);
  for (const image of images) await store.imageCreate(owner, randomUUID(), image.jobId, image);
  const assetId = randomUUID(),
    key = `mio/raw/${assetId}/${randomUUID()}`;
  await pool.query(
    "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at) VALUES($1,$2,'x.mp4','video/mp4',3,$3,$4,'ready',now())",
    [assetId, owner, `mio/staging/${assetId}`, key],
  );
  await store.create(owner, randomUUID(), assetId, key, 3, 'etag');
  const tenthImage = make();
  await expect(store.imageCreate(owner, randomUUID(), 'over', tenthImage)).rejects.toMatchObject({
    code: 'COMPUTE_QUOTA_EXCEEDED',
  });
  const failed: ImageResultV1 = {
    version: 1,
    type: 'image.result',
    messageId: randomUUID(),
    commandId: images[0]!.messageId,
    jobId: images[0]!.jobId,
    state: 'materialization_failed',
    outputs: [],
  };
  await store.imageAccept(failed);
  await store.imageCreate(owner, randomUUID(), 'replacement', tenthImage);
  await expect(store.imageRecover(owner, failed.jobId)).rejects.toMatchObject({
    code: 'COMPUTE_QUOTA_EXCEEDED',
  });
  await store.imageAccept({
    ...failed,
    messageId: randomUUID(),
    commandId: images[1]!.messageId,
    jobId: images[1]!.jobId,
    state: 'rejected',
    errorCode: 'IMAGE_LIMITED',
  });
  await store.imageRecover(owner, failed.jobId);
  expect((await store.imageGet(owner, failed.jobId)).status).toBe('materializing');
});

it.each([
  { imageCount: 250, videoCount: 249, owners: 'distinct' },
  { imageCount: 5, videoCount: 4, owners: 'same' },
] as const)(
  'serializes concurrent mixed admission at the $owners capacity boundary',
  async ({ imageCount, videoCount, owners }) => {
    const owner = `race-${randomUUID()}`;
    const assetId = randomUUID(),
      key = `mio/raw/${assetId}/${randomUUID()}`;
    await pool.query(
      "INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at) VALUES($1,$2,'x.mp4','video/mp4',3,$3,$4,'ready',now())",
      [assetId, owner, `mio/staging/${assetId}`, key],
    );
    const image: ImageCommandV1 = {
      version: 1,
      type: 'image.request',
      profile: 'openai-images',
      route: GPT_ROUTE,
      messageId: randomUUID(),
      jobId: randomUUID(),
      ownerId: owner,
      expiresAt: Date.now() + 60000,
      input: { model: 'gpt-image-2', prompt: 'square' },
      credential: sealImageKey('k', 'binding', 'b1', keys.publicKey),
    };
    await pool.query(
      `INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,state)
    SELECT gen_random_uuid(),CASE WHEN $2='same' THEN $3 ELSE 'image-'||n END,gen_random_uuid(),n::text,$4::jsonb,'accepted' FROM generate_series(1,$1) n`,
      [imageCount, owners, owner, JSON.stringify(image)],
    );
    await pool.query(
      `INSERT INTO mio_compute_jobs(id,owner_id,request_id,input_asset_id,input_key,input_size,input_etag,state,attempt,attempt_id,command_id)
    SELECT gen_random_uuid(),CASE WHEN $2='same' THEN $3 ELSE 'video-'||n END,gen_random_uuid(),$4,$5,3,'etag','queued',1,gen_random_uuid(),gen_random_uuid() FROM generate_series(1,$1) n`,
      [videoCount, owners, owner, assetId, key],
    );
    const results = await Promise.allSettled([
      store.imageCreate(owner, randomUUID(), 'race', image),
      store.create(owner, randomUUID(), assetId, key, 3, 'etag'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'COMPUTE_QUOTA_EXCEEDED' },
    });
  },
);

it('atomically deduplicates admission, persists encrypted outbox and registers owned assets once', async () => {
  const jobId = randomUUID();
  const requestId = randomUUID();
  const input = { model: 'gpt-image-2', prompt: 'square' };
  const expiresAt = Date.now() + 60000;
  const commandBase = {
    version: 1 as const,
    type: 'image.request' as const,
    profile: 'openai-images' as const,
    route: GPT_ROUTE,
    messageId: randomUUID(),
    jobId,
    ownerId: 'owner',
    expiresAt,
    input,
  };
  const credential = sealImageKey(
    'private-key',
    imageCommandCredentialBinding(commandBase),
    'b1',
    keys.publicKey,
  );
  const command: ImageCommandV1 = {
    ...commandBase,
    credential,
  };
  expect(parseImageCommand(command)).toEqual(command);
  expect(() => parseImageCommand({ ...command, profile: 'unimplemented-profile' })).toThrow(
    'IMAGE_MESSAGE_INVALID',
  );
  expect(() => parseImageCommand({ ...command, profile: 'gpt-images-v1' })).toThrow(
    'IMAGE_MESSAGE_INVALID',
  );
  const { route: _missingRoute, ...missingRoute } = command;
  void _missingRoute;
  expect(() => parseImageCommand(missingRoute)).toThrow('IMAGE_MESSAGE_INVALID');
  const { profile: _missingProfile, ...missingProfile } = command;
  void _missingProfile;
  expect(() => parseImageCommand(missingProfile)).toThrow('IMAGE_MESSAGE_INVALID');
  expect(JSON.stringify(command)).not.toContain('private-key');
  const ids = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      store.imageCreate('owner', requestId, 'hash', {
        ...command,
        jobId: index === 0 ? jobId : randomUUID(),
        messageId: randomUUID(),
      }),
    ),
  );
  expect(new Set(ids).size).toBe(1);
  const acceptedId = ids[0]!;
  const accepted = (await store.imagePending())!;
  expect(accepted.jobId).toBe(acceptedId);
  await expect(
    store.imageCreate('owner', requestId, 'different', {
      ...command,
      jobId: randomUUID(),
      messageId: randomUUID(),
    }),
  ).rejects.toMatchObject({
    code: 'REQUEST_CONFLICT',
  });
  expect(await store.imagePending()).toEqual(accepted);
  await store.imageSent(acceptedId, accepted.messageId);
  expect(await store.imagePending()).toBeUndefined();
  await expect(store.imageGet('other', acceptedId)).rejects.toMatchObject({
    code: 'JOB_NOT_FOUND',
  });
  const result: ImageResultV1 = {
    version: 1,
    type: 'image.result',
    messageId: randomUUID(),
    commandId: accepted.messageId,
    jobId: acceptedId,
    state: 'completed',
    outputs: [
      {
        key: imageKey(acceptedId, 0),
        sizeBytes: 3,
        sha256: 'a'.repeat(64),
        etag: 'etag',
        contentType: 'image/png',
      },
    ],
  };
  expect(parseImageResult(result)).toEqual(result);
  await store.imageAccept(result);
  await store.imageAccept({ ...result, messageId: randomUUID() });
  const view = await store.imageGet('owner', acceptedId);
  expect(view.status).toBe('completed');
  expect(view.assetIds).toHaveLength(1);
  const asset = (
    await pool.query('SELECT owner_id,raw_key FROM mio_assets WHERE id=$1', [view.assetIds[0]])
  ).rows[0];
  expect(asset).toEqual({ owner_id: 'owner', raw_key: result.outputs[0]!.key });
  expect(() =>
    parseImageResult({ ...result, outputs: [{ ...result.outputs[0], key: 'mio/raw/another' }] }),
  ).toThrow('IMAGE_MESSAGE_INVALID');
});

it('requires a UUID file ID in every derived image key', () => {
  const jobId = randomUUID();
  const base = {
    version: 1 as const,
    type: 'image.result' as const,
    messageId: randomUUID(),
    commandId: randomUUID(),
    jobId,
    state: 'completed' as const,
    outputs: [
      {
        key: imageKey(jobId, 0),
        sizeBytes: 3,
        sha256: 'a'.repeat(64),
        etag: 'etag',
        contentType: 'image/png',
      },
    ],
  };
  expect(parseImageResult(base)).toEqual(base);
  expect(() =>
    parseImageResult({
      ...base,
      outputs: [{ ...base.outputs[0]!, key: `mio/derived/${jobId}/images/0.png` }],
    }),
  ).toThrow('IMAGE_MESSAGE_INVALID');
});

it('registers durable partial outputs and resumes the remainder without duplicate assets', async () => {
  const jobId = randomUUID();
  const command: ImageCommandV1 = {
    version: 1,
    type: 'image.request',
    profile: 'openai-images',
    route: GPT_ROUTE,
    messageId: randomUUID(),
    jobId,
    ownerId: 'owner',
    expiresAt: Date.now() + 60000,
    input: { model: 'gpt-image-2', prompt: 'square', n: 2 },
    credential: sealImageKey('k', 'binding', 'b1', keys.publicKey),
  };
  await store.imageCreate('owner', randomUUID(), 'hash-partial', command);
  const output = (index: number) => ({
    key: imageKey(jobId, index),
    sizeBytes: 3,
    sha256: String(index).repeat(64),
    etag: 'etag',
    contentType: 'image/png',
  });
  const result: ImageResultV1 = {
    version: 1,
    type: 'image.result',
    messageId: randomUUID(),
    commandId: command.messageId,
    jobId,
    state: 'materializing',
    outputs: [output(0)],
  };
  expect(parseImageResult(result)).toEqual(result);
  await store.imageAccept(result);
  await store.imageAccept({ ...result, messageId: randomUUID() });
  const partial = await store.imageGet('owner', jobId);
  expect(partial.status).toBe('materializing');
  expect(partial.assetIds).toHaveLength(1);
  await expect(
    store.imageAccept({ ...result, outputs: [{ ...output(0), sizeBytes: 99 }] }),
  ).rejects.toMatchObject({ code: 'RESULT_CONFLICT' });
  await store.imageAccept({
    ...result,
    messageId: randomUUID(),
    state: 'completed',
    outputs: [output(0), output(1)],
  });
  const completed = await store.imageGet('owner', jobId);
  expect(completed.status).toBe('completed');
  expect(completed.assetIds).toHaveLength(2);
  expect(completed.assetIds[0]).toBe(partial.assetIds[0]);
});

it('registers a later output by its stable index when the earlier output is missing', async () => {
  const jobId = randomUUID();
  const command: ImageCommandV1 = {
    version: 1,
    type: 'image.request',
    profile: 'openai-images',
    route: GPT_ROUTE,
    messageId: randomUUID(),
    jobId,
    ownerId: 'owner',
    expiresAt: Date.now() + 60000,
    input: { model: 'gpt-image-2', prompt: 'square', n: 2 },
    credential: sealImageKey('k', 'binding', 'b1', keys.publicKey),
  };
  await store.imageCreate('owner', randomUUID(), 'sparse', command);
  const output = (index: number) => ({
    key: imageKey(jobId, index),
    sizeBytes: 3,
    sha256: String(index).repeat(64),
    etag: 'etag',
    contentType: 'image/png',
  });
  const result: ImageResultV1 = {
    version: 1,
    type: 'image.result',
    messageId: randomUUID(),
    commandId: command.messageId,
    jobId,
    state: 'materializing',
    outputs: [output(1)],
  };
  expect(parseImageResult(result)).toEqual(result);
  await store.imageAccept(result);
  const first = await store.imageGet('owner', jobId);
  expect(first.assetIds).toHaveLength(1);
  expect(first.outputs).toEqual([{ index: 1, assetId: first.assetIds[0] }]);
  await store.imageAccept({
    ...result,
    messageId: randomUUID(),
    state: 'completed',
    outputs: [output(0), output(1)],
  });
  const complete = await store.imageGet('owner', jobId);
  expect(complete.assetIds).toHaveLength(2);
  expect(complete.assetIds[1]).toBe(first.assetIds[0]);
  expect(
    (
      await pool.query(
        'SELECT output_index FROM mio_image_outputs WHERE job_id=$1 ORDER BY output_index',
        [jobId],
      )
    ).rows.map((row) => row.output_index),
  ).toEqual([0, 1]);
});
