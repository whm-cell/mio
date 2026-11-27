import { Pool } from 'pg';
import { readProviderConfig } from '../../src/providers/config.ts';
import { checkProviderSchema, providerSchemaSQL } from '../../src/providers/schema.ts';
import { adminSchemaSQL, checkAdminSchema } from '../../src/admin/schema.ts';

if (process.argv.slice(2).some((arg) => arg !== '--apply'))
  throw new Error('Usage: admin:migrate [--apply]');
const config = readProviderConfig();
if (!config) throw new Error('ADMIN_CONFIG: provider configuration required');
const pool = new Pool({ connectionString: config.databaseURL, connectionTimeoutMillis: 5000 });
try {
  if (!process.argv.includes('--apply')) {
    console.log(adminSchemaSQL);
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(providerSchemaSQL);
      await client.query(adminSchemaSQL);
      await checkProviderSchema(client);
      await checkAdminSchema(client);
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
      throw new Error('ADMIN_SCHEMA: migration failed; inspect database structure');
    } finally {
      client.release();
    }
    console.log('Admin schema is current.');
  }
} finally {
  await pool.end();
}
