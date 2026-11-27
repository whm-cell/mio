import { Pool } from 'pg';
import { getMigrations } from 'better-auth/db/migration';
import { authOptions, readAuthConfig } from '../../src/auth/config.ts';
import { migrateSmsBudget, previewSmsBudgetMigration } from './migrate-auth-sms-budget.ts';
import { accountDeletionSchemaSQL } from '../../src/account-deletion/schema.ts';
import { authDeletionGuardsSQL } from '../../src/auth/deletion-schema.ts';

const args = process.argv.slice(2);
if (args.some((arg) => !['--apply', '--rollback-sms-budget'].includes(arg)))
  throw new Error('Usage: auth:migrate [--rollback-sms-budget] [--apply]');
const apply = args.includes('--apply');
const rollback = args.includes('--rollback-sms-budget');
const config = readAuthConfig();
if (!config) throw new Error('AUTH_CONFIG: authentication configuration required');
const pool = new Pool({ connectionString: config.databaseURL, connectionTimeoutMillis: 5000 });
try {
  const plan = await getMigrations(authOptions(config, pool));
  if (plan.schemaProblems.length)
    throw new Error(
      `AUTH_SCHEMA: manual schema repair required\n${plan.schemaProblems.join('\n')}`,
    );
  const baseChanges = Boolean(
    plan.toBeCreated.length || plan.toBeAdded.length || plan.toBeAddedIndexes.length,
  );
  if (rollback) {
    const smsPlan = await previewSmsBudgetMigration(pool, true);
    if (smsPlan) {
      if (apply) {
        await migrateSmsBudget(pool, true);
        console.log('SMS budget rollback completed.');
      } else console.log(smsPlan);
    } else console.log('SMS budget already uses the earlier writer layout.');
  } else if (apply) {
    if (baseChanges) {
      await previewSmsBudgetMigration(pool, false);
      await plan.runMigrations();
    }
    await migrateSmsBudget(pool, false);
    await pool.query(accountDeletionSchemaSQL);
    await pool.query(authDeletionGuardsSQL);
    console.log('Authentication schema migration completed.');
  } else {
    const smsPlan = await previewSmsBudgetMigration(pool, false);
    if (baseChanges) console.log(await plan.compileMigrations());
    if (smsPlan) console.log(smsPlan);
    console.log(accountDeletionSchemaSQL);
    console.log(authDeletionGuardsSQL);
    if (!baseChanges && !smsPlan) console.log('Authentication schema is current.');
  }
} finally {
  await pool.end();
}
