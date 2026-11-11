import { Pool } from 'pg';
import { readConversationConfig } from '../../src/conversations/config.ts';
import { checkConversationSchema, conversationSchemaSQL } from '../../src/conversations/schema.ts';

if (process.argv.slice(2).some((arg) => arg !== '--apply'))
  throw new Error('Usage: conversations:migrate [--apply]');
const config = readConversationConfig();
if (!config) throw new Error('CONVERSATION_CONFIG: database URL required');
const pool = new Pool({ connectionString: config.databaseURL, connectionTimeoutMillis: 5000 });
try {
  if (process.argv.includes('--apply')) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(conversationSchemaSQL);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await checkConversationSchema(pool);
    console.log('Conversation metadata schema is current.');
  } else console.log(conversationSchemaSQL);
} finally {
  await pool.end();
}
