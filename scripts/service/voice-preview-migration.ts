import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { AssetRow } from '../../src/assets/store.ts';
import { AssetStore } from '../../src/assets/store.ts';
import { selectAudioModel } from '../../src/providers/audio-admission.ts';
import { providerStateSQL } from '../../src/providers/state.ts';
import type { ProviderState } from '../../src/providers/state.ts';

const execFileAsync = promisify(execFile);
const SOURCE_MANIFEST_LIMIT = 2 * 1024 * 1024;
const STAGED_MANIFEST_LIMIT = 4 * 1024 * 1024;
const PREVIEW_BYTES_LIMIT = 20 * 1024 * 1024;
const PREVIEW_DURATION_LIMIT_MS = 300_000;
const PREVIEW_ASSET_FILENAME = 'voice-preview.mp3';

export interface StagedVoicePreview {
  upstreamId: string;
  file: string;
  sizeBytes: number;
  sha256: string;
  durationMs: number;
}

export interface VoicePreviewManifest {
  version: 1;
  sourceManifestSha256: string;
  entries: StagedVoicePreview[];
}

interface VoiceRow {
  voice_ref: string;
  upstream_id: string;
  preview_asset_id: string | null;
}

export interface PlannedVoicePreview extends StagedVoicePreview {
  voiceRef: string;
  providerId: string;
  assetId: string;
  objectKey: string;
  alreadyBound: boolean;
}

export interface VoicePreviewPlan {
  ownerId: string;
  modelId: string;
  providerId: string;
  modelKey: string;
  credentialVersion: number;
  catalogVersion: number;
  adaptationVersion: number;
  whitelist: boolean;
  entries: PlannedVoicePreview[];
  totalBytes: number;
}

export interface PreviewObjectStore {
  head(key: string): Promise<{ size: number; etag: string; sha256?: string }>;
  putAudio?(
    key: string,
    bytes: Uint8Array,
    format: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<{ key: string; sizeBytes: number; sha256: string; etag: string }>;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('VOICE_PREVIEW_MANIFEST_INVALID');
}

function assertSafeUpstreamId(value: string): void {
  if (!value || Buffer.byteLength(value) > 256 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error('VOICE_PREVIEW_UPSTREAM_ID_INVALID');
}

function assertSafeFileName(value: string): void {
  if (
    !value ||
    basename(value) !== value ||
    value === '.' ||
    value === '..' ||
    value.includes('\\') ||
    !value.toLowerCase().endsWith('.mp3')
  )
    throw new Error('VOICE_PREVIEW_FILE_INVALID');
}

async function readBoundedJson(
  path: string,
  limit: number,
): Promise<{ raw: Buffer; value: unknown }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > limit)
    throw new Error('VOICE_PREVIEW_MANIFEST_INVALID');
  const raw = await readFile(path);
  return { raw, value: JSON.parse(raw.toString('utf8')) as unknown };
}

function sourceEntries(value: unknown): { upstreamId: string; file: string }[] {
  assertPlainObject(value);
  const seenFiles = new Set<string>();
  const entries = Object.entries(value).map(([upstreamId, file]) => {
    assertSafeUpstreamId(upstreamId);
    if (typeof file !== 'string') throw new Error('VOICE_PREVIEW_MANIFEST_INVALID');
    assertSafeFileName(file);
    if (seenFiles.has(file)) throw new Error('VOICE_PREVIEW_FILE_DUPLICATE');
    seenFiles.add(file);
    return { upstreamId, file };
  });
  if (entries.length < 1 || entries.length > 5000)
    throw new Error('VOICE_PREVIEW_MANIFEST_INVALID');
  return entries.sort((left, right) => left.upstreamId.localeCompare(right.upstreamId, 'en'));
}

function stagedManifest(value: unknown): VoicePreviewManifest {
  assertPlainObject(value);
  if (
    Object.keys(value).some(
      (key) => !['version', 'sourceManifestSha256', 'entries'].includes(key),
    ) ||
    value.version !== 1 ||
    typeof value.sourceManifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sourceManifestSha256) ||
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > 5000
  )
    throw new Error('VOICE_PREVIEW_MANIFEST_INVALID');
  const upstreamIds = new Set<string>();
  const files = new Set<string>();
  const entries = value.entries.map((item) => {
    assertPlainObject(item);
    if (
      Object.keys(item).some(
        (key) => !['upstreamId', 'file', 'sizeBytes', 'sha256', 'durationMs'].includes(key),
      ) ||
      typeof item.upstreamId !== 'string' ||
      typeof item.file !== 'string' ||
      typeof item.sizeBytes !== 'number' ||
      !Number.isSafeInteger(item.sizeBytes) ||
      item.sizeBytes < 1 ||
      item.sizeBytes > PREVIEW_BYTES_LIMIT ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      typeof item.durationMs !== 'number' ||
      !Number.isSafeInteger(item.durationMs) ||
      item.durationMs < 1 ||
      item.durationMs > PREVIEW_DURATION_LIMIT_MS
    )
      throw new Error('VOICE_PREVIEW_MANIFEST_INVALID');
    assertSafeUpstreamId(item.upstreamId);
    assertSafeFileName(item.file);
    if (upstreamIds.has(item.upstreamId) || files.has(item.file))
      throw new Error('VOICE_PREVIEW_MANIFEST_DUPLICATE');
    upstreamIds.add(item.upstreamId);
    files.add(item.file);
    return {
      upstreamId: item.upstreamId,
      file: item.file,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
      durationMs: item.durationMs,
    };
  });
  return { version: 1, sourceManifestSha256: value.sourceManifestSha256, entries };
}

export async function inspectMp3(path: string): Promise<number> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name:format=format_name,duration',
      '-of',
      'json',
      path,
    ],
    { maxBuffer: 64 * 1024, timeout: 30_000 },
  );
  const result = JSON.parse(stdout) as {
    streams?: { codec_name?: string }[];
    format?: { format_name?: string; duration?: string };
  };
  const durationMs = Math.round(Number(result.format?.duration) * 1000);
  if (
    result.streams?.[0]?.codec_name !== 'mp3' ||
    !result.format?.format_name?.split(',').includes('mp3') ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    durationMs > PREVIEW_DURATION_LIMIT_MS
  )
    throw new Error('VOICE_PREVIEW_AUDIO_INVALID');
  return durationMs;
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  action: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await action(values[index]!);
      }
    }),
  );
  return results;
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

export async function stageVoicePreviews(options: {
  sourceManifest: string;
  sourceDirectory: string;
  stagingDirectory: string;
  inspect?: (path: string) => Promise<number>;
}): Promise<VoicePreviewManifest> {
  const source = await readBoundedJson(resolve(options.sourceManifest), SOURCE_MANIFEST_LIMIT);
  const entries = sourceEntries(source.value);
  const root = resolve(options.stagingDirectory);
  const filesDirectory = resolve(root, 'files');
  await mkdir(filesDirectory, { recursive: true, mode: 0o700 });
  const inspect = options.inspect ?? inspectMp3;
  const staged = await mapConcurrent(entries, 8, async (entry) => {
    const sourcePath = resolve(options.sourceDirectory, entry.file);
    const sourceInfo = await lstat(sourcePath);
    if (
      !sourceInfo.isFile() ||
      sourceInfo.isSymbolicLink() ||
      sourceInfo.size < 1 ||
      sourceInfo.size > PREVIEW_BYTES_LIMIT
    )
      throw new Error('VOICE_PREVIEW_SOURCE_INVALID');
    const bytes = await readFile(sourcePath);
    if (bytes.length !== sourceInfo.size) throw new Error('VOICE_PREVIEW_SOURCE_CHANGED');
    const targetPath = resolve(filesDirectory, entry.file);
    await atomicWrite(targetPath, bytes);
    const durationMs = await inspect(targetPath);
    return {
      ...entry,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
      durationMs,
    };
  });
  const expected = new Set(staged.map((entry) => entry.file));
  const unexpected = (await readdir(filesDirectory)).filter((file) => !expected.has(file));
  if (unexpected.length > 0) throw new Error('VOICE_PREVIEW_STAGING_EXTRA_FILE');
  const manifest: VoicePreviewManifest = {
    version: 1,
    sourceManifestSha256: sha256(source.raw),
    entries: staged,
  };
  await atomicWrite(
    resolve(root, 'manifest.json'),
    Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
  );
  return manifest;
}

export async function loadStagedVoicePreviews(
  stagingDirectory: string,
): Promise<VoicePreviewManifest> {
  const root = resolve(stagingDirectory);
  const { value } = await readBoundedJson(resolve(root, 'manifest.json'), STAGED_MANIFEST_LIMIT);
  const manifest = stagedManifest(value);
  await mapConcurrent(manifest.entries, 8, async (entry) => {
    const path = resolve(root, 'files', entry.file);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.sizeBytes)
      throw new Error('VOICE_PREVIEW_STAGING_CHANGED');
    if (sha256(await readFile(path)) !== entry.sha256)
      throw new Error('VOICE_PREVIEW_STAGING_CHANGED');
  });
  const expected = new Set(manifest.entries.map((entry) => entry.file));
  if ((await readdir(resolve(root, 'files'))).some((file) => !expected.has(file)))
    throw new Error('VOICE_PREVIEW_STAGING_EXTRA_FILE');
  return manifest;
}

function deterministicAssetId(providerId: string, digest: string): string {
  const bytes = createHash('sha256')
    .update(`mio:voice-preview:v1:${providerId}:${digest}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function previewTarget(
  pool: Pick<Pool, 'query'>,
  ownerId: string,
  modelId: string,
  whitelist: boolean,
) {
  const state = (await pool.query<ProviderState>(providerStateSQL(false), [ownerId])).rows[0];
  if (!state) throw new Error('VOICE_PREVIEW_MODEL_UNAVAILABLE');
  const discovered = state.models.find((candidate) => candidate.raw_model_id === modelId);
  if (!discovered) throw new Error('VOICE_PREVIEW_MODEL_UNAVAILABLE');
  try {
    const { adaptation } = selectAudioModel(
      state,
      `onelink:model:${discovered.model_key}`,
      'tts',
      whitelist,
    );
    return {
      providerId: state.id,
      modelKey: discovered.model_key,
      credentialVersion: state.credential_version,
      catalogVersion: state.catalog_version!,
      adaptationVersion: adaptation.declarationVersion,
    };
  } catch {
    throw new Error('VOICE_PREVIEW_MODEL_UNAVAILABLE');
  }
}

export async function planVoicePreviewMigration(
  pool: Pick<Pool, 'query'>,
  options: { ownerId: string; modelId: string; stagingDirectory: string; whitelist?: boolean },
): Promise<VoicePreviewPlan> {
  if (!options.ownerId.trim() || !options.modelId.trim())
    throw new Error('VOICE_PREVIEW_TARGET_REQUIRED');
  const manifest = await loadStagedVoicePreviews(options.stagingDirectory);
  const whitelist = Boolean(options.whitelist);
  const target = await previewTarget(pool, options.ownerId, options.modelId, whitelist);
  const rows = (
    await pool.query<VoiceRow>(
      `SELECT v.id AS voice_ref,v.upstream_id,v.preview_asset_id
       FROM mio_provider_voices v
       WHERE v.provider_id=$1 AND v.source='system' AND v.present
        AND (v.registration_model_key IS NULL OR v.registration_model_key=$2)
        AND v.upstream_id=ANY($3::text[])`,
      [target.providerId, target.modelKey, manifest.entries.map((entry) => entry.upstreamId)],
    )
  ).rows;
  const byUpstream = new Map(rows.map((row) => [row.upstream_id, row]));
  const missing = manifest.entries.filter((entry) => !byUpstream.has(entry.upstreamId));
  if (missing.length > 0) throw new Error(`VOICE_PREVIEW_VOICE_UNAVAILABLE:${missing.length}`);
  const entries = manifest.entries.map((entry) => {
    const voice = byUpstream.get(entry.upstreamId)!;
    const assetId = voice.preview_asset_id ?? deterministicAssetId(target.providerId, entry.sha256);
    return {
      ...entry,
      voiceRef: voice.voice_ref,
      providerId: target.providerId,
      assetId,
      objectKey: `mio/raw/${assetId}/${PREVIEW_ASSET_FILENAME}`,
      alreadyBound: voice.preview_asset_id !== null,
    };
  });
  return {
    ownerId: options.ownerId,
    modelId: options.modelId,
    ...target,
    whitelist,
    entries,
    totalBytes: entries.reduce((total, entry) => total + entry.sizeBytes, 0),
  };
}

function objectMissing(error: unknown): boolean {
  const value = error as { statusCode?: number; code?: string };
  return value.statusCode === 404 || value.code === 'NoSuchKey' || value.code === 'NotFound';
}

function assertPreviewAsset(asset: AssetRow, entry: PlannedVoicePreview, etag: string) {
  if (
    asset.state !== 'ready' ||
    asset.content_type !== 'audio/mpeg' ||
    asset.raw_key !== entry.objectKey ||
    asset.source_etag !== etag ||
    Number(asset.size_bytes) !== entry.sizeBytes
  )
    throw new Error('VOICE_PREVIEW_ASSET_CONFLICT');
}

async function bindPreviewVoice(
  client: PoolClient,
  plan: VoicePreviewPlan,
  entry: PlannedVoicePreview,
): Promise<'bound' | 'existing'> {
  await client.query('BEGIN');
  try {
    await client.query(
      'SELECT id FROM mio_provider_configs WHERE id=$1 AND owner_id=$2 FOR UPDATE',
      [plan.providerId, plan.ownerId],
    );
    const target = await previewTarget(client, plan.ownerId, plan.modelId, plan.whitelist);
    if (
      target.providerId !== plan.providerId ||
      target.modelKey !== plan.modelKey ||
      target.credentialVersion !== plan.credentialVersion ||
      target.catalogVersion !== plan.catalogVersion ||
      target.adaptationVersion !== plan.adaptationVersion
    )
      throw new Error('VOICE_PREVIEW_MODEL_CHANGED');
    const voice = (
      await client.query<VoiceRow>(
        `SELECT v.id AS voice_ref,v.upstream_id,v.preview_asset_id
         FROM mio_provider_voices v JOIN mio_provider_configs c ON c.id=v.provider_id
         WHERE c.owner_id=$1 AND v.provider_id=$2 AND v.id=$3 AND v.source='system'
          AND v.upstream_id=$4 AND v.present
          AND (v.registration_model_key IS NULL OR v.registration_model_key=$5) FOR UPDATE OF v`,
        [plan.ownerId, plan.providerId, entry.voiceRef, entry.upstreamId, plan.modelKey],
      )
    ).rows[0];
    if (!voice) throw new Error('VOICE_PREVIEW_VOICE_CHANGED');
    if (voice.preview_asset_id) {
      if (voice.preview_asset_id !== entry.assetId)
        throw new Error('VOICE_PREVIEW_BINDING_CHANGED');
      await client.query('COMMIT');
      return 'existing';
    }
    const updated = await client.query(
      'UPDATE mio_provider_voices SET preview_asset_id=$2,updated_at=now() WHERE id=$1 AND preview_asset_id IS NULL',
      [entry.voiceRef, entry.assetId],
    );
    if (updated.rowCount !== 1) throw new Error('VOICE_PREVIEW_VOICE_CHANGED');
    await client.query('COMMIT');
    return 'bound';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function applyVoicePreviewMigration(
  providerPool: Pool,
  assetPool: Pool,
  objects: PreviewObjectStore,
  plan: VoicePreviewPlan,
  options: { stagingDirectory: string; concurrency?: number; signal?: AbortSignal },
): Promise<{
  bound: number;
  existing: number;
  uploaded: number;
  reconciled: number;
  failed: number;
}> {
  if (!objects.putAudio) throw new Error('VOICE_PREVIEW_COS_WRITE_UNAVAILABLE');
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error('VOICE_PREVIEW_CONCURRENCY_INVALID');
  const signal = options.signal ?? new AbortController().signal;
  const assets = new AssetStore(assetPool);
  const results = await mapConcurrent(plan.entries, concurrency, async (entry) => {
    let uploaded = false;
    try {
      signal.throwIfAborted();
      if (entry.alreadyBound) {
        const asset = await assets.owned(entry.assetId, plan.ownerId);
        const head = await objects.head(entry.objectKey);
        if (head.size !== entry.sizeBytes || head.sha256 !== entry.sha256 || !head.etag)
          throw new Error('VOICE_PREVIEW_OBJECT_CONFLICT');
        assertPreviewAsset(asset, entry, head.etag);
        return { status: 'existing' as const };
      }
      const bytes = await readFile(resolve(options.stagingDirectory, 'files', entry.file));
      if (bytes.length !== entry.sizeBytes || sha256(bytes) !== entry.sha256)
        throw new Error('VOICE_PREVIEW_STAGING_CHANGED');
      let head: Awaited<ReturnType<PreviewObjectStore['head']>>;
      try {
        head = await objects.head(entry.objectKey);
      } catch (error) {
        if (!objectMissing(error)) throw error;
        await objects.putAudio!(entry.objectKey, bytes, 'mp3', entry.sha256, signal);
        uploaded = true;
        head = await objects.head(entry.objectKey);
      }
      if (head.size !== entry.sizeBytes || head.sha256 !== entry.sha256 || !head.etag)
        throw new Error('VOICE_PREVIEW_OBJECT_CONFLICT');
      try {
        await assets.publishAudio({
          assetId: entry.assetId,
          ownerId: plan.ownerId,
          filename: PREVIEW_ASSET_FILENAME,
          contentType: 'audio/mpeg',
          sizeBytes: entry.sizeBytes,
          key: entry.objectKey,
          etag: head.etag,
        });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ASSET_SOURCE_CHANGED'))
          throw error;
        // An older preview may have been recorded under its source filename before it was bound.
        assertPreviewAsset(await assets.owned(entry.assetId, plan.ownerId), entry, head.etag);
      }
      const providerClient = await providerPool.connect();
      try {
        return { status: await bindPreviewVoice(providerClient, plan, entry), uploaded };
      } finally {
        providerClient.release();
      }
    } catch (error) {
      return { status: 'failed' as const, uploaded, error };
    }
  });
  const report = { bound: 0, existing: 0, uploaded: 0, reconciled: 0, failed: 0 };
  for (const result of results) {
    if (result.uploaded) report.uploaded++;
    if (result.status === 'failed') report.failed++;
    else {
      report[result.status]++;
      if (!result.uploaded && result.status === 'bound') report.reconciled++;
    }
  }
  return report;
}
