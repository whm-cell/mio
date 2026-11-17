import { Pool } from 'pg';
import { readAssetDatabaseURL } from '../../src/assets/config.ts';
import { generationSchemaSQL, checkGenerationSchema } from '../../src/generations/schema.ts';

if (process.argv.slice(2).some((arg) => arg !== '--apply'))
  throw new Error('Usage: generations:migrate [--apply]');
const databaseURL = readAssetDatabaseURL();
if (!databaseURL) throw new Error('GENERATION_CONFIG: assets database URL required');
const pool = new Pool({ connectionString: databaseURL, connectionTimeoutMillis: 5000 });
try {
  if (process.argv.includes('--apply')) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(generationSchemaSQL);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await checkGenerationSchema(pool);
    console.log('Generation metadata schema is current.');
  } else console.log(generationSchemaSQL);
} finally {
  await pool.end();
}
