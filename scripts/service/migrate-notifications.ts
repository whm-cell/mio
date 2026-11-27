import { Pool } from 'pg';
import { readNotificationsConfig } from '../../src/notifications/config.ts';
import { checkNotificationSchema, notificationSchemaSQL } from '../../src/notifications/schema.ts';

if (process.argv.slice(2).some((arg) => arg !== '--apply'))
  throw new Error('Usage: notifications:migrate [--apply]');
if (!process.argv.includes('--apply')) {
  console.log(notificationSchemaSQL);
} else {
  const config = readNotificationsConfig();
  if (!config) throw new Error('NOTIFICATIONS_CONFIG: MIO_NOTIFICATIONS_DATABASE_URL is required');
  const pool = new Pool({ connectionString: config.databaseURL, connectionTimeoutMillis: 5000 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(notificationSchemaSQL);
      await checkNotificationSchema(client);
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
      throw new Error('NOTIFICATIONS_SCHEMA: migration failed; inspect database structure');
    } finally {
      client.release();
    }
    console.log('Notifications schema is current.');
  } finally {
    await pool.end();
  }
}
