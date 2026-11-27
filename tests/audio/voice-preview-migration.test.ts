import { makeAudioRouteFixture } from '../providers/fixtures/onelink-audio-route.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
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
let assetDatabase: Awaited<ReturnType<typeof authDatabase>>;
let assets: Pool;
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  assetDatabase = await authDatabase();
  assets = new Pool({ connectionString: assetDatabase.url });
  await assets.query(assetSchemaSQL);
  await pool.query(providerSchemaSQL);
}, 30_000);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

afterAll(async () => {
  await Promise.all([pool?.end(), assets?.end()]);
  await Promise.all([database?.close(), assetDatabase?.close()]);
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
  readonly aclCalls: string[] = [];
  readonly aclWrites: string[] = [];
  readonly privateKeys = new Set<string>();
  readonly failAclOnce = new Set<string>();
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
    this.privateKeys.add(key);
    return { key, sizeBytes: body.length, sha256: digest, etag };
  }
  async ensureAudioPrivate(
    key: string,
    expected: { sizeBytes: number; sha256?: string; etag: string },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.aclCalls.push(key);
    const head = await this.head(key);
    expect(head).toEqual({
      size: expected.sizeBytes,
      sha256: expected.sha256,
      etag: expected.etag,
    });
    if (this.privateKeys.has(key)) return;
    if (this.failAclOnce.delete(key)) throw new Error('synthetic ACL failure');
    this.privateKeys.add(key);
    this.aclWrites.push(key);
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
  expect((await assets.query('SELECT * FROM mio_assets')).rowCount).toBe(0);
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
    applyVoicePreviewMigration(pool, assets, objects, plan, {
      stagingDirectory: fixture.staging,
      concurrency: 2,
    }),
  ).resolves.toEqual({ bound: 2, existing: 0, uploaded: 2, reconciled: 0, failed: 0 });
  expect((await assets.query("SELECT * FROM mio_assets WHERE state='ready'")).rowCount).toBe(2);
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
    applyVoicePreviewMigration(pool, assets, objects, rerun, {
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
    applyVoicePreviewMigration(pool, assets, objects, plan, {
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
    applyVoicePreviewMigration(pool, assets, objects, retry, {
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
    applyVoicePreviewMigration(pool, assets, objects, plan, {
      stagingDirectory: fixture.staging,
    }),
  ).resolves.toEqual({ bound: 0, existing: 0, uploaded: 0, reconciled: 0, failed: 1 });
  expect(
    (await assets.query('SELECT * FROM mio_assets WHERE owner_id=$1', [ownerId])).rowCount,
  ).toBe(0);
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
    applyVoicePreviewMigration(pool, assets, objects, plan, {
      stagingDirectory: fixture.staging,
    }),
  ).resolves.toEqual({ bound: 0, existing: 0, uploaded: 1, reconciled: 0, failed: 1 });
  expect(
    (await assets.query('SELECT * FROM mio_assets WHERE id=$1', [entry.assetId])).rowCount,
  ).toBe(1);
  expect(objects.uploads).toEqual([entry.objectKey]);

  await pool.query(
    `INSERT INTO mio_provider_voices(
      id,provider_id,source,upstream_id,name,descriptions,seen_seq
    ) VALUES($1,$2,'system',$3,$3,'[]'::jsonb,1)`,
    [entry.voiceRef, providerId, entry.upstreamId],
  );
  await expect(
    applyVoicePreviewMigration(pool, assets, objects, plan, {
      stagingDirectory: fixture.staging,
    }),
  ).resolves.toEqual({ bound: 1, existing: 0, uploaded: 0, reconciled: 1, failed: 0 });
  expect(objects.uploads).toEqual([entry.objectKey]);
});

it('shares a deterministic ready preview for identical MP3 bytes under distinct source names', async () => {
  const fixture = await stageFixture({ voiceA: 'original-a.mp3', voiceB: 'original-b.mp3' });
  await writeFile(
    join(fixture.source, 'original-b.mp3'),
    await readFile(join(fixture.source, 'original-a.mp3')),
  );
  await fixture.stage();
  const ownerId = randomUUID();
  const modelId = `speech-shared-preview-${randomUUID()}`;
  const providerId = await createTarget(ownerId, modelId, ['voiceA', 'voiceB']);
  const plan = await planVoicePreviewMigration(pool, {
    ownerId,
    modelId,
    stagingDirectory: fixture.staging,
  });
  const [first, second] = plan.entries;
  expect(first!.assetId).toBe(second!.assetId);
  const objects = new FakeObjects();
  await expect(
    applyVoicePreviewMigration(pool, assets, objects, plan, {
      stagingDirectory: fixture.staging,
      concurrency: 1,
    }),
  ).resolves.toEqual({ bound: 2, existing: 0, uploaded: 1, reconciled: 1, failed: 0 });
  const asset = await assets.query('SELECT owner_id,filename,state FROM mio_assets WHERE id=$1', [
    first!.assetId,
  ]);
  expect(asset.rows).toEqual([
    { owner_id: ownerId, filename: 'voice-preview.mp3', state: 'ready' },
  ]);
  const voices = await pool.query(
    'SELECT preview_asset_id FROM mio_provider_voices WHERE provider_id=$1',
    [providerId],
  );
  expect(voices.rows).toEqual([
    { preview_asset_id: first!.assetId },
    { preview_asset_id: first!.assetId },
  ]);
  const rerun = await planVoicePreviewMigration(pool, {
    ownerId,
    modelId,
    stagingDirectory: fixture.staging,
  });
  await expect(
    applyVoicePreviewMigration(pool, assets, objects, rerun, { stagingDirectory: fixture.staging }),
  ).resolves.toEqual({ bound: 0, existing: 2, uploaded: 0, reconciled: 0, failed: 0 });
});

it('recovers a legacy filename only after confirming owner, ready asset identity and COS digest', async () => {
  const fixture = await stageFixture({ voiceA: 'new-source.mp3' });
  await fixture.stage();
  const ownerId = randomUUID();
  const modelId = `speech-legacy-preview-${randomUUID()}`;
  await createTarget(ownerId, modelId, ['voiceA']);
  const plan = await planVoicePreviewMigration(pool, {
    ownerId,
    modelId,
    stagingDirectory: fixture.staging,
  });
  const entry = plan.entries[0]!;
  const objects = new FakeObjects();
  const bytes = await readFile(join(fixture.staging, 'files', entry.file));
  const etag = 'legacy-preview-etag';
  objects.objects.set(entry.objectKey, { bytes, sha256: entry.sha256, etag });
  await assets.query(
    `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,source_etag,expires_at,staging_deleted_at)
    VALUES($1,$2,'old-source.mp3','audio/mpeg',$3,$4,$4,'ready',$5,now(),now())`,
    [entry.assetId, randomUUID(), entry.sizeBytes, entry.objectKey, etag],
  );
  const apply = () =>
    applyVoicePreviewMigration(pool, assets, objects, plan, { stagingDirectory: fixture.staging });
  await expect(apply()).resolves.toMatchObject({ failed: 1, bound: 0 });
  await assets.query('UPDATE mio_assets SET owner_id=$2 WHERE id=$1', [entry.assetId, ownerId]);
  objects.objects.set(entry.objectKey, { bytes, sha256: '0'.repeat(64), etag });
  await expect(apply()).resolves.toMatchObject({ failed: 1, bound: 0 });
  expect(
    (
      await pool.query('SELECT preview_asset_id FROM mio_provider_voices WHERE id=$1', [
        entry.voiceRef,
      ])
    ).rows,
  ).toEqual([{ preview_asset_id: null }]);
  expect(objects.aclCalls).toEqual([]);
  objects.objects.set(entry.objectKey, { bytes, sha256: entry.sha256, etag });
  await expect(apply()).resolves.toEqual({
    failed: 0,
    bound: 1,
    existing: 0,
    uploaded: 0,
    reconciled: 1,
  });
  expect(
    (await assets.query('SELECT filename,source_etag FROM mio_assets WHERE id=$1', [entry.assetId]))
      .rows,
  ).toEqual([{ filename: 'old-source.mp3', source_etag: etag }]);
  expect(objects.aclWrites).toEqual([entry.objectKey]);
});

it('repairs the ACL of an old bound preview only after rechecking its current binding and identity', async () => {
  const fixture = await stageFixture({ voiceA: 'old-bound.mp3' });
  await fixture.stage();
  const ownerId = randomUUID();
  const modelId = `speech-bound-acl-${randomUUID()}`;
  await createTarget(ownerId, modelId, ['voiceA']);
  const planOptions = { ownerId, modelId, stagingDirectory: fixture.staging };
  const entry = (await planVoicePreviewMigration(pool, planOptions)).entries[0]!;
  const objects = new FakeObjects();
  const bytes = await readFile(join(fixture.staging, 'files', entry.file));
  const etag = 'prior-preview-etag';
  objects.objects.set(entry.objectKey, { bytes, sha256: entry.sha256, etag });
  await assets.query(
    `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,source_etag,expires_at,staging_deleted_at)
    VALUES($1,$2,'old-bound.mp3','audio/mpeg',$3,$4,$4,'ready',$5,now(),now())`,
    [entry.assetId, ownerId, entry.sizeBytes, entry.objectKey, etag],
  );
  await pool.query('UPDATE mio_provider_voices SET preview_asset_id=$2 WHERE id=$1', [
    entry.voiceRef,
    entry.assetId,
  ]);
  const planned = await planVoicePreviewMigration(pool, planOptions);
  expect(planned.entries[0]!.alreadyBound).toBe(true);
  const apply = () =>
    applyVoicePreviewMigration(pool, assets, objects, planned, {
      stagingDirectory: fixture.staging,
    });
  const binding = async () =>
    (
      await pool.query('SELECT preview_asset_id FROM mio_provider_voices WHERE id=$1', [
        entry.voiceRef,
      ])
    ).rows;

  objects.objects.set(entry.objectKey, { bytes, sha256: entry.sha256, etag: 'other-object' });
  await expect(apply()).resolves.toMatchObject({ failed: 1, existing: 0 });
  expect(objects.aclCalls).toEqual([]);
  objects.objects.set(entry.objectKey, { bytes, sha256: entry.sha256, etag });
  await pool.query('UPDATE mio_provider_voices SET preview_asset_id=NULL WHERE id=$1', [
    entry.voiceRef,
  ]);
  await expect(apply()).resolves.toMatchObject({ failed: 1, existing: 0 });
  expect(objects.aclCalls).toEqual([]);

  await pool.query('UPDATE mio_provider_voices SET preview_asset_id=$2 WHERE id=$1', [
    entry.voiceRef,
    entry.assetId,
  ]);
  objects.failAclOnce.add(entry.objectKey);
  await expect(apply()).resolves.toMatchObject({ failed: 1, existing: 0 });
  expect(objects.aclWrites).toEqual([]);
  expect(await binding()).toEqual([{ preview_asset_id: entry.assetId }]);
  await expect(apply()).resolves.toMatchObject({ failed: 0, existing: 1 });
  await expect(apply()).resolves.toMatchObject({ failed: 0, existing: 1 });
  expect(objects.aclWrites).toEqual([entry.objectKey]);
  expect(objects.uploads).toEqual([]);
  expect(await binding()).toEqual([{ preview_asset_id: entry.assetId }]);
});

it('keeps a recovered old object unbound until its private ACL has been verified', async () => {
  const fixture = await stageFixture({ voiceA: 'orphaned-preview.mp3' });
  await fixture.stage();
  const ownerId = randomUUID();
  const modelId = `speech-orphaned-preview-${randomUUID()}`;
  await createTarget(ownerId, modelId, ['voiceA']);
  const planned = await planVoicePreviewMigration(pool, {
    ownerId,
    modelId,
    stagingDirectory: fixture.staging,
  });
  const entry = planned.entries[0]!;
  const objects = new FakeObjects();
  const bytes = await readFile(join(fixture.staging, 'files', entry.file));
  objects.objects.set(entry.objectKey, { bytes, sha256: entry.sha256, etag: 'orphaned-preview' });
  objects.failAclOnce.add(entry.objectKey);
  const apply = () =>
    applyVoicePreviewMigration(pool, assets, objects, planned, {
      stagingDirectory: fixture.staging,
    });
  await expect(apply()).resolves.toEqual({
    failed: 1,
    bound: 0,
    existing: 0,
    uploaded: 0,
    reconciled: 0,
  });
  expect(
    (await assets.query('SELECT owner_id,state FROM mio_assets WHERE id=$1', [entry.assetId])).rows,
  ).toEqual([{ owner_id: ownerId, state: 'ready' }]);
  expect(
    (
      await pool.query('SELECT preview_asset_id FROM mio_provider_voices WHERE id=$1', [
        entry.voiceRef,
      ])
    ).rows,
  ).toEqual([{ preview_asset_id: null }]);
  await expect(apply()).resolves.toEqual({
    failed: 0,
    bound: 1,
    existing: 0,
    uploaded: 0,
    reconciled: 1,
  });
  expect(objects.aclWrites).toEqual([entry.objectKey]);
  expect(objects.uploads).toEqual([]);
});

it('binds different voices concurrently under config SHARE while rotation and same-voice writes wait', async () => {
  const fixture = await stageFixture({ voiceA: 'share-a.mp3', voiceB: 'share-b.mp3' });
  await fixture.stage();
  const ownerId = randomUUID(),
    modelId = 'speech-share-' + randomUUID();
  const providerId = await createTarget(ownerId, modelId, ['voiceA', 'voiceB']);
  const plan = await planVoicePreviewMigration(pool, {
    ownerId,
    modelId,
    stagingDirectory: fixture.staging,
  });
  const gate = await pool.connect();
  const key = randomBytes(6).readUIntBE(0, 6);
  const pid = (await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await gate.query('SELECT pg_advisory_lock($1)', [key]);
  await pool.query(`CREATE FUNCTION wait_preview_binding() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
    IF NEW.provider_id::text=TG_ARGV[1] THEN PERFORM pg_advisory_xact_lock_shared(TG_ARGV[0]::bigint); END IF;
    RETURN NEW; END$$;
    CREATE TRIGGER wait_preview_binding BEFORE UPDATE ON mio_provider_voices FOR EACH ROW
      WHEN (OLD.preview_asset_id IS NULL) EXECUTE FUNCTION wait_preview_binding('${key}','${providerId}')`);
  const migration = applyVoicePreviewMigration(pool, assets, new FakeObjects(), plan, {
    stagingDirectory: fixture.staging,
    concurrency: 2,
  });
  let rotation: Promise<unknown> | undefined, voiceWrite: Promise<unknown> | undefined;
  try {
    await vi.waitFor(async () =>
      expect(
        (
          await pool.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [
            pid,
          ])
        ).rows,
      ).toHaveLength(2),
    );
    rotation = pool.query(
      'UPDATE mio_provider_configs SET credential_version=credential_version+1 WHERE id=$1',
      [providerId],
    );
    voiceWrite = pool.query('UPDATE mio_provider_voices SET name=$2 WHERE id=$1', [
      plan.entries[0]!.voiceRef,
      'concurrent name',
    ]);
    await vi.waitFor(async () => {
      const rows = (
        await pool.query(
          "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0 AND (query LIKE 'UPDATE mio_provider_configs SET credential_version=%' OR query LIKE 'UPDATE mio_provider_voices SET name=%')",
        )
      ).rows;
      expect(rows).toHaveLength(2);
    });
  } finally {
    await gate.query('SELECT pg_advisory_unlock($1)', [key]);
    gate.release();
    await Promise.all([migration, rotation, voiceWrite]);
    await pool.query(
      'DROP TRIGGER wait_preview_binding ON mio_provider_voices; DROP FUNCTION wait_preview_binding()',
    );
  }
  expect(await migration).toMatchObject({ bound: 2, failed: 0 });
  expect(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM mio_provider_voices WHERE provider_id=$1 AND preview_asset_id IS NOT NULL',
        [providerId],
      )
    ).rows[0].n,
  ).toBe(2);
});
