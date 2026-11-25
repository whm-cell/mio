import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { readAssetConfig, readAssetDatabaseURL } from '../../src/assets/config.ts';
import { checkAssetSchema } from '../../src/assets/schema.ts';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { readProviderConfig } from '../../src/providers/config.ts';
import { checkProviderSchema } from '../../src/providers/schema.ts';
import {
  applyVoicePreviewMigration,
  planVoicePreviewMigration,
  stageVoicePreviews,
} from './voice-preview-migration.ts';

const usage = `Usage:
  audio:previews:import --stage --source-manifest <file> --source-directory <dir> [--staging-directory <dir>]
  audio:previews:import --owner-id <id> --model-id <id> [--staging-directory <dir>]
  audio:previews:import --apply --owner-id <id> --model-id <id> [--staging-directory <dir>] [--concurrency <1..8>]`;

interface Arguments {
  stage: boolean;
  apply: boolean;
  sourceManifest?: string;
  sourceDirectory?: string;
  stagingDirectory: string;
  ownerId?: string;
  modelId?: string;
  concurrency: number;
}

function argumentsFrom(argv: string[]): Arguments {
  const result: Arguments = {
    stage: false,
    apply: false,
    stagingDirectory: '.runtime/dev/voice-previews',
    concurrency: 4,
  };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--') continue;
    if (key === '--stage') result.stage = true;
    else if (key === '--apply') result.apply = true;
    else if (
      [
        '--source-manifest',
        '--source-directory',
        '--staging-directory',
        '--owner-id',
        '--model-id',
        '--concurrency',
      ].includes(key ?? '')
    ) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(usage);
      if (key === '--source-manifest') result.sourceManifest = value;
      else if (key === '--source-directory') result.sourceDirectory = value;
      else if (key === '--staging-directory') result.stagingDirectory = value;
      else if (key === '--owner-id') result.ownerId = value;
      else if (key === '--model-id') result.modelId = value;
      else result.concurrency = Number(value);
    } else throw new Error(usage);
  }
  if (result.stage === result.apply && result.stage) throw new Error(usage);
  if (result.stage) {
    if (!result.sourceManifest || !result.sourceDirectory || result.ownerId || result.modelId)
      throw new Error(usage);
  } else if (!result.ownerId || !result.modelId || result.sourceManifest || result.sourceDirectory)
    throw new Error(usage);
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 8)
    throw new Error(usage);
  return result;
}

export async function runVoicePreviewImport(argv: string[]): Promise<number> {
  const args = argumentsFrom(argv);
  if (args.stage) {
    const manifest = await stageVoicePreviews({
      sourceManifest: resolve(args.sourceManifest!),
      sourceDirectory: resolve(args.sourceDirectory!),
      stagingDirectory: resolve(args.stagingDirectory),
    });
    console.log(
      JSON.stringify({
        mode: 'stage',
        stagingDirectory: resolve(args.stagingDirectory),
        count: manifest.entries.length,
        totalBytes: manifest.entries.reduce((total, entry) => total + entry.sizeBytes, 0),
        sourceManifestSha256: manifest.sourceManifestSha256,
      }),
    );
    return 0;
  }
  const assetDatabaseURL = readAssetDatabaseURL();
  const providerConfig = readProviderConfig();
  if (!assetDatabaseURL || !providerConfig)
    throw new Error('VOICE_PREVIEW_DATABASE_CONFIG_REQUIRED');
  const assetPool = new Pool({
    connectionString: assetDatabaseURL,
    max: 5,
    connectionTimeoutMillis: 5000,
  });
  const providerPool = new Pool({
    connectionString: providerConfig.databaseURL,
    max: 5,
    connectionTimeoutMillis: 5000,
  });
  try {
    await checkAssetSchema(assetPool);
    await checkProviderSchema(providerPool);
    const plan = await planVoicePreviewMigration(providerPool, {
      ownerId: args.ownerId!,
      modelId: args.modelId!,
      whitelist: Boolean(providerConfig.catalogWhitelist),
      stagingDirectory: resolve(args.stagingDirectory),
    });
    if (!args.apply) {
      console.log(
        JSON.stringify({
          mode: 'preview',
          ownerId: plan.ownerId,
          modelId: plan.modelId,
          providerId: plan.providerId,
          count: plan.entries.length,
          totalBytes: plan.totalBytes,
          alreadyBound: plan.entries.filter((entry) => entry.alreadyBound).length,
          pending: plan.entries.filter((entry) => !entry.alreadyBound).length,
          writes: 0,
        }),
      );
      return 0;
    }
    const config = readAssetConfig();
    if (!config) throw new Error('VOICE_PREVIEW_COS_CONFIG_REQUIRED');
    const report = await applyVoicePreviewMigration(
      providerPool,
      assetPool,
      createCosStorage(config),
      plan,
      {
        stagingDirectory: resolve(args.stagingDirectory),
        concurrency: args.concurrency,
      },
    );
    console.log(JSON.stringify({ mode: 'apply', ...report, count: plan.entries.length }));
    return report.failed === 0 ? 0 : 1;
  } finally {
    await Promise.all([providerPool.end(), assetPool.end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await runVoicePreviewImport(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'VOICE_PREVIEW_IMPORT_FAILED');
    process.exitCode = 1;
  }
}
