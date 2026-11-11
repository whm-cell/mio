import { Pool } from 'pg';
import { readAssetDatabaseURL } from '../../src/assets/config.ts';
import { computeSchemaSQL, checkComputeSchema } from '../../src/compute/schema.ts';

if (process.argv.slice(2).some((arg) => arg !== '--apply'))
  throw new Error('Usage: compute:migrate [--apply]');
const databaseURL = readAssetDatabaseURL();
if (!databaseURL) throw new Error('COMPUTE_CONFIG: assets database URL required');
const pool = new Pool({ connectionString: databaseURL, connectionTimeoutMillis: 5000 });
try {
  if (process.argv.includes('--apply')) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(computeSchemaSQL);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await checkComputeSchema(pool);
    console.log('Compute metadata schema is current.');
  } else console.log(computeSchemaSQL);
} finally {
  await pool.end();
}
