import { Pool } from 'pg';
import { getMigrations } from 'better-auth/db/migration';
import { authOptions, readAuthConfig } from '../../src/auth/config.ts';

if (process.argv.slice(2).some((arg) => arg !== '--apply'))
  throw new Error('Usage: auth:migrate [--apply]');
const config = readAuthConfig();
if (!config) throw new Error('AUTH_CONFIG: authentication configuration required');
const pool = new Pool({ connectionString: config.databaseURL, connectionTimeoutMillis: 5000 });
try {
  const plan = await getMigrations(authOptions(config, pool));
  if (plan.schemaProblems.length)
    throw new Error(
      `AUTH_SCHEMA: manual schema repair required\n${plan.schemaProblems.join('\n')}`,
    );
  if (process.argv.includes('--apply')) {
    await plan.runMigrations();
    console.log('Authentication schema migration completed.');
  } else
    console.log(
      plan.toBeCreated.length || plan.toBeAdded.length || plan.toBeAddedIndexes.length
        ? await plan.compileMigrations()
        : 'Authentication schema is current.',
    );
} finally {
  await pool.end();
}
