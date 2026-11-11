import { Pool } from 'pg';
import { readAssetDatabaseURL } from '../../src/assets/config.ts';
import { assetSchemaSQL, checkAssetSchema } from '../../src/assets/schema.ts';

if (process.argv.slice(2).some((arg) => arg !== '--apply'))
  throw new Error('Usage: assets:migrate [--apply]');
const databaseURL = readAssetDatabaseURL();
if (!databaseURL) throw new Error('ASSET_CONFIG: database URL required');
const pool = new Pool({ connectionString: databaseURL, connectionTimeoutMillis: 5000 });
try {
  if (process.argv.includes('--apply')) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(assetSchemaSQL);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await checkAssetSchema(pool);
    console.log('Asset metadata schema is current.');
  } else console.log(assetSchemaSQL);
} finally {
  await pool.end();
}
