import { expect, it } from 'vitest';
import {
  prepareLocalRegression,
  type ConnectSqlSession,
  type SqlSession,
} from '../../scripts/service/local-regression.ts';

const ADMIN_PASS = 'a'.repeat(64);
const REG_PASS = 'b'.repeat(64);

function baseValues(port = '55432'): NodeJS.ProcessEnv {
  return {
    MIO_ENVIRONMENT: 'dev',
    MIO_LOCAL_POSTGRES_PORT: port,
    MIO_LOCAL_POSTGRES_PASSWORD: ADMIN_PASS,
    MIO_LOCAL_REGRESSION_PASSWORD: REG_PASS,
    MIO_TEST_DATABASE_URL: `postgresql://mio_regression:${REG_PASS}@127.0.0.1:${port}/mio_regression_test`,
  };
}

type MockState = {
  role: {
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolbypassrls: boolean;
  } | null;
  dbOwner: string | null;
  publicConnect: boolean;
  directConnect: boolean;
  allowRegressionLogin: boolean;
  allowAppLogin: boolean;
};

function createMockConnect(initial: Partial<MockState> = {}) {
  const state: MockState = {
    role: null,
    dbOwner: null,
    publicConnect: true,
    directConnect: false,
    allowRegressionLogin: true,
    allowAppLogin: false,
    ...initial,
  };
  const executed: string[] = [];

  const connect: ConnectSqlSession = async (url) => {
    const parsed = new URL(url);
    if (parsed.username === 'mio_admin' && parsed.pathname === '/mio_dev') {
      const session: SqlSession = {
        async query<Row extends Record<string, unknown>>(sql: string): Promise<{ rows: Row[] }> {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          executed.push(normalized);
          if (normalized.includes('FROM pg_roles')) {
            return { rows: (state.role ? [state.role] : []) as unknown as Row[] };
          }
          if (normalized.includes('FROM pg_database')) {
            return {
              rows: (state.dbOwner ? [{ owner: state.dbOwner }] : []) as unknown as Row[],
            };
          }
          if (normalized.includes("has_database_privilege('public'")) {
            return { rows: [{ allowed: state.publicConnect }] as unknown as Row[] };
          }
          if (normalized.includes("has_database_privilege('mio_regression'")) {
            return { rows: [{ allowed: state.directConnect }] as unknown as Row[] };
          }
          if (normalized.startsWith('REVOKE ALL ON DATABASE "mio_dev"')) {
            state.publicConnect = false;
            return { rows: [] };
          }
          if (normalized.startsWith('CREATE ROLE mio_regression')) {
            state.role = {
              rolcanlogin: true,
              rolsuper: false,
              rolcreatedb: false,
              rolcreaterole: false,
              rolbypassrls: false,
            };
            return { rows: [] };
          }
          if (normalized === 'CREATE DATABASE mio_regression_test OWNER mio_regression') {
            state.dbOwner = 'mio_regression';
            return { rows: [] };
          }
          if (normalized === 'REVOKE ALL ON DATABASE mio_regression_test FROM PUBLIC') {
            return { rows: [] };
          }
          throw new Error(`UNEXPECTED_SQL: ${normalized}`);
        },
        async close() {},
      };
      return session;
    }

    if (parsed.username === 'mio_regression' && parsed.pathname === '/mio_regression_test') {
      if (!state.allowRegressionLogin || parsed.password !== REG_PASS) {
        throw new Error('28P01: password authentication failed');
      }
      return {
        async query<Row extends Record<string, unknown>>() {
          return {
            rows: [{ db: 'mio_regression_test', usr: 'mio_regression' }] as unknown as Row[],
          };
        },
        async close() {},
      };
    }

    if (parsed.username === 'mio_regression' && parsed.pathname === '/mio_dev') {
      if (!state.allowAppLogin && !state.publicConnect && !state.directConnect) {
        throw new Error('42501: permission denied for database mio_dev');
      }
      return {
        async query<Row extends Record<string, unknown>>() {
          return { rows: [] as unknown as Row[] };
        },
        async close() {},
      };
    }

    throw new Error(`UNEXPECTED_URL: ${url}`);
  };

  return { state, executed, connect };
}

it('creates missing regression role and database on an existing dev volume and stays idempotent on rerun', async () => {
  const mock = createMockConnect();
  await prepareLocalRegression('dev', baseValues(), mock.connect);
  expect(mock.executed).toContain('REVOKE ALL ON DATABASE "mio_dev" FROM PUBLIC');
  expect(mock.executed).toContain(`CREATE ROLE mio_regression LOGIN PASSWORD '${REG_PASS}'`);
  expect(mock.executed).toContain('CREATE DATABASE mio_regression_test OWNER mio_regression');
  expect(mock.executed).toContain('REVOKE ALL ON DATABASE mio_regression_test FROM PUBLIC');

  mock.executed.length = 0;
  await prepareLocalRegression('dev', baseValues(), mock.connect);
  expect(mock.executed.some((sql) => sql.startsWith('CREATE '))).toBe(false);
});

it('rejects privileged roles, wrong database owners, leaked dev permissions, and bad passwords without resetting users', async () => {
  const superRole = createMockConnect({
    role: {
      rolcanlogin: true,
      rolsuper: true,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
    },
  });
  await expect(prepareLocalRegression('dev', baseValues(), superRole.connect)).rejects.toThrow(
    'LOCAL_REGRESSION_CONFLICT',
  );

  const wrongOwner = createMockConnect({
    role: {
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
    },
    dbOwner: 'mio',
  });
  await expect(prepareLocalRegression('dev', baseValues(), wrongOwner.connect)).rejects.toThrow(
    'LOCAL_REGRESSION_CONFLICT',
  );

  const directGrant = createMockConnect({
    role: {
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
    },
    dbOwner: 'mio_regression',
    publicConnect: false,
    directConnect: true,
  });
  await expect(prepareLocalRegression('dev', baseValues(), directGrant.connect)).rejects.toThrow(
    'LOCAL_REGRESSION_CONFLICT',
  );

  const badLogin = createMockConnect({ allowRegressionLogin: false });
  await expect(prepareLocalRegression('dev', baseValues(), badLogin.connect)).rejects.toThrow(
    'LOCAL_REGRESSION_LOGIN_FAILED',
  );

  const leakedIsolation = createMockConnect({ publicConnect: false, allowAppLogin: true });
  await expect(
    prepareLocalRegression('dev', baseValues(), leakedIsolation.connect),
  ).rejects.toThrow('LOCAL_REGRESSION_ISOLATION_FAILED');

  await expect(
    prepareLocalRegression(
      'dev',
      { ...baseValues(), MIO_TEST_DATABASE_URL: 'postgresql://mio:x@127.0.0.1:55432/mio_dev' },
      createMockConnect().connect,
    ),
  ).rejects.toThrow('LOCAL_REGRESSION_TARGET');
});
