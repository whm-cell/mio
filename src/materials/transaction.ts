import type { Pool, PoolClient } from 'pg';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { MaterialError } from './contracts.ts';

export async function withMaterialTransaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof MaterialError) throw error;
    if ((error as { code?: string }).code === '23505')
      throw new MaterialError(HTTP_STATUS.CONFLICT, 'UPSTREAM_RESOURCE_COLLISION');
    throw new MaterialError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'MATERIAL_UNAVAILABLE');
  } finally {
    client.release();
  }
}
