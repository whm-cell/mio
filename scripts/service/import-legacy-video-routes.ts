import { Pool } from 'pg';
import { readLocalEnvironment } from './local-environment.ts';
import { readProviderConfig } from '../../src/providers/config.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { legacyVideoRouteEntries } from './legacy-video-routes.ts';

const args = process.argv.slice(2);
if (args.length > 1 || (args[0] !== undefined && args[0] !== '--apply'))
  throw new Error('Usage: node scripts/service/import-legacy-video-routes.ts [--apply]');
const environment = await readLocalEnvironment('dev');
const config = readProviderConfig(environment.runtime);
if (!config) throw new Error('PROVIDER_CONFIG_REQUIRED');
const pool = new Pool({ connectionString: config.databaseURL });
try {
  const members = (
    await pool.query<{ raw_model_id: string }>(
      `SELECT DISTINCT m.raw_model_id FROM mio_provider_models m
     JOIN mio_provider_configs p ON p.id=m.provider_id
     WHERE p.enabled AND m.membership_state='current'
       AND m.credential_version=p.credential_version AND m.catalog_version=p.catalog_version`,
    )
  ).rows.map((row) => row.raw_model_id);
  const existing = new Set(
    (
      await pool.query<{ raw_model_id: string }>(
        "SELECT raw_model_id FROM mio_provider_model_routes WHERE provider_type='onelink' AND operation='video.generate'",
      )
    ).rows.map((row) => row.raw_model_id),
  );
  const candidates = legacyVideoRouteEntries(members);
  const missing = candidates.filter((entry) => !existing.has(entry.rawModelId));
  console.log(
    JSON.stringify({
      mode: args[0] === '--apply' ? 'apply' : 'preview',
      discoveredCandidates: candidates.length,
      existing: existing.size,
      newRoutes: missing.map((entry) => ({
        modelId: entry.rawModelId,
        driver: entry.driver,
        modes: entry.paramSpec.supportedModes,
      })),
      verification: 'unverified',
    }),
  );
  if (args[0] === '--apply' && missing.length) {
    const store = await createProviderStore(config);
    try {
      console.log(
        JSON.stringify(
          await store.importRoutes(missing, {
            actorType: 'cli',
            actorId: null,
            actorName: 'legacy-video-migration',
            summary: 'Add exact discovered legacy video routes without replacing existing routes',
            actionOverride: 'cli-import',
          }),
        ),
      );
    } finally {
      await store.close();
    }
  }
} finally {
  await pool.end();
}
