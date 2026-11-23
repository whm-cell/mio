import { makeAudioRouteFixture } from '../providers/fixtures/onelink-audio-route.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import {
  applyVoicePreviewMigration,
  loadStagedVoicePreviews,
  planVoicePreviewMigration,
  stageVoicePreviews,
} from '../../scripts/service/voice-preview-migration.ts';
import type { PreviewObjectStore } from '../../scripts/service/voice-preview-migration.ts';
import { authDatabase } from '../support/auth-database.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(providerSchemaSQL);
}, 30_000);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

afterAll(async () => {
  await pool?.end();
  await database?.close();
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mio-voice-previews-'));
  temporaryDirectories.push(root);
  return root;
}

async function stageFixture(entries: Record<string, string>) {
  const root = await temporaryRoot();
  const source = join(root, 'source');
  const staging = join(root, 'staging');
  await mkdir(source);
  const manifest = join(root, 'source.json');
  await writeFile(manifest, JSON.stringify(entries));
  for (const file of Object.values(entries))
    if (!file.includes('/') && !file.includes('\\'))
      await writeFile(join(source, file), Buffer.from(`synthetic-mp3:${file}`));
  return {
    root,
    source,
    staging,
    manifest,
    async stage() {
      return stageVoicePreviews({
        sourceManifest: manifest,
        sourceDirectory: source,
        stagingDirectory: staging,
        inspect: async () => 1250,
      });
    },
  };
}

async function createTarget(ownerId: string, modelId: string, upstreamIds: string[]) {
  const providerId = randomUUID();
  const modelKey = randomUUID();
  await pool.query(
    `INSERT INTO mio_provider_configs(
      id,owner_id,enabled,revision,credential_version,cipher_format,master_key_id,nonce,ciphertext,auth_tag,
      catalog_version,catalog_credential_version,catalog_succeeded_at,credential_auth_state
    ) VALUES($1,$2,true,1,1,1,'fixture',$3,$4,$5,1,1,now(),'valid')`,
    [providerId, ownerId, randomBytes(12), randomBytes(16), randomBytes(16)],
  );
  await pool.query(
    `INSERT INTO mio_provider_models(
      model_key,provider_id,raw_model_id,metadata_source,
      credential_version,catalog_version,first_seen_at,last_seen_at,membership_state
    ) VALUES($1,$2,$3,'fixture',1,1,now(),now(),'current')`,
    [modelKey, providerId, modelId],
  );
  await pool.query(
    `INSERT INTO mio_provider_model_routes(
      provider_type,raw_model_id,operation,vendor,driver,classification,submit_path,
      source_kind,source,source_version,param_spec
    ) VALUES('onelink',$1,'audio.tts','minimax','minimax-tts','voice','/minimax/v1/t2a_v2',
      'protocol-reference','test fixture','v1',$2::jsonb) ON CONFLICT DO NOTHING`,
    [modelId, JSON.stringify(makeAudioRouteFixture(modelId).paramSpec)],
  );
  await pool.query(
    `INSERT INTO mio_provider_voices(provider_id,source,upstream_id,name,descriptions,seen_seq,registration_model_key)
     SELECT $1,'system',value,value,'[]'::jsonb,1,$3 FROM unnest($2::text[]) value`,
    [providerId, upstreamIds, modelKey],
  );
  return providerId;
}

class MissingObjectError extends Error {
  readonly statusCode = 404;
}

class FakeObjects implements PreviewObjectStore {
  readonly objects = new Map<string, { bytes: Buffer; sha256: string; etag: string }>();
  readonly uploads: string[] = [];
  readonly failOnce = new Set<string>();

  async head(key: string) {
    const object = this.objects.get(key);
    if (!object) throw new MissingObjectError('missing');
    return { size: object.bytes.length, sha256: object.sha256, etag: object.etag };
  }

  async putAudio(
    key: string,
    bytes: Uint8Array,
    _format: string,
    digest: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.failOnce.delete(key)) throw new Error('synthetic upload failure');
    const body = Buffer.from(bytes);
    const etag = `etag-${digest.slice(0, 12)}`;
    this.objects.set(key, { bytes: body, sha256: digest, etag });
    this.uploads.push(key);
    return { key, sizeBytes: body.length, sha256: digest, etag };
  }
}

it('stages only manifest files and rejects path traversal or unexpected staging files', async () => {
  const fixture = await stageFixture({ voiceA: 'voice-a.mp3', voiceB: 'voice-b.mp3' });
  await writeFile(join(fixture.source, 'not-in-manifest.mp3'), 'ignored');
  const manifest = await fixture.stage();
  expect(manifest.entries).toHaveLength(2);
  expect(await readdir(join(fixture.staging, 'files'))).toEqual(['voice-a.mp3', 'voice-b.mp3']);
  await writeFile(join(fixture.staging, 'files', 'unexpected.mp3'), 'unexpected');
  await expect(loadStagedVoicePreviews(fixture.staging)).rejects.toThrow(
    'VOICE_PREVIEW_STAGING_EXTRA_FILE',
  );

  const unsafe = await stageFixture({ voiceA: '../escape.mp3' });
  await expect(unsafe.stage()).rejects.toThrow('VOICE_PREVIEW_FILE_INVALID');
});

it('detects a staged file changed after preparation', async () => {
  const fixture = await stageFixture({ voiceA: 'voice-a.mp3' });
  await fixture.stage();
  await writeFile(join(fixture.staging, 'files', 'voice-a.mp3'), 'changed');
  await expect(loadStagedVoicePreviews(fixture.staging)).rejects.toThrow(
    'VOICE_PREVIEW_STAGING_CHANGED',
  );
});

it('keeps preview mode read-only, applies ready assets for the owner, and reruns idempotently', async () => {
  const fixture = await stageFixture({ voiceA: 'voice-a.mp3', voiceB: 'voice-b.mp3' });
  await fixture.stage();
  const ownerId = randomUUID();
  const strangerId = randomUUID();
  const modelId = `speech-preview-${randomUUID()}`;
  await createTarget(ownerId, modelId, ['voiceA', 'voiceB']);
  const strangerProvider = await createTarget(strangerId, modelId, ['voiceA', 'voiceB']);
  const plan = await planVoicePreviewMigration(pool, {
    ownerId,
    modelId,
    stagingDirectory: fixture.staging,
  });
  expect(plan.entries).toHaveLength(2);
  expect((await pool.query('SELECT * FROM mio_assets')).rowCount).toBe(0);
  expect(
    (
      await pool.query<{ count: string }>(
        'SELECT count(*) FROM mio_provider_voices WHERE provider_id=$1 AND preview_asset_id IS NOT NULL',
        [strangerProvider],
      )
    ).rows[0]!.count,
  ).toBe('0');

  const objects = new FakeObjects();
  await expect(
    applyVoicePreviewMigration(pool, pool, objects, plan, {
      stagingDirectory: fixture.staging,
      concurrency: 2,
    }),
  ).resolves.toEqual({ bound: 2, existing: 0, uploaded: 2, reconciled: 0, failed: 0 });
  expect((await pool.query("SELECT * FROM mio_assets WHERE state='ready'")).rowCount).toBe(2);
  expect(
    (
      await pool.query<{ count: string }>(
        'SELECT count(*) FROM mio_provider_voices WHERE provider_id=$1 AND preview_asset_id IS NOT NULL',
        [strangerProvider],
      )
    ).rows[0]!.count,
  ).toBe('0');

  const rerun = await planVoicePreviewMigration(pool, {
    ownerId,
    modelId,
    stagingDirectory: fixture.staging,
  });
  expect(rerun.entries.every((entry) => entry.alreadyBound)).toBe(true);
  await expect(
    applyVoicePreviewMigration(pool, pool, objects, rerun, {
      stagingDirectory: fixture.staging,
    }),
  ).resolves.toEqual({ bound: 0, existing: 2, uploaded: 0, reconciled: 0, failed: 0 });
  expect(objects.uploads).toHaveLength(2);
});

it('reconciles an existing matching object and resumes only failed entries', async () => {
  const fixture = await stageFixture({ voiceA: 'voice-a.mp3', voiceB: 'voice-b.mp3' });
  await fixture.stage();
  const ownerId = randomUUID();
  const modelId = `speech-resume-${randomUUID()}`;
  await createTarget(ownerId, modelId, ['voiceA', 'voiceB']);
  const plan = await planVoicePreviewMigration(pool, {
    ownerId,
    modelId,
    stagingDirectory: fixture.staging,
  });
  const objects = new FakeObjects();
  const first = plan.entries[0]!;
  const bytes = await readFile(join(fixture.staging, 'files', first.file));
  objects.objects.set(first.objectKey, {
    bytes,
    sha256: first.sha256,
    etag: 'preexisting-etag',
  });
  objects.failOnce.add(plan.entries[1]!.objectKey);
  await expect(
    applyVoicePreviewMigration(pool, pool, objects, plan, {
      stagingDirectory: fixture.staging,
      concurrency: 1,
    }),
  ).resolves.toEqual({ bound: 1, existing: 0, uploaded: 0, reconciled: 1, failed: 1 });

  const retry = await planVoicePreviewMigration(pool, {
    ownerId,
    modelId,
    stagingDirectory: fixture.staging,
  });
  await expect(
    applyVoicePreviewMigration(pool, pool, objects, retry, {
      stagingDirectory: fixture.staging,
      concurrency: 1,
    }),
  ).resolves.toEqual({ bound: 1, existing: 1, uploaded: 1, reconciled: 0, failed: 0 });
});

it('refuses to bind a COS object whose length or digest conflicts with staging', async () => {
  const fixture = await stageFixture({ voiceA: 'voice-a.mp3' });
  await fixture.stage();
  const ownerId = randomUUID();
  const modelId = `speech-conflict-${randomUUID()}`;
  await createTarget(ownerId, modelId, ['voiceA']);
  const plan = await planVoicePreviewMigration(pool, {
    ownerId,
    modelId,
    stagingDirectory: fixture.staging,
  });
  const objects = new FakeObjects();
  objects.objects.set(plan.entries[0]!.objectKey, {
    bytes: Buffer.from('wrong'),
    sha256: '0'.repeat(64),
    etag: 'wrong-etag',
  });
  await expect(
    applyVoicePreviewMigration(pool, pool, objects, plan, {
      stagingDirectory: fixture.staging,
    }),
  ).resolves.toEqual({ bound: 0, existing: 0, uploaded: 0, reconciled: 0, failed: 1 });
  expect((await pool.query('SELECT * FROM mio_assets WHERE owner_id=$1', [ownerId])).rowCount).toBe(
    0,
  );
});

it('resumes provider binding after the ready Asset checkpoint committed', async () => {
  const fixture = await stageFixture({ voiceA: 'voice-a.mp3' });
  await fixture.stage();
  const ownerId = randomUUID();
  const modelId = `speech-checkpoint-${randomUUID()}`;
  const providerId = await createTarget(ownerId, modelId, ['voiceA']);
  const plan = await planVoicePreviewMigration(pool, {
    ownerId,
    modelId,
    stagingDirectory: fixture.staging,
  });
  const entry = plan.entries[0]!;
  await pool.query('DELETE FROM mio_provider_voices WHERE id=$1', [entry.voiceRef]);
  const objects = new FakeObjects();
  await expect(
    applyVoicePreviewMigration(pool, pool, objects, plan, {
      stagingDirectory: fixture.staging,
    }),
  ).resolves.toEqual({ bound: 0, existing: 0, uploaded: 1, reconciled: 0, failed: 1 });
  expect((await pool.query('SELECT * FROM mio_assets WHERE id=$1', [entry.assetId])).rowCount).toBe(
    1,
  );
  expect(objects.uploads).toEqual([entry.objectKey]);

  await pool.query(
    `INSERT INTO mio_provider_voices(
      id,provider_id,source,upstream_id,name,descriptions,seen_seq
    ) VALUES($1,$2,'system',$3,$3,'[]'::jsonb,1)`,
    [entry.voiceRef, providerId, entry.upstreamId],
  );
  await expect(
    applyVoicePreviewMigration(pool, pool, objects, plan, {
      stagingDirectory: fixture.staging,
    }),
  ).resolves.toEqual({ bound: 1, existing: 0, uploaded: 0, reconciled: 1, failed: 0 });
  expect(objects.uploads).toEqual([entry.objectKey]);
});
