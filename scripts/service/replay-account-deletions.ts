import { Pool } from 'pg';
import { readAuthConfig } from '../../src/auth/config.ts';
import { replayAccountDeletion } from '../../src/auth/deletion.ts';
import { readAssetConfig } from '../../src/assets/config.ts';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { accountDeletionDomainNames } from '../../src/account-deletion/domain-schema.ts';

if (process.argv.slice(2).some((arg) => arg !== '--apply'))
  throw new Error('Usage: account-deletion:replay [--apply]');
const auth = readAuthConfig(),
  assets = readAssetConfig();
if (!auth || !assets)
  throw new Error('ACCOUNT_REPLAY_CONFIG: authentication and private audit COS required');
const pool = new Pool({ connectionString: auth.databaseURL, connectionTimeoutMillis: 5000 });
const media = new Pool({ connectionString: assets.databaseURL, connectionTimeoutMillis: 5000 });
const apply = process.argv.includes('--apply');
try {
  const tables = new Set(
    (
      await media.query<{ name: string }>(
        `SELECT tablename AS name FROM pg_tables WHERE schemaname=ANY(current_schemas(false))`,
      )
    ).rows.map((row) => row.name),
  );
  const domains = accountDeletionDomainNames(
    [
      ...(process.env.MIO_PROVIDERS_DATABASE_URL ? ['providers'] : []),
      ...(process.env.MIO_CONVERSATIONS_DATABASE_URL ? ['conversations'] : []),
      ...(process.env.MIO_NOTIFICATIONS_DATABASE_URL ? ['notifications'] : []),
    ],
    tables,
  );
  const objects = createCosStorage(assets);
  for await (const tombstone of objects.accountDeletionTombstones!(AbortSignal.timeout(300_000))) {
    if (apply) await replayAccountDeletion(pool, tombstone, domains);
    console.log(JSON.stringify({ ...tombstone, action: apply ? 'replayed' : 'preview' }));
  }
  console.log(
    apply
      ? 'Replay queued. Keep service closed until cleanup and restore verification pass.'
      : 'Preview only; --apply is required to replay.',
  );
} finally {
  await Promise.all([pool.end(), media.end()]);
}
