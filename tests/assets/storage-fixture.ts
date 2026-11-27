import { Pool } from 'pg';
import { authDatabase } from '../support/auth-database.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { materialSchemaSQL } from '../../src/materials/schema.ts';
import { StorageAccounting } from '../../src/assets/storage-store.ts';
import type { StoragePolicy } from '../../src/assets/storage.ts';

export async function storageDatabase() {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL);
  await pool.query(materialSchemaSQL);
  return { database, pool };
}

export async function resetStorageAccounting(pool: Pool, policy: () => StoragePolicy) {
  await pool.query(
    'TRUNCATE mio_assets,mio_asset_holders,mio_storage_objects,mio_storage_usage CASCADE',
  );
  await pool.query('UPDATE mio_storage_policy SET revision=0');
  const storage = new StorageAccounting(pool, policy);
  await storage.updatePolicy();
  return storage;
}
