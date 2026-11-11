import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { authDatabase } from './auth-database.ts';

const argument = process.argv[2];
if (!argument) throw new Error('PORTABLE_ARTIFACT_ROOT_REQUIRED');
const root = realpathSync(argument);
const workspace = realpathSync('.');
if (root === workspace || root.startsWith(`${workspace}${sep}`))
  throw new Error('PORTABLE_ROOT_MUST_BE_OUTSIDE_WORKSPACE');
const database = await authDatabase();
const pool = new Pool({ connectionString: database.observerURL });
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  MIO_AUTH_DATABASE_URL: database.url,
  MIO_AUTH_BASE_URL: 'http://127.0.0.1:4174',
  MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
  MIO_AUTH_RATE_LIMIT_BACKEND: 'database',
  MIO_ASSETS_DATABASE_URL: database.url,
};
const migrate = (name: string) => {
  const result = spawnSync(
    process.execPath,
    [join(root, 'a/dist/tools/scripts/service', `migrate-${name}.js`), '--apply'],
    { cwd: root, env, encoding: 'utf8', timeout: 30000 },
  );
  if (result.status !== 0) throw new Error(`PORTABLE_MIGRATION_FAILED:${name}`);
};
try {
  for (const name of ['auth', 'assets']) migrate(name);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,source_etag,expires_at)
     VALUES($1,'probe','x.mp4','video/mp4',1,$2,$3,'ready','"source"',now()+interval '1 day')`,
    [id, `mio/staging/${id}`, `mio/raw/${id}/${randomUUID()}`],
  );
  const readOriginal = () => pool.query('SELECT * FROM mio_assets WHERE id=$1', [id]);
  const {
    rows: [original],
  } = await readOriginal();
  assert.ok(original);
  assert.equal(Object.hasOwn(original, 'asset_kind'), false);
  const expected = [{ ...original, asset_kind: 'original' }];

  migrate('compute');
  assert.deepEqual(
    (await readOriginal()).rows,
    expected,
    'first compute migration changed the asset',
  );
  console.log('PORTABLE_COMPUTE_MIGRATION_EXISTING_ASSET_OK');

  for (const name of ['auth', 'assets', 'compute']) migrate(name);
  assert.deepEqual((await readOriginal()).rows, expected, 'repeated migration changed the asset');
  await pool.query('SELECT id FROM mio_compute_jobs LIMIT 0');
  await pool.query('SELECT id FROM mio_compute_outbox LIMIT 0');
  await pool.query('SELECT id FROM mio_compute_inbox LIMIT 0');
  console.log('PORTABLE_AUTH_ASSET_COMPUTE_MIGRATIONS_OK');
} finally {
  await pool.end();
  await database.close();
}
