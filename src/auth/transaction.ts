import type { Pool, PoolClient } from 'pg';

export async function withAuthTransaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  const disconnected = () => {
    discard = true;
  };
  // The pool handles errors only while this client is idle.
  client.on('error', disconnected);
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (!discard) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
    }
    throw error;
  } finally {
    client.removeListener('error', disconnected);
    client.release(discard);
  }
}
