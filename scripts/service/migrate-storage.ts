import { Pool } from 'pg';
import { readAssetDatabaseURL } from '../../src/assets/config.ts';
import { storageSchemaSQL, checkStorageSchema } from '../../src/assets/storage-schema.ts';
import { materialStorageSchemaSQL } from '../../src/materials/schema.ts';

if (process.argv.slice(2).some((arg) => arg !== '--apply'))
  throw new Error('Usage: storage:migrate [--apply]');
const databaseURL = readAssetDatabaseURL();
if (!databaseURL) throw new Error('ASSET_CONFIG: database URL required');
const pool = new Pool({ connectionString: databaseURL, connectionTimeoutMillis: 5000 });
try {
  if (!process.argv.includes('--apply')) {
    console.log(storageSchemaSQL);
    console.log(
      '-- If mio_materials already exists, apply its reference bridge in the same media transaction.',
    );
    console.log(materialStorageSchemaSQL);
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(storageSchemaSQL);
      const result = await client.query<{ present: boolean }>(
        "SELECT to_regclass('mio_materials') IS NOT NULL AS present",
      );
      if (result.rows[0]?.present) await client.query(materialStorageSchemaSQL);
      await checkStorageSchema(client);
      await client.query('COMMIT');
      console.log('Storage accounting schema and initial ownership references are current.');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
