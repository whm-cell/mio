import { Pool } from 'pg';
import { readProviderConfig } from '../../src/providers/config.ts';
import {
  checkProviderSchema,
  providerSchemaSQL,
  providerReferencesSQL,
} from '../../src/providers/schema.ts';

if (process.argv.slice(2).some((arg) => !['--apply', '--with-conversations'].includes(arg)))
  throw new Error('Usage: providers:migrate [--apply] [--with-conversations]');
const config = readProviderConfig();
if (!config) throw new Error('PROVIDER_CONFIG: provider configuration required');
const pool = new Pool({ connectionString: config.databaseURL, connectionTimeoutMillis: 5000 });
const separate = process.argv.includes('--with-conversations');
if (separate && !process.env.MIO_CONVERSATIONS_DATABASE_URL)
  throw new Error('PROVIDER_SCHEMA: --with-conversations requires MIO_CONVERSATIONS_DATABASE_URL');
const references = separate
  ? new Pool({
      connectionString: process.env.MIO_CONVERSATIONS_DATABASE_URL!,
      connectionTimeoutMillis: 5000,
    })
  : undefined;
try {
  if (!process.argv.includes('--apply'))
    console.log(
      `${providerSchemaSQL}\n-- Existing conversation references are imported as historical rows at apply time.\n${providerReferencesSQL}`,
    );
  else {
    // External history is frozen by the migration contract; do not hold provider DDL locks while reading it.
    const externalBindings = references ? await readConversationReferences(references) : undefined;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(providerSchemaSQL);
      const bindings = externalBindings ?? (await readConversationReferences(client));
      for (const rows of bindings)
        if (rows.length) await client.query(providerReferencesSQL, [JSON.stringify(rows)]);
      await checkProviderSchema(client);
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
      throw new Error('PROVIDER_SCHEMA: migration failed; inspect database structure');
    } finally {
      client.release();
    }
    console.log('Provider schema is current.');
  }
} finally {
  await references?.end();
  await pool.end();
}

async function readConversationReferences(reader: Pick<Pool, 'query'>) {
  const columns = await reader.query<{
    table_name: string;
  }>(`SELECT table_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND column_name='model_binding'
      AND table_name IN ('mio_conversations','mio_conversation_requests')`);
  // DISTINCT reduces duplicate traffic; unique references still occupy O(U) memory.
  const bindings: { ownerId: string; providerId: string | null; modelRef: string }[][] = [];
  if (columns.rows.some((row) => row.table_name === 'mio_conversations')) {
    const result = await reader.query(`SELECT DISTINCT owner_id COLLATE "C" AS "ownerId",
      model_binding->>'providerConfigId' COLLATE "C" AS "providerId",model_binding->>'modelRef' COLLATE "C" AS "modelRef"
      FROM mio_conversations
      WHERE model_binding->>'modelRef' IS NOT NULL
        AND model_binding->>'modelRef' !~ '^onelink:model:[0-9a-f-]{36}$'`);
    bindings.push(result.rows);
  }
  if (columns.rows.some((row) => row.table_name === 'mio_conversation_requests')) {
    const result = await reader.query(`SELECT DISTINCT c.owner_id COLLATE "C" AS "ownerId",
      r.model_binding->>'providerConfigId' COLLATE "C" AS "providerId",r.model_binding->>'modelRef' COLLATE "C" AS "modelRef"
      FROM mio_conversation_requests r JOIN mio_conversations c ON c.id=r.conversation_id
      WHERE r.model_binding->>'modelRef' IS NOT NULL
        AND r.model_binding->>'modelRef' !~ '^onelink:model:[0-9a-f-]{36}$'`);
    bindings.push(result.rows);
  }
  return bindings;
}
