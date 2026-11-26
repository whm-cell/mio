import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

export async function authTableIndexes(pool: Pool, schema: string, table: string) {
  const { rows } = await pool.query<{ indexdef: string }>(
    'SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2',
    [schema, table],
  );
  return {
    unique: (column: string) =>
      rows.some(({ indexdef }) => indexdef.includes(column) && indexdef.includes('UNIQUE')),
    has: (column: string) => rows.some(({ indexdef }) => indexdef.includes(column)),
  };
}

/** Dedicated test DB only. Each run owns one schema; local mode owns and removes the entire cluster. */
export async function authDatabase() {
  let directory: string | undefined;
  let started = false;
  let url = process.env.MIO_TEST_DATABASE_URL;
  const command = (bin: string, args: string[]) => {
    const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0)
      throw new Error(`${bin} failed: ${result.error?.message ?? result.stderr}`);
  };
  const cleanupCluster = async () => {
    if (started)
      command('pg_ctl', ['-D', join(directory!, 'data'), '-m', 'immediate', '-w', 'stop']);
    if (directory) await rm(directory, { recursive: true, force: true });
  };
  try {
    if (url) {
      if (!new URL(url).pathname.endsWith('_test'))
        throw new Error('MIO_TEST_DATABASE_URL must name a dedicated database ending in _test');
    } else {
      directory = await mkdtemp(join(tmpdir(), 'mio-auth-pg-'));
      command('initdb', [
        '-D',
        join(directory, 'data'),
        '-A',
        'trust',
        '-U',
        'mio_test',
        '--no-locale',
        '--encoding=UTF8',
      ]);
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test port missing');
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      command('pg_ctl', [
        '-D',
        join(directory, 'data'),
        '-l',
        join(directory, 'postgres.log'),
        '-o',
        `-h 127.0.0.1 -p ${address.port} -k ${directory}`,
        '-w',
        'start',
      ]);
      started = true;
      url = `postgresql://mio_test@127.0.0.1:${address.port}/postgres`;
    }
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
    const schema = `mio_auth_${randomUUID().replaceAll('-', '')}`;
    const smokeToken = randomBytes(32).toString('hex');
    let identity: { database: string; user: string };
    let createdSchema = false;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      createdSchema = true;
      await pool.query(`COMMENT ON SCHEMA "${schema}" IS 'mio-auth-fixture:${smokeToken}'`);
      identity = (
        await pool.query<{ database: string; user: string }>(
          'SELECT current_database() AS database, current_user AS "user"',
        )
      ).rows[0]!;
    } catch (error) {
      if (createdSchema) await pool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
      await pool.end();
      const code = (error as { code?: unknown }).code;
      if (
        !started &&
        (code === '28P01' || code === '3D000') &&
        new URL(url).pathname === '/mio_regression_test'
      ) {
        throw new Error(
          `LOCAL_REGRESSION_UNINITIALIZED: mio_regression_test is not initialized on this PostgreSQL volume (${code}); run pnpm regression:init:dev (or pnpm regression:init:test)`,
          { cause: error },
        );
      }
      throw error;
    }
    const scoped = new URL(url);
    scoped.searchParams.set('options', `-csearch_path=${schema}`);
    scoped.searchParams.set('application_name', schema);
    const observer = new URL(scoped);
    observer.searchParams.set('application_name', `${schema}_observer`);
    return {
      url: scoped.toString(),
      observerURL: observer.toString(),
      applicationName: schema,
      smokeEnvironment: {
        MIO_SMOKE_AUTH_DATABASE_URL: scoped.toString(),
        MIO_SMOKE_AUTH_FIXTURE: JSON.stringify({ ...identity, schema, token: smokeToken }),
      },
      async close() {
        try {
          await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await pool.end();
          await cleanupCluster();
        }
      },
    };
  } catch (error) {
    await cleanupCluster();
    throw error;
  }
}
