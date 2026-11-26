import { Pool } from 'pg';
import {
  creationLogSchemaSQL,
  checkCreationLogSchema,
} from '../../src/notifications/creation-schema.ts';

if (process.argv.slice(2).some((arg) => arg !== '--apply'))
  throw new Error('Usage: creation-logs:migrate [--apply]');
if (!process.argv.includes('--apply')) console.log(creationLogSchemaSQL);
else {
  const databaseURL = process.env.MIO_ASSETS_DATABASE_URL?.trim();
  if (!databaseURL) throw new Error('CREATION_LOG_SCHEMA: MIO_ASSETS_DATABASE_URL is required');
  const pool = new Pool({ connectionString: databaseURL, connectionTimeoutMillis: 5000 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(creationLogSchemaSQL);
      await checkCreationLogSchema(client);
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
      throw new Error('CREATION_LOG_SCHEMA: migration failed; inspect database structure');
    } finally {
      client.release();
    }
    console.log('Creation log schema is current.');
  } finally {
    await pool.end();
  }
}
