import { Client } from 'pg';
import { expectedRegressionDatabaseUrl, type LocalEnvironment } from './local-environment.ts';

export type SqlSession = {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
  close(): Promise<void>;
};

export type ConnectSqlSession = (connectionString: string) => Promise<SqlSession>;

const defaultConnect: ConnectSqlSession = async (connectionString) => {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
  });
  await client.connect();
  return {
    query: (sql, values) => client.query(sql, values ? [...values] : undefined),
    close: () => client.end(),
  };
};

/** Idempotently provisions mio_regression_test on an existing volume without touching mio_dev/mio_test data. */
export async function prepareLocalRegression(
  name: LocalEnvironment,
  values: NodeJS.ProcessEnv,
  connectSession: ConnectSqlSession = defaultConnect,
) {
  const regressionUrl = expectedRegressionDatabaseUrl(values);
  const adminPassword = values.MIO_LOCAL_POSTGRES_PASSWORD;
  const regressionPassword = values.MIO_LOCAL_REGRESSION_PASSWORD!;
  const port = values.MIO_LOCAL_POSTGRES_PORT!;
  if (!/^[a-f0-9]{64}$/.test(adminPassword ?? ''))
    throw new Error(
      'LOCAL_ENV_SECRET: MIO_LOCAL_POSTGRES_PASSWORD must contain 64 hexadecimal characters',
    );

  const appDatabase = `mio_${name}`;
  const adminUrl = `postgresql://mio_admin:${adminPassword}@127.0.0.1:${port}/${appDatabase}`;
  let created = 0;

  const admin = await connectSession(adminUrl);
  try {
    const roleResult = await admin.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
         FROM pg_roles
        WHERE rolname = 'mio_regression'`,
    );
    const existingRole = roleResult.rows[0];
    if (
      existingRole &&
      (!existingRole.rolcanlogin ||
        existingRole.rolsuper ||
        existingRole.rolcreatedb ||
        existingRole.rolcreaterole ||
        existingRole.rolbypassrls)
    ) {
      throw new Error(
        'LOCAL_REGRESSION_CONFLICT: role mio_regression has unexpected administrative privileges',
      );
    }

    const dbResult = await admin.query<{ owner: string }>(
      `SELECT pg_get_userbyid(datdba) AS owner
         FROM pg_database
        WHERE datname = 'mio_regression_test'`,
    );
    const existingDb = dbResult.rows[0];
    if (existingDb && existingDb.owner !== 'mio_regression') {
      throw new Error(
        'LOCAL_REGRESSION_CONFLICT: database mio_regression_test is not owned by mio_regression',
      );
    }

    const publicAccess = await admin.query<{ allowed: boolean }>(
      `SELECT has_database_privilege('public', $1, 'CONNECT') AS allowed`,
      [appDatabase],
    );
    if (publicAccess.rows[0]?.allowed) {
      await admin.query(`REVOKE ALL ON DATABASE "${appDatabase}" FROM PUBLIC`);
    }

    if (existingRole) {
      const directAccess = await admin.query<{ allowed: boolean }>(
        `SELECT has_database_privilege('mio_regression', $1, 'CONNECT') AS allowed`,
        [appDatabase],
      );
      if (directAccess.rows[0]?.allowed) {
        throw new Error(
          `LOCAL_REGRESSION_CONFLICT: mio_regression must not hold CONNECT privilege on ${appDatabase}`,
        );
      }
    } else {
      await admin.query(`CREATE ROLE mio_regression LOGIN PASSWORD '${regressionPassword}'`);
      created++;
    }

    if (!existingDb) {
      await admin.query('CREATE DATABASE mio_regression_test OWNER mio_regression');
      created++;
    }
    await admin.query('REVOKE ALL ON DATABASE mio_regression_test FROM PUBLIC');
  } finally {
    await admin.close();
  }

  let regression: SqlSession | undefined;
  try {
    regression = await connectSession(regressionUrl);
    const identity = await regression.query<{ db: string; usr: string }>(
      'SELECT current_database() AS db, current_user AS usr',
    );
    if (
      identity.rows[0]?.db !== 'mio_regression_test' ||
      identity.rows[0]?.usr !== 'mio_regression'
    ) {
      throw new Error('LOCAL_REGRESSION_IDENTITY_MISMATCH');
    }
  } catch {
    throw new Error(
      'LOCAL_REGRESSION_LOGIN_FAILED: mio_regression; restore the original credentials, do not reset users',
    );
  } finally {
    await regression?.close();
  }

  const forbiddenAppUrl = `postgresql://mio_regression:${regressionPassword}@127.0.0.1:${port}/${appDatabase}`;
  let forbidden: SqlSession | undefined;
  try {
    forbidden = await connectSession(forbiddenAppUrl);
  } catch {
    forbidden = undefined;
  }
  if (forbidden) {
    await forbidden.close();
    throw new Error(
      `LOCAL_REGRESSION_ISOLATION_FAILED: mio_regression must not connect to ${appDatabase}`,
    );
  }

  console.log(
    `${name}: PostgreSQL regression database mio_regression_test ready (${created} resources created)`,
  );
}
