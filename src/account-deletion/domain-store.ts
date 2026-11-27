import { Pool } from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import { checkAccountClosureSchema } from './domain-schema.ts';

export interface DeletionSlice {
  done: boolean;
  remaining: number;
}

/** A separate domain pool; short local transactions never span files/COS or another database. */
export class AccountDomainStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async read<T extends QueryResultRow>(sql: string, values: unknown[] = []) {
    return (await this.pool.query<T>(sql, values)).rows;
  }

  async closeAccount(userId: string, finalizedAt: Date) {
    await this.transaction(userId, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('mio:closed-account:'||$1,0))",
        [userId],
      );
      await client.query(
        `INSERT INTO mio_closed_accounts(user_id,finalized_at) VALUES($1,$2)
        ON CONFLICT(user_id) DO UPDATE SET finalized_at=LEAST(mio_closed_accounts.finalized_at,EXCLUDED.finalized_at)`,
        [userId, finalizedAt],
      );
    });
  }

  async transaction<T>(userId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    const disconnected = () => {
      broken = true;
    };
    client.on('error', disconnected);
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('mio.cleanup_owner',$1,true)", [userId]);
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (!broken)
        await client.query('ROLLBACK').catch(() => {
          broken = true;
        });
      throw error;
    } finally {
      client.removeListener('error', disconnected);
      client.release(broken);
    }
  }

  async batch(
    userId: string,
    domain: string,
    run: (client: PoolClient) => Promise<number>,
  ): Promise<DeletionSlice> {
    return this.transaction(userId, async (client) => {
      const remaining = await run(client);
      await client.query(
        `INSERT INTO mio_account_cleanup_receipts(user_id,domain,completed_at,remaining)
        VALUES($1,$2,CASE WHEN $3=0 THEN clock_timestamp() ELSE NULL END,$3)
        ON CONFLICT(user_id,domain) DO UPDATE SET completed_at=EXCLUDED.completed_at,remaining=EXCLUDED.remaining`,
        [userId, domain, remaining],
      );
      return { done: remaining === 0, remaining };
    });
  }

  close() {
    return this.pool.end();
  }
}

export async function createAccountDomainStore(databaseURL: string, domain: string) {
  const pool = new Pool({
    connectionString: databaseURL,
    max: 3,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 5000,
    application_name: 'mio-deletion-' + domain,
  });
  pool.on('error', () => {});
  try {
    await checkAccountClosureSchema(pool);
    return new AccountDomainStore(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
}
