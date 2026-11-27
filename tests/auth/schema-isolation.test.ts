import { authDeletionGuardsSQL } from '../../src/auth/deletion-schema.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { Kysely } from 'kysely';
import { Client, Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { AuthPostgresDialect } from '../../src/auth/database.ts';
import { authOptions, readAuthConfig } from '../../src/auth/config.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import { authDatabase } from '../support/auth-database.ts';

async function authFixture(migrate = true) {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  const config = readAuthConfig({
    MIO_AUTH_BASE_URL: 'http://127.0.0.1:19191',
    MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
    MIO_AUTH_DATABASE_URL: database.url,
  })!;
  try {
    if (migrate) {
      await (await getMigrations(authOptions(config, pool))).runMigrations();
      await pool.query(authDeletionGuardsSQL);
    }
    return {
      database,
      pool,
      config,
      async close() {
        await pool.end();
        await database.close();
      },
    };
  } catch (error) {
    await pool.end();
    await database.close();
    throw error;
  }
}

function register(
  auth: Pick<ReturnType<typeof betterAuth>, 'handler'>,
  baseURL: string,
  email = 'owner@example.test',
) {
  return auth.handler(
    new Request(baseURL + '/api/auth/sign-up/email', {
      method: 'POST',
      headers: { origin: baseURL, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Schema fixture',
        email,
        password: 'schema-fixture-password-971',
      }),
    }),
  );
}

function queryText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'text' in value) return String(value.text);
  return '';
}

function expectScopedMetadata(queries: string[]) {
  const metadata = queries.filter((query) => query.includes('pg_catalog.pg_attribute'));
  expect(metadata.length).toBeGreaterThan(0);
  for (const query of metadata) {
    expect(query).toContain('current_schemas(false)');
    expect(query).toContain('pg_catalog.pg_depend');
    expect(query).not.toMatch(/has_schema_privilege|pg_get_serial_sequence/);
  }
}

it('uses scoped OID metadata for both migration planning and the first runtime adapter operation', async () => {
  const f = await authFixture();
  const queries = vi.spyOn(Client.prototype, 'query');
  try {
    const options = authOptions(f.config, f.pool);
    expect(options.database).toMatchObject({ type: 'postgres', transaction: true });
    const migration = await getMigrations(options);
    expect(migration.toBeCreated).toEqual([]);
    expect(migration.toBeAdded).toEqual([]);
    expect(migration.toBeAddedIndexes).toEqual([]);
    expect(migration.schemaProblems).toEqual([]);
    expectScopedMetadata(queries.mock.calls.map(([query]) => queryText(query)));
    queries.mockClear();
    const auth = betterAuth(authOptions(f.config, f.pool));
    const response = await register(auth, f.config.baseURL);
    expect(response.status, await response.clone().text()).toBe(200);
    expectScopedMetadata(queries.mock.calls.map(([query]) => queryText(query)));
  } finally {
    queries.mockRestore();
    await f.close();
  }
});

it('retains column order, serial/identity ownership, defaults, comments, types, views and internal-table options', async () => {
  const f = await authFixture();
  try {
    await f.pool.query(`
      CREATE TYPE metadata_state AS ENUM ('ready');
      CREATE TABLE metadata_fixture (
        serial_id serial, identity_id integer GENERATED ALWAYS AS IDENTITY,
        required text NOT NULL, optional text DEFAULT 'default', state metadata_state
      );
      COMMENT ON COLUMN metadata_fixture.required IS 'required fixture value';
      CREATE VIEW metadata_view AS SELECT required FROM metadata_fixture;
      CREATE TABLE kysely_migration (id integer);
      CREATE TABLE kysely_migration_lock (id integer);
    `);
    const db = new Kysely<unknown>({ dialect: new AuthPostgresDialect({ pool: f.pool }) });
    const tables = await db.introspection.getTables();
    const table = tables.find((table) => table.name === 'metadata_fixture')!;
    expect(table).toMatchObject({
      schema: f.database.applicationName,
      isView: false,
      isForeign: false,
    });
    expect(table.columns.map((column) => column.name)).toEqual([
      'serial_id',
      'identity_id',
      'required',
      'optional',
      'state',
    ]);
    expect(table.columns[0]).toMatchObject({
      dataType: 'int4',
      dataTypeSchema: 'pg_catalog',
      isAutoIncrementing: true,
      hasDefaultValue: true,
    });
    expect(table.columns[1]).toMatchObject({ isAutoIncrementing: true, isNullable: false });
    expect(table.columns[2]).toMatchObject({
      isNullable: false,
      hasDefaultValue: false,
      isAutoIncrementing: false,
      comment: 'required fixture value',
    });
    expect(table.columns[3]).toMatchObject({ isNullable: true, hasDefaultValue: true });
    expect(table.columns[4]).toMatchObject({
      dataType: 'metadata_state',
      dataTypeSchema: f.database.applicationName,
    });
    expect(tables.find((table) => table.name === 'metadata_view')).toMatchObject({
      isView: true,
      isForeign: false,
    });
    expect(tables.some((table) => table.name.startsWith('kysely_migration'))).toBe(false);
    const internal = await db.introspection.getTables({ withInternalKyselyTables: true });
    expect(internal.filter((table) => table.name.startsWith('kysely_migration'))).toHaveLength(2);
    expect(await db.introspection.getSchemas()).toEqual([{ name: f.database.applicationName }]);
  } finally {
    await f.close();
  }
});

it('discovers runtime tables in later effective search-path schemas while migration targets the first', async () => {
  const f = await authFixture(false);
  const fallback = 'mio_auth_fallback_' + randomUUID().replaceAll('-', '');
  const fallbackURL = new URL(f.database.url);
  fallbackURL.searchParams.set('options', '-csearch_path=' + fallback);
  const fallbackPool = new Pool({ connectionString: fallbackURL.toString() });
  const searchURL = new URL(f.database.url);
  searchURL.searchParams.set('options', `-csearch_path=${f.database.applicationName},${fallback}`);
  const searchPool = new Pool({ connectionString: searchURL.toString() });
  try {
    await f.pool.query(`CREATE SCHEMA "${fallback}"`);
    await (await getMigrations(authOptions(f.config, fallbackPool))).runMigrations();
    const options = authOptions(f.config, searchPool);
    const auth = betterAuth(options);
    const response = await register(auth, f.config.baseURL);
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await f.pool.query(`SELECT count(*) FROM "${fallback}"."user"`)).rows[0].count).toBe(
      '1',
    );
    const db = new Kysely<unknown>({ dialect: new AuthPostgresDialect({ pool: searchPool }) });
    expect(
      (await db.introspection.getTables()).find((table) => table.name === 'user')?.schema,
    ).toBe(fallback);
    expect((await db.introspection.getSchemas()).map((schema) => schema.name).sort()).toEqual(
      [f.database.applicationName, fallback].sort(),
    );
    expect((await getMigrations(options)).toBeCreated.length).toBeGreaterThan(0);
  } finally {
    await searchPool.end();
    await fallbackPool.end();
    await f.pool.query(`DROP SCHEMA IF EXISTS "${fallback}" CASCADE`);
    await f.close();
  }
});

it.each([
  'missing table',
  'missing column',
  'missing index',
  'unexpected required column',
] as const)('rejects startup for a real %s and releases the acquired pool', async (fault) => {
  const f = await authFixture();
  try {
    if (fault === 'missing table') await f.pool.query('DROP TABLE session');
    else if (fault === 'missing column') await f.pool.query('ALTER TABLE "user" DROP COLUMN email');
    else if (fault === 'unexpected required column')
      await f.pool.query('ALTER TABLE verification ADD COLUMN fixture_required text NOT NULL');
    else {
      const indexes = await f.pool.query(
        'SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2',
        [f.database.applicationName, 'account'],
      );
      const index = indexes.rows.find(
        (index) =>
          index.indexdef.includes('UNIQUE') &&
          index.indexdef.includes('("providerId", "accountId")'),
      )?.indexname;
      expect(index).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      await f.pool.query(`DROP INDEX "${index}"`);
    }
    const active = async () =>
      (
        await f.pool.query(
          'SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1',
          [f.database.applicationName],
        )
      ).rows[0].count;
    const before = await active();
    const starting = createAuthentication(f.config);
    const acquired = await starting.catch(() => undefined);
    if (acquired) await acquired.close();
    await expect(starting).rejects.toThrow('AUTH_SCHEMA');
    // pool.end() may resolve before PostgreSQL removes its session from pg_stat_activity.
    await vi.waitFor(async () => expect(await active()).toBe(before), {
      timeout: 1000,
      interval: 10,
    });
  } finally {
    await f.close();
  }
});

it.each(['missing table', 'missing column', 'unexpected required column'] as const)(
  'retains the first runtime schema validation for a real %s',
  async (fault) => {
    const f = await authFixture();
    const queries = vi.spyOn(Client.prototype, 'query');
    try {
      if (fault === 'missing table') await f.pool.query('DROP TABLE session');
      else if (fault === 'missing column')
        await f.pool.query('ALTER TABLE "user" DROP COLUMN email');
      else await f.pool.query('ALTER TABLE verification ADD COLUMN fixture_required text NOT NULL');
      queries.mockClear();
      const auth = betterAuth(authOptions(f.config, f.pool));
      await expect(register(auth, f.config.baseURL)).rejects.toThrow('Database schema mismatch');
      const statements = queries.mock.calls.map(([query]) => queryText(query));
      expectScopedMetadata(statements);
      expect(statements.some((statement) => /insert\s+into\s+"user"/i.test(statement))).toBe(false);
    } finally {
      queries.mockRestore();
      await f.close();
    }
  },
);

it('keeps independent auth startup and runtime writes stable during unrelated serial-schema creation/drop', async () => {
  const fixtures = await Promise.all([authFixture(), authFixture()]);
  const churnPool = new Pool({ connectionString: fixtures[0]!.database.observerURL, max: 1 });
  const schema = 'mio_auth_churn_' + randomUUID().replaceAll('-', '');
  const entered = Promise.withResolvers<void>();
  let stopping = false;
  let cycles = 0;
  const churn = (async () => {
    while (!stopping && cycles < 512) {
      await churnPool.query(
        `CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".serial_fixture (id serial PRIMARY KEY, identity_id integer GENERATED ALWAYS AS IDENTITY)`,
      );
      entered.resolve();
      await churnPool.query(`DROP SCHEMA "${schema}" CASCADE`);
      cycles++;
    }
  })();
  try {
    await Promise.race([entered.promise, churn]);
    await Promise.all(
      fixtures.map(async (f, owner) => {
        for (let attempt = 0; attempt < 4; attempt++) {
          const migration = await getMigrations(authOptions(f.config, f.pool));
          expect(migration.schemaProblems).toEqual([]);
          expect(migration.toBeCreated).toEqual([]);
          const auth = await createAuthentication(f.config);
          try {
            const response = await register(
              auth,
              f.config.baseURL,
              `owner-${owner}-${attempt}@example.test`,
            );
            expect(response.status, await response.clone().text()).toBe(200);
            const cookie = response.headers
              .getSetCookie()
              .map((cookie) => cookie.split(';')[0])
              .join('; ');
            const user = (await response.json()).user;
            expect(await auth.identity(new Headers({ cookie }))).toMatchObject({ userId: user.id });
          } finally {
            await auth.close();
          }
        }
      }),
    );
    expect(cycles).toBeGreaterThan(1);
  } finally {
    stopping = true;
    try {
      await churn;
    } finally {
      await churnPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await churnPool.end();
      await Promise.all(fixtures.map((fixture) => fixture.close()));
    }
  }
}, 30000);
