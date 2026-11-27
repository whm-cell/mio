import { Pool } from 'pg';
import {
  accountClosureSchemaSQL,
  accountClosureTables,
} from '../../src/account-deletion/domain-schema.ts';
import { assetGcSchemaSQL } from '../../src/assets/gc-schema.ts';

if (process.argv.slice(2).some((arg) => arg !== '--apply'))
  throw new Error('Usage: account-deletion:migrate [--apply]');
const apply = process.argv.includes('--apply');
await import('./migrate-auth.ts');

for (const [domain, url] of [
  ['media', process.env.MIO_ASSETS_DATABASE_URL],
  ['providers', process.env.MIO_PROVIDERS_DATABASE_URL],
  ['conversations', process.env.MIO_CONVERSATIONS_DATABASE_URL],
  ['notifications', process.env.MIO_NOTIFICATIONS_DATABASE_URL],
] as const) {
  if (!url) continue;
  if (!['postgres:', 'postgresql:'].includes(new URL(url).protocol))
    throw new Error('ACCOUNT_DELETION_CONFIG: PostgreSQL URL required');
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    const tables = new Set(
      (
        await pool.query<{ name: string }>(
          `SELECT tablename AS name FROM pg_tables WHERE schemaname=ANY(current_schemas(false))`,
        )
      ).rows.map((row) => row.name),
    );
    let sql = accountClosureSchemaSQL(accountClosureTables.filter(([table]) => tables.has(table)));
    if (tables.has('mio_assets')) sql += assetGcSchemaSQL;
    for (const table of ['mio_compute_inbox', 'mio_media_inbox'])
      if (tables.has(table))
        sql += `CREATE INDEX IF NOT EXISTS ${table}_account_cleanup ON ${table}((payload->>'jobId'));`;
    if (tables.has('mio_conversations'))
      sql +=
        'CREATE INDEX IF NOT EXISTS mio_conversations_fork_parent ON mio_conversations(forked_from_conversation_id) WHERE forked_from_conversation_id IS NOT NULL;';
    if (apply) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      console.log(`Account deletion ${domain} schema is current.`);
    } else {
      console.log(`-- ${domain}`);
      console.log(sql);
    }
  } finally {
    await pool.end();
  }
}
